// Just enough cartography: a TopoJSON decoder and the Natural Earth I projection
// (forward + inverse), with no mapping library.

export type Ring = [number, number][];

interface Topology {
  transform?: { scale: [number, number]; translate: [number, number] };
  arcs: [number, number][][];
  objects: Record<string, { type: string; geometries?: Geometry[]; arcs?: unknown }>;
}
type Geometry = { type: 'Polygon'; arcs: number[][] } | { type: 'MultiPolygon'; arcs: number[][][] } | { type: string; arcs?: unknown };

/** Decode a TopoJSON object into polygon rings of [lon, lat]. */
export function topoRings(topo: Topology, objectName: string): Ring[] {
  // 1. Undo delta + quantisation encoding of the shared arcs.
  const arcs = topo.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      if (topo.transform) {
        x += dx;
        y += dy;
        return [x * topo.transform.scale[0] + topo.transform.translate[0], y * topo.transform.scale[1] + topo.transform.translate[1]] as [number, number];
      }
      return [dx, dy] as [number, number];
    });
  });
  // 2. Stitch rings from arc references; ~i means arc i reversed.
  const ring = (refs: number[]): Ring => {
    const out: Ring = [];
    refs.forEach((ref, k) => {
      const pts = ref >= 0 ? arcs[ref]! : arcs[~ref]!.slice().reverse();
      out.push(...(k === 0 ? pts : pts.slice(1)));
    });
    return out;
  };
  const obj = topo.objects[objectName]!;
  const geoms = (obj.geometries ?? [obj]) as Geometry[];
  const rings: Ring[] = [];
  for (const g of geoms) {
    if (g.type === 'Polygon') for (const r of (g.arcs as number[][])) rings.push(ring(r));
    else if (g.type === 'MultiPolygon') for (const poly of (g.arcs as number[][][])) for (const r of poly) rings.push(ring(r));
  }
  return rings;
}

const RAD = Math.PI / 180;

/** Natural Earth I (Šavrič et al.), unit scale, input in degrees. */
export function naturalEarth(lon: number, lat: number): [number, number] {
  const l = lon * RAD;
  const p = lat * RAD;
  const p2 = p * p;
  const p4 = p2 * p2;
  return [
    l * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4))),
    p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4))),
  ];
}

/** Inverse via Newton's method on the latitude polynomial. */
export function naturalEarthInvert(x: number, y: number): [number, number] {
  let p = y;
  for (let i = 0; i < 25; i++) {
    const p2 = p * p;
    const p4 = p2 * p2;
    const f = p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4))) - y;
    const df = 1.007226 + p2 * (3 * 0.015085 + p4 * (-7 * 0.044475 + 9 * 0.028874 * p2 - 11 * 0.005916 * p4));
    const step = f / df;
    p -= step;
    if (Math.abs(step) < 1e-10) break;
  }
  const p2 = p * p;
  const p4 = p2 * p2;
  const l = x / (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4)));
  return [l / RAD, p / RAD];
}

/** Fit the whole globe (cropped at 60°S, Antarctica is quiet) into a w×h box. */
export function fitWorld(w: number, h: number, pad = 8) {
  const [xMax] = naturalEarth(180, 0);
  const [, yTop] = naturalEarth(0, 84);
  const [, yBottom] = naturalEarth(0, -60);
  const k = Math.min((w - pad * 2) / (xMax * 2), (h - pad * 2) / (yTop - yBottom));
  const cx = w / 2;
  const cy = h / 2 + ((yTop + yBottom) / 2) * k;
  return {
    k,
    project(lon: number, lat: number): [number, number] {
      const [x, y] = naturalEarth(lon, lat);
      return [cx + x * k, cy - y * k];
    },
    invert(sx: number, sy: number): [number, number] {
      return naturalEarthInvert((sx - cx) / k, (cy - sy) / k);
    },
  };
}
