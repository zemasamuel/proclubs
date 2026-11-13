#!/usr/bin/env node
// Downloads club crest images from EA's CDN and saves them to crests/.
// Runs after fetch.mjs so it picks up any new opponent clubs.
import { readDb } from './db-io.mjs';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CRESTS_DIR = join(ROOT, 'crests');
const EA_CREST = id => `https://eafc24.content.easports.com/img/user_avatar/FC25/default/l${id}.png`;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Referer': 'https://www.ea.com/',
  'Origin': 'https://www.ea.com'
};

await mkdir(CRESTS_DIR, { recursive: true });

const db = readDb();
const ids = new Set();
for (const m of db.matches || []) {
  if (m.us?.crest) ids.add(String(m.us.crest));
  if (m.them?.crest) ids.add(String(m.them.crest));
}
console.log(`Found ${ids.size} unique crest IDs.`);

let fetched = 0, skipped = 0, failed = 0;
for (const id of ids) {
  const dest = join(CRESTS_DIR, `${id}.png`);
  // Skip if already downloaded
  try { await access(dest); skipped++; continue; } catch {}

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(EA_CREST(id), { headers: HEADERS, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(dest, buf);
      fetched++;
      console.log(`  ✓ ${id}.png (${buf.length} bytes)`);
      break;
    } catch (err) {
      console.warn(`  ✗ ${id} attempt ${attempt}: ${err.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt));
      else failed++;
    }
  }
}
console.log(`Done. ${fetched} fetched, ${skipped} already cached, ${failed} failed.`);
