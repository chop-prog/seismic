// Canvas histogram with brushing, hover tooltip and a table-view twin.
// Bars: slot-1 blue for the current slice over a neutral "all data" ghost, 4px rounded
// tops, 2px gaps, hairline grid — per the data-viz mark specs.

export interface HistogramOptions {
  title: string;
  edges: number[];
  label: (i: number) => string;
  tick: (i: number) => string | null;
  unit: string;
  onBrush: (range: [number, number] | null) => void;
}

const fmt = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export class Histogram {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tip: HTMLElement;
  private table: HTMLTableElement;
  private o: HistogramOptions;
  private counts: ArrayLike<number> = [];
  private base: ArrayLike<number> = [];
  private brush: [number, number] | null = null; // bin indices, inclusive
  private dragFrom: number | null = null;
  private hover = -1;
  private pad = { l: 40, r: 8, t: 8, b: 24 };

  constructor(root: HTMLElement, o: HistogramOptions) {
    this.o = o;
    root.classList.add('card', 'hist');
    root.innerHTML = `
      <header><h3>${o.title}</h3><button class="link" aria-pressed="false">Table</button></header>
      <div class="plot"><canvas role="img" aria-label="${o.title} histogram"></canvas><div class="tip" hidden></div></div>
      <table class="data-table" hidden><thead><tr><th>${o.unit}</th><th>Selected</th><th>All</th></tr></thead><tbody></tbody></table>`;
    this.canvas = root.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.tip = root.querySelector('.tip')!;
    this.table = root.querySelector('table')!;
    const toggle = root.querySelector('button')!;
    toggle.addEventListener('click', () => {
      const show = this.table.hidden;
      this.table.hidden = !show;
      root.querySelector<HTMLElement>('.plot')!.hidden = show;
      toggle.setAttribute('aria-pressed', String(show));
    });
    new ResizeObserver(() => this.draw()).observe(this.canvas.parentElement!);
    this.bindPointer();
  }

  setEdges(edges: number[]) {
    this.o.edges = edges;
  }

  setData(counts: ArrayLike<number>, base: ArrayLike<number>) {
    this.counts = counts;
    this.base = base;
    this.draw();
    this.renderTable();
  }

  clearBrush() {
    this.brush = null;
    this.draw();
  }

  private get bins() {
    return this.o.edges.length - 1;
  }

  private binAt(clientX: number): number {
    const r = this.canvas.getBoundingClientRect();
    const w = r.width - this.pad.l - this.pad.r;
    const i = Math.floor(((clientX - r.left - this.pad.l) / w) * this.bins);
    return Math.max(0, Math.min(this.bins - 1, i));
  }

  private bindPointer() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.dragFrom = this.binAt(e.clientX);
      this.brush = [this.dragFrom, this.dragFrom];
      this.draw();
    });
    c.addEventListener('pointermove', (e) => {
      const b = this.binAt(e.clientX);
      if (this.dragFrom !== null) {
        this.brush = [Math.min(this.dragFrom, b), Math.max(this.dragFrom, b)];
      }
      this.hover = b;
      this.draw();
      this.showTip(e, b);
    });
    c.addEventListener('pointerleave', () => {
      this.hover = -1;
      this.tip.hidden = true;
      this.draw();
    });
    c.addEventListener('pointerup', () => {
      if (this.dragFrom === null) return;
      this.dragFrom = null;
      const b = this.brush!;
      // A single click on an already-brushed single bin clears the filter.
      const total = Array.from(this.base).reduce((a, x) => a + x, 0);
      if (!total) return;
      this.o.onBrush([this.o.edges[b[0]]!, this.o.edges[b[1] + 1]!]);
    });
    c.addEventListener('dblclick', () => {
      this.brush = null;
      this.o.onBrush(null);
      this.draw();
    });
  }

  private showTip(e: PointerEvent, b: number) {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    this.tip.hidden = false;
    this.tip.innerHTML = `<b>${this.o.label(b)}</b><br>${(this.counts[b] ?? 0).toLocaleString('en-US')} selected<span> · ${(this.base[b] ?? 0).toLocaleString('en-US')} total</span>`;
    const x = Math.min(r.width - 150, Math.max(0, e.clientX - r.left + 12));
    this.tip.style.transform = `translate(${x}px, ${Math.max(0, e.clientY - r.top - 54)}px)`;
  }

  private renderTable() {
    const rows: string[] = [];
    for (let i = 0; i < this.bins; i++) {
      if (!this.base[i]) continue;
      rows.push(`<tr><td>${this.o.label(i)}</td><td>${(this.counts[i] ?? 0).toLocaleString('en-US')}</td><td>${(this.base[i] ?? 0).toLocaleString('en-US')}</td></tr>`);
    }
    this.table.tBodies[0]!.innerHTML = rows.join('');
  }

  draw() {
    const { canvas, ctx, pad } = this;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = canvas.parentElement!.clientWidth;
    const H = canvas.parentElement!.clientHeight;
    if (!W || !H) return;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const css = getComputedStyle(canvas);
    const ink = css.getPropertyValue('--muted').trim();
    const grid = css.getPropertyValue('--grid').trim();
    const ghost = css.getPropertyValue('--ghost').trim();
    const series = css.getPropertyValue('--series-1').trim();

    const pw = W - pad.l - pad.r;
    const ph = H - pad.t - pad.b;
    let max = 1;
    for (let i = 0; i < this.bins; i++) max = Math.max(max, this.base[i] ?? 0);
    // Nice y-axis: 3 gridlines.
    const step = niceStep(max / 3);
    const top = Math.ceil(max / step) * step;
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let v = 0; v <= top; v += step) {
      const y = pad.t + ph - (v / top) * ph;
      ctx.fillStyle = grid;
      ctx.fillRect(pad.l, Math.round(y), pw, 1);
      ctx.fillStyle = ink;
      ctx.fillText(fmt(v), pad.l - 6, y);
    }

    const bw = pw / this.bins;
    const gap = Math.min(2, bw * 0.2);
    const bar = (i: number, v: number, color: string) => {
      if (v <= 0) return;
      const h = Math.max(1, (v / top) * ph);
      const x = pad.l + i * bw + gap / 2;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(x, pad.t + ph - h, Math.max(1, bw - gap), h, [Math.min(4, (bw - gap) / 2), Math.min(4, (bw - gap) / 2), 0, 0]);
      ctx.fill();
    };
    for (let i = 0; i < this.bins; i++) {
      bar(i, this.base[i] ?? 0, ghost);
      const inBrush = !this.brush || (i >= this.brush[0] && i <= this.brush[1]);
      ctx.globalAlpha = inBrush ? 1 : 0.35;
      bar(i, this.counts[i] ?? 0, series);
      ctx.globalAlpha = 1;
    }
    if (this.hover >= 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(pad.l + this.hover * bw, pad.t, bw, ph);
    }
    if (this.brush) {
      ctx.strokeStyle = series;
      ctx.lineWidth = 1;
      const x0 = pad.l + this.brush[0] * bw;
      const x1 = pad.l + (this.brush[1] + 1) * bw;
      ctx.strokeRect(Math.round(x0) + 0.5, pad.t + 0.5, Math.round(x1 - x0) - 1, ph - 1);
    }
    // Baseline + x ticks.
    ctx.fillStyle = css.getPropertyValue('--axis').trim();
    ctx.fillRect(pad.l, pad.t + ph, pw, 1);
    ctx.fillStyle = ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    let lastX = -Infinity;
    for (let i = 0; i <= this.bins; i++) {
      const t = this.o.tick(i);
      if (t === null) continue;
      const x = pad.l + i * bw;
      if (x - lastX < 46) continue;
      ctx.fillText(t, Math.min(W - 16, Math.max(pad.l + 10, x)), pad.t + ph + 6);
      lastX = x;
    }
  }
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
