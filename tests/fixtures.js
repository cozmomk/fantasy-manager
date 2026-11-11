// An offline stand-in for Yahoo Fantasy and Sleeper, built from the page structures observed on the real sites.
// Nothing here talks to the internet.

export const LEAGUE_ID = '111111';
export const TEAM_ID = '6';
export const TEAM_NAME = 'Test Team';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// weeks = points in weeks 1-4 (null = did not play). ros/start are [value, weekly change].
const P = (id, name, team, pos, o) => ({ id: String(id), name, team, pos, bye: 8, weeks: [null, null, null, null], ros: [50, 0], start: [20, 0], adp: NaN, depth: pos + '1', preRank: 150, inj: '', note: null, status: 'FA', ...o });

export const players = [
  // ---- your roster (team 6) ----
  P(1, 'Joe Burrow', 'Cin', 'QB', { bye: 6, weeks: [15, 16, 23, 26], adp: 25, ros: [100, 0], start: [90, 0], preRank: 10, mine: true, slot: 'QB' }),
  P(2, 'Jacory Croskey-Merritt', 'Was', 'RB', { bye: 7, weeks: [12, 5, 4, 5], adp: 120, depth: 'RB1', preRank: 90, mine: true, slot: 'RB', ros: [82, 0], start: [26, 0] }),
  P(3, 'Braelon Allen', 'NYJ', 'RB', { bye: 13, weeks: [4, 8, 2, 7], adp: 140, depth: 'RB1', preRank: 146, mine: true, slot: 'RB', ros: [84, 0] }),
  P(4, 'Amon-Ra St. Brown', 'Det', 'WR', { bye: 6, weeks: [19, 26, 8, 8], adp: 7.9, depth: 'WR1', preRank: 8, mine: true, slot: 'WR', ros: [100, 0], start: [100, 0] }),
  P(5, 'Jalen Coker', 'Car', 'WR', { bye: 5, weeks: [26, 7, 2, 0], adp: 125, depth: 'WR2', mine: true, slot: 'BN', inj: 'Q', ros: [85, -5] }),
  P(6, 'Brock Bowers', 'LV', 'TE', { bye: 13, weeks: [0, 0, 18, 15], adp: 20, depth: 'TE1', preRank: 30, mine: true, slot: 'TE', ros: [100, 0] }),
  P(7, 'Trey McBride', 'Ari', 'TE', { bye: 14, weeks: [16, 10, 8, 3], adp: 22, depth: 'TE1', preRank: 25, mine: true, slot: 'W/R/T', ros: [100, 0] }),
  P(8, 'Jonah Coleman', 'Den', 'RB', { bye: 10, weeks: [0, 12, 0, 0], adp: 128, depth: 'RB4', mine: true, slot: 'BN', inj: 'IR', note: 'Coleman (ankle) was placed on injured reserve.' }),
  P(9, 'Terry McLaurin', 'Was', 'WR', { bye: 7, weeks: [1, 5, 14, 0], adp: 56.7, depth: 'WR1', preRank: 65, mine: true, slot: 'BN', ros: [93, -2], start: [29, 5] }),
  P(10, 'Jonathon Brooks', 'Car', 'RB', { bye: 5, weeks: [6, 1, 0, 0], adp: 180, depth: 'RB3', mine: true, slot: 'IR', inj: 'IR' }),
  P(11, 'Evan McPherson', 'Cin', 'K', { bye: 6, weeks: [18, 12, 11, 4], adp: 150, depth: 'K1', mine: true, slot: 'K', ros: [100, 0] }),
  P(12, 'Ravens', 'Bal', 'DEF', { bye: 13, weeks: [7, 3, 5, 7], adp: 100, mine: true, slot: 'DEF', ros: [100, 0] }),
  P(62, 'Seahawks', 'Sea', 'DEF', { bye: 11, weeks: [12, 9, 4, 10], ros: [40, 5], status: 'FA', oppPts: 17.5 }),
  P(63, 'Texans', 'Hou', 'DEF', { bye: 6, weeks: [3, 2, 1, 4], ros: [20, 0], status: 'FA', oppPts: 25 }),
  // ---- the wire ----
  P(20, 'Kirk Cousins', 'LV', 'QB', { bye: 13, weeks: [13, 17, 18, 21], ros: [37, 15], start: [22, 13], status: 'W', depth: 'QB1', preRank: 120 }),
  P(21, 'C.J. Stroud', 'Hou', 'QB', { bye: 8, weeks: [18, 17, 19, 20], ros: [63, 3], start: [40, 2], status: 'W', depth: 'QB1', preRank: 60 }),
  P(22, 'Bo Nix', 'Den', 'QB', { bye: 10, weeks: [28, 5, 6, 4], ros: [81, -4], start: [60, -5], status: 'W', depth: 'QB1', preRank: 40 }),
  P(30, 'Mike Washington Jr.', 'LV', 'RB', { bye: 13, weeks: [4, 1, 11, 2], ros: [42, 7], status: 'W', depth: 'RB2' }),
  P(31, 'Chris Rodriguez Jr.', 'Jax', 'RB', { bye: 7, weeks: [2, 1, 10, 10], ros: [35, -2], status: 'W', depth: 'RB2' }),
  P(32, 'Will Shipley', 'Phi', 'RB', { bye: 10, weeks: [1, 2, 3, 9], ros: [48, 4], status: 'W', depth: 'RB2', inj: 'Q' }),
  P(40, 'Darius Cooper', 'Phi', 'WR', { bye: 10, weeks: [null, 9, null, 15], ros: [8, 8], start: [4, 4], status: 'W', depth: 'WR5', preRank: 330 }),
  P(41, 'Roman Wilson', 'Pit', 'WR', { bye: 9, weeks: [3, 3, 12, 13], ros: [28, 25], start: [15, 15], status: 'W', depth: 'WR2', inj: 'Q', note: 'Roman Wilson has been ruled out for the remainder of Week 5 with a dislocated finger.Advice: Wilson had one target.' }),
  P(42, 'Tyquan Thornton', 'KC', 'WR', { bye: 5, weeks: [null, 9, 2, 23], ros: [2, -1], status: 'FA', depth: 'WR6', inj: 'O', note: 'Thornton is slated to undergo surgery on the dislocated left ankle and is facing a recovery timeline of 3-to-4 months.Advice: Depending how quickly he bounces back.', preRank: 320 }),
  P(43, 'Kalif Raymond', 'Chi', 'WR', { bye: 5, weeks: [8, 4, 15, null], ros: [23, -14], status: 'W', depth: 'WR3' }),
  P(44, 'Evil <img src=x onerror=window.__pwned=1> Wicks', 'Phi', 'WR', { bye: 10, weeks: [13, 7, 3, 2], usage: [[0, 3], [0, 4], [0, 9], [0, 11]], ros: [44, -16], status: 'W', depth: 'WR2' }),
  P(50, 'Michael Mayer', 'LV', 'TE', { bye: 13, weeks: [3, 2, 6, 5], ros: [20, 3], status: 'W', depth: 'TE2' }),
  P(51, 'Brenton Strange', 'Jax', 'TE', { bye: 7, weeks: [6, 2, 3, 7], ros: [32, 5], status: 'W', depth: 'TE1' }),
  P(52, 'Tyler Higbee', 'LAR', 'TE', { bye: 8, weeks: [null, null, 5, 4], ros: [15, 2], status: 'FA', depth: 'TE2' }),
  P(60, 'Ryan Fitzgerald', 'Car', 'K', { bye: 8, weeks: [9, 10, 8, 12], ros: [10, 1], status: 'FA', depth: 'K1' }),
  P(61, 'Chase McLaughlin', 'TB', 'K', { bye: 8, weeks: [8, 9, 9, 7], ros: [12, 0], status: 'W', depth: 'K1', proj: 11 }),
  // ---- injured and available (IR-eligible) ----
  P(70, 'Caleb Williams', 'Chi', 'QB', { bye: 5, weeks: [24, 22, null, null], ros: [60, 0], status: 'W', depth: 'QB1', inj: 'O', preRank: 30, note: 'Williams (shoulder) is expected to miss 3-4 weeks.' }),
  P(71, 'Pat Bryant', 'Den', 'WR', { bye: 10, weeks: [4, 2, 12, 5], ros: [5, -3], status: 'W', depth: 'WR3', inj: 'IR', note: 'Bryant (ankle) was placed on the Broncos\' injured reserve Friday.' }),
];

