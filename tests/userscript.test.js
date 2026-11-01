import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build, version, FILE } from '../scripts/userscript.js';
import { launch, openBoard, waitForBoard } from './helpers.js';

describe('userscript build', () => {
  it('has the header a userscript manager needs, and the unchanged extension code after it', () => {
    const out = build('http://localhost:9999');
    assert.match(out, /^\/\/ ==UserScript==/);
    assert.match(out, /@match\s+https:\/\/football\.fantasysports\.yahoo\.com\/f1\/\*/);
    assert.match(out, /@grant\s+none/);
    assert.ok(out.includes(`@updateURL    http://localhost:9999/${FILE}`));
    assert.ok(out.endsWith(fs.readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8')));
  });
  it('the version goes up whenever the source file changes, so the manager sees the update', () => {
    assert.ok(version(Date.parse('2026-10-13T10:00:00')) < version(Date.parse('2026-10-13T10:00:01')));
    assert.match(version(Date.now()), /^1\.\d{8}\.\d{6}$/);
  });
});

describe('userscript runs without the extension APIs', () => {
  let browser;
  before(async () => { browser = await launch(); });
  after(async () => { await browser.close(); });
  it('builds the board when injected as plain page script (no chrome.storage)', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR', load: false });
    await page.addScriptTag({ content: build() });
    await waitForBoard(page);
    assert.equal(await page.evaluate(() => !(window.chrome && window.chrome.storage)), true);
    await context.close();
  });
});
