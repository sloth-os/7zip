#!/usr/bin/env node
/*
 * app-stage-cache.test.mjs — mock-harness test for the STAGE-ONCE archive
 * protocol in /home/ubuntu/software/7zip-web/app.js.
 *
 * Runs the REAL app.js inside a vm context with stubbed browser globals
 * (document / window / navigator / Worker / URL / Blob / File / fetch /
 * console + Node's real timers), copied from tests/app-file-handling.test.mjs,
 * and drives the new wire protocol:
 *
 *   (S1)  the opening 'list' is the ONLY byte-carrying request: archive.data
 *         travels in the TRANSFER list (never a slice copy) next to a
 *         non-empty string archiveKey
 *   (S2)  all five operations (extract-all, test, extract-to-folder,
 *         extract-selected, selected-to-folder) send archiveKey with NO
 *         archive bytes and NO 'files' field; selections stay sorted 'paths'
 *   (S3)  a second open lists under a DIFFERENT archiveKey
 *   (S4)  unknown-key recovery: re-read the File -> re-stage under the SAME
 *         key -> ONE identical retry, all silent (status untouched, selection
 *         and table untouched), ending in the pinned success status
 *   (S5)  retry-once: a second unknown-key surfaces the error and never
 *         triggers a third extract or a second re-stage
 *   (S6)  Clear mid-recovery abandons it: no further list/extract, no status
 *   (S7)  a superseding open mid-recovery: no re-stage list carrying the old
 *         key is ever sent, the old chain stays silent (stale flag)
 *   (S8)  worker restart: the keyed request goes to the NEW worker, and the
 *         unknown-key reply recovers there
 *   (S9)  Clear posts exactly one fire-and-forget {type:'evict'} (no id, no
 *         reply awaited) as its last worker message
 *   (S10) the key survives a password change; the new password rides along
 *   (S11) unknown-key recovery for the TEST operation ('test: unknown
 *         archiveKey' -> silent re-stage -> ONE retry test -> pinned status)
 *   (S12) folder flows: extract-to-folder recovers and writes its files; a
 *         superseding open mid-folder-recovery stays silent (the shared
 *         .catch's err.stale guard fires BEFORE the AbortError check)
 *   (S13) the retry reuses the PASSWORD CAPTURED AT CLICK TIME while the
 *         re-stage list carries the password typed in the meantime (§2.4)
 *   (S14) a File re-read that REJECTS during recovery propagates and is
 *         displayed like any other error — no re-stage, no retry
 *   (S15) the posted list bytes are the VERY buffer the File read resolved
 *         with (no copy anywhere between arrayBuffer() and postMessage), on
 *         the open AND on the recovery re-stage
 *
 * Usage: node tests/app-stage-cache.test.mjs   (from the repo root)
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PATH = path.join(REPO, 'app.js');

/* ---------------------------------------------------------------- reporting */

let passCount = 0;
let failCount = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    passCount++;
    console.log('PASS  ' + name);
  } else {
    failCount++;
    const detail = extra === undefined ? '' : ' -- ' + extra;
    failures.push(name + detail);
    console.log('FAIL  ' + name + detail);
  }
}

function section(title) {
  console.log('\n== ' + title + ' ==');
}

/* ------------------------------------------------------- realm-safe helpers */

function deepEq(a, b) {
  if (a === b) return true;
  if (isBytes(a) || isBytes(b)) return isBytes(a) && isBytes(b) && bytesEq(toBytes(a), toBytes(b));
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEq(a[k], b[k])) return false;
  }
  return true;
}

function isBytes(v) {
  return v instanceof ArrayBuffer || ArrayBuffer.isView(v);
}

function toBytes(v) {
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function bytesEq(a, b) {
  return Buffer.from(a).equals(Buffer.from(b));
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(pred, timeoutMs = 4000) {
  const t0 = Date.now();
  for (;;) {
    let hit = false;
    try {
      hit = !!pred();
    } catch (err) {
      hit = false;
    }
    if (hit) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await tick(2);
  }
}

const enc = new TextEncoder();

/* -------------------------------------------------------------- mock DOM */

const ID_TABLE = {
  'dropzone': { tag: 'div' },
  'file-input': { tag: 'input' },
  'status-line': { tag: 'p' },
  'progress-output': { tag: 'pre' },
  'btn-open-archive': { tag: 'button', hiddenFromHtml: true },
  'archive-panel': { tag: 'section' },
  'archive-name': { tag: 'span' },
  'entry-select-all': { tag: 'input' },
  'entries-body': { tag: 'tbody' },
  'btn-extract-all': { tag: 'button' },
  'btn-extract-selected': { tag: 'button' },
  'btn-extract-folder': { tag: 'button', hiddenFromHtml: true },
  'btn-extract-selected-folder': { tag: 'button', hiddenFromHtml: true },
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
    hidden: !!init.hidden,
    value: init.value === undefined ? '' : init.value,
    files: [],
    type: '',
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
    fetchCalls: []
  };

  for (const [id, initial] of Object.entries(ID_TABLE)) {
    world.byId[id] = makeElement(world, initial.tag, id, initial);
  }

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
        world.pickerCalls[key].push(options);
        return impl(options, world);
      };
    }
  }

  function WorkerStub(url) {
    this.url = String(url);
    this.onmessage = null;
    this.onerror = null;
    this.messages = []; // messages posted to THIS worker
    world.workers.push(this);
    const self = this;
    this.postMessage = function (msg, transfers) {
      const entry = { msg, transfers: transfers || [], worker: self };
      self.messages.push(entry);
      world.workerMessages.push(entry);
      if (msg && msg.type === 'init') {
        // Resolve the init handshake so the serialized queue keeps pumping.
        Promise.resolve().then(() => {
          if (self.onmessage) self.onmessage({ data: { id: msg.id, type: 'ready' } });
        });
      }
    };
    this.terminate = function () { world.terminated++; };
  }

  // Replies always target the LATEST worker: a restarted worker replaces the
  // previous one, and app.js only listens to the current one.
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
  world.waitForMsg = (pred, timeoutMs) => waitFor(() => world.workerMessages.some(pred), timeoutMs);

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
    setTimeout,
    clearTimeout,
    queueMicrotask
  };

  const ctx = vm.createContext(sandbox);
  world.ctx = ctx;
  world.sandbox = sandbox;
  world.windowStub = windowStub;
  world.load = () => {
    vm.runInContext(fs.readFileSync(APP_PATH, 'utf8'), ctx, { filename: APP_PATH });
    return world; // boot() ran synchronously (readyState !== 'loading')
  };
  world.status = () => world.byId['status-line'].textContent;
  world.isError = () => world.byId['status-line'].classList.contains('error');
  world.rows = () => world.byId['entries-body'].children;
  return world;
}

/* ------------------------------------------------- fake directory handles */

