#!/usr/bin/env node
/*
 * app-chunked-render.test.mjs — mock-harness test for the CHUNKED listing
 * render in /home/ubuntu/software/7zip-web/app.js.
 *
 * Runs the REAL app.js inside a vm context with stubbed browser globals
 * (document / window / navigator / Worker / URL / Blob / File / fetch / console
 * + Node's real timers), copied from tests/app-file-handling.test.mjs, and
 * drives renderEntries():
 *
 *   (C1) <= RENDER_CHUNK (500) entries render in ONE synchronous task: no
 *        timer is scheduled at all (N=3, N=500), while N=501 schedules exactly
 *        one setTimeout(..., 0)
 *   (C2) N=1200 renders in 500-row chunks, one per setTimeout(0) tick: exact
 *        chunk count, delay always 0, no requestAnimationFrame, row content
 *        correct AT the chunk boundaries, entryCheckboxes index-aligned with
 *        currentEntries across boundaries, and select-all covering every row
 *   (C3) select-all fired MID-render: rows built by LATER chunks come out
 *        checked, the count label stays truthful per chunk, and the extract
 *        payload carries every path (sorted)
 *   (C4) Clear mid-render kills the chain via renderToken: exactly the pinned
 *        '(no entries)' placeholder row survives, no late chunk ever appends,
 *        selection state resets, and the app stays usable
 *   (C5) a superseding open mid-render: the newer (small) listing wins and the
 *        older chain never appends into it
 *   (C6) N=5000 smoke: full render, correct chunk arithmetic, and worker
 *        messages are still processed WHILE rows stream in (proof the render
 *        yields the main thread instead of blocking it)
 *   (C7) select-all ON then OFF MID-render: the set is cleared and rows built
 *        by later chunks come up UNCHECKED (buildRow consults selectedPaths)
 *   (C8) duplicate paths across a chunk boundary (legal in zip): the later
 *        twin comes up CHECKED when its earlier twin is checked, the
 *        stillClaimed guard keeps the shared key while any twin is checked,
 *        and the extract payload holds the path exactly once (Set-keyed)
 *
 * Usage: node tests/app-chunked-render.test.mjs   (from the repo root)
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

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// Yield to the MICROTASK queue only (no timers run), which is exactly the point
// at which a synchronous renderEntries() has finished: the list-result reply
// resolves the request promise and app.js renders in its .then().
async function flushMicro(hops = 8) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

async function waitFor(pred, timeoutMs = 5000) {
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
  'btn-open-archive': { tag: 'button' },
  'archive-panel': { tag: 'section' },
  'archive-name': { tag: 'span' },
  'entry-select-all': { tag: 'input' },
  'entries-body': { tag: 'tbody' },
  'btn-extract-all': { tag: 'button' },
  'btn-extract-selected': { tag: 'button' },
  'btn-extract-folder': { tag: 'button' },
  'btn-extract-selected-folder': { tag: 'button' },
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
    checked: false,
    indeterminate: false,
    disabled: false,
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
    // Record every timer app.js schedules: renderEntries is the ONLY place in
    // app.js that calls setTimeout, so these are the render-chunk ticks.
    setTimeout(fn, ms, ...rest) {
      world.timerDelays.push(ms);
      return setTimeout(fn, ms, ...rest);
    },
    clearTimeout,
    queueMicrotask
    // NOTE: no requestAnimationFrame on purpose — the chunk scheduler must not
    // depend on one (and must not throttle rendering behind frames).
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
  world.selectAll = () => world.byId['entry-select-all'];
  world.selLabel = () => world.byId['btn-extract-selected'].textContent;
  return world;
}

/* --------------------------------------------------------- flow shortcuts */

function rowBox(world, rowIndex) {
  const tr = world.rows()[rowIndex];
  return tr && tr.children[0] && tr.children[0].children[0];
}
function rowName(world, rowIndex) {
  const tr = world.rows()[rowIndex];
  return tr && tr.children[1] && tr.children[1].textContent;
}
function toggle(world, box, on) {
  box.checked = on;
  world.fire(box, 'change');
}

