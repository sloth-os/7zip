// tests/app-folder-compress.test.mjs
// "Select folders to compress" — app-side scenarios A1-A16. Runs the REAL
// app.js against a minimal DOM stub inside a node:vm context (no browser, no
// build step) with REAL Node timers, instrumented so render-chunk scheduling
// is observable. The worker is a stub: assertions target the compress REQUEST
// payload (files/dirs/archiveName/transfers) — the protocol contract — never
// worker internals.
// Run: node tests/app-folder-compress.test.mjs   (from anywhere)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const APP_PATH = path.join(REPO, 'app.js');
const HTML_PATH = path.join(REPO, 'index.html');
const RENDER_CHUNK = 500; // pinned to index/app contract; asserted below
const READ_CONCURRENCY = 32; // pinned to app.js; asserted in A11
const htmlSource = fs.readFileSync(HTML_PATH, 'utf8');
const enc = new TextEncoder();
const dec = new TextDecoder();

// deepStrictEqual compares prototypes, and every structure app.js builds
// (picker options, worker payloads, transfer lists) lives in the vm realm
// with a DIFFERENT Object.prototype/Array.prototype. Structural comparisons
// therefore round-trip through host-realm JSON first. ArrayBuffer-carrying
// fields are never passed through here — compare those via decode().
const hostOf = (v) => JSON.parse(JSON.stringify(v));

// Initial `hidden` comes from the real index.html markup, so the gating checks
// cover the shipped HTML too (a missing hidden attribute would show the folder
// button in unsupported browsers).
function hiddenInHtml(id) {
  const m = new RegExp('<[^>]*\\bid="' + id + '"[^>]*>', 'i').exec(htmlSource);
  return !!m && /\shidden(\s|=|>|\/)/i.test(m[0]);
}

const ID_TABLE = {
  'dropzone': { tag: 'div' },
  'file-input': { tag: 'input' },
  'folder-input': { tag: 'input', hiddenFromHtml: true },
  'status-line': { tag: 'p' },
  'progress-output': { tag: 'pre' },
  'btn-open-archive': { tag: 'button' },
  'btn-add-folder': { tag: 'button', hiddenFromHtml: true },
  'archive-panel': { tag: 'section', hidden: true },
  'archive-name': { tag: 'span' },
  'entry-select-all': { tag: 'input' },
  'entries-body': { tag: 'tbody' },
  'btn-extract-all': { tag: 'button' },
  'btn-extract-selected': { tag: 'button', disabled: true },
  'btn-extract-folder': { tag: 'button' },
  'btn-extract-selected-folder': { tag: 'button', disabled: true },
  'btn-test-archive': { tag: 'button' },
  'compress-panel': { tag: 'section' },
  'compress-list': { tag: 'ul' },
  'format-select': { tag: 'select', value: '7z' },
  'level-select': { tag: 'select', value: '5' },
  'password-input': { tag: 'input', value: '' },
  'btn-compress': { tag: 'button' },
  'downloads': { tag: 'div' },
  'install-btn': { tag: 'button', hidden: true },
  'net-status': { tag: 'span' },
  'build-version': { tag: 'span', text: 'local' },
  'btn-clear': { tag: 'button' }
};

/* ------------------------------------------------------------- stub files */

function bytesOf(str) {
  const u8 = enc.encode(str);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

// Minimal File stand-in. arrayBuffer() resolves a FRESH buffer per call (the
// real File does too) so re-walks and repeat compress sends stay valid. With
// opts.tracker the stub records concurrent in-flight reads (A11). opts.rel
// sets webkitRelativePath (use '' for "present but empty").
function makeStubFile(name, content, opts = {}) {
  const file = {
    name,
    size: enc.encode(content).byteLength,
    arrayBuffer() {
      if (opts.tracker) {
        opts.tracker.inFlight++;
        if (opts.tracker.inFlight > opts.tracker.max) opts.tracker.max = opts.tracker.inFlight;
        return Promise.resolve(bytesOf(content)).then((b) => {
          opts.tracker.inFlight--;
          return b;
        });
      }
      return Promise.resolve(bytesOf(content));
    }
  };
  if (opts.rel !== undefined) file.webkitRelativePath = opts.rel;
  return file;
}

function manyFiles(n, tracker) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(makeStubFile('f' + String(i).padStart(4, '0') + '.txt', 'data-' + i, { tracker }));
  }
  return out;
}

// File stub whose arrayBuffer() resolves on a MACROTASK after delayMs, so a
// batch stays in flight long enough to overlap a second intake or a Clear
// (A13-A16). opts.tracker records concurrent in-flight reads.
function makeSlowFile(name, content, opts = {}) {
  const delayMs = opts.delay === undefined ? 60 : opts.delay;
  return {
    name,
    size: enc.encode(content).byteLength,
    arrayBuffer() {
      if (opts.tracker) {
        opts.tracker.inFlight++;
        if (opts.tracker.inFlight > opts.tracker.max) opts.tracker.max = opts.tracker.inFlight;
      }
      return new Promise((resolve) => {
        setTimeout(() => {
          if (opts.tracker) opts.tracker.inFlight--;
          resolve(bytesOf(content));
        }, delayMs);
      });
    }
  };
}

/* ----------------------------------- File System Access stubs (A1/A5/A8/A9) */

function makeFileHandle(name, file) {
  return { kind: 'file', name, getFile: () => Promise.resolve(file) };
}

// children: [[childName, handle], ...] — entries() must be an ASYNC ITERABLE
// (app.js walks it with for-await), regenerated per call so repeat picks work.
function makeDirHandle(name, children) {
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const pair of children) yield pair;
    }
  };
}

/* ------------------------------------------- WebKit entry-API stubs (drops) */

function makeFileEntry(name, file) {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file(ok, fail) {
      Promise.resolve().then(() => ok(file));
    }
  };
}

