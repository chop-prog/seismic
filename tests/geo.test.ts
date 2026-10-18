import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fitWorld, naturalEarth, naturalEarthInvert, topoRings } from '../src/geo.ts';

describe('Natural Earth projection', () => {
  it('maps the origin to the origin and is symmetric', () => {
    expect(naturalEarth(0, 0)).toEqual([0, 0]);
    const [x1, y1] = naturalEarth(120, 40);
    const [x2, y2] = naturalEarth(-120, -40);
    expect(x2).toBeCloseTo(-x1, 12);
    expect(y2).toBeCloseTo(-y1, 12);
  });

  it('matches reference values (d3-geo naturalEarth1Raw)', () => {
    const [x, y] = naturalEarth(180, 0);
    expect(x).toBeCloseTo(0.8707 * Math.PI, 10);
    expect(y).toBe(0);
  });

  it('inverts the forward projection', () => {
    for (const [lon, lat] of [[0, 0], [139.7, 35.7], [-70.6, -33.4], [179, 84], [-179, -59]] as const) {
      const [x, y] = naturalEarth(lon, lat);
      const [lon2, lat2] = naturalEarthInvert(x, y);
      expect(lon2).toBeCloseTo(lon, 6);
      expect(lat2).toBeCloseTo(lat, 6);
    }
  });

  it('fitWorld keeps the globe inside the box and round-trips screen coordinates', () => {
    const f = fitWorld(800, 420);
    for (const [lon, lat] of [[-180, 0], [180, 0], [0, 84], [0, -60]] as const) {
      const [sx, sy] = f.project(lon, lat);
      expect(sx).toBeGreaterThanOrEqual(7.99);
      expect(sx).toBeLessThanOrEqual(792.01);
      expect(sy).toBeGreaterThanOrEqual(7.99);
      expect(sy).toBeLessThanOrEqual(412.01);
    }
    const [lon, lat] = f.invert(...f.project(23.4, -12.3));
    expect(lon).toBeCloseTo(23.4, 6);
    expect(lat).toBeCloseTo(-12.3, 6);
  });
});

describe('TopoJSON decoding', () => {
  it('decodes delta-encoded arcs and stitches reversed arcs', () => {
    const topo = {
      transform: { scale: [1, 1] as [number, number], translate: [0, 0] as [number, number] },
      arcs: [[[0, 0], [10, 0], [0, 10]], [[0, 0], [0, 10]]] as [number, number][][],
      objects: { shape: { type: 'GeometryCollection', geometries: [{ type: 'Polygon', arcs: [[0, ~1]] }] } },
    };
    // arc0: (0,0)→(10,0)→(10,10); arc1: (0,0)→(0,10), reversed: (0,10)→(0,0)
    expect(topoRings(topo, 'shape')).toEqual([[[0, 0], [10, 0], [10, 10], [0, 0]]]);
  });

  it('decodes the bundled world land outlines into closed rings', () => {
    const topo = JSON.parse(readFileSync('node_modules/world-atlas/land-110m.json', 'utf8'));
    const rings = topoRings(topo, 'land');
    expect(rings.length).toBeGreaterThan(100);
    for (const r of rings) {
      expect(r[0]).toEqual(r[r.length - 1]);
      for (const [lon, lat] of r) {
        expect(Math.abs(lon)).toBeLessThanOrEqual(180.0001);
        expect(Math.abs(lat)).toBeLessThanOrEqual(90.0001);
      }
    }
  });
});