// A listing of `n` file entries whose lexicographic order is the REVERSE of the
// listing order, so "paths are sorted in the request" stays observable, plus
// one folder at the front when `withFolder`.
function makeEntries(n, withFolder = false) {
  const out = [];
  if (withFolder) {
    out.push({ path: 'zz-folder', size: 0, modified: '2026-01-01 00:00', method: '', isFolder: true, encrypted: false });
  }
  for (let i = 0; i < n; i++) {
    out.push({
      path: 'n' + String(n - i).padStart(6, '0') + '.txt',
      size: 10 + i,
      modified: '2026-02-03 04:05',
      method: 'LZMA2',
      isFolder: false,
      encrypted: false
    });
  }
  return out;
}

const sortedPaths = (entries) => entries.map((e) => e.path).slice().sort();

async function openListing(world, name, entries) {
  const file = new File([enc.encode('bytes-of-' + name)], name, { type: 'application/x-7z-compressed' });
  world.byId['file-input'].files = [file];
  world.fire(world.byId['file-input'], 'change');
  const okList = await waitFor(() => world.msgOfType('list').length >= 1 &&
    world.lastMsgOfType('list').archive && world.lastMsgOfType('list').archive.name === name);
  if (!okList) throw new Error('list request never arrived for ' + name);
  const listEntry = world.lastEntryOfType('list');
  world.reply({ id: listEntry.msg.id, type: 'list-result', entries });
  return listEntry;
}

// Rows rendered so far, without letting a single timer fire.
async function renderedSync(world) {
  await flushMicro();
  return world.rows().length;
}

/* =============== (C1) small listings render in one synchronous task ======= */

section('(C1) N=3 and N=RENDER_CHUNK render synchronously, no timer at all');

{
  const world = createAppWorld().load();
  const small = makeEntries(3);
  await openListing(world, 'small.7z', small);
  check('(C1) N=3: all rows exist before any timer could have fired',
    (await renderedSync(world)) === 3, 'rows=' + world.rows().length);
  check('(C1) N=3: app.js scheduled NO timer (pure synchronous path)',
    world.timerDelays.length === 0, JSON.stringify(world.timerDelays));
  check('(C1) N=3: no placeholder row, five cells per row, checkbox first',
    world.rows().every((tr) => tr.children.length === 5 &&
      tr.children[0].className === 'col-select' &&
      tr.children[0].children[0].className === 'entry-select' &&
      tr.children[0].children[0].type === 'checkbox' &&
      !tr.children[0].children[0].checked) &&
    deepEq(world.rows().map((tr) => tr.children[1].textContent), small.map((e) => e.path)),
    JSON.stringify(world.rows().map((tr) => tr.children[1].textContent)));
  check('(C1) N=3: the checkbox aria-label carries the entry path',
    rowBox(world, 1).getAttribute('aria-label') === 'Select ' + small[1].path,
    JSON.stringify(rowBox(world, 1).getAttribute('aria-label')));
  check('(C1) N=3: status and selection labels are the pinned ones',
    world.status() === '"small.7z": 3 entries listed' && world.selLabel() === 'Extract selected' &&
    world.byId['btn-extract-selected'].disabled === true &&
    world.selectAll().checked === false && world.selectAll().indeterminate === false,
    'status=' + JSON.stringify(world.status()) + ' label=' + JSON.stringify(world.selLabel()));
  await tick(20);
  check('(C1) N=3: still exactly 3 rows after the timers had their chance',
    world.rows().length === 3 && world.timerDelays.length === 0,
    'rows=' + world.rows().length + ' timers=' + JSON.stringify(world.timerDelays));
}

