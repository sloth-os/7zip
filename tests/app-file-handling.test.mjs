#!/usr/bin/env node
/*
 * Mock-harness test for the 7-Zip WASM app: PWA file handling in app.js.
 *
 * Runs the REAL /home/ubuntu/software/7zip-web/app.js inside a vm context with
 * stubbed browser globals — document (getElementById / createElement /
 * fragments, classList, hidden, listeners), window (listeners, launchQueue,
 * File System Access pickers), navigator, Worker (captures postMessage,
 * auto-replies the init handshake, result replies on demand), a Map-based
 * caches stub, fetch, console and Node's real File/Blob/URL (with a stubbed
 * createObjectURL) — then drives the contract:
 *
 *   (1) feature gating: no picker globals -> buttons stay hidden, download
 *       rows carry no Save-as button; picker stubs -> boot() unhides both
 *   (2) launchQueue consumer: registered once; fake handles with getFile()
 *       reach the worker as a list request; raw Files work; failures surface
 *   (3) shared-cache pickup: __shared/0 + count are read, ALL keys deleted,
 *       a list request for x.zip is sent; re-boot with the empty cache sends
 *       nothing (no double ingest)
 *   (4) #btn-open-archive: picker called synchronously in the click handler;
 *       resolved handles -> list request; AbortError silent; other errors
 *       -> error status
 *   (5) #btn-extract-folder: extract-result paths are contained via
 *       safeExtractPath (".." pops, drive letters dropped, leading "/"
 *       dropped); exactly 5 files written through the fake directory handle;
 *       nothing added to downloads
 *   (6) Save as…: showSaveFilePicker options (suggestedName/id/startIn/
 *       types), createWritable -> write(bytes) -> close on the SAME writable,
 *       success status; AbortError silent; errors surface
 *   (7) generation: Clear mid-extract rejects the flow — zero writes to the
 *       directory handle and no status set after Clear
 *   (8) selective extraction: every row (folders included) carries a leading
 *       td.col-select checkbox; button labels/enablement and the select-all
 *       checked/indeterminate states derive from the selection; Extract
 *       selected sends the SORTED paths as the worker's optional 'paths'
 *       field (never 'files') — as downloads or through the synchronously
 *       called directory picker; pinned status strings; empty selection is a
 *       no-op; Clear mid-flight and Clear-with-selection guards
 *
 * Usage: node tests/app-file-handling.test.mjs   (from the repo root)
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PATH = path.join(REPO, 'app.js');
const HTML_PATH = path.join(REPO, 'index.html');

const APP_BASE = 'https://app.example/sub/dir/';
const SHARED_CACHE = '7zip-web-shared';

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

// Objects created inside the vm context have that realm's prototypes, so
// assert.deepStrictEqual refuses them; compare structurally instead.
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

/* ------------------------------------------------------------- mock caches */
/* Map-backed CacheStorage: open/keys/match/put/delete with real Response
 * objects per match, mirroring what app.js consumeSharedFiles() expects.    */

function createAppCaches(store, opLog) {
  function mockCache(name) {
    const entries = new Map(); // url -> { url, body, status, headers }
    return {
      name,
      entries,
      async put(request, response) {
        const headers = {};
        response.headers.forEach((value, key) => { headers[key] = value; });
        const body = new Uint8Array(await response.arrayBuffer());
        const url = typeof request === 'string' ? request : request.url;
        entries.set(url, { url, body, status: response.status, headers });
      },
      async match(request) {
        const url = typeof request === 'string' ? request : request.url;
        const entry = entries.get(url);
        if (!entry) return undefined;
        return new Response(entry.body.slice(), { status: entry.status, headers: entry.headers });
      },
      async delete(request) {
        const url = typeof request === 'string' ? request : request.url;
        if (opLog) opLog.push('cache-delete:' + url);
        return entries.delete(url);
      },
      async keys() {
        return [...entries.values()].map((entry) => ({ url: entry.url, method: 'GET' }));
      }
    };
  }
  return {
    _mock: mockCache,
    async open(name) {
      let cache = store.get(name);
      if (!cache) {
        cache = mockCache(name);
        store.set(name, cache);
      }
      return cache;
    },
    async keys() {
      return [...store.keys()];
    },
    async has(name) {
      return store.has(name);
    },
    async delete(name) {
      return store.delete(name);
    }
  };
}

/* -------------------------------------------------------------- mock DOM */

const htmlSource = fs.readFileSync(HTML_PATH, 'utf8');

