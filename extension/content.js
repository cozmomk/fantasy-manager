// Fantasy Manager Highlights: runs on Yahoo Fantasy Football "Player List" and "Settings" pages.
// Read-only. It never clicks, adds, drops or submits anything. It adds a "decision board" to the page and
// reads other Yahoo views plus Sleeper's public trending data with plain GET requests.
(() => {
  const DEFAULT_SLOTS = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1, IR: 1 };
  // A "good game" by position (non-PPR baseline, 4-pt pass TD). A league's points per reception raise RB, WR and TE.
  const GOOD_BASE = { QB: 16, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 };
  const RADAR_SIZE = 10;         // wire candidates shown on the board
  const MAX_PAGES = 2;           // pages of 25 to scan per Yahoo view when looking players up
  const DEFAULT_WEEK = 5;        // fallback if the week cannot be read from the page
  const CACHE_MIN = 30;          // minutes to reuse fetched Yahoo views and notes (shared across tabs)
  const SETTINGS_DAYS = 7;       // re-read the league's settings this often, in case the commissioner changes them
  const SLEEPER = 'https://api.sleeper.app/v1';   // public, read-only; credit: Sleeper (sleeper.com)
  const SL_TREND_MIN = 15, SL_PLAYERS_HOURS = 20;
  const SL_HOT_POS_RANK = 5, SL_HOT_OVERALL = 25;  // "hot" = top adds at his position or overall in 24h

  const leagueId = (location.pathname.match(/\/f1\/(\d+)/) || [])[1];
  // Your team in this league: Yahoo's "My Team" link is in the nav of every league page. It is remembered in case
  // a page lacks it. No link and nothing remembered means a league you are not in, so do nothing.
  const teamKey = 'ff:team:' + leagueId;
  const myTeamLink = leagueId && [...document.querySelectorAll('a[href]')].find(a => a.textContent.trim() === 'My Team' && a.getAttribute('href').includes('/f1/' + leagueId + '/'));
  const linkedTeam = myTeamLink && (myTeamLink.getAttribute('href').match(/\/f1\/\d+\/(\d+)/) || [])[1];
  let teamId = linkedTeam;
  try { if (linkedTeam) localStorage.setItem(teamKey, linkedTeam); else teamId = localStorage.getItem(teamKey); } catch (e) { /* ignore */ }
  if (!teamId) return;
  const league = { name: 'your league', teamId };   // the name comes from the league's settings, below
  // pages the helper runs on: player lists, settings, the league home page, your own team page, the matchup page and the add page
  const PATH = location.pathname;
  const onList = /\/(players|playersearch)(\/|$)/.test(PATH), onSettings = /\/settings/.test(PATH);
  const onTeam = new RegExp('^/f1/' + leagueId + '(/(' + league.teamId + '|matchup)(/|$)|/?$)').test(PATH);   // league home, your team, your matchup: Lineup first
  const onAdd = /\/addplayer\/?$/.test(PATH);   // Yahoo's page for adding one player: compare him with who you would drop
  if (!onList && !onSettings && !onTeam && !onAdd) return;
  // Two copies on one page (for example an old install plus a newer one) would double every request.
  // The attribute lives on the shared DOM, so it is visible across the extension's isolated world and the page's.
  if (document.documentElement.dataset.ffLoaded) return;
  document.documentElement.dataset.ffLoaded = '1';
  const GOOD = Object.assign({}, GOOD_BASE);
  let PLAYOFF_START = 15;   // replaced by the league's own week once its settings are known
  let unknownSlots = [];    // starting slots this tool does not understand, for example defensive players

  const store = typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null;
  const key = 'slots:' + leagueId;
  // storage: extension storage when installed, page localStorage as a fallback (used when testing)
  const kvGet = k => new Promise(res => {
    try { if (store) store.get(k, o => res(o[k])); else res(JSON.parse(localStorage.getItem('ff:' + k) || 'null')); } catch (e) { res(undefined); }
  });
  const kvSet = (k, v) => new Promise(res => {
    try { if (store) store.set({ [k]: v }, () => res()); else { localStorage.setItem('ff:' + k, JSON.stringify(v)); res(); } } catch (e) { res(); /* quota */ }
  });
  const kvRemove = k => new Promise(res => { try { if (store) store.remove(k, () => res()); else { localStorage.removeItem('ff:' + k); res(); } } catch (e) { res(); } });
  const load = () => kvGet(key);
  const save = v => kvSet(key, v);
  const cfgKey = 'cfg:' + leagueId;
  // timing marks (seconds since the page started), readable from the console as window.__ffMarks
  const mark = label => { (window.__ffMarks = window.__ffMarks || []).push(label + ': ' + (performance.now() / 1000).toFixed(1) + 's'); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // private-use characters are Yahoo's icon-font glyphs (for example the arrow added to a sorted column header)
  const txt = el => (el && el.textContent || '').replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim();
  const num = s => { const v = parseFloat(s); return isNaN(v) ? NaN : v; };

  // ---- Being polite to Yahoo -----------------------------------------------------------------------------
  // One request at a time, spaced out. If Yahoo answers 403/429 ("Request denied"), stop ALL requests for
  // 20 minutes (remembered across pages and tabs) so this tool can never hammer the site.
  const TEST = (typeof window !== 'undefined' && window.__FF_TEST__) || null;   // set only by the offline test suite
  const YAHOO_GAP_MS = TEST && typeof TEST.gapMs === 'number' ? TEST.gapMs : 800, PAUSE_MIN = 20;
  let yChain = Promise.resolve(), yCount = 0;
  let blockedMem = 0, failStreak = 0;    // the pause is also kept in memory, in case storage is full or blocked
  const blockedUntil = () => { let v = 0; try { v = Number(localStorage.getItem('ff:blockedUntil') || 0); } catch (e) { /* ignore */ } return Math.max(v, blockedMem); };
  const tripBreaker = () => { blockedMem = Date.now() + PAUSE_MIN * 60000; try { localStorage.setItem('ff:blockedUntil', String(blockedMem)); } catch (e) { /* ignore */ } };
  const yfetch = (url, opts) => {
    const run = async () => {
      if (Date.now() < blockedUntil()) throw new Error('Yahoo asked us to slow down; paused until ' + new Date(blockedUntil()).toLocaleTimeString());
      await sleep(YAHOO_GAP_MS);
      try {   // two tabs share one pace: never closer together than the gap
        const wait = Number(localStorage.getItem('ff:lastReq') || 0) + YAHOO_GAP_MS - Date.now();
        if (wait > 0) await sleep(wait);
        localStorage.setItem('ff:lastReq', String(Date.now()));
      } catch (e) { /* ignore */ }
      yCount++; showProg();
      const res = await fetch(url, opts);
      if (res.status === 403 || res.status === 429 || res.status === 999) {   // 999 is Yahoo's "Request denied"
        tripBreaker();
        throw new Error('Yahoo returned ' + res.status + '; pausing requests for ' + PAUSE_MIN + ' minutes');
      }
      if (res.status >= 500) {            // a run of server errors is a wall too: stop instead of pushing on
        if (++failStreak >= 3) { tripBreaker(); throw new Error('Yahoo keeps returning errors (' + res.status + '); pausing requests for ' + PAUSE_MIN + ' minutes'); }
      } else failStreak = 0;
      return res;
    };
    const p = yChain.then(run, run);
    yChain = p.catch(() => {});
    return p;
  };
  // cache shared by every tab (localStorage), so a new tab does not refetch what another just loaded
  // Bump the number whenever how pages are read changes, so pages cached by an older version are never reused.
  const CACHE_PREFIX = 'ffc3:';
  try { Object.keys(localStorage).filter(x => x.startsWith('ffc:')).forEach(x => localStorage.removeItem(x)); } catch (e) { /* ignore */ }
  const cacheGet = (k, mins) => { try { const h = JSON.parse(localStorage.getItem(CACHE_PREFIX + k) || 'null'); return h && Date.now() - h.t < mins * 60000 ? h.d : undefined; } catch (e) { return undefined; } };
  const cacheSet = (k, d) => {
    const w = () => localStorage.setItem(CACHE_PREFIX + k, JSON.stringify({ t: Date.now(), d }));
    try { w(); } catch (e) {
      try { Object.keys(localStorage).filter(x => /^ffc\d*:/.test(x)).forEach(x => localStorage.removeItem(x)); w(); } catch (e2) { /* give up quietly */ }
    }
  };

  // ---- Layout health: notice when Yahoo changes a page the extension depends on ---------------------------
  // critical = the verdicts would rest on bad data, so the board stops recommending and says why
  const health = { issues: {}, noteTried: 0, noteSeen: 0, sleeperOk: true };
  const flag = (key, msg, critical) => { if (!health.issues[key]) health.issues[key] = { msg, critical: !!critical }; };
  const criticalIssue = () => Object.values(health.issues).find(i => i.critical);
  const checkList = (doc, stat, page, over) => {
    const t = [...doc.querySelectorAll('table')].filter(x => x.querySelector('a.name')).sort((a, b) => b.rows.length - a.rows.length)[0];
    if (!t) { if (!page && !(over && over.status === 'STATE_IR')) flag('list', 'Yahoo\'s player list no longer has a table the extension can read.', true); return true; }
    const heads = new Set([...t.rows].flatMap(r => [...r.cells].map(txt)));
    const need = ['Roster Status'];
    if (/^S_/.test(stat)) need.push('Fan Pts');
    if (stat === 'R_O') need.push('% Ros');
    const missing = need.filter(h => !heads.has(h));
    missing.forEach(h => flag('col:' + h, 'The "' + h + '" column is missing or renamed on Yahoo\'s player lists.', true));
    return !missing.length;
  };
  const checkNotes = () => {
    if (health.noteTried >= 4 && !health.noteSeen)
      flag('notes', 'Yahoo player notes could not be read (none of ' + health.noteTried + ' had a readable note), so injury news is missing' + (health.sleeperOk ? '; Sleeper injury tags are still used.' : '.'), !health.sleeperOk);
  };
  const renderHealth = () => {
    checkNotes();
    const box = document.getElementById('ff-health'); if (!box) return;
    const list = Object.values(health.issues);
    box.textContent = ''; box.className = list.length ? (criticalIssue() ? 'bad' : 'warn') : '';
    if (!list.length) return;
    box.appendChild(el('div', 'hd', criticalIssue() ? 'Yahoo\'s page layout looks changed. Do not rely on the recommendations.' : 'Some data could not be read. Recommendations may be less complete.'));
    list.forEach(i => box.appendChild(el('div', null, '• ' + i.msg)));
    box.appendChild(el('div', 'sub', 'Reload the page. If this stays, the extension needs an update.'));
  };
  // ---- Progress bar: Yahoo requests done vs. what this step usually needs (cache hits just finish sooner) --
  const prog = { on: false, base: 0, expect: 30, label: '', floor: 0 };
  const showProg = () => {
    const box = document.getElementById('ff-prog'); if (!box) return;
    box.style.display = prog.on ? '' : 'none';
    if (!prog.on) return;
    const pct = Math.round(Math.max(prog.floor, Math.min(95, (yCount - prog.base) / prog.expect * 100)));
    box.querySelector('.lab').textContent = prog.label + ' ' + pct + '%';
    box.querySelector('.fill').style.width = pct + '%';
  };
  const progStart = (label, expect) => { Object.assign(prog, { on: true, base: yCount, expect, label, floor: 0 }); showProg(); };
  const progStage = (label, floor) => { prog.label = label; prog.floor = Math.max(prog.floor, floor || 0); showProg(); };
  const progEnd = () => { prog.on = false; showProg(); };
  const guardVerdict = res => criticalIssue() ? Object.assign({}, res, { kind: 'no', headline: 'NO RECOMMENDATION: the data is not trustworthy', sub: criticalIssue().msg }) : res;

  // ---- League settings: name, playoffs, scoring and slots, read once and remembered ---------------------
  // read table cells (innerText can be only partly rendered on this page)
  const parseSettings = doc => {
    const value = label => { const c = [...doc.querySelectorAll('td,th')].find(x => txt(x) === label); return c && c.nextElementSibling ? txt(c.nextElementSibling) : ''; };
    const roster = value('Roster Positions:'), po = /Week (\d+)/.exec(value('Playoffs:'));
    if (!roster) return null;
    const slots = {}, unknown = [];
    roster.split(',').map(s => s.trim()).forEach(p => {
      if (/^(QB|RB|WR|TE|K|DEF|BN|IR|Q\/W\/R\/T|W\/R\/T|W\/R|W\/T|R\/T)$/.test(p)) slots[p] = (slots[p] || 0) + 1;
      else if (!unknown.includes(p)) unknown.push(p);
    });
    slots.BN = slots.BN || 0;
    return { slots, unknown, name: value('League Name:'), playoffStart: po ? +po[1] : 0, rec: num(value('Receptions')) || 0, passTd: num(value('Passing Touchdowns')) || 4 };
  };
  const saveSettings = r => Promise.all([save(r.slots), kvSet(cfgKey, { name: r.name, playoffStart: r.playoffStart, rec: r.rec, passTd: r.passTd, unknown: r.unknown, t: Date.now(), v: 2 })]);
  if (onSettings) {
    let tries = 0;
    const t = setInterval(() => {
      const r = parseSettings(document);
      if (r) { clearInterval(t); saveSettings(r); } else if (++tries > 20) clearInterval(t);
    }, 500);
    return;
  }
  const applySettings = c => {
    if (c.name) league.name = c.name;
    if (c.playoffStart) PLAYOFF_START = c.playoffStart;
    const rec = c.rec || 0;   // what the extra catches are worth in a typical good game
    GOOD.QB = GOOD_BASE.QB + 2 * ((c.passTd || 4) - 4);   // about two passing touchdowns in a good game
    unknownSlots = c.unknown || [];
    GOOD.RB = GOOD_BASE.RB + 2 * rec; GOOD.WR = GOOD_BASE.WR + 4 * rec; GOOD.TE = GOOD_BASE.TE + 2 * rec;
  };

  // ===================================================================================================
  // Data helpers
  // ===================================================================================================
  let SLOTS = DEFAULT_SLOTS;
  const OUT_TAGS = new Set(['O', 'IR', 'NA']);   // tags Yahoo lets you move to IR
  const INJ_TAG = /^(Q|O|D|IR|NA|SUSP|PUP[-\w]*|NFI[-\w]*)$/;
  // 2 = out for a long stretch, 1 = out this week (or doubtful), 0 = no out tag
  const tagLevel = t => (/^(IR|NA|SUSP|PUP|NFI)/.test(t) ? 2 : (t === 'O' || t === 'D' ? 1 : 0));
  // Note classification: lead sentence only (before "Advice:"), and only if it names the player.
  // Long absences need absence wording; "surgery in the offseason", "play through a fractured finger" or "miss 1-2 weeks" do not count.
  const PLAYS = /(expected to (play|start|suit up|be available|be active)|will play|is expected back|returned to|cleared|full participant|full practice|no restrictions)/i;
  const HARD_OUT = /(out for the (rest of the )?(season|year)|season-ending|ruled out for the (season|year)|placed on (the )?(injured reserve|IR)\b|out indefinitely|(tore|torn|ruptured)\s+(his\s+|her\s+)?(\w+\s+)?(ACL|Achilles)|\bACL (tear|injury)|Achilles (tear|rupture)|(undergo|undergoing|underwent|needs|requires|slated for|scheduled for)\s+(\w+\s+){0,2}surgery|(weeks|months) (of|on) (recovery|the shelf)|suspended (for|indefinitely)\s+(\d+|the rest|indef)|(broke|broken|fractured)\b[^.]{0,40}\b(will miss|out for|sidelined|miss(es|ing)?)\b)/i;
  const absenceWeeks = lead => {
    let m = /(?:miss(?:es|ing)?|out|sidelined|recovery(?: timeline)? of|expected to be out)\s+(?:for\s+)?(?:the\s+)?(?:next\s+)?(\d+)(?:\s*-\s*(?:to-)?\s*(\d+))?\s*(weeks?|months?|games?)/i.exec(lead)
      || /(\d+)\s*-\s*(?:to-)?\s*(\d+)\s*(weeks|months)/i.exec(lead);
    if (!m) return 0;
    const n = Math.max(+m[1], m[2] ? +m[2] : 0);
    return /month/i.test(m[3]) ? n * 4 : n;
  };
  const WEEK_OUT = /(ruled out|will not play|won't play|is inactive|out for (sunday|monday|thursday|saturday|this week|week \d+))/i;
  const classify = (n, name) => {
    if (!n) return '';
    const lead = n.text.split(/Advice:/)[0];
    const parts = (name || '').toLowerCase().replace(/[^a-z' ]/g, '').split(' ').filter(w => w.length >= 4 && !/^(jr|sr|iii)$/.test(w));
    if (parts.length && !parts.some(w => lead.toLowerCase().includes(w))) return '';
    const plays = PLAYS.test(lead), weeks = absenceWeeks(lead);
    if (!plays && (HARD_OUT.test(lead) || weeks >= 4)) return 'long';
    if (!plays && weeks > 0) return 'week';
    if (WEEK_OUT.test(lead)) return 'week';
    return '';
  };

  let weekGuessed = false;
  const readWeek = () => {
    const t = document.body.innerText;
    const m = t.match(/Week (\d+) \(proj\)/) || t.match(/Week (\d+): [A-Z][a-z]{2} \d/) || t.match(/Week (\d+) stats/) || t.match(/Week (\d+) Matchups/) || t.match(/Week (\d+)\s+Next 4 Wks/);   // stats dropdown, the matchup/team header, the league home's matchups box, or the add page's rankings
    weekGuessed = !m;
    return m ? parseInt(m[1], 10) : DEFAULT_WEEK;
  };
  // a defense has no numeric id, and Yahoo spells it differently on different pages ("Seahawks" / "Seattle"), so key it by team
  const playerId = a => ((a.getAttribute('href') || '').match(/(\d+)\/?(?:[?#].*)?$/) || [])[1] || nameKey(txt(a)) || txt(a);
  // "68% (+7)" -> { v: 68, d: 7 }; "100% (–)" -> { v: 100, d: 0 }
  const pct = s => {
    const m = /(\d+)%\s*\(\s*([+\-−–]?)\s*(\d*)\s*\)/.exec(s || '');
    if (!m) { const v = parseInt(s, 10); return { v: isNaN(v) ? NaN : v, d: 0 }; }
    return { v: +m[1], d: m[3] ? (m[2] === '-' || m[2] === '−' ? -1 : 1) * +m[3] : 0 };
  };

  // Any Yahoo player-list document -> { playerId: { name, _i (row order), _tp, _inj, <column header>: text } }
  const parseDoc = doc => {
    const t = [...doc.querySelectorAll('table')].filter(x => x.querySelector('a.name'))
      .sort((a, b) => b.rows.length - a.rows.length)[0];
    if (!t) return {};
    const hr = [...t.rows].find(r => [...r.cells].some(c => txt(c) === 'Roster Status'));
    if (!hr) return {};
    const h = [...hr.cells].map(txt);
    const out = {};
    [...t.rows].filter(r => r.querySelector('a.name')).forEach((r, i) => {
      const a = r.querySelector('a.name'), c = [...r.cells].map(txt), o = { name: txt(a), _i: i };
      h.forEach((k, j) => { if (k) o[k] = c[j]; });
      o._tp = [...r.querySelectorAll('.Fz-xxs')].map(txt).join(' ');
      const tm = /([A-Za-z.]+)\s*-\s*(QB|RB|WR|TE|K|DEF)\b/.exec(o._tp) || [];
      o._team = tm[1] || ''; o._pos = tm[2] || '';
      o._inj = ([...r.querySelectorAll('span')].map(txt).find(s => INJ_TAG.test(s))) || '';
      out[playerId(a)] = o;
    });
    return out;
  };

  // Weekly stats of finished weeks do not change (apart from Yahoo's stat corrections in the days after), so they are kept much longer
  // than ownership and status. A list of YOUR players is keyed by who is on your roster, so a new add is never missing from it.
  let curWeek = 0, lastNet = true;
  const ttlFor = stat => { const m = /^S_W_(\d+)$/.exec(stat); if (!m || !curWeek) return CACHE_MIN; const n = +m[1]; return n <= curWeek - 2 ? 720 : (n === curWeek - 1 ? 180 : CACHE_MIN); };
  const fetchPage = async (stat, page, over, sig) => {
    const p = new URLSearchParams(location.search);
    p.delete('search'); p.set('sdir', '1');     // never inherit a name search or a reversed sort from the page's own address
    p.set('stat1', stat);
    if (over) Object.entries(over).forEach(([k, v]) => p.set(k, v));
    if (page) p.set('count', String(25 * page)); else p.delete('count');
    const url = '/f1/' + leagueId + '/players?' + p.toString();
    const ckey = sig ? url + '|' + sig : url;
    const hit = cacheGet(ckey, ttlFor(stat));
    if (hit !== undefined) { lastNet = false; return hit; }
    lastNet = true;
    const res = await yfetch(url, { credentials: 'include' });
    if (!res.ok) return {};
    const html = new DOMParser().parseFromString(await res.text(), 'text/html');
    const d = parseDoc(html);
    if (checkList(html, stat, page, over)) cacheSet(ckey, d);   // never cache a page whose layout looks wrong
    return d;
  };
  const collect = async (stat, ids, over, maxPages) => {
    const found = {};
    for (let p = 0; p < (maxPages || MAX_PAGES); p++) {
      Object.assign(found, await fetchPage(stat, p, over, over && over.status === 'T' ? ids.slice().sort().join(',') : ''));
      if (ids.every(id => id in found)) break;
      if (lastNet) await sleep(250);        // only pace after a real request, not after a cache hit
    }
    return found;
  };
  const weekRange = week => { const a = []; for (let w = Math.max(1, week - 4); w < week; w++) a.push(w); return a; };
  const analyze = async (ids, week, over, mpw, mpt) => {
    const weekNums = weekRange(week), weekly = {};
    for (const w of weekNums) weekly[w] = await collect('S_W_' + w, ids, over && over.weekly, mpw);
    const research = await collect('R_O', ids, over && over.research, mpt);
    return { weekNums, weekly, research };
  };

  // Latest Yahoo player note (date + text). Same-site request, uses your login.
  // A healthy player's note rarely changes, so it is reused for 3 hours; a flagged (injured/questionable) player's note is kept 30 minutes.
  const NOTE_QUIET_MIN = 180;
  const isFlagged = p => !!(p && (p.injTag || (p.sl && p.sl.inj)));
  const fetchNote = async (id, fresh = true, withInfo = false) => {
    const ck = 'note:' + leagueId + ':' + id;
    const hit = cacheGet(ck, fresh ? CACHE_MIN : NOTE_QUIET_MIN);
    if (hit !== undefined && (!withInfo || cacheGet('pinfo:' + leagueId + ':' + id, CACHE_MIN) !== undefined)) return hit;
    let d = null, parsed = false;
    try {
      const res = await yfetch('/f1/' + leagueId + '/playernote?pid=' + encodeURIComponent(id), { credentials: 'include' });
      if (res.ok) {
        const j = JSON.parse(await res.text());
        parsed = true;
        const doc = new DOMParser().parseFromString(j.content || '', 'text/html');
        // the same card says how widely he is rostered across Yahoo and where he is in this league
        const card = txt(doc.body), ros = /(\d+)% Rostered/.exec(card), st = /Roster Status:\s*(.+?)\s*\|/.exec(card);
        cacheSet('pinfo:' + leagueId + ':' + id, { ros: ros ? +ros[1] : NaN, status: st ? st[1] : '' });
        const item = doc.querySelector('.noteitem');
        health.noteTried++; if (item) health.noteSeen++;
        if (item) {
          const date = txt(item.querySelector('.date'));
          const text = txt(item).replace(/^(New )?Player Note\s*/, '').replace(date, '').replace(/^(New )?Player Note\s*/, '').trim();
          d = { date, text };
        }
      }
    } catch (e) { if (/slow down|pausing/.test(String(e && e.message))) throw e; /* otherwise: no note available this time */ }
    if (parsed) cacheSet(ck, d);       // a failed request is not "no note": try again next time
    return d;
  };

  // ---- Sleeper ---------------------------------------------------------------------------------------
  const normName = n => (n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, ' ').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const getJson = async url => { try { const r = await fetch(url); if (!r.ok) throw new Error('Sleeper ' + r.status); return await r.json(); } catch (e) { kvSet('sl:fail', Date.now()); throw e; } };
  let slMemo = null;
  const getSleeper = async () => {
    if (slMemo) return slMemo;
    const failedAt = await kvGet('sl:fail');
    if (failedAt && Date.now() - failedAt < 15 * 60000) throw new Error('Sleeper failed a moment ago; backing off');
    let pl = await kvGet('sl:players');
    if (!pl || Date.now() - pl.t > SL_PLAYERS_HOURS * 3600000) {
      const all = await getJson(SLEEPER + '/players/nfl');          // several MB, but only about once a day
      const slim = {};
      for (const [id, p] of Object.entries(all)) {
        if (!p || !/^(QB|RB|WR|TE|K)$/.test(p.position || '') || !p.full_name) continue;
        if (!p.team && p.status !== 'Injured Reserve') continue;   // skip retired / unsigned
        slim[id] = { n: p.full_name, t: p.team || '', p: p.position, i: p.injury_status || '', b: p.injury_body_part || '' };
      }
      pl = { t: Date.now(), d: slim };
      kvSet('sl:players', pl);
    }
    let tr = await kvGet('sl:trend');
    if (!tr || Date.now() - tr.t > SL_TREND_MIN * 60000) {
      const q = (type, hrs) => getJson(SLEEPER + '/players/nfl/trending/' + type + '?lookback_hours=' + hrs + '&limit=200');
      const [add24, drop24, add7d] = await Promise.all([q('add', 24), q('drop', 24), q('add', 168)]);
      tr = { t: Date.now(), d: { add24, drop24, add7d } };
      kvSet('sl:trend', tr);
    }
    const players = pl.d, byName = {};
    Object.entries(players).forEach(([id, p]) => { (byName[normName(p.n)] = byName[normName(p.n)] || []).push(id); });
    const rank = list => {
      const m = {}, perPos = {};
      list.forEach((e, i) => {
        const pp = players[e.player_id]; if (!pp) return;
        perPos[pp.p] = (perPos[pp.p] || 0) + 1;
        m[e.player_id] = { count: e.count, rank: i + 1, posRank: perPos[pp.p] };
      });
      return m;
    };
    slMemo = { players, byName, add24: rank(tr.d.add24), drop24: rank(tr.d.drop24), add7d: rank(tr.d.add7d), addList: tr.d.add24, addList7d: tr.d.add7d };
    return slMemo;
  };
  const slFind = (SL, name, pos, team) => {
    if (!SL) return null;
    let ids = (SL.byName[normName(name)] || []).filter(id => SL.players[id].p === pos);
    if (ids.length > 1 && team) { const t = ids.filter(id => SL.players[id].t.toUpperCase() === team.toUpperCase()); if (t.length) ids = t; }
    return ids.length === 1 ? ids[0] : null;
  };
  const slInfo = (SL, name, pos, team) => {
    const id = slFind(SL, name, pos, team);
    if (!id) return null;
    const p = SL.players[id], a = SL.add24[id], d = SL.drop24[id], w = SL.add7d[id];
    return { id, inj: p.i, body: p.b, add: a || null, drop: d || null, week: w || null,
      hot: !!(a && (a.posRank <= SL_HOT_POS_RANK || a.rank <= SL_HOT_OVERALL)) };
  };
  const slOut = sl => (!sl ? 0 : /^(IR|PUP|Sus|NA)$/.test(sl.inj) ? 2 : (sl.inj === 'Out' || sl.inj === 'Doubtful') ? 1 : 0);

  // ===================================================================================================
  // Player model: one shape for your players and wire candidates
  // ===================================================================================================
  const USAGE_POS = /^(RB|WR|TE)$/;
  // "last 2 3.8" reads like a collapse when he only played one of those weeks: name the bye or the missed game
  const formText = m => {
    const ws = (m.wk || []).slice(-2), vs = (m.weeks || []).slice(-2), miss = ws.filter((w, i) => isNaN(vs[i]));
    if (!miss.length) return 'last 2 ' + f1(m.form);
    const why = miss.map(w => (w === m.bye ? 'bye' : 'missed') + ' wk ' + w).join(', ');
    return (miss.length >= ws.length ? 'no games in the last 2' : 'last game ' + f1(m.form)) + ' (' + why + ')';
  };
  const usageText = m => (isNaN(m.oppAvg) ? '' : 'usage ' + f1(m.oppAvg) + '/game' + (isNaN(m.oppForm) ? '' : ', last 2 ' + f1(m.oppForm)));
  const metrics = (id, pos, data, radarMode) => {
    const weeks = data.weekNums.map(w => {
      const row = data.weekly[w][id];
      if (!row) return radarMode ? 0 : NaN;
      // a game he missed (injured, inactive) is listed with GP "-" and 0.00 points: that is not a bad game, it is no game
      const gp = row['GP*'] ?? row['GP'];
      return gp !== undefined && !(num(gp) > 0) ? NaN : num(row['Fan Pts']);
    });
    const played = weeks.filter(v => !isNaN(v));
    const thr = GOOD[pos] || 8;
    const r = data.research[id] || {};
    const anyWeekRow = data.weekNums.map(w => data.weekly[w][id]).find(Boolean) || {};
    // usage = rush attempts + targets in that week ("Att*" and "Tgt*" on Yahoo's weekly views); points lag, opportunity leads
    const useOf = row => { if (!row) return NaN; const a = num(row['Att*'] ?? row['Att']), t = num(row['Tgt*'] ?? row['Tgt']); return isNaN(a) && isNaN(t) ? NaN : (isNaN(a) ? 0 : a) + (isNaN(t) ? 0 : t); };
    const opp = USAGE_POS.test(pos) ? data.weekNums.map(w => useOf(data.weekly[w][id])) : data.weekNums.map(() => NaN);
    const mean = l => { const v = l.filter(x => !isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
    return {
      opp, oppAvg: mean(opp), oppForm: mean(opp.slice(-2)), oppEarly: mean(opp.slice(0, -2)),
      pos, weeks, wk: data.weekNums, thr, played: played.length, good: played.filter(v => v >= thr).length,
      avg: played.length ? played.reduce((a, b) => a + b, 0) / played.length : NaN,
      form: (() => { const l = weeks.slice(-2).filter(v => !isNaN(v)); return l.length ? l.reduce((a, b) => a + b, 0) / l.length : NaN; })(),
      max: played.length ? Math.max(...played) : NaN,
      ros: pct(r['% Ros']), start: pct(r['% Start']), trendKnown: !!data.research[id],
      adp: num(r['Avg Pick']), depth: r['Depth Chart'] || '', bye: num(anyWeekRow['Bye']),
      known: !!(data.research[id] || data.weekNums.some(w => data.weekly[w][id])),
    };
  };
  const outLevel = p => {
    const k = classify(p.note, p.name), tl = tagLevel(p.injTag);
    return (tl === 2 || k === 'long' || slOut(p.sl) === 2) ? 2 : ((tl === 1 || k === 'week' || (slOut(p.sl) === 1 && p.injTag !== 'Q')) ? 1 : 0);   // Sleeper's dump can lag: a current Yahoo "Questionable" outranks its "Out"
  };
  // Protected from being "the weakest": good record, drafted early, or hot right now (strong last 2 weeks and widely started).
  // recompute a player's out level (and a wire player's tag) after his note arrives
  const refreshOut = p => {
    p.out = outLevel(p);
    if (p.mine === false) p.tag = p.out === 2 ? 'out' : (p.out === 1 ? 'wkout' : (tagOf(p.m) || 'watch'));
  };
  const proven = p => (!isNaN(p.m.adp) && p.m.adp <= 80) || (p.m.played >= 2 && (p.m.good / p.m.played >= 0.6 ||
    (!isNaN(p.m.form) && p.m.form / p.m.thr >= 1.2 && p.m.trendKnown && (p.m.start.v >= 50 || p.m.start.d >= 10))));
  const byRecord = (a, b) => (a.m.good - b.m.good) || ((a.m.avg / a.m.thr || 0) - (b.m.avg / b.m.thr || 0));

  // ---- Start / sit: who should be in your lineup this week ----------------------------------------------
  // Judged on consistent scoring (last 4 weeks, weighted toward the last 2), not on one-week projections; kickers and defenses are the exception.
  const SUPERFLEX = 'Q/W/R/T';
  const FLEX = { [SUPERFLEX]: ['QB', 'RB', 'WR', 'TE'], 'W/R/T': ['RB', 'WR', 'TE'], 'W/R': ['RB', 'WR'], 'W/T': ['WR', 'TE'], 'R/T': ['RB', 'TE'] };
  const slotFits = (p, slot) => slot === p.pos || (FLEX[slot] || []).includes(p.pos);
  const startScore = p => { const a = p.m.avg, f = p.m.form; return isNaN(a) ? NaN : (isNaN(f) ? a : 0.6 * a + 0.4 * f); };
  // kickers and defenses swing with the matchup, so their start/sit goes by Yahoo's projection for this week when both have one
  const PROJ_POS = /^(K|DEF)$/, PROJ_EDGE = 1.5;
  const byProjection = (b, s) => PROJ_POS.test(b.pos) && !isNaN(b.proj) && !isNaN(s.proj);
  const startValue = p => (PROJ_POS.test(p.pos) && !isNaN(p.proj) ? p.proj : startScore(p));
  const availability = (p, week) => (p.slot === 'IR' ? 'ir' : p.out === 2 ? 'out' : p.out === 1 ? 'outweek' : p.bye === week ? 'bye' : p.injTag === 'Q' ? 'q' : 'ok');
  const AVAIL_TEXT = { ir: 'on IR', out: 'out for a long stretch', outweek: 'out this week', bye: 'on bye this week' };
  const canPlay = (p, week) => { const a = availability(p, week); return a === 'ok' || a === 'q'; };
  const betterToStart = (b, s) => {
    if (byProjection(b, s)) return b.proj - s.proj >= PROJ_EDGE;
    const sb = startScore(b), ss = startScore(s);
    if (isNaN(sb) || isNaN(ss) || b.m.played < 2) return false;
    if (!(sb >= ss * (b.injTag === 'Q' ? 1.3 : 1.15) && sb - ss >= 2)) return false;   // a questionable bench player has to be clearly better
    return !proven(s) || b.m.good > s.m.good || sb >= ss * 1.3;        // do not bench a proven starter for a mild edge
  };
  // starting slots with nobody in them (for example a dropped kicker): one entry per missing player
  const emptySlots = (players, slots) => {
    const out = [];
    for (const pos of ['QB', 'RB', 'WR', 'TE', SUPERFLEX, 'W/R/T', 'W/R', 'W/T', 'R/T', 'K', 'DEF']) {
      const n = (slots && slots[pos] || 0) - players.filter(p => !/^(BN|IR)$/.test(p.slot) && p.slot === pos).length;
      for (let i = 0; i < n; i++) out.push(pos);
    }
    return out;
  };
  const computeLineup = (players, week, slots) => {
    const starters = players.filter(p => !/^(BN|IR)$/.test(p.slot));
    const bench = players.filter(p => p.slot === 'BN');
    const used = new Set(), fixes = [], swaps = [];
    const best = (list, slot) => list.filter(b => !used.has(b.id) && canPlay(b, week) && slotFits(b, slot))
      .sort((a, b) => ((a.injTag === 'Q' ? 1 : 0) - (b.injTag === 'Q' ? 1 : 0)) || ((isNaN(startValue(b)) ? -1 : startValue(b)) - (isNaN(startValue(a)) ? -1 : startValue(a))))[0];   // healthy first, then best scorer (K/DEF: best projection)
    for (const s of starters) {                       // 1. starters who cannot play this week
      if (canPlay(s, week)) continue;
      const sub = best(bench, s.slot);
      if (sub) used.add(sub.id);
      fixes.push({ slot: s.slot, sit: s, start: sub || null, why: AVAIL_TEXT[availability(s, week)] });
    }
    for (const pos of emptySlots(players, slots)) {
      const sub = best(bench, pos);
      if (sub) used.add(sub.id);
      fixes.push({ slot: pos, sit: null, start: sub || null, why: 'empty' });
    }
    const healthy = starters.filter(s => canPlay(s, week)), cands = [];
    for (const b of bench) {                           // 2. clear upgrades among healthy starters
      if (used.has(b.id) || !canPlay(b, week)) continue;
      for (const s of healthy) if (slotFits(b, s.slot) && betterToStart(b, s)) cands.push({ b, s, gain: byProjection(b, s) ? b.proj - s.proj : startScore(b) - startScore(s) });
    }
    cands.sort((x, y) => y.gain - x.gain);
    const usedS = new Set();
    for (const c of cands) {
      if (used.has(c.b.id) || usedS.has(c.s.id)) continue;
      used.add(c.b.id); usedS.add(c.s.id);
      swaps.push({ slot: c.s.slot, sit: c.s, start: c.b, gain: c.gain });
    }
    return { fixes, swaps, questionable: starters.filter(s => availability(s, week) === 'q') };
  };

  // ---- What you actually need: positions ranked from your own roster (empty slots, byes, injuries, depth, weak starters) ----
  const needsOf = (players, week, slots) => {
    const out = [];
    const push = (pos, score, why) => {
      if (!/^(QB|RB|WR|TE|K|DEF)$/.test(pos)) return;
      const ex = out.find(n => n.pos === pos);
      if (ex) { ex.score = Math.max(ex.score, score); if (!ex.why.includes(why)) ex.why.push(why); } else out.push({ pos, score, why: [why] });
    };
    const starters = players.filter(p => !/^(BN|IR)$/.test(p.slot));
    emptySlots(players, slots).forEach(pos => push(pos === SUPERFLEX ? 'QB' : pos, 100, 'your ' + pos + ' slot is empty'));
    if (slots && slots[SUPERFLEX] && players.filter(q => q.pos === 'QB' && q.slot !== 'IR' && q.out === 0).length < 2) push('QB', 75, 'a second QB is worth far more than a flex player in your ' + SUPERFLEX + ' slot');
    computeLineup(players, week, slots).fixes.filter(f => f.sit && !f.start).forEach(f => push(f.sit.pos, 90, f.sit.name + ' is ' + f.why + ' and nobody on your bench can play ' + f.slot));
    starters.filter(p => p.out === 2).forEach(s0 => push(s0.pos, 70, s0.name + ' is out long-term'));
    starters.filter(p => p.bye > week && p.bye <= week + 3).forEach(s0 => {
      const cover = players.some(q => q.id !== s0.id && q.slot === 'BN' && q.pos === s0.pos && q.out === 0 && q.bye !== s0.bye);
      if (!cover) push(s0.pos, 60 - (s0.bye - week) * 5, s0.name + '’s bye is week ' + s0.bye + ' and you have no other healthy ' + s0.pos);
    });
    ['RB', 'WR'].forEach(pos => { if (!players.some(q => q.slot === 'BN' && q.pos === pos && q.out === 0)) push(pos, 35, 'no healthy ' + pos + ' on your bench'); });
    starters.filter(p => /^(QB|RB|WR|TE)$/.test(p.pos) && p.m && p.m.played >= 3 && p.m.good / p.m.played <= 0.25 && !proven(p))
      .forEach(s0 => push(s0.pos, 30, s0.name + ' has ' + s0.m.good + ' good game' + (s0.m.good === 1 ? '' : 's') + ' in ' + s0.m.played));
    return out.sort((a, b) => b.score - a.score);
  };

  // Your roster: slots from your team page, stats from the same Yahoo views the wire uses.
  const parseRoster = doc => {
    const out = [];
    ['statTable0', 'statTable1', 'statTable2'].forEach(id => {
      const t = doc.getElementById(id); if (!t) return;
      const hr = [...t.rows].find(r => [...r.cells].some(c => txt(c) === 'Bye'));
      const h = hr ? [...hr.cells].map(txt) : [];
      [...t.rows].forEach(r => {
        const a = r.querySelector('a.name'); if (!a) return;
        const c = [...r.cells].map(txt), tp = [...r.querySelectorAll('.Fz-xxs')].map(txt).join(' ');
        const cx = [...r.cells].flatMap(x => Array(x.colSpan || 1).fill(txt(x)));   // aligned to the headers: a bye row's "Bye" spans Fan/Proj/% Start
        const tm = /([A-Za-z.]+)\s*-\s*(QB|RB|WR|TE|K|DEF)\b/.exec(tp) || [];
        out.push({
          slot: c[0], id: playerId(a), name: txt(a), team: tm[1] || '',
          pos: tm[2] || '', bye: h.length ? parseInt(c[h.indexOf('Bye')], 10) : NaN,
          proj: h.includes('Proj Pts') ? num(cx[h.indexOf('Proj Pts')]) : NaN,       // Yahoo's projection for the shown week: shown, never used to judge
          startPct: h.includes('% Start') ? pct(cx[h.indexOf('% Start')]).v : NaN,
          game: (/\b(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2}:\d\d [ap]m (?:vs|@) [A-Za-z]+/.exec(tp) || [])[0] || '',
          injTag: ([...r.querySelectorAll('span')].map(txt).find(s => INJ_TAG.test(s))) || '',
        });
      });
    });
    return out;
  };
  let rosterCache = null, teamHtmlMemo = null;
  const loadRoster = async (week, SL, listPos) => {
    const needKD = listPos === 'K' || listPos === 'DEF';   // K/DEF stats only when you are looking at them
    if (rosterCache && rosterCache.week === week && (rosterCache.kd || !needKD)) return rosterCache;
    // the team page is fetched once per page load: the later kicker/defense pass reuses it
    if (!teamHtmlMemo && onMyTeam) teamHtmlMemo = { t: Date.now(), html: document.documentElement.outerHTML };   // already on your team page: no request
    if (!teamHtmlMemo || Date.now() - teamHtmlMemo.t > 120000) { const res = await yfetch('/f1/' + leagueId + '/' + league.teamId, { credentials: 'include' }); teamHtmlMemo = { t: Date.now(), html: await res.text() }; }
    const doc = new DOMParser().parseFromString(teamHtmlMemo.html, 'text/html');
    const players = parseRoster(doc);
    pending = parsePending(doc);
    if (players.length < 8) { flag('roster', 'Your team page no longer shows the roster tables the extension reads (found ' + players.length + ' players).', true); throw new Error('could not read your roster from Yahoo\'s team page'); }
    const prio = (txt(doc.body).match(/Waiver Priority:\s*(\w+)/) || [])[1] || '';
    // one fetch set per group: every team-filtered list returns only your players
    const groups = { O: players.filter(p => /^(QB|RB|WR|TE)$/.test(p.pos)), K: players.filter(p => p.pos === 'K'), DEF: players.filter(p => p.pos === 'DEF') };
    const mdata = {};
    for (const [g, list] of Object.entries(groups)) {
      if (!list.length || (g !== 'O' && !needKD)) continue;
      const over = { status: 'T', fteam: league.teamId, pos: g, myteam: '1' };
      mdata[g] = await analyze(list.map(p => p.id), week, { weekly: over, research: over }, 1, 1);
    }
    for (const p of players) {
      const g = /^(QB|RB|WR|TE)$/.test(p.pos) ? 'O' : p.pos;
      p.data = mdata[g] || { weekNums: weekRange(week), weekly: Object.fromEntries(weekRange(week).map(w => [w, {}])), research: {} };
      p.m = metrics(p.id, p.pos, p.data, false);
      if (isNaN(p.bye)) p.bye = p.m.bye;
      p.sl = slInfo(SL, p.name, p.pos, p.team);
      p.m.sl = p.sl;
      // a note is only worth a request when Yahoo or Sleeper flags an injury; the rest load when you compare them
      p.note = (p.injTag || (p.sl && p.sl.inj)) ? await fetchNote(p.id) : undefined;
      p.out = outLevel(p);
      p.isStarter = !/^(BN|IR)$/.test(p.slot);
      p.mine = true;
    }
    const irTotal = SLOTS.IR || 0, irUsed = players.filter(p => p.slot === 'IR').length;
    const benchFree = SLOTS.BN ? Math.max(0, SLOTS.BN - players.filter(p => p.slot === 'BN').length) : 0;   // empty bench spots: an add that costs nobody
    rosterCache = { week, kd: needKD, players, prio, irTotal, irUsed, irFree: Math.max(0, irTotal - irUsed), benchFree };
    return rosterCache;
  };

  // Wire candidates for one position: best available by ACTUAL scoring plus whoever Sleeper managers are adding.
  const tagOf = m => {
    if (m.pos === 'K' || m.pos === 'DEF') return null;   // week-to-week noise: a hot streak says little
    if (!m.known || m.played < 2) return null;
    if (m.good / m.played >= 0.75 && m.played >= 3) return 'producer';
    const lastTwo = m.weeks.slice(-2).filter(v => !isNaN(v));
    const breakout = lastTwo.some(v => v >= m.thr * 1.3);
    const momentum = (m.trendKnown && (m.ros.d >= 5 || m.start.d >= 10)) || !!(m.sl && m.sl.hot);
    if (momentum && breakout) return 'rising';
    if (m.sl && m.sl.hot && m.good <= 1) return 'buzz';
    if (USAGE_POS.test(m.pos) && m.good <= 2 && !isNaN(m.oppEarly) && m.oppForm >= 6 && m.oppForm >= m.oppEarly * 1.4) return 'usage';   // more carries/targets before the points show it
    if (m.max >= m.thr * 1.5 && m.good <= 1) return 'spike';
    return null;
  };
  const TAG_LABEL = { producer: 'Consistent', rising: 'Rising', buzz: 'Hype, no record', spike: 'One-week spike', watch: 'Watch', out: 'Out / injured', wkout: 'Out this week', usage: 'Usage up' };
  let radarCache = { sig: '', list: null };
  // o = his row from a Yahoo list (name, team, roster status, injury tag)
  const wireCand = (id, o, pos, data, proj, SL) => {
    const team = o._team || '';
    const p = { id, name: o.name, pos, team, status: o['Roster Status'] || '', injTag: o._inj, data, mine: false };
    p.m = metrics(id, pos, data, true);
    p.bye = p.m.bye;
    p.proj = proj[id] ? num(proj[id]['Fan Pts']) : NaN;
    p.sl = slInfo(SL, o.name, pos, team);
    p.m.sl = p.sl;
    return p;
  };
  // One wire player who may be outside the best-available list (the add page). It reads the same list pages as the scan,
  // which are cached by then, so it costs at most a request or two.
  const loadOne = async (pl, week, SL) => {
    const over = { status: 'A', pos: pl.pos, sort: 'AR', myteam: '0' };
    const data = await analyze([pl.id], week, { weekly: over, research: { status: 'A', pos: pl.pos, myteam: '0' } }, 1, 2);
    const proj = PROJ_POS.test(pl.pos) ? await fetchPage('S_PW_' + week, 0, { status: 'A', pos: pl.pos, sort: 'PTS', myteam: '0' }) : {};
    const o = data.research[pl.id] || data.weekNums.map(w => data.weekly[w][pl.id]).find(Boolean) || {};
    const p = wireCand(pl.id, { ...o, name: pl.name, _team: o._team || pl.team }, pl.pos, data, proj, SL);
    refreshOut(p);
    return p;
  };
  // Yahoo's add page: the player is the first name link, with "NE - WR" in an element of its own just after it
  const readAddPlayer = () => {
    const a = document.querySelector('a.name'), TP = /^([A-Za-z.]+) - (QB|RB|WR|TE|K|DEF)$/;
    let n = a, m = null;
    for (let i = 0; i < 5 && n && !m; i++) { n = n.parentElement; m = n && [...n.querySelectorAll('*')].map(e => TP.exec(txt(e))).find(Boolean); }
    return m ? { id: playerId(a), name: txt(a), team: m[1], pos: m[2] } : null;
  };

  const loadRadar = async (pos, week, SL) => {
    const sig = pos + '|' + week;
    if (radarCache.sig === sig) return radarCache.list;
    const over = { status: 'A', pos, sort: 'AR', myteam: '0' };
    const season = await fetchPage('S_S_2026', 0, over), l4 = await fetchPage('S_AL4W', 0, over);
    const top = d => Object.entries(d).sort((a, b) => a[1]._i - b[1]._i).slice(0, 8);
    const cand = {};
    [...top(season), ...top(l4)].forEach(([id, o]) => { cand[id] = o; });
    // kickers and defenses swing with the matchup, so this week's projection says more than their recent scoring
    const byProj = PROJ_POS.test(pos), proj = byProj ? await fetchPage('S_PW_' + week, 0, { status: 'A', pos, sort: 'PTS', myteam: '0' }) : {};
    Object.entries(proj).sort((a, b) => (num(b[1]['Fan Pts']) || 0) - (num(a[1]['Fan Pts']) || 0)).slice(0, 8).forEach(([id, o]) => { if (!cand[id]) cand[id] = o; });
    const unmatched = [];
    if (SL) {
      const wire = {};
      for (let pg = 0; pg < 2; pg++) Object.assign(wire, await fetchPage('S_S_2026', pg, over));
      const byN = {};
      Object.entries(wire).forEach(([id, o]) => { byN[normName(o.name)] = [id, o]; });
      const hotIds = [...SL.addList, ...SL.addList7d].map(e => e.player_id)
        .filter((id, i, a) => SL.players[id] && SL.players[id].p === pos && a.indexOf(id) === i).slice(0, 12);
      for (const sid of hotIds) {
        const hit = byN[normName(SL.players[sid].n)];
        if (hit) cand[hit[0]] = hit[1]; else unmatched.push(SL.players[sid].n);
      }
    }
    const ids = Object.keys(cand);
    const data = await analyze(ids, week, { weekly: over, research: { status: 'A', pos, myteam: '0' } }, 1, 2);
    const list = ids.map(id => wireCand(id, cand[id], pos, data, proj, SL));
    const pri = { producer: 0, rising: 0, buzz: 1, watch: 2, spike: 3, wkout: 4, out: 5 };
    const rankList = () => {
      list.forEach(refreshOut);
      // injured last; then the most good games (your priority: consistent scorers), then tag, then average
      const pj = p => (isNaN(p.proj) ? -1 : p.proj);
      list.sort((a, b) => (a.out - b.out) || (byProj ? pj(b) - pj(a) : 0) || (b.m.good - a.m.good) || ((pri[a.tag] || 0) - (pri[b.tag] || 0)) || byRecord(b, a));
    };
    rankList();
    // notes cost a request each, so read them only where they matter: every flagged player, plus the best few others
    const flagged = p => !!(p.injTag || (p.sl && p.sl.inj));
    const want = [...list.filter(flagged), ...list.filter(p => !flagged(p)).slice(0, 5)].slice(0, 8);
    const res = list.slice(0, RADAR_SIZE);
    res.unmatched = unmatched.slice(0, 8);
    // the list is shown first; the notes load afterwards and the list is re-ranked when they arrive
    res.notesPending = true;
    res.loadNotes = async () => {
      try {
        for (const p of want) { if (p.note === undefined) p.note = await fetchNote(p.id, isFlagged(p)); }
        rankList();
        res.splice(0, res.length, ...list.slice(0, RADAR_SIZE));
      } finally { res.notesPending = false; }
    };
    radarCache = { sig, list: res };
    return res;
  };



  // ===================================================================================================
  // Daily snapshots: a small record of today's wire, your roster, league activity and Sleeper's market,
  // kept so trends over several days can be shown. At most once a day per league, about 6 Yahoo requests.
  // ===================================================================================================
  const KEEP_DAYS = store ? 60 : 14;      // without extension storage, snapshots share Yahoo's small localStorage quota
  const dayKey = d => { d = d || new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const snapKey = d => 'snap:' + leagueId + ':' + d;
  const snapIdxKey = 'snapidx:' + leagueId;

  // --- pure helpers (unit-tested in Node) ---
  // Split a transaction cell's text into one segment per player: the text after each name, up to the next name.
  const segmentRest = (text, names) => {
    let pos = 0;
    return names.map((nm, i) => {
      const at = text.indexOf(nm, pos); if (at < 0) return { name: nm, rest: '' };
      const nextAt = i + 1 < names.length ? text.indexOf(names[i + 1], at + nm.length) : -1;
      pos = at + nm.length;
      return { name: nm, rest: text.slice(at + nm.length, nextAt < 0 ? text.length : nextAt).trim() };
    });
  };
  const txKind = rest => /To Waivers|To Free Agents?|Dropped/i.test(rest) ? 'drop' : (/Free Agent|Waiver/i.test(rest) ? 'add' : 'move');
  const metaSplit = meta => {
    const m = /^(.*?)\s*([A-Z][a-z]{2} \d{1,2},? \d{1,2}:\d{2} [ap]m)$/.exec(meta || '');
    return m ? { who: m[1].trim(), when: m[2] } : { who: (meta || '').trim(), when: '' };
  };
  const summarizeTx = rows => {
    const adds = {}, drops = {}, who = {};
    rows.forEach(r => {
      (r.adds || []).forEach(a => { adds[a.name] = (adds[a.name] || 0) + 1; });
      (r.drops || []).forEach(d => { drops[d.name] = (drops[d.name] || 0) + 1; });
      if (r.who) who[r.who] = (who[r.who] || 0) + 1;
    });
    const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 8);
    return { adds: top(adds), drops: top(drops), who: top(who), n: rows.length };
  };
  // Players on the wire whose % rostered changed between the oldest and newest snapshot in the window.
  const computeMovers = snaps => {
    if (snaps.length < 2) return [];
    const first = {}, latest = snaps[snaps.length - 1];
    snaps.forEach(sn => Object.values(sn.wire || {}).flat().forEach(p => { if (!(p.id in first) && !isNaN(p.ros)) first[p.id] = { ros: p.ros, date: sn.date }; }));
    const out = [];
    Object.entries(latest.wire || {}).forEach(([pos, list]) => list.forEach(p => {
      if (first[p.id] && !isNaN(p.ros) && first[p.id].date !== latest.date) out.push({ id: p.id, name: p.name, pos, from: first[p.id].ros, to: p.ros, d: p.ros - first[p.id].ros, since: first[p.id].date });
    }));
    return out.filter(x => x.d !== 0).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  };
  // Consecutive most-recent days a player has been in Sleeper's top adds.
  const computeStreaks = snaps => {
    const latest = snaps[snaps.length - 1], out = [];
    if (!latest || !latest.sleeper) return out;
    (latest.sleeper.add24 || []).slice(0, 30).forEach(([id, cnt]) => {
      let streak = 0;
      for (let i = snaps.length - 1; i >= 0; i--) { if ((snaps[i].sleeper?.add24 || []).slice(0, 50).some(e => e[0] === id)) streak++; else break; }
      out.push({ id, name: (latest.sleeper.names || {})[id] || id, count: cnt, streak });
    });
    return out.filter(x => x.streak >= 2).sort((a, b) => b.streak - a.streak || b.count - a.count);
  };

  // --- collection and storage ---
  // Yahoo's transaction table: one <div class="Pbot-xs"> per player in a row (added player first), with the
  // source in an <h6> ("Free Agent", "Waiver", "To Waivers"). Player links are plain anchors under /players/.
  const parseTransactions = doc => {
    const PL = 'a[href*="/players/"]';
    const t = [...doc.querySelectorAll('table')].filter(x => x.querySelector(PL)).sort((a, b) => b.rows.length - a.rows.length)[0];
    if (!t) return [];
    return [...t.rows].filter(r => r.querySelector(PL)).slice(0, 60).map(r => {
      let segs = [...r.querySelectorAll('div.Pbot-xs')].filter(d => d.querySelector(PL)).map(d => {
        const a = d.querySelector(PL), np = d.querySelector('[data-ys-playerid]'), detail = txt(d.querySelector('h6'));
        return { id: np ? np.getAttribute('data-ys-playerid') : playerId(a), name: txt(a), tp: txt(d.querySelector('.F-position')), rest: detail, kind: txKind(detail) };
      });
      if (!segs.length) {   // fallback: split the cell text by player names
        const pc = [...r.cells].find(c => c.querySelector(PL)), anchors = [...pc.querySelectorAll(PL)].filter(a => txt(a));
        segs = segmentRest(txt(pc), anchors.map(txt)).map((sg, i) => ({ id: playerId(anchors[i]), name: sg.name, rest: sg.rest, kind: txKind(sg.rest) }));
      }
      const cells = [...r.cells], meta = metaSplit(txt(cells[cells.length - 1]));
      return { adds: segs.filter(x => x.kind === 'add'), drops: segs.filter(x => x.kind === 'drop'), who: meta.who, when: meta.when, raw: txt(r).slice(0, 240) };
    });
  };
  // Widely rostered players another manager just let go: rare, and usually the best add of the week.
  // Rows are newest first, so an add seen before a drop means he was picked up again afterwards.
  const DROP_DAYS = 4, DROP_ROS = 70, DROP_MAX = 4;
  const MONTHS = 'JanFebMarAprMayJunJulAugSepOctNovDec';
  const txDate = when => {
    const m = /^([A-Z][a-z]{2}) (\d{1,2})\b/.exec(when || ''), i = m ? MONTHS.indexOf(m[1]) : -1;
    if (i < 0 || i % 3) return null;
    const now = new Date(), d = new Date(now.getFullYear(), i / 3, +m[2]);
    if (d - now > 864e5) d.setFullYear(d.getFullYear() - 1);   // a December drop read in January
    return d;
  };
  const notableDrops = async (tx, mine) => {
    const taken = new Set(), seen = new Set(), cands = [];
    for (const r of tx) {
      const at = txDate(r.when);
      (r.drops || []).forEach(d => {
        if (!d.id || seen.has(d.id) || taken.has(d.id) || mine.has(d.id) || !at || Date.now() - at > DROP_DAYS * 864e5) return;
        seen.add(d.id); cands.push({ id: d.id, name: d.name, tp: d.tp || '', who: r.who, when: r.when });
      });
      (r.adds || []).forEach(a => taken.add(a.id));
    }
    const out = [], checked = cands.slice(0, DROP_MAX);
    for (const c of checked) {
      await fetchNote(c.id, true, true);
      const info = cacheGet('pinfo:' + leagueId + ':' + c.id, CACHE_MIN);
      if (info && info.ros >= DROP_ROS && /^(Waivers|Free Agent)/i.test(info.status)) out.push(Object.assign(c, info));
    }
    return { drops: out, checked: checked.length };
  };
  let dropAlerts = [];
  const dropBanner = R => {
    const mine = new Set(R.players.map(p => p.id)), list = dropAlerts.filter(d => !mine.has(d.id));
    if (!list.length) return null;
    const box = el('div', 'ff-verdict yes');
    box.appendChild(el('div', 'hd', 'Just dropped in your league: ' + list.map(d => d.name).join(', ')));
    list.forEach(d => {
      const row = el('div', 'sub'), btn = el('button', 'ff-btn', 'Look him up');
      row.append(d.name + (d.tp ? ' (' + d.tp + ')' : '') + ': ' + d.ros + '% rostered across Yahoo, dropped by ' + d.who + ' ' + d.when + ', now on ' + d.status + '. ');
      btn.onclick = e => { e.stopPropagation(); goToPlayer(d); };
      row.appendChild(btn); box.appendChild(row);
    });
    box.appendChild(el('div', 'ff-hint', 'As of today\'s snapshot. Players this widely rostered are rarely free, so read his note, then claim him before someone else does.'));
    return box;
  };
  // Your own pending claims/trades: a suggestion that is already queued should say so
  let pending = null;
  // Yahoo lists them on your team page: a "Pending Transactions" box with rows like "Waiver 1 (Oct 14): Player Name Add"
  const parsePending = doc => {
    const d = { adds: [], drops: [], any: [] };
    const head = [...doc.querySelectorAll('span,div,h2,h3,h4')].find(e => e.children.length === 0 && txt(e) === 'Pending Transactions');
    let box = head;
    while (box && !box.querySelector('.notes-module')) box = box.parentElement;
    if (!box) { if (/Pending Transactions/.test(doc.body ? doc.body.textContent : '')) flag('pending', 'Your pending transactions box changed shape, so queued claims may not be recognised.', false); return d; }
    // Two layouts: add-only reads "<name>" then a bold "Add"; add+drop reads "Add <name>, Drop <name>". Handle both.
    box.querySelectorAll('.notes-module a').forEach(a => {
      const line = (a.querySelector('.Bfc') || a).cloneNode(true);
      line.querySelectorAll('.Absolute').forEach(x => x.remove());
      const text = txt(line).replace(/^.*?\):\s*/, '').trim();
      const push = (kind, name) => { name = name.replace(/[,\s]+$/, '').trim(); if (!name) return; const rec = { id: '', name }; (kind === 'Add' ? d.adds : d.drops).push(rec); d.any.push(rec); };
      if (/^(Add|Drop)\s/.test(text)) text.split(/,\s*(?=(?:Add|Drop)\s)/).forEach(part => { const m = /^(Add|Drop)\s+(.+)$/.exec(part.trim()); if (m) push(m[1], m[2]); });
      else { const m = /^(.+?)\s*(Add|Drop)$/.exec(text); if (m) push(m[2], m[1]); }
    });
    return d;
  };
  // Yahoo shows a defense as a city on your roster ("Chicago") but as a nickname in pending claims ("Bears")
  const DEF_ALIASES = { cardinals: 'arizona', falcons: 'atlanta', ravens: 'baltimore', bills: 'buffalo', panthers: 'carolina', bears: 'chicago', bengals: 'cincinnati', browns: 'cleveland',
    cowboys: 'dallas', broncos: 'denver', lions: 'detroit', packers: 'green bay', texans: 'houston', colts: 'indianapolis', jaguars: 'jacksonville', chiefs: 'kansas city',
    raiders: 'las vegas|lv', chargers: 'los angeles chargers|la chargers', rams: 'los angeles rams|la rams', dolphins: 'miami', vikings: 'minnesota', patriots: 'new england',
    saints: 'new orleans', giants: 'new york giants|ny giants', jets: 'new york jets|ny jets', eagles: 'philadelphia', steelers: 'pittsburgh', '49ers': 'san francisco',
    seahawks: 'seattle', buccaneers: 'tampa bay', titans: 'tennessee', commanders: 'washington' };
  const defKeys = {};
  Object.entries(DEF_ALIASES).forEach(([nick, cities]) => { defKeys[nick] = nick; cities.split('|').forEach(c => { defKeys[c] = nick; }); });
  const nameKey = n => { const k = String(n || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/^the /, '').replace(/\s+(d\/st|defense|dst)$/, '').replace(/\s+/g, ' ').trim(); return defKeys[k] || normName(n); };
  const inPending = (p, list) => !!(pending && p && (pending[list] || []).some(x => (x.id && x.id === p.id) || nameKey(x.name) === nameKey(p.name)));
  const pendingGuard = (res, c, r) => {
    const add = c && (inPending(c, 'adds') || (inPending(c, 'any') && !inPending(c, 'drops')));
    const drop = r && !r.isFree && inPending(r, 'drops');
    if (!add && !drop) return res;
    const both = add && drop;
    return Object.assign({}, res, { kind: 'meh', headline: both ? 'ALREADY PENDING: this exact move is queued' : 'ALREADY PENDING: ' + (add ? c.name + ' is on a pending add' : r.name + ' is on a pending drop'),
      sub: 'Your pending transactions already include ' + (both ? 'adding ' + c.name + ' and dropping ' + r.name : add ? 'adding ' + c.name : 'dropping ' + r.name) + '. Check Yahoo\'s pending transactions before queueing anything else. Underlying verdict: ' + res.headline });
  };
  const getSnapIndex = async () => (await kvGet(snapIdxKey)) || [];
  const loadSnaps = async (days) => {
    const idx = (await getSnapIndex()).slice(-days), out = [];
    for (const d of idx) { const doc = await kvGet(snapKey(d)); if (doc) out.push(doc); }
    return out;
  };
  const saveSnap = async doc => {
    await kvSet(snapKey(doc.date), doc);
    const idx = new Set(await getSnapIndex()); idx.add(doc.date);
    const arr = [...idx].sort();
    while (arr.length > KEEP_DAYS) await kvRemove(snapKey(arr.shift()));
    await kvSet(snapIdxKey, arr);
  };
  let snapRunning = false, snapStatus = '';
  const takeSnapshot = async (roster, SL, week, force) => {
    if (snapRunning) return null;
    const date = dayKey();
    if (!force && (await getSnapIndex()).includes(date)) {                 // already have today's, unless it came out incomplete
      const cur = await kvGet(snapKey(date));
      if (cur && cur.drops) dropAlerts = cur.drops;
      if (!cur || (cur.tx || []).length || Date.now() - (cur.ts || 0) < 3600000) return null;
    }
    if (Date.now() < blockedUntil()) return null;                          // Yahoo asked us to back off
    snapRunning = true; snapStatus = 'Taking today\'s snapshot...';
    try {
      const before = yCount, doc = { date, ts: Date.now(), week, wire: {}, roster: [], tx: [], sleeper: {} };
      doc.roster = roster.players.map(p => ({ id: p.id, name: p.name, pos: p.pos, slot: p.slot, good: p.m.good, played: p.m.played, avg: isNaN(p.m.avg) ? null : +p.m.avg.toFixed(1), out: p.out }));
      for (const pos of ['QB', 'RB', 'WR', 'TE', 'K']) {
        const d = await fetchPage('S_S_2026', 0, { status: 'A', pos, sort: 'AR', myteam: '0' });   // usually already cached by the radar
        doc.wire[pos] = Object.entries(d).sort((a, b) => a[1]._i - b[1]._i).slice(0, 25).map(([id, o]) => ({ id, name: o.name, team: o._team || '', ros: pct(o['% Ros']).v, pts: num(o['Fan Pts']), status: (o['Roster Status'] || '').slice(0, 16) }));
      }
      const tres = await yfetch('/f1/' + leagueId + '/transactions', { credentials: 'include' });
      if (tres.ok) doc.tx = parseTransactions(new DOMParser().parseFromString(await tres.text(), 'text/html'));
      if (!doc.tx.length) flag('tx', 'The transactions page showed no readable rows, so trends will be incomplete.', false);
      const nd = await notableDrops(doc.tx, new Set(roster.players.map(p => p.id)));
      doc.drops = dropAlerts = nd.drops; doc.dropChecks = nd.checked;
      if (SL) {
        const slim = list => list.slice(0, 50).map(e => [e.player_id, e.count]);
        doc.sleeper = { add24: slim(SL.addList), drop24: Object.entries(SL.drop24).sort((a, b) => a[1].rank - b[1].rank).slice(0, 50).map(([id, v]) => [id, v.count]), add7d: slim(SL.addList7d), names: {} };
        [...doc.sleeper.add24, ...doc.sleeper.drop24, ...doc.sleeper.add7d].forEach(([id]) => { if (SL.players[id]) doc.sleeper.names[id] = SL.players[id].n; });
      }
      doc.yahooRequests = yCount - before;
      await saveSnap(doc);
      snapStatus = 'Snapshot saved for ' + date + ' (' + doc.yahooRequests + ' Yahoo requests).';
      return doc;
    } catch (e) { snapStatus = 'Snapshot skipped: ' + (e && e.message); return null; }
    finally { snapRunning = false; }
  };
  const downloadSnaps = async () => {
    const all = await loadSnaps(KEEP_DAYS);
    const blob = new Blob([JSON.stringify({ league: league.name, leagueId, exported: new Date().toISOString(), snapshots: all }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'fantasy-snapshots-' + leagueId + '-' + dayKey() + '.json';
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };

  // ===================================================================================================
  // Stash watch: injured players who may be worth holding until they return
  // ===================================================================================================
  // Read an expected return week from a note: ranges ("12-16 weeks", "3-to-4 months"), week-to-week,
  // a bare IR placement (at least 4 games), one-game absences, or out for the season.
  const parseReturn = (note, week) => {
    if (!note) return { kind: 'unknown', label: 'No Yahoo note' };
    const full = note.text.slice(0, 800), lead = full.split(/Advice:/)[0];
    if (/out for the (rest of the )?season|season-ending|done for the season/i.test(full)) return { kind: 'season', label: 'out for the season' };
    let m = /(\d+)\s*(?:-|to|–)\s*(?:to-)?\s*(\d+)\s*(weeks|months)/i.exec(full), lo, hi, unit;
    if (m) { lo = +m[1]; hi = +m[2]; unit = m[3]; }
    else { m = /(\d+)\s*(weeks|months)/i.exec(full); if (m) { lo = hi = +m[1]; unit = m[2]; } }
    if (m) { const k = /months/i.test(unit) ? 4.3 : 1; return { kind: 'range', lo: Math.round(week + lo * k), hi: Math.round(week + hi * k), label: m[0] }; }
    if (/week-to-week/i.test(full)) return { kind: 'range', lo: week + 1, hi: week + 4, label: 'week-to-week' };
    if (/placed on (the )?([\w' -]{0,24})?injured reserve|designated for return/i.test(full)) return { kind: 'ir', lo: week + 4, hi: week + 8, label: 'on IR: at least 4 games, no date given' };
    if (WEEK_OUT.test(lead)) return { kind: 'short', lo: week + 1, hi: week + 1, label: 'out this week only' };
    return { kind: 'unknown', label: 'no timeline in the note' };
  };
  const stashFit = ret => {
    const P = PLAYOFF_START, span = ret.lo === ret.hi ? 'wk ' + ret.lo : 'wk ' + ret.lo + '-' + ret.hi;
    if (ret.kind === 'season') return { k: 'no', t: 'Out for the season' };
    if (ret.kind === 'unknown') return { k: 'unk', t: 'No return date in the note: read it yourself' };
    if (ret.lo > P + 1) return { k: 'no', t: 'Back around ' + span + ', after your playoffs start (wk ' + P + ')' };
    if (ret.hi <= P - 3) return { k: 'good', t: 'Back around ' + span + ', at least 3 weeks before playoffs (wk ' + P + ')' };
    return { k: 'tight', t: 'Back around ' + span + ': tight against your playoffs (wk ' + P + ')' };
  };
  const stashQuality = p => {
    const r = isNaN(p.perGame) ? 0 : p.perGame / p.m.thr;
    return { r, k: r >= 1.05 ? 'good' : (r >= 0.85 ? 'ok' : 'weak') };
  };
  const stashVerdict = (c, R) => {
    const free = R.irFree > 0, sug = suggestReplace(R);
    const costTxt = free ? 'It costs nothing: your open IR slot takes him (your league lets you add an injured player straight to IR).'
      : 'It costs a bench spot' + (sug ? ': your weakest bench player is ' + sug.name + ' (' + sug.m.good + '/' + (sug.m.played || '?') + ' good games).' : '.');
    const perGame = 'He averaged ' + f1(c.perGame) + ' pts a game before the injury (a good game for a ' + c.pos + ' is ' + c.m.thr + '+).';
    if (c.fit.k === 'no') return { kind: 'no', headline: 'SKIP ' + c.name, sub: c.fit.t + '. Holding him cannot help your season.' };
    if (c.q.k === 'weak') return { kind: 'no', headline: 'SKIP ' + c.name, sub: perGame + ' That is below a good game, so he is not worth a roster spot even when healthy.' };
    if (c.fit.k === 'unk') return { kind: 'meh', headline: 'CHECK ' + c.name + ': no return date', sub: perGame + (c.note === undefined ? ' His note is still loading.' : ' The note gives no timeline, so read it before spending a spot.') + ' ' + costTxt };
    if (c.fit.k === 'tight') return { kind: 'meh', headline: 'RISKY STASH: ' + c.name, sub: c.fit.t + '. ' + perGame + ' ' + costTxt };
    return free ? { kind: 'yes', headline: 'STASH ' + c.name + ' in your open IR slot', sub: c.fit.t + '. ' + perGame + ' ' + costTxt }
      : { kind: 'meh', headline: 'STASH ' + c.name + ' only if you can spare a bench spot', sub: c.fit.t + '. ' + perGame + ' ' + costTxt };
  };
  // worth-a-look first: productive players with a workable return, then unknown timelines;
  // low-output players and players who return too late sink to the bottom as "skip"
  const stashTier = c => (c.fit.k === 'no' || c.q.k === 'weak') ? 3 : { good: 0, tight: 1, unk: 2 }[c.fit.k];
  const setStashReturn = (c, week) => {
    c.ret = c.note === undefined ? { kind: 'unknown', label: 'note not loaded yet' } : parseReturn(c.note, week);
    c.fit = stashFit(c.ret); c.tier = stashTier(c);
  };
  let stashData = null;
  // Light on Yahoo: 4 list pages (one per position) + one note per candidate. Weekly scans are skipped, so
  // production comes from season totals and games played (points per game before the injury).
  const loadStash = async (week, SL) => {
    const POS = ['QB', 'RB', 'WR', 'TE'], list = [];
    for (const pos of POS) {
      const d = await fetchPage('S_S_2026', 0, { status: 'STATE_IR', pos, sort: 'AR', myteam: '0' });
      Object.entries(d).sort((a, b) => a[1]._i - b[1]._i).slice(0, 4).forEach(([id, o]) => {
        const p = { id, name: o.name, pos, team: o._team || '', status: o['Roster Status'] || '', injTag: o._inj, mine: false, data: { weekNums: [] } };
        p.m = { thr: GOOD[pos] || 8, weeks: [], good: 0, played: 0, avg: NaN, adp: NaN, trendKnown: false, ros: { v: NaN, d: 0 }, start: { v: NaN, d: 0 } };
        p.seasonPts = num(o['Fan Pts']); p.gp = num(o['GP*']); p.perGame = p.gp > 0 ? p.seasonPts / p.gp : NaN;
        p.preRank = num(o['Pre-Season']);
        p.sl = slInfo(SL, o.name, pos, p.team); p.m.sl = p.sl;
        list.push(p);
      });
    }
    for (const p of list) p.q = stashQuality(p);
    // a note costs a request, so read only the six most productive; the rest load when you click them
    for (const p of [...list].filter(p => p.q.k !== 'weak').sort((a, b) => b.q.r - a.q.r).slice(0, 6)) p.note = await fetchNote(p.id);
    list.forEach(c => setStashReturn(c, week));
    list.sort((a, b) => (a.tier - b.tier) || (b.q.r - a.q.r));
    return { week, list };
  };

  // ===================================================================================================
  // Comparison engine: candidate vs the player you would replace. Every check shows who wins and why.
  // ===================================================================================================
  const f1 = v => (isNaN(v) ? '-' : v.toFixed(1));
  const signed = d => (d > 0 ? '+' : '') + d;
  const ratio = p => (isNaN(p.m.avg) ? 0 : p.m.avg / p.m.thr);
  const depthRank = p => { const d = parseInt((p.m.depth.match(/\d+/) || [])[0], 10); return isNaN(d) ? NaN : d; };
  const momentumScore = p => {
    const m = p.m;
    return (m.trendKnown ? (m.ros.d >= 5 ? 1 : 0) + (m.start.d >= 10 ? 1 : 0) - (m.ros.d <= -5 ? 1 : 0) - (m.start.d <= -10 ? 1 : 0) : 0) +
      (m.sl && m.sl.hot ? 1 : 0) - (m.sl && m.sl.drop && m.sl.add && m.sl.drop.count > m.sl.add.count ? 1 : 0);
  };
  const healthText = p => {
    const bits = [];
    const k = classify(p.note, p.name);
    if (p.injTag) bits.push('Yahoo: ' + p.injTag);
    if (p.sl && p.sl.inj) bits.push('Sleeper: ' + p.sl.inj + (p.sl.body ? ' (' + p.sl.body + ')' : ''));
    if (k === 'long') bits.push('note says long-term absence');
    else if (k === 'week') bits.push('note says out this week');
    return bits.length ? bits.join('; ') : 'No injury flags';
  };

  // Returns { checks: [{label, weight, edge (+1 candidate / -1 replace / 0), a: [..lines], b: [..lines], bars}], score, verdict }
  const compare = (c, r, ctxInfo) => {
    const checks = [];
    const add = (label, weight, edge, a, b, extra) => checks.push({ label, weight, edge, a, b, ...(extra || {}) });

    // 1. scoring record
    let e = 0;
    if (c.m.good !== r.m.good) e = c.m.good > r.m.good ? 1 : -1;
    else if (Math.abs(ratio(c) - ratio(r)) >= 0.25) e = ratio(c) > ratio(r) ? 1 : -1;
    const line = p => p.m.good + ' of ' + (p.m.played || '?') + ' good games (' + p.m.thr + '+ pts), avg ' + f1(p.m.avg);
    add('Scoring record, last 4 weeks', 3, e, [line(c)], [line(r)], { bars: true });
    // 2. recent form
    const fe = (isNaN(c.m.form) || isNaN(r.m.form)) ? 0 : (c.m.form / c.m.thr - r.m.form / r.m.thr >= 0.25 ? 1 : (r.m.form / r.m.thr - c.m.form / c.m.thr >= 0.25 ? -1 : 0));
    add('Last 2 weeks', 2, fe, [formText(c.m)], [formText(r.m)]);
    // 2b. usage: carries + targets per game, same position only
    if (USAGE_POS.test(c.pos) || USAGE_POS.test(r.pos)) {
      const comparable = c.pos === r.pos && !isNaN(c.m.oppAvg) && !isNaN(r.m.oppAvg);
      const ue = !comparable ? 0 : (c.m.oppAvg >= r.m.oppAvg * 1.2 && c.m.oppAvg - r.m.oppAvg >= 2 ? 1 : (r.m.oppAvg >= c.m.oppAvg * 1.2 && r.m.oppAvg - c.m.oppAvg >= 2 ? -1 : 0));
      const ul = p => (usageText(p.m) || 'usage n/a') + (comparable || isNaN(p.m.oppAvg) ? '' : ' (not comparable across positions)');
      add('Usage: carries + targets', 3, ue, [ul(c)], [ul(r)]);
    }
    // 3. momentum
    const ms = momentumScore(c) - momentumScore(r);
    const mom = p => [p.m.trendKnown ? 'Yahoo: rostered ' + p.m.ros.v + '% (' + signed(p.m.ros.d) + '), started ' + p.m.start.v + '% (' + signed(p.m.start.d) + ')' : 'Yahoo trend n/a',
      p.sl ? (p.sl.add ? 'Sleeper: ' + p.sl.add.count.toLocaleString() + ' adds in 24h (#' + p.sl.add.posRank + ' at pos)' : 'Sleeper: not trending') : 'Sleeper: no match'];
    add('Momentum: who is adding him', 2, ms > 0 ? 1 : (ms < 0 ? -1 : 0), mom(c), mom(r));
    // 3b. kickers and defenses: this week's matchup, as Yahoo projects it (a player on bye scores zero)
    const wkProj = p => (p.bye === ctxInfo.week ? 0 : p.proj);
    if (PROJ_POS.test(c.pos) && c.pos === r.pos && !isNaN(wkProj(c)) && !isNaN(wkProj(r))) {
      const d = wkProj(c) - wkProj(r), pl = p => [f1(wkProj(p)) + ' pts' + (p.bye === ctxInfo.week ? ' (bye)' : '')];
      add('This week\'s projection', 3, d >= 1.5 ? 1 : (d <= -1.5 ? -1 : 0), pl(c), pl(r));
    }
    // 4. role
    const dc = depthRank(c), dr = depthRank(r);
    const samePos = c.pos === r.pos;   // "RB2 vs WR1" says nothing, so only compare roles at the same position
    add('Role on his team', 2, (!samePos || isNaN(dc) || isNaN(dr)) ? 0 : (dc < dr ? 1 : (dc > dr ? -1 : 0)),
      [(c.m.depth ? 'Depth chart ' + c.m.depth : 'Depth chart n/a') + (samePos ? '' : ' (not comparable across positions)')],
      [(r.m.depth ? 'Depth chart ' + r.m.depth : 'Depth chart n/a') + (samePos ? '' : ' (not comparable across positions)')]);
    // 5. health and news (heaviest: a bad note can veto)
    const ch = c.out, rh = r.out;
    const noteLine = p => (p.note === undefined ? 'Note loading...' : p.note ? 'Note (' + p.note.date + '): ' + (p.note.text.length > 150 ? p.note.text.slice(0, 150) + '...' : p.note.text) : 'No Yahoo note');
    // if the player being replaced is already out, a healthy candidate is not a real "win": that spot is dead either way
    add('Health and news', rh > ch ? 0 : 3, ch === rh ? 0 : (ch < rh ? 1 : -1), [healthText(c), noteLine(c)], [healthText(r), noteLine(r)], { note: true });
    // 6. pedigree
    const pe = (isNaN(c.m.adp) || isNaN(r.m.adp) || Math.abs(c.m.adp - r.m.adp) < 30) ? 0 : (c.m.adp < r.m.adp ? 1 : -1);
    add('Draft pedigree', 1, pe, [isNaN(c.m.adp) ? 'Undrafted or n/a' : 'Avg draft pick ' + c.m.adp], [isNaN(r.m.adp) ? 'Undrafted or n/a' : 'Avg draft pick ' + r.m.adp]);
    // 7. bye fit
    const myPosByes = ctxInfo.roster.filter(p => p.pos === c.pos && p.id !== r.id).map(p => p.bye);
    const clash = !isNaN(c.bye) && myPosByes.includes(c.bye);
    add('Bye week', 1, clash ? -1 : 0, ['Bye wk ' + (isNaN(c.bye) ? '?' : c.bye) + (clash ? ': overlaps another of your ' + c.pos + 's' : '')], ['Bye wk ' + (isNaN(r.bye) ? '?' : r.bye)]);

    // 8. lineup impact: would he actually start for you, or cover a bye? Depth-only adds should not read as upgrades.
    const sameStarters = ctxInfo.roster.filter(p => p.isStarter && p.pos === c.pos);
    const weakS = [...sameStarters].sort((a, b) => ratio(a) - ratio(b))[0];
    // to displace a proven starter (good record or drafted early) he must also have the higher average, not just one more good game
    const beats = !weakS || ((c.m.good > weakS.m.good || (c.m.good === weakS.m.good && ratio(c) - ratio(weakS) >= 0.15)) && (!proven(weakS) || ratio(c) > ratio(weakS)));
    const covered = sameStarters.find(p => p.bye >= ctxInfo.week && p.bye <= ctxInfo.week + 3 && p.bye !== c.bye);
    const starterNames = sameStarters.map(p => p.name + ' (' + p.m.good + '/' + (p.m.played || '?') + ' good, avg ' + f1(p.m.avg) + ')').join('; ');
    if (beats) add('Would he start for you?', 3, 1, ['Yes: would start over ' + (weakS ? weakS.name : 'an empty ' + c.pos + ' slot')], [weakS ? 'Your weakest ' + c.pos + ' starter: ' + weakS.name : 'No ' + c.pos + ' starter']);
    else if (covered) add('Would he start for you?', covered.bye === ctxInfo.week && !ctxInfo.roster.some(q => q.pos === c.pos && q.slot === 'BN' && q.out === 0 && q.bye !== ctxInfo.week) ? 3 : 1, 1, ['Only as bye cover: replaces ' + covered.name + ' in wk ' + covered.bye + ', then sits on your bench'], ['Your ' + c.pos + ' starters: ' + starterNames]);
    else add('Would he start for you?', 3, -1, ['No: your ' + c.pos + ' starters are ahead of him, so this is depth only'], ['Your ' + c.pos + ' starters: ' + starterNames]);

    const spareOf = !r.isFree && surplusStarter(ctxInfo.roster, ctxInfo.week, r);
    if (spareOf) add('Needed on your roster?', 2, 1, ['-'], [(FLEX[r.slot] ? 'Second ' + r.pos + ': he only starts at ' + r.slot + ', which any RB/WR can fill. ' : 'Backup only. ') + 'Your top ' + r.pos + ' is ' + spareOf.name + ', whose bye (wk ' + spareOf.bye + ') is done.']);
    if (!r.isFree && coversBye(ctxInfo.roster, ctxInfo.week, r)) add('Needed this week?', 3, -1, ['Not needed: no starter of his is on bye'], [r.name + ' is your only healthy bench ' + r.pos + ' and a ' + r.pos + ' starter is on bye this week']);
    const score = checks.reduce((s, k) => s + k.weight * k.edge, 0);
    const wins = checks.filter(k => k.edge > 0), losses = checks.filter(k => k.edge < 0);
    // filling a starting slot that would otherwise be empty this week is worth more than a bench player's track record
    const fillsEmpty = !!(covered && !beats && covered.bye === ctxInfo.week && !ctxInfo.roster.some(q => q.pos === c.pos && q.slot === 'BN' && q.out === 0 && q.bye !== ctxInfo.week));
    const protectedR = !r.isFree && !spareOf && ((proven(r) && !(fillsEmpty && !r.isStarter)) || r.isStarter);
    // with nobody at the position, any decent player beats an empty slot: the volatility discount only applies to a real swap
    const emptyPos = !ctxInfo.roster.some(q => q.pos === c.pos && q.slot !== 'IR');
    const noisy = (c.pos === 'K' || c.pos === 'DEF') && !emptyPos;   // kickers and defenses swing wildly week to week
    const need = (protectedR ? 6 : 3) + (noisy ? 3 : 0);
    // opportunity gap: at the same position, a candidate getting under half the work of the player he replaces is not an upgrade,
    // whatever his points, momentum or buzz say (points on little work rarely last)
    const oppGap = USAGE_POS.test(c.pos) && c.pos === r.pos && !r.isFree && r.out === 0 && !isNaN(c.m.oppAvg) && !isNaN(r.m.oppAvg) && r.m.oppAvg >= 6 && c.m.oppAvg < r.m.oppAvg * 0.5;
    let kind, headline, sub;
    const top = list => [...list].sort((a, b) => b.weight - a.weight).slice(0, 3).map(k => k.label.toLowerCase().replace(/, last 4 weeks|: who is adding him/, '')).join(', ');
    if (c.out === 2) {
      kind = 'no'; headline = "DON'T ADD " + c.name;
      sub = 'He is out long-term (' + healthText(c) + '). His numbers are history, not what you would get.';
    } else if (r.isFree) {
      const lineupOk = beats || !!covered;
      kind = c.out === 1 ? 'meh' : ((c.m.good >= 2 || c.tag === 'rising' || c.tag === 'producer') && lineupOk ? 'yes' : 'meh');
      headline = (kind === 'yes' ? 'ADD ' : 'OPTIONAL: ') + c.name + ' for free';
      sub = 'Your IR slot is open: move ' + r.irPlayer.name + ' (' + healthText(r.irPlayer) + ') to IR, then add him without dropping anyone.' + (kind === 'meh' ? (lineupOk ? ' He has no strong case yet, so the open spot may be worth more later.' : ' He would not start for you, so this is depth only and the open spot may be worth more later.') : '');
    } else if (c.out === 1) {
      kind = 'meh'; headline = 'WAIT on ' + c.name;
      sub = 'Ruled out this week per the latest note. A claim does not help until he is back.';
    } else if (oppGap && score >= need) {
      kind = 'meh'; headline = 'KEEP ' + r.name + ': ' + c.name + ' gets far less work';
      sub = c.name + ' wins on paper (score ' + score + '), but he averages ' + f1(c.m.oppAvg) + ' carries + targets a game against ' + f1(r.m.oppAvg) + ' for ' + r.name + '. Scoring on that little work rarely lasts, so this is not an upgrade yet.';
    } else if ((score >= need || (r.out >= 1 && score > 0)) && !beats && !covered) {
      // wins on paper but would never be in your lineup: a bench-only add is not an upgrade
      kind = 'meh'; headline = 'DEPTH ONLY: ' + c.name + ' would not start for you';
      sub = 'He edges ' + r.name + (r.out >= 1 ? ' (who is out)' : '') + ' on paper (score ' + score + '), but your ' + c.pos + ' starters are ahead of him, so this only fills a bench spot. Add him only if that spot has no better use.';
    } else if (noisy && score >= need) {
      kind = 'meh'; headline = 'MARGINAL: ' + c.name + ' over ' + r.name;
      sub = c.name + ' is ahead on recent points, but ' + c.pos + ' scoring swings week to week, so recent points predict little. Stream by matchup each week instead of chasing a hot stretch.';
    } else if (score >= need) {
      kind = 'yes'; headline = 'ADD ' + c.name + ', DROP ' + r.name;
      sub = c.name + ' wins ' + wins.length + ' of ' + checks.length + ' checks, mainly: ' + top(wins) + '.' + (losses.length ? ' He loses on: ' + top(losses) + '.' : '') +
        (!beats && covered ? ' Note: he would start only in wk ' + covered.bye + ' (during ' + covered.name + ' bye), then sit on your bench.' : '');
    } else if (score > 0) {
      kind = 'meh'; headline = 'KEEP ' + r.name + ' (small edge for ' + c.name + ')';
      sub = 'Edge is real but small (score ' + score + ', need ' + need + (protectedR ? ' because ' + r.name + ' ' + (r.isStarter ? 'is in your lineup' : 'has a track record') : '') + '). ' + (protectedR ? 'Do not risk a proven player for a mild difference.' : 'That is not enough of a difference to spend a claim.');
    } else {
      kind = 'no'; headline = 'KEEP ' + r.name;
      sub = c.name + ' does not beat him' + (losses.length ? ': ' + r.name + ' is ahead on ' + top(losses) + '.' : '.');
    }
    return { checks, score, need, kind, headline, sub };
  };

  // ===================================================================================================
  // UI
  // ===================================================================================================
  const CSS = `
  #ff-tray{position:fixed;top:0;right:0;height:100vh;width:var(--ffw,560px);max-width:94vw;z-index:2147483000;background:#fff;color:#111;border-left:3px solid #6001d2;box-shadow:-6px 0 24px rgba(0,0,0,.28);display:flex;flex-direction:column;transform:translateX(0);transition:transform .22s ease;font:13px/1.4 system-ui;text-align:left}
  #ff-tray.docked{box-shadow:none;border-left:2px solid #6001d2}
  #ff-tray.docked .ff-verdict .hd{font-size:15px}
  #ff-tray.docked .ff-cmp{table-layout:auto}
  #ff-tray.docked .ff-cmp th,#ff-tray.docked .ff-cmp td{padding:5px 4px;font-size:11px;word-break:normal;overflow-wrap:normal}
  #ff-tray.docked .ff-cmp td.lab{width:auto;min-width:96px;overflow-wrap:anywhere}
  .ff-cmp + .ff-btn,.ff-cmp + .ff-irbox{display:inline-block;margin:6px 0 10px}
  .ff-cmp + .ff-cmp{margin-top:12px}
  #ff-tray .xc,#ff-tray .xxc,#ff-tray .xr{display:none}
  #ff-tray.wide .xc,#ff-tray.xwide .xxc{display:table-cell}
  #ff-tray.wide tr.xr{display:table-row}
  #ff-tray.wide div.xr{display:block}
  .ff-lineup{table-layout:auto}
  .ff-lineup td.lab{width:auto}
  .ff-lineup th.cs{width:46px}.ff-lineup th.cp{width:40px}.ff-lineup th.cst{width:52px}.ff-lineup th.ch{width:84px}
  .ff-lineup .gm{color:#555;font-size:11px;margin-top:2px}
  #ff-tray.closed{transform:translateX(100%);box-shadow:none}
  #ff-tab{position:absolute;left:-38px;top:42%;width:38px;padding:12px 0;background:#6001d2;color:#fff;border:0;border-radius:10px 0 0 10px;cursor:pointer;font:700 12px system-ui;writing-mode:vertical-rl;letter-spacing:.06em;box-shadow:-3px 2px 10px rgba(0,0,0,.25)}
  #ff-tab:hover{background:#7b2ff0}
  #ff-grip{position:absolute;left:-3px;top:0;bottom:0;width:8px;cursor:ew-resize;z-index:2}
  #ff-grip:hover{background:rgba(96,1,210,.25)}
  #ff-head{flex:none;padding:8px 12px 6px;background:#f6f0ff;border-bottom:1px solid #d9c8fb}
  #ff-head .row{display:flex;align-items:center;gap:6px}
  #ff-head .ttl{font-weight:800;font-size:14px;flex:1}
  #ff-head .sz{font:700 11px system-ui;border:1px solid #6001d2;color:#6001d2;background:#fff;border-radius:6px;padding:1px 7px;cursor:pointer}
  #ff-head .sz.on{background:#6001d2;color:#fff}
  #ff-prog .lab{font-size:11.5px;font-weight:700;color:#4b2a8a;margin-top:4px}
  #ff-prog .trk{height:8px;border-radius:4px;background:#e4dcf3;overflow:hidden;margin-top:2px}
  #ff-prog .fill{height:100%;width:0;background:#6b3fc4;transition:width .4s}
  .ff-bar{font-size:11.5px;color:#444;margin-top:2px}
  #ff-sum{margin-top:6px;border-radius:8px;padding:5px 9px;font-weight:800;font-size:13.5px;border:2px solid;display:none}
  #ff-sum.yes{display:block;background:#e6f8e6;border-color:#2a9d3a;color:#0d4a14}
  #ff-sum.no{display:block;background:#fde7e7;border-color:#c0392b;color:#7a1414}
  #ff-sum.meh{display:block;background:#fff4d6;border-color:#d9a400;color:#6a4a00}
  #ff-body{flex:1;overflow-y:auto;padding:10px 12px 40px}
  .ff-board{color:#111;font:13px/1.4 system-ui;text-align:left}
  .ff-board h3{margin:14px 0 6px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#5b1fb3}
  .ff-board h3:first-child{margin-top:0}
  #ff-health.bad,#ff-health.warn{border-radius:8px;padding:8px 10px;margin:6px 0;font-size:12px;border:2px solid}
  #ff-health.bad{background:#fde7e7;border-color:#c0392b;color:#7a1414}
  #ff-health.warn{background:#fff4d6;border-color:#d9a400;color:#6a4a00}
  #ff-health .hd{font-weight:800;font-size:13px}
  .ff-hint{color:#555;font-size:12px;margin:2px 0 6px}
  .ff-roster{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
  .ff-card{border:1px solid #ccc;border-radius:8px;padding:6px 8px;cursor:pointer;background:#fafafa}
  .ff-card:hover{border-color:#6001d2}
  .ff-card.sel{outline:3px solid #6001d2;background:#f3ecff}
  .ff-card .nm{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ff-link{color:#6001d2;cursor:pointer;text-decoration:underline;font-weight:700}
  .ff-news{border:2px solid #2a9d3a;border-radius:10px;padding:8px 10px;margin:4px 0 8px;background:#effaf0}
  .ff-news .hd{font-weight:800;font-size:13px;margin-bottom:3px;color:#0d4a14}
  .ff-news .item{font-size:12.5px;margin:3px 0}
  .ff-news .nt{display:block;color:#555;font-size:11.5px}
  .ff-suggest{border:2px solid #6001d2;border-radius:10px;padding:8px 10px;margin:6px 0 10px;background:#faf6ff}
  .ff-suggest .hd{font-weight:800;font-size:14px;margin-bottom:4px}
  .ff-suggest .need{margin:4px 0;font-size:12.5px}
  .ff-suggest .sub{font-size:12px;color:#444}
  .ff-btn.on{background:#6001d2;color:#fff}
  .ff-card.gap{border:2px dashed #c0392b;background:#fff5f5;cursor:pointer}
  .ff-card .sub,.ff-cand .sub{font-size:11px;color:#555}
  .ff-chip{display:inline-block;font-size:10px;font-weight:700;border-radius:8px;padding:0 6px;margin:2px 4px 0 0;vertical-align:1px}
  .ff-card .chips{min-height:16px}
  .c-hold{background:#e2d4ff;color:#4b1d99}.c-cut{background:#ffd9d9;color:#9b1c1c}.c-inj{background:#ffd9d9;color:#9b1c1c}
  .c-prod{background:#c8f7c5;color:#14611a}.c-rise{background:#cdeff2;color:#0b6b78}.c-buzz{background:#e8e3ff;color:#4b3bb0}
  .c-spike{background:#ffe9b3;color:#7a4f00}.c-watch{background:#eee;color:#555}.c-out{background:#ddd;color:#7a1f1f}
  .ff-bars{display:flex;gap:4px;align-items:flex-end;height:38px;margin-top:4px}
  .ff-bw{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;width:22px;font-size:9px;color:#555}
  .ff-bw i{display:block;width:16px;border-radius:2px 2px 0 0;background:#c4c4c4}
  .ff-bw i.g{background:#2a9d3a}.ff-bw i.n{background:transparent;border:1px dashed #bbb;height:4px}
  .ff-cands{border:1px solid #ddd;border-radius:8px;overflow:hidden}
  .ff-cand{display:grid;grid-template-columns:1fr auto auto;grid-template-areas:'nm bars go' 'why why why';gap:2px 10px;align-items:center;padding:7px 10px;border-top:1px solid #eee;cursor:pointer}
  .ff-cand>:nth-child(1){grid-area:nm}.ff-cand>:nth-child(2){grid-area:bars}.ff-cand>:nth-child(3){grid-area:why}.ff-cand>:nth-child(4){grid-area:go}
  .ff-cand:first-child{border-top:0}.ff-cand:hover{background:#faf6ff}.ff-cand.sel{background:#f3ecff;outline:3px solid #6001d2;outline-offset:-3px}
  .ff-cand .why{font-size:12px;color:#333}
  .ff-verdict{border-radius:10px;padding:10px 14px;margin:6px 0 10px;border:2px solid}
  .ff-verdict .hd{font-size:18px;font-weight:800}
  .ff-verdict.yes{background:#e6f8e6;border-color:#2a9d3a;color:#0d4a14}
  .ff-verdict.no{background:#fde7e7;border-color:#c0392b;color:#7a1414}
  .ff-verdict.meh{background:#fff4d6;border-color:#d9a400;color:#6a4a00}
  .ff-cmp{width:100%;border-collapse:collapse;table-layout:fixed}
  .ff-cmp th{font-size:12px;text-align:left;padding:6px 8px;background:#f1f1f1}
  .ff-cmp td{vertical-align:top;padding:6px 8px;border-top:1px solid #e3e3e3;font-size:12px;word-break:break-word}
  .ff-cmp td.lab{font-weight:700;width:21%}
  .ff-cmp td.w{background:#dff5df}.ff-cmp td.l{background:#fbe0e0}.ff-cmp td.e{background:#fafafa}
  .ff-cmp .mk{font-weight:800;margin-right:4px}
  .ff-cmp td.w .mk{color:#14611a}.ff-cmp td.l .mk{color:#9b1c1c}
  .ff-cmp .nt{color:#444;font-style:italic;margin-top:2px}
  .ff-tabs{display:flex;gap:6px;margin-bottom:10px}
  .ff-tabbtn{flex:1;font:700 12px system-ui;border:1px solid #6001d2;color:#6001d2;background:#fff;border-radius:8px;padding:6px 8px;cursor:pointer}
  .ff-tabbtn.on{background:#6001d2;color:#fff}
  .ff-irbox{border:1px dashed #6001d2;border-radius:8px;padding:6px 10px;background:#faf6ff;margin-top:6px}
  .ff-btn{font:600 11px system-ui;border:1px solid #6001d2;color:#6001d2;background:#fff;border-radius:10px;padding:1px 8px;cursor:pointer;margin-left:6px}
  `;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const barsFor = (p, radar) => {
    const wrap = el('div', 'ff-bars');
    const max = Math.max(p.m.thr * 2, ...p.m.weeks.filter(v => !isNaN(v)));
    p.m.weeks.forEach((v, i) => {
      const b = el('div', 'ff-bw'), bar = el('i');
      if (isNaN(v)) { bar.className = 'n'; b.title = 'Wk ' + p.data.weekNums[i] + ': did not play'; }
      else { bar.style.height = Math.max(3, Math.round((v / max) * 30)) + 'px'; if (v >= p.m.thr) bar.className = 'g'; b.title = 'Wk ' + p.data.weekNums[i] + ': ' + f1(v) + ' pts' + (radar && v === 0 ? ' (did not rank in the top 25 at his position)' : ''); }
      b.append(bar, el('span', null, isNaN(v) ? '-' : (radar && v === 0 ? 'lo' : String(Math.round(v)))));
      wrap.appendChild(b);
    });
    return wrap;
  };
  const state = { cand: null, rep: null, view: onList || onAdd ? 'wire' : 'lineup', stash: null, radarPos: null };
  const RADAR_POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
  let radarLoading = false;
  let trendData = null;   // { snaps, movers, streaks, txSummary }
  let board = null;   // { roster, radar, listPos, week }

  // ---- keep Yahoo's own list in step with what you pick in the tray -------------------------------------
  // Picking a position sets Yahoo's position filter; picking a player runs Yahoo's own name search. Both reload the page, so the
  // selection is saved first and restored afterwards (the data comes from the 30-minute cache, so a reload costs few requests).
  let savedSel = null;
  const DEFAULT_LIST_SEARCH = '?status=A&cut_type=33&stat1=S_S_2026&myteam=1&sort=PR&sdir=1';
  const onPlainList = /\/players\/?$/.test(PATH);
  const saveSel = () => kvSet('sel:' + leagueId, {
    t: Date.now(), radarPos: state.radarPos, cand: state.cand ? { id: state.cand.id, name: state.cand.name } : null,
    rep: state.rep && !state.rep.isFree ? state.rep.id : null, repManual: !!state.repManual,
    view: state.view, stash: state.stash ? { id: state.stash.id, name: state.stash.name } : null,
    listSearch: onPlainList ? location.search : (savedSel && savedSel.listSearch) || '' });
  const goToList = async pos => {
    await saveSel();
    const q = new URLSearchParams((onPlainList ? location.search : (savedSel && savedSel.listSearch)) || DEFAULT_LIST_SEARCH);
    q.set('pos', pos); q.delete('count');
    location.assign('/f1/' + leagueId + '/players?' + q.toString());
  };
  const goToPlayer = async c => {
    await saveSel();
    const f = document.createElement('form'); f.method = 'post'; f.action = '/f1/' + leagueId + '/playersearch';
    const i = document.createElement('input'); i.type = 'hidden'; i.name = 'search'; i.value = c.name;
    f.appendChild(i); document.body.appendChild(f); f.submit();
  };

  // Switch the "best available" list to another position from inside the tray.
  const selectRadarPos = async pos => {
    if (radarLoading || !board || state.radarPos === pos && board.radar) return;
    if (onList && ui.sync && (new URLSearchParams(location.search).get('pos') || '') !== pos) { state.radarPos = pos; state.cand = null; state.rep = null; state.repManual = false; goToList(pos); return; }
    state.radarPos = pos; state.cand = null; board.radar = null; board.radarError = null; radarLoading = true;
    render();
    progStart('Scanning the ' + pos + ' wire', 20);
    try {
      const SL = await getSleeper().catch(() => null);
      if (pos === 'K' && !board.roster.kd) board.roster = await loadRoster(board.week, SL, 'K');   // your kicker's stats are needed to compare
      board.radar = await loadRadar(pos, board.week, SL);
      state.cand = board.radar.find(p => p.out === 0) || null;
      if (!state.repManual) state.rep = defaultRep(board.roster, pos);
    } catch (e) { board.radarError = String(e && e.message); }
    progEnd();
    radarLoading = false;
    render();
    const rd = board.radar;
    if (rd && rd.loadNotes) rd.loadNotes().then(() => { if (board && board.radar === rd) render(); }).catch(() => {});
  };

  const chip = (cls, text) => el('span', 'ff-chip ' + cls, text);
  // a healthy bench player who is the only cover for a starter on bye this week is not droppable
  const coversBye = (players, week, p) => p.slot === 'BN' && p.out === 0 && p.bye !== week &&
    players.some(s => !/^(BN|IR)$/.test(s.slot) && s.pos === p.pos && s.bye === week) &&
    !players.some(q => q.id !== p.id && q.slot === 'BN' && q.out === 0 && q.pos === p.pos && q.bye !== week);
  // QB/TE/K/DEF have one starting slot. Your second one behind a better, healthy one whose bye is already behind him
  // only plays if that one gets hurt (or, for a TE, in a flex slot any RB/WR could fill): insurance, not a player to protect
  const surplusStarter = (players, week, p) => {
    if (p.pos === 'QB' && SLOTS[SUPERFLEX]) return null;   // in superflex your second QB is a starter
    if (!/^(QB|TE|K|DEF)$/.test(p.pos) || (SLOTS[p.pos] || 0) !== 1 || p.slot === 'IR' || !p.m) return null;
    const mine = startScore(p);
    return players.filter(x => x.id !== p.id && x.pos === p.pos && x.slot !== 'IR' && x.m && availability(x, week) === 'ok' && x.bye < week &&
      !isNaN(startScore(x)) && !(startScore(x) < mine)).sort((a, b) => startScore(b) - startScore(a))[0] || null;
  };
  const neededQB = (players, p) => p.pos === 'QB' && !!SLOTS[SUPERFLEX] && players.filter(q => q.pos === 'QB' && q.slot !== 'IR' && q.out === 0).length <= 2;
  const suggestReplace = roster => {
    const bench = roster.players.filter(p => p.slot === 'BN' && !(p.out === 2 && roster.irFree && !seasonDone(p, roster.week)) && !coversBye(roster.players, roster.week, p) && !neededQB(roster.players, p));
    const done = bench.find(p => seasonDone(p, roster.week));
    if (done) return done;
    const spare = bench.filter(p => surplusStarter(roster.players, roster.week, p)).sort(byRecord)[0];
    const unproven = bench.filter(p => !proven(p)).sort(byRecord)[0];
    return spare || unproven || [...bench].sort(byRecord)[0] || null;
  };
  // QB, TE and K are not interchangeable with a bench RB/WR: the natural swap is your weakest player at that position
  const defaultRep = (roster, pos) => {
    if (/^(QB|TE|K|DEF)$/.test(pos || '')) {
      const same = roster.players.filter(p => p.pos === pos && p.slot !== 'IR');
      // if your starter at this position has a bye in the next two weeks, the real question is bye cover: who on the bench goes
      if (same.some(p => p.slot !== 'BN' && p.bye >= roster.week && p.bye <= roster.week + 2) && !same.some(p => p.slot === 'BN') && /^(QB|TE)$/.test(pos)) return suggestReplace(roster);   // kickers and defenses are streamed: always compare with yours
      const pick = [...same].sort((a, b) => ((b.slot === 'BN' ? 1 : 0) - (a.slot === 'BN' ? 1 : 0)) || byRecord(a, b))[0];
      const weakest = [...same].sort(byRecord)[0];
      const bench = same.filter(p => p.slot === 'BN').sort(byRecord)[0];
      return bench || weakest || pick || suggestReplace(roster);
    }
    return suggestReplace(roster);
  };
  // his note says he will not be back this season (or not before your playoffs end): an IR slot is wasted on him, drop him instead
  const seasonDone = (p, week) => {
    if (!p.note || !(p.out >= 1 || p.slot === 'IR')) return false;
    const r = parseReturn(p.note, week);
    return r.kind === 'season' || (r.kind === 'range' && r.lo > PLAYOFF_START + 2);
  };
  const irOption = roster => {
    if (!roster.irFree) return null;
    return roster.players.filter(p => p.slot !== 'IR' && p.out >= 1 && (OUT_TAGS.has(p.injTag) || p.out === 2) && !seasonDone(p, roster.week)).sort((a, b) => b.out - a.out)[0] || null;
  };
  const doneText = (p, week) => p.name + ' is ' + (parseReturn(p.note, week).kind === 'season' ? 'out for the season' : 'not back before your playoffs end') + ' (his note, ' + p.note.date + '): drop him' + (p.slot === 'IR' ? ' to free your IR slot for a player who will return.' : ' rather than use an IR slot on him.');

  const openTrends = () => { trendData = null; render(); refreshTrends().then(render); loadBuzz(); };
  // loads the injured-player list (once per page load); the player you came back to after a name search is selected again
  const loadStashView = () => {
    stashData = { loading: true, week: board.week };
    render();
    progStart('Checking injured players', 12);
    getSleeper().catch(() => null).then(SL => loadStash(board.week, SL)).then(d => {
      progEnd(); stashData = d;
      const back = savedSel && savedSel.stash ? d.list.find(x => x.id === savedSel.stash.id) : null;
      if (back) state.stash = back; else if (!state.stash && d.list.length) state.stash = d.list[0];
      render();
    }).catch(e => { progEnd(); stashData = { error: String(e && e.message), week: board.week }; render(); });
  };

  // bring the verdict and comparison into view inside the tray
  const showResult = () => { const v = [...document.querySelectorAll('#ff-body .ff-verdict')].pop(); if (v) v.scrollIntoView({ block: 'start', behavior: 'smooth' }); };

  const render = () => {
    document.querySelectorAll('.ff-board').forEach(e => e.remove());
    ensureBar();   // makes sure the tray exists
    renderHealth();
    const sumEl = document.getElementById('ff-sum'); if (sumEl) { sumEl.className = ''; sumEl.textContent = ''; }
    const b = el('div', 'ff-board');
    const R = board.roster;
    if (newsAlerts.length) b.appendChild(newsBanner());
    const drops = dropBanner(R); if (drops) b.appendChild(drops);
    const tabs = el('div', 'ff-tabs');
    [['lineup', 'Lineup'], ['wire', 'Add / replace'], ['stash', 'Stash watch'], ['trends', 'Trends']].forEach(([v, label]) => {
      const t = el('button', 'ff-tabbtn' + (state.view === v ? ' on' : ''), label);
      t.onclick = () => {
        state.view = v;
        if (v === 'trends') { openTrends(); return; }
        if (v === 'stash' && (!stashData || stashData.week !== board.week) && !stashData?.loading) { loadStashView(); return; }
        if (v === 'wire' && !state.radarPos && !radarLoading) { const top = needsOf(board.roster.players, board.week, SLOTS)[0]; if (top) { render(); selectRadarPos(top.pos); return; } }   // team page: open on your top need
        render();
      };
      tabs.appendChild(t);
    });
    b.appendChild(tabs);
    if (state.view === 'lineup') {
      renderLineup(b, R, sumEl);
      document.getElementById('ff-body').replaceChildren(b);
      window.__ffExpected = 1;
      return;
    }
    if (state.view === 'trends') {
      renderTrends(b, R, sumEl);
      document.getElementById('ff-body').replaceChildren(b);
      window.__ffExpected = 1;
      return;
    }
    if (state.view === 'stash') {
      renderStash(b, R, sumEl);
      document.getElementById('ff-body').replaceChildren(b);
      window.__ffExpected = 1;
      return;
    }
    // ---- 0. suggested for you ---------------------------------------------------------------------------
    const needs = needsOf(R.players, board.week, SLOTS);
    const sugBox = el('div', 'ff-suggest');
    sugBox.appendChild(el('div', 'hd', 'Suggested for you'));
    if (!needs.length) sugBox.appendChild(el('div', 'sub', 'No gaps: every starting slot is covered this week and for the next three byes. Pick any position below to browse.'));
    needs.slice(0, 3).forEach(n => {
      const row = el('div', 'need');
      const btn = el('button', 'ff-btn' + (state.radarPos === n.pos ? ' on' : ''), state.radarPos === n.pos ? 'Showing ' + n.pos : 'Best available ' + n.pos);
      btn.onclick = e => { e.stopPropagation(); selectRadarPos(n.pos); };
      row.append(chip(n.score >= 90 ? 'c-out' : (n.score >= 50 ? 'c-spike' : 'c-watch'), 'NEED ' + n.pos), el('span', null, ' ' + n.why.join('; ') + ' '), btn);
      sugBox.appendChild(row);
    });
    if (needs.length && state.radarPos && !needs.some(n => n.pos === state.radarPos))
      sugBox.appendChild(el('div', 'sub', 'You are looking at ' + state.radarPos + ', which you do not need right now: an add there only makes sense if he clearly beats one of yours.'));
    b.appendChild(sugBox);
    // ---- 1. your roster ------------------------------------------------------------------------------
    b.appendChild(el('h3', null, '1. Your roster (click who you would replace)'));
    const ir = irOption(R);
    b.appendChild(el('div', 'ff-hint', 'Waiver priority ' + (R.prio || '?') + '. ' + (R.benchFree ? 'Open bench spots: ' + R.benchFree + '. ' : '') + 'IR slots: ' + R.irUsed + ' of ' + R.irTotal + ' used' + (ir ? '. ' + ir.name + ' is listed out and could move to IR to free a spot.' : '.') + ' Bars = points in weeks ' + R.players[0].data.weekNums.join('/') + '; green = a good game for that position.'));
    const onBye = R.players.filter(p => p.bye === board.week && !/^(BN|IR)$/.test(p.slot));
    if (onBye.length) {
      const alert = el('div', 'ff-verdict meh');
      alert.append(el('div', 'hd', 'On bye this week: ' + onBye.map(p => p.name + ' (' + p.pos + ')').join(', ')),
        el('div', null, onBye.map(p => { const sub = R.players.find(q => q.pos === p.pos && q.slot === 'BN' && q.bye !== board.week && q.out === 0); return p.name + ': ' + (sub ? 'bench option ' + sub.name : 'no healthy ' + p.pos + ' on your bench, so this slot is empty unless you add one'); }).join('. ') + '.'));
      b.appendChild(alert);
    }
    const grid = el('div', 'ff-roster');
    const order = { QB: 0, RB: 1, WR: 2, TE: 3, K: 4, DEF: 5 };
    const players = [...R.players].sort((a, b) => ((/^(BN|IR)$/.test(a.slot) ? 1 : 0) - (/^(BN|IR)$/.test(b.slot) ? 1 : 0)) || (order[a.pos] - order[b.pos]));
    const sug = suggestReplace(R);
    const gaps = emptySlots(R.players, SLOTS);
    gaps.forEach(pos => {
      const g = el('div', 'ff-card gap');
      g.appendChild(el('div', 'nm', 'EMPTY ' + pos + ' SLOT'));
      const chips = el('div', 'chips'); chips.appendChild(chip('c-inj', 'NO ' + pos)); g.appendChild(chips);
      g.appendChild(el('div', 'sub', 'Nobody in your starting ' + pos + ' slot: it scores zero until you fill it. Click to see the best available ' + pos + '.'));
      g.onclick = e => { e.stopPropagation(); if (pos === SUPERFLEX || /^(QB|RB|WR|TE|K|DEF)$/.test(pos)) { state.view = 'wire'; selectRadarPos(pos === SUPERFLEX ? 'QB' : pos); } else { state.view = 'lineup'; render(); } };
      grid.appendChild(g);
    });
    players.forEach(p => {
      const card = el('div', 'ff-card' + (state.rep && state.rep.id === p.id ? ' sel' : ''));
      const nm = el('div', 'nm', p.name);
      card.appendChild(nm);
      const chips = el('div', 'chips');
      if (seasonDone(p, board.week)) chips.appendChild(chip('c-cut', 'SEASON OVER: DROP'));
      else if (p.out >= 1) chips.appendChild(chip('c-inj', p.out === 2 ? 'OUT' : 'OUT THIS WEEK'));
      else if (surplusStarter(players, board.week, p)) chips.appendChild(chip('c-watch', FLEX[p.slot] ? '2ND ' + p.pos + ': FLEX ONLY' : 'BACKUP ONLY'));
      else if (proven(p)) chips.appendChild(chip('c-hold', 'KEEP'));
      if (p.bye === board.week && !/^(BN|IR)$/.test(p.slot)) chips.appendChild(chip('c-inj', 'BYE THIS WEEK'));
      if (inPending(p, 'drops')) chips.appendChild(chip('c-cut', 'PENDING DROP'));
      if (sug && sug.id === p.id) chips.appendChild(chip('c-cut', 'WEAKEST BENCH'));
      if (chips.childNodes.length) card.appendChild(chips);
      card.appendChild(el('div', 'sub', p.pos + ' | ' + (p.slot === 'BN' ? 'bench' : p.slot === 'IR' ? 'IR slot' : 'starting ' + p.slot) + ' | bye ' + (isNaN(p.bye) ? '?' : p.bye)));
      card.appendChild(barsFor(p, false));
      card.appendChild(el('div', 'sub', p.m.good + '/' + (p.m.played || '?') + ' good, avg ' + f1(p.m.avg) + (usageText(p.m) ? ' | ' + usageText(p.m) : '')));
      card.onclick = e => { e.stopPropagation(); state.rep = p; state.repManual = true; render(); };
      grid.appendChild(card);
    });
    b.appendChild(grid);
    if (ir) {
      const box = el('div', 'ff-irbox');
      box.append('Free option: ', el('b', null, 'use your open IR slot'), ' for ' + ir.name + ' (' + healthText(ir) + ') and add a wire player without dropping anyone. ');
      const btn = el('button', 'ff-btn', 'Compare using IR slot');
      btn.onclick = e => { e.stopPropagation(); state.rep = { isFree: true, irPlayer: ir, id: 'IR-FREE', name: 'your open IR slot', pos: ir.pos, m: ir.m, out: 0, data: ir.data }; render(); };
      box.appendChild(btn);
      b.appendChild(box);
    }
    // ---- 2. wire candidates --------------------------------------------------------------------------
    b.appendChild(el('h3', null, '2. Best available' + (state.radarPos ? ' ' + state.radarPos : '') + ' (click one to compare)'));
    if (PROJ_POS.test(state.radarPos || '')) b.appendChild(el('div', 'ff-hint', 'Kickers and defenses depend on the matchup, so they are ranked by Yahoo\'s projection for week ' + board.week + ', then by recent scoring.'));
    if (onList) {
      const lab = el('label', 'ff-hint'), cb = el('input'); cb.type = 'checkbox'; cb.checked = ui.sync;
      cb.onchange = () => { ui.sync = cb.checked; saveUi(); };
      lab.append(cb, " Also set Yahoo's position filter and search for the player when I pick one here (reloads the page)");
      b.appendChild(lab);
    }
    const posRow = el('div', 'ff-tabs');
    RADAR_POS.forEach(pp => {
      const t = el('button', 'ff-tabbtn' + (state.radarPos === pp ? ' on' : ''), pp);
      t.disabled = radarLoading; t.onclick = () => selectRadarPos(pp); posRow.appendChild(t);
    });
    b.appendChild(posRow);
    if (radarLoading) {
      b.appendChild(el('div', 'ff-hint', 'Scanning the ' + state.radarPos + ' wire by actual scoring. This takes about 30 seconds the first time (the requests are paced to be gentle on Yahoo).'));
    } else if (board.radarError) {
      b.appendChild(el('div', 'ff-hint', 'Could not scan the ' + state.radarPos + ' wire: ' + board.radarError));
    } else if (!board.radar) {
      b.appendChild(el('div', 'ff-hint', 'Pick a position above to scan its wire.'));
    } else {
      b.appendChild(el('div', 'ff-hint', 'Ranked by actual scoring, then Yahoo and Sleeper momentum. Injured players sink to the bottom. "lo" = did not rank in the top 25 at his position that week.'));
      if (board.radar.notesPending) b.appendChild(el('div', 'ff-hint ff-notes-pending', 'Checking injury notes for these players; the order can change when they arrive.'));
      const list = el('div', 'ff-cands');
      board.radar.forEach(c => {
        const row = el('div', 'ff-cand' + (state.cand && state.cand.id === c.id ? ' sel' : ''));
        const left = el('div');
        const nm = el('div'); nm.style.fontWeight = '700'; nm.appendChild(nameLink(c.name, c.id, () => { state.cand = c; }));
        const tagCls = { producer: 'c-prod', rising: 'c-rise', usage: 'c-rise', buzz: 'c-buzz', spike: 'c-spike', watch: 'c-watch', out: 'c-out', wkout: 'c-out' }[c.tag];
        nm.appendChild(chip(tagCls, TAG_LABEL[c.tag]));
        left.append(nm, el('div', 'sub', c.team + ' ' + c.pos + ' | ' + (/^W \(/.test(c.status) ? 'waivers ' + c.status.slice(3, -1) : (c.status === 'FA' ? 'FREE AGENT' : c.status)) + (c.injTag ? ' | ' + c.injTag : '')));
        const why = c.out === 2 ? 'Out long-term: ' + (c.note ? c.note.text.slice(0, 90) : healthText(c))
          : c.out === 1 ? 'Out this week: ' + (c.note ? c.note.text.slice(0, 90) : '')
            : (isNaN(c.proj) ? '' : 'Projected ' + f1(c.proj) + ' this week. ') + c.m.good + ' of ' + c.m.played + ' good games, avg ' + f1(c.m.avg) + '. ' + (usageText(c.m) ? 'Usage ' + usageText(c.m).slice(6) + '. ' : '') + (c.m.trendKnown ? 'Rostered ' + signed(c.m.ros.d) + ' this week. ' : '') + (c.sl && c.sl.add ? 'Sleeper #' + c.sl.add.posRank + ' at pos for adds.' : 'Not trending on Sleeper.');
        row.append(left, el('div'), el('div', 'why', why));
        row.appendChild(el('button', 'ff-btn', 'Compare'));
        row.onclick = e => { e.stopPropagation(); state.cand = c; render(); showResult(); };   // compare right here; the name link runs Yahoo's search
        list.appendChild(row);
      });
      b.appendChild(list);
      if (board.radar.unmatched && board.radar.unmatched.length) b.appendChild(el('div', 'ff-hint', "Also trending on Sleeper but not on this league's wire (rostered here, or not found): " + board.radar.unmatched.join(', ') + '.'));
    }
    // ---- 3. comparison -------------------------------------------------------------------------------
    b.appendChild(el('h3', null, '3. Comparison'));
    const c = state.cand, r = state.rep || sug;
    // notes are loaded on demand: fetch the two players being compared if we have not yet
    const needNote = [c, r && r.isFree ? r.irPlayer : r].filter(p => p && p.note === undefined && !p.noteTried);
    if (needNote.length) {
      needNote.forEach(p => { p.noteTried = true; });
      Promise.all(needNote.map(p => fetchNote(p.id, isFlagged(p)).then(n => { p.note = n; refreshOut(p); }).catch(() => { p.note = null; })))
        .then(() => { if (state.view === 'wire') render(); });
    }
    if (!c) b.appendChild(el('div', 'ff-hint', 'Pick a wire player above. He will be compared with ' + (r ? r.name : 'the player you select') + '.'));
    else if (!r) b.appendChild(el('div', 'ff-hint', 'No bench player to compare against. Click a player on your roster.'));
    else {
      const res = guardVerdict(pendingGuard(compare(c, r, { roster: R.players, week: board.week }), c, r));
      if (sumEl) { sumEl.className = res.kind; sumEl.textContent = res.headline; }
      const v = el('div', 'ff-verdict ' + res.kind);
      v.append(el('div', 'hd', res.headline), el('div', null, res.sub));
      if (R.benchFree && !r.isFree) v.appendChild(el('div', 'sub', 'You have an open bench spot, so you can add ' + c.name + ' without dropping ' + r.name + '.'));
      if (c.status && /^W \(/.test(c.status)) v.appendChild(el('div', 'sub', 'Claim clears ' + c.status.slice(3, -1) + '; your waiver priority is ' + (R.prio || '?') + '.'));
      b.appendChild(v);
      const tbl = el('table', 'ff-cmp');
      const free = !!r.isFree;
      const head = el('tr');
      (free ? ['Check', 'ADD: ' + c.name + ' (' + c.pos + '), facts only: nobody is being dropped']
        : ['Check', 'ADD: ' + c.name + ' (' + c.pos + ')', 'REPLACE: ' + r.name + ' (' + r.pos + (r.slot ? ', ' + r.slot : '') + ')'])
        .forEach(t => head.appendChild(el('th', null, t)));
      tbl.appendChild(head);
      res.checks.forEach(k => {
        const tr = el('tr');
        tr.appendChild(el('td', 'lab', k.label));
        const mk = (p, edgeForThis, lines, bars, isCand) => {
          const td = el('td', free ? 'e' : (edgeForThis > 0 ? 'w' : (edgeForThis < 0 ? 'l' : 'e')));
          if (!free) td.appendChild(el('span', 'mk', edgeForThis > 0 ? '\u2713' : (edgeForThis < 0 ? '\u2717' : '=')));
          lines.forEach((t, i) => td.appendChild(el(i && k.note ? 'div' : 'span', i && k.note ? 'nt' : null, (i && !k.note ? ' | ' : '') + t)));
          if (bars) td.appendChild(barsFor(p, isCand && !c.mine));
          return td;
        };
        tr.appendChild(mk(c, k.edge, k.a, k.bars, true));
        if (!free) tr.appendChild(mk(r, -k.edge, k.b, k.bars, false));
        tbl.appendChild(tr);
      });
      b.appendChild(tbl);
      if (free) {
        const ip = r.irPlayer;
        b.appendChild(el('div', 'ff-hint', 'The move: put ' + ip.name + ' on IR (Yahoo: ' + (ip.injTag || 'n/a') + (ip.sl && ip.sl.inj ? '; Sleeper: ' + ip.sl.inj : '') + '). ' + (ip.note ? 'His latest note (' + ip.note.date + '): ' + (ip.note.text.length > 220 ? ip.note.text.slice(0, 220) + '...' : ip.note.text) : 'No Yahoo note found.') + ' Read it first: IR is only worth it if he is out for a while. Your league allows adding an injured player straight to IR.'));
      } else {
        b.appendChild(el('div', 'ff-hint', 'Score ' + res.score + ' (weights: record 3, health 3, starts for you 3, usage 3, last 2 weeks 2, momentum 2, role 2, pedigree 1, bye 1). Need ' + res.need + ' to recommend a swap' + (res.need > 3 ? ' (higher bar because he is a starter or has a track record)' : '') + '. A check marked \u2713 favors that player.' + ((c.pos === 'K' || c.pos === 'DEF') ? ' Kickers and defenses are volatile, so the bar is 3 points higher.' : '')));
      }
    }
    document.getElementById('ff-body').replaceChildren(b);
    window.__ffExpected = 1;
  };


  const projText = p => p.bye === board.week ? '0 (bye)' : isNaN(p.proj) ? 'not shown' : f1(p.proj) + ' pts' + (p.game ? ', ' + p.game : '');
  const renderLineup = (b, R, sumEl) => {
    const week = board.week, L = computeLineup(R.players, week, SLOTS);
    const nm = p => p.name + ' (' + p.pos + ')';
    const stat = p => (!R.kd && /^(K|DEF)$/.test(p.pos) ? 'loading...' : isNaN(p.m.avg) ? 'no recent scoring' : p.m.good + '/' + (p.m.played || '?') + ' good games, avg ' + f1(p.m.avg) + ', ' + formText(p.m) + (usageText(p.m) ? '; ' + usageText(p.m) : ''));
    const guarded = criticalIssue();
    let kind, headline, sub;
    if (guarded) { kind = 'no'; headline = 'NO RECOMMENDATION: the data is not trustworthy'; sub = guarded.msg; }
    else if (L.fixes.length) { kind = 'no'; headline = 'FIX YOUR LINEUP: ' + L.fixes.map(f => f.sit ? f.sit.name + ' ' + f.why : 'your ' + f.slot + ' slot is empty').join('; '); sub = L.fixes.map(f => f.start ? 'Start ' + nm(f.start) + ' at ' + f.slot + '.' : 'Nobody on your bench can fill ' + f.slot + (f.sit ? '.' : ': add one from the wire.')).join(' '); }
    else if (L.swaps.length) { kind = 'yes'; headline = 'START ' + L.swaps.map(w => w.start.name).join(', ') + ' (week ' + week + ')'; sub = L.swaps.map(w => w.start.name + ' over ' + w.sit.name + ' at ' + w.slot).join('; ') + '.'; }
    else { kind = 'yes'; headline = 'Your week ' + week + ' lineup looks right'; sub = 'Nobody in your lineup is out or on bye, and no bench player is clearly better than a starter.'; }
    if (sumEl) { sumEl.className = kind; sumEl.textContent = headline; }
    b.appendChild(el('h3', null, 'Week ' + week + ' start / sit'));
    const box = el('div', 'ff-verdict ' + kind); box.append(el('div', 'hd', headline), el('div', null, sub)); b.appendChild(box);
    b.appendChild(el('div', 'ff-hint', 'Judged on consistent scoring (last 4 weeks, weighted to the last 2), not Yahoo\'s one-week projections. Matchups and kickoff times are not considered. A bench player must beat a starter by 15% and 2 points, and a proven starter needs more. Kickers and defenses are the exception: they swing with the matchup, so they go by Yahoo\'s projection for this week (a ' + PROJ_EDGE + '-point edge to swap).'));
    if (!guarded) {
      L.fixes.concat(L.swaps).forEach(x => {
        const t = el('table', 'ff-cmp'), h = el('tr');
        [x.why ? 'MUST FIX: ' + x.slot : 'SWAP: ' + x.slot, x.start ? 'START: ' + nm(x.start) : 'No bench player can play ' + x.slot, x.sit ? 'SIT: ' + nm(x.sit) : 'EMPTY SLOT'].forEach(c => h.appendChild(el('th', null, c)));
        t.appendChild(h);
        const row = (label, a, c) => { const tr = el('tr'); tr.append(el('td', 'lab', label), el('td', 'e', a), el('td', 'e', c)); t.appendChild(tr); };
        row('Scoring', x.start ? stat(x.start) : '-', x.sit ? stat(x.sit) : 'nobody in the slot');
        row('Yahoo projection', x.start ? projText(x.start) : '-', x.sit ? projText(x.sit) : '0');
        row('Status', x.start ? healthText(x.start) + (x.start.bye === week ? '; on bye' : '') : '-', x.sit ? (x.why ? x.why : healthText(x.sit)) : 'empty: scores zero until filled');
        b.appendChild(t);
        if (!x.start) {
          const fpos = x.sit ? x.sit.pos : x.slot, btn = el('button', 'ff-btn', 'Find a free-agent ' + fpos);
          btn.onclick = e => { e.stopPropagation(); state.view = 'wire'; if (/^(QB|RB|WR|TE|K|DEF)$/.test(fpos)) selectRadarPos(fpos); else render(); };
          b.appendChild(btn);
        }
      });
    }
    const irP = irOption(R), needFA = L.fixes.find(f => !f.start);
    if (!guarded && irP && needFA) {                   // an injured player on the bench can go to the open IR slot, so the add costs nobody
      const fpos = needFA.sit ? needFA.sit.pos : needFA.slot, irBox = el('div', 'ff-irbox');
      irBox.append('Free option: ', el('b', null, 'move ' + irP.name + ' to your open IR slot'), ' (' + healthText(irP) + '), then add a free-agent ' + fpos + ' without dropping anyone. ');
      const irBtn = el('button', 'ff-btn', 'Compare a ' + fpos + ' using the IR slot');
      irBtn.onclick = e => {
        e.stopPropagation();
        state.rep = { isFree: true, irPlayer: irP, id: 'IR-FREE', name: 'your open IR slot', pos: irP.pos, m: irP.m, out: 0, data: irP.data }; state.repManual = true; state.view = 'wire';
        if (/^(QB|RB|WR|TE|K|DEF)$/.test(fpos)) selectRadarPos(fpos); else render();
      };
      irBox.appendChild(irBtn); b.appendChild(irBox);
    }
    if (!guarded && R.benchFree) {
      const fpos = needFA ? (needFA.sit ? needFA.sit.pos : needFA.slot) : '', open = el('div', 'ff-irbox');
      open.append('Open roster spot: ', el('b', null, 'you have ' + R.benchFree + ' empty bench slot' + (R.benchFree > 1 ? 's' : '')),
        ', so you can add ' + (fpos ? 'a free-agent ' + fpos + ' for this week' : 'the best available player') + ' without dropping anyone. ');
      const ob = el('button', 'ff-btn', fpos ? 'Best available ' + fpos : 'See best available');
      ob.onclick = e => { e.stopPropagation(); state.view = 'wire'; if (/^(QB|RB|WR|TE|K|DEF)$/.test(fpos)) selectRadarPos(fpos); else render(); };
      open.appendChild(ob); b.appendChild(open);
    }
    if (!guarded) R.players.filter(p => seasonDone(p, week)).forEach(p => b.appendChild(el('div', 'ff-irbox', doneText(p, week))));
    L.questionable.forEach(q => b.appendChild(el('div', 'ff-hint', nm(q) + ' is listed Questionable: check his status before kickoff.')));
    if (unknownSlots.length) b.appendChild(el('div', 'ff-hint', 'This league also has ' + unknownSlots.join(', ') + ' slots, which this tool does not read, so check those yourself.'));
    b.appendChild(el('h3', null, 'Your lineup'));
    // M and L widths add Yahoo's projection, the game and % started (CSS hides those columns at S and Side)
    const tbl = el('table', 'ff-cmp ff-lineup'), head = el('tr');
    [['Slot', 'cs'], ['Player'], ['Proj', 'xc cp'], ['Recent scoring'], ['% Start', 'xxc cst'], ['Status', 'ch']].forEach(([c, k]) => head.appendChild(el('th', k, c)));
    const short = p => (!R.kd && /^(K|DEF)$/.test(p.pos) ? 'loading...' : isNaN(p.m.avg) ? 'no recent scoring' : p.m.good + '/' + (p.m.played || '?') + ' good, avg ' + f1(p.m.avg) + ', ' + formText(p.m) + (usageText(p.m) ? '; ' + usageText(p.m).replace(/\/game/g, '') : ''));
    tbl.appendChild(head);
    const order = { QB: 0, RB: 1, WR: 2, TE: 3, [SUPERFLEX]: 4, 'W/R/T': 4, K: 5, DEF: 6, BN: 7, IR: 8 };
    emptySlots(R.players, SLOTS).forEach(pos => {
      const tr = el('tr');
      tr.append(el('td', 'lab', pos), el('td', 'l', 'EMPTY'), el('td', 'l xc', '0'), el('td', 'e', 'nobody in the slot'), el('td', 'e xxc', '-'), el('td', 'l', 'scores zero until filled'));
      tbl.appendChild(tr);
    });
    [...R.players].sort((a, c) => (order[a.slot] ?? 9) - (order[c.slot] ?? 9)).forEach(p => {
      const a = availability(p, week), tr = el('tr');
      const below = !isNaN(p.proj) && !isNaN(p.m.avg) && p.m.avg >= 5 && p.proj < p.m.avg * 0.6;   // Yahoo sees a much smaller week than his recent scoring
      const who = el('td', 'e', nm(p));
      who.appendChild(el('div', 'gm xr', p.bye === week ? 'Bye' : (p.game || '')));   // the game sits under the name at M and L
      tr.append(el('td', 'lab', p.slot), who, el('td', (below ? 'l' : 'e') + ' xc', isNaN(p.proj) ? '-' : f1(p.proj)), el('td', 'e', short(p)), el('td', 'e xxc', isNaN(p.startPct) ? '-' : p.startPct + '%'),
        el('td', a === 'ok' ? 'e' : (a === 'q' ? 'e' : 'l'), a === 'ok' ? 'Healthy' : (a === 'q' ? 'Questionable' : AVAIL_TEXT[a])));
      tbl.appendChild(tr);
    });
    const starters = R.players.filter(p => !/^(BN|IR)$/.test(p.slot));
    if (starters.some(p => !isNaN(p.proj))) {
      const tot = el('tr', 'xr');
      tot.append(el('td', 'lab', 'Total'), el('td', 'e', 'Starters, Yahoo projection'), el('td', 'e xc', f1(starters.reduce((s, p) => s + (isNaN(p.proj) ? 0 : p.proj), 0))), el('td', 'e', ''), el('td', 'e xxc', ''), el('td', 'e', ''));
      tbl.appendChild(tot);
    }
    b.appendChild(tbl);
    b.appendChild(el('div', 'ff-hint xr', 'Proj is Yahoo\'s projection for this week, shown for reference only; red means it is far below his recent scoring. The verdicts above do not use it.'));
  };
  const renderStash = (b, R, sumEl) => {
    b.appendChild(el('h3', null, 'Injured players on the wire worth holding?'));
    if (!stashData || stashData.loading) { b.appendChild(el('div', 'ff-hint', 'Loading injured players, their notes and return timelines...')); return; }
    if (stashData.error) { b.appendChild(el('div', 'ff-hint', 'Could not load the stash list: ' + stashData.error)); return; }
    const ir = R.irFree > 0;
    b.appendChild(el('div', 'ff-hint', 'IR slots: ' + R.irUsed + ' of ' + R.irTotal + ' used' + (ir ? ' (open: a stash costs nothing).' : ' (full: a stash costs a bench player).') +
      ' Return weeks are estimates read from each note. Your playoffs start in week ' + PLAYOFF_START + '. Ranked by return timing, then production before the injury.'));
    const list = el('div', 'ff-cands');
    stashData.list.forEach(c => {
      const row = el('div', 'ff-cand' + (state.stash && state.stash.id === c.id ? ' sel' : ''));
      const left = el('div');
      const nm = el('div'); nm.style.fontWeight = '700'; nm.appendChild(nameLink(c.name, c.id, () => { state.stash = c; }));
      if (c.tier === 3) nm.appendChild(chip('c-out', c.fit.k === 'no' ? 'Skip: too late' : 'Skip: low output'));
      else nm.appendChild(chip({ good: 'c-prod', tight: 'c-spike', unk: 'c-watch' }[c.fit.k], { good: 'Worth a spot', tight: 'Risky timing', unk: 'No return date' }[c.fit.k]));
      left.append(nm, el('div', 'sub', c.team + ' ' + c.pos + ' | ' + (/^W \(/.test(c.status) ? 'waivers ' + c.status.slice(3, -1) : (c.status === 'FA' ? 'FREE AGENT' : c.status)) + (c.injTag ? ' | ' + c.injTag : '')));
      row.append(left, barsFor(c, true), el('div', 'why', f1(c.perGame) + ' pts/game before injury (' + c.gp + ' GP). ' + c.ret.label + '.'), el('button', 'ff-btn', 'Check'));
      row.onclick = e => { e.stopPropagation(); state.stash = c; render(); showResult(); };
      list.appendChild(row);
    });
    b.appendChild(list);
    b.appendChild(el('h3', null, 'Stash check'));
    const c = state.stash;
    if (!c) { b.appendChild(el('div', 'ff-hint', 'Pick a player above.')); return; }
    if (c.note === undefined && !c.noteTried) {   // load his note on demand
      c.noteTried = true;
      fetchNote(c.id).then(n => { c.note = n; setStashReturn(c, board.week); if (state.view === 'stash') render(); }).catch(() => { c.note = null; setStashReturn(c, board.week); });
    }
    const v = guardVerdict(stashVerdict(c, R));
    if (sumEl) { sumEl.className = v.kind; sumEl.textContent = v.headline; }
    const box = el('div', 'ff-verdict ' + v.kind);
    box.append(el('div', 'hd', v.headline), el('div', null, v.sub));
    b.appendChild(box);
    const tbl = el('table', 'ff-cmp');
    const head = el('tr'); ['Check', c.name + ' (' + c.pos + ')'].forEach(t => head.appendChild(el('th', null, t))); tbl.appendChild(head);
    const row = (label, edge, lines) => {
      const tr = el('tr'); tr.appendChild(el('td', 'lab', label));
      const td = el('td', edge > 0 ? 'w' : (edge < 0 ? 'l' : 'e'));
      td.appendChild(el('span', 'mk', edge > 0 ? '✓' : (edge < 0 ? '✗' : '=')));
      lines.forEach((t, i) => td.appendChild(el(i ? 'div' : 'span', i ? 'nt' : null, t)));
      tr.appendChild(td); tbl.appendChild(tr);
    };
    row('Production before the injury', c.q.k === 'good' ? 1 : (c.q.k === 'ok' ? 0 : -1), [f1(c.perGame) + ' pts/game over ' + c.gp + ' games (a good game is ' + c.m.thr + '+). Season total ' + f1(c.seasonPts) + '.']);
    row('Expected return', c.fit.k === 'good' ? 1 : (c.fit.k === 'no' ? -1 : 0), [c.fit.t, 'Read from the note: ' + c.ret.label]);
    row('Cost to hold him', ir ? 1 : -1, [ir ? 'Free: your IR slot is open' : 'Needs a roster spot: ' + (suggestReplace(R) ? 'drop ' + suggestReplace(R).name : 'none free')]);
    row('Pedigree', (!isNaN(c.preRank) && c.preRank <= 60) ? 1 : 0, [isNaN(c.preRank) ? 'Pre-season rank n/a' : 'Yahoo pre-season rank ' + c.preRank]);
    row('Market', c.sl && c.sl.hot ? 1 : 0, [slLineShort(c.sl)]);
    row('Latest note', 0, [c.note ? '(' + c.note.date + ') ' + (c.note.text.length > 420 ? c.note.text.slice(0, 420) + '...' : c.note.text) : 'No Yahoo note found']);
    b.appendChild(tbl);
    b.appendChild(el('div', 'ff-hint', 'A ✓ helps the case for holding him and a ✗ hurts it. Return weeks are rough: players often come back later than the first estimate, so treat "back in time" as a maybe, not a promise.'));
  };
  const slLineShort = sl => !sl ? 'Sleeper: no match' : (sl.add ? 'Sleeper: ' + sl.add.count.toLocaleString() + ' adds in 24h (#' + sl.add.posRank + ' at pos)' : 'Sleeper: not trending') + (sl.inj ? '; Sleeper lists him ' + sl.inj + (sl.body ? ' (' + sl.body + ')' : '') : '');


  // ---- Yahoo Buzz Index ("Transaction Trends" page): adds, drops and trades across Yahoo's leagues for players available to you ----
  const ROLE_UP = /((heavier|larger|bigger|increased|expanded)\s+(workload|role)|more (carries|touches|targets|snaps|work|reps|playing time|opportunities)|lead (back|role|rusher)|workhorse|bell[- ]?cow|take[s]? over|taking over|promoted|elevated|first[- ]team|expected to (start|lead|handle|see more|take on)|set to (start|lead)|steps? into|moves? into|handle the (bulk|majority)|primary (back|target|option)|No\. 1 (back|receiver|option|target))/i;
  // "behind" alone is not a role loss ("second on the team behind McBride", "played from behind"), so only depth-chart wording counts
  const ROLE_DOWN = /(lost his (starting|job|role)|loses? (his )?(starting|role|snaps|touches)|reduced role|smaller role|limited role|committee|splitting (the )?(work|carries|snaps|touches)|fewer (snaps|touches|targets|carries)|demoted|benched|relegated|(stuck|buried|sliding|slid|fell|falls?|drops?) (down )?behind|behind \w+( \w+)? on the depth chart|sees? (a )?decrease)/i;
  const HEDGE = /\b(could|may|might|would|if|potentially|possibly|should|depending)\b/i;
  // Sentences, without splitting "No. 1" or an initial; a role phrase only counts in a sentence that names the player.
  const sentencesOf = t => t.replace(/\bNo\.\s*(\d)/g, 'No․ $1').split(/(?<=[.!?])\s+(?=[A-Z"'])/).map(x => x.replace(/․/g, '.'));
  // "behind No. 1 option Josh Jacobs": a title like that belongs to the name right after it, not to anyone named before
  const NAME_AT = /^\s+([A-Z][a-zA-Z'.-]+(?:\s+[A-Z][a-zA-Z'.-]+){1,2})/;
  const titleOwner = (sent, m) => (/^(No\. 1|primary)/i.test(m[0]) && (NAME_AT.exec(sent.slice(m.index + m[0].length)) || [])[1]) || '';
  // words between a player's name and a role-gain phrase that make him the other back ("complementary options behind No. 1 option")
  const NOT_HIM = /\b(complementary|backup|behind|secondary|change-of-pace)\b/i;
  const roleOf = (text, name) => {
    const parts = (name || '').toLowerCase().replace(/[^a-z' ]/g, '').split(' ').filter(w => w.length >= 4 && !/^(jr|sr|iii)$/.test(w));
    for (const sent of sentencesOf(String(text || ''))) {
      if (parts.length && !parts.some(w => sent.toLowerCase().includes(w))) continue;
      let up = ROLE_UP.exec(sent);
      const down = ROLE_DOWN.exec(sent), owner = up && titleOwner(sent, up);
      if (owner && parts.length && !parts.some(w => owner.toLowerCase().includes(w))) up = null;
      if (!up && !down) continue;
      const m = up && (!down || up.index <= down.index) ? up : down;
      return { kind: m === up ? 'up' : 'down', phrase: m[0], maybe: HEDGE.test(sent) };
    }
    return null;
  };
  // Role news often sits in someone else's note ("While Thornton is out, Royals and Allen will handle more reps").
  // Every saved Yahoo note from the last two days is searched: a player named BEFORE a role-gain phrase in the same
  // sentence gets the news, unless he is the one who is out ("While X is out", "X (ankle) was placed on IR").
  const NOTE_NEWS_HOURS = 48;
  const roleNews = SL => {
    if (!SL) return [];
    const out = new Map(), pre = CACHE_PREFIX + 'note:';   // notes saved in either league: the news is the same, only availability differs
    let keys = [];
    try { keys = Object.keys(localStorage).filter(k => k.startsWith(pre)); } catch (e) { return []; }
    for (const k of keys) {
      let h = null;
      try { h = JSON.parse(localStorage.getItem(k)); } catch (e) { continue; }
      if (!h || !h.d || !h.d.text || Date.now() - h.t > NOTE_NEWS_HOURS * 3600000) continue;
      for (const sent of sentencesOf(h.d.text.replace(/Advice:\s*/, '. '))) {
        const m = ROLE_UP.exec(sent);
        if (!m) continue;
        const before = sent.slice(0, m.index), re = /\b([A-Z][a-zA-Z'.-]+(?:\s+[A-Z][a-zA-Z'.-]+){1,2})/g, owner = titleOwner(sent, m);
        const named = owner ? [{ 1: owner, index: -1 }] : [];
        let x;
        while (!owner && (x = re.exec(before))) named.push(x);
        for (x of named) {
          const ids = SL.byName[normName(x[1])];
          if (!ids || ids.length !== 1) continue;
          const p = SL.players[ids[0]];
          if (!/^(QB|RB|WR|TE)$/.test(p.p)) continue;
          const lead = before.slice(Math.max(0, x.index - 10), Math.max(0, x.index)), tail = before.slice(x.index + x[1].length, x.index + x[1].length + 40);
          if (x.index >= 0 && (/\b(with|while|after|without)\s+$/i.test(lead) || /^\s*(\([^)]*\)\s*)?(is |was |remains |has been )?(out|sidelined|injured|ruled out|placed|on (injured reserve|IR))\b/i.test(tail) || NOT_HIM.test(before.slice(x.index + x[1].length)))) continue;
          if (!out.has(ids[0])) out.set(ids[0], { name: p.n, pos: p.p, team: p.t, phrase: m[0], maybe: HEDGE.test(sent), sentence: sent.slice(0, 240), date: h.d.date });
        }
      }
    }
    return [...out.values()];
  };
  // Players free in THIS league, from pages the board already saved (free-agent lists and the buzz index): no extra requests.
  // Only recent pages count: a page saved weeks ago still lists players who have been claimed since.
  const FREE_LIST_HOURS = 6;
  const availableNames = () => {
    const set = new Set();
    let keys = [];
    try { keys = Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX)); } catch (e) { return set; }
    for (const k of keys) {
      try {
        const list = k.includes('/f1/' + leagueId + '/players?') && /[?&]status=A(&|$|\|)/.test(k), buzz = k.startsWith(CACHE_PREFIX + 'buzz:' + leagueId + ':');
        if (!list && !buzz) continue;
        const h = JSON.parse(localStorage.getItem(k));
        if (!h || Date.now() - h.t > FREE_LIST_HOURS * 3600000) continue;
        if (list) Object.values(h.d || {}).forEach(o => { if (o && o.name) set.add(normName(o.name)); });
        else (h.d || []).forEach(r => set.add(normName(r.name)));
      } catch (e) { /* skip a bad entry */ }
    }
    return set;
  };
  let newsAlerts = [], newsSeen = [];
  const newsKey = n => normName(n.name) + '|' + n.phrase.toLowerCase();
  const refreshNews = async () => {
    const SL = await getSleeper().catch(() => null);
    if (!SL || !board) return;
    const free = availableNames(), mine = new Set(board.roster.players.map(p => normName(p.name)));
    newsAlerts = roleNews(SL).filter(n => free.has(normName(n.name)) && !mine.has(normName(n.name)) && !newsSeen.includes(newsKey(n))).slice(0, 3);
    render();
  };
  const newsBanner = () => {
    const box = el('div', 'ff-news');
    box.appendChild(el('div', 'hd', 'Role news: free in ' + league.name));
    newsAlerts.forEach(n => {
      const row = el('div', 'item');
      row.append(nameLink(n.name, ''), el('span', null, ' (' + n.pos + ', ' + n.team + ') ' + (n.maybe ? 'may get' : 'is named for') + ' "' + n.phrase + '". '), el('span', 'nt', n.sentence));
      box.appendChild(row);
    });
    const ok = el('button', 'ff-btn', 'Got it');
    ok.onclick = e => { e.stopPropagation(); newsSeen = newsSeen.concat(newsAlerts.map(newsKey)).slice(-60); kvSet('newsSeen:' + leagueId, newsSeen); newsAlerts = []; render(); };
    box.appendChild(ok);
    return box;
  };
  let buzzData = null;       // { loading } | { rows, at } | { error }
  const BUZZ_POS = ['QB', 'RB', 'WR', 'TE'];
  const fetchBuzz = async pos => {
    const ck = 'buzz:' + leagueId + ':' + pos + ':' + dayKey(), hit = cacheGet(ck, CACHE_MIN);
    if (hit !== undefined) return hit;
    const res = await yfetch('/f1/' + leagueId + '/buzzindex?sort=BI_S&date=' + dayKey() + '&src=combined&bimtab=A&trendtab=O&pos=' + pos, { credentials: 'include' });
    if (!res.ok) return [];
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const d = parseDoc(doc), vals = Object.values(d);
    if (vals.length && !('Adds' in vals[0] && 'Drops' in vals[0])) { flag('buzz', 'Yahoo\'s Buzz Index columns changed, so its adds and drops cannot be read.', false); return []; }
    const rows = Object.entries(d).map(([id, o]) => ({ id, name: o.name, pos: o._pos || pos, team: o._team, status: o['Roster Status'] || '', ros: pct(o['% Ros']).v, start: pct(o['% Start']).v,
      adds: num(o['Adds']), drops: num(o['Drops']), trades: num(o['Trades']), injTag: o._inj, game: o._tp }));
    cacheSet(ck, rows);
    return rows;
  };
  const loadBuzz = async () => {
    if (buzzData && (buzzData.loading || (Date.now() - buzzData.at < CACHE_MIN * 60000))) return;
    buzzData = { loading: true, at: Date.now() }; render();
    progStart('Reading Yahoo\'s buzz index', 12);
    try {
      const SL = await getSleeper().catch(() => null), all = [];
      for (const pos of BUZZ_POS) all.push(...await fetchBuzz(pos));
      const rows = all.filter(r => !isNaN(r.adds) && !isNaN(r.drops)).map(r => ({ ...r, net: r.adds - r.drops, sl: slInfo(SL, r.name, r.pos, r.team) }))
        .sort((a, b) => b.net - a.net).slice(0, 18);
      buzzData = { rows, at: Date.now(), notesPending: true }; render();
      for (const r of rows.slice(0, 10)) { const n = await fetchNote(r.id, !!r.injTag).catch(() => null); r.role = n && !classify(n, r.name) ? roleOf(n.text, r.name) : null; r.note = n; }   // a player who is out gets no role tag from a note about his replacement
      buzzData.news = roleNews(SL);
      for (const r of rows) {
        if (r.role) continue;
        const n = buzzData.news.find(x => normName(x.name) === normName(r.name));
        if (n) r.role = { kind: 'up', phrase: n.phrase, maybe: n.maybe, via: true };
      }
      buzzData.notesPending = false;
      refreshNews();
    } catch (e) { buzzData = { error: String(e && e.message), at: Date.now() }; }
    progEnd(); render();
  };
  // a player name that opens Yahoo's own search for him (the tray state is restored afterwards)
  const nameLink = (name, id, pick) => { const a = el('span', 'ff-link', name); a.title = "Show " + name + " in Yahoo's player list"; a.onclick = e => { if (!ui.sync) return; e.stopPropagation(); if (pick) pick(); goToPlayer({ name, id }); }; return a; };   // pick: select him first, so he is the one restored   // sync off: the click falls through to the row
  const renderRoleNews = b => {
    const news = (buzzData && buzzData.news) || [];
    b.appendChild(el('h3', null, 'Role changes in the news'));
    if (!news.length) { b.appendChild(el('div', 'ff-hint', buzzData && buzzData.notesPending ? 'Reading notes...' : 'No player is named as gaining a role in the Yahoo notes read in the last two days.')); return; }
    b.appendChild(el('div', 'ff-hint', 'Players named as gaining work in a recent Yahoo note, often a note about someone else (an injury or a trade). Only notes the board has already read are searched; click a name to check if he is free in your league.'));
    const mine = new Set(((board && board.roster && board.roster.players) || []).map(p => normName(p.name)));
    const tbl = el('table', 'ff-cmp'), h = el('tr');
    ['Player', 'News', 'From the note'].forEach(t => h.appendChild(el('th', null, t)));
    tbl.appendChild(h);
    news.slice(0, 12).forEach(n => {
      const tr = el('tr'), nm = el('td', 'lab');
      nm.append(nameLink(n.name, ''), el('div', 'nt', n.pos + ' ' + n.team + (mine.has(normName(n.name)) ? ' | on your roster' : '')));
      const tag = el('td', 'w'); tag.append(chip('c-prod', 'Role up' + (n.maybe ? '?' : '')), el('div', 'nt', (n.maybe ? 'possible: "' : '"') + n.phrase + '"'));
      tr.append(nm, tag, el('td', 'e', n.sentence + (n.date ? ' (' + n.date + ')' : '')));
      tbl.appendChild(tr);
    });
    b.appendChild(tbl);
  };
  const renderBuzz = b => {
    b.appendChild(el('div', 'ff-hint', 'Yahoo buzz = what managers across Yahoo are adding and dropping today (players available in your league). Sleeper = adds in the last 24 hours. "Role up" is read from the latest Yahoo note.'));
    if (!buzzData || buzzData.loading) { b.appendChild(el('div', 'ff-hint', 'Reading Yahoo\'s buzz index...')); return; }
    if (buzzData.error) { b.appendChild(el('div', 'ff-hint', 'Could not read the buzz index: ' + buzzData.error)); return; }
    const posRow = el('div', 'ff-tabs');
    ['ALL', ...BUZZ_POS].forEach(pp => { const t = el('button', 'ff-tabbtn' + ((state.buzzPos || 'ALL') === pp ? ' on' : ''), pp === 'ALL' ? 'All' : pp); t.onclick = () => { state.buzzPos = pp; render(); }; posRow.appendChild(t); });
    b.appendChild(posRow);
    const rows = buzzData.rows.filter(r => !state.buzzPos || state.buzzPos === 'ALL' || r.pos === state.buzzPos);
    if (!rows.length) { b.appendChild(el('div', 'ff-hint', 'Nothing on the buzz index for that position.')); return; }
    const tbl = el('table', 'ff-cmp'), h = el('tr');
    ['Player', 'Yahoo adds / drops', 'Started', 'Sleeper adds', 'Role (from note)'].forEach(t => h.appendChild(el('th', t === 'Started' ? 'xc' : null, t)));   // Started is dropped at S and Side to keep names whole
    tbl.appendChild(h);
    rows.forEach(r => {
      const tr = el('tr'), nm = el('td', 'lab');
      nm.append(nameLink(r.name, r.id), el('div', 'nt', r.pos + ' ' + (r.team || '') + ' | ' + (/^W \(/.test(r.status) ? 'waivers ' + r.status.slice(3, -1) : (r.status === 'FA' ? 'free agent' : r.status)) + (r.injTag ? ' | ' + r.injTag : '')));
      const yad = el('td', r.net > 0 ? 'w' : 'e'); yad.append(fmtSigned(r.net) + ' net', el('div', 'nt', r.adds.toLocaleString() + ' adds / ' + r.drops.toLocaleString() + ' drops'));
      const st = el('td', 'e xc', isNaN(r.start) ? '-' : r.start + '%');
      const sl = el('td', r.sl && r.sl.add ? 'w' : 'e', r.sl && r.sl.add ? '#' + r.sl.add.posRank + ' at ' + r.pos + ' (' + r.sl.add.count.toLocaleString() + ')' : 'not trending');
      const role = el('td', r.role ? (r.role.kind === 'up' ? 'w' : 'l') : 'e');
      if (r.role) { role.append(chip(r.role.kind === 'up' ? 'c-prod' : 'c-out', (r.role.kind === 'up' ? 'Role up' : 'Role down') + (r.role.maybe ? '?' : '')), el('div', 'nt', (r.role.maybe ? 'possible: "' : '"') + r.role.phrase + '"' + (r.role.via ? ' (from another player\'s note)' : ''))); }
      else role.textContent = r.note === undefined ? (buzzData.notesPending ? 'reading note...' : '') : (r.note ? 'no role change in note' : 'no note');
      tr.append(nm, yad, st, sl, role); tbl.appendChild(tr);
    });
    b.appendChild(tbl);
    renderRoleNews(b);
    const both = buzzData.rows.filter(r => r.net > 0 && r.sl && r.sl.add).length;
    b.appendChild(el('div', 'ff-hint', both ? both + ' of these are also trending on Sleeper: when both agree, the move is more likely real.' : 'None of these are in Sleeper\'s top adds today.'));
  };
  const fmtSigned = v => (v > 0 ? '+' : '') + Number(v).toLocaleString();
  const renderTrends = (b, R, sumEl) => {
    b.appendChild(el('h3', null, 'Global player trends'));
    renderBuzz(b);
    if (!trendData) { b.appendChild(el('div', 'ff-hint', 'Loading saved snapshots...')); if (sumEl) { sumEl.className = ''; sumEl.textContent = ''; } return; }
    const { snaps, movers, streaks, txSummary } = trendData;

    b.appendChild(el('h3', null, 'Sleeper momentum (days in the top adds)'));
    if (!streaks.length) b.appendChild(el('div', 'ff-hint', snaps.length < 2 ? 'Needs at least 2 days of snapshots.' : 'No player has been in the top adds 2 or more days running.'));
    else { const tbl = el('table', 'ff-cmp'); const h = el('tr'); ['Player', 'Days in a row', 'Adds in 24h (latest)'].forEach(t => h.appendChild(el('th', null, t))); tbl.appendChild(h);
      streaks.slice(0, 10).forEach(x => { const tr = el('tr'), n = el('td', 'e'); n.appendChild(nameLink(x.name, x.id)); tr.append(n, el('td', 'e', String(x.streak)), el('td', 'e', x.count.toLocaleString())); tbl.appendChild(tr); }); b.appendChild(tbl); }

    b.appendChild(el('h3', null, 'Your league'));
    const btns = el('div', 'ff-irbox');
    btns.append(snaps.length ? 'Snapshots saved for ' + snaps.length + ' day' + (snaps.length > 1 ? 's' : '') + ' (latest ' + snaps[snaps.length - 1].date + '). ' : 'No snapshots yet. ');
    const now = el('button', 'ff-btn', snaps.length && snaps[snaps.length - 1].date === dayKey() && (snaps[snaps.length - 1].tx || []).length ? 'Already saved today' : 'Take snapshot now');
    now.onclick = async () => { now.disabled = true; now.textContent = 'Saving...'; const lastSn = snaps[snaps.length - 1]; await takeSnapshot(board.roster, await getSleeper().catch(() => null), board.week, !!lastSn && lastSn.date === dayKey() && !(lastSn.tx || []).length); await refreshTrends(); render(); };
    const dl = el('button', 'ff-btn', 'Download JSON'); dl.onclick = () => downloadSnaps();
    btns.append(now, dl, el('div', 'ff-hint', (snapStatus || 'A snapshot is taken automatically once a day when you open a Yahoo page. It costs about 6 Yahoo requests.') + ' Kept ' + KEEP_DAYS + ' days.'));
    b.appendChild(btns);

    b.appendChild(el('h3', null, 'Wire movers in your league (Yahoo % rostered)'));
    if (snaps.length < 2) b.appendChild(el('div', 'ff-hint', 'Needs at least 2 days of snapshots (have ' + snaps.length + '). Come back tomorrow.'));
    else if (!movers.length) b.appendChild(el('div', 'ff-hint', 'No wire player changed ownership since ' + snaps[0].date + '.'));
    else {
      const tbl = el('table', 'ff-cmp'); const h = el('tr'); ['Player', 'From', 'To', 'Change'].forEach(t => h.appendChild(el('th', null, t))); tbl.appendChild(h);
      movers.slice(0, 12).forEach(m => { const tr = el('tr'), n = el('td', 'e'); n.append(nameLink(m.name, m.id), ' (' + m.pos + ')'); tr.append(n, el('td', 'e', m.from + '%'), el('td', 'e', m.to + '%'), el('td', m.d > 0 ? 'w' : 'l', (m.d > 0 ? '+' : '') + m.d + ' pts since ' + m.since)); tbl.appendChild(tr); });
      b.appendChild(tbl);
    }

    b.appendChild(el('h3', null, 'Most active managers in your league'));
    if (!txSummary || !txSummary.n) b.appendChild(el('div', 'ff-hint', 'No transactions captured yet. Take a snapshot to read the feed.'));
    else {
      const g = el('div'); txSummary.who.forEach(([k, v]) => g.appendChild(el('div', 'sub', k + ': ' + v + ' moves')));
      b.appendChild(g);
      b.appendChild(el('div', 'ff-hint', 'From the latest ' + txSummary.n + ' transactions Yahoo lists, so it covers recent days only.'));
    }
    if (sumEl) { sumEl.className = ''; sumEl.textContent = ''; }
  };
  const refreshTrends = async () => {
    const snaps = await loadSnaps(14), last7 = snaps.slice(-7);
    trendData = { snaps, movers: computeMovers(last7), streaks: computeStreaks(last7), txSummary: snaps.length ? summarizeTx(snaps[snaps.length - 1].tx || []) : null };
  };

  // ---- slide-out tray: a tab on the right edge opens/closes it over the Yahoo page ------------------------
  const DOCK_W = 360;
  const ui = { open: true, w: 560, sync: true, dock: false };   // dock: a narrow sidebar that pushes the Yahoo page aside instead of covering it
  const saveUi = () => kvSet('ui', ui);
  const applyUi = () => {
    const t = document.getElementById('ff-tray'); if (!t) return;
    const w = ui.dock ? DOCK_W : ui.w;
    t.style.setProperty('--ffw', w + 'px');
    t.classList.toggle('closed', !ui.open);
    t.classList.toggle('docked', ui.dock);
    t.classList.toggle('wide', w >= 500); t.classList.toggle('xwide', w >= 700);   // extra lineup columns at M and L
    // docked and open: make room on the right so the page reflows beside the tray; otherwise give the space back
    document.documentElement.style.paddingRight = ui.dock && ui.open ? w + 'px' : '';
    t.querySelectorAll('.sz').forEach(b => b.classList.toggle('on', b.dataset.dock ? ui.dock : (!ui.dock && Math.abs(+b.dataset.w - ui.w) < 30)));
    const tab = document.getElementById('ff-tab'); if (tab) tab.textContent = ui.open ? 'Hide \u25B8' : '\u25C2 Fantasy';
  };
  function ensureBar() {
    if (!document.getElementById('ff-style')) { const st = el('style'); st.id = 'ff-style'; st.textContent = CSS; document.head.appendChild(st); }
    let tray = document.getElementById('ff-tray');
    if (!tray) {
      tray = el('div'); tray.id = 'ff-tray';
      const tab = el('button'); tab.id = 'ff-tab'; tab.type = 'button';
      tab.onclick = () => { ui.open = !ui.open; saveUi(); applyUi(); };
      const grip = el('div'); grip.id = 'ff-grip';
      grip.onpointerdown = e => {
        e.preventDefault(); grip.setPointerCapture(e.pointerId); tray.style.transition = 'none';
        const move = ev => { ui.dock = false; ui.w = Math.round(Math.min(window.innerWidth * 0.94, Math.max(380, window.innerWidth - ev.clientX))); applyUi(); };
        const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); tray.style.transition = ''; saveUi(); };
        grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
      };
      const head = el('div'); head.id = 'ff-head';
      const row = el('div', 'row');
      row.appendChild(el('span', 'ttl', 'Fantasy decision board'));
      [['S', 420], ['M', 560], ['L', 780]].forEach(([l, w]) => { const b = el('button', 'sz', l); b.dataset.w = w; b.title = 'Width ' + w + 'px, over the page'; b.onclick = () => { ui.w = w; ui.dock = false; saveUi(); applyUi(); }; row.appendChild(b); });
      const side = el('button', 'sz', 'Side'); side.dataset.dock = '1'; side.title = 'Narrow sidebar beside the page (pushes Yahoo aside instead of covering it)';
      side.onclick = () => { ui.dock = true; ui.open = true; saveUi(); applyUi(); };
      row.appendChild(side);
      const x = el('button', 'sz', '\u00D7'); x.title = 'Slide the tray away (click the side tab to bring it back)'; x.onclick = () => { ui.open = false; saveUi(); applyUi(); };
      row.appendChild(x);
      const status = el('div', 'ff-bar');
      const pg = el('div'); pg.id = 'ff-prog'; pg.style.display = 'none'; pg.append(el('div', 'lab'), el('div', 'trk'));
      pg.querySelector('.trk').appendChild(el('div', 'fill'));
      const sum = el('div'); sum.id = 'ff-sum';
      const hl = el('div'); hl.id = 'ff-health';
      head.append(row, status, pg, hl, sum);
      const body = el('div'); body.id = 'ff-body';
      tray.append(grip, tab, head, body);
      document.documentElement.appendChild(tray);
      applyUi();
    }
    return tray.querySelector('.ff-bar');
  }

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    const bar = ensureBar();
    try {
      const table = [...document.querySelectorAll('table')].filter(t => t.querySelector('a.name'))
        .sort((a, b) => b.rows.length - a.rows.length)[0];
      if (!table && onList) return;   // the league home page has no player table; it still gets the Lineup tab
      const week = readWeek(); curWeek = week;
      if (weekGuessed) flag('week', 'Could not read the current week from this Yahoo page, so week ' + week + ' is assumed: byes and recent-week stats may be off.', false);
      const listPos = onList ? (new URLSearchParams(location.search).get('pos') || 'O') : 'O';
      bar.textContent = 'Fantasy manager: loading your roster, weekly points, Yahoo notes and Sleeper trends...';
      progStart('Loading your roster and recent weeks', onList ? 30 : 8);
      let SL = null;
      try { SL = await getSleeper(); } catch (e) { window.__ffErr = 'sleeper: ' + e.message; health.sleeperOk = false; flag('sleeper', 'Sleeper trends and injury tags could not be loaded.', false); }
      mark('sleeper ready');
      progStage('Reading your roster', 5);
      // offense first so the lineup shows quickly; kicker and defense stats follow in the background
      const addP = onAdd ? readAddPlayer() : null;
      const roster = await loadRoster(week, SL, onList ? listPos : (addP ? addP.pos : 'O'));
      mark('roster loaded');
      progStage('Roster loaded', 35);
      let radar = null, addCand = null;
      if (addP) state.radarPos = addP.pos;   // the add page: his position's wire, with him in the comparison
      if (onList && !state.radarPos && /^(QB|RB|WR|TE|K|DEF)$/.test(listPos)) state.radarPos = listPos;   // start where Yahoo's list is; change it in the tray
      if (onList && !state.radarPos && savedSel && /^(QB|RB|WR|TE|K|DEF)$/.test(savedSel.radarPos || '')) state.radarPos = savedSel.radarPos;   // a name search has no position in its address
      if (onList && !state.radarPos) { const top = needsOf(roster.players, week, SLOTS)[0]; if (top) state.radarPos = top.pos; }   // "All" list: start on what you need
      board = { roster, radar: null, listPos, week };
      if (savedSel && onList) {       // coming back from a position change or name search made in the tray
        const r0 = savedSel.rep && savedSel.repManual ? roster.players.find(q => q.id === savedSel.rep) : null;
        if (r0) { state.rep = r0; state.repManual = true; }
      }
      if (!state.rep) state.rep = defaultRep(roster, state.radarPos);
      const backToStash = !!(onList && savedSel && savedSel.view === 'stash');
      const backToTrends = !!(onList && savedSel && savedSel.view === 'trends');
      if (backToStash) state.view = 'stash';
      if (backToTrends) state.view = 'trends';
      // show the board as soon as your roster is in (Lineup tab, roster cards, pending claims); the wire scan fills in afterwards
      if (state.radarPos) radarLoading = true;
      bar.textContent = 'Fantasy manager: your roster is loaded' + (state.radarPos ? '; scanning the ' + state.radarPos + ' wire next...' : '.');
      render();
      mark('roster shown');
      refreshNews();                                       // from notes and free-agent lists already saved: no requests
      if (backToStash && !stashData) loadStashView();      // back from a name search made in the Stash tab
      if (backToTrends) openTrends();                      // ...or in the Trends tab
      if (state.radarPos) {
        progStage('Scanning the ' + state.radarPos + ' wire', 40);
        try { radar = await loadRadar(state.radarPos, week, SL); } finally { radarLoading = false; }
        board.radar = radar;
        if (savedSel && onList) {
          const c0 = savedSel.cand ? radar.find(q => q.id === savedSel.cand.id) : null;
          if (c0) state.cand = c0;
        }
        if (addP) { addCand = radar.find(q => q.id === addP.id) || await loadOne(addP, week, SL); state.cand = addCand; }
        if (state.cand && state.cand.pos !== state.radarPos) state.cand = null;
        if (!state.cand) state.cand = radar.find(p => p.out === 0) || null;
      }
      const cameBack = !!(savedSel && onList && savedSel.cand);
      mark('wire list shown');
      bar.textContent = 'Fantasy manager: decision board for ' + league.name + ', week ' + week + '. Data: Yahoo and Sleeper. Yahoo requests so far on this page: ' + yCount + '. Read the player note before you claim.';
      render();
      if (cameBack || addCand) setTimeout(showResult, 50);   // back from a name search: show the comparison, not the top of the tray
      // notes first (they decide who is injured), then kicker and defense stats (about ten requests) in the background
      const notesDone = radar && radar.loadNotes
        ? radar.loadNotes().then(() => { mark('notes loaded'); refreshNews(); if (board && board.radar === radar) { if (state.cand && state.cand !== addCand && state.cand.pos === state.radarPos && !radar.includes(state.cand)) state.cand = null; render(); } }).catch(() => {})
        : Promise.resolve();
      let kdDone = notesDone;
      if (!roster.kd) {
        kdDone = notesDone.then(() => {
          progStart('Loading kicker and defense stats', 11);
          return loadRoster(week, SL, 'K').then(r => {
            board.roster = r;
            if (state.rep && !state.rep.isFree) state.rep = r.players.find(q => q.id === state.rep.id) || state.rep;
            progEnd(); mark('kicker/defense loaded'); render();
          }).catch(() => progEnd());
        });
      }
      // once a day, quietly save a snapshot (a few seconds after the board so the page is not hammered)
      setTimeout(() => { kdDone.then(() => takeSnapshot(board.roster, SL, week, false)).then(doc => { if (dropAlerts.length) render(); if (doc) { const st = document.querySelector('.ff-bar'); if (st) st.textContent += ' ' + snapStatus; } renderHealth(); }); }, TEST && typeof TEST.snapDelayMs === 'number' ? TEST.snapDelayMs : 4000);
      // light touch on the Yahoo list itself: tint your own players
      const ids = new Set(roster.players.map(p => p.id));
      if (onList && table) table.querySelectorAll('tr').forEach(tr => { const a = tr.querySelector('a.name'); if (a && ids.has(playerId(a))) tr.querySelectorAll('td').forEach(td => (td.style.background = '#f3ecff')); });
    } catch (e) {
      window.__ffErr = String(e && e.stack || e);
      bar.textContent = 'Fantasy manager: could not build the board (' + (e && e.message) + ').';
      flag('run', 'The board could not be built: ' + (e && e.message), true); renderHealth();
    } finally { running = false; progEnd(); }
  };

  // Your roster changes without a page load (Yahoo saves lineup moves in place, or you add/drop in another tab).
  // Re-read it then, so the board never keeps judging the old roster.
  const onMyTeam = new RegExp('^/f1/' + leagueId + '/' + league.teamId + '(/|$)').test(PATH);
  const rosterSig = doc => parseRoster(doc).map(p => p.slot + ':' + p.id + ':' + p.injTag).join(',');
  let lastSig = '', reloading = false, lastCheck = Date.now();
  const reloadRoster = async html => {
    if (reloading || running || !board) return;
    reloading = true;
    try {
      rosterCache = null; teamHtmlMemo = html ? { t: Date.now(), html } : null;
      const SL = await getSleeper().catch(() => null);
      board.roster = await loadRoster(board.week, SL, 'K');
      if (state.rep && !state.rep.isFree) state.rep = board.roster.players.find(q => q.id === state.rep.id) || null;
      lastSig = rosterSig(new DOMParser().parseFromString(teamHtmlMemo.html, 'text/html'));
      mark('roster re-read'); render(); refreshNews();
    } catch (e) { /* keep the board as it was */ } finally { reloading = false; }
  };
  const checkRoster = async fromPage => {
    if (!board || running || reloading) return;
    let html;
    if (fromPage) { if (!onMyTeam) return; html = document.documentElement.outerHTML; }   // your team page: the page itself is the newest roster, no request
    else {
      if (Date.now() - lastCheck < 120000) return;                                   // another tab: at most one team-page request per 2 minutes
      lastCheck = Date.now();
      try { const res = await yfetch('/f1/' + leagueId + '/' + league.teamId, { credentials: 'include' }); if (!res.ok) return; html = await res.text(); } catch (e) { return; }
    }
    const sig = rosterSig(new DOMParser().parseFromString(html, 'text/html'));
    if (!lastSig) lastSig = rosterSig(new DOMParser().parseFromString(teamHtmlMemo ? teamHtmlMemo.html : html, 'text/html'));
    if (sig && sig.split(',').length >= 8 && sig !== lastSig) await reloadRoster(html);
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkRoster(false); });

  // Yahoo redraws the list in place (sorting, filtering); rebuild if the board vanishes.
  let timer;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!running && board && !document.querySelector('.ff-board')) { document.getElementById('ff-tray')?.remove(); render(); }
      checkRoster(true);
    }, 800);
  };
  if (TEST) {
    TEST.api = { readAddPlayer, loadOne, parseDoc, parseTransactions, parseReturn, stashFit, stashQuality, classify, segmentRest, txKind, metaSplit,
      GOOD, formText, summarizeTx, computeMovers, computeStreaks, checkRoster, pct, normName, nameKey, roleOf, roleNews, outLevel, proven, parseRoster, compare, coversBye, surplusStarter, seasonDone, irOption, suggestReplace, computeLineup, emptySlots, needsOf, startScore, setSlots: v => { SLOTS = v; }, getPending: () => pending, metrics, state, getYahooCount: () => yCount };
  }
  // The first visit to a league reads its settings; after that they come from storage and are re-read weekly.
  const leagueSettings = async () => {
    const cfg = await kvGet(cfgKey);
    if (cfg && cfg.v >= 2 && Date.now() - (cfg.t || 0) < SETTINGS_DAYS * 864e5) return cfg;   // v2 also counts bench slots
    try {
      const res = await yfetch('/f1/' + leagueId + '/settings', { credentials: 'include' });
      const r = res.ok ? parseSettings(new DOMParser().parseFromString(await res.text(), 'text/html')) : null;
      if (r) { await saveSettings(r); return r; }
    } catch (e) { /* run on the defaults, and try again on the next page */ }
    return cfg || {};
  };
  Promise.all([leagueSettings(), kvGet('ui'), kvGet('sel:' + leagueId), kvGet('newsSeen:' + leagueId)]).then(async ([cfg, savedUi, sel, seen]) => {
    applySettings(cfg);
    const saved = await load();
    if (Array.isArray(seen)) newsSeen = seen;
    if (sel) kvRemove('sel:' + leagueId);       // used once: a later plain reload starts clean
    if (sel && Date.now() - sel.t < 600000) savedSel = sel;
    if (saved && Object.keys(saved).length) SLOTS = Object.assign({}, DEFAULT_SLOTS, saved);
    if (savedUi && typeof savedUi.w === 'number') { ui.w = savedUi.w; ui.open = savedUi.open !== false; }
    if (savedUi && typeof savedUi.sync === 'boolean') ui.sync = savedUi.sync;
    if (savedUi && savedUi.dock === true) ui.dock = true;
    run();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  });
})();