{
  const world = createAppWorld().load();
  const exact = makeEntries(500); // === RENDER_CHUNK
  await openListing(world, 'exact.7z', exact);
  check('(C1) N=500 (exactly RENDER_CHUNK): fully rendered synchronously',
    (await renderedSync(world)) === 500, 'rows=' + world.rows().length);
  check('(C1) N=500: NO timer scheduled — the chunk boundary is inclusive',
    world.timerDelays.length === 0, JSON.stringify(world.timerDelays));
  check('(C1) N=500: the last row is the last entry',
    rowName(world, 499) === exact[499].path, JSON.stringify(rowName(world, 499)));
  await tick(20);
  check('(C1) N=500: nothing more appended later',
    world.rows().length === 500 && world.timerDelays.length === 0, 'rows=' + world.rows().length);
}

{
  const world = createAppWorld().load();
  const over = makeEntries(501); // RENDER_CHUNK + 1
  await openListing(world, 'over.7z', over);
  check('(C1) N=501: the first 500 rows render synchronously, the 501st waits',
    (await renderedSync(world)) === 500, 'rows=' + world.rows().length);
  check('(C1) N=501: exactly one timer, scheduled with delay 0 (no throttling)',
    deepEq(world.timerDelays, [0]), JSON.stringify(world.timerDelays));
  check('(C1) N=501: the overflow row arrives on the next tick',
    await waitFor(() => world.rows().length === 501) && rowName(world, 500) === over[500].path,
    'rows=' + world.rows().length);
  check('(C1) N=501: the finished render schedules no further timer',
    world.timerDelays.length === 1, JSON.stringify(world.timerDelays));
  check('(C1) N=501: status reports the full count',
    world.status() === '"over.7z": 501 entries listed', JSON.stringify(world.status()));
}

/* ======================= (C2) N=1200 chunked, aligned ===================== */

section('(C2) N=1200: 500-row chunks over setTimeout(0), checkboxes aligned');