// Initial `hidden` comes from the real index.html markup, so the feature-gating
// check covers the shipped HTML too (a missing hidden attribute would show the
// buttons in unsupported browsers).
function hiddenInHtml(id) {
  const m = new RegExp('<[^>]*\\bid="' + id + '"[^>]*>', 'i').exec(htmlSource);
  return !!m && /\shidden(\s|=|>|\/)/i.test(m[0]);
}

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
    hidden: init.hiddenFromHtml ? hiddenInHtml(id) : !!init.hidden,
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
  const {
    pickers = {}, // { open?, dir?, save? } -> (options, world) => Promise
    launchQueue = true,
    cacheStore = new Map()
  } = opts;

  const world = {
    opts,
    cacheStore,
    byId: {},
    windowListeners: new Map(),
    documentListeners: new Map(),
    workers: [],
    workerMessages: [], // { msg, transfers }
    terminated: 0,
    pickerCalls: { open: [], dir: [], save: [] },
    setConsumerCalls: 0,
    launchConsumer: null,
    urlCreated: [],
    urlRevoked: [],
    urlSeq: 0,
    logs: [],
    warnings: [],
    errors: [],
    fetchCalls: [],
    opLog: [] // records cache-delete:* and worker-post:* in real order
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

  const cachesApi = createAppCaches(world.cacheStore, world.opLog);
  world.cachesApi = cachesApi;

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
    location: { href: APP_BASE + 'index.html', origin: 'https://app.example' },
    caches: cachesApi
  };
  if (launchQueue) {
    windowStub.launchQueue = {
      setConsumer(fn) {
        world.setConsumerCalls++;
        world.launchConsumer = fn;
      }
    };
  }
  const PICKER_NAMES = [
    ['showOpenFilePicker', 'open'],
    ['showDirectoryPicker', 'dir'],
    ['showSaveFilePicker', 'save']
  ];
  for (const [name, key] of PICKER_NAMES) {
    const impl = pickers[key];
    if (typeof impl === 'function') {
      // Recorded synchronously: the contract requires the picker call to
      // happen INSIDE the click handler (transient user activation).
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
    world.workers.push(this);
    const self = this;
    this.postMessage = function (msg, transfers) {
      world.workerMessages.push({ msg, transfers: transfers || [] });
      world.opLog.push('worker-post:' + (msg && msg.type));
      if (msg && msg.type === 'init') {
        // Resolve the init handshake so the serialized queue keeps pumping.
        Promise.resolve().then(() => {
          if (self.onmessage) self.onmessage({ data: { id: msg.id, type: 'ready' } });
        });
      }
    };
    this.terminate = function () { world.terminated++; };
  }

  world.reply = function (data) {
    const worker = world.workers[0];
    if (!worker || !worker.onmessage) throw new Error('no worker to reply to');
    worker.onmessage({ data });
  };
  world.msgOfType = (type) => world.workerMessages.filter((m) => m.msg.type === type);
  world.lastMsgOfType = (type) => {
    const list = world.msgOfType(type);
    return list.length ? list[list.length - 1].msg : null;
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
    caches: cachesApi,
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

function makeSaveRecorder() {
  const rec = { calls: 0, createWritableCalls: 0, writes: [], closed: 0, order: [] };
  rec.handle = {
    kind: 'file',
    async createWritable() {
      rec.createWritableCalls++;
      rec.order.push('createWritable');
      return {
        async write(blob) {
          rec.writes.push(new Uint8Array(await blob.arrayBuffer()));
          rec.order.push('write');
        },
        async close() {
          rec.closed++;
          rec.order.push('close');
        }
      };
    }
  };
  return rec;
}

/* --------------------------------------------------------- flow shortcuts */

async function seedSharedCache(world, entries) {
  const cache = await world.cachesApi.open(SHARED_CACHE);
  for (const entry of entries) {
    await cache.put(entry.url, new Response(entry.body, {
      status: 200,
      headers: entry.headers
    }));
  }
  return cache;
}

async function openArchiveViaInput(world, name, bytes, type) {
  world.byId['file-input'].files = [new File([bytes], name, { type: type || '' })];
  world.fire(world.byId['file-input'], 'change');
  const got = await waitFor(() => world.workerMessages.some(
    (m) => m.msg.type === 'list' && m.msg.archive && m.msg.archive.name === name
  ));
  return got ? world.lastMsgOfType('list') : null;
}

const enc = new TextEncoder();

/* ============================================= (1) feature gating ========= */

section('(1) feature gating: unsupported browsers keep the old behavior');

{
  // No picker globals at all (Firefox / Safari).
  const world = createAppWorld().load();

  check('(1a) index.html ships both new buttons with the hidden attribute',
    hiddenInHtml('btn-open-archive') && hiddenInHtml('btn-extract-folder'));
  check('(1a) boot() leaves #btn-open-archive hidden without showOpenFilePicker',
    world.byId['btn-open-archive'].hidden === true);
  check('(1a) boot() leaves #btn-extract-folder hidden without showDirectoryPicker',
    world.byId['btn-extract-folder'].hidden === true);

  // Produce a download row through the compress flow: no Save-as button.
  const fileMsg = await (async () => {
    world.byId['file-input'].files = [new File([enc.encode('hello')], 'note.txt', { type: 'text/plain' })];
    world.fire(world.byId['file-input'], 'change');
    if (!(await waitFor(() => world.status().includes('queued for compression')))) return null;
    world.click(world.byId['btn-compress']);
    if (!(await waitFor(() => world.workerMessages.some((m) => m.msg.type === 'compress')))) return null;
    return world.lastMsgOfType('compress');
  })();
  check('(1a) compress flow reached the worker', !!fileMsg);
  if (fileMsg) {
    world.reply({ id: fileMsg.id, type: 'compress-result', archive: { name: 'note.txt.7z', data: new Uint8Array([1, 2, 3]) } });
    check('(1a) a download row appeared', await waitFor(() => world.byId['downloads'].children.length === 1));
    const row = world.byId['downloads'].children[0];
    check('(1a) the row is a div.download-row wrapping the <a>',
      row.tagName === 'DIV' && row.className === 'download-row' &&
      row.children.length === 1 && row.children[0].tagName === 'A',
      'children=' + row.children.map((c) => c.tagName + '.' + c.className).join(','));
    const link = row.children[0];
    check('(1a) the link keeps href (object URL) + download + name/size spans',
      String(link.href).startsWith('blob:') && link.download === 'note.txt.7z' &&
      link.children.length === 2 && link.children[0].textContent === 'note.txt.7z' &&
      link.children[1].textContent === '3 B',
      JSON.stringify({ href: link.href, download: link.download, kids: link.children.map((c) => c.textContent) }));
    check('(1a) NO Save-as button without showSaveFilePicker',
      row.children.filter((c) => c.tagName === 'BUTTON').length === 0 &&
      !JSON.stringify(row.children.map((c) => c.className)).includes('btn-save-as'));
  }
}

{
  // All three pickers present (Chromium): boot() unhides both buttons and
  // download rows grow a Save-as button — inside the ROW, never inside the <a>.
  const saveRec = makeSaveRecorder();
  const world = createAppWorld({
    pickers: {
      open: () => Promise.resolve([]),
      dir: () => Promise.resolve(makeFakeDir().handle),
      save: () => Promise.resolve(saveRec.handle)
    }
  }).load();

  check('(1b) boot() unhides #btn-open-archive when showOpenFilePicker exists',
    world.byId['btn-open-archive'].hidden === false);
  check('(1b) boot() unhides #btn-extract-folder when showDirectoryPicker exists',
    world.byId['btn-extract-folder'].hidden === false);

  world.byId['file-input'].files = [new File([enc.encode('hello')], 'note.txt', { type: 'text/plain' })];
  world.fire(world.byId['file-input'], 'change');
  const queued = await waitFor(() => world.status().includes('queued for compression'));
  check('(1b) compress flow queued the dropped file', queued);
  world.click(world.byId['btn-compress']);
  const cmsg = (await waitFor(() => world.workerMessages.some((m) => m.msg.type === 'compress')))
    ? world.lastMsgOfType('compress') : null;
  check('(1b) compress request reached the worker', !!cmsg);
  if (cmsg) {
    world.reply({ id: cmsg.id, type: 'compress-result', archive: { name: 'note.txt.7z', data: new Uint8Array([1, 2, 3]) } });
    check('(1b) download row appeared', await waitFor(() => world.byId['downloads'].children.length === 1));
    const row = world.byId['downloads'].children[0];
    const link = row.children[0];
    const saveBtn = row.children[1];
    check('(1b) the row is div.download-row with <a> then Save-as button',
      row.className === 'download-row' && row.children.length === 2 &&
      link.tagName === 'A' && saveBtn && saveBtn.tagName === 'BUTTON',
      'children=' + row.children.map((c) => c.tagName).join(','));
    check('(1b) Save-as button markup matches the contract',
      !!saveBtn && saveBtn.type === 'button' && saveBtn.className === 'btn btn-save-as' &&
      saveBtn.textContent === 'Save as…',
      saveBtn ? JSON.stringify({ type: saveBtn.type, cls: saveBtn.className, text: saveBtn.textContent }) : 'missing');
    check('(1b) Save-as button is in the ROW, never inside the <a>',
      !!saveBtn && link.children.indexOf(saveBtn) < 0 &&
      link.children.every((c) => c.tagName === 'SPAN'));
    check('(1b) a click handler was captured on the Save-as button',
      !!saveBtn && (saveBtn.listeners.get('click') || []).length === 1);
  }
}

{
  // Partial support: showOpenFilePicker exists but showDirectoryPicker and
  // showSaveFilePicker do NOT. Every affordance must gate on its OWN API.
  const world = createAppWorld({ pickers: { open: () => Promise.resolve([]) } }).load();
  check('(1c) #btn-open-archive is unhidden when showOpenFilePicker exists',
    world.byId['btn-open-archive'].hidden === false);
  check('(1c) #btn-extract-folder stays hidden without showDirectoryPicker',
    world.byId['btn-extract-folder'].hidden === true);

  world.byId['file-input'].files = [new File([enc.encode('hello')], 'note.txt', { type: 'text/plain' })];
  world.fire(world.byId['file-input'], 'change');
  await waitFor(() => world.status().includes('queued for compression'));
  world.click(world.byId['btn-compress']);
  const gotCompress = await waitFor(() => world.workerMessages.some((m) => m.msg.type === 'compress'));
  check('(1c) the compress flow still works with partial picker support', gotCompress);
  if (gotCompress) {
    world.reply({ id: world.lastMsgOfType('compress').id, type: 'compress-result', archive: { name: 'note.txt.7z', data: new Uint8Array([1, 2, 3]) } });
    await waitFor(() => world.byId['downloads'].children.length === 1);
  }
  const row = world.byId['downloads'].children[0];
  check('(1c) no Save-as button without showSaveFilePicker (gated independently)',
    !!row && row.children.length === 1 && row.children[0].tagName === 'A',
    row ? 'children=' + row.children.map((c) => c.tagName).join(',') : 'no row');
}

/* ================================================ (2) launchQueue ========= */

section('(2) launchQueue consumer ("Open with")');

{
  const world = createAppWorld().load();
  check('(2) a launchQueue consumer was registered exactly once at boot',
    world.setConsumerCalls === 1 && typeof world.launchConsumer === 'function',
    'setConsumerCalls=' + world.setConsumerCalls);

  // Degenerate params: no consumer crash, no worker traffic, no error status.
  world.launchConsumer(undefined);
  world.launchConsumer({});
  world.launchConsumer({ files: [] });
  await tick(30);
  check('(2) empty/absent launch params are ignored silently',
    world.workerMessages.length === 0 && world.status() === '' && !world.isError(),
    'status=' + JSON.stringify(world.status()));

  // Fake FileSystemHandle with getFile().
  const LAUNCH_BYTES = enc.encode('7z-launch-bytes');
  world.launchConsumer({
    files: [{ getFile: async () => new File([LAUNCH_BYTES], 'a.7z', { type: 'application/x-7z-compressed' }) }]
  });
  const listed = await waitFor(() => world.workerMessages.some(
    (m) => m.msg.type === 'list' && m.msg.archive && m.msg.archive.name === 'a.7z'
  ));
  check('(2) a launched handle produced a list request for a.7z', listed,
    JSON.stringify(world.workerMessages.map((m) => m.msg.type)));
  if (listed) {
    const msg = world.lastMsgOfType('list');
    check('(2) the launched file bytes travel with the list request',
      bytesEq(new Uint8Array(msg.archive.data), LAUNCH_BYTES));
    check('(2) archive panel opened for the launched file',
      world.byId['archive-panel'].hidden === false &&
      world.byId['archive-name'].textContent === 'a.7z');
  }

  // A raw File (no getFile) also works.
  world.reply({ id: world.lastMsgOfType('list').id, type: 'list-result', entries: [] });
  world.launchConsumer({ files: [new File([enc.encode('raw')], 'direct.zip', { type: 'application/zip' })] });
  check('(2) a raw File entry (no getFile) also opens',
    await waitFor(() => world.workerMessages.some(
      (m) => m.msg.type === 'list' && m.msg.archive && m.msg.archive.name === 'direct.zip'
    )));

  // Non-file junk in params.files is filtered out (no crash, no request).
  const before = world.workerMessages.length;
  world.reply({ id: world.lastMsgOfType('list').id, type: 'list-result', entries: [] });
  world.launchConsumer({ files: [null, { notAFile: true }] });
  await tick(40);
  check('(2) non-File launch params are filtered without crashing',
    world.workerMessages.length === before && !world.isError(),
    'messages=' + world.workerMessages.length + ' before=' + before);

  // getFile() rejecting surfaces a readable error status.
  world.launchConsumer({
    files: [{ getFile: () => Promise.reject(new Error('handle expired')) }]
  });
  check('(2) an unreadable launch sets the documented error status',
    await waitFor(() => world.status() === 'Could not read the launched file(s): handle expired') &&
    world.isError(),
    'status=' + JSON.stringify(world.status()));
}

{
  // window.launchQueue is absent entirely (Firefox / older Chromium): boot
  // must not touch it and nothing may be registered.
  const world = createAppWorld({ launchQueue: false }).load();
  await tick(30);
  check('(2b) boot survives without window.launchQueue (no consumer, no errors)',
    world.setConsumerCalls === 0 && !world.isError() && world.status() === '' &&
    world.errors.length === 0,
    JSON.stringify(world.errors.concat(world.status())));
}

/* ============================================ (3) shared-cache pickup ===== */

section('(3) share-target pickup from the shared cache');

{
  const cacheStore = new Map();
  const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 7, 8, 9]);
  const worldA = createAppWorld({ cacheStore });
  const shared = await seedSharedCache(worldA, [
    {
      url: APP_BASE + '__shared/0',
      body: ZIP_BYTES,
      headers: { 'X-File-Name': encodeURIComponent('x.zip'), 'Content-Type': 'application/zip' }
    },
    {
      url: APP_BASE + '__shared/count',
      body: '1',
      headers: { 'Content-Type': 'text/plain' }
    }
  ]);
  worldA.load();

  const listed = await waitFor(() => worldA.workerMessages.some(
    (m) => m.msg.type === 'list' && m.msg.archive && m.msg.archive.name === 'x.zip'
  ));
  check('(3) boot() read the shared cache and sent a list request for x.zip', listed,
    JSON.stringify(worldA.workerMessages.map((m) => m.msg.type)));
  if (listed) {
    const msg = worldA.lastMsgOfType('list');
    check('(3) the shared file bytes survived the cache round-trip',
      bytesEq(new Uint8Array(msg.archive.data), ZIP_BYTES));
  }
  check('(3) ALL shared keys (file + count) were deleted',
    await waitFor(() => shared.entries.size === 0),
    'entries=' + [...shared.entries.keys()].join(','));
  // Contract order: read all -> delete all -> THEN process. Deleting before
  // the first worker message proves a mid-process reload cannot re-ingest.
  const firstPost = worldA.opLog.findIndex((e) => e.startsWith('worker-post:'));
  const lastDelete = worldA.opLog.map((e) => e.startsWith('cache-delete:')).lastIndexOf(true);
  check('(3) every shared key is deleted BEFORE processing starts (read -> delete -> process)',
    lastDelete >= 0 && firstPost > lastDelete,
    JSON.stringify(worldA.opLog));
  check('(3) pickup happens without user interaction and without errors',
    !worldA.isError() && worldA.errors.length === 0, JSON.stringify(worldA.errors));

  // Re-boot against the now-empty shared cache: nothing may be sent again.
  const worldB = createAppWorld({ cacheStore }).load();
  await tick(80);
  check('(3) re-boot with an empty shared cache sends nothing (no double ingest)',
    worldB.workerMessages.length === 0 && worldB.workers.length === 0 && !worldB.isError(),
    'messages=' + worldB.workerMessages.length);
}

