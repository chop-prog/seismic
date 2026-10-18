import type { Quakes } from './data.ts';
import { DEPTH_CLASSES } from './engine.ts';
import { fitWorld, type Ring } from './geo.ts';

/** Ordinal depth ramp (validated: one hue, monotone lightness, clears the dark surface). */
export const DEPTH_COLORS = ['#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95'];
/** Sequential ramp for the density raster: dark (sparse) → light (dense) on a dark surface. */
const DENSITY = ['#104281', '#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'];
const POINT_LIMIT = 60_000;

export const depthClass = (d: number) => {
  let c = 0;
  while (c < DEPTH_CLASSES.length && d >= DEPTH_CLASSES[c]!) c++;
  return c;
};
export const radius = (mag: number) => Math.min(22, Math.max(1.6, 0.9 * 1.45 ** mag));

interface MapOptions {
  rings: Ring[];
  onBox: (box: [number, number, number, number] | null) => void;
  onHover: (i: number | null, x: number, y: number) => void;
}

export class MapView {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private o: MapOptions;
  private q: Quakes | null = null;
  private order: Uint32Array = new Uint32Array();
  private mask: Uint8Array | null = null;
  private px = new Float32Array();
  private py = new Float32Array();
  private fit = fitWorld(100, 100);
  private land: Path2D | null = null;
  private size = { w: 0, h: 0, dpr: 1 };
  private drag: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private box: [number, number, number, number] | null = null;
  private highlight: number | null = null;
  private grid = new Map<number, number[]>();
  mode: 'points' | 'density' = 'points';