{
  const world = createAppWorld().load();
  const entries = makeEntries(1200, true); // 1 folder + 1200 files = 1201 rows
  const N = entries.length;
  await openListing(world, 'big.7z', entries);

  check('(C2) chunk 1 (500 rows) is synchronous; the rest is not',
    (await renderedSync(world)) === 500, 'rows=' + world.rows().length);
  check('(C2) the sandbox offers NO requestAnimationFrame (setTimeout only)',
    typeof world.sandbox.requestAnimationFrame === 'undefined' &&
    typeof world.windowStub.requestAnimationFrame === 'undefined');
  check('(C2) the status already reports the FULL listing count',
    world.status() === '"big.7z": ' + N + ' entries listed', JSON.stringify(world.status()));
  check('(C2) the selection UI is live while rows stream in',
    world.selectAll().indeterminate === false && world.selLabel() === 'Extract selected',
    JSON.stringify(world.selLabel()));

  // Mid-render interaction: the already-built rows work normally.
  toggle(world, rowBox(world, 0), true); // the folder row
  check('(C2) a chunk-1 checkbox toggles the count label immediately',
    world.selLabel() === 'Extract selected (1)' && world.selectAll().indeterminate === true,
    JSON.stringify(world.selLabel()));

  const okFull = await waitFor(() => world.rows().length === N);
  check('(C2) all ' + N + ' rows eventually render', okFull, 'rows=' + world.rows().length);
  check('(C2) exactly ceil(N/500)-1 = 2 chunk timers, all with delay 0',
    deepEq(world.timerDelays, [0, 0]), JSON.stringify(world.timerDelays));
  check('(C2) rows are in listing order with the right cells at the boundaries',
    rowName(world, 0) === 'zz-folder/' &&
    rowName(world, 499) === entries[499].path &&
    rowName(world, 500) === entries[500].path &&
    rowName(world, 501) === entries[501].path &&
    rowName(world, N - 1) === entries[N - 1].path &&
    world.rows()[0].className === 'folder' && world.rows()[1].className === '',
    JSON.stringify([rowName(world, 0), rowName(world, 499), rowName(world, 500), rowName(world, N - 1)]));
  check('(C2) the size cell is humanised for a row built by a LATER chunk',
    world.rows()[1000].children[2].textContent === ((10 + 999) < 1024 ? (10 + 999) + ' B' : '1.0 KiB') &&
    world.rows()[0].children[2].textContent === '—',
    JSON.stringify([world.rows()[1000].children[2].textContent, world.rows()[0].children[2].textContent]));

  // entryCheckboxes must stay index-aligned with currentEntries ACROSS chunks:
  // checking rows on both sides of every boundary selects exactly those paths.
  const probes = [1, 499, 500, 501, 999, 1000, N - 1];
  for (const i of probes) toggle(world, rowBox(world, i), true);
  check('(C2) checking rows across chunk boundaries counts them all',
    world.selLabel() === 'Extract selected (' + (probes.length + 1) + ')',
    JSON.stringify(world.selLabel()));

  world.click(world.byId['btn-extract-selected']);
  const okExt = await waitFor(() => world.msgOfType('extract').length >= 1);
  const expected = sortedPaths([entries[0]].concat(probes.map((i) => entries[i])));
  const sent = okExt ? world.lastMsgOfType('extract').paths : null;
  check('(C2) the extract payload is the SORTED paths of exactly the checked rows',
    okExt && deepEq(sent, expected),
    JSON.stringify({ sent: sent && sent.slice(0, 4), expected: expected.slice(0, 4), n: sent && sent.length }));
  world.reply({
    id: world.lastMsgOfType('extract').id,
    type: 'extract-result',
    files: [{ path: expected[0], data: new Uint8Array([1, 2, 3]) }]
  });
  check('(C2) the boundary-check extract completes with the pinned status',
    await waitFor(() => world.status() === 'Extracted 1 file(s) from "big.7z"') && !world.isError(),
    'status=' + JSON.stringify(world.status()));

  // Select-all after the full render: every row checkbox flips, count = N.
  world.selectAll().checked = true;
  world.fire(world.selectAll(), 'change');
  check('(C2) select-all checks all ' + N + ' rows and the label says so',
    world.selLabel() === 'Extract selected (' + N + ')' &&
    world.rows().every((tr) => tr.children[0].children[0].checked === true) &&
    world.selectAll().checked === true && world.selectAll().indeterminate === false,
    'label=' + JSON.stringify(world.selLabel()));
  world.click(world.byId['btn-extract-selected']);
  const okAll = await waitFor(() => world.msgOfType('extract').length >= 2);
  check('(C2) select-all extracts every entry, sorted',
    okAll && deepEq(world.lastMsgOfType('extract').paths, sortedPaths(entries)),
    'n=' + (world.lastMsgOfType('extract').paths || []).length);
  check('(C2) no console errors during the chunked render',
    world.errors.length === 0, JSON.stringify(world.errors));
}

/* ==================== (C3) select-all fired MID-render ==================== */

section('(C3) select-all mid-render: later chunks come out checked');