{
  // No caches API at all (very old browser): boot must not break.
  const world = createAppWorld();
  delete world.windowStub.caches;
  delete world.sandbox.caches;
  world.load();
  await tick(30);
  check('(3b) boot survives without the caches API',
    !world.isError() && world.errors.length === 0 && world.status() === '',
    JSON.stringify(world.errors.concat(world.status())));
}

{
  // Broken cache backend: caches.open rejects. consumeSharedFiles is wrapped
  // in a .catch, so boot must survive with only a console.warn.
  const world = createAppWorld();
  world.cachesApi.open = () => Promise.reject(new Error('cache backend down'));
  world.load();
  await tick(40);
  check('(3c) a rejecting caches.open only warns and never breaks boot',
    !world.isError() && world.status() === '' && world.errors.length === 0 &&
    world.warnings.some((w) => w.includes('could not consume shared files')),
    JSON.stringify(world.warnings));
}

/* ============================================ (4) #btn-open-archive ======= */

section('(4) Open archive… button (showOpenFilePicker)');

{
  const PICK_BYTES = enc.encode('picked-7z-bytes');
  const world = createAppWorld({
    pickers: {
      open: () => Promise.resolve([
        { getFile: async () => new File([PICK_BYTES], 'b.7z', { type: 'application/x-7z-compressed' }) }
      ])
    }
  }).load();

  const btn = world.byId['btn-open-archive'];
  check('(4) #btn-open-archive is visible and has exactly one click handler',
    btn.hidden === false && (btn.listeners.get('click') || []).length === 1);

  world.click(btn);
  check('(4) showOpenFilePicker is called SYNCHRONOUSLY inside the click handler',
    world.pickerCalls.open.length === 1);
  const options = world.pickerCalls.open[0] || {};
  check('(4) picker options: multiple true, id 7zip-open, startIn downloads',
    options.multiple === true && options.id === '7zip-open' && options.startIn === 'downloads',
    JSON.stringify({ multiple: options.multiple, id: options.id, startIn: options.startIn }));
  const acceptExts = options.types && options.types[0] && options.types[0].accept
    ? Object.keys(options.types[0].accept).reduce((acc, k) => acc.concat(options.types[0].accept[k]), [])
    : [];
  check('(4) picker filter is one "Archives" type covering all 17 dotted extensions',
    !!options.types && options.types.length === 1 && options.types[0].description === 'Archives' &&
    acceptExts.length === 17 && acceptExts.every((e) => e.startsWith('.')),
    JSON.stringify(acceptExts));

  check('(4) the picked file produced a list request for b.7z',
    await waitFor(() => world.workerMessages.some(
      (m) => m.msg.type === 'list' && m.msg.archive && m.msg.archive.name === 'b.7z'
    )),
    JSON.stringify(world.workerMessages.map((m) => m.msg.type)));
  if (world.lastMsgOfType('list')) {
    check('(4) the picked bytes travel with the list request',
      bytesEq(new Uint8Array(world.lastMsgOfType('list').archive.data), PICK_BYTES));
  }
}

{
  // Dismissed picker: AbortError must be silent.
  const world = createAppWorld({
    pickers: {
      open: () => {
        const err = new Error('The user aborted a request.');
        err.name = 'AbortError';
        return Promise.reject(err);
      }
    }
  }).load();
  world.click(world.byId['btn-open-archive']);
  await tick(60);
  check('(4b) AbortError from the open picker sets no status at all',
    world.status() === '' && !world.isError() && world.workerMessages.length === 0,
    'status=' + JSON.stringify(world.status()));
}

{
  // Real failure: readable error status.
  const world = createAppWorld({
    pickers: { open: () => Promise.reject(new Error('blocked')) }
  }).load();
  world.click(world.byId['btn-open-archive']);
  check('(4c) a failed open picker surfaces "Could not open the file picker: blocked"',
    await waitFor(() => world.status() === 'Could not open the file picker: blocked') && world.isError(),
    'status=' + JSON.stringify(world.status()));
}

/* ========================================= (5) #btn-extract-folder ======== */

section('(5) Extract to folder… (showDirectoryPicker + containment)');

