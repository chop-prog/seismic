import './style.css';
import land from 'world-atlas/land-110m.json';
import { fromGeoJSON, fromSnapshot, synthetic, type Quakes, type Snapshot } from './data.ts';
import { DEPTH_EDGES, MAG_EDGES, type Filters, type Result } from './engine.ts';
import { topoRings } from './geo.ts';
import { Histogram } from './histogram.ts';
import { DEPTH_COLORS, MapView, radius } from './map.ts';

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const nf = (n: number) => n.toLocaleString('en-US');
const FEEDS = {
  all: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_month.geojson',
  m25: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_month.geojson',
};

let data: Quakes | null = null;
let tEdges: number[] = [];
let base: { time: Uint32Array; mag: Uint32Array; depth: Uint32Array } | null = null;
let filters: Filters = {};
let seq = 0;

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

// ── Views ────────────────────────────────────────────────────────────────────
const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const timeHist = new Histogram($('#h-time'), {
  title: 'Events over time',
  edges: [0, 1],
  unit: 'Period',
  label: (i) => {
    const t = tEdges[i] ?? 0;
    const step = (tEdges[1] ?? 0) - (tEdges[0] ?? 0);
    return step < 86_400_000 ? new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' }) : dateFmt.format(t);
  },
  tick: (i) => (i % 5 === 0 && tEdges[i] !== undefined ? dateFmt.format(tEdges[i]!) : null),
  onBrush: (r) => setFilter('time', r),
});
const magHist = new Histogram($('#h-mag'), {
  title: 'Magnitude',
  edges: MAG_EDGES,
  unit: 'Magnitude',
  label: (i) => `M ${MAG_EDGES[i]!.toFixed(1)} – ${MAG_EDGES[i + 1]!.toFixed(1)}`,
  tick: (i) => (MAG_EDGES[i]! % 1 === 0 ? String(MAG_EDGES[i]) : null),
  onBrush: (r) => setFilter('mag', r),
});
const depthHist = new Histogram($('#h-depth'), {
  title: 'Depth',
  edges: DEPTH_EDGES,
  unit: 'Depth (km)',
  label: (i) => `${Math.max(0, DEPTH_EDGES[i]!)}–${DEPTH_EDGES[i + 1]} km`,
  tick: (i) => (i === 0 ? '0' : i < DEPTH_EDGES.length ? String(DEPTH_EDGES[i]) : null),
  onBrush: (r) => setFilter('depth', r),
});

const tip = $('#map-tip');
const map = new MapView($<HTMLCanvasElement>('#map'), {
  rings: topoRings(land as never, 'land'),
  onBox: (box) => setFilter('box', box),
  onHover: (i, x, y) => {
    if (i === null || !data) {
      tip.hidden = true;
      return;
    }
    tip.hidden = false;
    tip.innerHTML = describe(i);
    const w = tip.parentElement!.clientWidth;
    tip.style.transform = `translate(${Math.min(w - 260, x + 14)}px, ${Math.max(0, y - 70)}px)`;
  },
});

function describe(i: number) {
  const q = data!;
  return `<b>M ${q.mag[i]!.toFixed(1)}</b> · ${escapeHtml(q.place[i]!)}<br><span>${new Date(q.time[i]!).toLocaleString('en-US')} · depth ${q.depth[i]!.toFixed(0)} km</span>`;
}
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// ── Filters ──────────────────────────────────────────────────────────────────
function setFilter<K extends keyof Filters>(key: K, value: Filters[K] | null) {
  filters = { ...filters };
  if (value === null) delete filters[key];
  else filters[key] = value as Filters[K];
  if (key === 'box' && value === null) map.clearBox();
  run();
  renderChips();
}

function run() {
  if (!data) return;
  document.body.classList.add('busy');
  worker.postMessage({ type: 'filter', seq: ++seq, filters });
}

const ago = (t: number) => {
  const h = (Date.now() - t) / 3_600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} d ago`;
};

worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'ready') {
    tEdges = msg.tEdges;
    base = msg.base;
    timeHist.setEdges(tEdges);
    run();
    return;
  }
  if (msg.type !== 'result' || msg.seq !== seq || !data || !base) return; // stale
  document.body.classList.remove('busy');
  const r: Result = msg.result;
  timeHist.setData(r.hist.time, base.time);
  magHist.setData(r.hist.mag, base.mag);
  depthHist.setData(r.hist.depth, base.depth);
  map.setMask(r.mask);
  renderKpis(r);
  renderTop(r.top);
  $('#perf').textContent = `${nf(r.selected)} of ${nf(data.n)} events · filtered in ${msg.ms.toFixed(1)} ms on a Web Worker`;
};

function renderKpis(r: Result) {
  const q = data!;
  $('#k-count').textContent = nf(r.kpi.count);
  $('#k-count-sub').textContent = `of ${nf(q.n)} in the dataset`;
  $('#k-max').textContent = r.selected ? `M ${r.kpi.maxMag.toFixed(1)}` : '–';
  $('#k-max-sub').textContent = r.top[0] !== undefined ? q.place[r.top[0]]! : '';
  $('#k-strong').textContent = nf(r.kpi.strong);
  $('#k-depth').textContent = r.selected ? `${r.kpi.meanDepth.toFixed(0)} km` : '–';
  $('#k-tsunami').textContent = nf(r.kpi.tsunami);
}

function renderTop(top: number[]) {
  const q = data!;
  $('#top').innerHTML = top.length
    ? top.map((i) => `
      <li><button data-i="${i}">
        <span class="mag" style="--r:${radius(q.mag[i]!).toFixed(1)}px">${q.mag[i]!.toFixed(1)}</span>
        <span class="place">${escapeHtml(q.place[i]!)}<small>${ago(q.time[i]!)} · ${q.depth[i]!.toFixed(0)} km deep</small></span>
      </button></li>`).join('')
    : '<li class="empty">No events match these filters.</li>';
}

$('#top').addEventListener('pointerover', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  map.setHighlight(b ? Number(b.dataset.i) : null);
});
$('#top').addEventListener('pointerleave', () => map.setHighlight(null));
$('#top').addEventListener('focusin', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (b) map.setHighlight(Number(b.dataset.i));
});
$('#top').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (b && data && !data.id[Number(b.dataset.i)]!.startsWith('syn')) {
    window.open(`https://earthquake.usgs.gov/earthquakes/eventpage/${data.id[Number(b.dataset.i)]}`, '_blank', 'noopener');
  }
});

