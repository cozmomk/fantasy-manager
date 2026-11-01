// Builds the Tampermonkey / Violentmonkey version of the extension and (with --serve) serves it from localhost,
// so the userscript manager can install it once and then pick up every change by itself.
//   node scripts/userscript.js            writes dist/fantasy-manager.user.js
//   node scripts/userscript.js --serve    builds, then serves http://localhost:8787/fantasy-manager.user.js
//   node scripts/userscript.js --publish  uploads the committed code to the secret gist that friends install from
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'extension', 'content.js');
const OUT = path.join(ROOT, 'dist', 'fantasy-manager.user.js');
export const PORT = Number(process.env.FF_PORT || 8787);
export const FILE = 'fantasy-manager.user.js';
const GIST_FILE = path.join(ROOT, 'scripts', 'gist-id.txt');

export const gistBase = (user, id) => `https://gist.githubusercontent.com/${user}/${id}/raw`;

// Friends get every publish automatically, so only committed code goes out. --create makes the gist the first time.
function publish() {
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }).trim();
  if (run('git', ['status', '--porcelain', 'extension/content.js', 'scripts/userscript.js'])) throw new Error('Commit your changes first: only committed code is published.');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-')), FILE);
  fs.writeFileSync(tmp, build());
  let id = fs.existsSync(GIST_FILE) ? fs.readFileSync(GIST_FILE, 'utf8').trim() : '';
  if (!id) {
    if (!process.argv.includes('--create')) throw new Error('No gist yet. Run again with --create to make one.');
    id = run('gh', ['gist', 'create', '--desc', 'Fantasy Manager Highlights', tmp]).split('/').pop();
    fs.writeFileSync(GIST_FILE, id + '\n');
  }
  const base = gistBase(run('gh', ['api', 'user', '--jq', '.login']), id);
  fs.writeFileSync(tmp, build(base));         // the update address needs the gist id, so this write comes after the create
  run('gh', ['gist', 'edit', id, '--filename', FILE, tmp]);
  console.log(`Published. Install link: ${base}/${FILE}`);
}

// The manager only updates when @version goes up, so derive it from the source file's modified time.
export function version(mtime) {
  const d = new Date(mtime), p = n => String(n).padStart(2, '0');
  return `1.${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function build(base = `http://localhost:${PORT}`) {
  const body = fs.readFileSync(SRC, 'utf8');
  const header = [
    '// ==UserScript==',
    '// @name         Fantasy Manager Highlights',
    '// @namespace    fantasy-manager',
    `// @version      ${version(fs.statSync(SRC).mtimeMs)}`,
    '// @description  Read-only decision board for your Yahoo Fantasy Football leagues. Never adds, drops or submits anything.',
    '// @match        https://football.fantasysports.yahoo.com/f1/*',   // the script itself only acts on player lists, settings, the league home, your team and the matchup
    '// @run-at       document-idle',
    '// @grant        none',
    '// @noframes',
    `// @updateURL    ${base}/${FILE}`,
    `// @downloadURL  ${base}/${FILE}`,
    '// ==/UserScript==',
    '',
  ].join('\n');
  return header + body;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--publish')) publish();
else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, build());
  console.log('Wrote ' + path.relative(ROOT, OUT));
  if (process.argv.includes('--serve')) {
    http.createServer((req, res) => {
      if (req.url.split('?')[0] !== '/' + FILE) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(build());                       // rebuilt on every request, so the manager always sees the latest code
    }).listen(PORT, '127.0.0.1', () => console.log(`Serving http://localhost:${PORT}/${FILE}  (Ctrl+C to stop)`));
  }
}
