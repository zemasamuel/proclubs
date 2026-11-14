#!/usr/bin/env node
// Pulls the club's latest matches from EA and merges them into data/db.js.
// EA only returns the most recent few matches per type, so run this often:
// every run adds whatever is new and keeps everything already saved.
// When nothing has changed the file is left alone, so there is nothing to commit.
import { CLUB_ID, PLATFORM, API_BASE, MATCH_TYPES } from './config.mjs';
import { readDb, writeDb } from './db-io.mjs';
import { applyFetch } from './normalize.mjs';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.ea.com/',
  'Origin': 'https://www.ea.com'
};

async function get(path, params) {
  const url = `${API_BASE}${path}?${new URLSearchParams(params)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, redirect: 'error', signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.warn(`  ${path} attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  return null;
}

const bundle = { matches: {} };
let matchCallsOk = 0;
for (const t of MATCH_TYPES) {
  console.log(`Fetching ${t}…`);
  const list = await get('/clubs/matches', { platform: PLATFORM, matchType: t, clubIds: CLUB_ID, maxResultCount: '20' });
  if (Array.isArray(list)) { bundle.matches[t] = list; matchCallsOk++; console.log(`  ${list.length} matches`); }
}
bundle.info = await get('/clubs/info', { platform: PLATFORM, clubIds: CLUB_ID });
bundle.overall = await get('/clubs/overallStats', { platform: PLATFORM, clubIds: CLUB_ID });
bundle.members = await get('/members/stats', { platform: PLATFORM, clubId: CLUB_ID });

if (matchCallsOk === 0) {
  console.error('EA returned no match data (blocked or down). data/db.js left unchanged.');
  process.exit(1);
}

// Compare everything except the two timestamps, which change on every run.
const fingerprint = d => JSON.stringify([{ ...d.club, overallAsOf: null }, d.members, d.matches]);

const prev = readDb();
const db = applyFetch(prev, bundle, CLUB_ID, new Date().toISOString());
if (prev && fingerprint(prev) === fingerprint(db)) {
  console.log(`No new data (${db.matches.length} matches saved).`);
} else {
  writeDb(db);
  console.log(`Saved ${db.matches.length} matches (${db.matches.length - (prev ? prev.matches.length : 0)} new).`);
}
