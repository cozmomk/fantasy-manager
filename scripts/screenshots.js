// Renders the README screenshots from the offline test pages (tests/fixtures.js), so no real league ever appears.
//   npm run screenshots    writes media/*.png
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openBoard, waitForBoard, teamUrl } from '../tests/helpers.js';
import { players, TEAM_ID } from '../tests/fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'media');
const NOW = Date.parse('2026-11-10T09:30:00');   // a Tuesday morning: every game of the week is still ahead

// a game-day week: a Thursday player in the flex, a finished game, a questionable starter with a practice report
const by = id => players.find(p => p.id === id);
by('7').gameLine = 'Thu 5:15 pm vs Was';
by('1').gameLine = 'Final W 24-19 @ Mia';
by('3').inj = 'Q'; by('3').note = 'Allen was limited in practice Wednesday with a sore ankle.';
by('9').slot = 'WR';                                   // both WR slots filled, so the verdict is about game day
by('70').ros = [90, 0];                                // an injured free agent widely rostered: a stash alert
const weekLine = (url, body) => (/\/f1\/\d+\/\d+$/.test(new URL(url).pathname) ? body.replace('</body>', '<div>Week 5: Oct 6 - Oct 12</div></body>') : body);

const shots = [
  { file: 'lineup.png', url: teamUrl(TEAM_ID), radar: false, height: 1340 },
  { file: 'add-replace.png', pos: 'RB', radar: true, click: '.ff-cand', height: 1700 },
  { file: 'stash.png', pos: 'QB', radar: true, tab: 'Stash', height: 1130 },
];

fs.mkdirSync(OUT, { recursive: true });
const browser = await launch();
try {
  for (const s of shots) {
    const context = await browser.newContext({ viewport: { width: 1280, height: s.height }, deviceScaleFactor: 2 });
    await context.addInitScript(() => { try { localStorage.setItem('ff:ui', JSON.stringify({ w: 560, open: true })); } catch (e) { /* ignore */ } });
    const { page } = await openBoard(browser, { url: s.url, pos: s.pos, now: NOW, mutate: weekLine, context });
    await waitForBoard(page, { radar: s.radar });
    if (s.click) { await page.locator(s.click).first().click(); await page.waitForTimeout(800); await page.locator('#ff-body').evaluate(b => { b.scrollTop = 0; }); }
    if (s.tab) { await page.locator('.ff-tabbtn', { hasText: s.tab }).click(); await page.locator('.ff-cand').first().waitFor({ timeout: 30000 }); }
    await page.waitForTimeout(1200);
    await page.locator('#ff-tray').screenshot({ path: path.join(OUT, s.file) });
    console.log('Wrote media/' + s.file);
    await context.close();
  }
} finally { await browser.close(); }
