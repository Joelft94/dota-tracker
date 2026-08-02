// Refreshes the vendored hero constants. Run weekly by .github/workflows/heroes.yml,
// which commits the result only when it actually changed.
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../poller/config.js';
import { fetchJson } from '../poller/http.js';

const raw = await fetchJson('https://api.opendota.com/api/constants/heroes');

const out = {};
for (const key of Object.keys(raw)) {
  const h = raw[key];
  out[h.id] = {
    id: h.id,
    name: h.localized_name,
    img: h.img,
    attr: h.primary_attr,
    roles: h.roles,
  };
}

// The dashboard deploys from its own directory on Vercel and can't import files above
// its root, so it keeps a copy. Writing both here keeps them from drifting.
const targets = [join(ROOT, 'poller', 'heroes.json'), join(ROOT, 'dashboard', 'lib', 'heroes.json')];
const next = JSON.stringify(out, null, 1);
let changed = false;

for (const path of targets) {
  const prev = readFileSync(path, 'utf8');
  if (prev !== next) {
    writeFileSync(path, next);
    changed = true;
  }
}

console.log(
  changed
    ? `Updated: ${Object.keys(out).length} heroes.`
    : `No change (${Object.keys(out).length} heroes).`
);