{
  const world = createAppWorld().load();
  const entries = makeEntries(1200);
  const N = entries.length;
  await openListing(world, 'midselect.7z', entries);
  check('(C3) only chunk 1 is on screen when select-all fires',
    (await renderedSync(world)) === 500, 'rows=' + world.rows().length);

  world.selectAll().checked = true;
  world.fire(world.selectAll(), 'change');
  check('(C3) the whole listing is selected at once (currentEntries is complete)',
    world.selLabel() === 'Extract selected (' + N + ')' &&
    world.rows().every((tr) => tr.children[0].children[0].checked === true),
    'label=' + JSON.stringify(world.selLabel()) + ' rows=' + world.rows().length);

  const okFull = await waitFor(() => world.rows().length === N);
  check('(C3) every LATER chunk row is built already checked',
    okFull && world.rows().every((tr) => tr.children[0].children[0].checked === true) &&
    world.selLabel() === 'Extract selected (' + N + ')',
    'rows=' + world.rows().length + ' label=' + JSON.stringify(world.selLabel()));
  check('(C3) select-all stays fully checked after the stream finished',
    world.selectAll().checked === true && world.selectAll().indeterminate === false);

  world.click(world.byId['btn-extract-selected']);
  const okExt = await waitFor(() => world.msgOfType('extract').length >= 1);
  check('(C3) the mid-render select-all yields all ' + N + ' sorted paths',
    okExt && deepEq(world.lastMsgOfType('extract').paths, sortedPaths(entries)),
    'n=' + ((world.lastMsgOfType('extract') || {}).paths || []).length);
  check('(C3) the chunk arithmetic is unchanged by the mid-render select-all',
    deepEq(world.timerDelays, [0, 0]), JSON.stringify(world.timerDelays));

  // Unchecking one row of a LATE chunk must drop exactly its own path.
  const late = N - 1;
  toggle(world, rowBox(world, late), false);
  check('(C3) unchecking a late-chunk row decrements the count by one',
    world.selLabel() === 'Extract selected (' + (N - 1) + ')',
    JSON.stringify(world.selLabel()));
  world.reply({
    id: world.lastMsgOfType('extract').id,
    type: 'extract-result',
    files: [{ path: entries[0].path, data: new Uint8Array([1]) }]
  });
  check('(C3) the mid-render select-all extract completes with the pinned status',
    await waitFor(() => world.status() === 'Extracted 1 file(s) from "midselect.7z"') && !world.isError(),
    'status=' + JSON.stringify(world.status()));
  world.click(world.byId['btn-extract-selected']);
  const okExt2 = await waitFor(() => world.msgOfType('extract').length >= 2);
  const expected2 = sortedPaths(entries).filter((p) => p !== entries[late].path);
  check('(C3) the late-chunk uncheck is reflected in the payload',
    okExt2 && deepEq(world.lastMsgOfType('extract').paths, expected2),
    'n=' + ((world.lastMsgOfType('extract') || {}).paths || []).length);
}

/* ========================== (C4) Clear mid-render ========================= */

section('(C4) Clear mid-render: the token kills the chunk chain');

{
  const world = createAppWorld().load();
  const entries = makeEntries(1200);
  await openListing(world, 'clearme.7z', entries);
  check('(C4) a partial render is on screen before Clear',
    (await renderedSync(world)) === 500 && deepEq(world.timerDelays, [0]),
    'rows=' + world.rows().length + ' timers=' + JSON.stringify(world.timerDelays));
  toggle(world, rowBox(world, 3), true);
  check('(C4) a selection exists to be thrown away', world.selLabel() === 'Extract selected (1)');

  world.click(world.byId['btn-clear']);
  check('(C4) Clear replaces the partial table with the pinned placeholder row',
    world.rows().length === 1 && world.rows()[0].children.length === 1 &&
    world.rows()[0].children[0].colSpan === 5 &&
    world.rows()[0].children[0].textContent === '(no entries)',
    'rows=' + world.rows().length + ' first=' + JSON.stringify(world.rows()[0] && world.rows()[0].children.map((c) => c.textContent)));
  check('(C4) Clear resets the selection UI and the status',
    world.selLabel() === 'Extract selected' && world.byId['btn-extract-selected'].disabled === true &&
    world.selectAll().checked === false && world.selectAll().indeterminate === false &&
    world.status() === '' && !world.isError(),
    'label=' + JSON.stringify(world.selLabel()) + ' status=' + JSON.stringify(world.status()));
  check('(C4) Clear itself schedules no timer (empty listing short-circuits)',
    world.timerDelays.length === 1, JSON.stringify(world.timerDelays));

  await tick(60); // let the pending chunk timer fire
  check('(C4) the killed chain appends NOTHING later — still one placeholder row',
    world.rows().length === 1 && world.rows()[0].children[0].textContent === '(no entries)' &&
    world.timerDelays.length === 1,
    'rows=' + world.rows().length + ' timers=' + JSON.stringify(world.timerDelays));
  check('(C4) no late updateSelectionUI resurrected a count',
    world.selLabel() === 'Extract selected' && world.selectAll().indeterminate === false,
    JSON.stringify(world.selLabel()));

  // And the app is still usable afterwards.
  const again = makeEntries(3);
  await openListing(world, 'after-clear.7z', again);
  check('(C4) a fresh listing renders normally after the killed one',
    (await renderedSync(world)) === 3 &&
    world.byId['archive-name'].textContent === 'after-clear.7z' &&
    world.status() === '"after-clear.7z": 3 entries listed' &&
    deepEq(world.rows().map((tr) => tr.children[1].textContent), again.map((e) => e.path)),
    'rows=' + world.rows().length + ' status=' + JSON.stringify(world.status()));
  check('(C4) no console errors', world.errors.length === 0, JSON.stringify(world.errors));
}

