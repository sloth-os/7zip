// Adversarial verification of <repo>/index.html (read-only on repo)
// Run: node tests/verify-index-html.test.mjs   (from the repo root; any cwd works)
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';

// Repo root derived from this file's own location (tests/..).
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(REPO + '/index.html', 'utf8');
const appjs = readFileSync(REPO + '/app.js', 'utf8');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('ok   - ' + name); pass++; }
  catch (e) { console.log('FAIL - ' + name + '\n       ' + e.message); fail++; }
}

// The 27 contract ids: the original 20, the feature-detected native picker
// buttons added for PWA file handling, the three selective-extraction
// additions (select-all checkbox + the two "selected entries" buttons), and
// the two folder-compress intake additions (Select folder… button + hidden
// webkitdirectory input).
const CONTRACT_IDS = ['dropzone','file-input','folder-input','btn-open-archive','btn-add-folder','status-line','progress-output','archive-panel',
  'archive-name','entry-select-all','entries-body','btn-extract-all','btn-extract-selected','btn-extract-folder',
  'btn-extract-selected-folder','btn-test-archive','compress-panel',
  'compress-list','format-select','level-select','password-input','btn-compress','downloads',
  'install-btn','net-status','build-version','btn-clear'];

const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
const appIdRefs = new Set();
for (const m of appjs.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) appIdRefs.add(m[1]);
for (const m of appjs.matchAll(/\$\(\s*['"]([^'"]+)['"]\s*\)/g)) appIdRefs.add(m[1]);
for (const m of appjs.matchAll(/querySelector(?:All)?\(\s*['"]([^'"]+)['"]\s*\)/g)) {
  for (const idm of m[1].matchAll(/#([\w-]+)/g)) appIdRefs.add(idm[1]);
}

// 1. ID contract
t('every contract id defined exactly once in index.html', () => {
  assert.equal(CONTRACT_IDS.length, 27, 'contract id list must hold 27 ids');
  for (const id of CONTRACT_IDS) {
    assert.equal(htmlIds.filter(x => x === id).length, 1, 'id ' + id);
  }
});
t('no duplicate ids', () => {
  const dupes = htmlIds.filter((x, i) => htmlIds.indexOf(x) !== i);
  assert.deepEqual(dupes, []);
});
t('app.js-referenced ids are a SUBSET of index.html ids', () => {
  const missing = [...appIdRefs].filter(id => !htmlIds.includes(id));
  assert.deepEqual(missing, [], 'app.js references ids missing from index.html');
});
t('no extra ids beyond the contract set', () => {
  const extra = htmlIds.filter(id => !CONTRACT_IDS.includes(id));
  assert.deepEqual(extra, []);
});

// 2. no external URLs
t('zero external/protocol-relative URLs', () => {
  assert.ok(!/https?:\/\//i.test(html), 'http(s):// found');
  assert.ok(!/(href|src|action|data|poster|srcset)\s*=\s*["']\/\//i.test(html), 'protocol-relative URL attr');
  assert.ok(!/@import|url\(\s*['"]?(https?:|\/\/)/i.test(html), 'css external url/import');
  assert.ok(!/integrity=|crossorigin=/i.test(html), 'sri/crossorigin hints at external resource');
});

// 3. all URL attributes relative ./
t('all href/src attributes are ./-relative', () => {
  const attrs = [...html.matchAll(/\b(?:href|src|action|poster|srcset|data)\s*=\s*"([^"]*)"/gi)];
  assert.ok(attrs.length >= 4, 'expected url attrs, found ' + attrs.length);
  for (const m of attrs) {
    assert.match(m[1], /^\.\//, 'not ./-relative: ' + m[1]);
    assert.ok(!m[1].includes('//'), 'suspicious //: ' + m[1]);
  }
});
t('referenced local assets exist', () => {
  for (const p of ['./manifest.webmanifest','./icons/icon-32.png','./icons/icon-192.png','./app.js']) {
    assert.ok(existsSync(REPO + '/' + p.slice(2)), 'missing ' + p);
  }
});

// 4. head requirements
t('manifest link -> ./manifest.webmanifest', () => {
  assert.match(html, /<link[^>]+rel="manifest"[^>]+href="\.\/manifest\.webmanifest"/);
});
t('favicon + apple-touch-icon point at contract icon paths', () => {
  assert.match(html, /<link[^>]+rel="icon"[^>]+href="\.\/icons\/icon-\d+\.png"/);
  assert.match(html, /<link[^>]+rel="apple-touch-icon"[^>]+href="\.\/icons\/icon-192\.png"/);
});
t('theme-color meta present and matches manifest.webmanifest theme_color', () => {
  const meta = html.match(/<meta[^>]+name="theme-color"[^>]+content="([^"]+)"/);
  assert.ok(meta, 'no theme-color meta');
  const mf = JSON.parse(readFileSync(REPO + '/manifest.webmanifest', 'utf8'));
  assert.equal(meta[1].toLowerCase(), mf.theme_color.toLowerCase());
});
t('exactly one script tag: ./app.js with defer, no inline JS', () => {
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)];
  assert.equal(scripts.length, 1, scripts.length + ' script tags');
  assert.match(scripts[0][0], /src="\.\/app\.js"/);
  assert.match(scripts[0][0], /\bdefer\b/);
  assert.ok(!/<script\b[^>]*>(?!\s*<\/script>)[\s\S]*?<\/script>/i.test(html), 'inline script content');
});
t('noscript present', () => {
  assert.match(html, /<noscript>[\s\S]*?<\/noscript>/);
});
t('no inline event handlers or javascript: URLs', () => {
  assert.ok(!/\son(click|change|load|error|submit|input|drag\w*|drop|key\w*)\s*=/i.test(html));
  assert.ok(!/javascript:/i.test(html));
});

// 5. structure requirements
t('#entries-body is tbody inside a table whose thead leads with a select-all checkbox then Name/Size/Modified/Method', () => {
  const m = html.match(/<table>\s*<thead>\s*<tr>\s*<th class="col-select"><input type="checkbox" id="entry-select-all"[^>]*><\/th>\s*<th[^>]*>([^<]+)<\/th>\s*<th[^>]*>([^<]+)<\/th>\s*<th[^>]*>([^<]+)<\/th>\s*<th[^>]*>([^<]+)<\/th>\s*<\/tr>\s*<\/thead>\s*<tbody id="entries-body"><\/tbody>\s*<\/table>/);
  assert.ok(m, 'table structure mismatch (select-all th + 4 text th + tbody#entries-body)');
  assert.deepEqual([m[1], m[2], m[3], m[4]], ['Name','Size','Modified','Method']);
});
t('panels + install btn hidden initially', () => {
  assert.match(html, /<section id="archive-panel"[^>]*\bhidden\b/);
  assert.match(html, /<section id="compress-panel"[^>]*\bhidden\b/);
  assert.match(html, /<button id="install-btn"[^>]*\bhidden\b/);
  assert.ok(/hidden/.test(html.match(/<input id="file-input"[^>]*>/)[0]), 'file-input not hidden');
});
t('#dropzone is click/drag target; #file-input type=file multiple; #folder-input adds webkitdirectory', () => {
  assert.match(html, /<div id="dropzone"[^>]*role="button"[^>]*tabindex="0"/);
  const fi = html.match(/<input id="file-input"[^>]*>/)[0];
  assert.match(fi, /type="file"/);
  assert.match(fi, /\bmultiple\b/);
  const fo = html.match(/<input id="folder-input"[^>]*>/);
  assert.ok(fo, 'folder-input missing');
  assert.match(fo[0], /type="file"/);
  assert.match(fo[0], /\bwebkitdirectory\b/);
  assert.match(fo[0], /\bmultiple\b/);
  assert.match(fo[0], /\bhidden\b/);
  assert.ok(html.indexOf('<input id="folder-input"') > html.indexOf('<input id="file-input"'),
    'folder-input must follow file-input');
});
t('#progress-output is a <pre>; #status-line exists', () => {
  assert.match(html, /<pre id="progress-output"/);
  assert.match(html, /id="status-line"/);
});
t('#format-select options 7z,zip; #level-select 0,1,3,5,7,9 default 5', () => {
  const fs = html.match(/<select id="format-select">([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...fs.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]), ['7z','zip']);
  const ls = html.match(/<select id="level-select">([\s\S]*?)<\/select>/)[1];
  const opts = [...ls.matchAll(/<option value="([^"]+)"( selected)?>/g)];
  assert.deepEqual(opts.map(m => m[1]), ['0','1','3','5','7','9']);
  assert.deepEqual(opts.filter(m => m[2]).map(m => m[1]), ['5']);
});
t('#password-input type=password; #net-status and #build-version are spans; build-version fallback local', () => {
  assert.match(html, /<input id="password-input" type="password"/);
  assert.match(html, /<span id="net-status"/);
  assert.match(html, /<span id="build-version">local<\/span>/);
});
t('CSS supports classes app.js toggles: status error, net online/offline, hidden attr, dropzone dragover, disabled btn, select column', () => {
  assert.match(html, /#status-line\.error/);
  assert.match(html, /#net-status\.online/);
  assert.match(html, /#net-status\.offline/);
  assert.match(html, /\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(html, /#dropzone\.dragover/);
  assert.match(html, /\.btn:disabled/);
  assert.match(html, /\.col-select\b/);
  // the right-aligned Size column moved from nth-child(2) to nth-child(3)
  assert.match(html, /th:nth-child\(3\),\s*td:nth-child\(3\)\s*\{[^}]*text-align:\s*right/);
});

// 5b. PWA file-handling additions (native pickers + downloads row)
t('both picker buttons ship hidden, type=button, class btn, with an aria-label', () => {
  for (const id of ['btn-open-archive', 'btn-extract-folder']) {
    const m = html.match(new RegExp('<button id="' + id + '"[^>]*>'));
    assert.ok(m, id + ' button missing');
    assert.match(m[0], /type="button"/, id + ' lacks type="button"');
    assert.match(m[0], /\bhidden\b/, id + ' must ship hidden (feature-detected at boot)');
    assert.match(m[0], /class="btn"/, id + ' must reuse the .btn conventions');
    assert.match(m[0], /aria-label="[^"]{10,}"/, id + ' lacks a useful aria-label');
  }
});
t('both selection buttons ship type=button + class btn + aria-label + disabled; only the folder one ships hidden', () => {
  for (const id of ['btn-extract-selected', 'btn-extract-selected-folder']) {
    const m = html.match(new RegExp('<button id="' + id + '"[^>]*>([^<]*)</button>'));
    assert.ok(m, id + ' button missing');
    assert.match(m[0], /type="button"/, id + ' lacks type="button"');
    assert.match(m[0], /class="btn"/, id + ' must reuse the .btn conventions');
    assert.match(m[0], /aria-label="[^"]{10,}"/, id + ' lacks a useful aria-label');
    assert.match(m[0], /\bdisabled\b/, id + ' must ship disabled until a selection exists');
  }
  assert.ok(!/\bhidden\b/.test(html.match(/<button id="btn-extract-selected"[^>]*>/)[0]),
    'btn-extract-selected must NOT ship hidden (download path, always available)');
  assert.match(html.match(/<button id="btn-extract-selected-folder"[^>]*>/)[0], /\bhidden\b/,
    'btn-extract-selected-folder must ship hidden (feature-detected at boot)');
  // Pinned base labels (app.js appends " (N)" while a selection is active).
  assert.equal(html.match(/<button id="btn-extract-selected"[^>]*>([^<]*)</)[1], 'Extract selected');
  assert.equal(html.match(/<button id="btn-extract-selected-folder"[^>]*>([^<]*)</)[1], 'Selected to folder…');
});
t('only install-btn and the four feature-gated buttons ship hidden (nothing else got hidden)', () => {
  const hidden = [...html.matchAll(/<button\b[^>]*\bhidden\b[^>]*>/g)]
    .map(m => (m[0].match(/id="([^"]+)"/) || [])[1])
    .filter(Boolean);
  assert.deepEqual(hidden.sort(), ['btn-add-folder', 'btn-extract-folder', 'btn-extract-selected-folder', 'btn-open-archive', 'install-btn']);
});
t('.dz-actions row wraps #btn-open-archive then #btn-add-folder and follows #file-input inside the dropzone section', () => {
  const sec = html.match(/<section aria-label="File drop zone">([\s\S]*?)<\/section>/);
  assert.ok(sec, 'dropzone section missing');
  assert.ok(sec[1].indexOf('<p class="dz-actions">') > sec[1].indexOf('<input id="file-input"'),
    '.dz-actions must come after the #file-input line');
  const row = sec[1].match(/<p class="dz-actions">([\s\S]*?)<\/p>/);
  assert.ok(row, '.dz-actions paragraph not closed');
  assert.equal((row[1].match(/<button\b/g) || []).length, 2, '.dz-actions must hold exactly two buttons');
  assert.ok(row[1].includes('id="btn-open-archive"'), 'btn-open-archive not inside .dz-actions');
  assert.ok(row[1].includes('id="btn-add-folder"'), 'btn-add-folder not inside .dz-actions');
  assert.ok(row[1].indexOf('id="btn-open-archive"') < row[1].indexOf('id="btn-add-folder"'),
    'btn-add-folder must follow btn-open-archive');
  const add = html.match(/<button id="btn-add-folder"[^>]*>([^<]*)</);
  assert.ok(add, 'btn-add-folder button missing');
  assert.match(add[0], /type="button"/);
  assert.match(add[0], /\bhidden\b/, 'must ship hidden (feature-detected at boot)');
  assert.match(add[0], /class="btn"/);
  assert.match(add[0], /aria-label="[^"]{10,}"/);
  assert.equal(add[1], 'Select folder…');
});
t('.panel-actions button order is the 5-button contract order', () => {
  const panel = html.match(/<section id="archive-panel"[\s\S]*?<div class="panel-actions">([\s\S]*?)<\/div>/);
  assert.ok(panel, 'archive-panel .panel-actions missing');
  const ids = [...panel[1].matchAll(/<button id="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(ids, ['btn-extract-all', 'btn-extract-selected', 'btn-extract-folder', 'btn-extract-selected-folder', 'btn-test-archive']);
});
t('CSS: .dz-actions, #downloads .download-row, .download-row a and .btn-save-as all styled inline', () => {
  assert.equal((html.match(/<style\b/g) || []).length, 1, 'still exactly one <style> block');
  assert.match(html, /\.dz-actions\s*\{/);
  assert.match(html, /#downloads\s+\.download-row\s*\{[^}]*display:\s*flex/);
  assert.match(html, /\.download-row\s+a\s*\{[^}]*flex:\s*1 1 auto/);
  assert.match(html, /\.download-row\s+\.btn-save-as\s*\{/);
  assert.ok(!/<link[^>]+stylesheet/i.test(html), 'external stylesheet appeared');
  assert.ok(!/@import/i.test(html), 'css @import appeared');
});
t('no <form>/action attribute and no ./__share literal: the share POST stays a SW-only endpoint', () => {
  assert.ok(!/<form\b/i.test(html), 'index.html must not contain a <form>');
  assert.ok(!/\baction\s*=/i.test(html), 'no action= attribute expected');
  assert.ok(!html.includes('__share'), 'index.html must not reference the share endpoint');
  assert.ok(!html.includes('__shared'), 'index.html must not reference the shared-file cache URLs');
});

// 6. HTML sanity via python html.parser (unclosed/misnested tags)
t('html.parser reports no unclosed or misnested tags', () => {
  // The file path travels as argv (not interpolated into the program) so any
  // checkout path is safe.
  const out = execFileSync('python3', ['-I', '-c', `
import sys
from html.parser import HTMLParser
VOID={'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'}
class C(HTMLParser):
    def __init__(s):
        super().__init__(convert_charrefs=True); s.stack=[]; s.errs=[]
    def handle_starttag(s,t,a):
        if t not in VOID: s.stack.append((t,s.getpos()[0]))
    def handle_endtag(s,t):
        if t in VOID: s.errs.append('void close '+t); return
        if s.stack and s.stack[-1][0]==t: s.stack.pop()
        else: s.errs.append('mismatch </%s> at line %d, stack top %s'%(t,s.getpos()[0],s.stack[-1] if s.stack else None))
c=C(); c.feed(open(sys.argv[1]).read()); c.close()
for t,l in c.stack: c.errs.append('unclosed <%s> line %d'%(t,l))
print('|'.join(c.errs))
`, REPO + '/index.html'], { encoding: 'utf8' }).trim();
  assert.equal(out, '', 'parser errors: ' + out);
});
t('doctype + lang present', () => {
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<html lang="en">/);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