{
  const fakeDir = makeFakeDir();
  const world = createAppWorld({
    pickers: { dir: () => Promise.resolve(fakeDir.handle) }
  }).load();

  // Open an archive first.
  const ARC_BYTES = enc.encode('archive-bytes');
  const listMsg = await openArchiveViaInput(world, 'test.7z', ARC_BYTES, 'application/x-7z-compressed');
  check('(5) list request for test.7z reached the worker', !!listMsg);
  check('(5) the list request carries the archive bytes',
    !!listMsg && bytesEq(new Uint8Array(listMsg.archive.data), ARC_BYTES));
  world.reply({
    id: listMsg.id,
    type: 'list-result',
    entries: [{ path: 'hello.txt', size: 5, modified: '2026-01-02 03:04', method: 'LZMA2', isFolder: false, encrypted: false }]
  });
  check('(5) archive opened: panel visible, status reports the listing',
    await waitFor(() => world.status().includes('"test.7z": 1 entries listed')) &&
    world.byId['archive-panel'].hidden === false,
    'status=' + JSON.stringify(world.status()));

  world.click(world.byId['btn-extract-folder']);
  check('(5) showDirectoryPicker is called SYNCHRONOUSLY in the click handler',
    world.pickerCalls.dir.length === 1);
  check('(5) directory picker options: mode readwrite, id 7zip-extract, startIn downloads',
    deepEq(world.pickerCalls.dir[0], { mode: 'readwrite', id: '7zip-extract', startIn: 'downloads' }),
    JSON.stringify(world.pickerCalls.dir[0]));

  const gotExtract = await waitFor(() => world.workerMessages.some((m) => m.msg.type === 'extract'));
  check('(5) an extract request was sent for test.7z', gotExtract);
  check('(5) status switched to the extracting message',
    world.status() === 'Extracting "test.7z" to folder…', JSON.stringify(world.status()));

  const extractMsg = world.lastMsgOfType('extract');
  check('(5) extract request carries the staged archiveKey, no bytes and no password',
    extractMsg.archiveKey === listMsg.archiveKey &&
    extractMsg.archive === undefined &&
    extractMsg.password === undefined,
    JSON.stringify({ key: extractMsg.archiveKey, listKey: listMsg.archiveKey, hasArchive: extractMsg.archive !== undefined }));

  // Hostile + normal paths through safeExtractPath semantics.
  const DATA = {
    'docs/readme.txt': new Uint8Array([10, 11, 12]),
    '../evil.txt': new Uint8Array([20, 21]),
    '/etc/passwd': new Uint8Array([30, 31, 32]),
    'C:/windows/x.dll': new Uint8Array([40, 41, 42, 43]),
    'a/b/../c.txt': new Uint8Array([50, 51])
  };
  world.reply({
    id: extractMsg.id,
    type: 'extract-result',
    files: Object.keys(DATA).map((p) => ({ path: p, data: DATA[p] }))
  });

  check('(5) status reports all 5 files extracted to the folder',
    await waitFor(() => world.status() === 'Extracted 5 file(s) to the chosen folder'),
    'status=' + JSON.stringify(world.status()));
  check('(5) the success status is not an error', !world.isError());

  const writtenPaths = fakeDir.log.writes.map((w) => w.path).sort();
  check('(5) exactly the 5 contained paths were written',
    deepEq(writtenPaths, ['a/c.txt', 'docs/readme.txt', 'etc/passwd', 'evil.txt', 'windows/x.dll']),
    JSON.stringify(writtenPaths));
  check('(5) no written path escapes the chosen root (no "..", drive letter, leading "/" or empty segment)',
    writtenPaths.every((p) =>
      !p.startsWith('/') &&
      p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !/^[A-Za-z]:$/.test(seg))
    ),
    JSON.stringify(writtenPaths));
  check('(5) every written file has the exact bytes from the extract result',
    fakeDir.log.writes.length === 5 && fakeDir.log.writes.every((w) => {
      const source = Object.keys(DATA).find((p) => {
        const rel = p.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.' && !/^[A-Za-z]:$/.test(s));
        const out = [];
        for (const s of rel) { if (s === '..') { if (out.length) out.pop(); } else out.push(s); }
        return out.join('/') === w.path;
      });
      return source !== undefined && bytesEq(w.bytes, DATA[source]);
    }),
    JSON.stringify(fakeDir.log.writes.map((w) => [w.path, [...w.bytes]])));
  check('(5) parent directories were created with {create: true} and safe names',
    deepEq(fakeDir.log.mkdirs.map((m) => (m.at ? m.at + '/' : '') + m.name).sort(), ['a', 'docs', 'etc', 'windows']) &&
    fakeDir.log.mkdirs.every((m) => m.create === true),
    JSON.stringify(fakeDir.log.mkdirs));
  check('(5) file handles were requested with {create: true}',
    fakeDir.log.getFiles.length === 5 && fakeDir.log.getFiles.every((g) => g.create === true),
    JSON.stringify(fakeDir.log.getFiles.map((g) => g.name)));
  check('(5) every writable was closed after its write',
    fakeDir.log.closes.length === 5 &&
    fakeDir.log.writes.every((w) => {
      const wi = fakeDir.log.order.indexOf('write:' + w.path);
      const ci = fakeDir.log.order.indexOf('close:' + w.path);
      return wi >= 0 && ci > wi;
    }),
    JSON.stringify(fakeDir.log.order));
  check('(5) extract-to-folder added NOTHING to the downloads list',
    world.byId['downloads'].children.length === 0);
}

{
  // No archive open yet: the button must be a no-op (no picker call).
  const world = createAppWorld({
    pickers: { dir: () => Promise.resolve(makeFakeDir().handle) }
  }).load();
  world.click(world.byId['btn-extract-folder']);
  await tick(40);
  check('(5b) Extract to folder… without an open archive never calls the picker',
    world.pickerCalls.dir.length === 0 && world.status() === '' && !world.isError(),
    'dirCalls=' + world.pickerCalls.dir.length);
}

{
  // Per-file failures: one unwritable file must not abort the others, and the
  // aggregate status must report BOTH counts (failed > 0 -> error styling).
  const dirLog = { written: [], attempted: [] };
  const dirHandle = {
    kind: 'directory',
    async getDirectoryHandle() { return dirHandle; },
    async getFileHandle(name) {
      dirLog.attempted.push(name);
      if (name === 'locked.txt') throw new Error('permission denied');
      return {
        async createWritable() {
          return {
            async write() { dirLog.written.push(name); },
            async close() {}
          };
        }
      };
    }
  };
  const world = createAppWorld({ pickers: { dir: () => Promise.resolve(dirHandle) } }).load();
  const listMsg = await openArchiveViaInput(world, 'mixed.7z', enc.encode('arc'), 'application/x-7z-compressed');
  check('(5c) archive opened before the mixed-result extract', !!listMsg);
  world.reply({ id: listMsg.id, type: 'list-result', entries: [] });
  await waitFor(() => world.status().includes('entries listed'));

  world.click(world.byId['btn-extract-folder']);
  const gotExtract = await waitFor(() => world.workerMessages.some((m) => m.msg.type === 'extract'));
  world.reply({
    id: world.lastMsgOfType('extract').id,
    type: 'extract-result',
    files: [
      { path: 'good.txt', data: new Uint8Array([1]) },
      { path: 'locked.txt', data: new Uint8Array([2]) },
      { path: '../', data: new Uint8Array([3]) },
      { path: 'nodata.txt' }
    ]
  });
  check('(5c) partial failure reports "Extracted 1 file(s); 3 could not be written" as an error',
    gotExtract &&
    await waitFor(() => world.status() === 'Extracted 1 file(s); 3 could not be written') &&
    world.isError(),
    'status=' + JSON.stringify(world.status()));
  check('(5c) the writable file was still written despite the failures',
    deepEq(dirLog.written, ['good.txt']), JSON.stringify(dirLog.written));
  check('(5c) the unwritable file was logged via console.warn',
    world.warnings.some((w) => w.includes('could not write "locked.txt"')),
    JSON.stringify(world.warnings));
  check('(5c) entries with an empty contained path or no data never reached the handle',
    deepEq(dirLog.attempted, ['good.txt', 'locked.txt']),
    JSON.stringify(dirLog.attempted));
}

{
  // Directory picker dismissal vs failure (mirrors the save-picker contract).
  let rejectWith = null;
  const world = createAppWorld({ pickers: { dir: () => Promise.reject(rejectWith) } }).load();
  const listMsg = await openArchiveViaInput(world, 'test.7z', enc.encode('arc'), 'application/x-7z-compressed');
  world.reply({ id: listMsg.id, type: 'list-result', entries: [] });
  await waitFor(() => world.status().includes('entries listed'));
  const statusBefore = world.status();

  const abort = new Error('dismissed');
  abort.name = 'AbortError';
  rejectWith = abort;
  world.click(world.byId['btn-extract-folder']);
  await tick(50);
  check('(5d) AbortError from the directory picker is silent',
    world.status() === statusBefore && !world.isError(),
    'status=' + JSON.stringify(world.status()));

  rejectWith = new Error('no directory access');
  world.click(world.byId['btn-extract-folder']);
  check('(5d) a failed directory picker surfaces the error message',
    await waitFor(() => world.status() === 'no directory access') && world.isError(),
    'status=' + JSON.stringify(world.status()));
  check('(5d) no extract request was ever sent for rejected pickers',
    world.workerMessages.filter((m) => m.msg.type === 'extract').length === 0);
}

/* ============================================== (6) Save as… =============== */

section('(6) Save as… button (showSaveFilePicker)');

