/* eatmob — turns EA's raw Clubs JSON into the compact shape the site reads.
   Runs in the browser (window.EatmobNormalize) and in Node (require). */
(function (root) {
  'use strict';

  var POS = { goalkeeper: 'GK', defender: 'DEF', midfielder: 'MID', forward: 'FWD' };
  var TYPES = { leagueMatch: 'league', playoffMatch: 'playoff', friendlyMatch: 'friendly' };

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function pos(p) { return POS[String(p || '').toLowerCase()] || 'N/A'; }

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
      redCards: num(r.redcards),
      goalsConceded: num(r.goalsconceded),
      cleanSheet: num(r.cleansheetsany) > 0,
      motm: num(r.mom) > 0,
      secondsPlayed: num(r.secondsPlayed)
    };
  }

  function teamTotals(players) {
    var t = { shots: 0, passesMade: 0, passAttempts: 0, tacklesMade: 0, tackleAttempts: 0,
              saves: 0, redCards: 0, playerGoals: 0, humans: players.length, avgRating: 0 };
    var rs = 0, rn = 0;
    players.forEach(function (p) {
      t.shots += p.shots; t.passesMade += p.passesMade; t.passAttempts += p.passAttempts;
      t.tacklesMade += p.tacklesMade; t.tackleAttempts += p.tackleAttempts;
      t.saves += p.saves; t.redCards += p.redCards; t.playerGoals += p.goals;
      if (p.rating > 0) { rs += p.rating; rn++; }
    });
    t.avgRating = rn ? Math.round(rs / rn * 100) / 100 : 0;
    return t;
  }

  /* raw: one entry of EA's /clubs/matches array. type: league | playoff | friendly. */
  function normalizeMatch(raw, clubId, type) {
    if (!raw || typeof raw !== 'object' || !raw.clubs) return null;
    var usKey = String(clubId);
    var keys = Object.keys(raw.clubs);
    if (keys.indexOf(usKey) < 0) return null;
    var themKey = keys.filter(function (k) { return k !== usKey; })[0];
    if (themKey === undefined) return null;

    function side(key) {
      var c = raw.clubs[key] || {};
      var rp = (raw.players && raw.players[key]) || {};
      var players = Object.keys(rp).map(function (pid) { return normPlayer(pid, rp[pid] || {}); });
      var order = { GK: 0, DEF: 1, MID: 2, FWD: 3, 'N/A': 4 };
      players.sort(function (a, b) { return order[a.pos] - order[b.pos] || b.rating - a.rating; });
      return {
        club: { id: String(key), name: String((c.details && c.details.name) || 'Unknown club'), goals: num(c.goals),
                crest: String((c.details && c.details.customKit && c.details.customKit.crestAssetId) || '') },
        players: players,
        stats: teamTotals(players),
        raw: c
      };
    }
    var us = side(usKey), them = side(themKey);

    var result;
    if (num(us.raw.wins) > 0) result = 'W';
    else if (num(us.raw.losses) > 0) result = 'L';
    else if (num(us.raw.ties) > 0) result = 'D';
    else result = us.club.goals > them.club.goals ? 'W' : us.club.goals < them.club.goals ? 'L' : 'D';

    var ts = num(raw.timestamp);
    if (ts > 1e12) ts = Math.round(ts / 1000);
    if (!ts || raw.matchId === undefined || raw.matchId === null) return null;

    return {
      id: String(raw.matchId),
      ts: ts,
      type: TYPES[type] || type || 'league',
      result: result,
      dnf: num(us.raw.winnerByDnf) > 0 || num(them.raw.winnerByDnf) > 0,
      us: us.club, them: them.club,
      stats: { us: us.stats, them: them.stats },
      players: { us: us.players, them: them.players }
    };
  }

  function normalizeMatches(rawList, clubId, type) {
    if (!Array.isArray(rawList)) return [];
    return rawList.map(function (r) { return normalizeMatch(r, clubId, type); }).filter(Boolean);
  }

  /* Later entries win, so a re-fetch refreshes a match instead of duplicating it. */
  function mergeMatches(existing, incoming) {
    var map = {};
    (existing || []).concat(incoming || []).forEach(function (m) { if (m && m.id) map[m.id] = m; });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return a.ts - b.ts || (a.id < b.id ? -1 : 1); });
  }

  function normalizeMembers(raw) {
    var out = {};
    var list = raw && Array.isArray(raw.members) ? raw.members : [];
    list.forEach(function (m) {
      if (!m || !m.name) return;
      out[m.name] = {
        proName: m.proName || '', overall: num(m.proOverall), heightCm: num(m.proHeight),
        favoritePosition: pos(m.favoritePosition),
        gamesPlayed: num(m.gamesPlayed), goals: num(m.goals), assists: num(m.assists),
        ratingAve: num(m.ratingAve), motm: num(m.manOfTheMatch), winRate: num(m.winRate),
        shotSuccessRate: num(m.shotSuccessRate), passesMade: num(m.passesMade), passSuccessRate: num(m.passSuccessRate),
        tacklesMade: num(m.tacklesMade), tackleSuccessRate: num(m.tackleSuccessRate),
        cleanSheets: num(m.cleanSheetsDef) + num(m.cleanSheetsGK), redCards: num(m.redCards)
      };
    });
    return out;
  }

  function normalizeOverall(raw, clubId) {
    var list = Array.isArray(raw) ? raw : [];
    var o = list.filter(function (x) { return x && String(x.clubId) === String(clubId); })[0] || list[0];
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

  /* bundle: { info, overall, members, matches: { leagueMatch: [...], playoffMatch: [...], friendlyMatch: [...] } }
     Any part may be missing; whatever arrived is merged into db. */
  function applyFetch(db, bundle, clubId, nowIso) {
    var out = {
      version: 1,
      sample: false,
      updatedAt: nowIso,
      club: Object.assign({ id: String(clubId), name: 'Eaters', platform: 'common-gen5' }, (db && db.club) || {}),
      members: (db && db.members) || {},
      matches: (db && db.matches) || []
    };
    var info = bundle.info && bundle.info[String(clubId)];
    if (info && info.name) out.club.name = String(info.name);
    var overall = normalizeOverall(bundle.overall, clubId);
    if (overall) { out.club.overall = overall; out.club.overallAsOf = nowIso; }
    var members = normalizeMembers(bundle.members);
    if (Object.keys(members).length) out.members = members;
    var incoming = [];
    Object.keys(bundle.matches || {}).forEach(function (t) {
      incoming = incoming.concat(normalizeMatches(bundle.matches[t], clubId, t));
    });
    out.matches = mergeMatches(out.matches, incoming);
    out.added = incoming.length;
    return out;
  }

  var api = { normalizeMatch: normalizeMatch, normalizeMatches: normalizeMatches, mergeMatches: mergeMatches,
              normalizeMembers: normalizeMembers, normalizeOverall: normalizeOverall, applyFetch: applyFetch };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EatmobNormalize = api;
})(typeof self !== 'undefined' ? self : this);