  constructor(canvas: HTMLCanvasElement, o: MapOptions) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.o = o;
    new ResizeObserver(() => this.layout()).observe(canvas.parentElement!);
    this.bind();
  }

  setData(q: Quakes) {
    this.q = q;
    this.mask = null;
    this.mode = q.n > POINT_LIMIT ? 'density' : 'points';
    // Draw small events first so big ones stay on top (not needed for the density raster).
    this.order = this.mode === 'points' ? Uint32Array.from({ length: q.n }, (_, i) => i).sort((a, b) => q.mag[a]! - q.mag[b]!) : new Uint32Array();
    this.project();
    this.draw();
  }

  setMask(mask: Uint8Array) {
    this.mask = mask;
    this.draw();
  }

  setHighlight(i: number | null) {
    this.highlight = i;
    this.draw();
  }

  clearBox() {
    this.box = null;
    this.draw();
  }

  screenOf(i: number): [number, number] {
    return [this.px[i]!, this.py[i]!];
  }

  private layout() {
    const el = this.canvas.parentElement!;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.size = { w: el.clientWidth, h: el.clientHeight, dpr };
    this.canvas.width = Math.round(this.size.w * dpr);
    this.canvas.height = Math.round(this.size.h * dpr);
    this.canvas.style.width = `${this.size.w}px`;
    this.canvas.style.height = `${this.size.h}px`;
    this.fit = fitWorld(this.size.w, this.size.h);
    const path = new Path2D();
    for (const ring of this.o.rings) {
      ring.forEach(([lon, lat], k) => {
        const [x, y] = this.fit.project(lon, lat);
        if (k === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      });
      path.closePath();
    }
    this.land = path;
    this.project();
    this.draw();
  }

  private project() {
    const q = this.q;
    if (!q) return;
    this.px = new Float32Array(q.n);
    this.py = new Float32Array(q.n);
    for (let i = 0; i < q.n; i++) {
      const [x, y] = this.fit.project(q.lon[i]!, q.lat[i]!);
      this.px[i] = x;
      this.py[i] = y;
    }
  }

  private bind() {
    const c = this.canvas;
    const local = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top] as const;
    };
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      const [x, y] = local(e);
      this.drag = { x0: x, y0: y, x1: x, y1: y };
    });
    c.addEventListener('pointermove', (e) => {
      const [x, y] = local(e);
      if (this.drag) {
        this.drag.x1 = x;
        this.drag.y1 = y;
        this.draw();
        return;
      }
      this.o.onHover(this.nearest(x, y), x, y);
    });
    c.addEventListener('pointerleave', () => this.o.onHover(null, 0, 0));
    c.addEventListener('pointerup', () => {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (Math.abs(d.x1 - d.x0) < 6 && Math.abs(d.y1 - d.y0) < 6) {
        // A click clears the region filter.
        if (this.box) {
          this.box = null;
          this.o.onBox(null);
        }
        this.draw();
        return;
      }
      // Screen rectangle → lon/lat bounds (sample the edges: meridians curve in this projection).
      let lonMin = 180;
      let lonMax = -180;
      let latMin = 90;
      let latMax = -90;
      for (let t = 0; t <= 1; t += 0.125) {
        for (const [sx, sy] of [
          [d.x0 + (d.x1 - d.x0) * t, d.y0], [d.x0 + (d.x1 - d.x0) * t, d.y1],
          [d.x0, d.y0 + (d.y1 - d.y0) * t], [d.x1, d.y0 + (d.y1 - d.y0) * t],
        ] as const) {
          const [lon, lat] = this.fit.invert(sx, sy);
          lonMin = Math.min(lonMin, lon);
          lonMax = Math.max(lonMax, lon);
          latMin = Math.min(latMin, lat);
          latMax = Math.max(latMax, lat);
        }
      }
      const clampLon = (v: number) => Math.max(-180, Math.min(180, v));
      this.box = [clampLon(lonMin), Math.max(-90, latMin), clampLon(lonMax), Math.min(90, latMax)];
      this.o.onBox(this.box);
      this.draw();
    });
  }

  /** Nearest selected point within 14px, via a coarse screen-space grid. */
  private nearest(x: number, y: number): number | null {
    if (this.mode !== 'points') return null;
    let best: number | null = null;
    let bd = 14 * 14;
    const cell = 24;
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (const i of this.grid.get(gx * 4096 + gy) ?? []) {
          const d = (this.px[i]! - x) ** 2 + (this.py[i]! - y) ** 2;
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
      }
    }
    return best;
  }

  draw() {
    const { ctx, size, q } = this;
    if (!size.w || !this.land) return;
    const css = getComputedStyle(this.canvas);
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);

    // Graticule.
    ctx.strokeStyle = css.getPropertyValue('--grid').trim();
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let lon = -180; lon <= 180; lon += 30) {
      for (let lat = -60; lat <= 84; lat += 4) {
        const [x, y] = this.fit.project(lon, lat);
        if (lat === -60) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    for (let lat = -60; lat <= 80; lat += 20) {
      for (let lon = -180; lon <= 180; lon += 6) {
        const [x, y] = this.fit.project(lon, lat);
        if (lon === -180) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    ctx.fillStyle = css.getPropertyValue('--land').trim();
    ctx.fill(this.land);
    ctx.strokeStyle = css.getPropertyValue('--land-edge').trim();
    ctx.stroke(this.land);

    if (q) {
      if (this.mode === 'density') this.drawDensity(q);
      else this.drawPoints(q, css.getPropertyValue('--surface').trim());
    }

    const box = this.drag ?? (this.box ? this.boxToScreen(this.box) : null);
    if (box) {
      const x = Math.min(box.x0, box.x1);
      const y = Math.min(box.y0, box.y1);
      ctx.fillStyle = 'rgba(57, 135, 229, 0.08)';
      ctx.strokeStyle = '#3987e5';
      ctx.fillRect(x, y, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
    }

    if (this.highlight !== null && q) {
      const [x, y] = this.screenOf(this.highlight);
      const r = radius(q.mag[this.highlight]!) + 6;
      ctx.strokeStyle = '#f0efec';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private boxToScreen(b: [number, number, number, number]) {
    const [x0, y0] = this.fit.project(b[0], b[3]);
    const [x1, y1] = this.fit.project(b[2], b[1]);
    return { x0, y0, x1, y1 };
  }

  private drawPoints(q: Quakes, surface: string) {
    const { ctx, mask, order, px, py } = this;
    this.grid.clear();
    // Context: unselected events as faint dots.
    if (mask) {
      ctx.fillStyle = 'rgba(137, 135, 129, 0.35)';
      for (let k = 0; k < order.length; k++) {
        const i = order[k]!;
        if (!mask[i]) ctx.fillRect(px[i]! - 0.75, py[i]! - 0.75, 1.5, 1.5);
      }
    }
    // Selection: size = magnitude, colour = depth class; 1px surface ring separates overlaps.
    ctx.lineWidth = 1;
    ctx.strokeStyle = surface;
    for (let k = 0; k < order.length; k++) {
      const i = order[k]!;
      if (mask && !mask[i]) continue;
      const r = radius(q.mag[i]!);
      ctx.fillStyle = DEPTH_COLORS[depthClass(q.depth[i]!)]!;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(px[i]!, py[i]!, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (r > 2.5) ctx.stroke();
      const key = Math.floor(px[i]! / 24) * 4096 + Math.floor(py[i]! / 24);
      const cell = this.grid.get(key);
      if (cell) cell.push(i);
      else this.grid.set(key, [i]);
    }
  }

  /** 1M points: accumulate into a half-resolution density grid, colour on a log scale. */
  private drawDensity(q: Quakes) {
    const { size, mask, px, py } = this;
    const s = 2;
    const gw = Math.ceil(size.w / s);
    const gh = Math.ceil(size.h / s);
    const counts = new Uint32Array(gw * gh);
    let max = 0;
    for (let i = 0; i < q.n; i++) {
      if (mask && !mask[i]) continue;
      const gx = (px[i]! / s) | 0;
      const gy = (py[i]! / s) | 0;
      if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
      const c = ++counts[gy * gw + gx]!;
      if (c > max) max = c;
    }
    const img = new ImageData(gw, gh);
    const ramp = DENSITY.map((h) => [Number.parseInt(h.slice(1, 3), 16), Number.parseInt(h.slice(3, 5), 16), Number.parseInt(h.slice(5, 7), 16)]);
    const lm = Math.log1p(max || 1);
    for (let k = 0; k < counts.length; k++) {
      const c = counts[k]!;
      if (!c) continue;
      const t = Math.log1p(c) / lm;
      const [r, g, b] = ramp[Math.min(ramp.length - 1, Math.floor(t * ramp.length))]!;
      img.data[k * 4] = r!;
      img.data[k * 4 + 1] = g!;
      img.data[k * 4 + 2] = b!;
      img.data[k * 4 + 3] = 140 + 115 * t;
    }
    const off = new OffscreenCanvas(gw, gh);
    off.getContext('2d')!.putImageData(img, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(off, 0, 0, gw * s, gh * s);
    this.ctx.imageSmoothingEnabled = true;
  }
}