{
  const saveRec = makeSaveRecorder();
  const world = createAppWorld({
    pickers: { save: () => Promise.resolve(saveRec.handle) }
  }).load();

  // Three compress results -> three rows with different name shapes.
  const rows = [
    { file: 'note.txt', archive: 'note.txt.7z', bytes: new Uint8Array([1, 2, 3]) },
    { file: 'note.txt', archive: 'payload.bin', bytes: new Uint8Array([4, 5]) },
    { file: 'note.txt', archive: 'README', bytes: new Uint8Array([6]) }
  ];
  for (let i = 0; i < rows.length; i++) {
    if (i === 0) {
      world.byId['file-input'].files = [new File([enc.encode('hello')], rows[i].file, { type: 'text/plain' })];
      world.fire(world.byId['file-input'], 'change');
      if (!(await waitFor(() => world.status().includes('queued for compression')))) break;
    }
    world.click(world.byId['btn-compress']);
    const seen = world.msgOfType('compress').length;
    if (!(await waitFor(() => world.msgOfType('compress').length >= seen + 1))) break;
    const msg = world.lastMsgOfType('compress');
    world.reply({ id: msg.id, type: 'compress-result', archive: { name: rows[i].archive, data: rows[i].bytes } });
    if (!(await waitFor(() => world.byId['downloads'].children.length === i + 1))) break;
  }
  check('(6) three download rows were produced', world.byId['downloads'].children.length === 3,
    'rows=' + world.byId['downloads'].children.length);

  // Row 1: archive extension -> Archive file filter.
  const row1 = world.byId['downloads'].children[0];
  const saveBtn1 = row1.children[1];
  check('(6) row 1 carries a Save-as button', !!saveBtn1 && saveBtn1.className === 'btn btn-save-as');
  world.click(saveBtn1);
  check('(6) showSaveFilePicker is called SYNCHRONOUSLY in the Save-as click handler',
    world.pickerCalls.save.length === 1);
  const opt1 = world.pickerCalls.save[0] || {};
  check('(6) suggestedName equals the download name; id/startIn per contract',
    opt1.suggestedName === 'note.txt.7z' && opt1.id === '7zip-save' && opt1.startIn === 'downloads',
    JSON.stringify(opt1));
  check('(6) archive extension -> "Archive file" filter with the matching MIME',
    deepEq(opt1.types, [{ description: 'Archive file', accept: { 'application/x-7z-compressed': ['.7z'] } }]),
    JSON.stringify(opt1.types));
  check('(6) writable written with the exact download bytes, then closed',
    await waitFor(() => saveRec.closed === 1) &&
    saveRec.createWritableCalls === 1 && saveRec.writes.length === 1 &&
    bytesEq(saveRec.writes[0], rows[0].bytes) &&
    deepEq(saveRec.order, ['createWritable', 'write', 'close']),
    JSON.stringify(saveRec.order));
  check('(6) success status: Saved "note.txt.7z"',
    await waitFor(() => world.status() === 'Saved "note.txt.7z"') && !world.isError(),
    'status=' + JSON.stringify(world.status()));

  // Row 2: unknown extension -> generic All files filter.
  const saveBtn2 = world.byId['downloads'].children[1].children[1];
  world.click(saveBtn2);
  check('(6) unknown extension -> "All files" filter with application/octet-stream',
    await waitFor(() => world.pickerCalls.save.length >= 2) &&
    world.pickerCalls.save[1].suggestedName === 'payload.bin' &&
    deepEq(world.pickerCalls.save[1].types, [{ description: 'All files', accept: { 'application/octet-stream': ['.bin'] } }]),
    JSON.stringify(world.pickerCalls.save[1] && world.pickerCalls.save[1].types));
  check('(6) row 2 saved status', await waitFor(() => world.status() === 'Saved "payload.bin"'),
    'status=' + JSON.stringify(world.status()));

  // Row 3: no extension -> types omitted entirely.
  const saveBtn3 = world.byId['downloads'].children[2].children[1];
  world.click(saveBtn3);
  check('(6) no extension -> picker called WITHOUT a types member',
    await waitFor(() => world.pickerCalls.save.length >= 3) &&
    world.pickerCalls.save[2].suggestedName === 'README' &&
    world.pickerCalls.save[2].types === undefined,
    JSON.stringify(world.pickerCalls.save[2]));
}

{
  // Dismissed save picker: silent.
  const world = createAppWorld({
    pickers: {
      save: () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        return Promise.reject(err);
      }
    }
  }).load();
  world.byId['file-input'].files = [new File([enc.encode('hello')], 'note.txt', { type: 'text/plain' })];
  world.fire(world.byId['file-input'], 'change');
  await waitFor(() => world.status().includes('queued for compression'));
  world.click(world.byId['btn-compress']);
  await waitFor(() => world.workerMessages.some((m) => m.msg.type === 'compress'));
  world.reply({ id: world.lastMsgOfType('compress').id, type: 'compress-result', archive: { name: 'note.txt.7z', data: new Uint8Array([1, 2, 3]) } });
  await waitFor(() => world.byId['downloads'].children.length === 1);
  await waitFor(() => world.status().startsWith('Created "note.txt.7z"'));
  const statusBefore = world.status();
  world.click(world.byId['downloads'].children[0].children[1]);
  await tick(60);
  check('(6b) AbortError from the save picker leaves the status untouched',
    world.status() === statusBefore && !world.isError(),
    'before=' + JSON.stringify(statusBefore) + ' after=' + JSON.stringify(world.status()));
}

{
  // Failing save picker: error status with the message.
  const world = createAppWorld({
    pickers: { save: () => Promise.reject(new Error('not allowed')) }
  }).load();
  world.byId['file-input'].files = [new File([enc.encode('hello')], 'note.txt', { type: 'text/plain' })];
  world.fire(world.byId['file-input'], 'change');
  await waitFor(() => world.status().includes('queued for compression'));
  world.click(world.byId['btn-compress']);
  await waitFor(() => world.workerMessages.some((m) => m.msg.type === 'compress'));
  world.reply({ id: world.lastMsgOfType('compress').id, type: 'compress-result', archive: { name: 'note.txt.7z', data: new Uint8Array([1, 2, 3]) } });
  await waitFor(() => world.byId['downloads'].children.length === 1);
  world.click(world.byId['downloads'].children[0].children[1]);
  check('(6c) a failed save surfaces the error message',
    await waitFor(() => world.status() === 'not allowed') && world.isError(),
    'status=' + JSON.stringify(world.status()));
}

{
  // Clear after a download: the row must disappear and its object URL be
  // revoked (the pre-existing object-URL lifecycle, unchanged).
  const saveRec = makeSaveRecorder();
  const world = createAppWorld({ pickers: { save: () => Promise.resolve(saveRec.handle) } }).load();
  world.byId['file-input'].files = [new File([enc.encode('hello')], 'note.txt', { type: 'text/plain' })];
  world.fire(world.byId['file-input'], 'change');
  await waitFor(() => world.status().includes('queued for compression'));
  world.click(world.byId['btn-compress']);
  await waitFor(() => world.workerMessages.some((m) => m.msg.type === 'compress'));
  world.reply({ id: world.lastMsgOfType('compress').id, type: 'compress-result', archive: { name: 'note.txt.7z', data: new Uint8Array([1, 2, 3]) } });
  await waitFor(() => world.byId['downloads'].children.length === 1);
  const created = world.urlCreated.map((u) => u.url);
  world.click(world.byId['btn-clear']);
  check('(6d) Clear removes the download rows and revokes every object URL',
    world.byId['downloads'].children.length === 0 &&
    created.length === 1 && deepEq(world.urlRevoked, created),
    JSON.stringify({ created, revoked: world.urlRevoked, rows: world.byId['downloads'].children.length }));
}

/* ==================================== (7) generation / Clear mid-extract == */

section('(7) Clear during extract-to-folder cancels every write');

{
  const fakeDir = makeFakeDir();
  const world = createAppWorld({
    pickers: { dir: () => Promise.resolve(fakeDir.handle) }
  }).load();

  const listMsg = await openArchiveViaInput(world, 'test.7z', enc.encode('archive-bytes'), 'application/x-7z-compressed');
  check('(7) archive opened before the extract', !!listMsg);
  world.reply({ id: listMsg.id, type: 'list-result', entries: [] });
  await waitFor(() => world.status().includes('entries listed'));

  world.click(world.byId['btn-extract-folder']);
  const gotExtract = await waitFor(() => world.workerMessages.some((m) => m.msg.type === 'extract'));
  check('(7) extract request is in flight before Clear', gotExtract);
  check('(7) extracting status shown before Clear',
    world.status() === 'Extracting "test.7z" to folder…', JSON.stringify(world.status()));

  // Clear while the extract is pending.
  world.click(world.byId['btn-clear']);
  check('(7) Clear reset the status synchronously', world.status() === '' && !world.isError(),
    'status=' + JSON.stringify(world.status()));
  check('(7) Clear hid the archive panel', world.byId['archive-panel'].hidden === true);

  // The worker's late reply must hit the void.
  const extractMsg = world.lastMsgOfType('extract');
  world.reply({
    id: extractMsg.id,
    type: 'extract-result',
    files: [
      { path: 'one.txt', data: new Uint8Array([1]) },
      { path: 'two.txt', data: new Uint8Array([2]) },
      { path: 'three.txt', data: new Uint8Array([3]) }
    ]
  });
  await tick(80);
  check('(7) ZERO writes reached the directory handle after Clear',
    fakeDir.log.writes.length === 0 && fakeDir.log.mkdirs.length === 0 &&
    fakeDir.log.getFiles.length === 0 && fakeDir.log.closes.length === 0,
    JSON.stringify(fakeDir.log.order));
  check('(7) no status was set after Clear', world.status() === '' && !world.isError(),
    'status=' + JSON.stringify(world.status()));
  check('(7) nothing was added to downloads either', world.byId['downloads'].children.length === 0);
  check('(7) no console errors during the cancelled flow', world.errors.length === 0,
    JSON.stringify(world.errors));
}