function makeFakeDir() {
  const log = { mkdirs: [], getFiles: [], writes: [], closes: [], order: [] };
  const join = (a, b) => (a ? a + '/' + b : b);
  function dirHandle(dirPath) {
    return {
      kind: 'directory',
      name: dirPath.split('/').pop() || '',
      path: dirPath,
      async getDirectoryHandle(name, options) {
        log.mkdirs.push({ at: dirPath, name, create: !!(options && options.create) });
        log.order.push('mkdir:' + join(dirPath, name));
        return dirHandle(join(dirPath, name));
      },
      async getFileHandle(name, options) {
        const full = join(dirPath, name);
        log.getFiles.push({ at: dirPath, name, create: !!(options && options.create) });
        log.order.push('getFile:' + full);
        return {
          kind: 'file',
          name,
          async createWritable() {
            log.order.push('createWritable:' + full);
            return {
              async write(blob) {
                log.writes.push({ path: full, bytes: new Uint8Array(await blob.arrayBuffer()) });
                log.order.push('write:' + full);
              },
              async close() {
                log.closes.push(full);
                log.order.push('close:' + full);
              }
            };
          }
        };
      }
    };
  }
  return { handle: dirHandle(''), log };
}

/* --------------------------------------------------------- flow shortcuts */

// A file-like object app.js can open: only {name, arrayBuffer()} are used.
// Reads after the first can be delayed, which makes the unknown-key recovery's
// re-read window observable (and therefore deterministically testable).
// Every resolved buffer is recorded so tests can assert BUFFER IDENTITY (the
// posted list bytes must be the very buffer the read resolved with — no copy).
// opts.failReadFrom: 1-based read number from which arrayBuffer() rejects.
function makeFakeFile(name, bytes, opts = {}) {
  let reads = 0;
  const buffers = [];
  return {
    name,
    size: bytes.byteLength,
    arrayBuffer() {
      reads += 1;
      if (opts.failReadFrom && reads >= opts.failReadFrom) {
        return Promise.reject(new Error(opts.failMessage || 'disk read failed'));
      }
      const fresh = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      buffers.push(fresh);
      if (reads === 1 || !opts.delayMs) return Promise.resolve(fresh);
      return new Promise((resolve) => setTimeout(() => resolve(fresh), opts.delayMs));
    },
    reads: () => reads,
    buffers: () => buffers
  };
}

function openViaInput(world, file) {
  world.byId['file-input'].files = [file];
  world.fire(world.byId['file-input'], 'change');
}

async function openArchive(world, name, bytes, entries) {
  const file = new File([bytes], name, { type: 'application/x-7z-compressed' });
  openViaInput(world, file);
  const okList = await waitFor(() => world.workerMessages.some(
    (m) => m.msg.type === 'list' && m.msg.archive && m.msg.archive.name === name
  ));
  if (!okList) return null;
  const listEntry = world.lastEntryOfType('list');
  if (entries) {
    world.reply({ id: listEntry.msg.id, type: 'list-result', entries });
    await waitFor(() => world.status().includes('entries listed'));
  }
  return listEntry;
}

// One folder + two files, deliberately NOT in sorted order so the request's
// sorted-paths contract stays observable.
const SEL_ENTRIES = [
  { path: 'docs', size: 0, modified: '2026-01-01 00:00', method: '', isFolder: true, encrypted: false },
  { path: 'b.txt', size: 3, modified: '2026-01-02 03:04', method: 'LZMA2', isFolder: false, encrypted: false },
  { path: 'a.txt', size: 5, modified: '2026-01-02 03:05', method: 'LZMA2', isFolder: false, encrypted: false }
];

function rowBox(world, rowIndex) {
  const tr = world.rows()[rowIndex];
  return tr && tr.children[0] && tr.children[0].children[0];
}
function toggle(world, box, on) {
  box.checked = on;
  world.fire(box, 'change');
}

/* ============================== (S1) list = the only byte carrier ========= */

section('(S1) opening list: bytes TRANSFERRED (never copied) + archiveKey');

{
  const world = createAppWorld().load();
  const ARC = enc.encode('stage-cache-archive-bytes');
  const listEntry = await openArchive(world, 'big.7z', ARC, SEL_ENTRIES);

  check('(S1) the list request reached the worker with the archive bytes',
    !!listEntry && listEntry.msg.archive && listEntry.msg.archive.name === 'big.7z' &&
    bytesEq(new Uint8Array(listEntry.msg.archive.data), ARC),
    JSON.stringify(listEntry && Object.keys(listEntry.msg)));
  check('(S1) the list request carries a non-empty string archiveKey',
    !!listEntry && typeof listEntry.msg.archiveKey === 'string' && listEntry.msg.archiveKey.length > 0,
    JSON.stringify(listEntry && listEntry.msg.archiveKey));
  check('(S1) the ORIGINAL buffer is in the transfer list — no slice copy on the hot path',
    !!listEntry && listEntry.transfers.length === 1 &&
    listEntry.transfers[0] === listEntry.msg.archive.data,
    JSON.stringify(listEntry && { transfers: listEntry.transfers.length, same: listEntry.transfers[0] === listEntry.msg.archive.data }));
  check('(S1) the request never uses the reserved "files" field',
    !!listEntry && listEntry.msg.files === undefined);
  check('(S1) exactly one worker request was sent for the open (init + list)',
    deepEq(world.workerMessages.map((m) => m.msg.type), ['init', 'list']),
    JSON.stringify(world.workerMessages.map((m) => m.msg.type)));
  check('(S1) the listing rendered and the status reports all entries',
    world.status() === '"big.7z": 3 entries listed' && world.rows().length === 3,
    'status=' + JSON.stringify(world.status()) + ' rows=' + world.rows().length);
}

/* ==================== (S2) all five ops are keyed, byte-free ============== */

section('(S2) extract-all / test / extract-to-folder / extract-selected / selected-to-folder');

