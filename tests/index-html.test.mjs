// Contract self-check for <repo>/index.html
// Zero dependencies. Run: node tests/index-html.test.mjs  (from the repo root)
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';

// Repo root derived from this file's own location (tests/..).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = ROOT + '/index.html';
const html = readFileSync(FILE, 'utf8');

// The 27 contract ids: the original 20, the two feature-detected native
// picker buttons (Open archive… / Extract to folder…), the three
// selective-extraction additions (select-all checkbox + the two
// "selected entries" buttons), and the two folder-compress intake additions
// (Select folder… button + hidden webkitdirectory input).
const EXPECTED_IDS = [
  'dropzone', 'file-input', 'folder-input', 'btn-open-archive', 'btn-add-folder', 'status-line', 'progress-output',
  'archive-panel', 'archive-name', 'entry-select-all', 'entries-body',
  'btn-extract-all', 'btn-extract-selected', 'btn-extract-folder', 'btn-extract-selected-folder', 'btn-test-archive',
  'compress-panel', 'compress-list', 'format-select', 'level-select', 'password-input', 'btn-compress',
  'downloads', 'install-btn', 'net-status', 'build-version', 'btn-clear',
];

const failures = [];
let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`ok   - ${name}`); }
  catch (err) { failures.push(name); console.error(`FAIL - ${name}\n       ${err.message}`); }
}

// ---- helpers -------------------------------------------------------------
function tagWithId(tag, id) {
  const re = new RegExp(`<${tag}\\b[^>]*\\bid="${id}"[^>]*>`, 'i');
  return re.exec(html);
}
function rangeOfTag(tag, idRe) {
  // find opening tag (optionally by id), then match to its closing tag
  const openRe = idRe
    ? new RegExp(`<${tag}\\b[^>]*\\bid="${idRe}"[^>]*>`, 'i')
    : new RegExp(`<${tag}\\b[^>]*>`, 'i');
  const m = openRe.exec(html);
  if (!m) return null;
  const scan = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, 'gi');
  scan.lastIndex = m.index + m[0].length;
  let depth = 1, mm;
  while ((mm = scan.exec(html))) {
    if (mm[0][1] === '/') {
      depth--;
      if (depth === 0) return { start: m.index, end: mm.index + mm[0].length, open: m[0], inner: html.slice(m.index, mm.index + mm[0].length) };
    } else if (!mm[0].endsWith('/>')) depth++;
  }
  return null;
}
function count(re) { return (html.match(re) || []).length; }

// ---- structure -----------------------------------------------------------
check('doctype + lang', () => {
  assert.match(html, /^<!DOCTYPE html>\s*<html lang="en">/i);
});