{
  // Clear BETWEEN the picker click and the picker resolution: the generation
  // check must stop the flow before any extract request leaves for the worker.
  let resolvePicker = null;
  const fakeDir = makeFakeDir();
  const world = createAppWorld({
    pickers: { dir: () => new Promise((resolve) => { resolvePicker = resolve; }) }
  }).load();
  const listMsg = await openArchiveViaInput(world, 'test.7z', enc.encode('arc'), 'application/x-7z-compressed');
  world.reply({ id: listMsg.id, type: 'list-result', entries: [] });
  await waitFor(() => world.status().includes('entries listed'));

  world.click(world.byId['btn-extract-folder']);
  check('(7b) the directory picker was consulted before Clear',
    world.pickerCalls.dir.length === 1 && typeof resolvePicker === 'function');

  world.click(world.byId['btn-clear']);
  resolvePicker(fakeDir.handle);
  await tick(80);
  check('(7b) Clear before the picker resolves sends NO extract request and writes nothing',
    world.workerMessages.filter((m) => m.msg.type === 'extract').length === 0 &&
    fakeDir.log.order.length === 0 && world.status() === '' && !world.isError() &&
    world.errors.length === 0,
    JSON.stringify({
      msgs: world.workerMessages.map((m) => m.msg.type),
      order: fakeDir.log.order,
      status: world.status()
    }));
}

/* ==================================== (8) selective extraction ============= */

section('(8) selective extraction (checkbox column, selection UI, paths flows)');

// One folder + two files, deliberately NOT in sorted order so the request's
// sorted-paths contract is observable.
const SEL_ENTRIES = [
  { path: 'docs', size: 0, modified: '2026-01-01 00:00', method: '', isFolder: true, encrypted: false },
  { path: 'b.txt', size: 3, modified: '2026-01-02 03:04', method: 'LZMA2', isFolder: false, encrypted: false },
  { path: 'a.txt', size: 5, modified: '2026-01-02 03:05', method: 'LZMA2', isFolder: false, encrypted: false }
];

// Row checkboxes are reached through the stub tree (NO querySelectorAll, NO
// dataset — the render contract offers neither): tbody > tr > td.col-select > input.
function selRowBox(world, rowIndex) {
  const tr = world.byId['entries-body'].children[rowIndex];
  return tr && tr.children[0] && tr.children[0].children[0];
}
function selToggle(world, box, on) {
  box.checked = on;
  world.fire(box, 'change');
}