{
  const fakeDir = makeFakeDir();
  const world = createAppWorld({ pickers: { dir: () => Promise.resolve(fakeDir.handle) } }).load();
  const ARC = enc.encode('five-ops-archive');
  const listEntry = await openArchive(world, 'test.7z', ARC, SEL_ENTRIES);
  const KEY = listEntry.msg.archiveKey;
  check('(S2) archive opened and staged under a key', !!KEY, JSON.stringify(KEY));

  // (a) extract all
  const downloadsBefore = world.byId['downloads'].children.length;
  world.click(world.byId['btn-extract-all']);
  check('(S2a) extract-all: status is the pinned "Extracting "test.7z"…"',
    world.status() === 'Extracting "test.7z"…', JSON.stringify(world.status()));
  const okA = await waitFor(() => world.msgOfType('extract').length >= 1);
  const msgA = world.lastMsgOfType('extract');
  check('(S2a) extract-all sends archiveKey, no bytes, no files field',
    okA && msgA.archiveKey === KEY && msgA.archive === undefined && msgA.files === undefined &&
    msgA.paths === undefined && msgA.password === undefined,
    JSON.stringify(msgA && { key: msgA.archiveKey, archive: msgA.archive, files: msgA.files }));
  check('(S2a) extract-all carries NO transferable payload',
    world.lastEntryOfType('extract').transfers.length === 0,
    JSON.stringify(world.lastEntryOfType('extract').transfers.length));
  world.reply({ id: msgA.id, type: 'extract-result', files: [{ path: 'a.txt', data: new Uint8Array([1, 2, 3]) }] });
  check('(S2a) extract-all success status is pinned',
    await waitFor(() => world.status() === 'Extracted 1 file from "test.7z"') &&
    world.byId['downloads'].children.length === downloadsBefore + 1,
    'status=' + JSON.stringify(world.status()));

  // (b) test
  world.click(world.byId['btn-test-archive']);
  check('(S2b) test: status is the pinned "Testing "test.7z"…"',
    world.status() === 'Testing "test.7z"…', JSON.stringify(world.status()));
  const okT = await waitFor(() => world.msgOfType('test').length >= 1);
  const msgT = world.lastMsgOfType('test');
  check('(S2b) test sends archiveKey, no bytes, no files field',
    okT && msgT.archiveKey === KEY && msgT.archive === undefined && msgT.files === undefined,
    JSON.stringify(msgT && { key: msgT.archiveKey, archive: msgT.archive }));
  check('(S2b) the test request carries no transferable payload',
    world.lastEntryOfType('test').transfers.length === 0);
  world.reply({ id: msgT.id, type: 'test-result', ok: true, raw: 'Everything is Ok' });
  check('(S2b) test success status is pinned',
    await waitFor(() => world.status() === '"test.7z": test passed — archive is OK'),
    'status=' + JSON.stringify(world.status()));

  // (c) extract to folder
  world.click(world.byId['btn-extract-folder']);
  check('(S2c) showDirectoryPicker is still called SYNCHRONOUSLY in the click handler',
    world.pickerCalls.dir.length === 1 &&
    deepEq(world.pickerCalls.dir[0], { mode: 'readwrite', id: '7zip-extract', startIn: 'downloads' }),
    JSON.stringify(world.pickerCalls.dir[0]));
  const okC = await waitFor(() => world.msgOfType('extract').length >= 2);
  const msgC = world.lastMsgOfType('extract');
  check('(S2c) extract-to-folder sends archiveKey, no bytes, no files field',
    okC && msgC.archiveKey === KEY && msgC.archive === undefined && msgC.files === undefined &&
    msgC.paths === undefined,
    JSON.stringify(msgC && { key: msgC.archiveKey, paths: msgC.paths }));
  check('(S2c) extract-to-folder status is the pinned "to folder" variant',
    world.status() === 'Extracting "test.7z" to folder…', JSON.stringify(world.status()));
  world.reply({
    id: msgC.id,
    type: 'extract-result',
    files: [{ path: 'a.txt', data: new Uint8Array([1]) }, { path: 'b.txt', data: new Uint8Array([2]) }]
  });
  check('(S2c) extract-to-folder success status is pinned and wrote 2 files',
    await waitFor(() => world.status() === 'Extracted 2 file(s) to the chosen folder') &&
    fakeDir.log.writes.length === 2,
    'status=' + JSON.stringify(world.status()) + ' writes=' + fakeDir.log.writes.length);

  // (d) extract selected (downloads)
  toggle(world, rowBox(world, 1), true); // b.txt
  toggle(world, rowBox(world, 2), true); // a.txt
  check('(S2d) the selection counts up on both pinned labels',
    world.byId['btn-extract-selected'].textContent === 'Extract selected (2)' &&
    world.byId['btn-extract-selected-folder'].textContent === 'Selected to folder… (2)',
    JSON.stringify(world.byId['btn-extract-selected'].textContent));
  world.click(world.byId['btn-extract-selected']);
  check('(S2d) extract-selected click status is pinned',
    world.status() === 'Extracting 2 selected entries from "test.7z"…', JSON.stringify(world.status()));
  const okD = await waitFor(() => world.msgOfType('extract').length >= 3);
  const msgD = world.lastMsgOfType('extract');
  check('(S2d) extract-selected sends SORTED paths + archiveKey, no bytes, never "files"',
    okD && deepEq(msgD.paths, ['a.txt', 'b.txt']) && msgD.archiveKey === KEY &&
    msgD.archive === undefined && msgD.files === undefined,
    JSON.stringify(msgD && { paths: msgD.paths, key: msgD.archiveKey, hasArchive: msgD.archive !== undefined }));
  check('(S2d) the extract-selected request carries no transferable payload',
    world.lastEntryOfType('extract').transfers.length === 0);
  world.reply({
    id: msgD.id,
    type: 'extract-result',
    files: [{ path: 'a.txt', data: new Uint8Array([7]) }, { path: 'b.txt', data: new Uint8Array([8]) }]
  });
  check('(S2d) extract-selected success status is pinned',
    await waitFor(() => world.status() === 'Extracted 2 file(s) from "test.7z"'),
    'status=' + JSON.stringify(world.status()));

  // (e) selected to folder
  world.click(world.byId['btn-extract-selected-folder']);
  check('(S2e) the selected-folder picker is called synchronously with its own id',
    world.pickerCalls.dir.length === 2 &&
    deepEq(world.pickerCalls.dir[1], { mode: 'readwrite', id: '7zip-extract-selected', startIn: 'downloads' }),
    JSON.stringify(world.pickerCalls.dir[1]));
  const okE = await waitFor(() => world.msgOfType('extract').length >= 4);
  const msgE = world.lastMsgOfType('extract');
  check('(S2e) selected-to-folder sends SORTED paths + archiveKey, no bytes',
    okE && deepEq(msgE.paths, ['a.txt', 'b.txt']) && msgE.archiveKey === KEY &&
    msgE.archive === undefined && msgE.files === undefined,
    JSON.stringify(msgE && { paths: msgE.paths, key: msgE.archiveKey }));
  check('(S2e) selected-to-folder status is the pinned variant',
    world.status() === 'Extracting 2 selected entries from "test.7z" to folder…',
    JSON.stringify(world.status()));
  world.reply({
    id: msgE.id,
    type: 'extract-result',
    files: [{ path: 'a.txt', data: new Uint8Array([7]) }, { path: 'b.txt', data: new Uint8Array([8]) }]
  });
  check('(S2e) selected-to-folder success status is pinned',
    await waitFor(() => world.status() === 'Extracted 2 file(s) to the chosen folder') &&
    fakeDir.log.writes.length === 4,
    'status=' + JSON.stringify(world.status()) + ' writes=' + fakeDir.log.writes.length);

  check('(S2) the whole five-op session sent exactly ONE byte-carrying request',
    world.workerMessages.filter((m) => m.msg.archive && m.msg.archive.data).length === 1 &&
    deepEq(world.workerMessages.map((m) => m.msg.type),
      ['init', 'list', 'extract', 'test', 'extract', 'extract', 'extract']),
    JSON.stringify(world.workerMessages.map((m) => m.msg.type)));
}

/* ============================ (S3) second open -> new key ================= */

section('(S3) a second open stages under a different key');

{
  const world = createAppWorld().load();
  const first = await openArchive(world, 'a.7z', enc.encode('first-archive'), SEL_ENTRIES);
  const second = await openArchive(world, 'b.7z', enc.encode('second-archive'), SEL_ENTRIES);
  check('(S3) both opens listed', !!first && !!second);
  check('(S3) the second open uses a DIFFERENT non-empty archiveKey',
    !!first && !!second && typeof second.msg.archiveKey === 'string' &&
    second.msg.archiveKey.length > 0 && second.msg.archiveKey !== first.msg.archiveKey,
    JSON.stringify([first && first.msg.archiveKey, second && second.msg.archiveKey]));
  check('(S3) both list requests carried their own bytes',
    bytesEq(new Uint8Array(first.msg.archive.data), enc.encode('first-archive')) &&
    bytesEq(new Uint8Array(second.msg.archive.data), enc.encode('second-archive')));
  check('(S3) the table now shows the newer archive',
    world.byId['archive-name'].textContent === 'b.7z' && world.status() === '"b.7z": 3 entries listed',
    'status=' + JSON.stringify(world.status()));

  // Operations after the swap must use the NEWER key.
  world.click(world.byId['btn-extract-all']);
  const okExt = await waitFor(() => world.msgOfType('extract').length >= 1);
  check('(S3) extract-all after the swap references the newer key',
    okExt && world.lastMsgOfType('extract').archiveKey === second.msg.archiveKey &&
    world.lastMsgOfType('extract').archive === undefined,
    JSON.stringify(world.lastMsgOfType('extract') && world.lastMsgOfType('extract').archiveKey));
}