check('exactly one <style> block, no external stylesheet', () => {
  assert.equal(count(/<style\b/gi), 1);
  assert.ok(!/<link[^>]+rel=["']?stylesheet/i.test(html), 'external stylesheet link found');
});

check('exactly one script tag: ./app.js with defer, no inline JS', () => {
  assert.equal(count(/<script\b/gi), 1);
  assert.match(html, /<script src="\.\/app\.js" defer><\/script>/);
});

check('no inline event handlers or javascript: URLs', () => {
  for (const tag of html.match(/<[^>]+>/g) || []) {
    assert.ok(!/\son[a-z]+\s*=/i.test(tag), `event handler in tag: ${tag.slice(0, 80)}`);
  }
  assert.ok(!/javascript:/i.test(html), 'javascript: URL found');
});

check('offline-safe: zero occurrences of "http" anywhere; no protocol-relative URLs', () => {
  assert.ok(!/http/i.test(html), 'found an "http" substring');
  assert.ok(!/(?:href|src)=["']\/\//i.test(html), 'protocol-relative URL found');
});

check('every href/src attribute is relative (starts with ./)', () => {
  const refs = [...html.matchAll(/(?:href|src)="([^"]*)"/g)].map(m => m[1]);
  assert.ok(refs.length >= 4, 'expected manifest/icon/apple-touch-icon/app.js references');
  for (const r of refs) assert.ok(r.startsWith('./'), `not relative: ${r}`);
});

check('referenced local assets that must exist do exist', () => {
  assert.ok(existsSync(`${ROOT}/icons/icon-32.png`));
  assert.ok(existsSync(`${ROOT}/icons/icon-192.png`));
});

// ---- head -----------------------------------------------------------------
check('head: charset + viewport + title', () => {
  assert.match(html, /<meta charset="utf-8">/i);
  assert.match(html, /<meta name="viewport" content="[^"]*width=device-width/);
  assert.match(html, /<title>[^<]+<\/title>/);
});

check('head: description meta exact text', () => {
  const m = /<meta name="description" content="([^"]*)"/.exec(html);
  assert.ok(m, 'description meta missing');
  assert.equal(m[1], '7-Zip running entirely in your browser via WebAssembly — compress, extract and inspect archives offline, no uploads');
});

check('head: exactly one theme-color = #111111 (matches manifest contract)', () => {
  assert.equal(count(/name="theme-color"/g), 1);
  assert.match(html, /<meta name="theme-color" content="#111111">/);
});

check('head: manifest, favicon, apple-touch-icon links', () => {
  assert.match(html, /<link rel="manifest" href="\.\/manifest\.webmanifest">/);
  assert.match(html, /<link rel="icon"[^>]*href="\.\/icons\/icon-32\.png">/);
  assert.match(html, /<link rel="apple-touch-icon"[^>]*href="\.\/icons\/icon-192\.png">/);
  const rels = [...html.matchAll(/<link[^>]*rel="([^"]+)"/g)].map(m => m[1]);
  for (const rel of rels) {
    assert.ok(['manifest', 'icon', 'apple-touch-icon'].includes(rel), `unexpected link rel: ${rel}`);
  }
});

check('dark + light themes via prefers-color-scheme', () => {
  assert.match(html, /@media \(prefers-color-scheme: light\)/);
  assert.match(html, /color-scheme: dark light/);
});

// ---- DOM ID contract -------------------------------------------------------
check('all 27 contract ids defined exactly once, no extra ids', () => {
  const found = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(EXPECTED_IDS.length, 27, 'contract id list must hold 27 ids');
  for (const id of EXPECTED_IDS) {
    assert.equal(found.filter(x => x === id).length, 1, `id "${id}" must appear exactly once`);
  }
  const extras = found.filter(x => !EXPECTED_IDS.includes(x));
  assert.deepEqual(extras, [], 'extra ids defined');
});

check('#dropzone present with exact instruction text; #file-input type=file multiple hidden', () => {
  const dz = tagWithId('div', 'dropzone');
  assert.ok(dz, 'dropzone div missing');
  assert.ok(html.includes('Drop an archive to inspect/extract, or drop files or folders to compress'), 'instruction text missing');
  assert.match(
    dz[0],
    /aria-label="Drop an archive to inspect or extract, or drop files or folders to compress\. Activates a file chooser\."/,
    'dropzone aria-label must mention folders and the file chooser'
  );
  const fi = tagWithId('input', 'file-input');
  assert.ok(fi, 'file-input missing');
  assert.match(fi[0], /type="file"/);
  assert.match(fi[0], /\bmultiple\b/);
  assert.match(fi[0], /\bhidden\b/);
});

// ---- PWA file handling additions (native pickers) --------------------------
check('#btn-open-archive: hidden .btn inside a .dz-actions row after #file-input, in the dropzone section', () => {
  const sec = /<section aria-label="File drop zone">([\s\S]*?)<\/section>/.exec(html);
  assert.ok(sec, 'dropzone section missing');
  const inner = sec[1];
  assert.ok(inner.includes('<div id="dropzone"'), 'dropzone div missing from its section');
  const fiIdx = inner.indexOf('<input id="file-input"');
  const dzIdx = inner.indexOf('<p class="dz-actions">');
  assert.ok(fiIdx >= 0, '#file-input missing from the dropzone section');
  assert.ok(dzIdx >= 0, 'no <p class="dz-actions"> row in the dropzone section');
  assert.ok(dzIdx > fiIdx, '.dz-actions must follow the #file-input line');
  const row = /<p class="dz-actions">([\s\S]*?)<\/p>/.exec(inner);
  assert.ok(row, '.dz-actions paragraph is not closed');
  assert.ok(row[1].includes('id="btn-open-archive"'), 'btn-open-archive is not inside .dz-actions');
  const btn = tagWithId('button', 'btn-open-archive');
  assert.ok(btn, 'btn-open-archive button missing');
  assert.match(btn[0], /type="button"/);
  assert.match(btn[0], /\bhidden\b/, 'must ship hidden — app.js unhides it only when showOpenFilePicker exists');
  assert.match(btn[0], /class="btn"/);
  assert.match(btn[0], /aria-label="[^"]{10,}"/);
});

check('#btn-add-folder: hidden .btn after #btn-open-archive inside the .dz-actions row', () => {
  const row = /<p class="dz-actions">([\s\S]*?)<\/p>/.exec(html);
  assert.ok(row, '.dz-actions paragraph missing');
  const openIdx = row[1].indexOf('id="btn-open-archive"');
  const addIdx = row[1].indexOf('id="btn-add-folder"');
  assert.ok(openIdx >= 0 && addIdx >= 0, 'both picker buttons must live in .dz-actions');
  assert.ok(addIdx > openIdx, 'btn-add-folder must follow btn-open-archive');
  const btn = tagWithId('button', 'btn-add-folder');
  assert.ok(btn, 'btn-add-folder button missing');
  assert.match(btn[0], /type="button"/);
  assert.match(btn[0], /\bhidden\b/, 'must ship hidden — app.js unhides it only when a folder intake API exists');
  assert.match(btn[0], /class="btn"/);
  assert.match(btn[0], /aria-label="[^"]{10,}"/);
  const m = /<button[^>]*\bid="btn-add-folder"[^>]*>([^<]*)<\/button>/.exec(html);
  assert.ok(m, 'btn-add-folder has no simple text body');
  assert.equal(m[1], 'Select folder…');
});

check('#folder-input: hidden file input with webkitdirectory + multiple, directly after #file-input', () => {
  const fi = tagWithId('input', 'folder-input');
  assert.ok(fi, 'folder-input missing');
  assert.match(fi[0], /type="file"/);
  assert.match(fi[0], /\bwebkitdirectory\b/, 'legacy folder intake needs the webkitdirectory attribute');
  assert.match(fi[0], /\bmultiple\b/);
  assert.match(fi[0], /\bhidden\b/);
  const idxFile = html.indexOf('<input id="file-input"');
  const idxFolder = html.indexOf('<input id="folder-input"');
  assert.ok(idxFile >= 0, '#file-input missing');
  assert.ok(idxFolder > idxFile, '#folder-input must follow #file-input');
});

check('#btn-extract-folder: hidden .btn between #btn-extract-all and #btn-test-archive in .panel-actions', () => {
  const panel = rangeOfTag('section', 'archive-panel');
  assert.ok(panel, 'archive-panel section missing');
  const actions = /<div class="panel-actions">([\s\S]*?)<\/div>/.exec(panel.inner);
  assert.ok(actions, '.panel-actions missing inside archive-panel');
  const all = actions[1].indexOf('id="btn-extract-all"');
  const folder = actions[1].indexOf('id="btn-extract-folder"');
  const test = actions[1].indexOf('id="btn-test-archive"');
  assert.ok(all >= 0 && folder >= 0 && test >= 0, 'all three action buttons must live in .panel-actions');
  assert.ok(all < folder && folder < test, 'order must be: Extract all, Extract to folder…, Test archive');
  const btn = tagWithId('button', 'btn-extract-folder');
  assert.ok(btn, 'btn-extract-folder button missing');
  assert.match(btn[0], /type="button"/);
  assert.match(btn[0], /\bhidden\b/, 'must ship hidden — app.js unhides it only when showDirectoryPicker exists');
  assert.match(btn[0], /class="btn"/);
  assert.match(btn[0], /aria-label="[^"]{10,}"/);
});

check('.panel-actions order: all < selected < folder < selected-folder < test', () => {
  const panel = rangeOfTag('section', 'archive-panel');
  assert.ok(panel, 'archive-panel section missing');
  const actions = /<div class="panel-actions">([\s\S]*?)<\/div>/.exec(panel.inner);
  assert.ok(actions, '.panel-actions missing inside archive-panel');
  const ids = [...actions[1].matchAll(/<button id="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(ids, [
    'btn-extract-all', 'btn-extract-selected', 'btn-extract-folder',
    'btn-extract-selected-folder', 'btn-test-archive',
  ]);
});

check('#btn-extract-selected: visible .btn, type=button, aria-label, ships disabled', () => {
  const btn = tagWithId('button', 'btn-extract-selected');
  assert.ok(btn, 'btn-extract-selected button missing');
  assert.match(btn[0], /type="button"/);
  assert.match(btn[0], /class="btn"/);
  assert.match(btn[0], /aria-label="[^"]{10,}"/);
  assert.match(btn[0], /\bdisabled\b/, 'must ship disabled — app.js enables it once a selection exists');
  assert.ok(!/\bhidden\b/.test(btn[0]), 'btn-extract-selected must NOT ship hidden (it is the download path, always available)');
  // Its label text is pinned verbatim by the contract.
  const m = /<button[^>]*\bid="btn-extract-selected"[^>]*>([^<]*)<\/button>/.exec(html);
  assert.ok(m, 'btn-extract-selected has no simple text body');
  assert.equal(m[1], 'Extract selected');
});

check('#btn-extract-selected-folder: hidden .btn, type=button, aria-label, ships disabled', () => {
  const btn = tagWithId('button', 'btn-extract-selected-folder');
  assert.ok(btn, 'btn-extract-selected-folder button missing');
  assert.match(btn[0], /type="button"/);
  assert.match(btn[0], /class="btn"/);
  assert.match(btn[0], /aria-label="[^"]{10,}"/);
  assert.match(btn[0], /\bhidden\b/, 'must ship hidden — app.js unhides it only when showDirectoryPicker exists');
  assert.match(btn[0], /\bdisabled\b/, 'must ship disabled — app.js enables it once a selection exists');
  const m = /<button[^>]*\bid="btn-extract-selected-folder"[^>]*>([^<]*)<\/button>/.exec(html);
  assert.ok(m, 'btn-extract-selected-folder has no simple text body');
  assert.equal(m[1], 'Selected to folder…');
});

check('#entry-select-all is a checkbox input inside a .col-select th', () => {
  const input = tagWithId('input', 'entry-select-all');
  assert.ok(input, 'entry-select-all input missing');
  assert.match(input[0], /type="checkbox"/);
  assert.match(input[0], /aria-label="[^"]{5,}"/);
  const th = /<th class="col-select">\s*<input[^>]*\bid="entry-select-all"[^>]*>\s*<\/th>/.exec(html);
  assert.ok(th, 'entry-select-all must be wrapped in a th.col-select');
});

check('CSS: .dz-actions + .download-row/.btn-save-as rules live in the single inline <style> block', () => {
  const style = /<style>([\s\S]*?)<\/style>/.exec(html);
  assert.ok(style, 'no <style> block');
  assert.match(style[1], /\.dz-actions\s*\{[^}]*text-align:\s*center/);
  assert.match(style[1], /#downloads\s+\.download-row\s*\{[^}]*display:\s*flex/);
  assert.match(style[1], /\.download-row\s+a\s*\{[^}]*flex:\s*1 1 auto/);
  assert.match(style[1], /\.btn-save-as\s*\{/);
  assert.ok(!/<link[^>]+stylesheet/i.test(html), 'external stylesheet link found');
});

check('CSS: selection column — right-align moved to nth-child(3), .col-select + checkbox accent, .btn:disabled', () => {
  const style = /<style>([\s\S]*?)<\/style>/.exec(html);
  assert.ok(style, 'no <style> block');
  // The checkbox column inserted first shifted the right-aligned Size column
  // from nth-child(2) to nth-child(3).
  assert.match(style[1], /th:nth-child\(3\),\s*td:nth-child\(3\)\s*\{[^}]*text-align:\s*right/);
  assert.ok(!/nth-child\(2\)[^}]*text-align:\s*right/.test(style[1]), 'right-align must no longer target nth-child(2)');
  // Narrow, left-aligned select column; row checkboxes sized + accent-tinted.
  assert.match(style[1], /\.col-select\s*\{[^}]*width:\s*2\.2rem/);
  assert.match(style[1], /\.col-select\s*\{[^}]*text-align:\s*left/);
  assert.match(style[1], /\.col-select\s+input\[type="checkbox"\]\s*\{[^}]*accent-color:\s*var\(--accent\)/);
  // Disabled buttons dimmed with the default cursor.
  assert.match(style[1], /\.btn:disabled\s*\{[^}]*opacity:[^}]*cursor:\s*default/);
});

check('#status-line present; #progress-output is a <pre>', () => {
  assert.ok(html.includes('id="status-line"'));
  assert.ok(tagWithId('pre', 'progress-output'), 'progress-output must be a <pre>');
});

check('#archive-panel is a hidden <section> containing name/table/buttons', () => {
  const panel = rangeOfTag('section', 'archive-panel');
  assert.ok(panel, 'archive-panel section missing');
  assert.match(panel.open, /\bhidden\b/);
  for (const id of ['archive-name', 'entry-select-all', 'entries-body', 'btn-extract-all', 'btn-extract-selected', 'btn-extract-folder', 'btn-extract-selected-folder', 'btn-test-archive']) {
    assert.ok(panel.inner.includes(`id="${id}"`), `${id} not inside archive-panel`);
  }
  assert.ok(panel.inner.includes('<table'), 'no table inside archive-panel');
  assert.ok(tagWithId('tbody', 'entries-body'), 'entries-body must be a <tbody>');
  assert.ok(panel.inner.indexOf('<thead') < panel.inner.indexOf('<tbody'), 'thead must precede tbody');
  // The FIRST thead column is the select-all checkbox column; the four TEXT
  // headers keep their pinned labels and order behind it.
  const thead = /<thead>([\s\S]*?)<\/thead>/.exec(panel.inner);
  assert.ok(thead, 'no <thead> inside archive-panel');
  assert.match(
    thead[1],
    /<th class="col-select"><input type="checkbox" id="entry-select-all" aria-label="Select all entries"><\/th>/,
    'first header cell must be the select-all checkbox column'
  );
  assert.ok(
    thead[1].indexOf('id="entry-select-all"') < thead[1].indexOf('>Name<'),
    'the checkbox column must precede the Name column'
  );
  const ths = [...panel.inner.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map(m => m[1].trim());
  assert.deepEqual(ths, ['Name', 'Size', 'Modified', 'Method']);
  assert.ok(tagWithId('button', 'btn-extract-all') && tagWithId('button', 'btn-extract-folder') && tagWithId('button', 'btn-test-archive'));
});

check('#compress-panel is a hidden <section> containing list/selects/password/button', () => {
  const panel = rangeOfTag('section', 'compress-panel');
  assert.ok(panel, 'compress-panel section missing');
  assert.match(panel.open, /\bhidden\b/);
  for (const id of ['compress-list', 'format-select', 'level-select', 'password-input', 'btn-compress']) {
    assert.ok(panel.inner.includes(`id="${id}"`), `${id} not inside compress-panel`);
  }
  assert.ok(tagWithId('ul', 'compress-list'), 'compress-list must be a <ul>');
  assert.ok(tagWithId('button', 'btn-compress'), 'btn-compress must be a <button>');
  const pw = tagWithId('input', 'password-input');
  assert.match(pw[0], /type="password"/);
});

check('#format-select options are 7z and zip', () => {
  const sel = rangeOfTag('select', 'format-select');
  assert.ok(sel, 'format-select missing');
  const opts = [...sel.inner.matchAll(/<option[^>]*value="([^"]*)"[^>]*>/g)].map(m => m[1]);
  assert.deepEqual(opts, ['7z', 'zip']);
});

check('#level-select options 0,1,3,5,7,9 with default 5', () => {
  const sel = rangeOfTag('select', 'level-select');
  assert.ok(sel, 'level-select missing');
  const opts = [...sel.inner.matchAll(/<option([^>]*)>/g)].map(m => m[1]);
  const values = opts.map(a => /value="([^"]*)"/.exec(a)[1]);
  assert.deepEqual(values, ['0', '1', '3', '5', '7', '9']);
  assert.equal(opts.filter(a => /\bselected\b/.test(a)).length, 1, 'exactly one selected option');
  assert.match(sel.inner, /<option value="5" selected>/);
});

check('#downloads container present', () => {
  assert.ok(tagWithId('div', 'downloads'), 'downloads div missing');
});

check('#install-btn, #net-status, #build-version live in the header area', () => {
  const header = rangeOfTag('header', null);
  assert.ok(header, 'no <header> element');
  for (const id of ['install-btn', 'net-status', 'build-version']) {
    assert.ok(header.inner.includes(`id="${id}"`), `${id} not inside header`);
  }
  const install = tagWithId('button', 'install-btn');
  assert.match(install[0], /\bhidden\b/, 'install-btn must start hidden');
  assert.ok(tagWithId('span', 'net-status'), 'net-status must be a <span>');
  assert.ok(tagWithId('span', 'build-version'), 'build-version must be a <span>');
  assert.match(html, /<span id="build-version">local<\/span>/);
});

check('#btn-clear is a button', () => {
  assert.ok(tagWithId('button', 'btn-clear'), 'btn-clear must be a <button>');
});

check('all buttons have type="button"', () => {
  for (const id of ['install-btn', 'btn-clear', 'btn-extract-all', 'btn-extract-selected', 'btn-extract-folder', 'btn-extract-selected-folder', 'btn-open-archive', 'btn-add-folder', 'btn-test-archive', 'btn-compress']) {
    const tag = tagWithId('button', id);
    assert.ok(tag, `${id} missing`);
    assert.match(tag[0], /type="button"/, `${id} lacks type="button"`);
  }
});

// ---- text content -----------------------------------------------------------
check('noscript message present', () => {
  const m = /<noscript>([\s\S]*?)<\/noscript>/.exec(html);
  assert.ok(m, 'noscript missing');
  assert.ok(m[1].replace(/\s+/g, ' ').trim().length > 40, 'noscript empty');
});

check('exact footer text', () => {
  const normalized = html.replace(/\s+/g, ' ');
  assert.ok(normalized.includes('7-Zip is (c) 1999-2026 Igor Pavlov. This site runs it entirely in your browser via WebAssembly — your files never leave your device.'), 'footer text mismatch');
});

// ---- summary ------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.error('Failed checks:', failures.join('; ')); process.exit(1); }
console.log('ALL INDEX.HTML CONTRACT CHECKS PASSED');
