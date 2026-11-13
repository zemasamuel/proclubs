import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const DB_PATH = fileURLToPath(new URL('../data/db.js', import.meta.url));
const PREFIX = 'window.EATMOB_DB = ';
export function readDb() {
  if (!existsSync(DB_PATH)) return null;
  const txt = readFileSync(DB_PATH, 'utf8').trim();
  if (!txt.startsWith(PREFIX)) throw new Error('data/db.js is not in the expected format');
  return JSON.parse(txt.slice(PREFIX.length).replace(/;\s*$/, ''));
}
export function writeDb(db) {
  writeFileSync(DB_PATH, PREFIX + JSON.stringify(db) + ';\n');
}