/* ================================ (S4) unknown-key recovery =============== */

section('(S4) unknown archiveKey: silent re-read + re-stage + ONE retry');

{
  const world = createAppWorld().load();
  const ARC = enc.encode('recovery-archive-bytes');
  const listEntry = await openArchive(world, 'test.7z', ARC, SEL_ENTRIES);
  const KEY = listEntry.msg.archiveKey;
  toggle(world, rowBox(world, 1), true); // b.txt
  toggle(world, rowBox(world, 2), true); // a.txt
  const rowsBefore = world.rows().slice();

  world.click(world.byId['btn-extract-selected']);
  const okExt = await waitFor(() => world.msgOfType('extract').length >= 1);
  const first = world.lastMsgOfType('extract');
  check('(S4) the first extract is keyed', okExt && first.archiveKey === KEY && first.archive === undefined);

  const extractingStatus = world.status();
  world.reply({ id: first.id, type: 'error', message: 'extract: unknown archiveKey' });

  // The re-stage list is the recovery's first visible effect.
  const okRestage = await waitFor(() => world.msgOfType('list').length >= 2);
  const restage = world.lastEntryOfType('list');
  check('(S4) recovery sent a re-stage LIST carrying the SAME archiveKey',
    okRestage && restage.msg.archiveKey === KEY && restage.msg.id !== listEntry.msg.id,
    JSON.stringify(restage && { key: restage.msg.archiveKey }));
  check('(S4) the re-stage list re-read the File: bytes equal the original archive',
    !!restage && restage.msg.archive && restage.msg.archive.name === 'test.7z' &&
    bytesEq(new Uint8Array(restage.msg.archive.data), ARC),
    JSON.stringify(restage && restage.msg.archive && Object.keys(restage.msg.archive)));
  check('(S4) the re-stage list transfers its buffer too',
    !!restage && restage.transfers.length === 1 && restage.transfers[0] === restage.msg.archive.data);
  check('(S4) recovery is SILENT: the status never showed the unknown-key error',
    world.status() === extractingStatus && !world.isError(),
    'status=' + JSON.stringify(world.status()) + ' expected=' + JSON.stringify(extractingStatus));
  check('(S4) recovery left the table and the selection untouched',
    world.rows().length === 3 && world.rows().every((tr, i) => tr === rowsBefore[i]) &&
    world.byId['btn-extract-selected'].textContent === 'Extract selected (2)',
    'rows=' + world.rows().length + ' label=' + JSON.stringify(world.byId['btn-extract-selected'].textContent));

  // The re-stage reply's entries are IGNORED (no re-render).
  world.reply({ id: restage.msg.id, type: 'list-result', entries: [{ path: 'ignored.txt', size: 1, modified: '', method: '', isFolder: false, encrypted: false }] });
  const okRetry = await waitFor(() => world.msgOfType('extract').length >= 2);
  const retry = world.lastMsgOfType('extract');
  check('(S4) exactly ONE retry extract followed, with an identical payload',
    okRetry && retry.archiveKey === KEY && retry.archive === undefined && retry.files === undefined &&
    deepEq(retry.paths, ['a.txt', 'b.txt']) && retry.password === undefined &&
    retry.id !== first.id,
    JSON.stringify(retry && { key: retry.archiveKey, paths: retry.paths }));
  check('(S4) the ignored listing did NOT re-render the table',
    world.rows().length === 3 && world.rows().every((tr, i) => tr === rowsBefore[i]) &&
    world.status() === extractingStatus,
    'rows=' + world.rows().length + ' status=' + JSON.stringify(world.status()));

  world.reply({
    id: retry.id,
    type: 'extract-result',
    files: [{ path: 'a.txt', data: new Uint8Array([1, 2]) }, { path: 'b.txt', data: new Uint8Array([3]) }]
  });
  check('(S4) the retry ends in the pinned success status + downloads',
    await waitFor(() => world.status() === 'Extracted 2 file(s) from "test.7z"') && !world.isError() &&
    world.byId['downloads'].children.length === 2,
    'status=' + JSON.stringify(world.status()) + ' downloads=' + world.byId['downloads'].children.length);
  check('(S4) the whole recovery cost exactly one extra list and one extra extract',
    deepEq(world.workerMessages.map((m) => m.msg.type), ['init', 'list', 'extract', 'list', 'extract']),
    JSON.stringify(world.workerMessages.map((m) => m.msg.type)));
  check('(S4) recovery produced no console errors', world.errors.length === 0, JSON.stringify(world.errors));
}

/* ================================== (S5) retry exactly once =============== */

section('(S5) the retry is the last attempt: a second unknown-key surfaces');

{
  const world = createAppWorld().load();
  const ARC = enc.encode('retry-once-bytes');
  const listEntry = await openArchive(world, 'test.7z', ARC, SEL_ENTRIES);
  const KEY = listEntry.msg.archiveKey;
  toggle(world, rowBox(world, 2), true); // a.txt
  world.click(world.byId['btn-extract-selected']);
  await waitFor(() => world.msgOfType('extract').length >= 1);
  const first = world.lastMsgOfType('extract');
  world.reply({ id: first.id, type: 'error', message: 'extract: unknown archiveKey' });
  await waitFor(() => world.msgOfType('list').length >= 2);
  world.reply({ id: world.lastMsgOfType('list').id, type: 'list-result', entries: SEL_ENTRIES });
  const okRetry = await waitFor(() => world.msgOfType('extract').length >= 2);
  const retry = world.lastMsgOfType('extract');
  check('(S5) one retry was attempted', okRetry && retry.archiveKey === KEY);

  world.reply({ id: retry.id, type: 'error', message: 'extract: unknown archiveKey' });
  check('(S5) the retry failure surfaces the exact worker error',
    await waitFor(() => world.status() === 'extract: unknown archiveKey') && world.isError(),
    'status=' + JSON.stringify(world.status()));
  await tick(60);
  check('(S5) NO third extract and NO second re-stage were ever sent',
    world.msgOfType('extract').length === 2 && world.msgOfType('list').length === 2,
    JSON.stringify(world.workerMessages.map((m) => m.msg.type)));
}

/* ============================ (S6) Clear mid-recovery ===================== */

section('(S6) Clear during recovery abandons it silently');