/* ====================== (C5) superseded open mid-render =================== */

section('(C5) a newer open mid-render wins; the older chain appends nothing');

{
  const world = createAppWorld().load();
  const big = makeEntries(1200);
  await openListing(world, 'a.7z', big);
  check('(C5) archive A is mid-render with 500 of 1201 rows on screen',
    (await renderedSync(world)) === 500, 'rows=' + world.rows().length);

  const smallEntries = makeEntries(3, true); // 4 rows
  await openListing(world, 'b.7z', smallEntries);
  check('(C5) archive B\'s small listing renders synchronously',
    (await renderedSync(world)) === 4 &&
    world.byId['archive-name'].textContent === 'b.7z' &&
    world.status() === '"b.7z": 4 entries listed',
    'rows=' + world.rows().length + ' status=' + JSON.stringify(world.status()));
  check('(C5) A\'s pending chunk timer is dead: B\'s rows only',
    deepEq(world.rows().map((tr) => tr.children[1].textContent),
      ['zz-folder/'].concat(smallEntries.slice(1).map((e) => e.path))),
    JSON.stringify(world.rows().map((tr) => tr.children[1].textContent)));

  await tick(60);
  check('(C5) after the timers fire, B\'s table is still exactly 4 rows',
    world.rows().length === 4 && world.status() === '"b.7z": 4 entries listed',
    'rows=' + world.rows().length);
  check('(C5) A\'s single pending chunk timer is dead; B scheduled none',
    deepEq(world.timerDelays, [0]), JSON.stringify(world.timerDelays));
  check('(C5) B\'s selection state is clean and usable',
    world.selLabel() === 'Extract selected' && world.selectAll().indeterminate === false &&
    rowBox(world, 2).checked === false,
    JSON.stringify(world.selLabel()));
  toggle(world, rowBox(world, 2), true);
  world.click(world.byId['btn-extract-selected']);
  const okExt = await waitFor(() => world.msgOfType('extract').length >= 1);
  check('(C5) B\'s row indexes map to B\'s entries (no stale alignment)',
    okExt && deepEq(world.lastMsgOfType('extract').paths, [smallEntries[2].path]),
    JSON.stringify(world.lastMsgOfType('extract') && world.lastMsgOfType('extract').paths));
  check('(C5) no console errors', world.errors.length === 0, JSON.stringify(world.errors));
}

/* ============================== (C6) N=5000 smoke ========================= */

section('(C6) N=5000 smoke: full render, main thread stays responsive');

