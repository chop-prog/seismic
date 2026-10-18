/// <reference lib="webworker" />
// Off-main-thread aggregation: the UI thread never runs the O(n) filter loop, so brushing
// stays at 60 fps even on a million rows.
import { compute, prepare, type Filters, type Prepared } from './engine.ts';
import type { Quakes } from './data.ts';

export type WorkerIn =
  | { type: 'load'; q: Omit<Quakes, 'place' | 'id'> & { place: string[]; id: string[] } }
  | { type: 'filter'; seq: number; filters: Filters };

let prepared: Prepared | null = null;

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  if (msg.type === 'load') {
    const t0 = performance.now();
    prepared = prepare(msg.q as Quakes);
    const { base, tEdges } = prepared;
    self.postMessage({ type: 'ready', base, tEdges, ms: performance.now() - t0 });
    return;
  }
  if (!prepared) return;
  const t0 = performance.now();
  const r = compute(prepared, msg.filters);
  // Transfer the mask instead of copying it (1 MB at 1M rows).
  self.postMessage({ type: 'result', seq: msg.seq, result: r, ms: performance.now() - t0 }, [r.mask.buffer]);
};