// stats for each view of a list page
const total = p => p.weeks.reduce((a, b) => a + (b || 0), 0);
// rush attempts and targets in a week (Yahoo's "Att*" and "Tgt*"): explicit per player, or derived from that week's points
const usageOf = (p, stat) => {
  const m = /^S_W_(\d)$/.exec(stat);
  if (!m || !/^(QB|RB|WR|TE)$/.test(p.pos)) return ['-', '-'];
  const w = +m[1], pts = p.weeks[w - 1];
  if (pts === null || pts === undefined) return ['-', '-'];
  if (p.usage) return p.usage[w - 1];
  if (p.pos === 'RB') return [Math.round(pts * 1.1), Math.round(pts * 0.25)];
  if (p.pos === 'QB') return [Math.round(pts * 0.1), 0];
  return [0, Math.round(pts * 0.6)];
};
const games = p => p.weeks.filter(v => v !== null).length;
const f2 = v => v.toFixed(2);
const statValue = (p, stat) => {
  if (stat === 'S_S_2026') return total(p);
  if (stat === 'S_AL4W') return games(p) ? total(p) / games(p) : 0;
  const m = /^S_W_(\d)$/.exec(stat);
  if (m) { const v = p.weeks[+m[1] - 1]; return v === null || v === undefined ? null : v; }
  return p.proj ?? (games(p) ? total(p) / games(p) : 0) * 0.9;    // S_PW_5 projection
};