{
  const world = createAppWorld().load();
  const entries = makeEntries(5000);
  const N = entries.length;
  const listEntry = await openListing(world, 'huge.7z', entries);
  check('(C6) the first chunk lands synchronously',
    (await renderedSync(world)) === 500, 'rows=' + world.rows().length);

  // A worker message is processed WHILE rows are still streaming in: the
  // render yields the thread instead of holding it.
  world.reply({ id: listEntry.msg.id, type: 'progress', line: 'mid-render progress line' });
  check('(C6) a progress line is rendered mid-stream (UI not blocked)',
    world.byId['progress-output'].textContent.includes('mid-render progress line') &&
    world.rows().length === 500,
    'rows=' + world.rows().length + ' progress=' + JSON.stringify(world.byId['progress-output'].textContent));

  const t0 = Date.now();
  const okFull = await waitFor(() => world.rows().length === N, 20000);
  const elapsed = Date.now() - t0;
  check('(C6) all ' + N + ' rows render', okFull, 'rows=' + world.rows().length);
  check('(C6) chunk arithmetic: ceil(5000/500)-1 = 9 timers, all delay 0',
    world.timerDelays.length === 9 && world.timerDelays.every((d) => d === 0),
    JSON.stringify({ count: world.timerDelays.length, delays: [...new Set(world.timerDelays)] }));
  check('(C6) the render really spanned multiple event-loop turns',
    elapsed >= 5, 'elapsedMs=' + elapsed);
  check('(C6) first, middle and last rows are correct',
    rowName(world, 0) === entries[0].path && rowName(world, 2500) === entries[2500].path &&
    rowName(world, N - 1) === entries[N - 1].path,
    JSON.stringify([rowName(world, 0), rowName(world, 2500), rowName(world, N - 1)]));
  check('(C6) status and labels are consistent at the end',
    world.status() === '"huge.7z": ' + N + ' entries listed' && world.selLabel() === 'Extract selected',
    'status=' + JSON.stringify(world.status()));

  // Select-all on a fully streamed 5000-row table, then extract.
  world.selectAll().checked = true;
  world.fire(world.selectAll(), 'change');
  check('(C6) select-all counts all ' + N + ' rows',
    world.selLabel() === 'Extract selected (' + N + ')', JSON.stringify(world.selLabel()));
  world.click(world.byId['btn-extract-selected']);
  const okExt = await waitFor(() => world.msgOfType('extract').length >= 1);
  const sent = okExt ? world.lastMsgOfType('extract').paths : [];
  check('(C6) the payload holds all ' + N + ' paths in sorted order',
    okExt && sent.length === N && deepEq(sent, sortedPaths(entries)),
    'n=' + sent.length + ' first=' + JSON.stringify(sent[0]));
  check('(C6) no console errors', world.errors.length === 0, JSON.stringify(world.errors));
}

/* ================== (C7) select-all OFF mid-render ======================== */

section('(C7) select-all ON then OFF mid-render: later rows come up unchecked');

{
  const world = createAppWorld().load();
  const entries = makeEntries(1200);
  const N = entries.length;
  await openListing(world, 'offmid.7z', entries);
  check('(C7) only chunk 1 is on screen before the select-all churn',
    (await renderedSync(world)) === 500, 'rows=' + world.rows().length);

  world.selectAll().checked = true;
  world.fire(world.selectAll(), 'change');
  check('(C7) select-all ON mid-render selects all ' + N + ' unique paths at once',
    world.selLabel() === 'Extract selected (' + N + ')', JSON.stringify(world.selLabel()));

  world.selectAll().checked = false;
  world.fire(world.selectAll(), 'change');
  check('(C7) select-all OFF clears the set and unchecks every rendered row',
    world.rows().every((tr) => tr.children[0].children[0].checked === false) &&
    world.selLabel() === 'Extract selected' &&
    world.byId['btn-extract-selected'].disabled === true,
    JSON.stringify(world.selLabel()));
  check('(C7) the render is still mid-flight at that point',
    world.rows().length === 500, 'rows=' + world.rows().length);

  const okFull = await waitFor(() => world.rows().length === N);
  check('(C7) every LATER-chunk row is built UNCHECKED (selectedPaths is the source)',
    okFull && world.rows().every((tr) => tr.children[0].children[0].checked === false),
    'rows=' + world.rows().length);
  check('(C7) final selection UI: no count, select-all off, indeterminate off',
    world.selLabel() === 'Extract selected' && world.selectAll().checked === false &&
    world.selectAll().indeterminate === false && world.byId['btn-extract-selected'].disabled === true,
    JSON.stringify(world.selLabel()));
  check('(C7) the chunk arithmetic is unchanged: ceil(1200/500)-1 = 2 timers, delay 0',
    deepEq(world.timerDelays, [0, 0]), JSON.stringify(world.timerDelays));

  world.click(world.byId['btn-extract-selected']);
  await tick(40);
  check('(C7) clicking extract-selected on the empty selection sends nothing',
    world.msgOfType('extract').length === 0,
    JSON.stringify(world.workerMessages.map((m) => m.msg.type)));
  check('(C7) no console errors', world.errors.length === 0, JSON.stringify(world.errors));
}