{
  const world = createAppWorld().load();
  const listEntry = await openArchive(world, 'test.7z', enc.encode('clear-mid-recovery'), SEL_ENTRIES);
  const KEY = listEntry.msg.archiveKey;
  toggle(world, rowBox(world, 1), true);
  world.click(world.byId['btn-extract-selected']);
  await waitFor(() => world.msgOfType('extract').length >= 1);
  const first = world.lastMsgOfType('extract');

  world.reply({ id: first.id, type: 'error', message: 'extract: unknown archiveKey' });
  // Clear BEFORE the recovery's re-read resolves: the generation bump must
  // abort the chain before it queues anything.
  world.click(world.byId['btn-clear']);
  const clearedStatus = world.status();
  await tick(120);

  check('(S6) no re-stage list carrying the cleared key was ever sent',
    world.msgOfType('list').length === 1 && world.msgOfType('list')[0].msg.archiveKey === KEY,
    JSON.stringify(world.workerMessages.map((m) => m.msg.type + (m.msg.archiveKey ? ':' + m.msg.archiveKey : ''))));
  check('(S6) no retry extract was sent', world.msgOfType('extract').length === 1);
  check('(S6) the status stays at the cleared baseline (no error, no "Extracting…")',
    world.status() === clearedStatus && !world.isError(),
    'status=' + JSON.stringify(world.status()) + ' isError=' + world.isError());
  check('(S6) Clear still posted its fire-and-forget evict',
    world.msgOfType('evict').length === 1 && world.msgOfType('evict')[0].msg.id === undefined,
    JSON.stringify(world.workerMessages.map((m) => m.msg.type)));
  check('(S6) no console errors from the abandoned chain', world.errors.length === 0, JSON.stringify(world.errors));
}

/* ====================== (S7) superseded open mid-recovery ================= */

section('(S7) a newer open wins: the stale recovery never re-stages its key');

{
  const world = createAppWorld().load();
  const ARC_A = enc.encode('archive-A-bytes');
  // A's SECOND read (the recovery re-read) is delayed, so archive B can take
  // over while A's recovery is between its guards — the deterministic version
  // of "the user opened something else meanwhile".
  const fileA = makeFakeFile('a.7z', ARC_A, { delayMs: 80 });
  openViaInput(world, fileA);
  await waitFor(() => world.msgOfType('list').length >= 1);
  const listA = world.lastMsgOfType('list');
  const KEY_A = listA.archiveKey;
  world.reply({ id: listA.id, type: 'list-result', entries: SEL_ENTRIES });
  await waitFor(() => world.status() === '"a.7z": 3 entries listed');

  toggle(world, rowBox(world, 1), true); // b.txt
  world.click(world.byId['btn-extract-selected']);
  await waitFor(() => world.msgOfType('extract').length >= 1);
  const extractA = world.lastMsgOfType('extract');
  check('(S7) archive A extracted under its own key', extractA.archiveKey === KEY_A);

  world.reply({ id: extractA.id, type: 'error', message: 'extract: unknown archiveKey' });
  // Immediately open B; its own (fast) read swaps currentArchive while A's
  // recovery is still waiting on the delayed re-read.
  const listB = await openArchive(world, 'b.7z', enc.encode('archive-B-bytes'), SEL_ENTRIES);
  check('(S7) archive B opened and listed under a DIFFERENT key',
    !!listB && listB.msg.archiveKey !== KEY_A, JSON.stringify(listB && listB.msg.archiveKey));
  await tick(200); // let A's delayed re-read resolve and its guards run

  check('(S7) NO re-stage list carrying A\'s key was ever sent',
    world.msgOfType('list').filter((m) => m.msg.archiveKey === KEY_A).length === 1,
    JSON.stringify(world.msgOfType('list').map((m) => m.msg.archiveKey)));
  check('(S7) A\'s chain sent no retry extract either',
    world.msgOfType('extract').length === 1 && world.msgOfType('extract')[0].msg.archiveKey === KEY_A,
    JSON.stringify(world.msgOfType('extract').map((m) => m.msg.archiveKey)));
  check('(S7) A\'s stale error never reached the status line',
    world.status() === '"b.7z": 3 entries listed' && !world.isError(),
    'status=' + JSON.stringify(world.status()));
  check('(S7) the delayed re-read of A really happened (the guard, not the read, stopped it)',
    fileA.reads() === 2, 'reads=' + fileA.reads());

  // B is fully functional under its own key.
  world.click(world.byId['btn-extract-all']);
  const okB = await waitFor(() => world.msgOfType('extract').length >= 2);
  check('(S7) B\'s own extract is keyed with B\'s key',
    okB && world.lastMsgOfType('extract').archiveKey === listB.msg.archiveKey,
    JSON.stringify(world.lastMsgOfType('extract') && world.lastMsgOfType('extract').archiveKey));
  check('(S7) no console errors', world.errors.length === 0, JSON.stringify(world.errors));
}

/* ============================ (S8) worker restart ========================= */

section('(S8) worker restart: keyed request to the new worker, recovery there');

{
  const world = createAppWorld().load();
  const ARC = enc.encode('restart-archive-bytes');
  const listEntry = await openArchive(world, 'test.7z', ARC, SEL_ENTRIES);
  const KEY = listEntry.msg.archiveKey;
  toggle(world, rowBox(world, 2), true); // a.txt

  // Simulate a worker crash: failEverything terminates it and the next
  // operation spins up a fresh Worker whose MEMFS (and therefore the staged
  // archive) is empty.
  world.workers[0].onerror({ message: 'boom' });
  check('(S8) the crashed worker was terminated and the error surfaced',
    world.terminated === 1 && world.isError() && world.status().includes('Worker error: boom'),
    'status=' + JSON.stringify(world.status()));

  world.click(world.byId['btn-extract-selected']);
  const okNew = await waitFor(() => world.workers.length === 2 &&
    world.workers[1].messages.some((m) => m.msg.type === 'extract'));
  check('(S8) a fresh worker was created and got the keyed extract with the OLD key', okNew,
    JSON.stringify({ workers: world.workers.length, types: world.workerMessages.map((m) => m.msg.type) }));
  check('(S8) the new worker was initialised before the extract',
    deepEq(world.workers[1].messages.map((m) => m.msg.type), ['init', 'extract']),
    JSON.stringify(world.workers[1].messages.map((m) => m.msg.type)));
  const extract2 = world.workers[1].messages.find((m) => m.msg.type === 'extract').msg;
  check('(S8) the restarted extract carries no bytes', extract2.archive === undefined &&
    extract2.archiveKey === KEY && deepEq(extract2.paths, ['a.txt']));

  // The fresh worker has no staged archive -> unknown key -> recovery.
  world.reply({ id: extract2.id, type: 'error', message: 'extract: unknown archiveKey' });
  const okRestage = await waitFor(() => world.workers[1].messages.some((m) => m.msg.type === 'list'));
  const restage = world.workers[1].messages.find((m) => m.msg.type === 'list');
  check('(S8) recovery re-staged on the NEW worker under the same key',
    okRestage && restage.msg.archiveKey === KEY &&
    bytesEq(new Uint8Array(restage.msg.archive.data), ARC),
    JSON.stringify(restage && restage.msg.archiveKey));
  world.reply({ id: restage.msg.id, type: 'list-result', entries: SEL_ENTRIES });
  const okRetry = await waitFor(() => world.workers[1].messages.filter((m) => m.msg.type === 'extract').length >= 2);
  const retry = world.workers[1].messages.filter((m) => m.msg.type === 'extract')[1].msg;
  check('(S8) the retry went to the new worker with an identical payload',
    okRetry && retry.archiveKey === KEY && deepEq(retry.paths, ['a.txt']),
    JSON.stringify(retry && { key: retry.archiveKey, paths: retry.paths }));
  world.reply({ id: retry.id, type: 'extract-result', files: [{ path: 'a.txt', data: new Uint8Array([9, 9]) }] });
  check('(S8) the recovered extraction ends in the pinned success status',
    await waitFor(() => world.status() === 'Extracted 1 file(s) from "test.7z"') && !world.isError(),
    'status=' + JSON.stringify(world.status()));
  check('(S8) nothing was ever sent to the terminated worker again',
    deepEq(world.workers[0].messages.map((m) => m.msg.type), ['init', 'list']),
    JSON.stringify(world.workers[0].messages.map((m) => m.msg.type)));
}