const statusHtml = p => p.mine ? `<a href="/f1/${LEAGUE_ID}/${TEAM_ID}">${TEAM_NAME}</a>` : (p.status === 'W' ? 'W (Oct 14)' : 'FA');
const nameCell = p => `<a class="name" href="https://sports.yahoo.com/nfl/${p.pos === 'DEF' ? 'teams/' + p.team.toLowerCase() + '/' : 'players/' + p.id}">${esc(p.name)}</a>` +
  `<span class="Fz-xxs">${p.team} - ${p.pos}</span>` + (p.inj ? `<span class="F-injury Fz-xxs" title="${p.inj}">${p.inj}</span>` : '');

export function listPage({ pos = 'O', status = 'A', stat = 'S_PW_5', fteam, sort = 'PR', count = 0, name = null }) {
  let rows = players.filter(p => pos === 'O' ? /^(QB|RB|WR|TE)$/.test(p.pos) : p.pos === pos);
  if (name) rows = players.filter(p => p.name.toLowerCase().includes(name.toLowerCase()));
  if (status === 'T' && fteam) rows = rows.filter(p => p.mine);
  else if (status === 'A') rows = rows.filter(p => !p.mine);
  else if (status === 'STATE_IR') rows = rows.filter(p => !p.mine && (p.inj === 'O' || p.inj === 'IR'));
  if (sort === 'AR') rows.sort((a, b) => (statValue(b, stat) || 0) - (statValue(a, stat) || 0));
  else rows.sort((a, b) => a.preRank - b.preRank);
  rows = rows.slice(+count, +count + 25);
  const research = stat === 'R_O';
  const weekly = /^S_W_\d+$/.test(stat);
  const head = research
    ? ['', '', 'Offense', 'Highlight', 'Roster Status', 'Opp Rank', '% Ros', '% Start', 'Avg Pick', 'Depth Chart']
    : ['', '', 'Offense', 'Highlight', 'Roster Status', 'GP*', 'Bye', 'Fan Pts', 'Pre-Season', 'Actual', '% Ros', 'Att*', 'Tgt*', 'Pts vs.*'];
  const pctCell = ([v, d]) => `${v}% (${d > 0 ? '+' : d < 0 ? '-' : ''}${d ? Math.abs(d) : '–'})`;
  const body = rows.map(p => {
    const v = statValue(p, stat);
    const cells = research
      ? ['', '', nameCell(p), '', statusHtml(p), '10th for WRs', pctCell(p.ros), pctCell(p.start), isNaN(p.adp) ? '-' : p.adp, p.depth]
      // a weekly view shows a game he missed (injured, inactive) as GP "-" with 0.00 points, as Yahoo does
      : ['', '', nameCell(p), '', statusHtml(p), weekly ? (v === null ? '-' : 1) : games(p), p.bye, v === null ? (weekly ? '0.00' : '-') : f2(v), p.preRank, 100, `${p.ros[0]}%`, ...usageOf(p, stat),
        p.pos === 'DEF' && /^S_PW_/.test(stat) ? (p.oppPts ?? 21).toFixed(1) : '-'];   // a defense's points allowed (projected for the week)
    return `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
  }).join('');
  return `<!doctype html><html><head><title>Player List | Fantasy Football | Yahoo! Sports</title></head><body>
    <div>Stats: Week 5 (proj)</div>
    <table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}

// Yahoo's "Transaction Trends" page: adds, drops and trades across Yahoo's leagues for players available to you
export function buzzPage(pos = 'WR') {
  const rows = players.filter(p => !p.mine && p.pos === pos);
  const head = ['', '', 'Player', 'Roster Status', '% Ros', '% Start', 'Adds', 'Drops', 'Trades', 'Total'];
  const body = rows.map(p => {
    const adds = Math.max(500, (160 - +p.id) * 900), drops = +p.id * 90, trades = +p.id % 7;
    return `<tr>${['', '', nameCell(p), statusHtml(p), `${p.ros[0]}%`, `${p.start[0]}%`, adds, drops, trades, adds + drops + trades].map(c => `<td>${c}</td>`).join('')}</tr>`;
  }).join('');
  return `<!doctype html><html><head><title>Transaction Trends | Fantasy Football | Yahoo! Sports</title></head><body>
    <table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}

export function teamPage() {
  const mine = players.filter(p => p.mine);
  const mk = list => list.map((p, i) => `<tr><td>${p.slot}</td><td></td><td>${nameCell(p)}<span class="ysf-player-detail Nowrap Fz-xxs">${p.gameLine || (p.bye === 6 ? 'Bye - No game this week' : `Sun 1:00 pm ${i % 2 ? '@' : 'vs'} Kc`)}</span></td><td>${p.bye}</td>${p.bye === 6 ? '<td colspan="3">Bye</td><td>95%</td>' : `<td>10.00</td><td>${(8 + i * 1.25).toFixed(2)}</td><td>${60 - i}%</td>`}</tr>`).join('');
  const head = '<tr><th>Pos</th><th>Edit</th><th>Offense</th><th>Bye</th><th>Fan Pts</th><th>Proj Pts</th><th>% Start</th><th>% Ros</th></tr>';
  const t = (id, list) => `<table id="${id}">${head}<tr><th></th></tr>${mk(list)}</table>`;
  return `<!doctype html><html><body><div>Waiver Priority: 3rd</div>
    ${t('statTable0', mine.filter(p => /^(QB|RB|WR|TE)$/.test(p.pos)))}${t('statTable1', mine.filter(p => p.pos === 'K'))}${t('statTable2', mine.filter(p => p.pos === 'DEF'))}</body></html>`;
}

// Yahoo's "Add Free Agent" page for one player: his name and "Team - Pos" up top, the week in the rankings box,
// then your roster in drop tables with checkboxes (the tool never touches them)
export function addPage(pid) {
  const p = players.find(x => x.id === String(pid));
  const mine = players.filter(x => x.mine);
  return `<!doctype html><html><body><h2>Add Free Agent</h2>
    <div><div><a class="name" href="https://sports.yahoo.com/nfl/players/${p.id}">${esc(p.name)}</a><a href="#">Player Note</a></div><div>${p.team} - ${p.pos}</div></div>
    <table><tr><td>Projected Rankings</td><td>Transactions Trends</td></tr><tr><td>Week 5</td><td>Next 4 Wks</td></tr></table>
    <form method="post" action="/f1/${LEAGUE_ID}/${TEAM_ID}/addplayer"><table class="statTable-drop">${mine.map(x => `<tr><td><input type="checkbox" name="dpid" value="${x.id}"></td><td>${nameCell(x)}</td></tr>`).join('')}</table></form></body></html>`;
}

export const noteJson = pid => {
  if (DROPPED[pid]) return JSON.stringify({ content: `<div>${DROPPED[pid][0]} | Roster Status: Waivers (Nov 4) | % Ros ${DROPPED[pid][1]}% Rostered</div>`, hash: 'x', js: '', objects: [], errors: [] });
  const p = players.find(x => x.id === String(pid));
  const text = p && p.note ? p.note : (p ? `${p.name} caught two of three targets in Sunday's game.` : '');
  return JSON.stringify({ content: `<div class="noteitem"><span>Player Note</span> <span class="date">Today, 6:08 pm</span> ${esc(text)}</div>`, hash: 'x', js: '', objects: [], errors: [] });
};

// a date inside the alert window, written the way Yahoo writes it ("Nov 1, 9:59 am")
const recent = new Date(Date.now() - 864e5).toLocaleString('en-US', { month: 'short', day: 'numeric' }) + ', 9:59 am';
// player cards for the two players dropped above: one widely rostered, one not
const DROPPED = { 777: ['Nico Collins', 100], 776: ['Deep Backup', 4] };
export const transactionsPage = () => `<!doctype html><html><body><table>${[
  ['Brian Robinson', 'Atl - RB', 'Free Agent', 'Marvin Harrison Jr.', 'Hou - WR', 'To Waivers', 'Lazy Sundays Oct 11, 10:53 am', '34054', '40893'],
  ['Keon Coleman', 'Buf - WR', 'Free Agent', 'Jadarian Price', 'Sea - RB', 'To Waivers', 'Brain Trust Oct 11, 9:56 am', '1', '2'],
  ['Denzel Boston', 'Cle - WR', 'Waiver', '', '', '', 'ED SHEERAN HALFTIME SHOW Oct 10, 3:31 am', '3', ''],
  ['Rashee Rice', 'KC - WR', 'Free Agent', 'Nico Collins', 'Hou - WR', 'To Waivers', 'Brain Trust ' + recent, '778', '777'],
  ['Kendre Miller', 'NO - RB', 'Free Agent', 'Deep Backup', 'Jax - WR', 'To Waivers', 'Lazy Sundays ' + recent, '779', '776'],
].map(([a, at, as, d, dt, ds, meta, aid, did]) => `<tr><td><span title="Added Player"></span></td><td colspan="2">
  <div class="Pbot-xs"><a href="https://sports.yahoo.com/nfl/players/${aid}" target="sports">${a}</a> <span class="F-position Fz-xxs">${at}</span> <a class="yfa-icon playernote" data-ys-playerid="${aid}"></a><h6>${as} </h6></div>
  ${d ? `<div class="Pbot-xs"><a href="https://sports.yahoo.com/nfl/players/${did}" target="sports">${d}</a> <span class="F-position Fz-xxs">${dt}</span> <a class="yfa-icon playernote" data-ys-playerid="${did}"></a><h6>${ds} </h6></div>` : ''}
  </td><td>${meta}</td></tr>`).join('')}</table></body></html>`;


export const settingsPage = () => '<!doctype html><html><body><table><tr><td>League Name:</td><td>Friend League</td></tr><tr><td>Playoffs:</td><td>4 teams - Week 16 and 17 (ends Monday, Jan 4)</td></tr><tr><td>Roster Positions:</td><td>QB, WR, WR, RB, RB, TE, W/R/T, Q/W/R/T, K, DEF, DL, BN, BN, BN, IR</td></tr><tr><td>Passing Touchdowns</td><td>6</td></tr><tr><td>Receptions</td><td>0.5</td></tr></table></body></html>';

// ---- Sleeper ----
export const sleeperPlayers = () => Object.fromEntries(players.filter(p => p.pos !== 'DEF').map(p => [`s${p.id}`, {
  full_name: p.name, position: p.pos, team: p.team.toUpperCase(), status: 'Active',
  injury_status: p.id === '41' ? 'Out' : (p.id === '42' ? 'Out' : (p.id === '5' ? 'Out' : (p.inj === 'IR' ? 'IR' : null))), injury_body_part: p.id === '41' ? 'Finger' : null,
}]));
const trend = ids => ids.map((id, i) => ({ player_id: `s${id}`, count: 400000 - i * 30000 }));
export const sleeperTrending = type => type === 'add' ? trend(['40', '20', '21', '41', '50', '51', '52', '31']) : trend(['22', '43', '44']);

// ---- helpers for the test server ----
export function yahooResponse(url) {
  const u = new URL(url);
  const path = u.pathname, q = u.searchParams;
  if (path === `/f1/${LEAGUE_ID}/players`) return { type: 'text/html', body: listPage({ pos: q.get('pos') || 'O', status: q.get('status') || 'A', stat: q.get('stat1') || 'S_PW_5', fteam: q.get('fteam') && q.get('fteam') !== 'NONE' ? q.get('fteam') : null, sort: q.get('sort') || 'PR', count: q.get('count') || 0 }) };
  if (path === `/f1/${LEAGUE_ID}/${TEAM_ID}`) return { type: 'text/html', body: teamPage() };
  if (path === `/f1/${LEAGUE_ID}`) return { type: 'text/html', body: '<!doctype html><html><body><h2>Week 6 Matchups</h2><div>Not started yet</div></body></html>' };
  if (path === `/f1/${LEAGUE_ID}/matchup`) return { type: 'text/html', body: teamPage().replace('</body>', '<div>Week 5: Oct 6 - Oct 12</div></body>') };
  if (path === `/f1/${LEAGUE_ID}/playernote`) return { type: 'application/json', body: noteJson(q.get('pid')) };
  if (path === `/f1/${LEAGUE_ID}/transactions`) return { type: 'text/html', body: transactionsPage() };
  if (path === `/f1/${LEAGUE_ID}/buzzindex`) return { type: 'text/html', body: buzzPage(q.get('pos') || 'WR') };
  if (path === `/f1/${LEAGUE_ID}/addplayer`) return { type: 'text/html', body: addPage(q.get('apid')) };
  if (path === `/f1/${LEAGUE_ID}/settings`) return { type: 'text/html', body: settingsPage() };
  return null;
}