// readEntries delivers at most `batchSize` entries per call and an empty
// array to signal the end — exactly the real API's 100-cap batching contract.
function makeDirEntry(name, children, batchSize) {
  const n = batchSize && batchSize > 0 ? batchSize : Math.max(children.length, 1);
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      let pos = 0;
      return {
        readEntries(ok, fail) {
          Promise.resolve().then(() => {
            const slice = children.slice(pos, pos + n);
            pos += slice.length;
            ok(slice);
          });
        }
      };
    }
  };
}

// DataTransferItem stub. entry null + fallbackFile models the
// "webkitGetAsEntry() returned null" fallback to the synchronously captured
// getAsFile() File.
function itemOf(entry, fallbackFile) {
  return {
    webkitGetAsEntry: () => entry,
    getAsFile: () => fallbackFile || null
  };
}

/* ------------------------------------------------------------- DOM pieces */

function makeElement(world, tag, id, initial) {
  const init = initial || {};
  const classes = new Set(String(init.className || '').split(/\s+/).filter(Boolean));
  const listeners = new Map();
  let text = init.text === undefined ? '' : String(init.text);

  const el = {
    tagName: String(tag).toUpperCase(),
    id: id || '',
    children: [],
    attributes: {},
    listeners,
    hidden: init.hiddenFromHtml ? hiddenInHtml(id) : !!init.hidden,
    value: init.value === undefined ? '' : init.value,
    files: [],
    type: '',
    checked: false,
    indeterminate: false,
    disabled: !!init.disabled,
    scrollTop: 0,
    scrollHeight: 100,
    classList: {
      add(...names) { names.forEach((n) => classes.add(n)); },
      remove(...names) { names.forEach((n) => classes.delete(n)); },
      contains: (n) => classes.has(n),
      toggle(n, force) {
        const on = force === undefined ? !classes.has(n) : !!force;
        if (on) classes.add(n);
        else classes.delete(n);
        return on;
      }
    },
    setAttribute(name, value) { el.attributes[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(el.attributes, name) ? el.attributes[name] : null; },
    appendChild(child) {
      if (child && child.isFragment) {
        for (const c of child.children) el.children.push(c);
        child.children.length = 0;
      } else {
        el.children.push(child);
      }
      return child;
    },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      return child;
    },
    contains(other) {
      return el.children.some((c) => c === other || (c.contains && c.contains(other)));
    },
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn));
    },
    click() {
      world.fire(el, 'click');
    }
  };

  Object.defineProperty(el, 'textContent', {
    get: () => text,
    set: (v) => { text = String(v); el.children.length = 0; }, // like the real DOM
    configurable: true
  });
  Object.defineProperty(el, 'className', {
    get: () => [...classes].join(' '),
    set: (v) => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((n) => classes.add(n)); },
    configurable: true
  });
  return el;
}

function makeFragment() {
  return {
    isFragment: true,
    children: [],
    appendChild(child) { this.children.push(child); return child; }
  };
}

/* ------------------------------------------------------------ mock worlds */

function createAppWorld(opts = {}) {
  const { pickers = {} } = opts;

  const world = {
    opts,
    byId: {},
    windowListeners: new Map(),
    documentListeners: new Map(),
    workers: [],
    workerMessages: [], // { msg, transfers, worker }
    terminated: 0,
    pickerCalls: { open: [], dir: [], save: [] },
    urlCreated: [],
    urlRevoked: [],
    urlSeq: 0,
    logs: [],
    warnings: [],
    errors: [],
    fetchCalls: [],
    timerDelays: [] // every setTimeout(...) app.js itself schedules
  };

  for (const [id, initial] of Object.entries(ID_TABLE)) {
    world.byId[id] = makeElement(world, initial.tag, id, initial);
  }
  // The legacy folder intake is gated on `'webkitdirectory' in folderInput`;
  // plain stubs lack the property, so opt-in worlds add it BEFORE load().
  if (opts.webkitdirectory) world.byId['folder-input'].webkitdirectory = '';

  world.fire = function (el, type, extra) {
    const handlers = el.listeners.get(type) || [];
    const event = Object.assign(
      { type, target: el, preventDefault() {}, stopPropagation() {} },
      extra
    );
    for (const fn of handlers.slice()) fn(event);
    return handlers.length;
  };
  world.click = (el) => world.fire(el, 'click');

  const documentStub = {
    readyState: 'complete',
    getElementById: (id) => world.byId[id] || null,
    createElement: (tag) => makeElement(world, tag),
    createDocumentFragment: () => makeFragment(),
    addEventListener(type, fn) {
      const list = world.documentListeners.get(type) || [];
      list.push(fn);
      world.documentListeners.set(type, list);
    }
  };

  const windowStub = {
    addEventListener(type, fn) {
      const list = world.windowListeners.get(type) || [];
      list.push(fn);
      world.windowListeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = world.windowListeners.get(type) || [];
      world.windowListeners.set(type, list.filter((f) => f !== fn));
    },
    location: { href: 'https://app.example/sub/dir/index.html', origin: 'https://app.example' }
    // no launchQueue, no caches: boot() feature-detects both and stays quiet
  };
  const PICKER_NAMES = [
    ['showOpenFilePicker', 'open'],
    ['showDirectoryPicker', 'dir'],
    ['showSaveFilePicker', 'save']
  ];
  for (const [name, key] of PICKER_NAMES) {
    const impl = pickers[key];
    if (typeof impl === 'function') {
      windowStub[name] = function (options) {
        // Recorded synchronously: picker calls must happen inside the click
        // handler (transient user activation), and A1 asserts exactly that.
        world.pickerCalls[key].push(options);
        return impl(options, world);
      };
    }
  }

  function WorkerStub(url) {
    this.url = String(url);
    this.onmessage = null;
    this.onerror = null;
    this.messages = [];
    world.workers.push(this);
    const self = this;
    this.postMessage = function (msg, transfers) {
      const entry = { msg, transfers: transfers || [], worker: self };
      self.messages.push(entry);
      world.workerMessages.push(entry);
      if (msg && msg.type === 'init') {
        Promise.resolve().then(() => {
          if (self.onmessage) self.onmessage({ data: { id: msg.id, type: 'ready' } });
        });
      }
    };
    this.terminate = function () { world.terminated++; };
  }

  world.reply = function (data) {
    const worker = world.workers[world.workers.length - 1];
    if (!worker || !worker.onmessage) throw new Error('no worker to reply to');
    worker.onmessage({ data });
  };
  world.msgOfType = (type) => world.workerMessages.filter((m) => m.msg.type === type);
  world.lastEntryOfType = (type) => {
    const list = world.msgOfType(type);
    return list.length ? list[list.length - 1] : null;
  };
  world.lastMsgOfType = (type) => {
    const entry = world.lastEntryOfType(type);
    return entry ? entry.msg : null;
  };

  class TestURL extends URL {}
  TestURL.createObjectURL = function (blob) {
    const url = 'blob:7zip-test/' + (++world.urlSeq);
    world.urlCreated.push({ url, blob });
    return url;
  };
  TestURL.revokeObjectURL = function (url) {
    world.urlRevoked.push(url);
  };

  const navigatorStub = { onLine: true }; // no serviceWorker on purpose

  const sandbox = {
    window: windowStub,
    document: documentStub,
    navigator: navigatorStub,
    Worker: WorkerStub,
    fetch(url) {
      world.fetchCalls.push(String(url));
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error('no json')) });
    },
    console: {
      log: (...args) => world.logs.push(args.join(' ')),
      info: (...args) => world.logs.push(args.join(' ')),
      warn: (...args) => world.warnings.push(args.join(' ')),
      error: (...args) => world.errors.push(args.join(' '))
    },
    URL: TestURL,
    Blob,
    File,
    Response,
    Headers,
    Request,
    FormData,
    TextEncoder,
    TextDecoder,
    // Record every timer app.js schedules. renderEntries and renderCompressList
    // are the ONLY setTimeout callers in app.js, so these are render-chunk
    // ticks — the compress-list chunking asserts (A6/A7) read this array.
    setTimeout(fn, ms, ...rest) {
      world.timerDelays.push(ms);
      return setTimeout(fn, ms, ...rest);
    },
    clearTimeout,
    queueMicrotask
    // NOTE: no requestAnimationFrame on purpose — the chunk schedulers must
    // not depend on one.
  };

  const ctx = vm.createContext(sandbox);
  world.ctx = ctx;
  world.sandbox = sandbox;
  world.windowStub = windowStub;
  world.load = () => {
    vm.runInContext(fs.readFileSync(APP_PATH, 'utf8'), ctx, { filename: APP_PATH });
    return world;
  };
  world.status = () => world.byId['status-line'].textContent;
  world.isError = () => world.byId['status-line'].classList.contains('error');
  world.rows = () => world.byId['entries-body'].children;
  world.compressRows = () => world.byId['compress-list'].children;
  world.rowLabel = (i) => world.compressRows()[i].children[0].textContent;
  world.rowAria = (i) => world.compressRows()[i].children[1].getAttribute('aria-label');
  world.clickRemove = (i) => world.compressRows()[i].children[1].click();
  world.waitFor = (pred, ms) => waitFor(pred, ms);
  return world;
}