{
  // No picker globals: the download-path button is always wired; the folder
  // variant stays hidden and unwired.
  const world = createAppWorld().load();

  check('(8a) #btn-extract-selected ships visible, #btn-extract-selected-folder stays hidden without showDirectoryPicker',
    world.byId['btn-extract-selected'].hidden === false &&
    world.byId['btn-extract-selected-folder'].hidden === true);
  check('(8a) #btn-extract-selected is always wired; the folder variant has no click handler without showDirectoryPicker',
    (world.byId['btn-extract-selected'].listeners.get('click') || []).length === 1 &&
    (world.byId['btn-extract-selected-folder'].listeners.get('click') || []).length === 0);

  const ARC = enc.encode('selective-arc-bytes');
  const listMsg = await openArchiveViaInput(world, 'test.7z', ARC, 'application/x-7z-compressed');
  check('(8a) list request for test.7z reached the worker', !!listMsg);
  world.reply({ id: listMsg.id, type: 'list-result', entries: SEL_ENTRIES });
  check('(8a) archive opened: 3 entries listed',
    await waitFor(() => world.status() === '"test.7z": 3 entries listed'),
    'status=' + JSON.stringify(world.status()));

  const rows = world.byId['entries-body'].children;
  check('(8a) one row per entry', rows.length === 3, 'rows=' + rows.length);
  check('(8a) EVERY row (folder included) prepends a td.col-select holding exactly one checkbox input.entry-select',
    rows.length === 3 && rows.every((tr) => {
      const td = tr.children[0];
      return td && td.tagName === 'TD' && td.className === 'col-select' &&
        td.children.length === 1 && td.children[0].tagName === 'INPUT' &&
        td.children[0].type === 'checkbox' && td.children[0].className === 'entry-select';
    }),
    JSON.stringify(rows.map((tr) => tr.children.map((td) => td.tagName + '.' + td.className))));
  check('(8a) each row checkbox aria-labels its own entry path and captured exactly one change listener',
    rows.length === 3 && rows.every((tr, i) =>
      tr.children[0].children[0].getAttribute('aria-label') === 'Select ' + SEL_ENTRIES[i].path &&
      (tr.children[0].children[0].listeners.get('change') || []).length === 1),
    JSON.stringify(rows.map((tr) => tr.children[0].children[0] && tr.children[0].children[0].getAttribute('aria-label'))));
  check('(8a) every row has 5 cells (select + name/size/modified/method)',
    rows.length === 3 && rows.every((tr) => tr.children.length === 5));

  check('(8a) initial selection UI: both buttons disabled with the pinned base labels, select-all off',
    world.byId['btn-extract-selected'].disabled === true &&
    world.byId['btn-extract-selected'].textContent === 'Extract selected' &&
    world.byId['btn-extract-selected-folder'].disabled === true &&
    world.byId['btn-extract-selected-folder'].textContent === 'Selected to folder…' &&
    !world.byId['entry-select-all'].checked && !world.byId['entry-select-all'].indeterminate,
    JSON.stringify({
      sel: world.byId['btn-extract-selected'].textContent,
      selFolder: world.byId['btn-extract-selected-folder'].textContent,
      disabled: [world.byId['btn-extract-selected'].disabled, world.byId['btn-extract-selected-folder'].disabled]
    }));

  selToggle(world, selRowBox(world, 1), true); // b.txt
  check('(8a) checking one row flips disabled and appends " (1)" to BOTH pinned labels; select-all goes indeterminate',
    world.byId['btn-extract-selected'].disabled === false &&
    world.byId['btn-extract-selected'].textContent === 'Extract selected (1)' &&
    world.byId['btn-extract-selected-folder'].disabled === false &&
    world.byId['btn-extract-selected-folder'].textContent === 'Selected to folder… (1)' &&
    world.byId['entry-select-all'].indeterminate === true &&
    !world.byId['entry-select-all'].checked,
    JSON.stringify([
      world.byId['btn-extract-selected'].textContent,
      world.byId['btn-extract-selected-folder'].textContent,
      world.byId['entry-select-all'].indeterminate
    ]));

  selToggle(world, selRowBox(world, 2), true); // a.txt
  check('(8a) a second checked row counts up to " (2)" on both labels',
    world.byId['btn-extract-selected'].textContent === 'Extract selected (2)' &&
    world.byId['btn-extract-selected-folder'].textContent === 'Selected to folder… (2)');

  selToggle(world, selRowBox(world, 1), false); // uncheck b.txt again
  check('(8a) unchecking a row counts back down to " (1)" and keeps select-all indeterminate',
    world.byId['btn-extract-selected'].textContent === 'Extract selected (1)' &&
    world.byId['btn-extract-selected-folder'].textContent === 'Selected to folder… (1)' &&
    world.byId['entry-select-all'].indeterminate === true &&
    !world.byId['entry-select-all'].checked);

  const selectAll = world.byId['entry-select-all'];
  selectAll.checked = true;
  world.fire(selectAll, 'change');
  check('(8a) select-all checks EVERY row (folder included), counts all 3 and clears indeterminate',
    [0, 1, 2].every((i) => selRowBox(world, i).checked === true) &&
    world.byId['btn-extract-selected'].textContent === 'Extract selected (3)' &&
    world.byId['btn-extract-selected-folder'].textContent === 'Selected to folder… (3)' &&
    selectAll.checked === true && selectAll.indeterminate === false,
    JSON.stringify([0, 1, 2].map((i) => selRowBox(world, i).checked)));

  // Extract the select-all selection: proves the folder path joined the set
  // and that the request order is SORTED (docs, b.txt, a.txt -> a, b, docs).
  world.click(world.byId['btn-extract-selected']);
  check('(8a) click status is pinned: Extracting 3 selected entries from "test.7z"…',
    world.status() === 'Extracting 3 selected entries from "test.7z"…' && !world.isError(),
    'status=' + JSON.stringify(world.status()));
  const selMsg = (await waitFor(() => world.workerMessages.some((m) => m.msg.type === 'extract')))
    ? world.lastMsgOfType('extract') : null;
  check('(8a) extract request paths are the SORTED selected paths, folders included',
    !!selMsg && deepEq(selMsg.paths, ['a.txt', 'b.txt', 'docs']),
    JSON.stringify(selMsg && selMsg.paths));
  check('(8a) the selection travels as "paths", NEVER as "files" (pumpQueue would treat files as transferables)',
    !!selMsg && selMsg.files === undefined && Array.isArray(selMsg.paths));
  check('(8a) the staged archiveKey rides along instead of bytes, password untouched',
    !!selMsg && selMsg.archiveKey === listMsg.archiveKey &&
    selMsg.archive === undefined && selMsg.password === undefined,
    JSON.stringify(selMsg && { key: selMsg.archiveKey, listKey: listMsg.archiveKey, hasArchive: selMsg.archive !== undefined }));
  world.reply({ id: selMsg.id, type: 'extract-result', files: [] });
  check('(8a) zero files -> pinned plural error status "Nothing extracted from the 3 selected entries"',
    await waitFor(() => world.status() === 'Nothing extracted from the 3 selected entries') && world.isError(),
    'status=' + JSON.stringify(world.status()));

  selToggle(world, selRowBox(world, 0), false); // uncheck docs
  check('(8a) unchecking one row after select-all: labels count 2, select-all drops to indeterminate',
    world.byId['btn-extract-selected'].textContent === 'Extract selected (2)' &&
    world.byId['btn-extract-selected-folder'].textContent === 'Selected to folder… (2)' &&
    selectAll.checked === false && selectAll.indeterminate === true);

  selectAll.checked = false;
  world.fire(selectAll, 'change');
  check('(8a) select-all off unchecks every row, resets both labels to base and disables both buttons',
    [0, 1, 2].every((i) => selRowBox(world, i).checked === false) &&
    world.byId['btn-extract-selected'].disabled === true &&
    world.byId['btn-extract-selected'].textContent === 'Extract selected' &&
    world.byId['btn-extract-selected-folder'].disabled === true &&
    world.byId['btn-extract-selected-folder'].textContent === 'Selected to folder…' &&
    selectAll.checked === false && selectAll.indeterminate === false,
    JSON.stringify([0, 1, 2].map((i) => selRowBox(world, i).checked)));

  // Empty selection: the click handler must be a no-op even though the stub
  // fires listeners regardless of `disabled` (defense-in-depth per contract).
  const msgsBefore = world.workerMessages.length;
  const statusBefore = world.status();
  world.click(world.byId['btn-extract-selected']);
  await tick(40);
  check('(8a) empty selection: clicking Extract selected sends NO worker message and leaves the status untouched',
    world.workerMessages.length === msgsBefore && world.status() === statusBefore,
    'newMessages=' + (world.workerMessages.length - msgsBefore) + ' status=' + JSON.stringify(world.status()));

  // Password + sorted paths + successful download flow.
  world.byId['password-input'].value = 'hunter2';
  selToggle(world, selRowBox(world, 1), true); // b.txt
  selToggle(world, selRowBox(world, 2), true); // a.txt
  world.click(world.byId['btn-extract-selected']);
  check('(8a) two-entry click status is pinned plural: Extracting 2 selected entries from "test.7z"…',
    world.status() === 'Extracting 2 selected entries from "test.7z"…' && !world.isError(),
    'status=' + JSON.stringify(world.status()));
  const sel2 = (await waitFor(() => world.msgOfType('extract').length >= 2))
    ? world.lastMsgOfType('extract') : null;
  check('(8a) second request carries sorted ["a.txt","b.txt"], the typed password and the staged key',
    !!sel2 && deepEq(sel2.paths, ['a.txt', 'b.txt']) && sel2.password === 'hunter2' &&
    sel2.archiveKey === listMsg.archiveKey && sel2.archive === undefined,
    JSON.stringify(sel2 && { paths: sel2.paths, password: sel2.password, key: sel2.archiveKey }));
  const DATA = { 'a.txt': new Uint8Array([1, 2, 3]), 'b.txt': new Uint8Array([4, 5]) };
  world.reply({
    id: sel2.id,
    type: 'extract-result',
    files: Object.keys(DATA).map((p) => ({ path: p, data: DATA[p] }))
  });
  check('(8a) both returned files appeared as download rows with their base names',
    await waitFor(() => world.byId['downloads'].children.length === 2) &&
    deepEq(world.byId['downloads'].children.map((row) => row.children[0].download).sort(), ['a.txt', 'b.txt']),
    JSON.stringify(world.byId['downloads'].children.map((row) => row.children[0] && row.children[0].download)));
  check('(8a) pinned success status: Extracted 2 file(s) from "test.7z" (not an error)',
    world.status() === 'Extracted 2 file(s) from "test.7z"' && !world.isError(),
    'status=' + JSON.stringify(world.status()));

  // Singular pins: 1 selected entry, zero files returned.
  selToggle(world, selRowBox(world, 2), false); // keep only b.txt
  world.click(world.byId['btn-extract-selected']);
  check('(8a) single-entry click status is pinned singular: Extracting 1 selected entry from "test.7z"…',
    world.status() === 'Extracting 1 selected entry from "test.7z"…',
    'status=' + JSON.stringify(world.status()));
  const sel3 = (await waitFor(() => world.msgOfType('extract').length >= 3))
    ? world.lastMsgOfType('extract') : null;
  check('(8a) singular request carries exactly ["b.txt"]',
    !!sel3 && deepEq(sel3.paths, ['b.txt']), JSON.stringify(sel3 && sel3.paths));
  world.reply({ id: sel3.id, type: 'extract-result', files: [] });
  check('(8a) zero files -> pinned singular error status "Nothing extracted from the 1 selected entry"',
    await waitFor(() => world.status() === 'Nothing extracted from the 1 selected entry') && world.isError(),
    'status=' + JSON.stringify(world.status()));

  // Clear with an active selection resets the whole selection UI.
  world.click(world.byId['btn-clear']);
  check('(8a) Clear with a selection: base labels, both buttons disabled, select-all unchecked and not indeterminate',
    world.byId['btn-extract-selected'].textContent === 'Extract selected' &&
    world.byId['btn-extract-selected'].disabled === true &&
    world.byId['btn-extract-selected-folder'].textContent === 'Selected to folder…' &&
    world.byId['btn-extract-selected-folder'].disabled === true &&
    world.byId['entry-select-all'].checked !== true &&
    !world.byId['entry-select-all'].indeterminate,
    JSON.stringify({
      sel: world.byId['btn-extract-selected'].textContent,
      selFolder: world.byId['btn-extract-selected-folder'].textContent,
      checked: world.byId['entry-select-all'].checked,
      indeterminate: world.byId['entry-select-all'].indeterminate
    }));
  const bodyAfterClear = world.byId['entries-body'];
  check('(8a) Clear renders the empty listing: one "(no entries)" placeholder row with colSpan 5',
    bodyAfterClear.children.length === 1 &&
    bodyAfterClear.children[0].children.length === 1 &&
    bodyAfterClear.children[0].children[0].colSpan === 5 &&
    bodyAfterClear.children[0].children[0].textContent === '(no entries)',
    JSON.stringify(bodyAfterClear.children.map((tr) => tr.children.map((td) => [td.colSpan, td.textContent]))));
}

{
  // An empty list-result must render the 5-column placeholder directly.
  const world = createAppWorld().load();
  const listMsg = await openArchiveViaInput(world, 'empty.7z', enc.encode('nothing'), 'application/x-7z-compressed');
  check('(8b) list request for empty.7z reached the worker', !!listMsg);
  world.reply({ id: listMsg.id, type: 'list-result', entries: [] });
  check('(8b) empty listing: "(no entries)" placeholder spans all 5 columns',
    await waitFor(() => world.status() === '"empty.7z": 0 entries listed') &&
    world.byId['entries-body'].children.length === 1 &&
    world.byId['entries-body'].children[0].children[0].colSpan === 5 &&
    world.byId['entries-body'].children[0].children[0].textContent === '(no entries)',
    JSON.stringify(world.byId['entries-body'].children.map((tr) => tr.children.map((td) => [td.colSpan, td.textContent]))));
  check('(8b) buttons keep the base labels and stay disabled after an empty listing',
    world.byId['btn-extract-selected'].textContent === 'Extract selected' &&
    world.byId['btn-extract-selected'].disabled === true &&
    world.byId['btn-extract-selected-folder'].textContent === 'Selected to folder…' &&
    world.byId['btn-extract-selected-folder'].disabled === true);
}