/* ================================== (S9) evict on Clear =================== */

section('(S9) Clear posts one fire-and-forget evict');

{
  const world = createAppWorld().load();
  await openArchive(world, 'test.7z', enc.encode('evict-me'), SEL_ENTRIES);
  const before = world.workerMessages.length;
  world.click(world.byId['btn-clear']);

  const evicts = world.msgOfType('evict');
  check('(S9) exactly one extra worker message: {type:"evict"}',
    world.workerMessages.length === before + 1 && evicts.length === 1,
    JSON.stringify(world.workerMessages.slice(before).map((m) => m.msg)));
  check('(S9) the evict carries NO id and NO payload',
    evicts.length === 1 && evicts[0].msg.id === undefined &&
    deepEq(Object.keys(evicts[0].msg), ['type']) && evicts[0].transfers.length === 0,
    JSON.stringify(evicts[0] && evicts[0].msg));
  check('(S9) the evict is the LAST message Clear posted',
    world.workerMessages[world.workerMessages.length - 1].msg.type === 'evict',
    JSON.stringify(world.workerMessages.map((m) => m.msg.type)));
  check('(S9) Clear reset the UI as before',
    world.status() === '' && !world.isError() && world.byId['archive-panel'].hidden === true &&
    world.rows().length === 1 && world.rows()[0].children[0].colSpan === 5 &&
    world.rows()[0].children[0].textContent === '(no entries)',
    JSON.stringify({ status: world.status(), rows: world.rows().length }));

  // Nothing awaits a reply: the app stays usable, and a new open works.
  await tick(60);
  check('(S9) no reply was needed — no errors, no stuck state',
    world.errors.length === 0 && !world.isError(), JSON.stringify(world.errors));
  const reopened = await openArchive(world, 'again.7z', enc.encode('again'), SEL_ENTRIES);
  check('(S9) a fresh open after Clear stages under a NEW key',
    !!reopened && typeof reopened.msg.archiveKey === 'string' && reopened.msg.archiveKey.length > 0 &&
    world.status() === '"again.7z": 3 entries listed',
    'status=' + JSON.stringify(world.status()));
  check('(S9) Clear without an archive still evicts (idempotent, fire-and-forget)',
    (world.click(world.byId['btn-clear']), world.msgOfType('evict').length === 2),
    'evicts=' + world.msgOfType('evict').length);
}

/* ========================= (S10) key survives a password change =========== */

section('(S10) the staged key survives a password change');

{
  const world = createAppWorld().load();
  world.byId['password-input'].value = 'P1';
  const ARC = enc.encode('passworded-archive');
  const listEntry = await openArchive(world, 'secret.7z', ARC, SEL_ENTRIES);
  const KEY = listEntry.msg.archiveKey;
  check('(S10) the staging list carried the typed password',
    listEntry.msg.password === 'P1', JSON.stringify(listEntry.msg.password));

  world.byId['password-input'].value = 'P2';
  toggle(world, rowBox(world, 2), true); // a.txt
  world.click(world.byId['btn-extract-selected']);
  const okExt = await waitFor(() => world.msgOfType('extract').length >= 1);
  const msg = world.lastMsgOfType('extract');
  check('(S10) the extract reuses the SAME archiveKey with the NEW password',
    okExt && msg.archiveKey === KEY && msg.password === 'P2' && msg.archive === undefined &&
    deepEq(msg.paths, ['a.txt']),
    JSON.stringify(msg && { key: msg.archiveKey, password: msg.password, paths: msg.paths }));

  // The queue is strictly sequential: settle the first extract before a second
  // click can dispatch anything.
  world.reply({ id: msg.id, type: 'extract-result', files: [{ path: 'a.txt', data: new Uint8Array([3]) }] });
  check('(S10) the keyed extract completed under the new password',
    await waitFor(() => world.status() === 'Extracted 1 file(s) from "secret.7z"') &&
    world.byId['downloads'].children.length === 1,
    'status=' + JSON.stringify(world.status()));

  // An empty password field means "no password" (undefined), still keyed.
  world.byId['password-input'].value = '';
  world.click(world.byId['btn-extract-selected']);
  const okExt2 = await waitFor(() => world.msgOfType('extract').length >= 2);
  const msg2 = world.lastMsgOfType('extract');
  check('(S10) clearing the password sends undefined, not an empty string',
    okExt2 && msg2.archiveKey === KEY && msg2.password === undefined &&
    deepEq(msg2.paths, ['a.txt']) && msg2.archive === undefined,
    JSON.stringify(msg2 && { key: msg2.archiveKey, password: msg2.password }));
  world.reply({ id: msg2.id, type: 'extract-result', files: [{ path: 'a.txt', data: new Uint8Array([4]) }] });
  check('(S10) the keyed flow still completes after the password churn',
    await waitFor(() => world.status() === 'Extracted 1 file(s) from "secret.7z"') &&
    world.byId['downloads'].children.length === 2 &&
    deepEq(world.workerMessages.map((m) => m.msg.type), ['init', 'list', 'extract', 'extract']),
    'status=' + JSON.stringify(world.status()) + ' types=' + JSON.stringify(world.workerMessages.map((m) => m.msg.type)));
}

/* =========== (S11) unknown-key recovery of the TEST operation ============ */

section('(S11) test: unknown archiveKey recovers silently and retries once');

