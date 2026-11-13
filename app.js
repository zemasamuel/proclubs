/* eatmob: renders every view from window.EATMOB_DB (data/db.js). */
(function () {
  'use strict';

  var N = window.EatmobNormalize;
  var TIME_ZONE = 'America/Chicago';
  var CREST_BASE = 'crests/';
  var DAY_STARTS_AT_HOUR = 5;      // games ending before 5 AM count for the previous day
  var MATCH_SECONDS = 5400;        // game-clock seconds in 90 minutes
  var SUB_MARGIN = 60;             // played this many seconds less than the longest-serving player = sub
  var LS_KEY = 'eatmob-import-v1';
  var TYPE_LABEL = { league: 'League', playoff: 'Playoffs', friendly: 'Friendlies' };
  var POS_LABEL = { GK: 'Goalkeeper', DEF: 'Defender', MID: 'Midfielder', FWD: 'Forward', 'N/A': 'Unknown' };
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  var view = document.getElementById('view');
  var memoryImport = null;
  var ui = { calOpen: false, calMonth: null, tab: 'facts', squadMode: 'tracked', sortK: 'rating', sortDir: -1, importMsg: null, importDraft: '', cmp: { tpl: 'fwd', sel: null } };
  var MAX_COMPARE = 4;
  var db, idx;

  /* ---------- helpers ---------- */
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
  function fmtStamp(iso) { var d = new Date(iso); return isNaN(d) ? 'unknown' : d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: TIME_ZONE }) + ' CT'; }

  function f1(v) { return v === null || v === undefined || !isFinite(v) ? '–' : v.toFixed(1); }
  function f2(v) { return v === null || v === undefined || !isFinite(v) ? '–' : v.toFixed(2); }
  function pct(a, b) { return b > 0 ? a / b * 100 : null; }
  function pctS(a, b) { var v = pct(a, b); return v === null ? '–' : Math.round(v) + '%'; }
  function per90(v, sec) { return sec > 0 ? v * MATCH_SECONDS / sec : null; }
  function mins(sec) { return Math.round(sec / 60); }
  function games(n) { return n + (n === 1 ? ' game' : ' games'); }

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
  function rt(r, big, motm) {
    var cls = 'rt' + (big ? ' big' : '');
    if (!(r > 0)) return '<span class="' + cls + ' none">–</span>';
    return '<span class="' + cls + '" style="background:' + rtColor(r, motm) + '"' + (motm ? ' title="Player of the match"' : '') + '>' + r.toFixed(1) + (motm ? ICON_STAR : '') + '</span>';
  }

  function svg(cls, body) { return '<svg class="' + cls + '" viewBox="0 0 24 24" aria-hidden="true">' + body + '</svg>'; }
  var ICON_STAR = svg('i-star', '<path d="M12 1.8l3.1 6.6 7.2.9-5.3 5 1.4 7.1L12 17.9l-6.4 3.5 1.4-7.1-5.3-5 7.2-.9z"/>');
  var ICON_BALL = svg('i-ball', (function () {
    var out = '<circle cx="12" cy="12" r="10.6" fill="#fff" stroke="#141a18" stroke-width="1.4"/>', pent = [], k, a;
    function at(r, deg) { var t = deg * Math.PI / 180; return (12 + r * Math.sin(t)).toFixed(1) + ',' + (12 - r * Math.cos(t)).toFixed(1); }
    for (k = 0; k < 5; k++) {
      a = k * 72;
      pent.push(at(4.4, a));
      out += '<path d="M' + at(4.4, a) + 'L' + at(7.4, a) + '" stroke="#141a18" stroke-width="1.2"/><path d="M' + at(7.2, a) + 'L' + at(10.4, a - 20) + 'L' + at(10.4, a + 20) + 'z" fill="#141a18"/>';
    }
    return out + '<path d="M' + pent.join('L') + 'z" fill="#141a18"/>';
  })());
  var ICON_BOOT = svg('i-boot', '<path d="M3.5 5.5h5.2l.9 4.1c.2 1 .9 1.8 1.9 2.1l5.9 1.9c1.9.6 3.1 2.1 3.1 3.9v.5h-17z"/><path d="M5 19.3h2.2v2H5zM10.2 19.3h2.2v2h-2.2zM15.4 19.3h2.2v2h-2.2z"/>');
  var ICON_SUB = svg('i-sub', '<circle cx="12" cy="12" r="9" fill="#1ea55b"/><path d="M12 16V9M12 9l-3 3M12 9l3 3" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>');
  function initials(name) { var s = String(name).replace(/[^A-Za-z0-9]/g, ''); return esc((s.slice(0, 2) || '?').toUpperCase()); }
  function resChip(r) { return '<span class="res ' + r + '" title="' + ({ W: 'Win', D: 'Draw', L: 'Loss' }[r]) + '">' + r + '</span>'; }
  function times(n) { return n > 1 ? ' ×' + n : ''; }
  function ordinal(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function mean(a) { return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : null; }
  function stdev(a) { if (a.length < 2) return null; var m = mean(a); return Math.sqrt(mean(a.map(function (v) { return (v - m) * (v - m); }))); }
  function crest(side, size) {
    var id = side && /^\d+$/.test(side.crest || '') ? side.crest : '';
    var img = id ? '<img src="' + CREST_BASE + id + '.png" alt="" loading="lazy" decoding="async" onerror="this.parentNode.classList.add(\'bad\')">' : '';
    return '<span class="cr s' + size + (id ? '' : ' bad') + '" aria-hidden="true">' + img +
      '<span class="fb">' + initials(side && side.name || '?') + '</span></span>';
  }

  /* ---------- data ---------- */
  function readImport() {
    if (memoryImport) return memoryImport;
    try { var v = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); if (v && Array.isArray(v.matches)) return v; } catch (e) { /* storage unavailable */ }
    return null;
  }
  function writeImport(v) {
    memoryImport = v;
    try { if (v) localStorage.setItem(LS_KEY, JSON.stringify(v)); else localStorage.removeItem(LS_KEY); } catch (e) { /* kept in memory only */ }
  }
  function loadDb() {
    var base = window.EATMOB_DB || { club: { id: '', name: 'Eaters' }, members: {}, matches: [] };
    var imp = readImport();
    var out = { club: base.club || { name: 'Eaters' }, members: base.members || {}, updatedAt: base.updatedAt, sample: !!base.sample, imported: 0, matches: base.matches || [] };
    if (imp && imp.matches.length) {
      out.matches = N.mergeMatches(base.sample ? [] : out.matches, imp.matches);
      out.imported = imp.matches.length;
      out.sample = false;
    }
    return out;
  }

  function newAgg(id, name) {
    return { id: id, name: name || '', apps: 0, goals: 0, assists: 0, shots: 0, passesMade: 0, passAttempts: 0, tacklesMade: 0, tackleAttempts: 0,
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

  function buildIndex() {
    var matches = db.matches.slice().sort(function (a, b) { return a.ts - b.ts; });
    var byDay = {}, byId = {}, players = {};
    matches.forEach(function (m) {
      m.day = dayKeyOf(m.ts);
      m.full = m.players.us.concat(m.players.them).reduce(function (mx, p) { return Math.max(mx, p.secondsPlayed || 0); }, 0);
      (byDay[m.day] = byDay[m.day] || []).push(m);
      byId[slug(m.id)] = m;
      m.players.us.forEach(function (p) {
        var a = players[p.id] || (players[p.id] = newAgg(p.id, p.name));
        a.name = p.name;
        a.apps++; a.goals += p.goals; a.assists += p.assists; a.shots += p.shots;
        a.passesMade += p.passesMade; a.passAttempts += p.passAttempts;
        a.tacklesMade += p.tacklesMade; a.tackleAttempts += p.tackleAttempts;
        a.saves += p.saves; a.redCards += p.redCards; a.goalsConceded += p.goalsConceded;
        a.seconds += p.secondsPlayed || 0;
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
    var seen = {};
    Object.keys(players).forEach(function (id) { seen[players[id].name] = true; });
    Object.keys(db.members).forEach(function (name) {
      if (!seen[name]) { var id = 'm' + slug(name); players[id] = newAgg(id, name); }
    });
    var list = Object.keys(players).map(function (id) { return players[id]; });
    var bySlug = {};
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
  function isSub(p, m) { return m.full > 0 && (p.secondsPlayed || 0) > 0 && (p.secondsPlayed || 0) < m.full - SUB_MARGIN; }
  function subOnMin(p, m) { return Math.round((m.full - (p.secondsPlayed || 0)) / 60); }
  function minsCell(p, m) {
    var n = mins(p.secondsPlayed || 0);
    if (isSub(p, m)) {
      var on = subOnMin(p, m);
      return '<span class="submin" title="Subbed on at ' + on + '\'' + '">' + ICON_SUB + n + '</span>';
    }
    return n;
  }
  function minApps() {
    var most = Math.max.apply(null, idx.players.map(function (a) { return a.apps; }));
    return Math.max(1, Math.ceil(most * 0.3));
  }
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
  function notices() { return db.sample ? '<div class="banner"><b>Sample data.</b> Real games appear after the first fetch.</div>' : ''; }
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

    var h = notices();
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
    var per = {};
    list.forEach(function (m) {
      m.players.us.forEach(function (p) {
        var a = per[p.id] || (per[p.id] = { id: p.id, name: p.name, n: 0, rs: 0, rn: 0, g: 0, as: 0 });
        a.n++; a.g += p.goals; a.as += p.assists; if (p.rating > 0) { a.rs += p.rating; a.rn++; }
      });
    });
    var arr = Object.keys(per).map(function (k) { return per[k]; });
    var need = Math.max(1, Math.ceil(list.length / 2));
    var rated = arr.filter(function (a) { return a.rn >= need; }).sort(function (a, b) { return b.rs / b.rn - a.rs / a.rn; });
    var scorers = arr.filter(function (a) { return a.g + a.as > 0; }).sort(function (a, b) { return b.g - a.g || b.as - a.as; });
    var h = '<div class="grid2">';
    h += '<section class="card"><div class="card-h"><h2>Best average rating</h2><span class="muted small">min ' + games(need) + '</span></div><div class="plist">' +
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
    var h = '<div class="row" style="justify-content:space-between"><a class="btn" href="#day-' + m.day + '">‹ ' + esc(fmtDayShort(m.day)) + '</a>' +
      '<div class="row"><a class="btn" ' + (prev ? 'href="' + matchHref(prev) + '"' : 'aria-disabled="true"') + '>‹ Previous</a><a class="btn" ' + (next ? 'href="' + matchHref(next) + '"' : 'aria-disabled="true"') + '>Next ›</a></div></div>';

    h += '<section class="card"><div class="mh"><div class="comp">' + TYPE_LABEL[m.type] + ' · ' + esc(fmtDayLong(zoneKey(m.ts))) + ' · ended ' + esc(fmtTime(m.ts)) + ' CT</div>' +
      '<div class="board"><div class="team">' + crest(m.us, 64) + '<span>' + esc(m.us.name) + '</span></div><div class="score">' + m.us.goals + ' – ' + m.them.goals + '</div><div class="team">' + crest(m.them, 64) + '<span>' + esc(m.them.name) + '</span></div></div>' +
      '<div class="row" style="justify-content:center">' + resChip(m.result) + '<span class="muted small">' + (m.dnf ? 'Ended early (DNF)' : 'Full time') + '</span></div>' +
      '<div class="scorers"><div>' + scorerList(m.players.us, m.us.goals) + '</div><div>' + scorerList(m.players.them, m.them.goals) + '</div></div></div>';
    var tabs = [['facts', 'Facts'], ['lineup', 'Lineup'], ['shots', 'Shots'], ['stats', 'Stats'], ['players', 'Player stats']];
    h += '<div class="tabs" role="tablist">' + tabs.map(function (t) {
      return '<button role="tab" data-act="tab" data-tab="' + t[0] + '" aria-selected="' + (ui.tab === t[0]) + '">' + t[1] + '</button>';
    }).join('') + '</div></section>';

    if (ui.tab === 'facts') h += matchFacts(m);
    else if (ui.tab === 'lineup') h += matchLineup(m);
    else if (ui.tab === 'shots') h += matchShots(m);
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
        '<div class="avatar">' + initials(motm.p.name) + '</div><div><div style="font-weight:700;font-size:17px">' +
        (motm.us ? '<a href="' + playerHref(motm.p.id) + '">' + esc(motm.p.name) + '</a>' : esc(motm.p.name)) + '</div>' +
        '<div class="muted small">' + esc(motm.us ? m.us.name : m.them.name) + ' · ' + POS_LABEL[motm.p.pos] + ' · ' + motm.p.goals + ' G · ' + motm.p.assists + ' A</div></div>' +
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
      '<dt>Finished</dt><dd>' + esc(new Date(m.ts * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: TIME_ZONE })) + ' CT</dd>' +
      '<dt>Players</dt><dd>' + m.stats.us.humans + ' v ' + m.stats.them.humans + '</dd>' +
      '<dt>Team rating</dt><dd>' + f2(m.stats.us.avgRating) + ' v ' + f2(m.stats.them.avgRating) + '</dd>' +
      '<dt>Match ID</dt><dd>' + esc(m.id) + '</dd></dl></div></section>';
    return h;
  }

  /* Lineup marker: rating top right, sub top left, goals bottom right, assists and red card bottom left. */
  function evIcons(icon, n, cls) {
    if (n > 4) return '<i class="e ' + cls + '">' + icon + '<b>' + n + '</b></i>';
    var out = '';
    while (n-- > 0) out += '<i class="e ' + cls + '">' + icon + '</i>';
    return out;
  }
  function pitchPlayer(p, m, us) {
    var left = (p.redCards ? '<i class="rc" title="Red card"></i>' : '') + evIcons(ICON_BOOT, p.assists, 'as');
    var inner = '<span class="av">' + initials(p.name) +
      (isSub(p, m) ? '<span class="sub" title="Subbed on at ' + subOnMin(p, m) + '\'">' + ICON_SUB + subOnMin(p, m) + '′</span>' : '') +
      rt(p.rating, false, p.motm) +
      (left ? '<span class="evs l"' + (p.assists ? ' title="' + p.assists + ' A"' : '') + '>' + left + '</span>' : '') +
      (p.goals ? '<span class="evs" title="' + p.goals + ' G">' + evIcons(ICON_BALL, p.goals, 'gl') + '</span>' : '') +
      '</span><span class="nm">' + esc(p.name) + '</span>';
    return us ? '<a class="pp" href="' + playerHref(p.id) + '">' + inner + '</a>' : '<div class="pp">' + inner + '</div>';
  }
  function pitchHalf(m, us) {
    var players = us ? m.players.us : m.players.them, order = us ? ['FWD', 'MID', 'DEF', 'GK'] : ['GK', 'DEF', 'MID', 'FWD'];
    return '<div class="half"><div class="side">' + esc((us ? m.us : m.them).name) + '</div>' + order.map(function (pos) {
      var ps = players.filter(function (p) { return p.pos === pos || (pos === 'MID' && p.pos === 'N/A'); });
      return ps.length ? '<div class="line">' + ps.map(function (p) { return pitchPlayer(p, m, us); }).join('') + '</div>' : '';
    }).join('') + '</div>';
  }
  function matchLineup(m) {
    return '<section class="card"><div class="pitch">' + pitchHalf(m, false) + pitchHalf(m, true) + '</div></section>';
  }

  // EA's shot count is sometimes below a player's goals, so a goal always counts as a shot.
  function tries(p) { return Math.max(p.shots, p.goals); }
  function triesOf(players) { return players.reduce(function (s, p) { return s + tries(p); }, 0); }
  function shotTeam(side, players, us, teamGoals) {
    var sh = players.filter(function (p) { return tries(p) > 0; })
      .sort(function (a, b) { return tries(b) - tries(a) || b.goals - a.goals || b.rating - a.rating; });
    var total = 0, goals = 0;
    players.forEach(function (p) { total += tries(p); goals += p.goals; });
    var other = Math.max(0, teamGoals - goals);
    var h = '<section class="card"><div class="card-h shot-h"><h2>' + crest(side, 24) + '<span>' + esc(side.name) + '</span></h2><span class="muted small">' +
      total + (total === 1 ? ' shot' : ' shots') + ' · ' + goals + (goals === 1 ? ' goal' : ' goals') + ' · ' + (total ? Math.round(goals / total * 100) + '% conversion' : 'no shots') + '</span></div>';
    if (!sh.length) return h + '<div class="card-b muted">No shots.</div></section>';
    h += '<div class="shots">' + sh.map(function (p) {
      var t = tries(p), miss = t - p.goals, dots = '', i;
      for (i = 0; i < p.goals; i++) dots += '<i class="sd goal"></i>';
      for (i = 0; i < miss; i++) dots += '<i class="sd"></i>';
      var nm = us ? '<a href="' + playerHref(p.id) + '">' + esc(p.name) + '</a>' : esc(p.name);
      return '<div class="srow"><span class="nm">' + nm + '<small>' + POS_LABEL[p.pos] + '</small></span><span class="dots2" role="img" aria-label="' + t + ' shots, ' + p.goals + ' goals">' + dots + '</span>' +
        '<span class="sv"><b>' + t + '</b> ' + (t === 1 ? 'shot' : 'shots') + (p.goals ? ' · <b>' + p.goals + '</b> G' : '') + '</span></div>';
    }).join('') + '</div>';
    if (other > 0) h += '<div class="card-b small muted">+' + other + ' from AI teammates, own goals or forfeit</div>';
    return h + '</section>';
  }
  function matchShots(m) {
    return '<section class="card"><div class="card-b">' + statBar('Shots', triesOf(m.players.us), triesOf(m.players.them)) +
      '<div class="legend small muted"><span><i class="sd goal"></i> goal</span><span><i class="sd"></i> no goal</span></div></div></section>' +
      shotTeam(m.us, m.players.us, true, m.us.goals) + shotTeam(m.them, m.players.them, false, m.them.goals);
  }

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

  function playerTable(m, us) {
    var players = us ? m.players.us : m.players.them;
    return '<div class="tw"><table><thead><tr><th>Player</th><th>Pos</th><th>Rating</th><th>Min</th><th>G</th><th>A</th><th>Shots</th><th>Passes</th><th>Pass %</th><th>Tackles</th><th>Saves</th><th title="Red cards">RC</th></tr></thead><tbody>' +
      players.map(function (p) {
        return '<tr><td class="name">' + (us ? '<a href="' + playerHref(p.id) + '">' + esc(p.name) + '</a>' : esc(p.name)) + '</td><td>' + p.pos + '</td><td>' + rt(p.rating, false, p.motm) + '</td><td>' + minsCell(p, m) + '</td><td>' + p.goals + '</td><td>' + p.assists + '</td><td>' + tries(p) + '</td><td>' + p.passesMade + '/' + p.passAttempts + '</td><td>' + pctS(p.passesMade, p.passAttempts) + '</td><td>' + p.tacklesMade + '/' + p.tackleAttempts + '</td><td>' + p.saves + '</td><td>' + p.redCards + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function matchPlayers(m) {
    return '<section class="card"><div class="card-h"><h2>' + esc(m.us.name) + '</h2></div>' + playerTable(m, true) + '</section>' +
      '<section class="card"><div class="card-h"><h2>' + esc(m.them.name) + '</h2></div>' + playerTable(m, false) + '</section>';
  }

  /* ---------- squad ---------- */
  function viewSquad() {
    var tracked = ui.squadMode === 'tracked';
    var cols = tracked
      ? [['apps', 'Apps'], ['mins', 'Min'], ['goals', 'G'], ['assists', 'A'], ['ga90', 'G+A /90'], ['pass', 'Pass %'], ['motm', 'MOTM'], ['rating', 'Rating']]
      : [['apps', 'Games'], ['win', 'Win %'], ['goals', 'G'], ['assists', 'A'], ['pass', 'Pass %'], ['motm', 'MOTM'], ['ovr', 'OVR'], ['rating', 'Rating']];
    if (!cols.some(function (c) { return c[0] === ui.sortK; })) { ui.sortK = 'rating'; ui.sortDir = -1; }
    var rows = idx.players.map(function (a) {
      var mem = db.members[a.name] || null, v;
      if (tracked) v = { apps: a.apps, mins: mins(a.seconds), goals: a.goals, assists: a.assists, ga90: per90(a.goals + a.assists, a.seconds), pass: pct(a.passesMade, a.passAttempts), motm: a.motm, rating: avgRating(a) };
      else v = mem ? { apps: mem.gamesPlayed, win: mem.gamesPlayed ? mem.winRate : null, goals: mem.goals, assists: mem.assists, pass: mem.gamesPlayed ? mem.passSuccessRate : null, motm: mem.motm, ovr: mem.overall || null, rating: mem.ratingAve || null } : null;
      return { a: a, mem: mem, v: v };
    }).filter(function (r) { return r.v; });
    rows.sort(function (x, y) {
      var a = x.v[ui.sortK], b = y.v[ui.sortK];
      var na = a === null || a === undefined, nb = b === null || b === undefined;
      if (na || nb) return na && nb ? x.a.name.localeCompare(y.a.name) : na ? 1 : -1;
      return (a - b) * ui.sortDir || x.a.name.localeCompare(y.a.name);
    });
    var fm = { ga90: f2, pass: function (v) { return v === null ? '–' : Math.round(v) + '%'; }, win: function (v) { return v === null ? '–' : v + '%'; }, rating: function (v) { return rt(v || 0); } };
    var h = notices() + '<div class="dayhead"><h1>Squad</h1><div class="seg" role="group" aria-label="Stats source">' +
      '<button data-act="squad-mode" data-mode="tracked" aria-pressed="' + tracked + '">Tracked</button>' +
      '<button data-act="squad-mode" data-mode="ea" aria-pressed="' + !tracked + '">All-time</button></div></div>';
    h += '<section class="card"><div class="tw"><table><thead><tr><th>Player</th><th>Pos</th>' + cols.map(function (c) {
      var on = ui.sortK === c[0];
      return '<th' + (on ? ' aria-sort="' + (ui.sortDir < 0 ? 'descending' : 'ascending') + '"' : '') + '><button data-act="sort" data-k="' + c[0] + '" class="' + (on ? 'on' : '') + '">' + c[1] + (on ? (ui.sortDir < 0 ? ' ↓' : ' ↑') : '') + '</button></th>';
    }).join('') + '</tr></thead><tbody>' + rows.map(function (r) {
      var pos = mainPos(r.a);
      return '<tr><td class="name"><a href="' + playerHref(r.a.id) + '">' + esc(r.a.name) + (r.mem && r.mem.proName ? '<small>' + esc(r.mem.proName) + '</small>' : '') + '</a></td><td>' + (pos || '–') + '</td>' +
        cols.map(function (c) { var val = r.v[c[0]]; return '<td>' + (fm[c[0]] ? fm[c[0]](val === undefined ? null : val) : (val === null ? '–' : val)) + '</td>'; }).join('') + '</tr>';
    }).join('') + '</tbody></table></div></section>';
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
      s += '<a href="' + matchHref(x.m) + '"><circle fill="' + rtColor(x.p.rating, x.p.motm) + '" cx="' + X(i).toFixed(1) + '" cy="' + Y(x.p.rating).toFixed(1) + '" r="6"><title>' + x.p.rating.toFixed(1) + ' v ' + esc(x.m.them.name) + ' (' + x.m.us.goals + '–' + x.m.them.goals + '), ' + esc(fmtDayShort(x.m.day)) + '</title></circle></a>';
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
    var need = minApps();
    var pool = idx.players.filter(function (p) { return p.apps > 0 && (p.apps >= need || p === a); });
    var metrics = [
      ['Avg rating', avgRating, f2],
      ['Goals /90', function (p) { return per90(p.goals, p.seconds); }, f2],
      ['Assists /90', function (p) { return per90(p.assists, p.seconds); }, f2],
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
    return '<section class="card"><div class="card-h"><h2>Squad rank</h2><span class="muted small">min ' + games(need) + '</span></div><div class="card-b">' + h + '</div></section>';
  }

  function viewPlayer(a) {
    var mem = db.members[a.name] || null, pos = mainPos(a), avg = avgRating(a);
    var h = '<div class="row" style="justify-content:space-between"><a class="btn" href="#squad">‹ Squad</a>' + (a.apps ? '<a class="btn" href="#compare-' + slug(a.id) + '">Compare players ›</a>' : '') + '</div>';
    h += '<section class="card"><div class="card-b phead"><div class="avatar">' + initials(a.name) + '</div><div><h1>' + esc(a.name) + '</h1><div class="muted">' +
      [mem && mem.proName ? 'Pro: ' + esc(mem.proName) : '', pos ? POS_LABEL[pos] : '', mem && mem.heightCm ? mem.heightCm + ' cm' : '', esc(db.club.name)].filter(Boolean).join(' · ') + '</div></div>' +
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

      h += '<div class="statgroups">';
      h += kvCard('Ratings', [['Average', f2(avg)], ['Best', perfLink(best)], ['Lowest', perfLink(worst)], ['Games rated 8.0+', r8 + ' of ' + rated.length], ['Consistency (std dev)', sd === null ? '–' : f2(sd)], ['Player of the match', a.motm + ' (' + pctS(a.motm, a.apps) + ' of games)']]);
      h += kvCard('Attacking', [['Goals', a.goals], ['Goals per 90', f2(per90(a.goals, a.seconds))], ['Shots', a.tries], ['Shots per 90', f1(per90(a.tries, a.seconds))], ['Shot conversion', pctS(a.goals, a.tries)], ['Minutes per goal', a.goals ? Math.round(a.seconds / 60 / a.goals) : '–'], ['Longest scoring streak', games(longest) + (cur && cur === longest ? ' (current)' : '')]]);
      h += kvCard('Creating and passing', [['Assists', a.assists], ['Assists per 90', f2(per90(a.assists, a.seconds))], ['Goals + assists per 90', f2(per90(a.goals + a.assists, a.seconds))], ['Goal involvement', pctS(a.goals + a.assists, a.teamGoals)], ['Games with a goal or assist', gaGames + ' of ' + a.apps], ['Passes completed', a.passesMade + ' of ' + a.passAttempts], ['Pass accuracy', pctS(a.passesMade, a.passAttempts)], ['Passes per 90', f1(per90(a.passesMade, a.seconds))]]);
      var defRows = [['Tackles won', a.tacklesMade + ' of ' + a.tackleAttempts], ['Tackle success', pctS(a.tacklesMade, a.tackleAttempts)], ['Tackles won per 90', f1(per90(a.tacklesMade, a.seconds))], ['Clean sheets', a.cleanSheets], ['Goals conceded per 90', f2(per90(a.goalsConceded, a.seconds))], ['Red cards', a.redCards]];
      if (a.pos.GK) {
        var gk = { saves: 0, conceded: 0, sec: 0, n: 0 };
        log.forEach(function (x) { if (x.p.pos === 'GK') { gk.saves += x.p.saves; gk.conceded += x.p.goalsConceded; gk.sec += x.p.secondsPlayed || 0; gk.n++; } });
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
      h += '<section class="card"><div class="card-h"><h2>All-time with ' + esc(db.club.name) + '</h2></div>' +
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

  /* ---------- compare (radar) ---------- */
  function pctF(v) { return v === null || v === undefined || !isFinite(v) ? '–' : Math.round(v) + '%'; }
  var CMP = {
    rating: { label: 'Rating', f: avgRating, fmt: f2 },
    g90: { label: 'Goals /90', f: function (a) { return per90(a.goals, a.seconds); }, fmt: f2 },
    a90: { label: 'Assists /90', f: function (a) { return per90(a.assists, a.seconds); }, fmt: f2 },
    s90: { label: 'Shots /90', f: function (a) { return per90(a.tries, a.seconds); }, fmt: f1 },
    conv: { label: 'Shot conversion', f: function (a) { return pct(a.goals, a.tries); }, fmt: pctF },
    gi: { label: 'Goal involvement', f: function (a) { return pct(a.goals + a.assists, a.teamGoals); }, fmt: pctF, tip: 'Goals + assists as a share of club goals in games played' },
    pass: { label: 'Pass accuracy', f: function (a) { return pct(a.passesMade, a.passAttempts); }, fmt: pctF },
    p90: { label: 'Passes /90', f: function (a) { return per90(a.passesMade, a.seconds); }, fmt: f1 },
    t90: { label: 'Tackles won /90', f: function (a) { return per90(a.tacklesMade, a.seconds); }, fmt: f1 },
    tpct: { label: 'Tackle success', f: function (a) { return pct(a.tacklesMade, a.tackleAttempts); }, fmt: pctF },
    cga90: { label: 'Conceded /90', f: function (a) { return per90(a.goalsConceded, a.seconds); }, fmt: f2, inv: true, tip: 'Lower is better' },
    cs: { label: 'Clean sheets', f: function (a) { return pct(a.cleanSheets, a.apps); }, fmt: pctF, tip: 'Share of games' },
    sv90: { label: 'Saves /90', f: function (a) { return per90(a.saves, a.seconds); }, fmt: f1 },
    motm: { label: 'MOTM rate', f: function (a) { return pct(a.motm, a.apps); }, fmt: pctF, tip: 'Share of games' },
    pressing_rate: { label: 'Pressing rate', f: function (a) { return a.seconds > 0 ? a.tackleAttempts / (a.seconds / MATCH_SECONDS) : null; }, fmt: f1, tip: 'Tackle attempts per 90' },
    atk_threat: { label: 'Attacking threat', f: function (a) { return a.seconds > 0 ? (a.goals + a.assists + a.tries) / (a.seconds / MATCH_SECONDS) : null; }, fmt: f1, tip: 'Goals + assists + shots per 90' }
  };
  var CMP_TPL = [
    { k: 'fwd',  name: 'Forward',          axes: ['g90', 's90', 'a90', 'pass', 'conv', 'gi'],           pos: 'FWD' },
    { k: 'mid',  name: 'Midfield',          axes: ['g90', 'a90', 'p90', 't90', 'pressing_rate', 'pass'], pos: 'MID' },
    { k: 'def',  name: 'Defence',           axes: ['t90', 'pressing_rate', 'tpct', 'pass', 'p90', 'cs'], pos: 'DEF' },
    { k: 'wide', name: 'Wide / wing-back',  axes: ['g90', 's90', 'a90', 't90', 'pressing_rate', 'pass'], pos: null }
  ];
  // Share of the other players in the pool this value beats. Ties beat nobody; inv flips it for lower-is-better stats.
  function percentile(v, vals, inv) {
    if (v === null || !vals.length) return null;
    if (vals.length < 2) return 50;
    var beaten = vals.filter(function (x) { return inv ? x > v + 1e-9 : x < v - 1e-9; }).length;
    return beaten / (vals.length - 1) * 100;
  }
  function cmpAvail() { return idx.players.filter(function (a) { return a.apps > 0; }); }
  function cmpSelected() {
    var avail = cmpAvail(), by = {};
    avail.forEach(function (a) { by[a.id] = a; });
    var ids = ui.cmp.sel;
    if (ids === null) ids = avail.slice().sort(function (x, y) { return y.seconds - x.seconds; }).slice(0, 2).map(function (a) { return a.id; });
    return ids.filter(function (id) { return by[id]; }).slice(0, MAX_COMPARE).map(function (id) { return by[id]; });
  }
  function cmpAdd(a) {
    var ids = cmpSelected().map(function (x) { return x.id; });
    if (ids.indexOf(a.id) < 0) { if (ids.length >= MAX_COMPARE) ids.pop(); ids.push(a.id); }
    ui.cmp.sel = ids;
    var pos = mainPos(a);
    CMP_TPL.forEach(function (t) { if (t.pos && t.pos === pos) ui.cmp.tpl = t.k; });
  }

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
      s += '<text class="alab" style="font-size:' + FS + 'px" x="' + p[0].toFixed(1) + '" y="' + y0.toFixed(1) + '" text-anchor="' + (c > 0.3 ? 'start' : c < -0.3 ? 'end' : 'middle') + '">' +
        ls.map(function (l, k) { return '<tspan x="' + p[0].toFixed(1) + '"' + (k ? ' dy="' + lh.toFixed(1) + '"' : '') + '>' + esc(l) + '</tspan>'; }).join('') + '</text>';
    });
    rows.forEach(function (r) {
      s += '<polygon class="ser s' + r.i + '" points="' + r.cells.map(function (c, k) { return xy(pt(k, R * (c.p === null ? 0 : c.p) / 100)); }).join(' ') + '"/>';
    });
    rows.forEach(function (r) {
      r.cells.forEach(function (c, k) {
        var p = pt(k, R * (c.p === null ? 0 : c.p) / 100);
        s += '<circle class="pt s' + r.i + '" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + (compact ? 6 : 4.5) + '"><title>' + esc(r.a.name) + ' · ' + esc(axes[k].mt.label) + ': ' + (c.p === null ? 'no data' : Math.round(c.p) + ' (' + axes[k].mt.fmt(c.v) + ')') + '</title></circle>';
      });
    });
    return s + '</svg>';
  }

  function viewCompare() {
    var tpl = CMP_TPL.filter(function (t) { return t.k === ui.cmp.tpl; })[0] || CMP_TPL[0];
    var avail = cmpAvail(), sel = cmpSelected();
    var h = notices() + '<div class="dayhead"><h1>Compare</h1><span class="muted small">percentile within the squad</span></div>';
    if (!avail.length) { view.innerHTML = h + emptyState(); return; }

    h += '<section class="card"><div class="tabs" role="tablist" aria-label="Stat template">' + CMP_TPL.map(function (t) {
      return '<button role="tab" data-act="cmp-tpl" data-tpl="' + t.k + '" aria-selected="' + (t.k === tpl.k) + '">' + t.name + '</button>';
    }).join('') + '</div><div class="card-b"><div class="pickrow" role="group" aria-label="Players to compare">' +
      avail.slice().sort(function (x, y) { return y.seconds - x.seconds || x.name.localeCompare(y.name); }).map(function (a) {
        var at = sel.indexOf(a), on = at >= 0, full = !on && sel.length >= MAX_COMPARE;
        return '<button class="pchip' + (on ? ' on s' + at : '') + '" data-act="cmp-toggle" data-id="' + esc(a.id) + '" aria-pressed="' + on + '"' + (full ? ' aria-disabled="true"' : '') + '>' +
          '<i class="sw"></i>' + esc(a.name) + '</button>';
      }).join('') + '</div></div></section>';

    if (!sel.length) { view.innerHTML = h + '<div class="card"><div class="card-b muted">Pick a player.</div></div>'; return; }

    var need = minApps();
    var pool = avail.filter(function (a) { return a.apps >= need || sel.indexOf(a) >= 0; });
    var axes = tpl.axes.map(function (k) {
      var mt = CMP[k];
      return { k: k, mt: mt, vals: pool.map(mt.f).filter(function (v) { return v !== null; }) };
    });
    var rows = sel.map(function (a, i) {
      return { a: a, i: i, cells: axes.map(function (ax) { var v = ax.mt.f(a); return { v: v, p: percentile(v, ax.vals, ax.mt.inv) }; }) };
    });

    h += '<section class="card"><div class="tw"><table class="cmptable"><thead><tr><th>Percentile</th>' + axes.map(function (ax) {
      return '<th' + (ax.mt.tip ? ' title="' + esc(ax.mt.tip) + '"' : '') + '>' + esc(ax.mt.label) + '</th>';
    }).join('') + '<th>Minutes</th><th><span class="sr">Remove</span></th></tr></thead><tbody>' + rows.map(function (r) {
      var pos = mainPos(r.a);
      return '<tr class="s' + r.i + '"><td class="name"><a href="' + playerHref(r.a.id) + '">' + esc(r.a.name) + '</a><small>' + games(r.a.apps) + (pos ? ' · ' + POS_LABEL[pos] : '') + '</small></td>' +
        r.cells.map(function (c, k) { return '<td><b class="pv">' + (c.p === null ? '–' : Math.round(c.p)) + '</b><small>' + (c.v === null ? '' : axes[k].mt.fmt(c.v)) + '</small></td>'; }).join('') +
        '<td>' + mins(r.a.seconds) + '</td><td><button class="x" data-act="cmp-toggle" data-id="' + esc(r.a.id) + '" aria-label="Remove ' + esc(r.a.name) + '">×</button></td></tr>';
    }).join('') + '</tbody></table></div></section>';

    h += '<section class="card"><div class="card-b">' + radarSvg(axes, rows) + '</div></section>';
    view.innerHTML = h;
  }

  /* ---------- club stats ---------- */
  function board(title, sub, rows) {
    return '<section class="card"><div class="card-h"><h2>' + title + '</h2><span class="muted small">' + sub + '</span></div><div class="plist">' +
      (rows.slice(0, 5).map(function (r, i) {
        return '<a class="pl" href="' + playerHref(r.a.id) + '"><span class="rk">' + (i + 1) + '</span><span class="nm">' + esc(r.a.name) + '<small>' + games(r.a.apps) + '</small></span><span class="v">' + r.s + '</span></a>';
      }).join('') || '<div class="pl muted">None yet.</div>') + '</div></section>';
  }
  function leaders(valueFn, fmt, filter) {
    return idx.players.filter(function (a) { return a.apps > 0 && (!filter || filter(a)); })
      .map(function (a) { return { a: a, v: valueFn(a) }; }).filter(function (r) { return r.v !== null && r.v > 0; })
      .sort(function (x, y) { return y.v - x.v || y.a.apps - x.a.apps; })
      .map(function (r) { return { a: r.a, s: fmt(r.v) }; });
  }

  function streakOf(ms, pred) {
    var cur = 0, best = 0;
    ms.forEach(function (m) { if (pred(m)) { cur++; if (cur > best) best = cur; } else cur = 0; });
    return { cur: cur, best: best };
  }
  var DAYPARTS = [
    ['Morning', '5 AM – noon', 5, 12], ['Afternoon', 'noon – 5 PM', 12, 17], ['Evening', '5 – 9 PM', 17, 21], ['Night', '9 PM – midnight', 21, 24], ['Late night', 'midnight – 5 AM', 0, 5]
  ];
  function teamSections(ms) {
    var P = ms.length, h = '', name = esc(db.club.name);
    function acc() { return { goals: 0, tries: 0, pg: 0, pm: 0, pa: 0, tm: 0, ta: 0, sv: 0, rc: 0, rs: 0, rn: 0 }; }
    var U = acc(), O = acc(), pts = 0, out = { n: 0, w: 0 }, csN = 0, scoredN = 0, ratings = [];
    var byRes = { W: { n: 0, rs: [], gf: 0, ga: 0 }, D: { n: 0, rs: [], gf: 0, ga: 0 }, L: { n: 0, rs: [], gf: 0, ga: 0 } };
    var parts = DAYPARTS.map(function (d) { return { d: d, ms: [] }; });
    var pos = { GK: [0, 0], DEF: [0, 0], MID: [0, 0], FWD: [0, 0], 'N/A': [0, 0] }, humanGoals = 0, ourGoals = 0;
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
      parts.forEach(function (p) { if (hr >= p.d[2] && hr < p.d[3]) p.ms.push(m); });
      m.players.us.forEach(function (p) { pos[p.pos][0] += p.goals; pos[p.pos][1] += p.assists; humanGoals += p.goals; });
      ourGoals += m.us.goals;
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

    var posRows = ['FWD', 'MID', 'DEF', 'GK'].filter(function (p) { return pos[p][0] + pos[p][1] > 0; }).map(function (p) {
      return '<div class="cmp"><span>' + POS_LABEL[p] + 's</span><span class="track"><i style="width:' + (humanGoals ? Math.max(2, pos[p][0] / humanGoals * 100) : 2) + '%"></i></span><span class="r"><b>' + pos[p][0] + ' G</b> · ' + pos[p][1] + ' A</span></div>';
    }).join('');
    var other = Math.max(0, ourGoals - humanGoals);
    h += '<div class="grid2"><section class="card"><div class="card-h"><h2>Goals by position</h2></div><div class="card-b">' + (posRows || '<p class="muted">No goals yet.</p>') +
      (other ? '<p class="muted small" style="margin-top:6px">+' + other + ' from AI teammates, own goals or forfeit</p>' : '') + '</div></section>';
    h += '<section class="card"><div class="card-h"><h2>When we play</h2><span class="muted small">Central Time</span></div><div class="tw"><table><thead><tr><th>Time of day</th><th>P</th><th>W</th><th>D</th><th>L</th><th>Win %</th></tr></thead><tbody>' +
      parts.filter(function (p) { return p.ms.length; }).map(function (p) {
        var x = tally(p.ms);
        return '<tr><td class="name">' + p.d[0] + '<small>' + p.d[1] + '</small></td><td>' + x.P + '</td><td>' + x.W + '</td><td>' + x.D + '</td><td>' + x.L + '</td><td>' + pctS(x.W, x.P) + '</td></tr>';
      }).join('') + '</tbody></table></div></section></div>';
    return h;
  }

  function squadPer90() {
    var rows = idx.players.filter(function (a) { return a.apps > 0; }).sort(function (x, y) { return y.seconds - x.seconds; });
    if (!rows.length) return '';
    return '<section class="card"><div class="card-h"><h2>Squad per 90</h2></div><div class="tw"><table><thead><tr><th>Player</th><th>Min</th><th>G</th><th>A</th><th>Shots</th><th>Conv %</th><th>Pass %</th><th>Tackles</th><th>Rating</th></tr></thead><tbody>' +
      rows.map(function (a) {
        return '<tr><td class="name"><a href="' + playerHref(a.id) + '">' + esc(a.name) + '</a><small>' + games(a.apps) + '</small></td><td>' + mins(a.seconds) + '</td><td>' + f2(per90(a.goals, a.seconds)) + '</td><td>' + f2(per90(a.assists, a.seconds)) + '</td><td>' + f1(per90(a.tries, a.seconds)) + '</td><td>' + pctS(a.goals, a.tries) + '</td><td>' + pctS(a.passesMade, a.passAttempts) + '</td><td>' + f1(per90(a.tacklesMade, a.seconds)) + '</td><td>' + rt(avgRating(a) || 0) + '</td></tr>';
      }).join('') + '</tbody></table></div></section>';
  }

  function viewStats() {
    var ms = idx.matches, t = tally(ms), o = db.club.overall;
    var h = notices() + '<h1>Club stats</h1>';
    if (!ms.length && !o) { view.innerHTML = h + emptyState(); return; }
    if (ms.length) {
      var teamAvg = mean(ms.map(function (m) { return m.stats.us.avgRating; }).filter(function (v) { return v > 0; }));
      h += '<section class="card"><div class="card-h"><h2>Tracked</h2><span class="muted small">' + esc(fmtDayShort(ms[0].day)) + ' – ' + esc(fmtDayShort(ms[ms.length - 1].day)) + '</span></div>' +
        tiles([['Played', t.P], ['Record', t.W + '-' + t.D + '-' + t.L], ['Win rate', pctS(t.W, t.P)], ['Goals for', t.GF], ['Goals against', t.GA], ['Goals per game', f2(t.GF / t.P)], ['Conceded per game', f2(t.GA / t.P)], ['Team rating', f2(teamAvg)]]) +
        '<div class="card-b"><div class="formrow"><span class="muted small">Form</span>' + ms.slice(-10).reverse().map(function (m) {
          return '<a href="' + matchHref(m) + '" title="' + m.us.goals + '–' + m.them.goals + ' v ' + esc(m.them.name) + '">' + resChip(m.result) + '</a>';
        }).join('') + '</div></div></section>';
      h += teamSections(ms);
    }
    if (o) {
      h += '<section class="card"><div class="card-h"><h2>All-time</h2></div>' +
        tiles([['Played', o.gamesPlayed], ['Record', o.wins + '-' + o.draws + '-' + o.losses], ['Win rate', pctS(o.wins, o.gamesPlayed)], ['Goals for', o.goals], ['Goals against', o.goalsAgainst], ['Skill rating', o.skillRating], ['Promotions', o.promotions], ['Relegations', o.relegations], ['Unbeaten run', o.unbeatenStreak], ['League games', o.leagueApps], ['Playoff games', o.playoffApps], ['Goal difference', (o.goals - o.goalsAgainst >= 0 ? '+' : '−') + Math.abs(o.goals - o.goalsAgainst)]]) + '</section>';
    }
    if (ms.length) {
      var need = minApps(), q = function (a) { return a.apps >= need; }, sub = 'min ' + games(need);
      h += '<h2 style="margin-top:6px">Leaderboards</h2><div class="grid2">' +
        board('Average rating', sub, leaders(avgRating, function (v) { return rt(v); }, q)) +
        board('Goals', 'total', leaders(function (a) { return a.goals; }, String)) +
        board('Assists', 'total', leaders(function (a) { return a.assists; }, String)) +
        board('Goals + assists per 90', sub, leaders(function (a) { return per90(a.goals + a.assists, a.seconds); }, f2, q)) +
        board('Player of the match', 'awards', leaders(function (a) { return a.motm; }, String)) +
        board('Pass accuracy', sub, leaders(function (a) { return pct(a.passesMade, a.passAttempts); }, function (v) { return Math.round(v) + '%'; }, q)) +
        board('Tackles won per 90', sub, leaders(function (a) { return per90(a.tacklesMade, a.seconds); }, f1, q)) +
        board('Saves', 'total', leaders(function (a) { return a.saves; }, String)) + '</div>';

      h += squadPer90();

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

      var opp = {};
      ms.forEach(function (m) { var e = opp[m.them.id] || (opp[m.them.id] = { name: m.them.name, ms: [], last: 0 }); e.name = m.them.name; e.side = m.them; e.ms.push(m); e.last = m.ts; });
      var ol = Object.keys(opp).map(function (k) { return opp[k]; }).sort(function (a, b) { return b.ms.length - a.ms.length || b.last - a.last; });
      h += '<section class="card"><div class="card-h"><h2>Opponents</h2><span class="muted small">' + ol.length + '</span></div><div class="tw"><table><thead><tr><th>Club</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>Last met</th></tr></thead><tbody>' +
        ol.slice(0, 25).map(function (e) {
          var x = tally(e.ms), lastM = e.ms[e.ms.length - 1];
          return '<tr><td class="name"><a class="who" href="' + matchHref(lastM) + '">' + crest(e.side, 24) + '<span>' + esc(e.name) + '</span></a></td><td>' + x.P + '</td><td>' + x.W + '</td><td>' + x.D + '</td><td>' + x.L + '</td><td>' + x.GF + '</td><td>' + x.GA + '</td><td>' + esc(fmtDayShort(lastM.day)) + '</td></tr>';
        }).join('') + '</tbody></table></div></section>';
    }
    view.innerHTML = h;
  }

  /* ---------- data page ---------- */
  function viewData() {
    var ms = idx.matches, clubId = esc(db.club.id || '');
    var url = 'https://proclubs.ea.com/api/fc/clubs/matches?platform=' + esc(db.club.platform || 'common-gen5') + '&amp;matchType=leagueMatch&amp;clubIds=' + clubId;
    var h = '<h1>Data</h1>' + kvCard('Tracked', [
      ['Games', ms.length], ['First', ms.length ? esc(fmtDayLong(ms[0].day)) : '–'], ['Latest', ms.length ? esc(fmtDayLong(ms[ms.length - 1].day)) : '–'],
      ['Updated', db.updatedAt ? esc(fmtStamp(db.updatedAt)) : '–'], ['Added in this browser', db.imported || 0], ['Club ID', clubId || '–']]);
    h += '<section class="card"><div class="card-h"><h2>Add games by hand</h2></div><div class="card-b" style="display:flex;flex-direction:column;gap:10px">' +
      '<ol class="steps"><li>Open <code>' + url + '</code> (or <code>playoffMatch</code> / <code>friendlyMatch</code>).</li><li>Copy the whole page and paste it here.</li></ol>' +
      '<textarea id="import-json" spellcheck="false" aria-label="EA match JSON" placeholder="[{&quot;matchId&quot;: … }]">' + esc(ui.importDraft) + '</textarea>' +
      '<div class="row"><select id="import-type" aria-label="Competition"><option value="leagueMatch">League</option><option value="playoffMatch">Playoffs</option><option value="friendlyMatch">Friendlies</option></select>' +
      '<button class="btn primary" data-act="import">Add games</button>' + (db.imported ? '<button class="btn" data-act="import-clear">Remove added games</button>' : '') + '</div>' +
      (ui.importMsg ? '<p class="' + (ui.importMsg.ok ? 'ok' : 'err') + '" role="status">' + esc(ui.importMsg.text) + '</p>' : '') +
      '<p class="muted small">Stays in this browser only.</p></div></section>';
    view.innerHTML = h;
  }

  function doImport() {
    var ta = document.getElementById('import-json'), sel = document.getElementById('import-type');
    var raw;
    ui.importDraft = ta.value; // survives the re-render if the import fails
    try { raw = JSON.parse(ta.value); } catch (e) { ui.importMsg = { ok: false, text: 'Not valid JSON. Copy the whole page, from [ to ].' }; return; }
    if (!Array.isArray(raw)) raw = [raw];
    var got = N.normalizeMatches(raw, db.club.id, sel.value);
    if (!got.length) { ui.importMsg = { ok: false, text: 'No games for club ' + db.club.id + ' in that JSON.' }; return; }
    var known = {}; idx.matches.forEach(function (m) { known[m.id] = true; });
    var fresh = got.filter(function (m) { return !known[m.id]; }).length;
    var imp = readImport() || { matches: [] };
    writeImport({ matches: N.mergeMatches(imp.matches, got) });
    ui.importDraft = '';
    ui.importMsg = { ok: true, text: fresh + ' new, ' + (got.length - fresh) + ' already tracked.' };
    reload();
  }

  /* ---------- routing ---------- */
  function reload() { db = loadDb(); idx = buildIndex(); }
  function setNav(name) {
    Array.prototype.forEach.call(document.querySelectorAll('#nav a'), function (a) {
      var on = a.getAttribute('data-nav') === name;
      a.classList.toggle('on', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  var lastRoute = null;
  function render() {
    var hash = (location.hash || '').replace(/^#/, '');
    var m;
    if (hash !== lastRoute) {
      if (lastRoute !== null) window.scrollTo(0, 0);
      if (hash.indexOf('match-') === 0 && (lastRoute || '').indexOf('match-') !== 0) ui.tab = 'facts'; // keep the tab when stepping between matches
      if (hash.indexOf('day-') === 0) ui.calMonth = null;
      if ((m = /^compare-([A-Za-z0-9]+)$/.exec(hash)) && idx.bySlug[m[1]] && idx.bySlug[m[1]].apps) cmpAdd(idx.bySlug[m[1]]);
      lastRoute = hash;
    }
    if (/^compare(-[A-Za-z0-9]+)?$/.test(hash)) { setNav('compare'); return viewCompare(); }
    if (hash === 'squad') { setNav('squad'); return viewSquad(); }
    if (hash === 'stats') { setNav('stats'); return viewStats(); }
    if (hash === 'data') { setNav('data'); return viewData(); }
    if ((m = /^match-([A-Za-z0-9]+)$/.exec(hash)) && idx.byId[m[1]]) { setNav('matches'); return viewMatch(idx.byId[m[1]]); }
    if ((m = /^player-([A-Za-z0-9]+)$/.exec(hash)) && idx.bySlug[m[1]]) { setNav('squad'); return viewPlayer(idx.bySlug[m[1]]); }
    setNav('matches');
    m = /^day-(\d{4}-\d{2}-\d{2})$/.exec(hash);
    viewDay(m && validKey(m[1]) ? m[1] : null);
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    var act = el.getAttribute('data-act');
    if (act === 'cal-toggle') ui.calOpen = !ui.calOpen;
    else if (act === 'cal-prev' || act === 'cal-next') {
      var p = ui.calMonth.split('-'), d = new Date(+p[0], +p[1] - 1 + (act === 'cal-next' ? 1 : -1), 1);
      ui.calMonth = d.getFullYear() + '-' + pad(d.getMonth() + 1);
    }
    else if (act === 'tab') ui.tab = el.getAttribute('data-tab');
    else if (act === 'cmp-tpl') ui.cmp.tpl = el.getAttribute('data-tpl');
    else if (act === 'cmp-toggle') {
      var cid = el.getAttribute('data-id'), ids = cmpSelected().map(function (a) { return a.id; }), at = ids.indexOf(cid);
      if (at >= 0) ids.splice(at, 1); else if (ids.length < MAX_COMPARE) ids.push(cid);
      ui.cmp.sel = ids;
    }
    else if (act === 'squad-mode') ui.squadMode = el.getAttribute('data-mode');
    else if (act === 'sort') { var k = el.getAttribute('data-k'); if (ui.sortK === k) ui.sortDir = -ui.sortDir; else { ui.sortK = k; ui.sortDir = -1; } }
    else if (act === 'import') doImport();
    else if (act === 'import-clear') { writeImport(null); ui.importMsg = { ok: true, text: 'Removed.' }; reload(); }
    render();
  });
  window.addEventListener('hashchange', render);
  if (compactMq && compactMq.addEventListener) compactMq.addEventListener('change', function () { if (/^compare/.test((location.hash || '').replace(/^#/, ''))) render(); });
  document.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t.tagName === 'IMG' && t.parentNode && t.parentNode.classList && t.parentNode.classList.contains('cr')) t.parentNode.classList.add('bad');
  }, true);

  reload();
  render();
})();