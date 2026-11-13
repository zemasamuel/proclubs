/* eatmob — reads window.EATMOB_DB (data/db.js) and renders every view. No build step. */
(function () {
  'use strict';

  var N = window.EatmobNormalize;
  var DAY_STARTS_AT_HOUR = 5;      // a game that ends at 12:17 AM belongs to the night before
  var MATCH_SECONDS = 5400;        // EA reports game-clock seconds; 5400 = 90 minutes
  var LS_KEY = 'eatmob-import-v1';
  var TYPE_LABEL = { league: 'League', playoff: 'Playoffs', friendly: 'Friendlies' };
  var POS_LABEL = { GK: 'Goalkeeper', DEF: 'Defender', MID: 'Midfielder', FWD: 'Forward', 'N/A': 'Unknown' };
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  var view = document.getElementById('view');
  var memoryImport = null;
  var ui = { calOpen: false, calMonth: null, tab: 'facts', squadMode: 'tracked', sortK: 'rating', sortDir: -1, importMsg: null };
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
  function dayKeyOf(ts) { return keyOfDate(new Date(ts * 1000 - DAY_STARTS_AT_HOUR * 3600000)); }
  function dateOfKey(k) { var p = k.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(k, n) { var d = dateOfKey(k); d.setDate(d.getDate() + n); return keyOfDate(d); }
  function validKey(k) { return /^\d{4}-\d{2}-\d{2}$/.test(k) && keyOfDate(dateOfKey(k)) === k; }
  function todayKey() { return dayKeyOf(Date.now() / 1000); }
  function fmtTime(ts) { return new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function fmtDayLong(k) { var d = dateOfKey(k); return WD_LONG[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear(); }
  function fmtDayShort(k) { var d = dateOfKey(k); return MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getDate(); }
  var WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function fmtStamp(iso) { var d = new Date(iso); return isNaN(d) ? 'unknown' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
  function afterMidnight(m) { return keyOfDate(new Date(m.ts * 1000)) !== m.day; }

  function f1(v) { return v === null || v === undefined || !isFinite(v) ? '–' : v.toFixed(1); }
  function f2(v) { return v === null || v === undefined || !isFinite(v) ? '–' : v.toFixed(2); }
  function pct(a, b) { return b > 0 ? a / b * 100 : null; }
  function pctS(a, b) { var v = pct(a, b); return v === null ? '–' : Math.round(v) + '%'; }
  function per90(v, sec) { return sec > 0 ? v * MATCH_SECONDS / sec : null; }
  function mins(sec) { return Math.round(sec / 60); }
  function rtClass(r) { return !(r > 0) ? 'none' : r >= 9 ? 'elite' : r >= 7 ? 'good' : r >= 6 ? 'mid' : 'low'; }
  function rt(r, big) { return '<span class="rt ' + rtClass(r) + (big ? ' big' : '') + '">' + (r > 0 ? r.toFixed(1) : '–') + '</span>'; }
  function initials(name) { var s = String(name).replace(/[^A-Za-z0-9]/g, ''); return esc((s.slice(0, 2) || '?').toUpperCase()); }
  function resChip(r) { return '<span class="res ' + r + '" title="' + ({ W: 'Win', D: 'Draw', L: 'Loss' }[r]) + '">' + r + '</span>'; }
  function times(n) { return n > 1 ? ' ×' + n : ''; }
  function ordinal(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

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
             saves: 0, redCards: 0, motm: 0, cleanSheets: 0, goalsConceded: 0, seconds: 0, ratingSum: 0, rated: 0, W: 0, D: 0, L: 0, pos: {}, log: [] };
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
      (byDay[m.day] = byDay[m.day] || []).push(m);
      byId[slug(m.id)] = m;
      m.players.us.forEach(function (p) {
        var a = players[p.id] || (players[p.id] = newAgg(p.id, p.name));
        a.name = p.name; // latest gamertag wins
        a.apps++; a.goals += p.goals; a.assists += p.assists; a.shots += p.shots;
        a.passesMade += p.passesMade; a.passAttempts += p.passAttempts;
        a.tacklesMade += p.tacklesMade; a.tackleAttempts += p.tackleAttempts;
        a.saves += p.saves; a.redCards += p.redCards; a.goalsConceded += p.goalsConceded;
        a.seconds += p.secondsPlayed || 0;
        if (p.motm) a.motm++;
        if (p.cleanSheet) a.cleanSheets++;
        if (p.rating > 0) { a.ratingSum += p.rating; a.rated++; }
        a[m.result]++;
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
    return { matches: matches, byDay: byDay, days: Object.keys(byDay).sort(), byId: byId, players: list, bySlug: bySlug };
  }

  function tally(ms) {
    var t = { P: ms.length, W: 0, D: 0, L: 0, GF: 0, GA: 0 };
    ms.forEach(function (m) { t[m.result]++; t.GF += m.us.goals; t.GA += m.them.goals; });
    return t;
  }
  function record(t) { return t.W + 'W ' + t.D + 'D ' + t.L + 'L'; }
  function topRated(m) { var b = null; m.players.us.forEach(function (p) { if (p.rating > 0 && (!b || p.rating > b.rating)) b = p; }); return b; }
  function playerHref(id) { return '#player-' + slug(id); }
  function matchHref(m) { return '#match-' + slug(m.id); }

  /* ---------- shared pieces ---------- */
  function matchRow(m, withDate) {
    var best = topRated(m);
    return '<a class="mrow" href="' + matchHref(m) + '">' +
      '<span class="t">' + (withDate ? esc(fmtDayShort(m.day)) + '<br>' : '') + esc(fmtTime(m.ts)) + '</span>' +
      resChip(m.result) +
      '<span class="home">' + esc(m.us.name) + '</span>' +
      '<span class="sc">' + m.us.goals + ' – ' + m.them.goals + '</span>' +
      '<span class="away">' + esc(m.them.name) + (m.dnf ? ' <span class="tag" title="A team quit before full time">DNF</span>' : '') + '</span>' +
      '<span class="best num" title="' + (best ? 'Top rated: ' + esc(best.name) : '') + '">' + (best ? rt(best.rating) : '') + '</span>' +
      '</a>';
  }
  function notices() {
    var h = '';
    if (db.sample) h += '<div class="banner"><b>Sample data.</b> These matches are placeholders. Real games appear after the first fetch from EA.</div>';
    return h;
  }
  function emptyState() {
    return '<div class="card"><div class="card-b"><h2>No matches saved yet</h2><p class="muted" style="margin-top:6px">Run the fetch script or use the <a href="#data" style="color:var(--accent);font-weight:600">Data</a> page to add games.</p></div></div>';
  }

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
    h += '<div class="clubhead"><div class="crest" aria-hidden="true">' + esc((db.club.name || 'E').charAt(0)) + '</div><div><h1>' + esc(db.club.name) + '</h1>' +
      '<div class="meta">' + idx.matches.length + ' saved ' + (idx.matches.length === 1 ? 'match' : 'matches') + (idx.matches.length ? ' · ' + record(t) : '') +
      (db.club.overall ? ' · Skill rating ' + db.club.overall.skillRating : '') + '</div></div></div>';

    // date strip
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

    // the day
    h += '<div class="dayhead"><h2 style="font-size:19px">' + esc(fmtDayLong(sel)) + '</h2>';
    if (list.length) {
      var dt = tally(list);
      h += '<div class="chips"><span class="chip">' + list.length + (list.length === 1 ? ' game' : ' games') + '</span><span class="chip">' + record(dt) + '</span><span class="chip">Goals ' + dt.GF + '–' + dt.GA + '</span></div>';
    }
    h += '</div>';

    if (!list.length) {
      h += '<div class="card"><div class="card-b"><p><b>No games on this day.</b></p><p class="muted small" style="margin-top:4px">' +
        (idx.matches.length ? 'Use the match-day buttons or the calendar to jump to a day with games.' : 'No matches are saved yet.') + '</p></div></div>';
    } else {
      ['league', 'playoff', 'friendly'].forEach(function (type) {
        var ms = list.filter(function (m) { return m.type === type; });
        if (!ms.length) return;
        var tt = tally(ms);
        h += '<section class="card"><div class="card-h"><h2>' + TYPE_LABEL[type] + '</h2><span class="muted small">' + record(tt) + '</span></div>' +
          ms.slice().reverse().map(function (m) { return matchRow(m); }).join('') + '</section>';
      });
      if (list.some(afterMidnight)) h += '<p class="note">Games that finish between midnight and ' + DAY_STARTS_AT_HOUR + ' AM are listed with the night they belong to. Times shown are when each game ended, in your time zone.</p>';
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
    h += '<section class="card"><div class="card-h"><h2>Best average rating</h2><span class="muted small">min ' + need + (need === 1 ? ' game' : ' games') + '</span></div><div class="plist">' +
      (rated.slice(0, 5).map(function (a, i) {
        return '<a class="pl" href="' + playerHref(a.id) + '"><span class="rk">' + (i + 1) + '</span><span class="nm">' + esc(a.name) + '<small>' + a.n + (a.n === 1 ? ' game' : ' games') + '</small></span>' + rt(a.rs / a.rn) + '</a>';
      }).join('') || '<div class="pl muted">No ratings recorded.</div>') + '</div></section>';
    h += '<section class="card"><div class="card-h"><h2>Goals and assists</h2><span class="muted small">this day</span></div><div class="plist">' +
      (scorers.slice(0, 5).map(function (a, i) {
        return '<a class="pl" href="' + playerHref(a.id) + '"><span class="rk">' + (i + 1) + '</span><span class="nm">' + esc(a.name) + '</span><span class="v">' + a.g + ' G · ' + a.as + ' A</span></a>';
      }).join('') || '<div class="pl muted">No goals or assists by club members.</div>') + '</div></section>';
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
        h += '<a href="#day-' + k + '" class="' + (k === sel ? 'sel' : '') + '" style="background:none;font-weight:400;color:var(--muted)">' + num + '</a>';
      }
    }
    return h + '</div><p class="muted small" style="padding:0 16px 12px">One dot per game: <i class="dot W" style="display:inline-block"></i> win <i class="dot D" style="display:inline-block"></i> draw <i class="dot L" style="display:inline-block"></i> loss</p></div>';
  }

  /* ---------- match ---------- */
  function scorerList(players, teamGoals) {
    var parts = [], sum = 0;
    players.filter(function (p) { return p.goals > 0; }).sort(function (a, b) { return b.goals - a.goals; })
      .forEach(function (p) { sum += p.goals; parts.push(esc(p.name) + times(p.goals)); });
    if (teamGoals > sum) parts.push('<span title="Goals not credited to a human player: AI teammates, own goals, or goals awarded when a team quits">Other' + times(teamGoals - sum) + '</span>');
    return parts.join('<br>');
  }

  function viewMatch(m) {
    var i = idx.matches.indexOf(m), prev = idx.matches[i - 1], next = idx.matches[i + 1];
    var h = '<div class="row" style="justify-content:space-between"><a class="btn" href="#day-' + m.day + '">‹ ' + esc(fmtDayShort(m.day)) + '</a>' +
      '<div class="row"><a class="btn" ' + (prev ? 'href="' + matchHref(prev) + '"' : 'aria-disabled="true"') + '>‹ Previous</a><a class="btn" ' + (next ? 'href="' + matchHref(next) + '"' : 'aria-disabled="true"') + '>Next ›</a></div></div>';

    h += '<section class="card"><div class="mh"><div class="comp">' + TYPE_LABEL[m.type] + ' · ' + esc(fmtDayLong(keyOfDate(new Date(m.ts * 1000)))) + ' · ended ' + esc(fmtTime(m.ts)) + '</div>' +
      '<div class="board"><div class="team" style="text-align:right">' + esc(m.us.name) + '</div><div class="score">' + m.us.goals + ' – ' + m.them.goals + '</div><div class="team" style="text-align:left">' + esc(m.them.name) + '</div></div>' +
      '<div class="row" style="justify-content:center">' + resChip(m.result) + '<span class="muted small">' + (m.dnf ? 'Ended early: a team quit (DNF)' : 'Full time') + '</span></div>' +
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
        '<div class="avatar">' + initials(motm.p.name) + '</div><div><div style="font-weight:700;font-size:17px">' +
        (motm.us ? '<a href="' + playerHref(motm.p.id) + '">' + esc(motm.p.name) + '</a>' : esc(motm.p.name)) + '</div>' +
        '<div class="muted small">' + esc(motm.us ? m.us.name : m.them.name) + ' · ' + POS_LABEL[motm.p.pos] + ' · ' + motm.p.goals + ' G · ' + motm.p.assists + ' A</div></div>' +
        '<div class="ovr">' + rt(motm.p.rating, true) + '</div></div></section>';
    }
    function top(players, us) {
      return players.slice().sort(function (a, b) { return b.rating - a.rating; }).slice(0, 3).map(function (p, i) {
        var inner = '<span class="rk">' + (i + 1) + '</span><span class="nm">' + esc(p.name) + '<small>' + POS_LABEL[p.pos] + '</small></span>' + rt(p.rating);
        return us ? '<a class="pl" href="' + playerHref(p.id) + '">' + inner + '</a>' : '<div class="pl">' + inner + '</div>';
      }).join('') || '<div class="pl muted">No players recorded.</div>';
    }
    h += '<div class="grid2"><section class="card"><div class="card-h"><h2>Top rated · ' + esc(m.us.name) + '</h2></div><div class="plist">' + top(m.players.us, true) + '</div></section>' +
      '<section class="card"><div class="card-h"><h2>Top rated · ' + esc(m.them.name) + '</h2></div><div class="plist">' + top(m.players.them, false) + '</div></section></div>';
    h += '<section class="card"><div class="card-h"><h2>Match facts</h2></div><div class="card-b"><dl class="kv">' +
      '<dt>Competition</dt><dd>' + TYPE_LABEL[m.type] + '</dd>' +
      '<dt>Finished</dt><dd>' + esc(new Date(m.ts * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })) + '</dd>' +
      '<dt>Human players</dt><dd>' + m.stats.us.humans + ' v ' + m.stats.them.humans + '</dd>' +
      '<dt>Team average rating</dt><dd>' + f2(m.stats.us.avgRating) + ' v ' + f2(m.stats.them.avgRating) + '</dd>' +
      '<dt>Result type</dt><dd>' + (m.dnf ? 'Ended early (DNF)' : 'Played to full time') + '</dd>' +
      '<dt>EA match ID</dt><dd>' + esc(m.id) + '</dd></dl></div></section>';
    return h;
  }

  function pitchHalf(players, order, label, us) {
    var h = '<div class="half"><div class="side">' + esc(label) + '</div>';
    order.forEach(function (pos) {
      var ps = players.filter(function (p) { return pos === 'MID' ? (p.pos === 'MID' || p.pos === 'N/A') : p.pos === pos; });
      if (!ps.length) return;
      h += '<div class="line">' + ps.map(function (p) {
        var ev = (p.goals ? 'G' + times(p.goals) : '') + (p.goals && p.assists ? ' · ' : '') + (p.assists ? 'A' + times(p.assists) : '') + (p.redCards ? ' RC' : '');
        var inner = rt(p.rating) + '<span class="nm">' + esc(p.name) + '</span>' + (ev ? '<span class="ev">' + ev + '</span>' : '');
        return us ? '<a class="pp" href="' + playerHref(p.id) + '">' + inner + '</a>' : '<div class="pp">' + inner + '</div>';
      }).join('') + '</div>';
    });
    return h + '</div>';
  }
  function matchLineup(m) {
    return '<section class="card"><div class="pitch">' +
      pitchHalf(m.players.them, ['GK', 'DEF', 'MID', 'FWD'], m.them.name, false) +
      pitchHalf(m.players.us, ['FWD', 'MID', 'DEF', 'GK'], m.us.name, true) +
      '</div><div class="card-b"><p class="muted small">Only human players are shown, grouped by the position they played. EA does not report AI teammates or exact formation slots. G = goals, A = assists, RC = red card.</p></div></section>';
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
      statBar('Shots', u.shots, o.shots) +
      statBar('Passes completed', u.passesMade, o.passesMade) +
      statBar('Pass accuracy', pct(u.passesMade, u.passAttempts), pct(o.passesMade, o.passAttempts), p) +
      statBar('Tackles won', u.tacklesMade, o.tacklesMade) +
      statBar('Tackle success', pct(u.tacklesMade, u.tackleAttempts), pct(o.tacklesMade, o.tackleAttempts), p) +
      statBar('Saves', u.saves, o.saves) +
      statBar('Red cards', u.redCards, o.redCards) +
      statBar('Average rating', u.avgRating, o.avgRating, function (v) { return v ? v.toFixed(2) : '–'; }) +
      statBar('Human players', u.humans, o.humans) +
      '<p class="muted small" style="margin-top:8px">Every row except Goals adds up the human players only. EA does not report possession, or shots and passes by AI teammates.</p></div></section>';
  }

  function playerTable(players, us) {
    return '<div class="tw"><table><thead><tr><th>Player</th><th>Pos</th><th>Rating</th><th title="Minutes on the game clock">Min</th><th>G</th><th>A</th><th>Shots</th><th>Passes</th><th>Pass %</th><th>Tackles</th><th>Saves</th><th title="Red cards">RC</th></tr></thead><tbody>' +
      players.map(function (p) {
        return '<tr><td class="name">' + (us ? '<a href="' + playerHref(p.id) + '">' + esc(p.name) + '</a>' : esc(p.name)) + (p.motm ? ' <span class="tag">MOTM</span>' : '') + '</td><td>' + p.pos + '</td><td>' + rt(p.rating) + '</td><td>' + mins(p.secondsPlayed || 0) + '</td><td>' + p.goals + '</td><td>' + p.assists + '</td><td>' + p.shots + '</td><td>' + p.passesMade + '/' + p.passAttempts + '</td><td>' + pctS(p.passesMade, p.passAttempts) + '</td><td>' + p.tacklesMade + '/' + p.tackleAttempts + '</td><td>' + p.saves + '</td><td>' + p.redCards + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function matchPlayers(m) {
    return '<section class="card"><div class="card-h"><h2>' + esc(m.us.name) + '</h2></div>' + playerTable(m.players.us, true) + '</section>' +
      '<section class="card"><div class="card-h"><h2>' + esc(m.them.name) + '</h2></div>' + playerTable(m.players.them, false) + '</section>';
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
      if (a === null || a === undefined) return 1;
      if (b === null || b === undefined) return -1;
      return (a - b) * ui.sortDir || x.a.name.localeCompare(y.a.name);
    });
    var fm = { ga90: f2, pass: function (v) { return v === null ? '–' : Math.round(v) + '%'; }, win: function (v) { return v === null ? '–' : v + '%'; }, rating: function (v) { return rt(v || 0); }, ovr: function (v) { return v === null ? '–' : v; } };
    var h = notices() + '<div class="dayhead"><h1>Squad</h1><div class="seg" role="group" aria-label="Stats source">' +
      '<button data-act="squad-mode" data-mode="tracked" aria-pressed="' + tracked + '">Saved matches</button>' +
      '<button data-act="squad-mode" data-mode="ea" aria-pressed="' + !tracked + '">All-time (EA)</button></div></div>';
    h += '<section class="card"><div class="tw"><table><thead><tr><th>Player</th><th>Pos</th>' + cols.map(function (c) {
      var on = ui.sortK === c[0];
      return '<th' + (on ? ' aria-sort="' + (ui.sortDir < 0 ? 'descending' : 'ascending') + '"' : '') + '><button data-act="sort" data-k="' + c[0] + '" class="' + (on ? 'on' : '') + '">' + c[1] + (on ? (ui.sortDir < 0 ? ' ↓' : ' ↑') : '') + '</button></th>';
    }).join('') + '</tr></thead><tbody>' + rows.map(function (r) {
      var pos = mainPos(r.a);
      return '<tr><td class="name"><a href="' + playerHref(r.a.id) + '">' + esc(r.a.name) + (r.mem && r.mem.proName ? '<small>' + esc(r.mem.proName) + '</small>' : '') + '</a></td><td>' + (pos || '–') + '</td>' +
        cols.map(function (c) { var val = r.v[c[0]]; return '<td>' + (fm[c[0]] ? fm[c[0]](val === undefined ? null : val) : (val === null ? '–' : val)) + '</td>'; }).join('') + '</tr>';
    }).join('') + '</tbody></table></div></section>';
    h += '<p class="note">' + (tracked
      ? 'Saved matches covers the ' + idx.matches.length + ' games stored on this site. Tap a column to sort.'
      : 'All-time figures are EA\'s own career totals for each member in this club' + (db.updatedAt ? ', as of ' + esc(fmtStamp(db.updatedAt)) : '') + '.') + '</p>';
    view.innerHTML = h;
  }

  /* ---------- player ---------- */
  function ratingChart(log) {
    var pts = log.filter(function (x) { return x.p.rating > 0; });
    if (!pts.length) return '<p class="muted">No rated games yet.</p>';
    var W = 720, H = 220, L = 34, R = 14, T = 14, B = 28;
    var lo = Math.min(5, Math.floor(Math.min.apply(null, pts.map(function (x) { return x.p.rating; })))), hi = 10;
    var X = function (i) { return pts.length === 1 ? (L + W - R) / 2 : L + i * (W - L - R) / (pts.length - 1); };
    var Y = function (v) { return T + (hi - v) * (H - T - B) / (hi - lo); };
    var avg = pts.reduce(function (s, x) { return s + x.p.rating; }, 0) / pts.length;
    var s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Match rating for each of ' + pts.length + ' rated games, average ' + avg.toFixed(2) + '">';
    for (var g = lo; g <= hi; g++) s += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(g) + '" y2="' + Y(g) + '"/><text class="axis" x="' + (L - 8) + '" y="' + (Y(g) + 4) + '" text-anchor="end">' + g + '</text>';
    s += '<line class="avg" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(avg) + '" y2="' + Y(avg) + '"/>';
    if (pts.length > 1) s += '<polyline class="ln" points="' + pts.map(function (x, i) { return X(i).toFixed(1) + ',' + Y(x.p.rating).toFixed(1); }).join(' ') + '"/>';
    pts.forEach(function (x, i) {
      s += '<a href="' + matchHref(x.m) + '"><circle class="' + rtClass(x.p.rating) + '" cx="' + X(i).toFixed(1) + '" cy="' + Y(x.p.rating).toFixed(1) + '" r="6"><title>' + x.p.rating.toFixed(1) + ' v ' + esc(x.m.them.name) + ' (' + x.m.us.goals + '–' + x.m.them.goals + '), ' + esc(fmtDayShort(x.m.day)) + '</title></circle></a>';
    });
    s += '<text class="axis" x="' + L + '" y="' + (H - 8) + '">' + esc(fmtDayShort(pts[0].m.day)) + '</text>';
    if (pts.length > 1) s += '<text class="axis" x="' + (W - R) + '" y="' + (H - 8) + '" text-anchor="end">' + esc(fmtDayShort(pts[pts.length - 1].m.day)) + '</text>';
    s += '<text class="avgl" x="' + (W / 2) + '" y="' + (H - 8) + '" text-anchor="middle">Dashed line: average ' + avg.toFixed(2) + '</text>';
    return s + '</svg>';
  }

  function kvCard(title, rows) {
    return '<section class="card"><div class="card-h"><h2>' + title + '</h2></div><div class="card-b"><dl class="kv">' +
      rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('') + '</dl></div></section>';
  }

  function squadCompare(a) {
    var maxApps = Math.max.apply(null, idx.players.map(function (p) { return p.apps; }));
    var minApps = Math.max(1, Math.ceil(maxApps * 0.3));
    var pool = idx.players.filter(function (p) { return p.apps >= minApps || p === a; }).filter(function (p) { return p.apps > 0; });
    var metrics = [
      ['Avg rating', function (p) { return avgRating(p); }, f2],
      ['Goals /90', function (p) { return per90(p.goals, p.seconds); }, f2],
      ['Assists /90', function (p) { return per90(p.assists, p.seconds); }, f2],
      ['Shots /90', function (p) { return per90(p.shots, p.seconds); }, f1],
      ['Pass accuracy', function (p) { return pct(p.passesMade, p.passAttempts); }, function (v) { return v === null ? '–' : Math.round(v) + '%'; }],
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
    return '<section class="card"><div class="card-h"><h2>Compared with the squad</h2><span class="muted small">players with ' + minApps + '+ saved games</span></div><div class="card-b">' + h +
      '<p class="muted small" style="margin-top:6px">Bars are relative to the squad leader in each stat.</p></div></section>';
  }

  function viewPlayer(a) {
    var mem = db.members[a.name] || null, pos = mainPos(a), avg = avgRating(a);
    var h = '<div class="row"><a class="btn" href="#squad">‹ Squad</a></div>';
    h += '<section class="card"><div class="card-b phead"><div class="avatar">' + initials(a.name) + '</div><div><h1>' + esc(a.name) + '</h1><div class="muted">' +
      [mem && mem.proName ? 'Pro: ' + esc(mem.proName) : '', pos ? POS_LABEL[pos] : '', mem && mem.heightCm ? mem.heightCm + ' cm' : '', esc(db.club.name)].filter(Boolean).join(' · ') + '</div></div>' +
      (mem && mem.overall ? '<div class="ovr"><b>' + mem.overall + '</b><span class="muted small">Overall</span></div>' : '') + '</div>';
    if (a.apps) {
      h += '<div class="tiles" style="border-top:1px solid var(--line)">' +
        [['Games', a.apps], ['Minutes', mins(a.seconds)], ['Goals', a.goals], ['Assists', a.assists], ['Avg rating', f2(avg)], ['MOTM', a.motm]].map(function (t) { return '<div class="tile"><b>' + t[1] + '</b><span>' + t[0] + '</span></div>'; }).join('') + '</div>';
    }
    h += '</section>';

    if (!a.apps) {
      h += '<p class="note">No saved matches for this player yet. Their stats will build up as new games are recorded.</p>';
    } else {
      var log = a.log, rated = log.filter(function (x) { return x.p.rating > 0; });
      var last5 = rated.slice(-5), l5 = last5.length ? last5.reduce(function (s, x) { return s + x.p.rating; }, 0) / last5.length : null;
      var best = rated.slice().sort(function (x, y) { return y.p.rating - x.p.rating; })[0], worst = rated.slice().sort(function (x, y) { return x.p.rating - y.p.rating; })[0];
      var sd = rated.length > 1 ? Math.sqrt(rated.reduce(function (s, x) { return s + Math.pow(x.p.rating - avg, 2); }, 0) / rated.length) : null;
      var teamGoals = log.reduce(function (s, x) { return s + x.m.us.goals; }, 0);
      var cur = 0, longest = 0, run = 0, gaGames = 0, r8 = 0;
      log.forEach(function (x) { if (x.p.goals > 0) { run++; longest = Math.max(longest, run); } else run = 0; if (x.p.goals + x.p.assists > 0) gaGames++; if (x.p.rating >= 8) r8++; });
      cur = run;
      var clubAll = tally(idx.matches), clubWin = pct(clubAll.W, clubAll.P), myWin = pct(a.W, a.apps), diff = myWin - clubWin;
      var perfLink = function (x) { return x ? '<a href="' + matchHref(x.m) + '" style="color:var(--accent)">' + x.p.rating.toFixed(1) + ' v ' + esc(x.m.them.name) + '</a>' : '–'; };

      h += '<section class="card"><div class="card-h"><h2>Match ratings</h2><span class="muted small">saved games, oldest to newest</span></div><div class="card-b">' + ratingChart(log) +
        '<div class="formrow" style="margin-top:10px"><span class="muted small">Last ' + last5.length + ':</span>' + last5.map(function (x) { return '<a href="' + matchHref(x.m) + '" title="v ' + esc(x.m.them.name) + '">' + rt(x.p.rating) + '</a>'; }).join('') +
        '<span class="muted small" style="margin-left:auto">Last-' + last5.length + ' average <b style="color:var(--text)">' + f2(l5) + '</b></span></div></div></section>';

      h += '<div class="statgroups">';
      h += kvCard('Ratings', [['Average', f2(avg)], ['Best', perfLink(best)], ['Lowest', perfLink(worst)], ['Games rated 8.0+', r8 + ' of ' + rated.length], ['Consistency (std dev)', sd === null ? '–' : f2(sd)], ['Player of the match', a.motm + ' (' + pctS(a.motm, a.apps) + ' of games)']]);
      h += kvCard('Attacking', [['Goals', a.goals], ['Goals per 90', f2(per90(a.goals, a.seconds))], ['Shots', a.shots], ['Shots per 90', f1(per90(a.shots, a.seconds))], ['Shot conversion', pctS(a.goals, a.shots)], ['Minutes per goal', a.goals ? Math.round(a.seconds / 60 / a.goals) : '–'], ['Longest scoring streak', longest + (longest === 1 ? ' game' : ' games') + (cur && cur === longest ? ' (current)' : '')]]);
      h += kvCard('Creating and passing', [['Assists', a.assists], ['Assists per 90', f2(per90(a.assists, a.seconds))], ['Goals + assists per 90', f2(per90(a.goals + a.assists, a.seconds))], ['Share of club goals while playing', pctS(a.goals + a.assists, teamGoals)], ['Games with a goal or assist', gaGames + ' of ' + a.apps], ['Passes completed', a.passesMade + ' of ' + a.passAttempts], ['Pass accuracy', pctS(a.passesMade, a.passAttempts)], ['Passes per 90', f1(per90(a.passesMade, a.seconds))]]);
      var defRows = [['Tackles won', a.tacklesMade + ' of ' + a.tackleAttempts], ['Tackle success', pctS(a.tacklesMade, a.tackleAttempts)], ['Tackles won per 90', f1(per90(a.tacklesMade, a.seconds))], ['Clean sheets', a.cleanSheets], ['Goals conceded per 90', f2(per90(a.goalsConceded, a.seconds))], ['Red cards', a.redCards]];
      if (a.pos.GK) {
        var gk = { saves: 0, conceded: 0, sec: 0, n: 0 };
        log.forEach(function (x) { if (x.p.pos === 'GK') { gk.saves += x.p.saves; gk.conceded += x.p.goalsConceded; gk.sec += x.p.secondsPlayed || 0; gk.n++; } });
        defRows.splice(4, 0, ['Saves (in goal, ' + gk.n + (gk.n === 1 ? ' game)' : ' games)'), gk.saves], ['Saves per 90', f1(per90(gk.saves, gk.sec))], ['Save rate', pctS(gk.saves, gk.saves + gk.conceded)]);
      }
      h += kvCard(a.pos.GK ? 'Defending and goalkeeping' : 'Defending and discipline', defRows);
      h += kvCard('Results with ' + esc(a.name), [['Record', a.W + 'W ' + a.D + 'D ' + a.L + 'L'], ['Win rate', pctS(a.W, a.apps)], ['Club win rate (all saved games)', pctS(clubAll.W, clubAll.P)], ['Difference', (diff >= 0 ? '+' : '−') + Math.abs(Math.round(diff)) + ' percentage points'], ['Points per game', f2((a.W * 3 + a.D) / a.apps)], ['Games missed', (idx.matches.length - a.apps) + ' of ' + idx.matches.length]]);
      var posRows = Object.keys(a.pos).sort(function (x, y) { return a.pos[y] - a.pos[x]; }).map(function (p) {
        var ls = log.filter(function (x) { return x.p.pos === p; }), rs = ls.filter(function (x) { return x.p.rating > 0; });
        var g = 0, as = 0; ls.forEach(function (x) { g += x.p.goals; as += x.p.assists; });
        return [POS_LABEL[p], ls.length + (ls.length === 1 ? ' game' : ' games') + ' · ' + g + ' G · ' + as + ' A · ' + (rs.length ? rt(rs.reduce(function (s, x) { return s + x.p.rating; }, 0) / rs.length) : '–')];
      });
      h += kvCard('By position', posRows);
      h += '</div>';
      h += squadCompare(a);
    }

    if (mem && mem.gamesPlayed) {
      h += '<section class="card"><div class="card-h"><h2>All-time with ' + esc(db.club.name) + '</h2><span class="muted small">EA career totals' + (db.updatedAt ? ' · ' + esc(fmtStamp(db.updatedAt)) : '') + '</span></div><div class="tiles">' +
        [['Games', mem.gamesPlayed], ['Win rate', mem.winRate + '%'], ['Goals', mem.goals], ['Assists', mem.assists], ['Avg rating', mem.ratingAve.toFixed(1)], ['MOTM', mem.motm], ['Shot success', mem.shotSuccessRate + '%'], ['Pass success', mem.passSuccessRate + '%'], ['Tackle success', mem.tackleSuccessRate + '%'], ['Clean sheets', mem.cleanSheets], ['Red cards', mem.redCards], ['Goals per game', (mem.goals / mem.gamesPlayed).toFixed(2)]]
          .map(function (t) { return '<div class="tile"><b>' + t[1] + '</b><span>' + t[0] + '</span></div>'; }).join('') + '</div></section>';
    }

    if (a.apps) {
      h += '<section class="card"><div class="card-h"><h2>Match log</h2><span class="muted small">newest first</span></div><div class="tw"><table><thead><tr><th>Match</th><th>Result</th><th>Pos</th><th>Min</th><th>G</th><th>A</th><th>Shots</th><th>Pass %</th><th>Tackles</th><th>Rating</th></tr></thead><tbody>' +
        a.log.slice().reverse().map(function (x) {
          var p = x.p, m = x.m;
          return '<tr><td class="name"><a href="' + matchHref(m) + '">v ' + esc(m.them.name) + '<small>' + esc(fmtDayShort(m.day)) + ' · ' + TYPE_LABEL[m.type] + '</small></a></td><td>' + resChip(m.result) + ' ' + m.us.goals + '–' + m.them.goals + '</td><td>' + p.pos + '</td><td>' + mins(p.secondsPlayed || 0) + '</td><td>' + p.goals + '</td><td>' + p.assists + '</td><td>' + p.shots + '</td><td>' + pctS(p.passesMade, p.passAttempts) + '</td><td>' + p.tacklesMade + '</td><td>' + rt(p.rating) + (p.motm ? ' <span class="tag">MOTM</span>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div></section>';
    }
    view.innerHTML = h;
  }

  /* ---------- club stats ---------- */
  function board(title, sub, rows) {
    return '<section class="card"><div class="card-h"><h2>' + title + '</h2><span class="muted small">' + sub + '</span></div><div class="plist">' +
      (rows.slice(0, 5).map(function (r, i) {
        return '<a class="pl" href="' + playerHref(r.a.id) + '"><span class="rk">' + (i + 1) + '</span><span class="nm">' + esc(r.a.name) + '<small>' + r.a.apps + (r.a.apps === 1 ? ' game' : ' games') + '</small></span><span class="v">' + r.s + '</span></a>';
      }).join('') || '<div class="pl muted">Nothing recorded yet.</div>') + '</div></section>';
  }
  function leaders(valueFn, fmt, filter) {
    return idx.players.filter(function (a) { return a.apps > 0 && (!filter || filter(a)); })
      .map(function (a) { return { a: a, v: valueFn(a) }; }).filter(function (r) { return r.v !== null && r.v > 0; })
      .sort(function (x, y) { return y.v - x.v || y.a.apps - x.a.apps; })
      .map(function (r) { return { a: r.a, s: fmt(r.v) }; });
  }

  function viewStats() {
    var ms = idx.matches, t = tally(ms), o = db.club.overall;
    var h = notices() + '<h1>Club stats</h1>';
    if (!ms.length && !o) { view.innerHTML = h + emptyState(); return; }
    if (ms.length) {
      var rs = 0, rn = 0; ms.forEach(function (m) { if (m.stats.us.avgRating > 0) { rs += m.stats.us.avgRating; rn++; } });
      h += '<section class="card"><div class="card-h"><h2>Saved matches</h2><span class="muted small">' + esc(fmtDayShort(ms[0].day)) + ' to ' + esc(fmtDayShort(ms[ms.length - 1].day)) + '</span></div><div class="tiles">' +
        [['Played', t.P], ['Record', t.W + '-' + t.D + '-' + t.L], ['Win rate', pctS(t.W, t.P)], ['Goals for', t.GF], ['Goals against', t.GA], ['Goals per game', f2(t.GF / t.P)], ['Conceded per game', f2(t.GA / t.P)], ['Team avg rating', rn ? f2(rs / rn) : '–']]
          .map(function (x) { return '<div class="tile"><b>' + x[1] + '</b><span>' + x[0] + '</span></div>'; }).join('') + '</div>' +
        '<div class="card-b"><div class="formrow"><span class="muted small">Form, newest first:</span>' + ms.slice(-10).reverse().map(function (m) {
          return '<a href="' + matchHref(m) + '" title="' + m.us.goals + '–' + m.them.goals + ' v ' + esc(m.them.name) + '">' + resChip(m.result) + '</a>';
        }).join('') + '</div></div></section>';
    }
    if (o) {
      h += '<section class="card"><div class="card-h"><h2>All-time</h2><span class="muted small">EA club totals' + (db.updatedAt ? ' · ' + esc(fmtStamp(db.updatedAt)) : '') + '</span></div><div class="tiles">' +
        [['Played', o.gamesPlayed], ['Record', o.wins + '-' + o.draws + '-' + o.losses], ['Win rate', pctS(o.wins, o.gamesPlayed)], ['Goals for', o.goals], ['Goals against', o.goalsAgainst], ['Skill rating', o.skillRating], ['Promotions', o.promotions], ['Relegations', o.relegations], ['Unbeaten run', o.unbeatenStreak], ['League games', o.leagueApps], ['Playoff games', o.playoffApps], ['Goal difference', (o.goals - o.goalsAgainst >= 0 ? '+' : '−') + Math.abs(o.goals - o.goalsAgainst)]]
          .map(function (x) { return '<div class="tile"><b>' + x[1] + '</b><span>' + x[0] + '</span></div>'; }).join('') + '</div></section>';
    }
    if (ms.length) {
      var maxApps = Math.max.apply(null, idx.players.map(function (a) { return a.apps; }));
      var minApps = Math.max(1, Math.ceil(maxApps * 0.3));
      var q = function (a) { return a.apps >= minApps; }, sub = 'min ' + minApps + (minApps === 1 ? ' game' : ' games');
      h += '<h2 style="margin-top:6px">Player leaderboards · saved matches</h2><div class="grid2">' +
        board('Average rating', sub, leaders(avgRating, function (v) { return rt(v); }, q)) +
        board('Goals', 'total', leaders(function (a) { return a.goals; }, String)) +
        board('Assists', 'total', leaders(function (a) { return a.assists; }, String)) +
        board('Goals + assists per 90', sub, leaders(function (a) { return per90(a.goals + a.assists, a.seconds); }, f2, q)) +
        board('Player of the match', 'awards', leaders(function (a) { return a.motm; }, String)) +
        board('Pass accuracy', sub, leaders(function (a) { return pct(a.passesMade, a.passAttempts); }, function (v) { return Math.round(v) + '%'; }, q)) +
        board('Tackles won per 90', sub, leaders(function (a) { return per90(a.tacklesMade, a.seconds); }, f1, q)) +
        board('Saves', 'total', leaders(function (a) { return a.saves; }, String)) + '</div>';

      // records
      var bigW = null, bigL = null, hi = null, perf = null, wRun = 0, wBest = 0, uRun = 0, uBest = 0;
      ms.forEach(function (m) {
        var d = m.us.goals - m.them.goals;
        if (m.result === 'W' && (!bigW || d > bigW.us.goals - bigW.them.goals)) bigW = m;
        if (m.result === 'L' && (!bigL || d < bigL.us.goals - bigL.them.goals)) bigL = m;
        if (!hi || m.us.goals + m.them.goals > hi.us.goals + hi.them.goals) hi = m;
        m.players.us.forEach(function (p) { if (!perf || p.rating > perf.p.rating) perf = { p: p, m: m }; });
        wRun = m.result === 'W' ? wRun + 1 : 0; wBest = Math.max(wBest, wRun);
        uRun = m.result !== 'L' ? uRun + 1 : 0; uBest = Math.max(uBest, uRun);
      });
      var ml = function (m) { return m ? '<a href="' + matchHref(m) + '" style="color:var(--accent)">' + m.us.goals + '–' + m.them.goals + ' v ' + esc(m.them.name) + '</a>' + (m.dnf ? ' (DNF)' : '') : '–'; };
      h += kvCard('Records · saved matches', [['Biggest win', ml(bigW)], ['Heaviest defeat', ml(bigL)], ['Most goals in a game', ml(hi)],
        ['Best individual rating', perf ? '<a href="' + matchHref(perf.m) + '" style="color:var(--accent)">' + esc(perf.p.name) + ' ' + perf.p.rating.toFixed(1) + ' v ' + esc(perf.m.them.name) + '</a>' : '–'],
        ['Longest winning run', wBest + (wBest === 1 ? ' game' : ' games')], ['Longest unbeaten run', uBest + (uBest === 1 ? ' game' : ' games')]]);

      // by competition
      h += '<section class="card"><div class="card-h"><h2>By competition</h2></div><div class="tw"><table><thead><tr><th>Competition</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>Win %</th></tr></thead><tbody>' +
        ['league', 'playoff', 'friendly'].map(function (ty) {
          var x = tally(ms.filter(function (m) { return m.type === ty; }));
          return '<tr><td class="name">' + TYPE_LABEL[ty] + '</td><td>' + x.P + '</td><td>' + x.W + '</td><td>' + x.D + '</td><td>' + x.L + '</td><td>' + x.GF + '</td><td>' + x.GA + '</td><td>' + pctS(x.W, x.P) + '</td></tr>';
        }).join('') + '</tbody></table></div></section>';

      // opponents
      var opp = {};
      ms.forEach(function (m) { var e = opp[m.them.id] || (opp[m.them.id] = { name: m.them.name, ms: [], last: 0 }); e.name = m.them.name; e.ms.push(m); e.last = m.ts; });
      var ol = Object.keys(opp).map(function (k) { return opp[k]; }).sort(function (a, b) { return b.ms.length - a.ms.length || b.last - a.last; });
      h += '<section class="card"><div class="card-h"><h2>Opponents</h2><span class="muted small">' + ol.length + ' faced</span></div><div class="tw"><table><thead><tr><th>Club</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>Last met</th></tr></thead><tbody>' +
        ol.slice(0, 25).map(function (e) {
          var x = tally(e.ms), lastM = e.ms[e.ms.length - 1];
          return '<tr><td class="name"><a href="' + matchHref(lastM) + '">' + esc(e.name) + '</a></td><td>' + x.P + '</td><td>' + x.W + '</td><td>' + x.D + '</td><td>' + x.L + '</td><td>' + x.GF + '</td><td>' + x.GA + '</td><td>' + esc(fmtDayShort(lastM.day)) + '</td></tr>';
        }).join('') + '</tbody></table></div></section>';
    }
    view.innerHTML = h;
  }

  /* ---------- data page ---------- */
  function viewData() {
    var ms = idx.matches, clubId = esc(db.club.id || '');
    var url = 'https://proclubs.ea.com/api/fc/clubs/matches?platform=' + esc(db.club.platform || 'common-gen5') + '&amp;matchType=leagueMatch&amp;clubIds=' + clubId;
    var h = '<h1>Data</h1>';
    h += kvCard('What this site holds', [
      ['Saved matches', ms.length], ['First saved game', ms.length ? esc(fmtDayLong(ms[0].day)) : '–'], ['Latest saved game', ms.length ? esc(fmtDayLong(ms[ms.length - 1].day)) : '–'],
      ['Last pulled from EA', db.updatedAt ? esc(fmtStamp(db.updatedAt)) : '–'], ['Added in this browser', db.imported ? db.imported + ' (stored on this device only)' : 'none'], ['EA club ID', clubId || '–']]);
    h += '<section class="card"><div class="card-h"><h2>How history builds up</h2></div><div class="card-b" style="display:flex;flex-direction:column;gap:8px">' +
      '<p>EA only keeps a club\'s most recent games (about 10 per competition) and removes older ones. This site keeps every game it has ever fetched, so the calendar grows from the first fetch onward.</p>' +
      '<p>The GitHub version runs <code>scripts/fetch.mjs</code> on a schedule. Each run adds any new games to <code>data/db.js</code> and the site updates itself.</p></div></section>';
    h += '<section class="card"><div class="card-h"><h2>Add games by hand</h2></div><div class="card-b" style="display:flex;flex-direction:column;gap:10px">' +
      '<ol class="steps"><li>Open this address in a normal browser tab: <code>' + url + '</code> (swap <code>leagueMatch</code> for <code>playoffMatch</code> or <code>friendlyMatch</code> as needed).</li><li>Select everything on that page and copy it.</li><li>Paste it below, choose the competition, and press Add games.</li></ol>' +
      '<label for="import-json" class="small muted">EA match JSON</label><textarea id="import-json" spellcheck="false" placeholder="[{&quot;matchId&quot;: … }]"></textarea>' +
      '<div class="row"><label for="import-type" class="small muted">Competition</label><select id="import-type"><option value="leagueMatch">League</option><option value="playoffMatch">Playoffs</option><option value="friendlyMatch">Friendlies</option></select>' +
      '<button class="btn primary" data-act="import">Add games</button>' + (db.imported ? '<button class="btn" data-act="import-clear">Remove games added in this browser</button>' : '') + '</div>' +
      (ui.importMsg ? '<p class="' + (ui.importMsg.ok ? 'ok' : 'err') + '" role="status">' + esc(ui.importMsg.text) + '</p>' : '') +
      '<p class="muted small">Games added here are saved in this browser only. Other visitors will not see them; the scheduled fetch is what updates the site for everyone.</p></div></section>';
    view.innerHTML = h;
  }

  function doImport() {
    var ta = document.getElementById('import-json'), sel = document.getElementById('import-type');
    var raw;
    try { raw = JSON.parse(ta.value); } catch (e) { ui.importMsg = { ok: false, text: 'That is not valid JSON. Copy the whole page from EA, starting with [ and ending with ].' }; return; }
    if (!Array.isArray(raw)) raw = [raw];
    var got = N.normalizeMatches(raw, db.club.id, sel.value);
    if (!got.length) { ui.importMsg = { ok: false, text: 'No games for club ' + db.club.id + ' were found in that JSON.' }; return; }
    var known = {}; idx.matches.forEach(function (m) { known[m.id] = true; });
    var fresh = got.filter(function (m) { return !known[m.id]; }).length;
    var imp = readImport() || { matches: [] };
    writeImport({ matches: N.mergeMatches(imp.matches, got) });
    ui.importMsg = { ok: true, text: 'Read ' + got.length + (got.length === 1 ? ' game' : ' games') + ': ' + fresh + ' new, ' + (got.length - fresh) + ' already saved.' };
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
    if (hash !== lastRoute) { if (lastRoute !== null) window.scrollTo(0, 0); if (hash.indexOf('match-') === 0) ui.tab = 'facts'; if (hash.indexOf('day-') === 0) ui.calMonth = null; lastRoute = hash; }
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
    else if (act === 'squad-mode') ui.squadMode = el.getAttribute('data-mode');
    else if (act === 'sort') { var k = el.getAttribute('data-k'); if (ui.sortK === k) ui.sortDir = -ui.sortDir; else { ui.sortK = k; ui.sortDir = -1; } }
    else if (act === 'import') doImport();
    else if (act === 'import-clear') { writeImport(null); ui.importMsg = { ok: true, text: 'Removed the games added in this browser.' }; reload(); }
    render();
  });
  window.addEventListener('hashchange', render);

  reload();
  render();
})();
