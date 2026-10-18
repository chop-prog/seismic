// Columnar earthquake data. Typed arrays keep 1M rows at ~25 MB and make the filter
// loop cache-friendly; they also transfer to the worker without copying.

export interface Quakes {
  n: number;
  time: Float64Array;
  mag: Float32Array;
  depth: Float32Array;
  lat: Float32Array;
  lon: Float32Array;
  tsunami: Uint8Array;
  place: string[];
  id: string[];
}

interface Feature {
  id: string;
  properties: { mag: number | null; place: string | null; time: number; tsunami: number };
  geometry: { coordinates: [number, number, number] };
}

export function alloc(n: number): Quakes {
  return {
    n,
    time: new Float64Array(n),
    mag: new Float32Array(n),
    depth: new Float32Array(n),
    lat: new Float32Array(n),
    lon: new Float32Array(n),
    tsunami: new Uint8Array(n),
    place: new Array<string>(n).fill(''),
    id: new Array<string>(n).fill(''),
  };
}

/** USGS GeoJSON feed → columns. Events without a magnitude are dropped. */
export function fromGeoJSON(fc: { features: Feature[] }): Quakes {
  const rows = fc.features.filter((f) => typeof f.properties.mag === 'number' && Number.isFinite(f.properties.mag));
  const q = alloc(rows.length);
  rows.forEach((f, i) => {
    const [lon, lat, depth] = f.geometry.coordinates;
    q.time[i] = f.properties.time;
    q.mag[i] = f.properties.mag!;
    q.depth[i] = depth ?? 0;
    q.lat[i] = lat;
    q.lon[i] = lon;
    q.tsunami[i] = f.properties.tsunami ? 1 : 0;
    q.place[i] = f.properties.place ?? 'Unknown location';
    q.id[i] = f.id;
  });
  return q;
}

export interface Snapshot {
  generated: number;
  source: string;
  time: number[];
  mag: number[];
  depth: number[];
  lat: number[];
  lon: number[];
  tsunami: number[];
  place: string[];
  id: string[];
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** Compact JSON form bundled with the app as an offline fallback. */
export function toSnapshot(q: Quakes, source: string, generated = Date.now()): Snapshot {
  const pick = <T>(f: (i: number) => T) => Array.from({ length: q.n }, (_, i) => f(i));
  return {
    generated,
    source,
    time: pick((i) => q.time[i]!),
    mag: pick((i) => round(q.mag[i]!, 2)),
    depth: pick((i) => round(q.depth[i]!, 1)),
    lat: pick((i) => round(q.lat[i]!, 3)),
    lon: pick((i) => round(q.lon[i]!, 3)),
    tsunami: pick((i) => q.tsunami[i]!),
    place: q.place.slice(),
    id: q.id.slice(),
  };
}

export function fromSnapshot(s: Snapshot): Quakes {
  const q = alloc(s.time.length);
  q.time.set(s.time);
  q.mag.set(s.mag);
  q.depth.set(s.depth);
  q.lat.set(s.lat);
  q.lon.set(s.lon);
  q.tsunami.set(s.tsunami);
  q.place = s.place.slice();
  q.id = s.id.slice();
  return q;
}

/**
 * Synthetic stress data with a realistic shape: epicentres jittered around real ones
 * (so they follow plate boundaries), magnitudes from a Gutenberg–Richter (exponential)
 * law, depths resampled from the real distribution.
 */
export function synthetic(n: number, base: Quakes, rand = Math.random): Quakes {
  const q = alloc(n);
  const t0 = Math.min(...base.time.subarray(0, Math.min(base.n, 50_000)));
  const t1 = Math.max(...base.time.subarray(0, Math.min(base.n, 50_000)));
  for (let i = 0; i < n; i++) {
    const j = Math.floor(rand() * base.n);
    const g = () => (rand() + rand() + rand() - 1.5) * 1.6; // ~gaussian jitter, degrees
    q.lat[i] = Math.max(-89, Math.min(89, base.lat[j]! + g()));
    q.lon[i] = ((base.lon[j]! + g() + 540) % 360) - 180;
    q.depth[i] = Math.max(0, base.depth[Math.floor(rand() * base.n)]! * (0.8 + rand() * 0.4));
    q.mag[i] = Math.min(8.5, 0.2 - Math.log(1 - rand()) / Math.LN10); // b-value 1
    q.time[i] = t0 + rand() * (t1 - t0);
    q.place[i] = 'Synthetic event';
    q.id[i] = `syn${i}`;
  }
  return q;
}
