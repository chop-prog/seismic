import { describe, expect, it } from 'vitest';
import { alloc, fromGeoJSON, fromSnapshot, synthetic, toSnapshot, type Quakes } from '../src/data.ts';
import { binOf, compute, MAG_EDGES, prepare, timeEdges, type Filters } from '../src/engine.ts';

const DAY = 86_400_000;

function make(rows: [time: number, mag: number, depth: number, lat: number, lon: number][]): Quakes {
  const q = alloc(rows.length);
  rows.forEach(([t, m, d, la, lo], i) => {
    q.time[i] = t; q.mag[i] = m; q.depth[i] = d; q.lat[i] = la; q.lon[i] = lo; q.place[i] = `p${i}`; q.id[i] = `id${i}`;
  });
  return q;
}

/** Naive reference implementation the fast engine must agree with. */
function naive(q: Quakes, f: Filters) {
  const pass = (i: number, skip?: string) =>
    (skip === 'time' || !f.time || (q.time[i]! >= f.time[0] && q.time[i]! < f.time[1])) &&
    (skip === 'mag' || !f.mag || (q.mag[i]! >= f.mag[0] && q.mag[i]! < f.mag[1])) &&
    (skip === 'depth' || !f.depth || (q.depth[i]! >= f.depth[0] && q.depth[i]! < f.depth[1])) &&
    (!f.box || (q.lon[i]! >= f.box[0] && q.lat[i]! >= f.box[1] && q.lon[i]! <= f.box[2] && q.lat[i]! <= f.box[3]));
  const idx = [...Array(q.n).keys()];
  return {
    selected: idx.filter((i) => pass(i)).length,
    magHist: MAG_EDGES.slice(0, -1).map((_, b) => idx.filter((i) => pass(i, 'mag') && binOf(q.mag[i]!, MAG_EDGES) === b).length),
  };
}

describe('binning', () => {
  it('binOf finds the half-open bin and clamps outliers', () => {
    const e = [0, 10, 20, 30];
    expect([binOf(-5, e), binOf(0, e), binOf(9.99, e), binOf(10, e), binOf(29, e), binOf(99, e)]).toEqual([0, 0, 0, 1, 2, 2]);
  });
  it('uses day bins for long ranges and hour bins for short ones', () => {
    expect(timeEdges(0, 10 * DAY)[1]).toBe(DAY);
    expect(timeEdges(0, 2 * DAY)[1]).toBe(3_600_000);
  });
});

describe('crossfilter compute', () => {
  const q = make([
    [0, 1.2, 10, 35, 139], [DAY, 4.6, 30, -6, 105], [2 * DAY, 5.5, 600, -20, -178],
    [3 * DAY, 2.1, 8, 38, -122], [4 * DAY, 6.1, 15, 61, -150], [5 * DAY, 0.4, 2, 19, -155],
  ]);
  const p = prepare(q);

  it('no filters selects everything', () => {
    const r = compute(p, {});
    expect(r.selected).toBe(6);
    expect(r.kpi.maxMag).toBeCloseTo(6.1);
    expect(r.kpi.strong).toBe(2);
    expect([...r.mask]).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("a dimension's own histogram ignores its own filter (crossfilter semantics)", () => {
    const r = compute(p, { mag: [4.5, 9] });
    expect(r.selected).toBe(3);
    // The magnitude histogram still shows all 6 records, so the brush has context…
    expect([...r.hist.mag].reduce((a, b) => a + b)).toBe(6);
    // …while the other histograms only show the 3 selected ones.
    expect([...r.hist.depth].reduce((a, b) => a + b)).toBe(3);
  });

  it('returns the strongest selected events in order', () => {
    expect(compute(p, {}, 3).top).toEqual([4, 2, 1]);
    expect(compute(p, { depth: [0, 100] }, 3).top).toEqual([4, 1, 3]);
  });

  it('matches a naive reference on random data and random filters', () => {
    const base = make(Array.from({ length: 50 }, (_, i) => [i * 3_600_000, (i % 9) - 0.5, i * 13 % 700, (i * 7 % 160) - 80, (i * 37 % 360) - 180]));
    const big = synthetic(5000, base, mulberry(7));
    const pb = prepare(big);
    const r = mulberry(99);
    for (let k = 0; k < 40; k++) {
      const f: Filters = {};
      if (r() < 0.6) { const a = r() * 8 - 1; f.mag = [a, a + r() * 4]; }
      if (r() < 0.6) { const a = r() * 300; f.depth = [a, a + r() * 400]; }
      if (r() < 0.4) { const a = r() * 300 - 180; const b = r() * 120 - 60; f.box = [a, b, a + 60, b + 40]; }
      const fast = compute(pb, f);
      const ref = naive(big, f);
      expect(fast.selected).toBe(ref.selected);
      expect([...fast.hist.mag]).toEqual(ref.magHist);
    }
  });
});

describe('data adapters', () => {
  const fc = {
    features: [
      { id: 'a', properties: { mag: 4.2, place: '10 km N of X', time: 1, tsunami: 0 }, geometry: { coordinates: [10, 20, 5] as [number, number, number] } },
      { id: 'b', properties: { mag: null, place: 'no mag', time: 2, tsunami: 0 }, geometry: { coordinates: [0, 0, 0] as [number, number, number] } },
      { id: 'c', properties: { mag: 6, place: null, time: 3, tsunami: 1 }, geometry: { coordinates: [-70.1234, -33.5678, 35.25] as [number, number, number] } },
    ],
  };
  it('parses GeoJSON, dropping events without magnitude', () => {
    const q = fromGeoJSON(fc);
    expect(q.n).toBe(2);
    expect(q.place).toEqual(['10 km N of X', 'Unknown location']);
    expect(q.tsunami[1]).toBe(1);
  });
  it('round-trips through the compact snapshot', () => {
    const q = fromGeoJSON(fc);
    const back = fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(q, 'test'))));
    expect(back.n).toBe(2);
    expect(back.lon[1]).toBeCloseTo(-70.123, 3);
    expect(back.id).toEqual(['a', 'c']);
  });
  it('synthetic data follows Gutenberg–Richter: ~10× fewer events per magnitude unit', () => {
    const base = fromGeoJSON(fc);
    const s = synthetic(200_000, base, mulberry(3));
    let m2 = 0;
    let m3 = 0;
    for (let i = 0; i < s.n; i++) {
      if (s.mag[i]! >= 2 && s.mag[i]! < 3) m2++;
      if (s.mag[i]! >= 3 && s.mag[i]! < 4) m3++;
    }
    expect(m2 / m3).toBeGreaterThan(8);
    expect(m2 / m3).toBeLessThan(12.5);
  });
});

function mulberry(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