{
  // Selected-to-folder flow with the directory picker present.
  const fakeDir = makeFakeDir();
  const world = createAppWorld({
    pickers: { dir: () => Promise.resolve(fakeDir.handle) }
  }).load();

  check('(8c) boot() unhides #btn-extract-selected-folder when showDirectoryPicker exists and wires exactly one click handler',
    world.byId['btn-extract-selected-folder'].hidden === false &&
    (world.byId['btn-extract-selected-folder'].listeners.get('click') || []).length === 1);

  const ARC = enc.encode('folder-arc-bytes');
  const listMsg = await openArchiveViaInput(world, 'test.7z', ARC, 'application/x-7z-compressed');
  check('(8c) archive opened before the selected-to-folder extract', !!listMsg);
  world.reply({ id: listMsg.id, type: 'list-result', entries: SEL_ENTRIES });
  await waitFor(() => world.status() === '"test.7z": 3 entries listed');

  selToggle(world, selRowBox(world, 1), true); // b.txt
  selToggle(world, selRowBox(world, 2), true); // a.txt
  check('(8c) folder button counts the selection: "Selected to folder… (2)"',
    world.byId['btn-extract-selected-folder'].textContent === 'Selected to folder… (2)' &&
    world.byId['btn-extract-selected-folder'].disabled === false);

  world.click(world.byId['btn-extract-selected-folder']);
  check('(8c) showDirectoryPicker is called SYNCHRONOUSLY in the click handler',
    world.pickerCalls.dir.length === 1);
  check('(8c) directory picker options: mode readwrite, id 7zip-extract-selected, startIn downloads',
    deepEq(world.pickerCalls.dir[0], { mode: 'readwrite', id: '7zip-extract-selected', startIn: 'downloads' }),
    JSON.stringify(world.pickerCalls.dir[0]));

  const gotExtract = await waitFor(() => world.workerMessages.some((m) => m.msg.type === 'extract'));
  const msg = world.lastMsgOfType('extract');
  check('(8c) extract request carries the sorted selection paths, the staged archiveKey and no files field',
    gotExtract && deepEq(msg.paths, ['a.txt', 'b.txt']) && msg.files === undefined &&
    msg.archiveKey === listMsg.archiveKey && msg.archive === undefined &&
    msg.password === undefined,
    JSON.stringify(msg && { paths: msg.paths, key: msg.archiveKey }));
  check('(8c) status is the pinned "to folder" variant',
    world.status() === 'Extracting 2 selected entries from "test.7z" to folder…',
    JSON.stringify(world.status()));

  const DATA = { 'a.txt': new Uint8Array([9, 8, 7]), 'b.txt': new Uint8Array([6, 5]) };
  world.reply({
    id: msg.id,
    type: 'extract-result',
    files: Object.keys(DATA).map((p) => ({ path: p, data: DATA[p] }))
  });
  check('(8c) success status: Extracted 2 file(s) to the chosen folder (not an error)',
    await waitFor(() => world.status() === 'Extracted 2 file(s) to the chosen folder') && !world.isError(),
    'status=' + JSON.stringify(world.status()));
  check('(8c) both selected files were written through the fake directory handle with exact bytes',
    fakeDir.log.writes.length === 2 &&
    fakeDir.log.writes.every((w) => DATA[w.path] !== undefined && bytesEq(w.bytes, DATA[w.path])) &&
    deepEq(fakeDir.log.writes.map((w) => w.path).sort(), ['a.txt', 'b.txt']),
    JSON.stringify(fakeDir.log.writes.map((w) => [w.path, [...w.bytes]])));
  check('(8c) selected-to-folder added NOTHING to the downloads list',
    world.byId['downloads'].children.length === 0);

  // Partial write failure mirrors the extract-all-to-folder status contract.
  world.click(world.byId['btn-extract-selected-folder']);
  const msg2 = (await waitFor(() => world.msgOfType('extract').length >= 2))
    ? world.lastMsgOfType('extract') : null;
  check('(8c) a second click re-sends the same sorted selection',
    !!msg2 && deepEq(msg2.paths, ['a.txt', 'b.txt']));
  world.reply({
    id: msg2.id,
    type: 'extract-result',
    files: [
      { path: 'a.txt', data: new Uint8Array([1]) },
      { path: 'broken.txt' } // no data -> counts as unwritable
    ]
  });
  check('(8c) partial failure reports "Extracted 1 file(s); 1 could not be written" as an error',
    await waitFor(() => world.status() === 'Extracted 1 file(s); 1 could not be written') && world.isError(),
    'status=' + JSON.stringify(world.status()));
}

{
  // Selected-to-folder picker dismissal vs failure (mirrors the (5d) contract).
  let rejectWith = null;
  const world = createAppWorld({ pickers: { dir: () => Promise.reject(rejectWith) } }).load();
  const listMsg = await openArchiveViaInput(world, 'test.7z', enc.encode('arc'), 'application/x-7z-compressed');
  world.reply({ id: listMsg.id, type: 'list-result', entries: SEL_ENTRIES });
  await waitFor(() => world.status().includes('entries listed'));
  selToggle(world, selRowBox(world, 2), true); // a.txt
  const statusBefore = world.status();

  const abort = new Error('dismissed');
  abort.name = 'AbortError';
  rejectWith = abort;
  world.click(world.byId['btn-extract-selected-folder']);
  await tick(50);
  check('(8d) AbortError from the selected-folder picker is silent',
    world.status() === statusBefore && !world.isError(),
    'status=' + JSON.stringify(world.status()));

  rejectWith = new Error('no directory access');
  world.click(world.byId['btn-extract-selected-folder']);
  check('(8d) a failed selected-folder picker surfaces the error message',
    await waitFor(() => world.status() === 'no directory access') && world.isError(),
    'status=' + JSON.stringify(world.status()));
  check('(8d) rejected pickers never sent an extract request',
    world.workerMessages.filter((m) => m.msg.type === 'extract').length === 0);
}

{
  // Clear mid-flight for BOTH selected-extraction flows: the late worker
  // reply must hit the void (generation guard).
  const fakeDir = makeFakeDir();
  const world = createAppWorld({
    pickers: { dir: () => Promise.resolve(fakeDir.handle) }
  }).load();

  // Downloads flow.
  let listMsg = await openArchiveViaInput(world, 'test.7z', enc.encode('arc'), 'application/x-7z-compressed');
  world.reply({ id: listMsg.id, type: 'list-result', entries: SEL_ENTRIES });
  await waitFor(() => world.status().includes('entries listed'));
  selToggle(world, selRowBox(world, 1), true); // b.txt
  selToggle(world, selRowBox(world, 2), true); // a.txt
  world.click(world.byId['btn-extract-selected']);
  const gotExtract = await waitFor(() => world.workerMessages.some((m) => m.msg.type === 'extract'));
  check('(8e) extract-selected request is in flight before Clear', gotExtract);
  world.click(world.byId['btn-clear']);
  const inFlight = world.lastMsgOfType('extract');
  world.reply({
    id: inFlight.id,
    type: 'extract-result',
    files: [
      { path: 'a.txt', data: new Uint8Array([1]) },
      { path: 'b.txt', data: new Uint8Array([2]) }
    ]
  });
  await tick(80);
  check('(8e) Clear mid-flight: ZERO downloads added and no status set after the late reply',
    world.byId['downloads'].children.length === 0 && world.status() === '' && !world.isError(),
    'rows=' + world.byId['downloads'].children.length + ' status=' + JSON.stringify(world.status()));

  // Folder flow. Fresh archive NAME on purpose: openArchiveViaInput waits for
  // "a list message with this name", which the first flow's message already
  // satisfies — reusing 'test.7z' would grab the stale request id.
  listMsg = await openArchiveViaInput(world, 'test2.7z', enc.encode('arc'), 'application/x-7z-compressed');
  world.reply({ id: listMsg.id, type: 'list-result', entries: SEL_ENTRIES });
  check('(8e) second archive listed before the selected-to-folder extract',
    await waitFor(() => world.status() === '"test2.7z": 3 entries listed'),
    'status=' + JSON.stringify(world.status()));
  selToggle(world, selRowBox(world, 2), true); // a.txt
  world.click(world.byId['btn-extract-selected-folder']);
  const gotExtract2 = await waitFor(() => world.msgOfType('extract').length >= 2);
  check('(8e) selected-to-folder request is in flight before Clear', gotExtract2);
  world.click(world.byId['btn-clear']);
  const inFlight2 = world.lastMsgOfType('extract');
  world.reply({
    id: inFlight2.id,
    type: 'extract-result',
    files: [{ path: 'a.txt', data: new Uint8Array([1]) }]
  });
  await tick(80);
  check('(8e) Clear mid-flight: ZERO directory writes, zero downloads, no status, no console errors',
    fakeDir.log.order.length === 0 && world.byId['downloads'].children.length === 0 &&
    world.status() === '' && !world.isError() && world.errors.length === 0,
    JSON.stringify({ order: fakeDir.log.order, status: world.status(), errors: world.errors }));
}

/* ----------------------------------------------------------------- report */

console.log('\n' + '-'.repeat(70));
console.log('app-file-handling: ' + passCount + ' passed, ' + failCount + ' failed');
if (failCount > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log('  - ' + failure);
  process.exit(1);
}
console.log('ALL APP FILE-HANDLING TESTS PASSED');
process.exit(0);
