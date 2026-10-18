// Crossfilter-style aggregation. One pass over the data computes, for every dimension,
// the histogram of records that pass *all the other* filters — so each chart shows what
// its own brush would select from — plus the selection mask, KPIs and the top events.

import type { Quakes } from './data.ts';

export type Range = [number, number];

export interface Filters {
  time?: Range;
  mag?: Range;
  depth?: Range;
  /** [lonMin, latMin, lonMax, latMax] */
  box?: [number, number, number, number];
}

export const MAG_EDGES = Array.from({ length: 20 }, (_, i) => -1 + i * 0.5); // -1 … 8.5
export const DEPTH_EDGES = [-5, 5, 10, 20, 35, 70, 150, 300, 500, 800];
export const DEPTH_CLASSES = [35, 70, 150, 300]; // colour classes: <35, 35-70, 70-150, 150-300, 300+

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Day bins for long ranges, hour bins for short ones. */
export function timeEdges(min: number, max: number): number[] {
  const step = max - min > 3 * DAY ? DAY : HOUR;
  const start = Math.floor(min / step) * step;
  const edges: number[] = [];
  for (let t = start; t <= max; t += step) edges.push(t);
  edges.push(edges[edges.length - 1]! + step);
  return edges;
}

/** Index of the bin containing v (clamped into range). Binary search. */
export function binOf(v: number, edges: number[]): number {
  let lo = 0;
  let hi = edges.length - 2;
  if (v < edges[0]!) return 0;
  if (v >= edges[hi + 1]!) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (edges[mid]! <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface Prepared {
  q: Quakes;
  tEdges: number[];
  bt: Uint16Array;
  bm: Uint16Array;
  bd: Uint16Array;
  /** Histograms of the unfiltered data, drawn as context. */
  base: { time: Uint32Array; mag: Uint32Array; depth: Uint32Array };
}

/** Precompute bin indices once so every filter pass is pure integer work. */
export function prepare(q: Quakes): Prepared {
  let tmin = Infinity;
  let tmax = -Infinity;
  for (let i = 0; i < q.n; i++) {
    const t = q.time[i]!;
    if (t < tmin) tmin = t;
    if (t > tmax) tmax = t;
  }
  const tEdges = q.n ? timeEdges(tmin, tmax) : timeEdges(0, DAY);
  const bt = new Uint16Array(q.n);
  const bm = new Uint16Array(q.n);
  const bd = new Uint16Array(q.n);
  const base = { time: new Uint32Array(tEdges.length - 1), mag: new Uint32Array(MAG_EDGES.length - 1), depth: new Uint32Array(DEPTH_EDGES.length - 1) };
  for (let i = 0; i < q.n; i++) {
    base.time[(bt[i] = binOf(q.time[i]!, tEdges))]!++;
    base.mag[(bm[i] = binOf(q.mag[i]!, MAG_EDGES))]!++;
    base.depth[(bd[i] = binOf(q.depth[i]!, DEPTH_EDGES))]!++;
  }
  return { q, tEdges, bt, bm, bd, base };
}

export interface Result {
  selected: number;
  hist: { time: Uint32Array; mag: Uint32Array; depth: Uint32Array };
  kpi: { count: number; maxMag: number; meanDepth: number; tsunami: number; strong: number };
  /** Indices of the strongest selected events, descending. */
  top: number[];
  /** 1 = record passes every filter. */
  mask: Uint8Array;
}

const T = 1;
const M = 2;
const D = 4;
const B = 8;

export function compute(p: Prepared, f: Filters, topK = 10): Result {
  const { q, bt, bm, bd, tEdges } = p;
  const hist = { time: new Uint32Array(tEdges.length - 1), mag: new Uint32Array(MAG_EDGES.length - 1), depth: new Uint32Array(DEPTH_EDGES.length - 1) };
  const mask = new Uint8Array(q.n);
  let selected = 0;
  let maxMag = -Infinity;
  let depthSum = 0;
  let tsunami = 0;
  let strong = 0;
  const top: number[] = [];

  for (let i = 0; i < q.n; i++) {
    let fail = 0;
    if (f.time && (q.time[i]! < f.time[0] || q.time[i]! >= f.time[1])) fail |= T;
    if (f.mag && (q.mag[i]! < f.mag[0] || q.mag[i]! >= f.mag[1])) fail |= M;
    if (f.depth && (q.depth[i]! < f.depth[0] || q.depth[i]! >= f.depth[1])) fail |= D;
    if (f.box) {
      const lon = q.lon[i]!;
      const lat = q.lat[i]!;
      if (lon < f.box[0] || lat < f.box[1] || lon > f.box[2] || lat > f.box[3]) fail |= B;
    }
    if (fail === 0) {
      selected++;
      mask[i] = 1;
      hist.time[bt[i]!]!++;
      hist.mag[bm[i]!]!++;
      hist.depth[bd[i]!]!++;
      const m = q.mag[i]!;
      if (m > maxMag) maxMag = m;
      if (m >= 5) strong++;
      depthSum += q.depth[i]!;
      tsunami += q.tsunami[i]!;
      // Bounded insertion keeps top-K at O(n·K) without sorting everything.
      if (top.length < topK || m > q.mag[top[top.length - 1]!]!) {
        let k = top.length < topK ? top.length : topK - 1;
        while (k > 0 && q.mag[top[k - 1]!]! < m) {
          top[k] = top[k - 1]!;
          k--;
        }
        top[k] = i;
      }
    } else if (fail === T) hist.time[bt[i]!]!++;
    else if (fail === M) hist.mag[bm[i]!]!++;
    else if (fail === D) hist.depth[bd[i]!]!++;
  }

  return {
    selected,
    hist,
    kpi: { count: selected, maxMag: selected ? maxMag : 0, meanDepth: selected ? depthSum / selected : 0, tsunami, strong },
    top,
    mask,
  };
}