{
  const world = createAppWorld().load();
  const ARC = enc.encode('test-op-recovery-bytes');
  const listEntry = await openArchive(world, 'test.7z', ARC, SEL_ENTRIES);
  const KEY = listEntry.msg.archiveKey;

  world.click(world.byId['btn-test-archive']);
  check('(S11) test click status is the pinned "Testing "test.7z"…"',
    world.status() === 'Testing "test.7z"…', JSON.stringify(world.status()));
  const okT = await waitFor(() => world.msgOfType('test').length >= 1);
  const first = world.lastMsgOfType('test');
  check('(S11) the first test request is keyed and byte-free',
    okT && first.archiveKey === KEY && first.archive === undefined && first.files === undefined);

  world.reply({ id: first.id, type: 'error', message: 'test: unknown archiveKey' });
  const okRestage = await waitFor(() => world.msgOfType('list').length >= 2);
  const restage = world.lastEntryOfType('list');
  check('(S11) recovery re-staged under the SAME key with the original bytes',
    okRestage && restage.msg.archiveKey === KEY && restage.msg.archive &&
    restage.msg.archive.name === 'test.7z' &&
    bytesEq(new Uint8Array(restage.msg.archive.data), ARC),
    JSON.stringify(restage && restage.msg.archiveKey));
  check('(S11) recovery is SILENT: still the pinned "Testing" status, no error',
    world.status() === 'Testing "test.7z"…' && !world.isError(),
    'status=' + JSON.stringify(world.status()));
  world.reply({ id: restage.msg.id, type: 'list-result', entries: SEL_ENTRIES });
  const okRetry = await waitFor(() => world.msgOfType('test').length >= 2);
  const retry = world.lastMsgOfType('test');
  check('(S11) exactly ONE retry test followed, keyed with the same key',
    okRetry && retry.archiveKey === KEY && retry.archive === undefined &&
    retry.files === undefined && retry.id !== first.id,
    JSON.stringify(retry && { key: retry.archiveKey }));
  world.reply({ id: retry.id, type: 'test-result', ok: true, raw: 'Everything is Ok' });
  check('(S11) the recovered test ends in the pinned success status',
    await waitFor(() => world.status() === '"test.7z": test passed — archive is OK') && !world.isError(),
    'status=' + JSON.stringify(world.status()));
  check('(S11) the whole recovery cost exactly one extra list and one extra test',
    deepEq(world.workerMessages.map((m) => m.msg.type), ['init', 'list', 'test', 'list', 'test']),
    JSON.stringify(world.workerMessages.map((m) => m.msg.type)));
  check('(S11) no console errors', world.errors.length === 0, JSON.stringify(world.errors));
}

/* ============ (S12) folder flows: recovery + stale silence =============== */

section('(S12a) extract-to-folder: unknown-key recovery writes via the picker');

{
  const fakeDir = makeFakeDir();
  const world = createAppWorld({ pickers: { dir: () => Promise.resolve(fakeDir.handle) } }).load();
  const ARC = enc.encode('folder-recovery-bytes');
  const listEntry = await openArchive(world, 'test.7z', ARC, SEL_ENTRIES);
  const KEY = listEntry.msg.archiveKey;

  world.click(world.byId['btn-extract-folder']);
  const okExt = await waitFor(() => world.msgOfType('extract').length >= 1);
  const first = world.lastMsgOfType('extract');
  check('(S12a) the folder extract is keyed with no paths and no bytes',
    okExt && first.archiveKey === KEY && first.paths === undefined && first.archive === undefined,
    JSON.stringify(first && { key: first.archiveKey, paths: first.paths }));
  check('(S12a) the pinned folder status is on screen',
    world.status() === 'Extracting "test.7z" to folder…', JSON.stringify(world.status()));

  world.reply({ id: first.id, type: 'error', message: 'extract: unknown archiveKey' });
  const okRestage = await waitFor(() => world.msgOfType('list').length >= 2);
  check('(S12a) recovery re-staged under the SAME key',
    okRestage && world.lastMsgOfType('list').archiveKey === KEY,
    JSON.stringify(world.lastMsgOfType('list') && world.lastMsgOfType('list').archiveKey));
  check('(S12a) recovery is SILENT: the folder status never changed, no error',
    world.status() === 'Extracting "test.7z" to folder…' && !world.isError(),
    'status=' + JSON.stringify(world.status()));
  world.reply({ id: world.lastMsgOfType('list').id, type: 'list-result', entries: SEL_ENTRIES });
  const okRetry = await waitFor(() => world.msgOfType('extract').length >= 2);
  const retry = world.lastMsgOfType('extract');
  check('(S12a) exactly ONE retry extract followed, identical payload',
    okRetry && retry.archiveKey === KEY && retry.archive === undefined &&
    retry.paths === undefined && retry.id !== first.id,
    JSON.stringify(retry && { key: retry.archiveKey, paths: retry.paths }));
  world.reply({
    id: retry.id,
    type: 'extract-result',
    files: [{ path: 'a.txt', data: new Uint8Array([1]) }, { path: 'sub/b.txt', data: new Uint8Array([2, 2]) }]
  });
  check('(S12a) the recovered folder extract writes both files and reports the pinned status',
    await waitFor(() => world.status() === 'Extracted 2 file(s) to the chosen folder') &&
    fakeDir.log.writes.length === 2 && !world.isError(),
    'status=' + JSON.stringify(world.status()) + ' writes=' + fakeDir.log.writes.length);
  check('(S12a) message sequence: init, list, extract, re-stage list, retry extract',
    deepEq(world.workerMessages.map((m) => m.msg.type), ['init', 'list', 'extract', 'list', 'extract']),
    JSON.stringify(world.workerMessages.map((m) => m.msg.type)));
  check('(S12a) no console errors', world.errors.length === 0, JSON.stringify(world.errors));
}

section('(S12b) superseded open mid-folder-recovery: the stale chain stays silent');

{
  const fakeDir = makeFakeDir();
  const world = createAppWorld({ pickers: { dir: () => Promise.resolve(fakeDir.handle) } }).load();
  const ARC_A = enc.encode('folder-archive-A');
  // A's recovery re-read is delayed so B can take over between A's guards —
  // the folder flows capture `arc` when the picker resolves, and their shared
  // .catch must drop the stale error BEFORE its AbortError check.
  const fileA = makeFakeFile('a.7z', ARC_A, { delayMs: 80 });
  openViaInput(world, fileA);
  await waitFor(() => world.msgOfType('list').length >= 1);
  const listA = world.lastMsgOfType('list');
  const KEY_A = listA.archiveKey;
  world.reply({ id: listA.id, type: 'list-result', entries: SEL_ENTRIES });
  await waitFor(() => world.status() === '"a.7z": 3 entries listed');

  world.click(world.byId['btn-extract-folder']);
  await waitFor(() => world.msgOfType('extract').length >= 1);
  const extractA = world.lastMsgOfType('extract');
  check('(S12b) A\'s folder extract is keyed with A\'s key', extractA.archiveKey === KEY_A);

  world.reply({ id: extractA.id, type: 'error', message: 'extract: unknown archiveKey' });
  // Open B while A's recovery sits in the delayed File re-read.
  const listB = await openArchive(world, 'b.7z', enc.encode('folder-archive-B'), SEL_ENTRIES);
  check('(S12b) archive B took over with its own key',
    !!listB && listB.msg.archiveKey !== KEY_A, JSON.stringify(listB && listB.msg.archiveKey));
  await tick(200); // let A's delayed re-read resolve and its guards run

  check('(S12b) NO re-stage list carrying A\'s key was ever sent',
    world.msgOfType('list').filter((m) => m.msg.archiveKey === KEY_A).length === 1,
    JSON.stringify(world.msgOfType('list').map((m) => m.msg.archiveKey)));
  check('(S12b) NO retry extract was sent for A', world.msgOfType('extract').length === 1,
    JSON.stringify(world.msgOfType('extract').map((m) => m.msg.archiveKey)));
  check('(S12b) A\'s stale unknown-key error never reached the status line',
    world.status() === '"b.7z": 3 entries listed' && !world.isError(),
    'status=' + JSON.stringify(world.status()));
  check('(S12b) A\'s stale chain wrote nothing through the picker',
    fakeDir.log.writes.length === 0, JSON.stringify(fakeDir.log.writes.length));
  check('(S12b) the delayed re-read of A really happened (the guard stopped the chain)',
    fileA.reads() === 2, 'reads=' + fileA.reads());
  check('(S12b) no console errors', world.errors.length === 0, JSON.stringify(world.errors));
}