/* --------------------------------------------------------------- timing */

function tick(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

// Flush pending promise callbacks (microtasks) WITHOUT firing any macrotask
// timer — used to observe the synchronous-first-chunk state before the
// setTimeout(0) chain runs.
async function flushMicro(hops = 8) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try { ok = !!predicate(); } catch { ok = false; }
    if (ok) return true;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

let passed = 0;
const failures = [];
async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log('ok   - ' + name);
  } catch (err) {
    failures.push(name);
    console.log('FAIL - ' + name);
    console.log('       ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n       ') : err));
  }
}

/* ------------------------------------------------------------- scenarios */

async function main() {
  await t('(A1) showDirectoryPicker walk: root-prefixed paths, empty dirs (incl. dir-of-empty-dirs), hint + payload + naming', async () => {
    const root = makeDirHandle('photos', [
      ['a.jpg', makeFileHandle('a.jpg', makeStubFile('a.jpg', 'AAAAA'))],
      ['2024', makeDirHandle('2024', [
        ['b.jpg', makeFileHandle('b.jpg', makeStubFile('b.jpg', 'BBB'))],
        ['empty1', makeDirHandle('empty1', [])]
      ])],
      ['onlyempty', makeDirHandle('onlyempty', [
        ['empty2', makeDirHandle('empty2', [])]
      ])]
    ]);
    const world = createAppWorld({ pickers: { dir: () => Promise.resolve(root) } }).load();
    assert.equal(world.byId['btn-add-folder'].hidden, false, 'gated button must unhide when showDirectoryPicker exists');

    world.byId['btn-add-folder'].click();
    // The picker call must be synchronous with the click (transient user
    // activation) and use read-only mode with the compress picker id.
    assert.equal(world.pickerCalls.dir.length, 1, 'picker not called synchronously on click');
    assert.deepEqual(hostOf(world.pickerCalls.dir[0]), { mode: 'read', id: '7zip-compress', startIn: 'documents' });

    await world.waitFor(() => world.status() === '2 files queued for compression');
    assert.equal(world.byId['compress-panel'].hidden, false, 'compress panel must show');
    assert.deepEqual(world.compressRows().map((li) => li.children[0].textContent), [
      'photos/a.jpg — 5 B',
      'photos/2024/b.jpg — 3 B',
      'photos/2024/empty1 — empty folder',
      'photos/onlyempty/empty2 — empty folder',
      'photos/onlyempty — empty folder' // dir holding only an empty dir: 0 files anywhere
    ]);
    assert.equal(world.rowAria(0), 'Remove a.jpg from the list');
    assert.equal(world.rowAria(2), 'Remove folder photos/2024/empty1 from the list');

    world.byId['btn-compress'].click();
    await world.waitFor(() => world.lastMsgOfType('compress'));
    const msg = world.lastMsgOfType('compress');
    assert.equal(msg.type, 'compress');
    assert.deepEqual(hostOf(msg.files.map((f) => f.path)), ['photos/a.jpg', 'photos/2024/b.jpg']);
    assert.deepEqual(hostOf(msg.dirs), ['photos/2024/empty1', 'photos/onlyempty/empty2', 'photos/onlyempty']);
    assert.equal(msg.archiveName, 'photos.7z', 'archive must be named after the picked folder root');
    assert.equal(msg.format, '7z');
    assert.equal(msg.level, '5');
    assert.equal(dec.decode(msg.files[0].data), 'AAAAA');
    assert.equal(world.lastEntryOfType('compress').transfers.length, 2, 'one transferred copy per file');
    world.reply({ id: msg.id, type: 'compress-result', archive: { name: msg.archiveName, data: bytesOf('zzz') } });
    await world.waitFor(() => world.status() === 'Created "photos.7z" (3 B)');

    // Second click: queued buffers survive (transferCopy sends detached copies).
    world.byId['btn-compress'].click();
    await world.waitFor(() => world.msgOfType('compress').length === 2);
    const msg2 = world.msgOfType('compress')[1].msg;
    assert.equal(dec.decode(msg2.files[0].data), 'AAAAA', 'queued buffer must survive the first send');
  });

  await t('(A2) webkitdirectory fallback: FileList intake, rootName from first relative path, input reset', async () => {
    const world = createAppWorld({ webkitdirectory: true }).load();
    assert.equal(world.byId['btn-add-folder'].hidden, false, 'button must unhide when the input supports webkitdirectory');
    const folderInput = world.byId['folder-input'];
    let clicks = 0;
    folderInput.addEventListener('click', () => { clicks++; });
    world.byId['btn-add-folder'].click();
    assert.equal(clicks, 1, 'button click must forward to folderInput.click()');

    folderInput.value = 'C:\\fakepath\\whatever';
    folderInput.files = [
      makeStubFile('a.txt', 'aaa', { rel: 'photos/a.txt' }),
      makeStubFile('b.txt', 'bb', { rel: 'photos/sub/b.txt' })
    ];
    world.fire(folderInput, 'change');
    assert.equal(world.status(), 'Reading 2 files…');
    assert.equal(folderInput.value, '', 'input value must reset so the same folder can be re-picked');

    await world.waitFor(() => world.status() === '2 files queued for compression');
    assert.deepEqual(world.compressRows().map((li) => li.children[0].textContent), [
      'photos/a.txt — 3 B',
      'photos/sub/b.txt — 2 B'
    ]);

    world.byId['btn-compress'].click();
    await world.waitFor(() => world.lastMsgOfType('compress'));
    const msg = world.lastMsgOfType('compress');
    assert.deepEqual(hostOf(msg.files.map((f) => f.path)), ['photos/a.txt', 'photos/sub/b.txt']);
    assert.deepEqual(hostOf(msg.dirs), [], 'dirs is always sent — empty for the legacy intake');
    assert.equal(msg.archiveName, 'photos.7z');
  });

  await t('(A3) entry-API drop: readEntries batching, empty dirs, and a directory named evil.zip NEVER opens as an archive', async () => {
    const world = createAppWorld().load();
    const dirEntry = makeDirEntry('evil.zip', [
      makeFileEntry('inner.txt', makeStubFile('inner.txt', 'III')),
      makeDirEntry('sub', []),
      makeFileEntry('note.md', makeStubFile('note.md', 'NN'))
    ], 2); // force multi-batch readEntries (real API caps at 100 per call)
    world.fire(world.byId['dropzone'], 'drop', {
      dataTransfer: {
        items: [itemOf(dirEntry)],
        files: [makeStubFile('decoy.7z', 'ZZ')] // must be ignored while items carry entries
      }
    });

    await world.waitFor(() => world.status() === '2 files queued for compression');
    assert.equal(world.msgOfType('list').length, 0, 'a dropped DIRECTORY named *.zip must never open as an archive');
    assert.equal(world.byId['archive-panel'].hidden, true, 'archive panel must stay closed');
    assert.deepEqual(world.compressRows().map((li) => li.children[0].textContent), [
      'evil.zip/inner.txt — 3 B',
      'evil.zip/note.md — 2 B',
      'evil.zip/sub — empty folder'
    ]);

    world.byId['btn-compress'].click();
    await world.waitFor(() => world.lastMsgOfType('compress'));
    const msg = world.lastMsgOfType('compress');
    assert.deepEqual(hostOf(msg.files.map((f) => f.path)), ['evil.zip/inner.txt', 'evil.zip/note.md']);
    assert.deepEqual(hostOf(msg.dirs), ['evil.zip/sub']);
    assert.equal(msg.archiveName, 'evil.zip.7z', 'hint is the dropped folder root; the format extension is still appended');
  });

  await t('(A4) mixed drop: archive opens, null-entry item falls back to getAsFile, folder queues alongside', async () => {
    const world = createAppWorld().load();
    const arc = makeStubFile('arc.7z', 'ARC');
    world.fire(world.byId['dropzone'], 'drop', {
      dataTransfer: {
        items: [
          itemOf(makeFileEntry('arc.7z', arc), arc),
          itemOf(null, makeStubFile('loose.txt', 'LOOSE')), // webkitGetAsEntry() -> null
          itemOf(makeDirEntry('docs', [makeFileEntry('d.txt', makeStubFile('d.txt', 'DDDD'))]))
        ],
        files: [makeStubFile('decoy.zip', 'X')] // ignored: the entry path won
      }
    });

    await world.waitFor(() => world.msgOfType('list').length === 1);
    const listMsg = world.lastMsgOfType('list');
    assert.equal(listMsg.archive.name, 'arc.7z', 'the dropped archive FILE (not the decoy, not the folder) opens');
    world.reply({
      id: listMsg.id,
      type: 'list-result',
      entries: [{ path: 'x', isFolder: false, size: 1, modified: '2026-01-01 00:00', method: 'LZMA2', encrypted: false }]
    });
    await world.waitFor(() => world.byId['archive-panel'].hidden === false && world.compressRows().length === 2);
    assert.deepEqual(world.compressRows().map((li) => li.children[0].textContent), [
      'loose.txt — 5 B',
      'docs/d.txt — 4 B'
    ]);
    assert.equal(world.byId['compress-panel'].hidden, false, 'compress panel must stay visible while the archive is open');
    await world.waitFor(() => world.status().includes('entries listed'));
  });

  await t('(A5a) dedupe: re-adding the same folder skips the whole batch and reports the count', async () => {
    const makeRoot = () => makeDirHandle('photos', [
      ['a.jpg', makeFileHandle('a.jpg', makeStubFile('a.jpg', 'AAAAA'))],
      ['b.jpg', makeFileHandle('b.jpg', makeStubFile('b.jpg', 'BBB'))],
      ['e', makeDirHandle('e', [])]
    ]);
    const world = createAppWorld({ pickers: { dir: () => Promise.resolve(makeRoot()) } }).load();
    const btn = world.byId['btn-add-folder'];
    btn.click();
    await world.waitFor(() => world.status() === '2 files queued for compression');
    assert.equal(world.compressRows().length, 3);

    btn.click(); // same tree again: 2 file paths + 1 dir path all collide
    await world.waitFor(() => world.status().includes('skipped'));
    assert.equal(world.status(), '2 files queued for compression (3 duplicates skipped)');
    assert.equal(world.compressRows().length, 3, 'nothing may be re-queued');

    world.byId['btn-compress'].click();
    await world.waitFor(() => world.lastMsgOfType('compress'));
    const msg = world.lastMsgOfType('compress');
    assert.deepEqual(hostOf(msg.files.map((f) => f.path)), ['photos/a.jpg', 'photos/b.jpg']);
    assert.deepEqual(hostOf(msg.dirs), ['photos/e'], 'no duplicate dir entries either');
  });

  await t('(A5b) dedupe: loose file vs folder-resolved path and within-batch duplicates', async () => {
    const world = createAppWorld({ webkitdirectory: true }).load();
    const input = world.byId['file-input'];
    input.files = [makeStubFile('x.txt', 'XXXX')];
    world.fire(input, 'change');
    await world.waitFor(() => world.status() === '1 file queued for compression');

    // Folder batch whose first item resolves to the loose file's path (empty
    // webkitRelativePath -> name fallback) plus a within-batch duplicate pair.
    const folderInput = world.byId['folder-input'];
    folderInput.files = [
      makeStubFile('x.txt', 'XXXX', { rel: '' }),
      makeStubFile('y.txt', 'Y', { rel: 'F/y.txt' }),
      makeStubFile('y.txt', 'Y', { rel: 'F/y.txt' })
    ];
    world.fire(folderInput, 'change');
    await world.waitFor(() => world.status().includes('skipped'));
    assert.equal(world.status(), '2 files queued for compression (2 duplicates skipped)');
    assert.deepEqual(world.compressRows().map((li) => li.children[0].textContent), [
      'x.txt — 4 B',
      'F/y.txt — 1 B'
    ]);

    world.byId['btn-compress'].click();
    await world.waitFor(() => world.lastMsgOfType('compress'));
    const msg = world.lastMsgOfType('compress');
    assert.deepEqual(hostOf(msg.files.map((f) => f.path)), ['x.txt', 'F/y.txt'], 'exactly one copy of each path');
    assert.equal(msg.archiveName, 'F.7z', 'rootName comes from the first item that has a webkitRelativePath');
  });

  await t('(A6) Remove buttons with >RENDER_CHUNK rows splice the right array element and re-render coherently', async () => {
    const world = createAppWorld().load();
    const input = world.byId['file-input'];
    input.files = manyFiles(1200);
    world.fire(input, 'change');
    await world.waitFor(() => world.compressRows().length === 1200 && world.status() === '1200 files queued for compression');

    // One empty folder adds a dir row AFTER the 1200 file rows.
    world.fire(world.byId['dropzone'], 'drop', {
      dataTransfer: { items: [itemOf(makeDirEntry('E', []))], files: [] }
    });
    await world.waitFor(() => world.compressRows().length === 1201);
    assert.equal(world.rowLabel(1200), 'E — empty folder');

    // Remove the first file row: re-render starts with a synchronous chunk.
    world.clickRemove(0);
    assert.equal(world.compressRows().length, RENDER_CHUNK, 're-render must build the first chunk synchronously');
    await world.waitFor(() => world.compressRows().length === 1200);
    assert.ok(world.rowLabel(0).startsWith('f0001.txt — '), 'the RIGHT element was spliced: ' + world.rowLabel(0));

    // Remove the dir row (last row): splices queuedDirs, not queuedFiles.
    world.clickRemove(1199);
    await world.waitFor(() => world.compressRows().length === 1199);
    assert.ok(world.rowLabel(1198).startsWith('f1199.txt — '), 'file rows must be intact: ' + world.rowLabel(1198));

    world.byId['btn-compress'].click();
    await world.waitFor(() => world.lastMsgOfType('compress'));
    const msg = world.lastMsgOfType('compress');
    assert.equal(msg.files.length, 1199, 'payload reflects the removed file');
    assert.equal(msg.files[0].path, 'f0001.txt');
    assert.equal(msg.files[1198].path, 'f1199.txt');
    assert.deepEqual(hostOf(msg.dirs), [], 'removed empty folder must leave the payload');
    assert.equal(msg.archiveName, 'E.7z', 'the dropped folder set the naming hint before it was removed as a row');
  });

  await t('(A7a) chunked compress render: first chunk sync, remaining chunks via setTimeout(0), no runaway timer', async () => {
    const world = createAppWorld().load();
    const input = world.byId['file-input'];
    input.files = manyFiles(1200);
    world.fire(input, 'change');
    await flushMicro(400); // reads settle on microtasks; NO timer has fired yet
    assert.equal(world.status(), '1200 files queued for compression');
    assert.equal(world.compressRows().length, RENDER_CHUNK, 'exactly the first chunk builds synchronously');
    assert.deepEqual(world.timerDelays, [0], 'one chunk timer scheduled after the sync chunk');

    // Poll for the completed chain instead of a fixed wall-clock window: each
    // remaining chunk is one chained setTimeout(0) whose callback builds up to
    // RENDER_CHUNK DOM-stub rows, so a fixed budget (tick(30)) fails under
    // event-loop load with only part of the list built. waitFor keeps the
    // assertion on the OUTCOME (all rows) plus the pinned timer shape below.
    await world.waitFor(() => world.compressRows().length === 1200);
    assert.equal(world.compressRows().length, 1200, 'remaining rows stream in on timer ticks');
    assert.deepEqual(world.timerDelays, [0, 0], 'ceil(1200/500)-1 chunk timers, all delay 0');

    await tick(40);
    assert.deepEqual(world.timerDelays, [0, 0], 'no timer may be scheduled once the list is complete');
    assert.equal(world.compressRows().length, 1200);
  });

  await t('(A7b) Clear mid-chain stops the pending compress chunk chain (compressRenderToken)', async () => {
    const world = createAppWorld().load();
    const input = world.byId['file-input'];
    input.files = manyFiles(1200);
    world.fire(input, 'change');
    await flushMicro(400);
    assert.equal(world.compressRows().length, RENDER_CHUNK);
    assert.deepEqual(world.timerDelays, [0], 'chunk timer pending');

    world.byId['btn-clear'].click(); // BEFORE the pending timer fires
    assert.equal(world.compressRows().length, 0, 'Clear empties the list synchronously');
    assert.equal(world.byId['compress-panel'].hidden, true);

    await tick(60);
    assert.equal(world.compressRows().length, 0, 'the superseded chunk chain must NOT append after Clear');
    assert.deepEqual(world.timerDelays, [0], 'Clear schedules no new timer');
  });

  await t('(A7c) a superseding batch render kills the previous chain (no doubled rows)', async () => {
    const world = createAppWorld().load();
    const input = world.byId['file-input'];
    input.files = manyFiles(1200);
    world.fire(input, 'change');
    await flushMicro(400);
    assert.equal(world.compressRows().length, RENDER_CHUNK);

    // Second batch lands while the first chain still has a pending timer.
    input.files = [makeStubFile('extra.txt', 'E')];
    world.fire(input, 'change');
    await flushMicro(400);
    assert.equal(world.status(), '1201 files queued for compression');
    assert.equal(world.compressRows().length, RENDER_CHUNK, 'the NEW render replaced the list and built its own first chunk');
    assert.deepEqual(world.timerDelays, [0, 0], 'stale-chain timer + new-chain timer, neither fired yet');

    await world.waitFor(() => world.compressRows().length === 1201);
    assert.equal(world.compressRows().length, 1201, 'exactly 1201 rows — the stale chain appended nothing');
    assert.ok(world.rowLabel(1200).startsWith('extra.txt — '));
  });

  await t('(A8) empty-folder-only pick: dirs-only payload, hint naming, download still produced', async () => {
    const world = createAppWorld({ pickers: { dir: () => Promise.resolve(makeDirHandle('vacant', [])) } }).load();
    world.byId['btn-add-folder'].click();
    await world.waitFor(() => world.byId['compress-panel'].hidden === false);
    assert.deepEqual(world.compressRows().map((li) => li.children[0].textContent), ['vacant — empty folder']);
    assert.equal(world.rowAria(0), 'Remove folder vacant from the list');
    assert.ok(!world.status().includes('Reading'), 'a dirs-only batch reads no bytes — no Reading status');
    assert.equal(world.isError(), false);

    world.byId['btn-compress'].click();
    assert.equal(world.status(), 'Compressing 1 folder…', 'dirs-only batches count folders, not files');
    await world.waitFor(() => world.lastMsgOfType('compress'));
    const msg = world.lastMsgOfType('compress');
    assert.deepEqual(hostOf(msg.files), [], 'files is empty but always present');
    assert.deepEqual(hostOf(msg.dirs), ['vacant']);
    assert.equal(msg.archiveName, 'vacant.7z', 'dirs-only batch names after the folder root hint');
    assert.deepEqual(hostOf(world.lastEntryOfType('compress').transfers), [], 'no file bytes to transfer');

    world.reply({ id: msg.id, type: 'compress-result', archive: { name: msg.archiveName, data: bytesOf('vac') } });
    await world.waitFor(() => world.status() === 'Created "vacant.7z" (3 B)');
    assert.equal(world.byId['downloads'].children.length, 1, 'download row appeared');
  });

  await t('(A9) Clear resets queuedDirs and archiveBaseHint; plain files name by the old rule again', async () => {
    const root = makeDirHandle('photos', [
      ['a.jpg', makeFileHandle('a.jpg', makeStubFile('a.jpg', 'AAAAA'))]
    ]);
    const world = createAppWorld({ pickers: { dir: () => Promise.resolve(root) } }).load();
    world.byId['btn-add-folder'].click();
    await world.waitFor(() => world.status() === '1 file queued for compression');

    world.byId['btn-clear'].click();
    assert.equal(world.byId['compress-panel'].hidden, true);
    assert.equal(world.compressRows().length, 0);

    const input = world.byId['file-input'];
    input.files = [makeStubFile('note.txt', 'abc')];
    world.fire(input, 'change');
    await world.waitFor(() => world.status() === '1 file queued for compression');

    world.byId['btn-compress'].click();
    await world.waitFor(() => world.lastMsgOfType('compress'));
    const msg = world.lastMsgOfType('compress');
    assert.equal(msg.archiveName, 'note.txt.7z', 'stale folder hint must not survive Clear');
    assert.deepEqual(hostOf(msg.dirs), [], 'stale empty dirs must not survive Clear');
    assert.deepEqual(hostOf(msg.files.map((f) => f.path)), ['note.txt']);
  });

  await t('(A10) gating: no showDirectoryPicker + no webkitdirectory -> button stays hidden and inert', async () => {
    // The shipped markup must hide both new elements (unsupported browsers).
    assert.ok(hiddenInHtml('btn-add-folder'), 'btn-add-folder must ship hidden in index.html');
    assert.ok(hiddenInHtml('folder-input'), 'folder-input must ship hidden in index.html');

    const world = createAppWorld().load(); // no pickers, plain stub input
    const btn = world.byId['btn-add-folder'];
    assert.equal(btn.hidden, true, 'button must stay hidden without any folder API');
    assert.equal((btn.listeners.get('click') || []).length, 0, 'no click handler may be wired');
    assert.equal((world.byId['folder-input'].listeners.get('change') || []).length, 0, 'no change handler may be wired');
  });

  await t('(A11) reads run with bounded concurrency (READ_CONCURRENCY) and keep input order', async () => {
    // Pin the constant to the source so a silent change cannot pass.
    const appjs = fs.readFileSync(APP_PATH, 'utf8');
    assert.ok(appjs.includes('var READ_CONCURRENCY = ' + READ_CONCURRENCY + ';'), 'READ_CONCURRENCY pin');

    const tracker = { inFlight: 0, max: 0 };
    const world = createAppWorld().load();
    const input = world.byId['file-input'];
    const files = manyFiles(100, tracker);
    input.files = files;
    world.fire(input, 'change');
    assert.equal(world.status(), 'Reading 100 files…');
    assert.equal(tracker.max, READ_CONCURRENCY, 'the full read window opens synchronously');

    await world.waitFor(() => world.status() === '100 files queued for compression');
    assert.equal(tracker.max, READ_CONCURRENCY, 'never more than 32 arrayBuffer() calls in flight');
    assert.equal(tracker.inFlight, 0, 'all reads settled');

    world.byId['btn-compress'].click();
    await world.waitFor(() => world.lastMsgOfType('compress'));
    const msg = world.lastMsgOfType('compress');
    assert.deepEqual(hostOf(msg.files.map((f) => f.path)), files.map((f) => f.name), 'queue order = input order regardless of completion order');
  });

  await t('(A12) legacy plain-file statuses are byte-identical to the pre-folder behavior', async () => {
    const world = createAppWorld().load();
    const input = world.byId['file-input'];
    input.files = [makeStubFile('note.txt', 'abc')];
    world.fire(input, 'change');
    assert.equal(world.status(), 'Reading 1 file…', 'singular wording preserved');
    await world.waitFor(() => world.status() === '1 file queued for compression');

    input.files = [makeStubFile('a.txt', 'aaaa'), makeStubFile('b.txt', 'bb')];
    world.fire(input, 'change');
    assert.equal(world.status(), 'Reading 2 files…');
    await world.waitFor(() => world.status() === '3 files queued for compression');
    assert.deepEqual(world.compressRows().map((li) => li.children[0].textContent), [
      'note.txt — 3 B',
      'a.txt — 4 B',
      'b.txt — 2 B'
    ]);

    world.byId['btn-compress'].click();
    assert.equal(world.status(), 'Compressing 3 files…');
    await world.waitFor(() => world.lastMsgOfType('compress'));
    const msg = world.lastMsgOfType('compress');
    assert.equal(msg.archiveName, 'note.txt.7z', 'old naming rule: base name of the first queued file');
    assert.deepEqual(hostOf(msg.dirs), [], 'dirs always present, empty on the legacy path');
    world.reply({ id: msg.id, type: 'compress-result', archive: { name: msg.archiveName, data: bytesOf('z') } });
    await world.waitFor(() => world.status() === 'Created "note.txt.7z" (1 B)');
  });

  await t('(A12b) empty-queue guard message + legacy dt.files drop routing unchanged', async () => {
    const world = createAppWorld().load();
    world.byId['btn-compress'].click();
    assert.equal(world.status(), 'Nothing to compress — drop files or folders first');
    assert.equal(world.isError(), true);

    // Drop with NO items/webkitGetAsEntry anywhere: the old dt.files path.
    const arc = makeStubFile('old.7z', 'ARC');
    const plain = makeStubFile('p.txt', 'P');
    world.fire(world.byId['dropzone'], 'drop', { dataTransfer: { files: [arc, plain] } });
    assert.equal(world.status(), 'Reading 1 file…', 'plain remainder keeps the legacy queue status');
    await world.waitFor(() => world.msgOfType('list').length === 1);
    assert.equal(world.lastMsgOfType('list').archive.name, 'old.7z', 'first archive-named file still opens');
    await world.waitFor(() => world.status() === '1 file queued for compression');
    assert.deepEqual(world.compressRows().map((li) => li.children[0].textContent), ['p.txt — 1 B']);
  });

  await t('(A13) an intake overlapping an in-flight batch dedupes against it (no duplicate paths)', async () => {
    // A folder pick reads for seconds with no per-file feedback, so a second
    // drop of the same tree landing mid-read is a real user flow. Both batches
    // would otherwise queue the same paths and the worker rejects the WHOLE
    // compress job on 'compress: duplicate input path'.
    const world = createAppWorld().load();
    const input = world.byId['file-input'];
    input.files = [makeSlowFile('a.txt', 'A', { delay: 200 }), makeSlowFile('b.txt', 'B', { delay: 200 })];
    world.fire(input, 'change');
    assert.equal(world.status(), 'Reading 2 files…');

    // Same tree again BEFORE the first batch commits anything to the queue.
    input.files = [makeSlowFile('a.txt', 'A', { delay: 200 }), makeSlowFile('b.txt', 'B', { delay: 200 })];
    world.fire(input, 'change');

    await world.waitFor(() => world.status() === '2 files queued for compression');
    assert.deepEqual(world.compressRows().map((li) => li.children[0].textContent), [
      'a.txt — 1 B',
      'b.txt — 1 B'
    ], 'each path queued exactly once');

    world.byId['btn-compress'].click();
    await world.waitFor(() => world.lastMsgOfType('compress'));
    const msg = world.lastMsgOfType('compress');
    assert.deepEqual(hostOf(msg.files.map((f) => f.path)), ['a.txt', 'b.txt'], 'no duplicate paths in the payload');

    // The reservation is released once the batch settles: the queue itself
    // dedupes from here on (A5 behavior, unchanged).
    input.files = [makeStubFile('a.txt', 'A')];
    world.fire(input, 'change');
    await world.waitFor(() => world.status() === '2 files queued for compression (1 duplicate skipped)');
  });

  await t('(A14) Clear while a batch is reading stays cleared (generation guard)', async () => {
    const world = createAppWorld().load();
    const initial = world.status();
    const input = world.byId['file-input'];
    input.files = [makeSlowFile('a.txt', 'A', { delay: 250 }), makeSlowFile('b.txt', 'B', { delay: 250 })];
    world.fire(input, 'change');
    assert.equal(world.status(), 'Reading 2 files…');

    world.byId['btn-clear'].click();
    assert.equal(world.status(), initial, 'Clear resets the status line');

    await tick(600); // both reads settle and the batch callback runs
    assert.equal(world.compressRows().length, 0, 'a cleared batch must not re-queue its bytes');
    assert.equal(world.byId['compress-panel'].hidden, true, 'the panel must stay hidden');
    assert.equal(world.status(), initial, 'no resurrected queue status');
    assert.equal(world.isError(), false, 'no error status either');
    world.byId['btn-compress'].click();
    assert.equal(world.status(), 'Nothing to compress — drop files or folders first', 'the queue is really empty');

    // The released reservation means the same paths can be queued again.
    input.files = [makeSlowFile('a.txt', 'A', { delay: 5 })];
    world.fire(input, 'change');
    await world.waitFor(() => world.status() === '1 file queued for compression');
    assert.deepEqual(world.compressRows().map((li) => li.children[0].textContent), ['a.txt — 1 B']);
  });

  await t('(A15) two folders dropped at once share ONE READ_CONCURRENCY window', async () => {
    // Each dropped folder is its own batch; the cap is global, so N folders in
    // one drop must not open N x 32 concurrent arrayBuffer() reads.
    const tracker = { inFlight: 0, max: 0 };
    const world = createAppWorld().load();
    function folder(name, count) {
      const kids = [];
      for (let i = 0; i < count; i++) {
        kids.push(makeFileEntry('f' + i + '.txt', makeSlowFile('f' + i + '.txt', 'data-' + i, { tracker, delay: 20 })));
      }
      return makeDirEntry(name, kids, 100);
    }
    world.fire(world.byId['dropzone'], 'drop', {
      dataTransfer: { items: [itemOf(folder('one', 60)), itemOf(folder('two', 60))], files: [] }
    });

    await world.waitFor(() => world.compressRows().length === 120);
    assert.equal(tracker.max, READ_CONCURRENCY, 'never more than 32 reads in flight across batches (saw ' + tracker.max + ')');
    assert.equal(tracker.inFlight, 0, 'all reads settled');

    world.byId['btn-compress'].click();
    await world.waitFor(() => world.lastMsgOfType('compress'));
    const msg = world.lastMsgOfType('compress');
    const paths = hostOf(msg.files.map((f) => f.path));
    assert.equal(paths.length, 120, 'both folders queued in full');
    assert.equal(new Set(paths).size, 120, 'no duplicate paths');
    assert.ok(paths.includes('one/f0.txt') && paths.includes('two/f0.txt'), 'both roots present');
  });

  await t('(A16) Clear + re-pick while the old batch is still reading: the new pick queues, the old stays dead', async () => {
    // Folder reads take seconds. A user who hits Clear mid-read and picks the
    // SAME folder again must get the new pick queued: the old batch is
    // gen-dead (it can never commit), so its stale reservation must not dedupe
    // the fresh one away. Conversely, the LIVE re-pick's own reservation must
    // still dedupe a third intake, and the dead batch settling late must not
    // release it (generation-tagged reservations in pendingPaths).
    const world = createAppWorld().load();
    const input = world.byId['file-input'];
    input.files = [makeSlowFile('a.txt', 'A', { delay: 300 }), makeSlowFile('b.txt', 'B', { delay: 300 })];
    world.fire(input, 'change');
    assert.equal(world.status(), 'Reading 2 files…');

    world.byId['btn-clear'].click();

    // Re-pick the same paths while batch 1 is still reading.
    input.files = [makeSlowFile('a.txt', 'A', { delay: 150 }), makeSlowFile('b.txt', 'B', { delay: 150 })];
    world.fire(input, 'change');
    assert.equal(world.status(), 'Reading 2 files…', 'the re-pick reads instead of deduping to zero');

    // A third intake of an overlapping path dedupes against the LIVE batch-2
    // reservation (batch 2 has not settled yet).
    input.files = [makeStubFile('a.txt', 'A')];
    world.fire(input, 'change');
    await world.waitFor(() => world.status().includes('duplicate'));
    assert.equal(world.status(), '0 file queued for compression (1 duplicate skipped)');

    // Batch 2 commits exactly once…
    await world.waitFor(() => world.compressRows().length === 2);
    assert.deepEqual(world.compressRows().map((li) => li.children[0].textContent), [
      'a.txt — 1 B',
      'b.txt — 1 B'
    ], 'the re-picked batch queues exactly once each');
    assert.equal(world.status(), '2 files queued for compression');

    // …and batch 1 settling afterwards neither adds rows nor steals batch 2's
    // released-by-then reservation (rows stay put, payload stays unique).
    await tick(500);
    assert.equal(world.compressRows().length, 2, 'the dead batch never commits');

    world.byId['btn-compress'].click();
    await world.waitFor(() => world.lastMsgOfType('compress'));
    const paths = hostOf(world.lastMsgOfType('compress').files.map((f) => f.path));
    assert.deepEqual(paths, ['a.txt', 'b.txt'], 'no duplicate paths in the payload');
  });

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    console.log('FAILED:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('ALL APP FOLDER-COMPRESS TESTS PASSED');
}

main().catch((err) => {
  console.error('fatal', err);
  process.exit(1);
});