/* ============ (C8) duplicate paths across a chunk boundary ================ */

section('(C8) duplicate paths across chunks: Set-keyed selection model');

{
  const world = createAppWorld().load();
  const entries = makeEntries(1200);
  // Two twins with the SAME path in different chunks (index 100 -> chunk 1,
  // index 700 -> chunk 2). Duplicate paths are legal in e.g. zip listings and
  // the selection model is a Set keyed by path.
  entries[100].path = 'dup.txt';
  entries[700].path = 'dup.txt';
  const N = entries.length;
  await openListing(world, 'dupes.7z', entries);
  check('(C8) chunk 1 renders with the first twin in it',
    (await renderedSync(world)) === 500 && rowName(world, 100) === 'dup.txt',
    'rows=' + world.rows().length);

  toggle(world, rowBox(world, 100), true);
  check('(C8) checking the first twin counts the path once',
    world.selLabel() === 'Extract selected (1)', JSON.stringify(world.selLabel()));

  const okFull = await waitFor(() => world.rows().length === N);
  check('(C8) the later-chunk twin is BUILT CHECKED (buildRow consults selectedPaths)',
    okFull && rowBox(world, 700).checked === true && rowBox(world, 100).checked === true,
    'late=' + (rowBox(world, 700) || {}).checked);
  check('(C8) the label counts the UNIQUE path: still (1) with two checked twins',
    world.selLabel() === 'Extract selected (1)', JSON.stringify(world.selLabel()));

  toggle(world, rowBox(world, 700), false);
  check('(C8) unchecking the later twin while the earlier is checked KEEPS the path',
    world.selLabel() === 'Extract selected (1)', JSON.stringify(world.selLabel()));
  toggle(world, rowBox(world, 700), true);
  toggle(world, rowBox(world, 100), false);
  check('(C8) mirrored: the later twin keeps the path claimed across the boundary',
    world.selLabel() === 'Extract selected (1)', JSON.stringify(world.selLabel()));
  toggle(world, rowBox(world, 700), false);
  check('(C8) with the last checked twin gone the path drops out',
    world.selLabel() === 'Extract selected' && world.byId['btn-extract-selected'].disabled === true,
    JSON.stringify(world.selLabel()));

  // Payload: both twins + one unique row -> the Set-keyed model sends the
  // duplicate path exactly ONCE.
  toggle(world, rowBox(world, 100), true);
  toggle(world, rowBox(world, 700), true);
  toggle(world, rowBox(world, N - 1), true);
  check('(C8) two twins + one unique row count as TWO unique paths',
    world.selLabel() === 'Extract selected (2)', JSON.stringify(world.selLabel()));
  world.click(world.byId['btn-extract-selected']);
  const okExt = await waitFor(() => world.msgOfType('extract').length >= 1);
  const expected = ['dup.txt', entries[N - 1].path].sort();
  check('(C8) the extract payload holds "dup.txt" exactly once, sorted with the unique path',
    okExt && deepEq(world.lastMsgOfType('extract').paths, expected),
    JSON.stringify(okExt && world.lastMsgOfType('extract').paths));
  world.reply({
    id: world.lastMsgOfType('extract').id,
    type: 'extract-result',
    files: [{ path: 'dup.txt', data: new Uint8Array([1]) }]
  });
  check('(C8) the pinned success status completes the flow',
    await waitFor(() => world.status() === 'Extracted 1 file(s) from "dupes.7z"') && !world.isError(),
    'status=' + JSON.stringify(world.status()));
  check('(C8) no console errors', world.errors.length === 0, JSON.stringify(world.errors));
}

/* ---------------------------------------------------------------- summary */

console.log('');
console.log(`${passCount} passed, ${failCount} failed`);
if (failCount) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
}
console.log(failCount ? 'RESULT: FAIL' : 'ALL APP CHUNKED-RENDER TESTS PASSED');
process.exitCode = failCount ? 1 : 0;
