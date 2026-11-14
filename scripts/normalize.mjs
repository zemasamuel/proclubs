// Turns EA's raw Clubs JSON into the compact shape the site reads from data/db.js.
// Every value is forced to a number, a fixed keyword or a plain string here, so nothing
// EA sends is stored as-is.

const POS = { goalkeeper: 'GK', defender: 'DEF', midfielder: 'MID', forward: 'FWD' };
const TYPES = { leagueMatch: 'league', playoffMatch: 'playoff', friendlyMatch: 'friendly' };
const POS_ORDER = { GK: 0, DEF: 1, MID: 2, FWD: 3, 'N/A': 4 };

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pos = p => POS[String(p || '').toLowerCase()] || 'N/A';
const digits = v => (/^\d{1,20}$/.test(String(v ?? '')) ? String(v) : '');

function normPlayer(id, r) {
  return {
    id: String(id),
    name: String(r.playername || r.name || 'Unknown'),
    pos: pos(r.pos),
    rating: Math.round(num(r.rating) * 100) / 100,
    goals: num(r.goals),
    assists: num(r.assists),
    shots: num(r.shots),
    passesMade: num(r.passesmade),
    passAttempts: num(r.passattempts),
    tacklesMade: num(r.tacklesmade),
    tackleAttempts: num(r.tackleattempts),
    saves: num(r.saves),
    goalsConceded: num(r.goalsconceded),
    cleanSheet: num(r.cleansheetsany) > 0,
    motm: num(r.mom) > 0,
    secondsPlayed: num(r.secondsPlayed)
  };
}

// Team totals add up the human players only; EA does not report AI teammates.
function teamTotals(players) {
  const t = { shots: 0, passesMade: 0, passAttempts: 0, tacklesMade: 0, tackleAttempts: 0,
              saves: 0, playerGoals: 0, humans: players.length, avgRating: 0 };
  let sum = 0, rated = 0;
  for (const p of players) {
    t.shots += p.shots; t.passesMade += p.passesMade; t.passAttempts += p.passAttempts;
    t.tacklesMade += p.tacklesMade; t.tackleAttempts += p.tackleAttempts;
    t.saves += p.saves; t.playerGoals += p.goals;
    if (p.rating > 0) { sum += p.rating; rated++; }
  }
  t.avgRating = rated ? Math.round(sum / rated * 100) / 100 : 0;
  return t;
}

// raw: one entry of EA's /clubs/matches array. type: leagueMatch | playoffMatch | friendlyMatch.
function normalizeMatch(raw, clubId, type) {
  if (!raw || typeof raw !== 'object' || !raw.clubs) return null;
  const usKey = String(clubId);
  const keys = Object.keys(raw.clubs);
  const themKey = keys.find(k => k !== usKey);
  if (!keys.includes(usKey) || themKey === undefined) return null;

  const side = key => {
    const c = raw.clubs[key] || {};
    const rp = (raw.players && raw.players[key]) || {};
    const players = Object.keys(rp).map(pid => normPlayer(pid, rp[pid] || {}))
      .sort((a, b) => POS_ORDER[a.pos] - POS_ORDER[b.pos] || b.rating - a.rating);
    return {
      club: { id: String(key), name: String(c.details?.name || 'Unknown club'), goals: num(c.goals),
              crest: digits(c.details?.customKit?.crestAssetId) },
      players, stats: teamTotals(players), raw: c
    };
  };
  const us = side(usKey), them = side(themKey);

  let result;
  if (num(us.raw.wins) > 0) result = 'W';
  else if (num(us.raw.losses) > 0) result = 'L';
  else if (num(us.raw.ties) > 0) result = 'D';
  else result = us.club.goals > them.club.goals ? 'W' : us.club.goals < them.club.goals ? 'L' : 'D';

  let ts = num(raw.timestamp);
  if (ts > 1e12) ts = Math.round(ts / 1000);
  const id = digits(raw.matchId);
  if (!ts || !id) return null;

  return {
    id, ts,
    type: TYPES[type] || 'league',
    result,
    dnf: num(us.raw.winnerByDnf) > 0 || num(them.raw.winnerByDnf) > 0,
    us: us.club, them: them.club,
    stats: { us: us.stats, them: them.stats },
    players: { us: us.players, them: them.players }
  };
}

// Later entries win, so a re-fetch refreshes a match instead of duplicating it.
function mergeMatches(existing, incoming) {
  const map = new Map();
  for (const m of [...existing, ...incoming]) if (m && m.id) map.set(m.id, m);
  return [...map.values()].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
}

function normalizeMembers(raw) {
  const out = {};
  for (const m of Array.isArray(raw?.members) ? raw.members : []) {
    if (!m || typeof m.name !== 'string' || !m.name || m.name === '__proto__') continue;
    out[m.name] = {
      proName: String(m.proName || ''), overall: num(m.proOverall), heightCm: num(m.proHeight),
      favoritePosition: pos(m.favoritePosition),
      gamesPlayed: num(m.gamesPlayed), goals: num(m.goals), assists: num(m.assists),
      ratingAve: num(m.ratingAve), motm: num(m.manOfTheMatch), winRate: num(m.winRate),
      shotSuccessRate: num(m.shotSuccessRate), passesMade: num(m.passesMade), passSuccessRate: num(m.passSuccessRate),
      tacklesMade: num(m.tacklesMade), tackleSuccessRate: num(m.tackleSuccessRate),
      cleanSheets: num(m.cleanSheetsDef) + num(m.cleanSheetsGK)
    };
  }
  return out;
}

function normalizeOverall(raw, clubId) {
  const list = Array.isArray(raw) ? raw : [];
  const o = list.find(x => x && String(x.clubId) === String(clubId)) || list[0];
  if (!o) return null;
  return {
    wins: num(o.wins), draws: num(o.ties), losses: num(o.losses),
    goals: num(o.goals), goalsAgainst: num(o.goalsAgainst),
    gamesPlayed: num(o.gamesPlayed), leagueApps: num(o.leagueAppearances),
    playoffApps: num(o.gamesPlayedPlayoff), skillRating: num(o.skillRating),
    promotions: num(o.promotions), relegations: num(o.relegations),
    winStreak: num(o.wstreak), unbeatenStreak: num(o.unbeatenstreak)
  };
}

// bundle: { info, overall, members, matches: { leagueMatch: [...], playoffMatch: [...], friendlyMatch: [...] } }
// Any part may be missing; whatever arrived is merged into the saved db. Saved matches are never dropped.
export function applyFetch(db, bundle, clubId, nowIso) {
  const out = {
    version: 1,
    updatedAt: nowIso,
    club: { id: String(clubId), name: 'Eaters', platform: 'common-gen5', ...(db?.club || {}) },
    members: db?.members || {},
    matches: db?.matches || []
  };
  const info = bundle.info?.[String(clubId)];
  if (info?.name) out.club.name = String(info.name);
  const overall = normalizeOverall(bundle.overall, clubId);
  if (overall) { out.club.overall = overall; out.club.overallAsOf = nowIso; }
  const members = normalizeMembers(bundle.members);
  if (Object.keys(members).length) out.members = members;
  const incoming = Object.keys(bundle.matches || {})
    .flatMap(t => (Array.isArray(bundle.matches[t]) ? bundle.matches[t] : []).map(r => normalizeMatch(r, clubId, t)).filter(Boolean));
  out.matches = mergeMatches(out.matches, incoming);
  return out;
}
