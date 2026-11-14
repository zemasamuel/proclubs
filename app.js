/* eatmob — FC Pro Clubs match tracker for the Eaters.
 * All views are rendered client-side from window.EATMOB_DB (data/db.js).
 * No server; every page load builds the UI from the static data file. */
(function () {
  'use strict';

  /* ---------- constants ---------- */
  var TIME_ZONE = 'America/Chicago';
  var CREST_BASE = 'https://eatmob-crests.zemasamuel.workers.dev/';
  /* Primary avatar image; SVG data-URL fallback if the asset fails to load */
  var PLAYER_AVATAR_URL = 'assets/player-fallback-dark.png';
  var PLAYER_AVATAR_FALLBACK = "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%23232927'/%3E%3Ccircle cx='32' cy='23' r='12' fill='%235c6662'/%3E%3Cpath d='M10 64c2-14 12-22 22-22s20 8 22 22' fill='%235c6662'/%3E%3C/svg%3E";
  var DAY_STARTS_AT_HOUR = 5;      // games ending before 5 AM count for the previous day
  var MATCH_SECONDS = 5400;        // game-clock seconds in 90 minutes
  var SUB_MARGIN = 60;             // played this many seconds less than the longest-serving player = sub
  var TYPE_LABEL = { league: 'League', playoff: 'Playoffs', friendly: 'Friendlies' };
  var POS_LABEL = { GK: 'Goalkeeper', DEF: 'Defender', MID: 'Midfielder', FWD: 'Forward', 'N/A': 'Unknown' };
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  /* ---------- DOM refs & UI state ---------- */
  var view = document.getElementById('view');
  var chartTip = document.getElementById('chart-tip');
  /* ui holds all ephemeral view state; render() reads from it every time */
  var ui = {
    calOpen: false,
    calMonth: null,       // null = show today's month
    tab: 'facts',         // active tab on match detail view
    squadMode: 'tracked', // 'tracked' (this season) | 'ea' (career) | 'per90' | 'compare'
    squadQuery: '',       // text filter on squad table
    squadPos: 'ALL',      // position filter on squad table
    oppQuery: '',         // text filter on opponents table
    sortK: 'rating',      // squad table sort column
    sortDir: -1,          // -1 = descending, 1 = ascending
    cmpSel: [],           // compare: selected player IDs, in pick order
    matchSort: { k: 'rating', dir: -1 },   // match detail player-table sort
    per90Sort: { k: 'mins', dir: -1 },     // squad per-90 table sort
    insSort: { k: 'impact', dir: -1 }      // squad insights table sort
  };
  var db, idx;

  /* ---------- utility / formatting helpers ---------- */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function slug(s) { return String(s).replace(/[^A-Za-z0-9]/g, ''); }
  function keyOfDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function dateOfKey(k) { var p = k.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(k, n) { var d = dateOfKey(k); d.setDate(d.getDate() + n); return keyOfDate(d); }
  function validKey(k) { return /^\d{4}-\d{2}-\d{2}$/.test(k) && keyOfDate(dateOfKey(k)) === k; }
  var zoneFmt = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  function zoneParts(ts) { var o = {}; zoneFmt.formatToParts(new Date(ts * 1000)).forEach(function (p) { o[p.type] = p.value; }); o.hour = (+o.hour) % 24; return o; }
  function zoneKey(ts) { var p = zoneParts(ts); return p.year + '-' + p.month + '-' + p.day; }
  function zoneHour(ts) { return zoneParts(ts).hour; }
  function dayKeyOf(ts) { var p = zoneParts(ts), k = p.year + '-' + p.month + '-' + p.day; return p.hour < DAY_STARTS_AT_HOUR ? addDays(k, -1) : k; }
  function todayKey() { return dayKeyOf(Date.now() / 1000); }
  function fmtTime(ts) { return new Date(ts * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TIME_ZONE }); }
  var WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function fmtDayLong(k) { var d = dateOfKey(k); return WD_LONG[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear(); }
  function fmtDayShort(k) { var d = dateOfKey(k); return MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getDate(); }

  function f1(v) { return v === null || v === undefined || !isFinite(v) ? '–' : v.toFixed(1); }
  function f2(v) { return v === null || v === undefined || !isFinite(v) ? '–' : v.toFixed(2); }
  function pct(a, b) { return b > 0 ? a / b * 100 : null; }
  function pctS(a, b) { var v = pct(a, b); return v === null ? '–' : Math.round(v) + '%'; }
  function per90(v, sec) { return sec > 0 ? v * MATCH_SECONDS / sec : null; }
  function mins(sec) { return Math.round(sec / 60); }
  function games(n) { return n + (n === 1 ? ' game' : ' games'); }

  /* Images carry no inline onerror: the page's Content-Security-Policy forbids inline script.
     Load failures are handled by the single 'error' listener at the bottom of this file. */
  function playerImg(name) {
    var src = name ? 'assets/players/' + encodeURIComponent(name) + '.jpg' : PLAYER_AVATAR_URL;
    return '<img class="p-img" src="' + src + '" alt="" loading="lazy" decoding="async">';
  }

  /* Rating chip: red to green by tenth, blue with a star for player of the match. */
  var RT_STOPS = [[4, [214, 54, 50]], [5.5, [232, 108, 28]], [6.5, [226, 146, 16]], [7.3, [150, 172, 30]], [8, [70, 170, 56]], [9, [28, 150, 70]], [10, [10, 125, 62]]];
  var MOTM_BLUE = '#1f7ae0';
  function rtColor(r, motm) {
    if (motm) return MOTM_BLUE;
    var v = Math.max(4, Math.min(10, Math.round(r * 10) / 10)), i = 1;
    while (RT_STOPS[i][0] < v) i++;
    var a = RT_STOPS[i - 1], b = RT_STOPS[i], t = (v - a[0]) / (b[0] - a[0]);
    return 'rgb(' + a[1].map(function (c, k) { return Math.round(c + (b[1][k] - c) * t); }).join(',') + ')';
  }
  /* Rating chip: colour-coded span, blue with star for MOTM. */
  function rt(r, big, motm) {
    var cls = 'rt' + (big ? ' big' : '');
    if (!(r > 0)) return '<span class="' + cls + ' none">–</span>';
    return '<span class="' + cls + '" style="background:' + rtColor(r, motm) + '"' + (motm ? ' title="Player of the match"' : '') + '>' + r.toFixed(1) + (motm ? ICON_STAR : '') + '</span>';
  }

  function svg(cls, body) { return '<svg class="' + cls + '" viewBox="0 0 24 24" aria-hidden="true">' + body + '</svg>'; }
  var ICON_STAR = svg('i-star', '<path d="M12 1.8l3.1 6.6 7.2.9-5.3 5 1.4 7.1L12 17.9l-6.4 3.5 1.4-7.1-5.3-5 7.2-.9z"/>');
  var ICON_SHARE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';

  /* FotMob-style goal ball SVG */
  var ICON_BALL = svg('i-ball',
    '<circle cx="12" cy="12" r="9.2" fill="none" stroke="#1b2220" stroke-width="1.8"/>' +
    '<circle cx="12" cy="6.8" r="1.9" fill="#1b2220"/>' +
    '<circle cx="16.9" cy="10.4" r="1.9" fill="#1b2220"/>' +
    '<circle cx="15" cy="16.1" r="1.9" fill="#1b2220"/>' +
    '<circle cx="9" cy="16.1" r="1.9" fill="#1b2220"/>' +
    '<circle cx="7.1" cy="10.4" r="1.9" fill="#1b2220"/>'
  );

  /* FotMob-style angled cleat with 2 white stripes and studs */
  var ICON_BOOT = svg('i-boot',
    '<g transform="rotate(-32 12 12)">' +
    '<path d="M3.5 14.5c0-1 .7-1.8 1.7-2l5.2-1 2.5-4.2c.3-.5.9-.7 1.4-.5l1.6.6c.4.2.6.6.5 1l-.3 2.1 4.2 1.2c1 .3 1.7 1.2 1.7 2.2v1.3c0 .6-.5 1.1-1.1 1.1H4.6c-.6 0-1.1-.5-1.1-1.1v-.7z" fill="#1b2220"/>' +
    '<path d="M10.2 11.8l3.6.7M9.6 13.6l3.6.7" stroke="#ffffff" stroke-width="1.4" stroke-linecap="round"/>' +
    '<circle cx="6.2" cy="17.6" r="1" fill="#1b2220"/>' +
    '<circle cx="9.5" cy="17.6" r="1" fill="#1b2220"/>' +
    '<circle cx="15.8" cy="17.6" r="1" fill="#1b2220"/>' +
    '<circle cx="18.8" cy="17.6" r="1" fill="#1b2220"/>' +
    '</g>'
  );

  var ICON_RC = svg('i-card', '<rect x="6.5" y="4" width="11" height="16" rx="2" fill="#e0352f"/>');
  var ICON_SUB = svg('i-sub',
    '<circle cx="12" cy="12" r="10" fill="#1ea55b"/>' +
    '<path d="M7.5 12h9M13 8.5L16.5 12 13 15.5" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
  );

  function initials(name) { var s = String(name).replace(/[^A-Za-z0-9]/g, ''); return esc((s.slice(0, 2) || '?').toUpperCase()); }
  function resChip(r) { return '<span class="res ' + r + '" title="' + ({ W: 'Win', D: 'Draw', L: 'Loss' }[r]) + '">' + r + '</span>'; }
  function ordinal(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function mean(a) { return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : null; }
  function stdev(a) { if (a.length < 2) return null; var m = mean(a); return Math.sqrt(mean(a.map(function (v) { return (v - m) * (v - m); }))); }
  function crest(side, size) {
    var id = side && /^\d+$/.test(side.crest || '') ? side.crest : '';
    var img = id ? '<img src="' + CREST_BASE + id + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : '';
    return '<span class="cr s' + size + (id ? '' : ' bad') + '" aria-hidden="true">' + img +
      '<span class="fb">' + initials(side && side.name || '?') + '</span></span>';
  }

  /* ---------- data loading & indexing ---------- */
  /* Everything in data/db.js comes from EA's servers: club names, player names, numbers.
     loadDb copies it field by field and forces each value to the type the views expect,
     so a malformed or tampered file cannot put markup on the page or break the maths.
     Text is still escaped with esc() wherever it is written out. */
  function dict() { return Object.create(null); }   // a map with no inherited keys such as "constructor"
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function str(v) { return String(v === null || v === undefined ? '' : v).slice(0, 80); }
  function oneOf(v, allowed, fallback) { return allowed.indexOf(v) >= 0 ? v : fallback; }
  var POSITIONS = ['GK', 'DEF', 'MID', 'FWD'];

  function cleanPlayer(p) {
    p = p || {};
    return { id: str(p.id), name: str(p.name) || 'Unknown', pos: oneOf(p.pos, POSITIONS, 'N/A'), rating: num(p.rating),
             goals: num(p.goals), assists: num(p.assists), shots: num(p.shots), passesMade: num(p.passesMade), passAttempts: num(p.passAttempts),
             tacklesMade: num(p.tacklesMade), tackleAttempts: num(p.tackleAttempts), saves: num(p.saves), redCards: num(p.redCards),
             goalsConceded: num(p.goalsConceded), cleanSheet: !!p.cleanSheet, motm: !!p.motm, secondsPlayed: num(p.secondsPlayed) };
  }
  function cleanSide(c) {
    c = c || {};
    return { id: str(c.id), name: str(c.name) || 'Unknown club', goals: num(c.goals), crest: /^\d{1,12}$/.test(c.crest || '') ? String(c.crest) : '' };
  }
  function cleanTeamStats(t) {
    t = t || {};
    return { passesMade: num(t.passesMade), passAttempts: num(t.passAttempts), tacklesMade: num(t.tacklesMade), tackleAttempts: num(t.tackleAttempts),
             saves: num(t.saves), redCards: num(t.redCards), playerGoals: num(t.playerGoals), humans: num(t.humans), avgRating: num(t.avgRating) };
  }
  function cleanMatch(m) {
    if (!m || typeof m !== 'object') return null;
    var id = str(m.id), ts = num(m.ts);
    if (!slug(id) || ts <= 0) return null;
    var us = cleanSide(m.us), them = cleanSide(m.them), pl = m.players || {}, st = m.stats || {};
    return { id: id, ts: ts, type: oneOf(m.type, ['league', 'playoff', 'friendly'], 'league'),
             result: oneOf(m.result, ['W', 'D', 'L'], us.goals > them.goals ? 'W' : us.goals < them.goals ? 'L' : 'D'),
             dnf: !!m.dnf, us: us, them: them,
             stats: { us: cleanTeamStats(st.us), them: cleanTeamStats(st.them) },
             players: { us: (Array.isArray(pl.us) ? pl.us : []).map(cleanPlayer), them: (Array.isArray(pl.them) ? pl.them : []).map(cleanPlayer) } };
  }
  function cleanMember(m) {
    m = m || {};
    return { proName: str(m.proName), overall: num(m.overall), heightCm: num(m.heightCm), favoritePosition: oneOf(m.favoritePosition, POSITIONS, 'N/A'),
             gamesPlayed: num(m.gamesPlayed), goals: num(m.goals), assists: num(m.assists), ratingAve: num(m.ratingAve), motm: num(m.motm), winRate: num(m.winRate),
             shotSuccessRate: num(m.shotSuccessRate), passSuccessRate: num(m.passSuccessRate), tacklesMade: num(m.tacklesMade), tackleSuccessRate: num(m.tackleSuccessRate),
             cleanSheets: num(m.cleanSheets), redCards: num(m.redCards) };
  }
  function cleanOverall(o) {
    if (!o || typeof o !== 'object') return null;
    return { wins: num(o.wins), draws: num(o.draws), losses: num(o.losses), goals: num(o.goals), goalsAgainst: num(o.goalsAgainst), gamesPlayed: num(o.gamesPlayed),
             leagueApps: num(o.leagueApps), playoffApps: num(o.playoffApps), skillRating: num(o.skillRating), promotions: num(o.promotions),
             relegations: num(o.relegations), unbeatenStreak: num(o.unbeatenStreak) };
  }
  function loadDb() {
    var base = window.EATMOB_DB || {}, club = base.club || {}, rawMembers = base.members || {}, members = dict();
    Object.keys(rawMembers).forEach(function (name) { members[str(name)] = cleanMember(rawMembers[name]); });
    return {
      club: { name: str(club.name) || 'Eaters', overall: cleanOverall(club.overall) },
      members: members,
      matches: (Array.isArray(base.matches) ? base.matches : []).map(cleanMatch).filter(Boolean)
    };
  }

  /* newAgg: an empty season total for one player; buildIndex fills it from the saved matches */
  function newAgg(id, name) {
    return { id: id, name: name || '', apps: 0, goals: 0, assists: 0, passesMade: 0, passAttempts: 0, tacklesMade: 0, tackleAttempts: 0,
             saves: 0, redCards: 0, motm: 0, cleanSheets: 0, goalsConceded: 0, seconds: 0, ratingSum: 0, rated: 0, W: 0, D: 0, L: 0, pos: {}, log: [],
             teamGoals: 0, tries: 0, subs: 0 };
  }
  function avgRating(a) { return a.rated ? a.ratingSum / a.rated : null; }
  function mainPos(a) {
    var best = null;
    Object.keys(a.pos).forEach(function (p) { if (!best || a.pos[p] > a.pos[best]) best = p; });
    if (best) return best;
    var mem = db.members[a.name];
    return mem && mem.favoritePosition !== 'N/A' ? mem.favoritePosition : null;
  }

  /* buildIndex: sort the matches and derive every lookup the views need —
     matches by day and by id, and a season total (newAgg) per player. */
  function buildIndex() {
    var matches = db.matches.slice().sort(function (a, b) { return a.ts - b.ts; });
    var byDay = dict(), byId = dict(), players = dict();
    matches.forEach(function (m) {
      m.day = dayKeyOf(m.ts);
      m.full = m.players.us.concat(m.players.them).reduce(function (mx, p) { return Math.max(mx, p.secondsPlayed); }, 0);
      (byDay[m.day] = byDay[m.day] || []).push(m);
      byId[slug(m.id)] = m;
      m.players.us.forEach(function (p) {
        var a = players[p.id] || (players[p.id] = newAgg(p.id, p.name));
        a.name = p.name;
        a.apps++; a.goals += p.goals; a.assists += p.assists;
        a.passesMade += p.passesMade; a.passAttempts += p.passAttempts;
        a.tacklesMade += p.tacklesMade; a.tackleAttempts += p.tackleAttempts;
        a.saves += p.saves; a.redCards += p.redCards; a.goalsConceded += p.goalsConceded;
        a.seconds += p.secondsPlayed;
        if (p.motm) a.motm++;
        if (isSub(p, m)) a.subs++;
        if (p.cleanSheet) a.cleanSheets++;
        if (p.rating > 0) { a.ratingSum += p.rating; a.rated++; }
        a[m.result]++;
        a.teamGoals += m.us.goals; a.tries += tries(p);
        a.pos[p.pos] = (a.pos[p.pos] || 0) + 1;
        a.log.push({ m: m, p: p });
      });
    });
    /* club members who have not appeared in a saved match still get a (blank) squad entry */
    var seen = dict();
    Object.keys(players).forEach(function (id) { seen[players[id].name] = true; });
    Object.keys(db.members).forEach(function (name) {
      if (!seen[name]) { var id = 'm' + slug(name); players[id] = newAgg(id, name); }
    });
    var list = Object.keys(players).map(function (id) { return players[id]; });
    var bySlug = dict();
    list.forEach(function (a) { bySlug[slug(a.id)] = a; });
    var usSide = null;
    matches.forEach(function (m) { if (m.us.crest) usSide = m.us; });
    return { matches: matches, byDay: byDay, days: Object.keys(byDay).sort(), byId: byId, players: list, bySlug: bySlug, us: { name: db.club.name, crest: usSide ? usSide.crest : '' } };
  }

  function tally(ms) {
    var t = { P: ms.length, W: 0, D: 0, L: 0, GF: 0, GA: 0 };
    ms.forEach(function (m) { t[m.result]++; t.GF += m.us.goals; t.GA += m.them.goals; });
    return t;
  }
  function record(t) { return t.W + 'W ' + t.D + 'D ' + t.L + 'L'; }
  function isSub(p, m) { return m.full > 0 && p.secondsPlayed > 0 && p.secondsPlayed < m.full - SUB_MARGIN; }
  // We only know how long a player was on the pitch, not whether they subbed on or off.
  // Always show actual minutes played (secondsPlayed) so the number is never wrong.
  function minsCell(p, m) {
    var n = mins(p.secondsPlayed);
    return isSub(p, m) ? '<span class="submin" title="Partial appearance (' + n + ' min)">' + ICON_SUB + n + '</span>' : n;
  }
  /* Stat tile grid: list of [label, value] pairs → HTML */
  function tiles(list, cls) {
    return '<div class="tiles' + (cls ? ' ' + cls : '') + '">' + list.map(function (t) { return '<div class="tile"><b>' + t[1] + '</b><span>' + t[0] + '</span></div>'; }).join('') + '</div>';
  }
  function playerHref(id) { return '#player-' + slug(id); }
  function matchHref(m) { return '#match-' + slug(m.id); }

  /* ---------- shared pieces ---------- */
  function matchRow(m) {
    var avg = m.stats.us.avgRating;
    return '<a class="mrow" href="' + matchHref(m) + '">' +
      '<span class="t">' + esc(fmtTime(m.ts)) + '</span>' + resChip(m.result) +
      '<span class="home"><span class="n">' + esc(m.us.name) + '</span>' + crest(m.us, 24) + '</span>' +
      '<span class="sc">' + m.us.goals + ' – ' + m.them.goals + '</span>' +
      '<span class="away">' + crest(m.them, 24) + '<span class="n">' + esc(m.them.name) + '</span>' + (m.dnf ? '<span class="tag" title="A team quit before full time">DNF</span>' : '') + '</span>' +
      '<span class="best" title="Team average rating">' + (avg > 0 ? rt(avg) : '') + '</span></a>';
  }
  function emptyState() { return '<div class="card"><div class="card-b muted">No games yet.</div></div>'; }

  /* ---------- matches by day ---------- */
  function viewDay(sel) {
    var days = idx.days;
    if (!sel) sel = days.length ? days[days.length - 1] : todayKey();
    var today = todayKey();
    var list = idx.byDay[sel] || [];
    var prevDay = null, nextDay = null;
    days.forEach(function (d) { if (d < sel) prevDay = d; if (d > sel && !nextDay) nextDay = d; });
    if (!ui.calMonth) ui.calMonth = sel.slice(0, 7);

    var h = '';
    var t = tally(idx.matches);
    h += '<div class="clubhead">' + crest(idx.us, 56) + '<div><h1>' + esc(db.club.name) + '</h1>' +
      '<div class="meta">' + [idx.matches.length ? record(t) : '', db.club.overall ? 'Skill rating ' + db.club.overall.skillRating : ''].filter(Boolean).join(' · ') + '</div></div></div>';

    h += '<div class="card"><div class="card-b" style="display:flex;flex-direction:column;gap:12px">';
    h += '<div class="datebar"><a class="arrow" href="#day-' + addDays(sel, -1) + '" aria-label="Previous day">‹</a><div class="strip">';
    for (var i = -3; i <= 3; i++) {
      var k = addDays(sel, i), d = dateOfKey(k), n = (idx.byDay[k] || []).length;
      h += '<a href="#day-' + k + '" class="' + (i === 0 ? 'sel ' : '') + (n ? 'has' : '') + '"' + (i === 0 ? ' aria-current="date"' : '') + '>' +
        '<span>' + (k === today ? 'Today' : WD[d.getDay()]) + '</span><b>' + d.getDate() + '</b><span class="cnt">' + (n ? n : '') + '</span></a>';
    }
    h += '</div><a class="arrow" href="#day-' + addDays(sel, 1) + '" aria-label="Next day">›</a></div>';
    h += '<div class="daytools"><div class="grp">' +
      '<a class="btn" ' + (prevDay ? 'href="#day-' + prevDay + '"' : 'aria-disabled="true"') + '>‹ Previous match day</a>' +
      '<a class="btn" ' + (nextDay ? 'href="#day-' + nextDay + '"' : 'aria-disabled="true"') + '>Next match day ›</a></div>' +
      '<div class="grp"><a class="btn" href="#day-' + today + '">Today</a>' +
      '<button class="btn" data-act="cal-toggle" aria-expanded="' + ui.calOpen + '">' + (ui.calOpen ? 'Hide calendar' : 'Calendar') + '</button></div></div>';
    h += '</div>';
    if (ui.calOpen) h += calendar(sel, today);
    h += '</div>';

    h += '<div class="dayhead"><h2 style="font-size:19px">' + esc(fmtDayLong(sel)) + '</h2>';
    if (list.length) {
      var dt = tally(list);
      h += '<div class="chips"><span class="chip">' + games(list.length) + '</span><span class="chip">' + record(dt) + '</span><span class="chip">Goals ' + dt.GF + '–' + dt.GA + '</span></div>';
    }
    h += '</div>';

    if (!list.length) {
      h += '<div class="card"><div class="card-b muted">No games this day.</div></div>';
    } else {
      ['league', 'playoff', 'friendly'].forEach(function (type) {
        var ms = list.filter(function (m) { return m.type === type; });
        if (!ms.length) return;
        var tt = tally(ms);
        h += '<section class="card"><div class="card-h"><h2>' + TYPE_LABEL[type] + '</h2><span class="muted small">' + record(tt) + '</span></div>' +
          ms.slice().reverse().map(matchRow).join('') + '</section>';
      });
      h += daySummary(list);
    }
    view.innerHTML = h;
  }

  function daySummary(list) {
    var per = dict();
    list.forEach(function (m) {
      m.players.us.forEach(function (p) {
        var a = per[p.id] || (per[p.id] = { id: p.id, name: p.name, n: 0, rs: 0, rn: 0, g: 0, as: 0 });
        a.n++; a.g += p.goals; a.as += p.assists; if (p.rating > 0) { a.rs += p.rating; a.rn++; }
      });
    });
    var arr = Object.keys(per).map(function (k) { return per[k]; });
    var rated = arr.filter(function (a) { return a.rn > 0; }).sort(function (a, b) { return b.rs / b.rn - a.rs / a.rn; });
    var scorers = arr.filter(function (a) { return a.g + a.as > 0; }).sort(function (a, b) { return (b.g + b.as) - (a.g + a.as) || b.g - a.g; });
    var h = '<div class="grid2">';
    h += '<section class="card"><div class="card-h"><h2>Best average rating</h2></div><div class="plist">' +
      (rated.slice(0, 5).map(function (a, i) {
        return '<a class="pl" href="' + playerHref(a.id) + '"><span class="rk">' + (i + 1) + '</span><span class="nm">' + esc(a.name) + '<small>' + games(a.n) + '</small></span>' + rt(a.rs / a.rn) + '</a>';
      }).join('') || '<div class="pl muted">No ratings.</div>') + '</div></section>';
    h += '<section class="card"><div class="card-h"><h2>Goals and assists</h2></div><div class="plist">' +
      (scorers.slice(0, 5).map(function (a, i) {
        return '<a class="pl" href="' + playerHref(a.id) + '"><span class="rk">' + (i + 1) + '</span><span class="nm">' + esc(a.name) + '</span><span class="v">' + a.g + ' G · ' + a.as + ' A</span></a>';
      }).join('') || '<div class="pl muted">None.</div>') + '</div></section>';
    return h + '</div>';
  }

  function calendar(sel, today) {
    var p = ui.calMonth.split('-'), y = +p[0], mo = +p[1] - 1;
    var first = new Date(y, mo, 1), n = new Date(y, mo + 1, 0).getDate();
    var h = '<div style="border-top:1px solid var(--line)"><div class="cal-h"><button class="btn" data-act="cal-prev" aria-label="Previous month">‹</button><b>' + MONTHS[mo] + ' ' + y + '</b><button class="btn" data-act="cal-next" aria-label="Next month">›</button></div><div class="cal-grid">';
    WD.forEach(function (w) { h += '<span class="wd">' + w + '</span>'; });
    for (var b = 0; b < first.getDay(); b++) h += '<span></span>';
    for (var d = 1; d <= n; d++) {
      var k = y + '-' + pad(mo + 1) + '-' + pad(d), ms = idx.byDay[k] || [];
      var num = '<span class="' + (k === today ? 'today-n' : '') + '">' + d + '</span>';
      if (ms.length) {
        var tt = tally(ms);
        h += '<a href="#day-' + k + '" class="' + (k === sel ? 'sel' : '') + '" title="' + ms.length + (ms.length === 1 ? ' game: ' : ' games: ') + record(tt) + '">' + num +
          '<span class="dots">' + ms.slice(0, 10).map(function (m) { return '<i class="dot ' + m.result + '"></i>'; }).join('') + '</span></a>';
      } else {
        h += '<a href="#day-' + k + '" class="empty' + (k === sel ? ' sel' : '') + '">' + num + '</a>';
      }
    }
    return h + '</div></div>';
  }

  /* ---------- match ---------- */
  function scorerList(players, teamGoals) {
    var parts = [], sum = 0;
    players.filter(function (p) { return p.goals > 0; }).sort(function (a, b) { return b.goals - a.goals; })
      .forEach(function (p) { sum += p.goals; parts.push('<b>' + esc(p.name) + '</b>' + (p.goals > 1 ? '<span class="muted"> ×' + p.goals + '</span>' : '')); });
    if (teamGoals > sum) parts.push('<span class="muted" title="AI teammates, own goals, or goals awarded for a forfeit">Other' + (teamGoals - sum > 1 ? ' ×' + (teamGoals - sum) : '') + '</span>');
    return parts.join('<br>');
  }

  function viewMatch(m) {
    var i = idx.matches.indexOf(m), prev = idx.matches[i - 1], next = idx.matches[i + 1];
    var shareUrl = location.href.split('#')[0] + '#match-' + slug(m.id);
    var h = '<div class="row" style="justify-content:space-between">' +
      '<a class="btn" href="#day-' + m.day + '">‹ ' + esc(fmtDayShort(m.day)) + '</a>' +
      '<div class="row">' +
      '<button class="btn" data-act="share-match" data-url="' + esc(shareUrl) + '">' + ICON_SHARE + '<span>Share</span></button>' +
      '<a class="btn" ' + (prev ? 'href="' + matchHref(prev) + '"' : 'aria-disabled="true"') + '>‹ Prev</a>' +
      '<a class="btn" ' + (next ? 'href="' + matchHref(next) + '"' : 'aria-disabled="true"') + '>Next ›</a>' +
      '</div></div>';

    h += '<section class="card"><div class="mh"><div class="comp">' + TYPE_LABEL[m.type] + ' · ' + esc(fmtDayLong(zoneKey(m.ts))) + ' · ' + esc(fmtTime(m.ts)) + '</div>' +
      '<div class="board"><div class="team">' + crest(m.us, 64) + '<span>' + esc(m.us.name) + '</span></div><div class="score">' + m.us.goals + ' – ' + m.them.goals + '</div><div class="team">' + crest(m.them, 64) + '<span>' + esc(m.them.name) + '</span></div></div>' +
      '<div class="row" style="justify-content:center">' + resChip(m.result) + '<span class="muted small">' + (m.dnf ? 'Ended early (DNF)' : 'Full time') + '</span></div>' +
      '<div class="scorers"><div>' + scorerList(m.players.us, m.us.goals) + '</div><div>' + scorerList(m.players.them, m.them.goals) + '</div></div></div>';
    var tabs = [['facts', 'Facts'], ['lineup', 'Lineup'], ['stats', 'Stats'], ['players', 'Player stats']];
    h += '<div class="tabs" role="tablist">' + tabs.map(function (t) {
      return '<button role="tab" data-act="tab" data-tab="' + t[0] + '" aria-selected="' + (ui.tab === t[0]) + '">' + t[1] + '</button>';
    }).join('') + '</div></section>';

    if (ui.tab === 'facts') h += matchFacts(m);
    else if (ui.tab === 'lineup') h += matchLineup(m);
    else if (ui.tab === 'stats') h += matchStats(m);
    else h += matchPlayers(m);
    view.innerHTML = h;
  }

  function matchFacts(m) {
    var all = m.players.us.map(function (p) { return { p: p, us: true }; }).concat(m.players.them.map(function (p) { return { p: p, us: false }; }));
    var motm = all.filter(function (x) { return x.p.motm; })[0];
    var h = '';
    if (motm) {
      h += '<section class="card"><div class="card-h"><h2>Player of the match</h2></div><div class="card-b phead">' +
        '<div class="avatar">' + playerImg(motm.p.name) + '</div><div><div style="font-weight:700;font-size:17px">' +
        (motm.us ? '<a href="' + playerHref(motm.p.id) + '">' + esc(motm.p.name) + '</a>' : esc(motm.p.name)) + '</div>' +
        '<div class="muted small">' + esc(motm.us ? m.us.name : m.them.name) + '</div></div>' +
        '<div class="ovr">' + rt(motm.p.rating, true, true) + '</div></div></section>';
    }
    function top(players, us) {
      return players.filter(function (p) { return p.rating > 0; }).sort(function (a, b) { return b.rating - a.rating; }).slice(0, 3).map(function (p, i) {
        var inner = '<span class="rk">' + (i + 1) + '</span><span class="nm">' + esc(p.name) + '<small>' + POS_LABEL[p.pos] + '</small></span>' + rt(p.rating, false, p.motm);
        return us ? '<a class="pl" href="' + playerHref(p.id) + '">' + inner + '</a>' : '<div class="pl">' + inner + '</div>';
      }).join('') || '<div class="pl muted">No ratings.</div>';
    }
    h += '<div class="grid2"><section class="card"><div class="card-h"><h2>Top rated · ' + esc(m.us.name) + '</h2></div><div class="plist">' + top(m.players.us, true) + '</div></section>' +
      '<section class="card"><div class="card-h"><h2>Top rated · ' + esc(m.them.name) + '</h2></div><div class="plist">' + top(m.players.them, false) + '</div></section></div>';
    h += '<section class="card"><div class="card-h"><h2>Match facts</h2></div><div class="card-b"><dl class="kv">' +
      '<dt>Competition</dt><dd>' + TYPE_LABEL[m.type] + '</dd>' +
      '<dt>Finished</dt><dd>' + esc(new Date(m.ts * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: TIME_ZONE })) + '</dd>' +
      '<dt>Players</dt><dd>' + m.stats.us.humans + ' v ' + m.stats.them.humans + '</dd>' +
      '<dt>Team rating</dt><dd>' + f2(m.stats.us.avgRating) + ' v ' + f2(m.stats.them.avgRating) + '</dd>' +
      '<dt>Match ID</dt><dd>' + esc(m.id) + '</dd></dl></div></section>';
    return h;
  }

  /* Lineup marker: FotMob avatar + badges, fixed 4-zone positional grid so GK stays inside the penalty box. */
  function evIcons(icon, n, cls) {
    if (n > 4) return '<i class="e ' + cls + '">' + icon + '<b>' + n + '</b></i>';
    var out = '';
    while (n-- > 0) out += '<i class="e ' + cls + '">' + icon + '</i>';
    return out;
  }
  function pitchPlayer(p, m, us) {
    var cardHtml = p.redCards ? '<span class="pcard" title="Red card">' + ICON_RC + '</span>' : '';
    var inner = '<span class="av">' + playerImg(p.name) +
      (isSub(p, m) ? '<span class="sub" title="Partial appearance (' + mins(p.secondsPlayed) + ' min)"><span class="sub-min">' + mins(p.secondsPlayed) + '’</span><i class="sub-ic">' + ICON_SUB + '</i></span>' : '') +
      rt(p.rating, false, p.motm) +
      cardHtml +
      (p.assists ? '<span class="evs l" title="' + p.assists + ' A">' + evIcons(ICON_BOOT, p.assists, 'as') + '</span>' : '') +
      (p.goals ? '<span class="evs" title="' + p.goals + ' G">' + evIcons(ICON_BALL, p.goals, 'gl') + '</span>' : '') +
      '</span><span class="nm">' + esc(p.name) + '</span>';
    return us ? '<a class="pp" href="' + playerHref(p.id) + '">' + inner + '</a>' : '<div class="pp">' + inner + '</div>';
  }
  function pitchHalf(m, us) {
    var players = us ? m.players.us : m.players.them;
    var order = us ? ['FWD', 'MID', 'DEF', 'GK'] : ['GK', 'DEF', 'MID', 'FWD'];
    return '<div class="half">' + order.map(function (pos) {
      var ps = players.filter(function (p) { return p.pos === pos || (pos === 'MID' && p.pos === 'N/A'); });
      return '<div class="line pos-' + pos.toLowerCase() + (ps.length ? '' : ' empty-line') + '">' +
        ps.map(function (p) { return pitchPlayer(p, m, us); }).join('') +
        '</div>';
    }).join('') + '</div>';
  }
  function matchLineup(m) {
    return '<section class="card"><div class="pitch">' + pitchHalf(m, false) + pitchHalf(m, true) + '</div></section>';
  }

  // EA's shot count is sometimes below a player's goals, so a goal always counts as a shot.
  function tries(p) { return Math.max(p.shots, p.goals); }
  function triesOf(players) { return players.reduce(function (s, p) { return s + tries(p); }, 0); }

  function statBar(label, a, b, fmt) {
    var av = a || 0, bv = b || 0, tot = av + bv;
    var show = fmt || function (v) { return v === null ? '–' : String(v); };
    return '<div class="sb"><span class="lab">' + label + '</span><span class="a">' + show(a) + '</span>' +
      '<span class="bar"><i class="u" style="width:' + (tot ? av / tot * 100 : 0) + '%"></i><i class="o" style="width:' + (tot ? bv / tot * 100 : 0) + '%"></i></span>' +
      '<span class="b">' + show(b) + '</span></div>';
  }
  function matchStats(m) {
    var u = m.stats.us, o = m.stats.them;
    var p = function (v) { return v === null ? '–' : Math.round(v) + '%'; };
    return '<section class="card"><div class="card-h"><h2>' + esc(m.us.name) + '</h2><h2>' + esc(m.them.name) + '</h2></div><div class="card-b">' +
      statBar('Goals', m.us.goals, m.them.goals) +
      statBar('Shots', triesOf(m.players.us), triesOf(m.players.them)) +
      statBar('Passes completed', u.passesMade, o.passesMade) +
      statBar('Pass accuracy', pct(u.passesMade, u.passAttempts), pct(o.passesMade, o.passAttempts), p) +
      statBar('Tackles won', u.tacklesMade, o.tacklesMade) +
      statBar('Tackle success', pct(u.tacklesMade, u.tackleAttempts), pct(o.tacklesMade, o.tackleAttempts), p) +
      statBar('Saves', u.saves, o.saves) +
      statBar('Red cards', u.redCards, o.redCards) +
      statBar('Average rating', u.avgRating, o.avgRating, function (v) { return v ? v.toFixed(2) : '–'; }) +
      statBar('Players', u.humans, o.humans) + '</div></section>';
  }

  var PT_COLS = [
    { k: 'rating', label: 'Rating', v: function (p) { return p.rating || 0; } },
    { k: 'mins',   label: 'Min',    v: function (p, m) { return mins(p.secondsPlayed); } },
    { k: 'goals',  label: 'G',      v: function (p) { return p.goals; } },
    { k: 'assists',label: 'A',      v: function (p) { return p.assists; } },
    { k: 'shots',  label: 'Shots',  v: function (p) { return tries(p); } },
    { k: 'passpc', label: 'Pass %', v: function (p) { return pct(p.passesMade, p.passAttempts) || 0; } },
    { k: 'tackles',label: 'Tackles',v: function (p) { return p.tacklesMade; } },
    { k: 'saves',  label: 'Saves',  v: function (p) { return p.saves; } },
    { k: 'rc',     label: 'RC',     v: function (p) { return p.redCards; } }
  ];
  function playerTable(m, us) {
    var sk = ui.matchSort.k, sd = ui.matchSort.dir;
    var col = PT_COLS.filter(function (c) { return c.k === sk; })[0] || PT_COLS[0];
    var players = (us ? m.players.us : m.players.them).slice().sort(function (a, b) {
      return (col.v(b, m) - col.v(a, m)) * sd;
    });
    function th(c) {
      var on = c.k === sk;
      return '<th><button data-act="match-sort" data-k="' + c.k + '" class="' + (on ? 'on' : '') + '">' + c.label + (on ? (sd < 0 ? ' ↓' : ' ↑') : '') + '</button></th>';
    }
    return '<div class="tw"><table><thead><tr><th>Player</th><th>Pos</th>' + PT_COLS.map(th).join('') + '</tr></thead><tbody>' +
      players.map(function (p) {
        return '<tr><td class="name">' + (us ? '<a href="' + playerHref(p.id) + '">' + esc(p.name) + '</a>' : esc(p.name)) + '</td><td>' + p.pos + '</td><td>' + rt(p.rating, false, p.motm) + '</td><td>' + minsCell(p, m) + '</td><td>' + p.goals + '</td><td>' + p.assists + '</td><td>' + tries(p) + '</td><td>' + pctS(p.passesMade, p.passAttempts) + '</td><td>' + p.tacklesMade + '/' + p.tackleAttempts + '</td><td>' + p.saves + '</td><td>' + p.redCards + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function matchPlayers(m) {
    return '<section class="card"><div class="card-h"><h2>' + esc(m.us.name) + '</h2></div>' + playerTable(m, true) + '</section>' +
      '<section class="card"><div class="card-h"><h2>' + esc(m.them.name) + '</h2></div>' + playerTable(m, false) + '</section>';
  }

  /* ---------- squad ---------- */
  /* One column set for both "This season" (saved matches) and "Career" (EA's all-time totals) */
  var SQUAD_COLS = [['rating', 'Rating'], ['goals', 'G'], ['assists', 'A'], ['ga', 'G+A'], ['pass', 'Pass %'], ['tackles', 'Tkl'], ['win', 'Win %'], ['motm', 'MOTM'], ['mins', 'Min'], ['apps', 'Apps']];
  var SQUAD_FMT = {
    pass: function (v) { return v === null ? '–' : Math.round(v) + '%'; },
    win: function (v) { return v === null ? '–' : Math.round(v) + '%'; },
    rating: function (v) { return rt(v || 0); }
  };
  var POS_ORDER = { GK: 0, DEF: 1, MID: 2, FWD: 3 };

  function squadTableHtml() {
    var tracked = ui.squadMode === 'tracked';
    var q = ui.squadQuery.trim().toLowerCase();
    var posFilter = ui.squadPos;
    if (!SQUAD_COLS.some(function (c) { return c[0] === ui.sortK; })) { ui.sortK = 'rating'; ui.sortDir = -1; }
    var rows = idx.players.map(function (a) {
      var mem = db.members[a.name] || null, v;
      if (tracked) v = { rating: avgRating(a), goals: a.goals, assists: a.assists, ga: a.goals + a.assists, pass: pct(a.passesMade, a.passAttempts), tackles: a.tacklesMade, win: pct(a.W, a.apps), motm: a.motm, mins: mins(a.seconds), apps: a.apps };
      /* EA's career totals carry no minutes, so that column stays blank in Career */
      else v = mem ? { rating: mem.ratingAve || null, goals: mem.goals, assists: mem.assists, ga: mem.goals + mem.assists, pass: mem.gamesPlayed ? mem.passSuccessRate : null, tackles: mem.tacklesMade, win: mem.gamesPlayed ? mem.winRate : null, motm: mem.motm, mins: null, apps: mem.gamesPlayed } : null;
      return { a: a, mem: mem, pos: mainPos(a), v: v };
    }).filter(function (r) {
      if (!r.v) return false;
      if (posFilter !== 'ALL' && r.pos !== posFilter && !r.a.pos[posFilter]) return false;
      if (!q) return true;
      return [r.a.name, r.mem && r.mem.proName, r.pos, r.pos && POS_LABEL[r.pos]].some(function (s) { return s && String(s).toLowerCase().indexOf(q) >= 0; });
    });
    rows.sort(function (x, y) {
      var a = x.v[ui.sortK], b = y.v[ui.sortK];
      var na = a === null || a === undefined, nb = b === null || b === undefined;
      if (na || nb) return na && nb ? x.a.name.localeCompare(y.a.name) : na ? 1 : -1;
      var diff = (a - b) * ui.sortDir;
      if (diff !== 0) return diff;
      /* tiebreak: position group order, then name */
      var po = (POS_ORDER[x.pos] !== undefined ? POS_ORDER[x.pos] : 4) - (POS_ORDER[y.pos] !== undefined ? POS_ORDER[y.pos] : 4);
      return po || x.a.name.localeCompare(y.a.name);
    });
    if (!rows.length) return '<div class="card-b muted">No matching players.</div>';
    return '<div class="tw"><table><thead><tr><th>Player</th><th>Pos</th>' + SQUAD_COLS.map(function (c) {
      var on = ui.sortK === c[0];
      return '<th' + (on ? ' aria-sort="' + (ui.sortDir < 0 ? 'descending' : 'ascending') + '"' : '') + '><button data-act="sort" data-k="' + c[0] + '" class="' + (on ? 'on' : '') + '">' + c[1] + (on ? (ui.sortDir < 0 ? ' ↓' : ' ↑') : '') + '</button></th>';
    }).join('') + '</tr></thead><tbody>' + rows.map(function (r) {
      return '<tr><td class="name"><a href="' + playerHref(r.a.id) + '">' + esc(r.a.name) + (r.mem && r.mem.proName ? '<small>' + esc(r.mem.proName) + '</small>' : '') + '</a></td><td>' + (r.pos || '–') + '</td>' +
        SQUAD_COLS.map(function (c) { var val = r.v[c[0]]; return '<td>' + (SQUAD_FMT[c[0]] ? SQUAD_FMT[c[0]](val) : (val === null ? '–' : val)) + '</td>'; }).join('') + '</tr>';
    }).join('') + '</tbody></table></div>';
  }

  /* leaderboards: the top-5 cards under the squad table — saved matches, or EA career totals */
  function leaderboardsHtml(career) {
    var pctOne = function (v) { return f1(v) + '%'; };
    if (career) {
      return '<div class="grid2">' +
        board('Rating', memLeaders(function (m) { return m.ratingAve; }, function (v) { return rt(v); }), gamesFnMem) +
        board('Goals', memLeaders(function (m) { return m.goals; }, String), gamesFnMem) +
        board('Assists', memLeaders(function (m) { return m.assists; }, String), gamesFnMem) +
        board('Goals + assists', memLeaders(function (m) { return m.goals + m.assists; }, String), gamesFnMem) +
        board('Win rate', memLeaders(function (m) { return m.winRate; }, function (v) { return Math.round(v) + '%'; }), gamesFnMem) +
        board('Player of the match', memLeaders(function (m) { return m.motm; }, String), gamesFnMem) +
        board('Pass accuracy', memLeaders(function (m) { return m.passSuccessRate; }, pctOne), gamesFnMem) +
        board('Games played', memLeaders(function (m) { return m.gamesPlayed; }, String), gamesFnMem) + '</div>';
    }
    return '<div class="grid2">' +
      board('Average rating', leaders(avgRating, function (v) { return rt(v); })) +
      board('Goals', leaders(function (a) { return a.goals; }, String)) +
      board('Assists', leaders(function (a) { return a.assists; }, String)) +
      board('Goals + assists', leaders(function (a) { return a.goals + a.assists; }, String)) +
      board('Goals + assists per 90', leaders(function (a) { return per90(a.goals + a.assists, a.seconds); }, f2)) +
      board('Player of the match', leaders(function (a) { return a.motm; }, String)) +
      board('Pass accuracy', leaders(function (a) { return pct(a.passesMade, a.passAttempts); }, pctOne)) +
      board('Tackles won per 90', leaders(function (a) { return per90(a.tacklesMade, a.seconds); }, f1)) + '</div>';
  }

  var SQUAD_MODES = [['tracked', 'This season'], ['ea', 'Career'], ['per90', 'Per 90'], ['compare', 'Compare']];
  function viewSquad() {
    var mode = ui.squadMode;
    var h = '<div class="dayhead"><h1>Squad</h1><div class="seg" role="group" aria-label="Squad view">' +
      SQUAD_MODES.map(function (m) {
        return '<button data-act="squad-mode" data-mode="' + m[0] + '" aria-pressed="' + (mode === m[0]) + '">' + m[1] + '</button>';
      }).join('') + '</div></div>';

    if (mode === 'compare') { view.innerHTML = h + compareHtml(); return; }

    if (mode === 'per90') {
      h += squadPer90();
    } else {
      /* This season / Career: the squad table with a position filter and a search box */
      h += '<div class="squad-tools">' +
        '<div class="pos-pills" role="group" aria-label="Filter by position">' +
        [['ALL', 'All'], ['FWD', 'FWD'], ['MID', 'MID'], ['DEF', 'DEF'], ['GK', 'GK']].map(function (p) {
          return '<button class="pos-pill" data-act="squad-pos" data-pos="' + p[0] + '" aria-pressed="' + (ui.squadPos === p[0]) + '">' + p[1] + '</button>';
        }).join('') + '</div>' +
        '<input class="search-in" type="search" data-filter="squad" placeholder="Search name, pro, pos…" value="' + esc(ui.squadQuery) + '" aria-label="Filter squad">' +
        '</div>';
      h += '<section class="card" id="squad-card">' + squadTableHtml() + '</section>';
    }
    if (idx.matches.length) h += '<div class="dayhead"><h2>Leaderboards</h2></div>' + leaderboardsHtml(mode === 'ea');
    view.innerHTML = h;
  }

  /* ---------- insights ---------- */
  /* Everything here is worked out from the saved matches only: a role for each player, recent form,
     how steady their ratings are, how the club does with and without them, how they do in close
     games, and which players do well together. Small samples swing a lot, so each
     figure needs a minimum number of games before it is shown. */
  var INS_MIN_GAMES = 3;     // games needed for a role, and on each side of a with/without split
  var INS_MIN_RATED = 4;     // rated games needed for form and consistency
  var INS_TREND = 0.3;       // rating change that counts as a real shift (hot/cold, better/worse in close games)
  var INS_HIGH = 1.25;       // "well above the squad average" = 25% above it
  var GOOD_GAME = 7.5;       // a rating at or above this is a good game

  function signed(v, digits) { return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(digits); }
  function pointsPerGame(t) { return t.P ? (t.W * 3 + t.D) / t.P : null; }
  function goalDiffPerGame(t) { return t.P ? (t.GF - t.GA) / t.P : null; }
  function isClose(m) { return Math.abs(m.us.goals - m.them.goals) <= 1; }   // a draw or a one-goal game
  function ratingsOf(log) { return log.filter(function (x) { return x.p.rating > 0; }).map(function (x) { return x.p.rating; }); }
  function gaPer90(log) {
    var ga = 0, sec = 0;
    log.forEach(function (x) { ga += x.p.goals + x.p.assists; sec += x.p.secondsPlayed; });
    return per90(ga, sec);
  }
  var RATE = {
    g: function (a) { return per90(a.goals, a.seconds) || 0; },
    as: function (a) { return per90(a.assists, a.seconds) || 0; },
    pass: function (a) { return per90(a.passesMade, a.seconds) || 0; },
    tkl: function (a) { return per90(a.tacklesMade, a.seconds) || 0; },
    press: function (a) { return per90(a.tackleAttempts, a.seconds) || 0; }
  };

  /* roleOf: label a player's style from what they actually do per 90, measured against the
     outfield average (sq). EA only reports GK/DEF/MID/FWD, so this is the extra detail. */
  function roleOf(a, sq) {
    if (a.apps < INS_MIN_GAMES) return null;
    var pos = mainPos(a), g = RATE.g(a), as = RATE.as(a), ps = RATE.pass(a), tk = RATE.tkl(a), pr = RATE.press(a);
    var passPct = pct(a.passesMade, a.passAttempts) || 0;
    function high(v, avg) { return v > 0 && v >= avg * INS_HIGH; }
    function role(label, why) { return { label: label, why: why }; }
    if (pos === 'GK') {
      var saves = 0, conceded = 0;
      a.log.forEach(function (x) { if (x.p.pos === 'GK') { saves += x.p.saves; conceded += x.p.goalsConceded; } });
      var rate = pct(saves, saves + conceded);
      if (rate === null) return role('Goalkeeper', 'No shots faced yet');
      return role(rate >= 65 ? 'Shot-stopper' : 'Goalkeeper', 'Saves ' + pctF(rate) + ' of shots on target');
    }
    var goals = f2(g) + ' goals per 90', assists = f2(as) + ' assists per 90', tackles = f1(tk) + ' tackles won per 90';
    var passing = f1(ps) + ' passes per 90 at ' + pctF(passPct);
    var hiG = high(g, sq.g), hiA = high(as, sq.as), hiT = high(tk, sq.tkl);
    if (hiG && hiA) return role('Complete attacker', goals + ' and ' + assists);
    if (hiG && as < sq.as * 0.5) return role('Poacher', goals + ', ' + assists);
    if (hiG) return role(pos === 'MID' ? 'Goalscoring midfielder' : pos === 'DEF' ? 'Attacking defender' : 'Finisher', goals + ', ' + assists);
    if (hiA) return role(pos === 'FWD' ? 'Creative forward' : pos === 'DEF' ? 'Attacking defender' : 'Playmaker', assists + ', ' + goals);
    if (pos === 'DEF') {
      if (hiT) return role('Ball-winning defender', tackles);
      if (ps >= sq.pass || passPct >= 85) return role('Ball-playing defender', passing);
      return role('Stay-at-home defender', tackles + ', ' + passing);
    }
    if (hiT && g + as >= sq.g + sq.as) return role('Box-to-box', tackles + ', ' + f2(g + as) + ' goals + assists per 90');
    if (hiT) return role('Ball winner', tackles);
    if (pos === 'FWD' && pr >= sq.press * 1.5 && pr > 0) return role('Pressing forward', f1(pr) + ' tackle attempts per 90');
    if (ps >= sq.pass * 1.15) return role('Holding midfielder', passing);
    return role('All-rounder', 'Close to the squad average in every area');
  }

  /* formOf: the latest few rated games against the ones before them */
  function formOf(a) {
    var rs = ratingsOf(a.log);
    if (rs.length < INS_MIN_RATED) return null;
    var n = Math.min(5, Math.floor(rs.length / 2)), recent = mean(rs.slice(-n)), before = mean(rs.slice(0, -n)), delta = recent - before;
    return { n: n, recent: recent, before: before, delta: delta, label: delta >= INS_TREND ? 'Hot' : delta <= -INS_TREND ? 'Cold' : 'Steady' };
  }

  /* steadinessOf: how much the ratings swing from game to game (standard deviation) */
  function steadinessOf(a) {
    var rs = ratingsOf(a.log);
    if (rs.length < INS_MIN_RATED) return null;
    var sd = stdev(rs);
    return { sd: sd, solid: pct(rs.filter(function (r) { return r >= 7; }).length, rs.length),
             label: sd < 0.65 ? 'Very consistent' : sd < 0.9 ? 'Consistent' : sd < 1.1 ? 'Up and down' : 'Boom or bust' };
  }

  /* impactOf: the club's results in games the player played against games they missed */
  function impactOf(a) {
    if (a.apps < INS_MIN_GAMES) return null;
    var played = a.log.map(function (x) { return x.m; });
    var missed = idx.matches.filter(function (m) { return played.indexOf(m) < 0; });
    var w = tally(played), wo = tally(missed), enough = missed.length >= INS_MIN_GAMES;
    return { w: w, wo: wo, ppgWith: pointsPerGame(w), ppgWithout: enough ? pointsPerGame(wo) : null,
             delta: enough ? pointsPerGame(w) - pointsPerGame(wo) : null };
  }

  /* closeOf: rating and output in close games against the rest */
  function closeOf(a) {
    var close = a.log.filter(function (x) { return isClose(x.m); }), rest = a.log.filter(function (x) { return !isClose(x.m); });
    var rc = ratingsOf(close), rr = ratingsOf(rest);
    if (rc.length < 2 || rr.length < 2) return null;
    return { n: close.length, rating: mean(rc), restRating: mean(rr), delta: mean(rc) - mean(rr), ga: gaPer90(close), restGa: gaPer90(rest) };
  }

  /* ---------- who plays well together ---------- */
  /* regulars: everyone with enough games for the grids, most games first */
  function regularsOf() {
    return idx.players.filter(function (a) { return a.apps >= INS_MIN_GAMES; })
      .sort(function (x, y) { return y.apps - x.apps || x.name.localeCompare(y.name); });
  }
  /* togetherOf: the matches every player in the list played in */
  function togetherOf(list) {
    return idx.matches.filter(function (m) { return list.every(function (a) { return a.inMatch[m.id]; }); });
  }
  /* duosOf: the club's record in the games each pair of regulars both played */
  function duosOf(regs) {
    var map = dict();
    regs.forEach(function (a, i) {
      regs.slice(i + 1).forEach(function (b) {
        var t = tally(togetherOf([a, b]));
        map[a.id + '|' + b.id] = map[b.id + '|' + a.id] = t;
      });
    });
    return map;
  }
  /* linkupsOf: games where one player had an assist and a teammate scored.
     EA does not say who assisted whom, so this counts games, not goals. */
  function linkupsOf(byId) {
    var map = dict();
    idx.matches.forEach(function (m) {
      var us = m.players.us;
      us.forEach(function (a) {
        if (!a.assists) return;
        us.forEach(function (b) {
          if (b === a || !b.goals) return;
          var k = a.id + '>' + b.id;
          (map[k] || (map[k] = { from: byId[a.id], to: byId[b.id], n: 0 })).n++;
        });
      });
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .filter(function (e) { return e.from && e.to && e.n >= 2; })
      .sort(function (x, y) { return y.n - x.n || x.from.name.localeCompare(y.from.name); });
  }
  /* bestFiveOf: the five regulars with the best record in the games all five played */
  function bestFiveOf(regs) {
    var need = Math.max(INS_MIN_GAMES, Math.ceil(idx.matches.length / 5)), list = [];
    (function pick(start, chosen) {
      if (chosen.length === 5) {
        var ms = togetherOf(chosen);
        if (ms.length >= need) { var t = tally(ms); list.push({ ps: chosen.slice(), t: t, ppg: pointsPerGame(t), gd: goalDiffPerGame(t) }); }
        return;
      }
      for (var i = start; i <= regs.length - (5 - chosen.length); i++) { chosen.push(regs[i]); pick(i + 1, chosen); chosen.pop(); }
    })(0, []);
    list.sort(function (x, y) { return y.ppg - x.ppg || y.t.P - x.t.P || y.gd - x.gd; });
    return { need: need, best: list[0] || null };
  }

  /* insights: built once per page load (the data never changes while the page is open).
     Roles, form and every award are worked out again from the saved games on each load,
     so they change on their own as new games come in. */
  function insights() {
    if (idx.ins) return idx.ins;
    var byId = dict();
    idx.players.forEach(function (a) {
      byId[a.id] = a;
      a.inMatch = dict();
      a.log.forEach(function (x) { a.inMatch[x.m.id] = true; });
    });
    var outfield = idx.players.filter(function (a) { return a.apps >= INS_MIN_GAMES && mainPos(a) !== 'GK'; });
    var sq = {};
    Object.keys(RATE).forEach(function (k) { sq[k] = mean(outfield.map(RATE[k])) || 0; });
    var by = dict();
    idx.players.filter(function (a) { return a.apps > 0; }).forEach(function (a) {
      by[a.id] = { a: a, role: roleOf(a, sq), form: formOf(a), steady: steadinessOf(a), impact: impactOf(a), close: closeOf(a) };
    });
    var regs = regularsOf();
    return (idx.ins = { by: by, regs: regs, duos: duosOf(regs), links: linkupsOf(byId), five: bestFiveOf(regs) });
  }

  function recordOf(t) { return t.W + 'W ' + t.D + 'D ' + t.L + 'L'; }
  function tone(delta, limit) { return delta >= limit ? ' good' : delta <= -limit ? ' bad' : ''; }
  function playerLink(a) { return '<a href="' + playerHref(a.id) + '">' + esc(a.name) + '</a>'; }
  /* shortName: grid headers have little room, so drop trailing digits and cut long names */
  function shortName(n) { var s = String(n).replace(/\d+$/, '') || String(n); return s.length > 9 ? s.slice(0, 8) + '…' : s; }

  /* G+A streak: games in a row, counting back from the latest, with a goal or an assist */
  function gaRunOf(a) {
    var n = 0;
    for (var i = a.log.length - 1; i >= 0; i--) { if (a.log[i].p.goals + a.log[i].p.assists > 0) n++; else break; }
    return n;
  }
  function closeGaOf(a) {
    var n = 0, ga = 0;
    a.log.forEach(function (x) { if (isClose(x.m)) { n++; ga += x.p.goals + x.p.assists; } });
    return { n: n, ga: ga };
  }

  /* trophiesOf: one award per category, worked out fresh from the saved games.
     Ties share the award. An award with nobody qualifying is left out. */
  function trophiesOf(ins) {
    var ps = idx.players.filter(function (a) { return a.apps > 0; }), out = [];
    function award(title, value, show, opt) {
      opt = opt || {};
      var rows = ps.filter(function (a) { return !opt.ok || opt.ok(a); }).map(function (a) { return { a: a, v: value(a) }; })
        .filter(function (r) { return r.v !== null && r.v !== undefined && isFinite(r.v) && (opt.low || r.v >= (opt.min || 1e-9)); });
      if (!rows.length) return;
      rows.sort(function (x, y) { return opt.low ? x.v - y.v : y.v - x.v; });
      var top = rows.filter(function (r) { return Math.abs(r.v - rows[0].v) < 1e-9; });
      out.push({ title: title, who: top.map(function (r) { return r.a; }), value: show(top[0].v, top[0].a), sub: opt.sub ? opt.sub(top[0].a, top.length) : '', tip: opt.tip || '' });
    }
    var n = idx.matches.length;
    award('Golden Boot', function (a) { return a.goals; }, function (v) { return v + (v === 1 ? ' goal' : ' goals'); },
      { sub: function (a, k) { return k > 1 ? 'shared' : 'in ' + games(a.apps); }, tip: 'Most goals' });
    award('Playmaker', function (a) { return a.assists; }, function (v) { return v + (v === 1 ? ' assist' : ' assists'); },
      { sub: function (a, k) { return k > 1 ? 'shared' : 'in ' + games(a.apps); }, tip: 'Most assists' });
    award('Top rated', avgRating, function (v) { return f2(v) + ' average'; },
      { ok: function (a) { return a.rated >= INS_MIN_RATED; }, sub: function (a) { return 'over ' + games(a.rated); }, tip: 'Best average rating, ' + INS_MIN_RATED + '+ rated games' });
    award('Sharpshooter', function (a) { return pct(a.goals, a.tries); }, function (v) { return pctF(v) + ' of shots scored'; },
      { ok: function (a) { return a.goals >= 3; }, sub: function (a) { return a.goals + ' from ' + a.tries + ' shots'; }, tip: 'Best goals per shot, 3+ goals' });
    award('Clutch', function (a) { return closeGaOf(a).ga; }, function (v) { return v + ' G+A in close games'; },
      { sub: function (a) { return 'in ' + games(closeGaOf(a).n) + ' decided by a goal or less'; }, tip: 'Most goals + assists in draws and one-goal games' });
    award('Player of the match', function (a) { return a.motm; }, function (v) { return v + (v === 1 ? ' award' : ' awards'); },
      { sub: function (a) { return 'in ' + games(a.apps); }, tip: 'Most player of the match awards' });
    award('On a run', gaRunOf, function (v) { return v + ' games in a row'; },
      { min: 3, sub: function () { return 'with a goal or assist, and counting'; }, tip: 'Longest current run of games with a goal or an assist (3+)' });
    award('In form', function (a) { var f = ins.by[a.id] && ins.by[a.id].form; return f ? f.delta : null; }, function (v) { return signed(v, 2) + ' rating'; },
      { min: INS_TREND, sub: function (a) { var f = ins.by[a.id].form; return f2(f.recent) + ' over the last ' + games(f.n); }, tip: 'Biggest rise in rating, latest games against the ones before' });
    award('Mr Reliable', function (a) { var s = ins.by[a.id] && ins.by[a.id].steady; return s ? s.sd : null; }, function (v) { return '±' + f2(v) + ' game to game'; },
      { low: true, sub: function (a) { return 'steadiest ratings over ' + games(a.rated); }, tip: 'Smallest swing in rating from game to game' });
    award('Wildcard', function (a) { var s = ins.by[a.id] && ins.by[a.id].steady; return s ? s.sd : null; }, function (v) { return '±' + f2(v) + ' game to game'; },
      { sub: function (a) { var rs = ratingsOf(a.log); return 'anywhere from ' + f1(Math.min.apply(null, rs)) + ' to ' + f1(Math.max.apply(null, rs)); }, tip: 'Biggest swing in rating from game to game' });
    award('Safe hands', function (a) { var s = 0; a.log.forEach(function (x) { if (x.p.pos === 'GK') s += x.p.saves; }); return s; }, function (v) { return v + (v === 1 ? ' save' : ' saves'); },
      { sub: function (a) { var g = a.log.filter(function (x) { return x.p.pos === 'GK'; }).length; return 'in ' + games(g) + ' in goal'; }, tip: 'Most saves in goal' });
    award('Ever-present', function (a) { return a.apps; }, function (v) { return v + ' of ' + n + ' games'; },
      { sub: function (a, k) { return k > 1 ? 'shared' : pctS(a.apps, n) + ' of games played'; }, tip: 'Most games played' });
    return out;
  }

  /* sparkline: the last 10 ratings as a small line, latest dot coloured like its rating chip */
  function sparkline(a) {
    var log = a.log.filter(function (x) { return x.p.rating > 0; }).slice(-10);
    if (log.length < 2) return '<span class="muted">–</span>';
    var rs = log.map(function (x) { return x.p.rating; });
    var W = 72, H = 24, lo = Math.min(5, Math.floor(Math.min.apply(null, rs))), hi = 10;
    var X = function (i) { return 3 + i * (W - 6) / (rs.length - 1); }, Y = function (v) { return 3 + (hi - v) * (H - 6) / (hi - lo); };
    var last = log[log.length - 1];
    return '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Last ' + rs.length + ' ratings: ' + rs.map(function (r) { return r.toFixed(1); }).join(', ') + '">' +
      '<title>Last ' + rs.length + ' ratings: ' + rs.map(function (r) { return r.toFixed(1); }).join(', ') + '</title>' +
      '<polyline points="' + rs.map(function (r, i) { return X(i).toFixed(1) + ',' + Y(r).toFixed(1); }).join(' ') + '"/>' +
      '<circle cx="' + X(rs.length - 1).toFixed(1) + '" cy="' + Y(last.p.rating).toFixed(1) + '" r="2.8" style="fill:' + rtColor(last.p.rating, last.p.motm) + '"/></svg>';
  }

  /* Insights tab: trophy cabinet, the player table, linkups, best five and the duo grid */
  var INS_COLS = [
    { k: 'form',    label: 'Form',        tip: 'Average rating in the latest games minus the games before', v: function (r) { return r.form ? r.form.delta : null; } },
    { k: 'steady',  label: 'Rating swing', tip: 'How much the rating moves from game to game. Lower is steadier', v: function (r) { return r.steady ? r.steady.sd : null; } },
    { k: 'with',    label: 'Pts/game with', tip: 'Club points per game when the player plays (win 3, draw 1)', v: function (r) { return r.impact ? r.impact.ppgWith : null; } },
    { k: 'without', label: 'Without',     tip: 'Club points per game in the games the player missed', v: function (r) { return r.impact ? r.impact.ppgWithout : null; } },
    { k: 'impact',  label: 'Impact',      tip: 'Points per game with the player minus without', v: function (r) { return r.impact ? r.impact.delta : null; } },
    { k: 'close',   label: 'Close games', tip: 'Average rating in draws and one-goal games', v: function (r) { return r.close ? r.close.rating : null; } }
  ];

  function trophyCabinetHtml(ins) {
    var list = trophiesOf(ins);
    if (!list.length) return '';
    return '<section class="card"><div class="card-h"><h2>Trophy cabinet</h2><span class="muted small">updates after every game</span></div><div class="trophies">' +
      list.map(function (t) {
        return '<div class="trophy" title="' + esc(t.tip) + '"><span class="tr-t">' + esc(t.title) + '</span>' +
          '<span class="tr-who">' + t.who.map(playerLink).join(' &amp; ') + '</span>' +
          '<span class="tr-v">' + esc(t.value) + '</span>' + (t.sub ? '<span class="tr-s">' + esc(t.sub) + '</span>' : '') + '</div>';
      }).join('') + '</div></section>';
  }

  function insightsTableHtml(ins) {
    var sk = ui.insSort.k, sd = ui.insSort.dir;
    var col = INS_COLS.filter(function (c) { return c.k === sk; })[0] || INS_COLS[0];
    var rows = Object.keys(ins.by).map(function (id) { return ins.by[id]; });
    rows.sort(function (x, y) {
      var a = col.v(x), b = col.v(y);
      if (a === null || b === null) return a === null && b === null ? y.a.apps - x.a.apps : a === null ? 1 : -1;   // blanks always last
      return (b - a) * -sd || y.a.apps - x.a.apps;
    });
    function small(s) { return '<small>' + s + '</small>'; }
    return '<section class="card"><div class="tw"><table class="ins-t"><thead><tr><th>Player</th><th title="Ratings in the last 10 games">Last 10</th>' + INS_COLS.map(function (c) {
      var on = c.k === sk;
      return '<th title="' + esc(c.tip) + '"><button data-act="ins-sort" data-k="' + c.k + '" class="' + (on ? 'on' : '') + '">' + c.label + (on ? (sd < 0 ? ' ↓' : ' ↑') : '') + '</button></th>';
    }).join('') + '</tr></thead><tbody>' + rows.map(function (r) {
      var f = r.form, s = r.steady, im = r.impact, c = r.close;
      var roleLine = r.role ? esc(r.role.label) : games(r.a.apps) + ' · role after ' + INS_MIN_GAMES;
      return '<tr><td class="name">' + playerLink(r.a) + small(roleLine) + '</td>' +
        '<td class="spark-td">' + sparkline(r.a) + '</td>' +
        '<td>' + (f ? '<b class="delta' + tone(f.delta, INS_TREND) + '">' + signed(f.delta, 2) + '</b>' + small(f.label) : '–') + '</td>' +
        '<td>' + (s ? '±' + f2(s.sd) + small(s.label) : '–') + '</td>' +
        '<td>' + (im ? f2(im.ppgWith) + small(games(im.w.P)) : '–') + '</td>' +
        '<td>' + (im && im.ppgWithout !== null ? f2(im.ppgWithout) + small(games(im.wo.P)) : '–') + '</td>' +
        '<td>' + (im && im.delta !== null ? '<b class="delta' + tone(im.delta, 0.25) + '">' + signed(im.delta, 2) + '</b>' : '–') + '</td>' +
        '<td>' + (c ? rt(c.rating) + small(f1(c.restRating) + ' in the rest') : '–') + '</td></tr>';
    }).join('') + '</tbody></table></div></section>';
  }

  function linkupsHtml(ins) {
    return '<section class="card"><div class="card-h"><h2>Linkups</h2><span class="muted small">assist → goal, same game</span></div><div class="plist">' +
      (ins.links.slice(0, 6).map(function (e, i) {
        return '<div class="pl"><span class="rk">' + (i + 1) + '</span><span class="nm wrap">' + playerLink(e.from) + ' <span class="muted">→</span> ' + playerLink(e.to) +
          '</span><span class="v">' + games(e.n) + '</span></div>';
      }).join('') || '<div class="pl muted">No linkup has happened twice yet.</div>') + '</div></section>';
  }

  function bestFiveHtml(ins) {
    var f = ins.five, b = f.best;
    return '<section class="card"><div class="card-h"><h2>Best five</h2><span class="muted small">all five on the pitch · ' + f.need + '+ games</span></div>' +
      (b ? '<div class="card-b five"><div class="five-names">' + b.ps.map(playerLink).join('') + '</div>' +
        '<div class="five-rec"><b>' + recordOf(b.t) + '</b><span class="muted small">' + games(b.t.P) + ' together · ' + f2(b.ppg) + ' pts/game · ' + signed(b.gd, 1) + ' goals a game</span></div></div>'
        : '<div class="card-b muted">No five regulars have played ' + f.need + ' games together yet.</div>') + '</section>';
  }

  /* duo grid: club win % in the games each pair both played, tinted against the club's overall win % */
  function duoGridHtml(ins) {
    var regs = ins.regs;
    if (regs.length < 2) return '';
    var club = tally(idx.matches), base = pct(club.W, club.P) || 0;
    function cell(t, self) {
      if (t.P < INS_MIN_GAMES) return '<td class="duo-c muted" title="' + games(t.P) + ' together">–</td>';
      var w = pct(t.W, t.P), diff = w - base, k = Math.min(1, Math.abs(diff) / 30) * 38;
      var bg = self || Math.abs(diff) < 1 ? '' : ' style="background:color-mix(in srgb, var(--' + (diff > 0 ? 'win' : 'loss') + ') ' + Math.round(k) + '%, transparent)"';
      return '<td class="duo-c' + (self ? ' duo-self' : '') + '"' + bg + ' title="' + recordOf(t) + ' in ' + games(t.P) + '"><b>' + Math.round(w) + '%</b><small>' + t.P + ' gp</small></td>';
    }
    var h = '<section class="card"><div class="card-h"><h2>Who wins together</h2><span class="muted small">win % when both play · club ' + Math.round(base) + '%</span></div>' +
      '<div class="tw"><table class="duo"><thead><tr><th></th>' + regs.map(function (a) { return '<th title="' + esc(a.name) + '">' + esc(shortName(a.name)) + '</th>'; }).join('') + '</tr></thead><tbody>';
    regs.forEach(function (a) {
      h += '<tr><td class="name">' + playerLink(a) + '</td>' + regs.map(function (b) {
        return a === b ? cell({ P: a.apps, W: a.W, D: a.D, L: a.L }, true) : cell(ins.duos[a.id + '|' + b.id], false);
      }).join('') + '</tr>';
    });
    return h + '</tbody></table></div><p class="duo-key muted small">Green: the club wins more often than usual when both play. Red: less often. Grey: the player\'s own record. Pairs need ' + INS_MIN_GAMES + ' games together.</p></section>';
  }

  function insightsPageHtml() {
    if (!idx.matches.length) return emptyState();
    var ins = insights();
    return trophyCabinetHtml(ins) + insightsTableHtml(ins) +
      '<div class="grid2">' + linkupsHtml(ins) + bestFiveHtml(ins) + '</div>' + duoGridHtml(ins) +
      '<p class="note">Worked out from the ' + games(idx.matches.length) + ' saved here, again on every visit, so roles, awards and form move as new games come in. ' +
      'Form compares a player\'s latest rated games with the ones before. With and without need ' + INS_MIN_GAMES + ' games each, and a close game is a draw or a one-goal result. ' +
      'EA doesn\'t say who assisted whom, so a linkup counts games where one player had an assist and the other scored.</p>';
  }

  /* Player page > Insights: the same findings written out for one player */
  function playerInsightsHtml(a) {
    var ins = insights(), r = ins.by[a.id];
    if (!r) return '';
    var rows = [], f = r.form, s = r.steady, im = r.impact, c = r.close, name = esc(a.name), club = esc(db.club.name);
    function row(tag, cls, text) { rows.push('<li><span class="ins-tag' + cls + '">' + tag + '</span><span>' + text + '</span></li>'); }

    if (r.role) row(esc(r.role.label), '', esc(r.role.why) + '.');
    if (f) row(f.label, tone(f.delta, INS_TREND), 'Rated ' + f2(f.recent) + ' over the last ' + games(f.n) + ', ' +
      (Math.abs(f.delta) < 0.005 ? 'level with' : (f.delta > 0 ? 'up ' : 'down ') + f2(Math.abs(f.delta)) + ' on') + ' the ' + f2(f.before) + ' before that.');
    if (s) row(s.label, '', 'Ratings move by ±' + f2(s.sd) + ' from game to game; ' + pctF(s.solid) + ' of games rated 7.0 or better.');
    if (im && im.delta !== null) {
      row(signed(im.delta, 2) + ' pts/game', tone(im.delta, 0.25), club + ' take ' + f2(im.ppgWith) + ' points a game with ' + name + ' (' + recordOf(im.w) + ') and ' +
        f2(im.ppgWithout) + ' without (' + recordOf(im.wo) + ').');
    } else if (im) {
      row('Impact', '', name + ' has missed ' + games(im.wo.P) + ', too few to compare ' + club + ' with and without.');
    }
    var good = a.log.filter(function (x) { return x.p.rating >= GOOD_GAME; }), other = a.log.filter(function (x) { return x.p.rating > 0 && x.p.rating < GOOD_GAME; });
    if (good.length && other.length) {
      row('Rated ' + GOOD_GAME.toFixed(1) + '+', '', club + ' go ' + recordOf(tally(good.map(function (x) { return x.m; }))) + ' when ' + name + ' rates ' + GOOD_GAME.toFixed(1) + ' or better, ' +
        recordOf(tally(other.map(function (x) { return x.m; }))) + ' otherwise.');
    }
    if (c) {
      row('Close games', tone(c.delta, INS_TREND), 'Rated ' + f2(c.rating) + ' in ' + games(c.n) + ' decided by a goal or less, ' + f2(c.restRating) + ' in the rest.' +
        (a.goals + a.assists > 0 ? ' Goals + assists per 90: ' + f2(c.ga) + ' v ' + f2(c.restGa) + '.' : ''));
    }
    if (a.goals + a.assists > 0) {
      var parts = [['W', 'wins'], ['D', 'draws'], ['L', 'defeats']].map(function (x) {
        var log = a.log.filter(function (y) { return y.m.result === x[0]; }), ga = 0;
        log.forEach(function (y) { ga += y.p.goals + y.p.assists; });
        return log.length ? f2(ga / log.length) + ' in ' + x[1] : '';
      }).filter(Boolean);
      row('By result', '', 'Goals + assists per game: ' + parts.join(', ') + '.');
    }
    var feeds = ins.links.filter(function (e) { return e.from === a; })[0], fedBy = ins.links.filter(function (e) { return e.to === a; })[0];
    if (feeds) row('Linkup', '', 'Had an assist in ' + games(feeds.n) + ' where ' + playerLink(feeds.to) + ' scored.');
    if (fedBy) row('Fed by', '', playerLink(fedBy.from) + ' had an assist in ' + games(fedBy.n) + ' where ' + name + ' scored.');
    if (!rows.length) return '';
    return '<section class="card"><div class="card-h"><h2>Insights</h2><span class="muted small">from ' + games(a.apps) + '</span></div><ul class="ins">' + rows.join('') + '</ul></section>';
  }

  /* ---------- insights (top-level tab) ---------- */
  function viewInsights() {
    var h = '<div class="dayhead"><h1>Insights</h1>' + (idx.matches.length ? '<span class="muted small">from ' + games(idx.matches.length) + '</span>' : '') + '</div>';
    h += insightsPageHtml();
    view.innerHTML = h;
  }

  /* ---------- player ---------- */
  function ratingChart(log) {
    var pts = log.filter(function (x) { return x.p.rating > 0; });
    if (!pts.length) return '<p class="muted">No ratings yet.</p>';
    var W = 720, H = 220, L = 34, R = 14, T = 14, B = 28;
    var lo = Math.min(5, Math.floor(Math.min.apply(null, pts.map(function (x) { return x.p.rating; })))), hi = 10;
    var X = function (i) { return pts.length === 1 ? (L + W - R) / 2 : L + i * (W - L - R) / (pts.length - 1); };
    var Y = function (v) { return T + (hi - v) * (H - T - B) / (hi - lo); };
    var avg = pts.reduce(function (s, x) { return s + x.p.rating; }, 0) / pts.length;
    var s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Rating by game, average ' + avg.toFixed(2) + '">';
    for (var g = lo; g <= hi; g++) s += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(g) + '" y2="' + Y(g) + '"/><text class="axis" x="' + (L - 8) + '" y="' + (Y(g) + 4) + '" text-anchor="end">' + g + '</text>';
    s += '<line class="avg" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(avg) + '" y2="' + Y(avg) + '"/>';
    if (pts.length > 1) s += '<polyline class="ln" points="' + pts.map(function (x, i) { return X(i).toFixed(1) + ',' + Y(x.p.rating).toFixed(1); }).join(' ') + '"/>';
    pts.forEach(function (x, i) {
      var title = x.p.rating.toFixed(1) + ' v ' + x.m.them.name;
      var sub = x.m.us.goals + '–' + x.m.them.goals + ' · ' + fmtDayShort(x.m.day);
      s += '<a href="' + matchHref(x.m) + '"><circle class="tip-node" data-tip-title="' + esc(title) + '" data-tip-sub="' + esc(sub) + '" fill="' + rtColor(x.p.rating, x.p.motm) + '" cx="' + X(i).toFixed(1) + '" cy="' + Y(x.p.rating).toFixed(1) + '" r="6"></circle></a>';
    });
    s += '<text class="axis" x="' + L + '" y="' + (H - 8) + '">' + esc(fmtDayShort(pts[0].m.day)) + '</text>';
    if (pts.length > 1) s += '<text class="axis" x="' + (W - R) + '" y="' + (H - 8) + '" text-anchor="end">' + esc(fmtDayShort(pts[pts.length - 1].m.day)) + '</text>';
    s += '<text class="avgl" x="' + (W / 2) + '" y="' + (H - 8) + '" text-anchor="middle">Avg ' + avg.toFixed(2) + '</text>';
    return s + '</svg>';
  }

  function kvCard(title, rows) {
    return '<section class="card"><div class="card-h"><h2>' + title + '</h2></div><div class="card-b"><dl class="kv">' +
      rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('') + '</dl></div></section>';
  }

  function squadCompare(a) {
    var pool = idx.players.filter(function (p) { return p.apps > 0; });
    var metrics = [
      ['Avg rating', avgRating, f2],
      ['Goals /90', function (p) { return per90(p.goals, p.seconds); }, f2],
      ['Assists /90', function (p) { return per90(p.assists, p.seconds); }, f2],
      ['G+A /90', function (p) { return per90(p.goals + p.assists, p.seconds); }, f2],
      ['Shots /90', function (p) { return per90(p.tries, p.seconds); }, f1],
      ['Pass accuracy', function (p) { return pct(p.passesMade, p.passAttempts); }, pctF],
      ['Tackles won /90', function (p) { return per90(p.tacklesMade, p.seconds); }, f1]
    ];
    var h = '';
    metrics.forEach(function (mt) {
      var mine = mt[1](a);
      if (mine === null) return;
      var vals = pool.map(mt[1]).filter(function (v) { return v !== null; });
      var max = Math.max.apply(null, vals), rank = 1 + vals.filter(function (v) { return v > mine + 1e-9; }).length;
      h += '<div class="cmp"><span>' + mt[0] + '</span><span class="track"><i style="width:' + (max > 0 ? Math.max(2, mine / max * 100) : 2) + '%"></i></span><span class="r"><b>' + mt[2](mine) + '</b> · ' + ordinal(rank) + ' of ' + vals.length + '</span></div>';
    });
    return '<section class="card"><div class="card-h"><h2>Squad rank</h2></div><div class="card-b">' + h + '</div></section>';
  }

  function viewPlayer(a) {
    var mem = db.members[a.name] || null, pos = mainPos(a), avg = avgRating(a);
    var role = a.apps ? insights().by[a.id].role : null;
    var h = '<div class="row" style="justify-content:space-between"><a class="btn" href="#squad">‹ Squad</a>' + (a.apps ? '<a class="btn" href="#compare-' + slug(a.id) + '">Compare players ›</a>' : '') + '</div>';
    h += '<section class="card"><div class="card-b phead"><div class="avatar">' + playerImg(a.name) + '</div><div><h1>' + esc(a.name) + '</h1><div class="muted">' +
      [mem && mem.proName ? 'Pro: ' + esc(mem.proName) : '', pos ? POS_LABEL[pos] : '', role ? esc(role.label) : '', mem && mem.heightCm ? mem.heightCm + ' cm' : ''].filter(Boolean).join(' · ') + '</div></div>' +
      (mem && mem.overall ? '<div class="ovr"><b>' + mem.overall + '</b><span class="muted small">Overall</span></div>' : '') + '</div>';
    if (a.apps) {
      h += tiles([['Games', a.apps], ['Minutes', mins(a.seconds)], ['Goals', a.goals], ['Assists', a.assists], ['Avg rating', f2(avg)], ['MOTM', a.motm]], 'topline');
    }
    h += '</section>';

    if (!a.apps) {
      h += '<p class="note">No games tracked yet.</p>';
    } else {
      var log = a.log, rated = log.filter(function (x) { return x.p.rating > 0; });
      var last5 = rated.slice(-5), l5 = last5.length ? last5.reduce(function (s, x) { return s + x.p.rating; }, 0) / last5.length : null;
      var best = rated.slice().sort(function (x, y) { return y.p.rating - x.p.rating; })[0], worst = rated.slice().sort(function (x, y) { return x.p.rating - y.p.rating; })[0];
      var sd = rated.length > 1 ? Math.sqrt(rated.reduce(function (s, x) { return s + Math.pow(x.p.rating - avg, 2); }, 0) / rated.length) : null;
      var cur, longest = 0, run = 0, gaGames = 0, r8 = 0;
      log.forEach(function (x) { if (x.p.goals > 0) { run++; longest = Math.max(longest, run); } else run = 0; if (x.p.goals + x.p.assists > 0) gaGames++; if (x.p.rating >= 8) r8++; });
      cur = run;
      var clubAll = tally(idx.matches), clubWin = pct(clubAll.W, clubAll.P), myWin = pct(a.W, a.apps), diff = myWin - clubWin;
      var perfLink = function (x) { return x ? '<a href="' + matchHref(x.m) + '" style="color:var(--accent)">' + x.p.rating.toFixed(1) + ' v ' + esc(x.m.them.name) + '</a>' : '–'; };

      h += '<section class="card"><div class="card-h"><h2>Match ratings</h2></div><div class="card-b">' + ratingChart(log) +
        '<div class="formrow" style="margin-top:10px"><span class="muted small">Last ' + last5.length + ':</span>' + last5.map(function (x) { return '<a href="' + matchHref(x.m) + '" title="v ' + esc(x.m.them.name) + '">' + rt(x.p.rating, false, x.p.motm) + '</a>'; }).join('') +
        '<span class="muted small" style="margin-left:auto">Avg <b style="color:var(--text)">' + f2(l5) + '</b></span></div></div></section>';

      h += playerInsightsHtml(a);

      h += '<div class="statgroups">';
      h += kvCard('Ratings', [['Average', f2(avg)], ['Best', perfLink(best)], ['Lowest', perfLink(worst)], ['Games rated 8.0+', r8 + ' of ' + rated.length], ['Consistency (std dev)', sd === null ? '–' : f2(sd)], ['Player of the match', a.motm + ' (' + pctS(a.motm, a.apps) + ' of games)']]);
      h += kvCard('Attacking', [['Goals', a.goals], ['Goals per 90', f2(per90(a.goals, a.seconds))], ['Shots', a.tries], ['Shots per 90', f1(per90(a.tries, a.seconds))], ['Shot conversion', pctS(a.goals, a.tries)], ['Minutes per goal', a.goals ? Math.round(a.seconds / 60 / a.goals) : '–'], ['Longest scoring streak', games(longest) + (cur && cur === longest ? ' (current)' : '')]]);
      h += kvCard('Creating and passing', [['Assists', a.assists], ['Assists per 90', f2(per90(a.assists, a.seconds))], ['Goals + assists per 90', f2(per90(a.goals + a.assists, a.seconds))], ['Goal involvement', pctS(a.goals + a.assists, a.teamGoals)], ['Games with a goal or assist', gaGames + ' of ' + a.apps], ['Passes completed', a.passesMade + ' of ' + a.passAttempts], ['Pass accuracy', pctS(a.passesMade, a.passAttempts)], ['Passes per 90', f1(per90(a.passesMade, a.seconds))]]);
      var defRows = [['Tackles won', a.tacklesMade + ' of ' + a.tackleAttempts], ['Tackle success', pctS(a.tacklesMade, a.tackleAttempts)], ['Tackles won per 90', f1(per90(a.tacklesMade, a.seconds))], ['Clean sheets', a.cleanSheets], ['Goals conceded per 90', f2(per90(a.goalsConceded, a.seconds))], ['Red cards', a.redCards]];
      if (a.pos.GK) {
        var gk = { saves: 0, conceded: 0, sec: 0, n: 0 };
        log.forEach(function (x) { if (x.p.pos === 'GK') { gk.saves += x.p.saves; gk.conceded += x.p.goalsConceded; gk.sec += x.p.secondsPlayed; gk.n++; } });
        defRows.splice(4, 0, ['Saves (' + games(gk.n) + ' in goal)', gk.saves], ['Saves per 90', f1(per90(gk.saves, gk.sec))], ['Save rate', pctS(gk.saves, gk.saves + gk.conceded)]);
      }
      h += kvCard(a.pos.GK ? 'Defending and goalkeeping' : 'Defending and discipline', defRows);
      h += kvCard('Results with ' + esc(a.name), [['Record', a.W + 'W ' + a.D + 'D ' + a.L + 'L'], ['Win rate', pctS(a.W, a.apps)], ['Club win rate', pctS(clubAll.W, clubAll.P)], ['Difference', (diff >= 0 ? '+' : '−') + Math.abs(Math.round(diff)) + ' pts'], ['Points per game', f2((a.W * 3 + a.D) / a.apps)], ['Sub appearances', a.subs], ['Games missed', (idx.matches.length - a.apps) + ' of ' + idx.matches.length]]);
      var posRows = Object.keys(a.pos).sort(function (x, y) { return a.pos[y] - a.pos[x]; }).map(function (p) {
        var ls = log.filter(function (x) { return x.p.pos === p; }), rs = ls.filter(function (x) { return x.p.rating > 0; });
        var g = 0, as = 0; ls.forEach(function (x) { g += x.p.goals; as += x.p.assists; });
        return [POS_LABEL[p], games(ls.length) + ' · ' + g + ' G · ' + as + ' A · ' + (rs.length ? rt(rs.reduce(function (s, x) { return s + x.p.rating; }, 0) / rs.length) : '–')];
      });
      h += kvCard('By position', posRows);
      h += '</div>';
      h += squadCompare(a);
    }

    if (mem && mem.gamesPlayed) {
      h += '<section class="card"><div class="card-h"><h2>All-time</h2></div>' +
        tiles([['Games', mem.gamesPlayed], ['Win rate', mem.winRate + '%'], ['Goals', mem.goals], ['Assists', mem.assists], ['Avg rating', mem.ratingAve.toFixed(1)], ['MOTM', mem.motm], ['Shot success', mem.shotSuccessRate + '%'], ['Pass success', mem.passSuccessRate + '%'], ['Tackle success', mem.tackleSuccessRate + '%'], ['Clean sheets', mem.cleanSheets], ['Red cards', mem.redCards], ['Goals per game', (mem.goals / mem.gamesPlayed).toFixed(2)]]) + '</section>';
    }

    if (a.apps) {
      h += '<section class="card"><div class="card-h"><h2>Match log</h2></div><div class="tw"><table><thead><tr><th>Match</th><th>Result</th><th>Pos</th><th>Min</th><th>G</th><th>A</th><th>Shots</th><th>Pass %</th><th>Tackles</th><th>Rating</th></tr></thead><tbody>' +
        a.log.slice().reverse().map(function (x) {
          var p = x.p, m = x.m;
          return '<tr><td class="name"><a href="' + matchHref(m) + '">v ' + esc(m.them.name) + '<small>' + esc(fmtDayShort(m.day)) + ' · ' + TYPE_LABEL[m.type] + '</small></a></td><td>' + resChip(m.result) + ' ' + m.us.goals + '–' + m.them.goals + '</td><td>' + p.pos + '</td><td>' + minsCell(p, m) + '</td><td>' + p.goals + '</td><td>' + p.assists + '</td><td>' + tries(p) + '</td><td>' + pctS(p.passesMade, p.passAttempts) + '</td><td>' + p.tacklesMade + '</td><td>' + rt(p.rating, false, p.motm) + '</td></tr>';
        }).join('') + '</tbody></table></div></section>';
    }
    view.innerHTML = h;
  }

  /* ---------- compare (radar + stat list) ---------- */
  /* pctF: format a percentage value, used by CMP metric formatters */
  function pctF(v) { return v === null || v === undefined || !isFinite(v) ? '–' : Math.round(v) + '%'; }
  /* CMP: all comparison metrics — each has a label, value function (a → number|null),
     formatter, optional tooltip, and optional inv flag (lower = better). */
  var CMP = {
    ga:            { label: 'G+A',             f: function (a) { return a.goals + a.assists; },                                                                        fmt: String },
    rating:        { label: 'Rating',          f: avgRating,                                                                                                          fmt: f2 },
    g90:           { label: 'Goals/90',        f: function (a) { return per90(a.goals, a.seconds); },                                                                 fmt: f2,   tip: 'Goals per 90 minutes played' },
    a90:           { label: 'Assists/90',      f: function (a) { return per90(a.assists, a.seconds); },                                                               fmt: f2,   tip: 'Assists per 90 minutes played' },
    ga90:          { label: 'G+A/90',          f: function (a) { return per90(a.goals + a.assists, a.seconds); },                                                     fmt: f2,   tip: 'Goals and assists combined per 90 minutes' },
    s90:           { label: 'Shots/90',        f: function (a) { return per90(a.tries, a.seconds); },                                                                 fmt: f1,   tip: 'Shot attempts per 90 minutes' },
    conv:          { label: 'Shot conv%',      f: function (a) { return pct(a.goals, a.tries); },                                                                     fmt: pctF, tip: 'Goals divided by shot attempts' },
    gi:            { label: 'Goal involve%',   f: function (a) { return pct(a.goals + a.assists, a.teamGoals); },                                                     fmt: pctF, tip: 'Goals + assists as a share of club goals in games played' },
    pass:          { label: 'Pass%',           f: function (a) { return pct(a.passesMade, a.passAttempts); },                                                         fmt: pctF, tip: 'Pass completion rate' },
    p90:           { label: 'Passes/90',       f: function (a) { return per90(a.passesMade, a.seconds); },                                                            fmt: f1,   tip: 'Passes completed per 90 minutes' },
    t90:           { label: 'Tackles/90',      f: function (a) { return per90(a.tacklesMade, a.seconds); },                                                           fmt: f1,   tip: 'Tackles won per 90 minutes' },
    tpct:          { label: 'Tackle%',         f: function (a) { return pct(a.tacklesMade, a.tackleAttempts); },                                                      fmt: pctF, tip: 'Tackle success rate — won tackles divided by attempts' },
    cga90:         { label: 'Conceded/90',     f: function (a) { return per90(a.goalsConceded, a.seconds); },                                                         fmt: f2,   inv: true, tip: 'Goals conceded per 90 — lower is better' },
    cs:            { label: 'Clean sheet%',    f: function (a) { return pct(a.cleanSheets, a.apps); },                                                                fmt: pctF, tip: 'Share of games with a clean sheet' },
    sv90:          { label: 'Saves/90',        f: function (a) { return per90(a.saves, a.seconds); },                                                                 fmt: f1,   tip: 'Saves per 90 minutes' },
    motm:          { label: 'MOTM%',           f: function (a) { return pct(a.motm, a.apps); },                                                                       fmt: pctF, tip: 'Player of the match award rate' },
    pressing_rate: { label: 'Press rate',      f: function (a) { return a.seconds > 0 ? a.tackleAttempts / (a.seconds / MATCH_SECONDS) : null; }, fmt: f1, tip: 'Tackle attempts per 90 — measures defensive pressure applied' },
    atk_threat:    { label: 'Atk threat',      f: function (a) { return a.seconds > 0 ? (a.goals + a.assists + a.tries) / (a.seconds / MATCH_SECONDS) : null; }, fmt: f1, tip: 'Goals + assists + shots per 90 — overall attacking output' }
  };
  /* percentile: 0–100 position of v in vals array; inv=true means lower is better */
  function percentile(v, vals, inv) {
    if (v === null || !vals.length) return null;
    if (vals.length < 2) return 50;
    var beaten = vals.filter(function (x) { return inv ? x > v + 1e-9 : x < v - 1e-9; }).length;
    return beaten / (vals.length - 1) * 100;
  }
  /* cmpAvail: players with at least one tracked game, eligible for compare */
  function cmpAvail() { return idx.players.filter(function (a) { return a.apps > 0; }); }

  /* cmpSelected: the picked players, in pick order (ids that no longer exist are dropped) */
  function cmpSelected() {
    var by = dict();
    cmpAvail().forEach(function (a) { by[a.id] = a; });
    return ui.cmpSel.filter(function (id) { return by[id]; }).map(function (id) { return by[id]; });
  }

  /* radarSvg: build an SVG radar/spider chart.
   *   axes: array of { k, mt, vals } — one spoke per stat
   *   rows: array of { a, i, cells } — one polygon per player
   * Uses percentile positioning so every player can be compared regardless of scale. */
  var compactMq = window.matchMedia ? window.matchMedia('(max-width: 600px)') : null;
  function radarSvg(axes, rows) {
    var compact = !!(compactMq && compactMq.matches);
    var W = compact ? 520 : 640, H = compact ? 470 : 520, cx = W / 2, cy = compact ? 236 : 262, R = compact ? 135 : 178, FS = compact ? 18 : 13, n = axes.length;
    function pt(i, r) { var t = -Math.PI / 2 + i * 2 * Math.PI / n; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; }
    function xy(p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }
    function lines(label) {
      if (label.length <= 9 || label.indexOf(' ') < 0) return [label];
      var mid = label.length / 2, best = -1, i;
      for (i = 0; i < label.length; i++) if (label.charAt(i) === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
      return [label.slice(0, best), label.slice(best + 1)];
    }
    var s = '<svg class="radar" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Radar chart comparing ' + rows.map(function (r) { return esc(r.a.name); }).join(', ') + ' on ' + n + ' stats">';
    [20, 40, 60, 80, 100].forEach(function (lv) {
      s += '<polygon class="ring" points="' + axes.map(function (_, i) { return xy(pt(i, R * lv / 100)); }).join(' ') + '"/>';
    });
    axes.forEach(function (_, i) { s += '<line class="spoke" x1="' + cx + '" y1="' + cy + '" x2="' + pt(i, R)[0].toFixed(1) + '" y2="' + pt(i, R)[1].toFixed(1) + '"/>'; });
    if (!compact) [20, 40, 60, 80, 100].forEach(function (lv) { s += '<text class="ringl" x="' + (cx + 4) + '" y="' + (cy - R * lv / 100 - 2).toFixed(1) + '">' + lv + '</text>'; });
    axes.forEach(function (ax, i) {
      var t = -Math.PI / 2 + i * 2 * Math.PI / n, c = Math.cos(t), sn = Math.sin(t), p = pt(i, R + 16), ls = lines(ax.mt.label), lh = FS * 1.15;
      var y0 = p[1] + FS * 0.32 - (ls.length - 1) * lh * (sn < -0.3 ? 1 : sn > 0.3 ? 0 : 0.5);
      s += '<text class="alab' + (ax.mt.tip ? ' tip tip-node' : '') + '" style="font-size:' + FS + 'px" x="' + p[0].toFixed(1) + '" y="' + y0.toFixed(1) + '" text-anchor="' + (c > 0.3 ? 'start' : c < -0.3 ? 'end' : 'middle') + '"' + (ax.mt.tip ? ' data-tip-title="' + esc(ax.mt.label) + '" data-tip-sub="' + esc(ax.mt.tip) + '"' : '') + '>' +
        ls.map(function (l, k) { return '<tspan x="' + p[0].toFixed(1) + '"' + (k ? ' dy="' + lh.toFixed(1) + '"' : '') + '>' + esc(l) + '</tspan>'; }).join('') + '</text>';
    });
    rows.forEach(function (r) {
      s += '<polygon class="ser s' + r.i + '" points="' + r.cells.map(function (c, k) { return xy(pt(k, R * (c.p === null ? 0 : c.p) / 100)); }).join(' ') + '"/>';
    });
    rows.forEach(function (r) {
      r.cells.forEach(function (c, k) {
        var p = pt(k, R * (c.p === null ? 0 : c.p) / 100);
        var tipTitle = r.a.name + ' · ' + axes[k].mt.label;
        var tipSub = c.p === null ? 'No data' : Math.round(c.p) + 'th pct (' + axes[k].mt.fmt(c.v) + ')';
        s += '<circle class="pt s' + r.i + ' tip-node" data-tip-title="' + esc(tipTitle) + '" data-tip-sub="' + esc(tipSub) + '" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + (compact ? 6 : 4.5) + '"></circle>';
      });
    });
    return s + '</svg>';
  }

  /* Radar axes — 6-point hexagon, opposites pair meaningfully:
     Rating ↔ Pass%  |  G/90 ↔ Shot conv%  |  A/90 ↔ Tackles/90
     Clockwise from top: Rating, G/90, A/90, Pass%, Tackles/90, Shot conv% */
  var CMP_RADAR_AXES = ['rating', 'g90', 'a90', 'pass', 't90', 'conv'];
  /* Full stat list shown below the radar, grouped by section.
   * String items reference CMP keys; object items are section headers. */
  var CMP_ALL_STATS = [
    { section: 'Overall' },
    'rating', 'motm', 'ga', 'ga90',
    { section: 'Attacking' },
    'g90', 's90', 'conv', 'gi', 'atk_threat',
    { section: 'Creating' },
    'a90', 'pass', 'p90',
    { section: 'Defending' },
    't90', 'tpct', 'pressing_rate', 'cga90', 'cs', 'sv90'
  ];

  /* compareHtml: the compare body, shared by viewCompare and the Squad > Compare toggle */
  function compareHtml() {
    var avail = cmpAvail(), sel = cmpSelected();
    var h = '';
    if (!avail.length) { return emptyState(); }

    h += '<section class="card"><div class="card-b"><div class="pickrow" role="group" aria-label="Players to compare">' +
      avail.slice().sort(function (x, y) { return y.seconds - x.seconds || x.name.localeCompare(y.name); }).map(function (a) {
        var at = sel.indexOf(a), on = at >= 0;
        return '<button class="pchip' + (on ? ' on s' + at : '') + '" data-act="cmp-toggle" data-id="' + esc(a.id) + '" aria-pressed="' + on + '">' +
          '<i class="sw"></i>' + esc(a.name) + '</button>';
      }).join('') + '</div></div></section>';

    if (!sel.length) { return h + '<div class="card"><div class="card-b muted">Pick a player above to compare.</div></div>'; }

    var radarAxes = CMP_RADAR_AXES.map(function (k) {
      var mt = CMP[k];
      return { k: k, mt: mt, vals: avail.map(mt.f).filter(function (v) { return v !== null; }) };
    });
    var rows = sel.map(function (a, i) {
      return { a: a, i: i, cells: radarAxes.map(function (ax) { var v = ax.mt.f(a); return { v: v, p: percentile(v, ax.vals, ax.mt.inv) }; }) };
    });

    h += '<section class="card"><div class="card-b">' + radarSvg(radarAxes, rows) + '</div></section>';

    /* Stat comparison list */
    h += '<section class="card"><div class="cmp-list" style="--cmp-n:' + sel.length + '">';
    /* header row with player names */
    h += '<div class="cmp-hdr"><span></span>' + sel.map(function (a, i) {
      return '<span class="s' + i + 'c">' + esc(a.name) + '</span>';
    }).join('') + '</div>';

    CMP_ALL_STATS.forEach(function (item) {
      if (item && item.section) {
        h += '<div class="cmp-section">' + esc(item.section) + '</div>';
        return;
      }
      var k = item, mt = CMP[k];
      if (!mt) return;
      var vals = sel.map(function (a) { return mt.f(a); });
      /* find winner: highest value (or lowest if inv) among non-null vals */
      var winnerIdx = null;
      if (sel.length >= 2) {
        var best = null;
        vals.forEach(function (v, i) {
          if (v === null) return;
          if (best === null) { best = v; winnerIdx = i; return; }
          var better = mt.inv ? v < best : v > best;
          if (better) { best = v; winnerIdx = i; }
          else if (v === best) winnerIdx = -1; /* tie */
        });
      }
      h += '<div class="cmp-row"><span class="cmp-label">' + esc(mt.label) + (mt.tip ? '<small class="muted"> ' + esc(mt.tip) + '</small>' : '') + '</span>' +
        vals.map(function (v, i) {
          var win = winnerIdx === i;
          return '<span class="cmp-val' + (win ? ' s' + i + 'c cmp-win' : '') + '">' + (v === null ? '–' : mt.fmt(v)) + '</span>';
        }).join('') + '</div>';
    });

    h += '</div></section>';
    return h;
  }
  function viewCompare() {
    var h = '<div class="dayhead"><h1>Compare</h1></div>';
    view.innerHTML = h + compareHtml();
  }

  /* ---------- club stats & leaderboards ---------- */
  /* board: render a top-5 leaderboard card.
     gamesFn(r) — optional — returns the subtitle string for each row (defaults to tracked apps) */
  function board(title, rows, gamesFn) {
    var gfn = gamesFn || function (r) { return games(r.a.apps); };
    return '<section class="card"><div class="card-h"><h2>' + title + '</h2></div><div class="plist">' +
      (rows.slice(0, 5).map(function (r, i) {
        return '<a class="pl" href="' + playerHref(r.a.id) + '"><span class="rk">' + (i + 1) + '</span><span class="nm">' + esc(r.a.name) + '<small>' + gfn(r) + '</small></span><span class="v">' + r.s + '</span></a>';
      }).join('') || '<div class="pl muted">None yet.</div>') + '</div></section>';
  }
  /* leaders: build sorted leaderboard rows from tracked idx.players */
  function leaders(valueFn, fmt) {
    return idx.players.filter(function (a) { return a.apps > 0; })
      .map(function (a) { return { a: a, v: valueFn(a) }; }).filter(function (r) { return r.v !== null && r.v > 0; })
      .sort(function (x, y) { return y.v - x.v || y.a.apps - x.a.apps; })
      .map(function (r) { return { a: r.a, s: fmt(r.v) }; });
  }

  /* memLeaders: build sorted leaderboard rows from EA career db.members */
  function memLeaders(valueFn, fmt) {
    var memPlayers = idx.players.filter(function (a) { return db.members[a.name] && db.members[a.name].gamesPlayed > 0; });
    return memPlayers.map(function (a) { return { a: a, m: db.members[a.name], v: valueFn(db.members[a.name]) }; })
      .filter(function (r) { return r.v !== null && r.v !== undefined && r.v > 0; })
      .sort(function (x, y) { return y.v - x.v || y.m.gamesPlayed - x.m.gamesPlayed; })
      .map(function (r) { return { a: r.a, m: r.m, s: fmt(r.v) }; });
  }
  /* gamesFnMem: subtitle showing career gamesPlayed for board() rows */
  function gamesFnMem(r) { return games(r.m ? r.m.gamesPlayed : 0); }

  function streakOf(ms, pred) {
    var cur = 0, best = 0;
    ms.forEach(function (m) { if (pred(m)) { cur++; if (cur > best) best = cur; } else cur = 0; });
    return { cur: cur, best: best };
  }

  /* Dynamic 24-hour time slots (ordered from 5 AM start-of-day through 3–5 AM late night).
     Earlier slots stay hidden until at least 1 match is played in that window. */
  var TIME_SLOTS = [
    ['Early morning', '5 – 8 AM', 5, 8],
    ['Morning', '8 – 11 AM', 8, 11],
    ['Midday', '11 AM – 2 PM', 11, 14],
    ['Afternoon', '2 – 5 PM', 14, 17],
    ['Early evening', '5 – 7 PM', 17, 19],
    ['Evening', '7 – 9 PM', 19, 21],
    ['Prime time', '9 – 11 PM', 21, 23],
    ['Late night', '11 PM – 1 AM', 23, 25],
    ['After hours', '1 – 3 AM', 1, 3],
    ['Overnight', '3 – 5 AM', 3, 5]
  ];
  function inSlot(hr, start, end) {
    if (end > 24) return hr >= start || hr < (end % 24);
    return hr >= start && hr < end;
  }

  function teamSections(ms) {
    var P = ms.length, h = '', name = esc(db.club.name);
    function acc() { return { goals: 0, tries: 0, pg: 0, pm: 0, pa: 0, tm: 0, ta: 0, sv: 0, rc: 0, rs: 0, rn: 0 }; }
    var U = acc(), O = acc(), pts = 0, out = { n: 0, w: 0 }, csN = 0, scoredN = 0, ratings = [];
    var byRes = { W: { n: 0, rs: [], gf: 0, ga: 0 }, D: { n: 0, rs: [], gf: 0, ga: 0 }, L: { n: 0, rs: [], gf: 0, ga: 0 } };
    var parts = TIME_SLOTS.map(function (d) { return { d: d, ms: [] }; });
    ms.forEach(function (m) {
      [[U, m.us, m.stats.us, m.players.us], [O, m.them, m.stats.them, m.players.them]].forEach(function (x) {
        var t = x[0], st = x[2];
        t.goals += x[1].goals; t.tries += triesOf(x[3]); t.pg += st.playerGoals; t.pm += st.passesMade; t.pa += st.passAttempts;
        t.tm += st.tacklesMade; t.ta += st.tackleAttempts; t.sv += st.saves; t.rc += st.redCards;
        if (st.avgRating > 0) { t.rs += st.avgRating; t.rn++; }
      });
      pts += m.result === 'W' ? 3 : m.result === 'D' ? 1 : 0;
      if (triesOf(m.players.us) > triesOf(m.players.them)) { out.n++; if (m.result === 'W') out.w++; }
      if (m.them.goals === 0) csN++;
      if (m.us.goals > 0) scoredN++;
      var tr = m.stats.us.avgRating;
      if (tr > 0) { ratings.push(tr); byRes[m.result].rs.push(tr); }
      byRes[m.result].n++; byRes[m.result].gf += m.us.goals; byRes[m.result].ga += m.them.goals;
      var hr = zoneHour(m.ts);
      parts.forEach(function (p) { if (inSlot(hr, p.d[2], p.d[3])) p.ms.push(m); });
    });

    var rows = [
      ['Goals', U.goals / P, O.goals / P, f2, false],
      ['Shots', U.tries / P, O.tries / P, f1, false],
      ['Shot conversion', pct(U.pg, U.tries), pct(O.pg, O.tries), pctF, false],
      ['Passes completed', U.pm / P, O.pm / P, f1, false],
      ['Pass accuracy', pct(U.pm, U.pa), pct(O.pm, O.pa), pctF, false],
      ['Tackles won', U.tm / P, O.tm / P, f1, false],
      ['Tackle success', pct(U.tm, U.ta), pct(O.tm, O.ta), pctF, false],
      ['Saves', U.sv / P, O.sv / P, f1, false],
      ['Red cards', U.rc / P, O.rc / P, f2, true],
      ['Team average rating', U.rn ? U.rs / U.rn : null, O.rn ? O.rs / O.rn : null, f2, false]
    ];
    h += '<section class="card"><div class="card-h"><h2>Per game</h2><span class="muted small">' + games(P) + '</span></div><div class="tw"><table class="vs"><thead><tr><th>Stat</th><th>' + name + '</th><th>Opponents</th></tr></thead><tbody>' +
      rows.map(function (r) {
        var a = r[1], b = r[2], better = a === null || b === null || Math.abs(a - b) < 1e-9 ? 0 : ((a > b) !== r[4] ? 1 : 2);
        return '<tr><td class="name">' + r[0] + '</td><td class="' + (better === 1 ? 'better' : '') + '">' + r[3](a) + '</td><td class="' + (better === 2 ? 'better' : '') + '">' + r[3](b) + '</td></tr>';
      }).join('') + '</tbody></table></div></section>';

    var l5 = ratings.slice(-5), sd = stdev(ratings), allAvg = mean(ratings);
    var shotShare = pct(U.tries, U.tries + O.tries), gd = (U.goals - O.goals) / P;
    var trend = [
      [(gd >= 0 ? '+' : '−') + Math.abs(gd).toFixed(2), 'Goal difference / game'],
      [f2(pts / P), 'Points / game'],
      [pctF(shotShare), 'Shot share'],
      [pctF(pct(csN, P)), 'Clean sheets'],
      [pctF(pct(scoredN, P)), 'Scored in'],
      [out.n ? pctF(pct(out.w, out.n)) : '–', 'Win rate when out-shooting'],
      [f2(U.rc / P), 'Red cards / game'],
      [sd === null ? '–' : f2(sd), 'Team rating std dev'],
      [P > 5 && allAvg !== null ? ((mean(l5) - allAvg >= 0 ? '+' : '−') + Math.abs(mean(l5) - allAvg).toFixed(2)) : '–', 'Last 5 rating v average']
    ];
    h += '<section class="card"><div class="card-h"><h2>Trends</h2></div>' + tiles(trend.map(function (x) { return [x[1], x[0]]; }), 't3') + '</section>';

    var st = [['Winning run', streakOf(ms, function (m) { return m.result === 'W'; })], ['Unbeaten run', streakOf(ms, function (m) { return m.result !== 'L'; })],
      ['Games in a row with a goal', streakOf(ms, function (m) { return m.us.goals > 0; })], ['Clean sheets in a row', streakOf(ms, function (m) { return m.them.goals === 0; })]];
    h += '<div class="grid2"><section class="card"><div class="card-h"><h2>Streaks</h2><span class="muted small">current · best</span></div><div class="card-b"><dl class="kv">' +
      st.map(function (s) { return '<dt>' + s[0] + '</dt><dd>' + s[1].cur + ' · ' + s[1].best + '</dd>'; }).join('') + '</dl></div></section>';
    h += '<section class="card"><div class="card-h"><h2>Rating by result</h2></div><div class="tw"><table><thead><tr><th>Result</th><th>Games</th><th>Rating</th><th>GF–GA</th></tr></thead><tbody>' +
      ['W', 'D', 'L'].map(function (r) {
        var b = byRes[r];
        return '<tr><td class="name">' + resChip(r) + '</td><td>' + b.n + '</td><td>' + (b.rs.length ? rt(mean(b.rs)) : '–') + '</td><td>' + (b.n ? f1(b.gf / b.n) + '–' + f1(b.ga / b.n) : '–') + '</td></tr>';
      }).join('') + '</tbody></table></div></section></div>';

    var activeParts = parts.filter(function (p) { return p.ms.length > 0; });
    if (activeParts.length) {
      h += '<section class="card"><div class="card-h"><h2>When we play</h2></div><div class="tw"><table><thead><tr><th>Time of day</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF–GA</th><th>Win %</th></tr></thead><tbody>' +
        activeParts.map(function (p) {
          var x = tally(p.ms);
          return '<tr><td class="name">' + p.d[0] + '<small>' + p.d[1] + '</small></td><td>' + x.P + '</td><td>' + x.W + '</td><td>' + x.D + '</td><td>' + x.L + '</td><td>' + x.GF + '–' + x.GA + '</td><td>' + pctS(x.W, x.P) + '</td></tr>';
        }).join('') + '</tbody></table></div></section>';
    }
    return h;
  }

  /* ---------- team patterns (Stats tab) ---------- */
  /* seasonArc: points per game over the latest five games, game by game, against the season average */
  var ARC_SPAN = 5;
  function seasonArc(ms) {
    if (ms.length < 3) return '';
    var W = 720, H = 200, L = 34, R = 14, T = 14, B = 28;
    var pts = ms.map(function (m, i) { return { m: m, v: pointsPerGame(tally(ms.slice(Math.max(0, i - ARC_SPAN + 1), i + 1))) }; });
    var X = function (i) { return L + i * (W - L - R) / (ms.length - 1); }, Y = function (v) { return T + (3 - v) * (H - T - B) / 3; };
    var season = pointsPerGame(tally(ms));
    var s = '<svg class="chart arc" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Points per game over the latest ' + ARC_SPAN + ' games, game by game. Season average ' + f2(season) + '">';
    for (var g = 0; g <= 3; g++) s += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(g) + '" y2="' + Y(g) + '"/><text class="axis" x="' + (L - 8) + '" y="' + (Y(g) + 4) + '" text-anchor="end">' + g + '</text>';
    s += '<line class="avg" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(season) + '" y2="' + Y(season) + '"/>';
    s += '<polyline class="ln" points="' + pts.map(function (p, i) { return X(i).toFixed(1) + ',' + Y(p.v).toFixed(1); }).join(' ') + '"/>';
    var col = { W: 'var(--win)', D: 'var(--draw)', L: 'var(--loss)' };
    pts.forEach(function (p, i) {
      var title = p.m.result + ' ' + p.m.us.goals + '–' + p.m.them.goals + ' v ' + p.m.them.name;
      var sub = fmtDayShort(p.m.day) + ' · last ' + Math.min(ARC_SPAN, i + 1) + ': ' + f2(p.v) + ' pts/game';
      s += '<a href="' + matchHref(p.m) + '"><circle class="tip-node" data-tip-title="' + esc(title) + '" data-tip-sub="' + esc(sub) + '" style="fill:' + col[p.m.result] + '" cx="' + X(i).toFixed(1) + '" cy="' + Y(p.v).toFixed(1) + '" r="6"></circle></a>';
    });
    s += '<text class="axis" x="' + L + '" y="' + (H - 8) + '">' + esc(fmtDayShort(ms[0].day)) + '</text>';
    s += '<text class="axis" x="' + (W - R) + '" y="' + (H - 8) + '" text-anchor="end">' + esc(fmtDayShort(ms[ms.length - 1].day)) + '</text>';
    s += '<text class="avgl" x="' + (W / 2) + '" y="' + (H - 8) + '" text-anchor="middle">Season ' + f2(season) + ' pts/game</text>';
    var recent = pts[pts.length - 1].v, d = recent - season;
    return '<section class="card"><div class="card-h"><h2>Season arc</h2><span class="muted small">points per game, last ' + ARC_SPAN + ' · now ' + f2(recent) +
      (Math.abs(d) >= 0.05 ? ' (' + signed(d, 2) + ' on the season)' : '') + '</span></div><div class="card-b">' + s + '</svg></div></section>';
  }

  function recRow(label, sub, ms) {
    var x = tally(ms);
    return '<tr><td class="name">' + label + (sub ? '<small>' + sub + '</small>' : '') + '</td><td>' + x.P + '</td><td>' + x.W + '</td><td>' + x.D + '</td><td>' + x.L + '</td><td>' + x.GF + '–' + x.GA + '</td><td>' + pctS(x.W, x.P) + '</td></tr>';
  }
  var REC_HEAD = '<th>P</th><th>W</th><th>D</th><th>L</th><th>GF–GA</th><th>Win %</th>';

  /* gameOfNight: results by where the game fell in the night's session (a night runs to 5 AM) */
  var NIGHT_SLOTS = [['1st game', '', 1, 1], ['2nd – 3rd', '', 2, 3], ['4th – 5th', '', 4, 5], ['6th and later', '', 6, 999]];
  function gameOfNightHtml(ms) {
    var count = dict(), order = ms.map(function (m) { count[m.day] = (count[m.day] || 0) + 1; return count[m.day]; });
    var rows = NIGHT_SLOTS.map(function (s) { return { s: s, ms: ms.filter(function (m, i) { return order[i] >= s[2] && order[i] <= s[3]; }) }; })
      .filter(function (r) { return r.ms.length; });
    return '<section class="card"><div class="card-h"><h2>Game of the night</h2><span class="muted small">' + games(Object.keys(count).length).replace('game', 'night') + '</span></div><div class="tw"><table><thead><tr><th>Game</th>' + REC_HEAD + '</tr></thead><tbody>' +
      rows.map(function (r) { return recRow(r.s[0], '', r.ms); }).join('') + '</tbody></table></div></section>';
  }

  /* numbersHtml: results by how many of us were real players, and against how many of them */
  function numbersHtml(ms) {
    var sizes = dict();
    ms.forEach(function (m) { var n = m.stats.us.humans; (sizes[n] = sizes[n] || []).push(m); });
    var keys = Object.keys(sizes).map(Number).filter(function (n) { return n > 0; }).sort(function (a, b) { return a - b; });
    if (!keys.length) return '';
    return '<section class="card"><div class="card-h"><h2>Numbers on the pitch</h2><span class="muted small">real players on our side</span></div><div class="tw"><table><thead><tr><th>Players</th>' + REC_HEAD + '</tr></thead><tbody>' +
      keys.map(function (n) { return recRow(n + (n === 1 ? ' player' : ' players'), '', sizes[n]); }).join('') + '</tbody></table></div></section>';
  }

  /* splitsHtml: the club's record in different kinds of game */
  function splitsHtml(ms) {
    var rows = [
      ['Scoring 3 or more', function (m) { return m.us.goals >= 3; }],
      ['Conceding 2 or more', function (m) { return m.them.goals >= 2; }],
      ['Close games', function (m) { return isClose(m); }, 'a draw or decided by one goal'],
      ['Higher team rating than them', function (m) { return m.stats.us.avgRating > 0 && m.stats.us.avgRating > m.stats.them.avgRating; }],
      ['Out-shooting them', function (m) { return triesOf(m.players.us) > triesOf(m.players.them); }],
      ['Completing more passes', function (m) { return m.stats.us.passesMade > m.stats.them.passesMade; }],
      ['More players than them', function (m) { return m.stats.us.humans > m.stats.them.humans; }, 'real players'],
      ['Fewer players than them', function (m) { return m.stats.us.humans < m.stats.them.humans; }, 'real players']
    ].map(function (r) { return { label: r[0], sub: r[2] || '', ms: ms.filter(r[1]) }; }).filter(function (r) { return r.ms.length; });
    return '<section class="card"><div class="card-h"><h2>When…</h2><span class="muted small">record in each kind of game</span></div><div class="tw"><table><thead><tr><th>Game</th>' + REC_HEAD + '</tr></thead><tbody>' +
      rows.map(function (r) { return recRow(r.label, r.sub, r.ms); }).join('') + '</tbody></table></div></section>';
  }

  /* nightsHtml: every night we played, newest first, with that night's top-rated player */
  function nightsHtml(ms) {
    var days = dict();
    ms.forEach(function (m) { (days[m.day] = days[m.day] || []).push(m); });
    var keys = Object.keys(days).sort().reverse();
    return '<section class="card"><div class="card-h"><h2>Nights</h2><span class="muted small">best average rating that night</span></div><div class="tw scroll-y"><table><thead><tr><th>Night</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF–GA</th><th>Star of the night</th></tr></thead><tbody>' +
      keys.map(function (k) {
        var list = days[k], x = tally(list), per = dict(), star = null;
        list.forEach(function (m) {
          m.players.us.forEach(function (p) {
            if (!(p.rating > 0)) return;
            var e = per[p.id] || (per[p.id] = { id: p.id, name: p.name, s: 0, n: 0 });
            e.s += p.rating; e.n++;
          });
        });
        var need = Math.ceil(list.length / 2);
        Object.keys(per).forEach(function (id) { var e = per[id]; if (e.n >= need && (!star || e.s / e.n > star.s / star.n)) star = e; });
        var d = dateOfKey(k);
        return '<tr><td class="name"><a href="#day-' + k + '">' + WD[d.getDay()] + ' ' + esc(fmtDayShort(k)) + '</a></td><td>' + x.P + '</td><td>' + x.W + '</td><td>' + x.D + '</td><td>' + x.L + '</td><td>' + x.GF + '–' + x.GA + '</td><td>' +
          (star ? '<a class="star" href="' + playerHref(star.id) + '">' + esc(star.name) + '</a> ' + rt(star.s / star.n) : '–') + '</td></tr>';
      }).join('') + '</tbody></table></div></section>';
  }

  function teamPatternsHtml(ms) {
    return seasonArc(ms) +
      '<div class="grid2">' + gameOfNightHtml(ms) + numbersHtml(ms) + '</div>' +
      splitsHtml(ms) + nightsHtml(ms);
  }

  var P90_COLS = [
    { k: 'mins',    label: 'Min',     v: function (a) { return mins(a.seconds); } },
    { k: 'g90',     label: 'G /90',   v: function (a) { return per90(a.goals, a.seconds) || 0; } },
    { k: 'a90',     label: 'A /90',   v: function (a) { return per90(a.assists, a.seconds) || 0; } },
    { k: 'sh90',    label: 'Shots /90',v: function (a) { return per90(a.tries, a.seconds) || 0; } },
    { k: 'conv',    label: 'Conv %',  v: function (a) { return pct(a.goals, a.tries) || 0; } },
    { k: 'passpc',  label: 'Pass %',  v: function (a) { return pct(a.passesMade, a.passAttempts) || 0; } },
    { k: 'tack90',  label: 'Tackles /90', v: function (a) { return per90(a.tacklesMade, a.seconds) || 0; } },
    { k: 'rating',  label: 'Rating',  v: function (a) { return avgRating(a) || 0; } }
  ];
  function squadPer90() {
    var sk = ui.per90Sort.k, sd = ui.per90Sort.dir;
    var col = P90_COLS.filter(function (c) { return c.k === sk; })[0] || P90_COLS[0];
    var rows = idx.players.filter(function (a) { return a.apps > 0; }).sort(function (x, y) { return (col.v(y) - col.v(x)) * sd; });
    if (!rows.length) return '';
    function th(c) {
      var on = c.k === sk;
      return '<th><button data-act="per90-sort" data-k="' + c.k + '" class="' + (on ? 'on' : '') + '">' + c.label + (on ? (sd < 0 ? ' ↓' : ' ↑') : '') + '</button></th>';
    }
    return '<section class="card"><div class="card-h"><h2>Squad per 90</h2></div><div class="tw"><table><thead><tr><th>Player</th>' + P90_COLS.map(th).join('') + '</tr></thead><tbody>' +
      rows.map(function (a) {
        return '<tr><td class="name"><a href="' + playerHref(a.id) + '">' + esc(a.name) + '</a><small>' + games(a.apps) + '</small></td><td>' + mins(a.seconds) + '</td><td>' + f2(per90(a.goals, a.seconds)) + '</td><td>' + f2(per90(a.assists, a.seconds)) + '</td><td>' + f1(per90(a.tries, a.seconds)) + '</td><td>' + pctS(a.goals, a.tries) + '</td><td>' + pctS(a.passesMade, a.passAttempts) + '</td><td>' + f1(per90(a.tacklesMade, a.seconds)) + '</td><td>' + rt(avgRating(a) || 0) + '</td></tr>';
      }).join('') + '</tbody></table></div></section>';
  }

  function opponentsTableHtml(ms) {
    var q = ui.oppQuery.trim().toLowerCase();
    var opp = dict();
    ms.forEach(function (m) { var e = opp[m.them.id] || (opp[m.them.id] = { name: m.them.name, ms: [], last: 0 }); e.name = m.them.name; e.side = m.them; e.ms.push(m); e.last = m.ts; });
    var ol = Object.keys(opp).map(function (k) { return opp[k]; }).filter(function (e) {
      return !q || e.name.toLowerCase().indexOf(q) >= 0;
    }).sort(function (a, b) { return b.ms.length - a.ms.length || b.last - a.last; });
    if (!ol.length) return '<div class="card-b muted">No matching opponents.</div>';
    return '<table><thead><tr><th>Club</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>Last met</th></tr></thead><tbody>' +
      ol.map(function (e) {
        var x = tally(e.ms), lastM = e.ms[e.ms.length - 1];
        return '<tr><td class="name"><a class="who" href="' + matchHref(lastM) + '">' + crest(e.side, 24) + '<span>' + esc(e.name) + '</span></a></td><td>' + x.P + '</td><td>' + x.W + '</td><td>' + x.D + '</td><td>' + x.L + '</td><td>' + x.GF + '</td><td>' + x.GA + '</td><td>' + esc(fmtDayShort(lastM.day)) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function viewStats() {
    var ms = idx.matches, t = tally(ms), o = db.club.overall;
    var h = '<h1>Club stats</h1>';
    if (!ms.length && !o) { view.innerHTML = h + emptyState(); return; }
    if (ms.length) {
      var teamAvg = mean(ms.map(function (m) { return m.stats.us.avgRating; }).filter(function (v) { return v > 0; }));
      var playerGoals = 0, playerAssists = 0;
      ms.forEach(function (m) {
        m.players.us.forEach(function (p) { playerGoals += p.goals; playerAssists += p.assists; });
      });
      h += '<section class="card"><div class="card-h"><h2>Tracked</h2><span class="muted small">' + esc(fmtDayShort(ms[0].day)) + ' – ' + esc(fmtDayShort(ms[ms.length - 1].day)) + '</span></div>' +
        tiles([['Played', t.P], ['Record', t.W + '-' + t.D + '-' + t.L], ['Win rate', pctS(t.W, t.P)], ['Goals', playerGoals], ['Assists', playerAssists], ['Goals / game', f2(t.GF / t.P)], ['Conceded / game', f2(t.GA / t.P)], ['Team rating', f2(teamAvg)]]) +
        '<div class="card-b"><div class="formrow"><span class="muted small">Form</span>' + ms.slice(-10).reverse().map(function (m) {
          return '<a href="' + matchHref(m) + '" title="' + m.us.goals + '–' + m.them.goals + ' v ' + esc(m.them.name) + '">' + resChip(m.result) + '</a>';
        }).join('') + '</div></div></section>';
      h += teamPatternsHtml(ms);
      h += teamSections(ms);
    }
    if (o) {
      h += '<section class="card"><div class="card-h"><h2>All-time</h2></div>' +
        tiles([['Played', o.gamesPlayed], ['Record', o.wins + '-' + o.draws + '-' + o.losses], ['Win rate', pctS(o.wins, o.gamesPlayed)], ['Goals for', o.goals], ['Goals against', o.goalsAgainst], ['Skill rating', o.skillRating], ['Promotions', o.promotions], ['Relegations', o.relegations], ['Goals / game', o.gamesPlayed ? (o.goals / o.gamesPlayed).toFixed(2) : '—'], ['League games', o.leagueApps], ['Playoff games', o.playoffApps], ['Goal difference', (o.goals - o.goalsAgainst >= 0 ? '+' : '') + (o.goals - o.goalsAgainst)]]) + '</section>';
    }
    if (ms.length) {
      var bigW = null, bigL = null, hi = null, perf = null;
      ms.forEach(function (m) {
        var d = m.us.goals - m.them.goals;
        if (m.result === 'W' && (!bigW || d > bigW.us.goals - bigW.them.goals)) bigW = m;
        if (m.result === 'L' && (!bigL || d < bigL.us.goals - bigL.them.goals)) bigL = m;
        if (!hi || m.us.goals + m.them.goals > hi.us.goals + hi.them.goals) hi = m;
        m.players.us.forEach(function (p) { if (p.rating > 0 && (!perf || p.rating > perf.p.rating)) perf = { p: p, m: m }; });
      });
      var ml = function (m) { return m ? '<a href="' + matchHref(m) + '" style="color:var(--accent)">' + m.us.goals + '–' + m.them.goals + ' v ' + esc(m.them.name) + '</a>' + (m.dnf ? ' (DNF)' : '') : '–'; };
      h += kvCard('Records', [['Biggest win', ml(bigW)], ['Heaviest defeat', ml(bigL)], ['Most goals in a game', ml(hi)],
        ['Best individual rating', perf ? '<a href="' + matchHref(perf.m) + '" style="color:var(--accent)">' + esc(perf.p.name) + ' ' + perf.p.rating.toFixed(1) + ' v ' + esc(perf.m.them.name) + '</a>' : '–']]);

      h += '<section class="card"><div class="card-h"><h2>By competition</h2></div><div class="tw"><table><thead><tr><th>Competition</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>Win %</th></tr></thead><tbody>' +
        ['league', 'playoff', 'friendly'].map(function (ty) {
          var x = tally(ms.filter(function (m) { return m.type === ty; }));
          return '<tr><td class="name">' + TYPE_LABEL[ty] + '</td><td>' + x.P + '</td><td>' + x.W + '</td><td>' + x.D + '</td><td>' + x.L + '</td><td>' + x.GF + '</td><td>' + x.GA + '</td><td>' + pctS(x.W, x.P) + '</td></tr>';
        }).join('') + '</tbody></table></div></section>';

      h += '<section class="card"><div class="card-h"><h2>Opponents</h2>' +
        '<input class="search-in" type="search" data-filter="opp" placeholder="Filter clubs…" value="' + esc(ui.oppQuery) + '" aria-label="Filter opponents"></div>' +
        '<div id="opp-wrap" class="tw scroll-y">' + opponentsTableHtml(ms) + '</div></section>';
    }
    view.innerHTML = h;
  }

  /* ---------- routing & render ---------- */
  function setNav(name) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-nav]'), function (a) {
      var on = a.getAttribute('data-nav') === name;
      a.classList.toggle('on', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  /* Re-sorting or filtering redraws the page. On a phone the wide tables are scrolled sideways,
     so remember where each table was scrolled and put it back, instead of jumping to the left. */
  function tableScroll() {
    return Array.prototype.map.call(view.querySelectorAll('.tw'), function (el) { return [el.scrollLeft, el.scrollTop]; });
  }
  function restoreTableScroll(saved) {
    if (!saved) return;
    var els = view.querySelectorAll('.tw');
    saved.forEach(function (p, i) { if (els[i]) { els[i].scrollLeft = p[0]; els[i].scrollTop = p[1]; } });
  }

  var lastRoute = null;
  function render() {
    hideTip();
    var hash = (location.hash || '').replace(/^#/, '');
    var saved = hash === lastRoute ? tableScroll() : null;
    route(hash);
    restoreTableScroll(saved);
  }
  function route(hash) {
    var m;
    var routeChanged = hash !== lastRoute;
    if (routeChanged) {
      if (lastRoute !== null) window.scrollTo(0, 0);
      if (hash.indexOf('match-') === 0 && (lastRoute || '').indexOf('match-') !== 0) ui.tab = 'facts';
      if (hash.indexOf('day-') === 0) ui.calMonth = null;
      /* #compare starts empty; #compare-<player> (from a player page) starts with that player picked */
      if (hash === 'compare') ui.cmpSel = [];
      else if ((m = /^compare-([A-Za-z0-9]+)$/.exec(hash)) && idx.bySlug[m[1]] && idx.bySlug[m[1]].apps) ui.cmpSel = [idx.bySlug[m[1]].id];
      lastRoute = hash;
    }
    view.classList.toggle('anim', routeChanged);
    if (/^compare(-[A-Za-z0-9]+)?$/.test(hash)) { setNav('squad'); ui.squadMode = 'compare'; return viewSquad(); }
    if (hash === 'squad') { setNav('squad'); return viewSquad(); }
    if (hash === 'insights') { setNav('insights'); return viewInsights(); }
    if (hash === 'stats') { setNav('stats'); return viewStats(); }
    if ((m = /^match-([A-Za-z0-9]+)$/.exec(hash)) && idx.byId[m[1]]) { setNav('matches'); return viewMatch(idx.byId[m[1]]); }
    if ((m = /^player-([A-Za-z0-9]+)$/.exec(hash)) && idx.bySlug[m[1]]) { setNav('squad'); return viewPlayer(idx.bySlug[m[1]]); }
    setNav('matches');
    m = /^day-(\d{4}-\d{2}-\d{2})$/.exec(hash);
    viewDay(m && validKey(m[1]) ? m[1] : null);
  }

  /* ---------- tooltip (hover on chart dots / radar labels) ---------- */
  function showTip(node, clientX, clientY) {
    if (!chartTip) return;
    var t = node.getAttribute('data-tip-title') || '';
    var s = node.getAttribute('data-tip-sub') || '';
    chartTip.innerHTML = (t ? '<b>' + esc(t) + '</b>' : '') + (s ? '<span>' + esc(s) + '</span>' : '');
    chartTip.hidden = false;
    var rect = chartTip.getBoundingClientRect();
    var x = Math.max(rect.width / 2 + 8, Math.min(window.innerWidth - rect.width / 2 - 8, clientX));
    var y = Math.max(rect.height + 16, clientY);
    chartTip.style.left = x + 'px';
    chartTip.style.top = y + 'px';
  }
  function hideTip() {
    if (chartTip) chartTip.hidden = true;
  }
  document.addEventListener('pointerover', function (e) {
    var node = e.target.closest ? e.target.closest('.tip-node') : null;
    if (node) showTip(node, e.clientX, e.clientY);
  });
  document.addEventListener('pointermove', function (e) {
    if (chartTip && !chartTip.hidden) {
      var node = e.target.closest ? e.target.closest('.tip-node') : null;
      if (node) showTip(node, e.clientX, e.clientY);
      else hideTip();
    }
  });
  document.addEventListener('pointerout', function (e) {
    if (e.target.closest && e.target.closest('.tip-node')) hideTip();
  });

  /* ---------- live filter inputs (squad search, opponents search) ---------- */
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (!el || !el.getAttribute) return;
    var f = el.getAttribute('data-filter');
    if (f === 'squad') {
      ui.squadQuery = el.value;
      var sc = document.getElementById('squad-card'), keep = tableScroll();
      if (sc) { sc.innerHTML = squadTableHtml(); restoreTableScroll(keep); }
    } else if (f === 'opp') {
      ui.oppQuery = el.value;
      var ow = document.getElementById('opp-wrap');
      if (ow) ow.innerHTML = opponentsTableHtml(idx.matches);
    }
  });

  /* ---------- keyboard shortcuts (arrow keys navigate between matches / days) ---------- */
  document.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    var hash = (location.hash || '').replace(/^#/, '');
    var m;
    if ((m = /^match-([A-Za-z0-9]+)$/.exec(hash)) && idx.byId[m[1]]) {
      var i = idx.matches.indexOf(idx.byId[m[1]]);
      var target = idx.matches[i + (e.key === 'ArrowRight' ? 1 : -1)];
      if (target) location.hash = matchHref(target);
    } else if (!hash || hash === 'matches' || /^day-(\d{4}-\d{2}-\d{2})$/.test(hash)) {
      var dm = /^day-(\d{4}-\d{2}-\d{2})$/.exec(hash);
      var cur = dm && validKey(dm[1]) ? dm[1] : (idx.days.length ? idx.days[idx.days.length - 1] : todayKey());
      location.hash = '#day-' + addDays(cur, e.key === 'ArrowRight' ? 1 : -1);
    }
  });

  /* ---------- click actions (data-act dispatch) ---------- */
  document.addEventListener('click', function (e) {
    var tipNode = e.target.closest ? e.target.closest('.tip-node') : null;
    if (tipNode && tipNode.tagName === 'text') {
      showTip(tipNode, e.clientX, e.clientY);
      return;
    }
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    var act = el.getAttribute('data-act');
    if (act === 'cal-toggle') ui.calOpen = !ui.calOpen;
    else if (act === 'cal-prev' || act === 'cal-next') {
      var p = ui.calMonth.split('-'), d = new Date(+p[0], +p[1] - 1 + (act === 'cal-next' ? 1 : -1), 1);
      ui.calMonth = d.getFullYear() + '-' + pad(d.getMonth() + 1);
    }
    else if (act === 'tab') ui.tab = el.getAttribute('data-tab');
    else if (act === 'cmp-toggle') {
      var cid = el.getAttribute('data-id'), ids = cmpSelected().map(function (a) { return a.id; }), at = ids.indexOf(cid);
      if (at >= 0) ids.splice(at, 1); else ids.push(cid);
      ui.cmpSel = ids;
    }
    else if (act === 'squad-mode') {
      ui.squadMode = el.getAttribute('data-mode');
      var sy1 = window.scrollY || window.pageYOffset;
      render();
      window.scrollTo(0, sy1);
      return;
    }
    else if (act === 'squad-pos') {
      ui.squadPos = el.getAttribute('data-pos');
      var sy2 = window.scrollY || window.pageYOffset;
      render();
      window.scrollTo(0, sy2);
      return;
    }
    else if (act === 'sort') { var k = el.getAttribute('data-k'); if (ui.sortK === k) ui.sortDir = -ui.sortDir; else { ui.sortK = k; ui.sortDir = -1; } }
    else if (act === 'match-sort') { var mk = el.getAttribute('data-k'); if (ui.matchSort.k === mk) ui.matchSort.dir = -ui.matchSort.dir; else { ui.matchSort.k = mk; ui.matchSort.dir = -1; } }
    else if (act === 'ins-sort') { var ik = el.getAttribute('data-k'); if (ui.insSort.k === ik) ui.insSort.dir = -ui.insSort.dir; else { ui.insSort.k = ik; ui.insSort.dir = ik === 'steady' ? 1 : -1; } }
    else if (act === 'per90-sort') { var pk = el.getAttribute('data-k'); if (ui.per90Sort.k === pk) ui.per90Sort.dir = -ui.per90Sort.dir; else { ui.per90Sort.k = pk; ui.per90Sort.dir = -1; } }
    else if (act === 'share-match') {
      var url = el.getAttribute('data-url');
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function () {
          el.innerHTML = '<span>Copied! ✓</span>';
          setTimeout(function () { el.innerHTML = ICON_SHARE + '<span>Share</span>'; }, 2000);
        });
      } else {
        window.prompt('Copy this link:', url);
      }
      return;
    }
    render();
  });

  /* ---------- dark mode toggle ---------- */
  var themeBtn = document.getElementById('themeToggle');
  function applyTheme(dark) {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    if (themeBtn) themeBtn.setAttribute('aria-checked', dark ? 'true' : 'false');
  }
  /* Storage can be blocked (private windows, strict browser settings); the page must still load */
  function readTheme() { try { return localStorage.getItem('eatmob-theme'); } catch (e) { return null; } }
  function saveTheme(v) { try { localStorage.setItem('eatmob-theme', v); } catch (e) { /* not saved; the toggle still works for this visit */ } }
  var savedTheme = readTheme();
  var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(savedTheme ? savedTheme === 'dark' : prefersDark);
  if (themeBtn) themeBtn.addEventListener('click', function () {
    var dark = document.documentElement.getAttribute('data-theme') !== 'dark';
    applyTheme(dark);
    saveTheme(dark ? 'dark' : 'light');
  });

  window.addEventListener('hashchange', render);
  if (compactMq && compactMq.addEventListener) compactMq.addEventListener('change', function () { if (/^compare/.test((location.hash || '').replace(/^#/, ''))) render(); });
  /* Image load failures ('error' does not bubble, so listen in the capture phase):
     a missing crest falls back to the club's initials, a missing avatar to the built-in silhouette. */
  document.addEventListener('error', function (e) {
    var t = e.target;
    if (!t || t.tagName !== 'IMG') return;
    if (t.classList.contains('p-img')) { if (t.getAttribute('src') !== PLAYER_AVATAR_FALLBACK) t.src = PLAYER_AVATAR_FALLBACK; }
    else if (t.parentNode && t.parentNode.classList && t.parentNode.classList.contains('cr')) t.parentNode.classList.add('bad');
  }, true);

  db = loadDb();
  idx = buildIndex();
  render();
})();