function renderChips() {
  const chips: string[] = [];
  const f = filters;
  if (f.time) chips.push(chip('time', `${dateFmt.format(f.time[0])} – ${dateFmt.format(f.time[1])}`));
  if (f.mag) chips.push(chip('mag', `M ${f.mag[0]} – ${Math.min(f.mag[1], 9)}`));
  if (f.depth) chips.push(chip('depth', `${Math.max(0, f.depth[0])}–${f.depth[1]} km`));
  if (f.box) chips.push(chip('box', `Region ${f.box.map((v) => v.toFixed(0)).join(', ')}`));
  $('#chips').innerHTML = chips.join('') || '<span class="muted">No filters: drag on any chart or the map to filter</span>';
}
const chip = (key: string, text: string) => `<button class="chip" data-key="${key}" aria-label="Remove filter ${text}">${text} <span aria-hidden="true">×</span></button>`;
$('#chips').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.chip');
  if (!b) return;
  const key = b.dataset.key as keyof Filters;
  ({ time: timeHist, mag: magHist, depth: depthHist } as Record<string, Histogram>)[key]?.clearBrush();
  setFilter(key, null);
});

function reset() {
  filters = {};
  [timeHist, magHist, depthHist].forEach((h) => h.clearBrush());
  map.clearBox();
  run();
  renderChips();
}
$('#reset').addEventListener('click', reset);

const PRESETS: Record<string, () => Filters> = {
  day: () => ({ time: [tEdges[tEdges.length - 1]! - 86_400_000, tEdges[tEdges.length - 1]!] }),
  week: () => ({ time: [tEdges[tEdges.length - 1]! - 7 * 86_400_000, tEdges[tEdges.length - 1]!] }),
  strong: () => ({ mag: [4.5, 10] }),
  shallow: () => ({ depth: [-5, 70] }),
  japan: () => ({ box: [128, 28, 148, 46] }),
  alaska: () => ({ box: [-180, 50, -128, 72] }),
};
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-preset]')) {
  b.addEventListener('click', () => {
    reset();
    filters = PRESETS[b.dataset.preset!]!() as Filters;
    run();
    renderChips();
  });
}

// ── Data loading ─────────────────────────────────────────────────────────────
async function loadSnapshot(): Promise<{ q: Quakes; label: string }> {
  const s = (await (await fetch(`${import.meta.env.BASE_URL}data/snapshot.json`)).json()) as Snapshot;
  return { q: fromSnapshot(s), label: `Bundled snapshot from ${new Date(s.generated).toLocaleDateString('en-US', { dateStyle: 'medium' })}` };
}

async function load(source: string) {
  $('#source-status').textContent = 'Loading…';
  document.body.classList.add('busy');
  let loaded: { q: Quakes; label: string };
  try {
    if (source === 'snapshot') loaded = await loadSnapshot();
    else if (source === 'stress') {
      const { q } = await loadSnapshot();
      $('#source-status').textContent = 'Generating 1,000,000 events…';
      await new Promise((r) => setTimeout(r, 30));
      loaded = { q: synthetic(1_000_000, q), label: 'Synthetic: 1,000,000 events (Gutenberg–Richter magnitudes)' };
    } else {
      const res = await fetch(FEEDS[source as keyof typeof FEEDS], { cache: 'no-cache' });
      if (!res.ok) throw new Error(`USGS ${res.status}`);
      loaded = { q: fromGeoJSON(await res.json()), label: `Live from USGS · fetched ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` };
    }
  } catch {
    loaded = await loadSnapshot();
    loaded.label = `USGS unreachable, showing the ${loaded.label.toLowerCase()}`;
  }
  data = loaded.q;
  $('#source-status').textContent = loaded.label;
  document.body.dataset.mode = data.n > 60_000 ? 'density' : 'points';
  filters = {};
  [timeHist, magHist, depthHist].forEach((h) => h.clearBrush());
  map.clearBox();
  renderChips();
  map.setData(data);
  // Structured clone copies the columns into the worker; the main thread keeps its own for drawing.
  worker.postMessage({ type: 'load', q: data });
}

$<HTMLSelectElement>('#source').addEventListener('change', (e) => void load((e.target as HTMLSelectElement).value));

// Legend.
$('#legend-depth').innerHTML = ['< 35', '35–70', '70–150', '150–300', '300+']
  .map((l, i) => `<span><i style="background:${DEPTH_COLORS[i]}"></i>${l}</span>`).join('');
$('#legend-size').innerHTML = [3, 5, 7].map((m) => `<span><i class="dot" style="width:${radius(m) * 2}px;height:${radius(m) * 2}px"></i>M${m}</span>`).join('');

window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') reset();
});

void load('all');