/* ============== (S13) password timing across a recovery ================== */

section('(S13) retry keeps the click-time password; the re-stage list takes the new one');

{
  const world = createAppWorld().load();
  const ARC = enc.encode('password-timing-bytes');
  world.byId['password-input'].value = 'P1';
  const listEntry = await openArchive(world, 'test.7z', ARC, SEL_ENTRIES);
  const KEY = listEntry.msg.archiveKey;
  toggle(world, rowBox(world, 2), true); // a.txt

  world.click(world.byId['btn-extract-selected']);
  await waitFor(() => world.msgOfType('extract').length >= 1);
  const first = world.lastMsgOfType('extract');
  check('(S13) the click-time extract carries the typed password P1',
    first.password === 'P1' && first.archiveKey === KEY && deepEq(first.paths, ['a.txt']),
    JSON.stringify(first && { password: first.password, key: first.archiveKey }));

  world.reply({ id: first.id, type: 'error', message: 'extract: unknown archiveKey' });
  // The user retypes the password while the recovery is starting — set it
  // synchronously here, so it is guaranteed to land before any recovery code
  // (promise callbacks run only after this task completes).
  world.byId['password-input'].value = 'P2';

  const okRestage = await waitFor(() => world.msgOfType('list').length >= 2);
  const restage = world.lastMsgOfType('list');
  check('(S13) the re-stage list carries the password typed IN THE MEANTIME (P2)',
    okRestage && restage.password === 'P2' && restage.archiveKey === KEY &&
    bytesEq(new Uint8Array(restage.archive.data), ARC),
    JSON.stringify(restage && { password: restage.password, key: restage.archiveKey }));
  world.reply({ id: restage.id, type: 'list-result', entries: SEL_ENTRIES });
  const okRetry = await waitFor(() => world.msgOfType('extract').length >= 2);
  const retry = world.lastMsgOfType('extract');
  check('(S13) the retry reuses the IDENTICAL click-time payload (password P1)',
    okRetry && retry.password === 'P1' && retry.archiveKey === KEY &&
    deepEq(retry.paths, ['a.txt']) && retry.id !== first.id,
    JSON.stringify(retry && { password: retry.password, paths: retry.paths }));
  world.reply({ id: retry.id, type: 'extract-result', files: [{ path: 'a.txt', data: new Uint8Array([5]) }] });
  check('(S13) the recovered extract completes with the pinned status',
    await waitFor(() => world.status() === 'Extracted 1 file(s) from "test.7z"') && !world.isError(),
    'status=' + JSON.stringify(world.status()));
  check('(S13) no console errors', world.errors.length === 0, JSON.stringify(world.errors));
}

/* ======== (S14) a failing File re-read surfaces like any other error ===== */

section('(S14) recovery re-read rejection propagates to the status line');

{
  const world = createAppWorld().load();
  const ARC = enc.encode('reread-fails-bytes');
  const file = makeFakeFile('test.7z', ARC, { failReadFrom: 2, failMessage: 'disk read failed' });
  openViaInput(world, file);
  await waitFor(() => world.msgOfType('list').length >= 1);
  const listEntry = world.lastMsgOfType('list');
  world.reply({ id: listEntry.id, type: 'list-result', entries: SEL_ENTRIES });
  await waitFor(() => world.status() === '"test.7z": 3 entries listed');

  toggle(world, rowBox(world, 2), true); // a.txt
  world.click(world.byId['btn-extract-selected']);
  await waitFor(() => world.msgOfType('extract').length >= 1);
  const first = world.lastMsgOfType('extract');
  world.reply({ id: first.id, type: 'error', message: 'extract: unknown archiveKey' });

  check('(S14) the failed re-read error is displayed like any other error',
    await waitFor(() => world.status() === 'disk read failed') && world.isError(),
    'status=' + JSON.stringify(world.status()));
  await tick(60);
  check('(S14) NO re-stage list and NO retry were sent',
    world.msgOfType('list').length === 1 && world.msgOfType('extract').length === 1,
    JSON.stringify(world.workerMessages.map((m) => m.msg.type)));
  check('(S14) the File was read exactly twice (open + failed recovery re-read)',
    file.reads() === 2, 'reads=' + file.reads());
  check('(S14) no console errors', world.errors.length === 0, JSON.stringify(world.errors));
}

/* ======== (S15) buffer identity: no copy between File and postMessage ==== */

section('(S15) the posted bytes ARE the buffer the File read resolved with');

{
  const world = createAppWorld().load();
  const ARC = enc.encode('buffer-identity-bytes');
  const file = makeFakeFile('test.7z', ARC);
  openViaInput(world, file);
  const okList = await waitFor(() => world.msgOfType('list').length >= 1);
  const listEntry = world.lastEntryOfType('list');
  check('(S15) the open list posts the VERY buffer arrayBuffer() resolved with',
    okList && file.buffers().length === 1 &&
    listEntry.msg.archive.data === file.buffers()[0] &&
    listEntry.transfers.length === 1 && listEntry.transfers[0] === file.buffers()[0],
    JSON.stringify({ buffers: file.buffers().length, same: listEntry.msg.archive.data === file.buffers()[0] }));
  world.reply({ id: listEntry.msg.id, type: 'list-result', entries: SEL_ENTRIES });
  await waitFor(() => world.status() === '"test.7z": 3 entries listed');

  toggle(world, rowBox(world, 2), true); // a.txt
  world.click(world.byId['btn-extract-selected']);
  await waitFor(() => world.msgOfType('extract').length >= 1);
  world.reply({ id: world.lastMsgOfType('extract').id, type: 'error', message: 'extract: unknown archiveKey' });
  const okRestage = await waitFor(() => world.msgOfType('list').length >= 2);
  const restage = world.lastEntryOfType('list');
  check('(S15) the recovery re-stage posts the VERY buffer of the SECOND read',
    okRestage && file.buffers().length === 2 &&
    restage.msg.archive.data === file.buffers()[1] &&
    file.buffers()[1] !== file.buffers()[0] &&
    restage.transfers.length === 1 && restage.transfers[0] === file.buffers()[1],
    JSON.stringify({ buffers: file.buffers().length }));
  world.reply({ id: restage.msg.id, type: 'list-result', entries: SEL_ENTRIES });
  const okRetry = await waitFor(() => world.msgOfType('extract').length >= 2);
  check('(S15) the retry after the re-stage is keyed and byte-free',
    okRetry && world.lastMsgOfType('extract').archive === undefined &&
    world.lastMsgOfType('extract').archiveKey === listEntry.msg.archiveKey);
  world.reply({
    id: world.lastMsgOfType('extract').id,
    type: 'extract-result',
    files: [{ path: 'a.txt', data: new Uint8Array([1]) }]
  });
  check('(S15) the flow still ends in the pinned success status',
    await waitFor(() => world.status() === 'Extracted 1 file(s) from "test.7z"') && !world.isError(),
    'status=' + JSON.stringify(world.status()));
}

/* ---------------------------------------------------------------- summary */

console.log('');
console.log(`${passCount} passed, ${failCount} failed`);
if (failCount) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
}
console.log(failCount ? 'RESULT: FAIL' : 'ALL APP STAGE-CACHE TESTS PASSED');
process.exitCode = failCount ? 1 : 0;
