// Builds the offline fallback: `node scripts/snapshot.ts <usgs-geojson-file>`
import { readFileSync, writeFileSync } from 'node:fs';
import { fromGeoJSON, toSnapshot } from '../src/data.ts';

const file = process.argv[2];
if (!file) throw new Error('usage: node scripts/snapshot.ts <all_month.geojson>');
const q = fromGeoJSON(JSON.parse(readFileSync(file, 'utf8')));
const snap = toSnapshot(q, 'USGS all_month.geojson');
writeFileSync('public/data/snapshot.json', JSON.stringify(snap));
console.log(`snapshot: ${q.n} events`);
