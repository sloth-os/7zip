/*
 * worker-stage-cache.test.mjs — Node integration test for the STAGE-ONCE
 * archive cache, the keyed extract/test protocol, the fire-and-forget 'evict'
 * message and the listing-validated coverage fallback in <repo>/worker.js,
 * driven against the REAL 7zz wasm build shipped in <repo>/wasm.
 *
 * Harness copied from tests/worker-integration.mjs: a vm context stubs the
 * Worker environment exactly per the contract (self.onmessage / self.postMessage
 * / importScripts / self.location / fetch / console), the emscripten factory is
 * wrapped transparently so `engineModule` exposes Module.FS for MEMFS
 * assertions, and fixtures are built with the worker's own 'compress' op. The
 * empty-directory fixture comes from tests/make-dir-archive-fixture.mjs (run as
 * a child process, output under /tmp/7zip-perf/test-fixtures).
 *
 * Covered (§7.3):
 *   1  stage-once: keyed list creates /arc/<seq>, cleans /job<id>, no 'raw'
 *   2  cache hit: keyed extract/test with NO bytes, byte-identical, no churn
 *   3  unknown key: extract/test/non-string keys, worker keeps serving
 *   4  eviction: staging a second key evicts the first
 *   5  {type:'evict'}: no reply at all, /arc gone, legacy still works
 *   6  legacy coexistence: byte jobs never evict the keyed cache
 *   7  fallback skip (absent path): ONE engine run keyed, TWO legacy
 *   8  fallback skip (empty directory): one run, zero files, no error
 *   9  no wrong skip: a present-but-FILTERED-missed path still re-runs
 *  10  mixed coverage: one present + one absent -> re-run, real file only
 *  11  zip: keyed list + keyed subset extract
 *  12  password/key interplay with -mhe=on
 *  13  defensive FS.stat: a vanished staged file drops the map entry
 *  14  keyed requests IGNORE archive bytes carried alongside the key, and an
 *      unknown key never falls back to legacy staging (§1.2 precedence)
 *  15  list precedence: ''/non-string keys stay legacy (no stage, no evict);
 *      a key WITHOUT bytes keeps 'request is missing the archive payload'
 *      (a list never produces an unknown-key error)
 *  16  a FAILED staging list evicted the previous key first (evict-before-
 *      write order) and its bytes remain staged with a null listing
 *  17  an evict posted mid-job runs only AFTER the job completed; evict on an
 *      empty store posts nothing and the worker stays healthy
 *  18  backslash-spelled selection: the listing index says "maybe present" ->
 *      FULL re-run happens; keyed and legacy results are identical (§5)
 *  19  case-variant selection: provably absent -> skip is RESULT-IDENTICAL
 *      (keyed 1 run, legacy 2 runs, both zero files — no case folding, §5)
 *
 * Run-count evidence: one 'Everything is Ok' progress line per 7zz extract
 * invocation, counted in res.related.
 *
 * Run: node tests/worker-stage-cache.test.mjs   (from the repo root; any cwd)
 * Prints "SKIPPED (wasm not built)" and exits 0 when <repo>/wasm is missing.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TESTS_DIR, '..');
const require_ = createRequire(import.meta.url);

const WASM_DIR = path.join(REPO, 'wasm');
const WORKER_JS = path.join(REPO, 'worker.js');
const FIXTURE_DIR = '/tmp/7zip-perf/test-fixtures';
const JOB_TIMEOUT_MS = 120000;

if (!fs.existsSync(path.join(WASM_DIR, '7zz.js')) || !fs.existsSync(path.join(WASM_DIR, '7zz.wasm'))) {
  console.log('SKIPPED (wasm not built)');
  process.exit(0);
}

// ---------------------------------------------------------------- harness ---

const wasmFileBytes = fs.readFileSync(path.join(WASM_DIR, '7zz.wasm'));
// Exact-sized ArrayBuffer (Node Buffers can be pooled views!).
const wasmArrayBuffer = wasmFileBytes.buffer.slice(
  wasmFileBytes.byteOffset,
  wasmFileBytes.byteOffset + wasmFileBytes.byteLength
);

const messages = []; // every worker -> main message: { msg, transfer }
function capturePostMessage(msg, transfer) {
  messages.push({ msg, transfer });
}

let engineModule = null;

const selfObj = {
  location: new URL('file://' + WORKER_JS),
  postMessage: capturePostMessage,
  onmessage: null,
};

const sandbox = {
  self: selfObj,
  importScripts(p) {
    const mapped = String(p).replace('./wasm/', WASM_DIR + '/');
    const factory = require_(mapped);
    sandbox.create7zip = function (...args) {
      const pr = factory(...args);
      Promise.resolve(pr).then(
        (mod) => {
          engineModule = mod;
        },
        () => {}
      );
      return pr;
    };
  },
  fetch: async (url) => {
    const u = String((url && url.href) || url);
    if (u.includes('7zz.wasm') || u.includes('/wasm/')) {
      return { ok: true, status: 200, arrayBuffer: async () => wasmArrayBuffer };
    }
    return {
      ok: false,
      status: 404,
      arrayBuffer: async () => {
        throw new Error('not found: ' + u);
      },
    };
  },
  postMessage: capturePostMessage,
  console,
  URL,
  TextEncoder,
  TextDecoder,
  require: require_,
  setTimeout,
  clearTimeout,
  Promise,
  ArrayBuffer,
  Uint8Array,
};

const context = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(WORKER_JS, 'utf8'), context, { filename: WORKER_JS });

// ------------------------------------------------------------ test plumbing ---

const results = [];
function assert(cond, what) {
  if (!cond) throw new Error('assertion failed: ' + what);
}

async function runScenario(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e });
    console.log(`FAIL  ${name}`);
    console.log('      ' + String(e && e.message ? e.message : e).split('\n').join('\n      '));
  }
}

let idCounter = 0;
function nextId() {
  return ++idCounter;
}

function sendAndWait(msg, terminalTypes, timeoutMs = JOB_TIMEOUT_MS) {
  const startIdx = messages.length;
  context.self.onmessage({ data: msg });
  return waitTerminal(msg.id, terminalTypes, startIdx, timeoutMs);
}

function waitTerminal(id, terminalTypes, startIdx, timeoutMs = JOB_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      for (let i = startIdx; i < messages.length; i++) {
        const m = messages[i].msg;
        if (m && m.id === id && terminalTypes.includes(m.type)) {
          clearInterval(timer);
          resolve({
            index: i,
            response: m,
            transfer: messages[i].transfer,
            related: messages.slice(startIdx, i + 1).filter((x) => x.msg && x.msg.id === id),
          });
        }
      }
      if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        const seen = messages
          .slice(startIdx)
          .map((x) => (x.msg ? `${x.msg.id}:${x.msg.type}` : '?'))
          .join(', ');
        reject(new Error(`timeout waiting for [${terminalTypes}] on id ${id}; saw: ${seen}`));
      }
    }, 5);
  });
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function assertJobDirCleaned(id) {
  if (!engineModule) return;
  const p = engineModule.FS.analyzePath('/job' + id);
  assert(!p.exists, `MEMFS job dir /job${id} removed after job finished`);
}

const enc = new TextEncoder();

function bufOf(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}
function asBuffer(ab) {
  return Buffer.from(new Uint8Array(ab));
}

// One 'Everything is Ok' progress line per 7zz extract invocation.
function engineRuns(res) {
  return res.related.filter(
    (x) => x.msg.type === 'progress' && String(x.msg.line).trim() === 'Everything is Ok'
  ).length;
}

// Children of the persistent /arc store (null when /arc does not exist).
function arcChildren() {
  if (!engineModule) return null;
  const FS = engineModule.FS;
  if (!FS.analyzePath('/arc').exists) return null;
  return FS.readdir('/arc').filter((n) => n !== '.' && n !== '..');
}

function arcExists() {
  return !!engineModule && engineModule.FS.analyzePath('/arc').exists;
}

function rootJobDirs() {
  if (!engineModule) return [];
  return engineModule.FS.readdir('/').filter((n) => /^job\d+$/.test(n));
}

// The single staged file path under /arc (throws when there is not exactly one).
function stagedPath() {
  const dirs = arcChildren();
  assert(Array.isArray(dirs) && dirs.length === 1, `exactly one staged dir (got ${JSON.stringify(dirs)})`);
  const files = engineModule.FS.readdir('/arc/' + dirs[0]).filter((n) => n !== '.' && n !== '..');
  assert(files.length === 1, `exactly one staged file (got ${JSON.stringify(files)})`);
  return '/arc/' + dirs[0] + '/' + files[0];
}

// ------------------------------------------------------------- fixture helpers ---

// Build a fixture archive with the worker's OWN compress op (level 1: these
// suites assert protocol and run counts, not compression ratio).
async function compressFixture(files, archiveName, format, opts = {}) {
  const id = nextId();
  const msg = {
    id,
    type: 'compress',
    files: files.map((f) => ({ path: f.path, data: bufOf(f.data) })),
    archiveName,
    format: format || '7z',
    level: '1',
  };
  if (opts.password !== undefined) {
    msg.password = opts.password;
    msg.encryptHeaders = !!opts.encryptHeaders;
  }
  const res = await sendAndWait(msg, ['compress-result', 'error']);
  if (res.response.type === 'error') throw new Error('compress failed: ' + res.response.message);
  assert(res.response.archive.name === archiveName, 'compress-result archive name');
  assertJobDirCleaned(id);
  return res.response.archive.data;
}

// Staging list: the ONLY request that carries bytes, and the one that creates
// the worker-side cache entry for `key`.
async function stageKeyed(key, name, bytes, password) {
  const id = nextId();
  const msg = { id, type: 'list', archive: { name, data: bytes }, archiveKey: key };
  if (password !== undefined) msg.password = password;
  const res = await sendAndWait(msg, ['list-result', 'error']);
  if (res.response.type === 'error') throw new Error('staging list failed: ' + res.response.message);
  assertJobDirCleaned(id);
  return { id, res };
}

async function keyedExtract(key, opts = {}) {
  const id = nextId();
  const msg = { id, type: 'extract', archiveKey: key };
  if ('paths' in opts) msg.paths = opts.paths;
  if (opts.password !== undefined) msg.password = opts.password;
  const res = await sendAndWait(msg, ['extract-result', 'error']);
  assertJobDirCleaned(id);
  return { id, res };
}

function filesOf(res) {
  const byPath = new Map();
  for (const f of res.response.files || []) byPath.set(f.path, asBuffer(f.data));
  return byPath;
}

// Empty-directory fixture built by the repo helper (standalone wasm engine,
// child process) — the compress protocol can only write files, never a bare
// directory entry.
function buildDirFixture() {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const arc = path.join(FIXTURE_DIR, 'with-dirs.7z');
  const meta = path.join(FIXTURE_DIR, 'with-dirs.meta.json');
  try {
    fs.rmSync(arc, { force: true });
    fs.rmSync(meta, { force: true });
  } catch (ignored) {}
  const r = spawnSync(
    process.execPath,
    [path.join(TESTS_DIR, 'make-dir-archive-fixture.mjs'), arc, meta],
    { encoding: 'utf8', cwd: REPO }
  );
  if (r.status !== 0 || !fs.existsSync(arc) || !fs.existsSync(meta)) {
    throw new Error(
      'make-dir-archive-fixture.mjs failed (status ' + r.status + '): ' +
      String(r.stderr || r.stdout || '').slice(0, 600)
    );
  }
  const nodeBuf = fs.readFileSync(arc);
  const bytes = nodeBuf.buffer.slice(nodeBuf.byteOffset, nodeBuf.byteOffset + nodeBuf.byteLength);
  return { bytes, meta: JSON.parse(fs.readFileSync(meta, 'utf8')) };
}

// ------------------------------------------------------------- scenarios ---

assert(typeof context.self.onmessage === 'function', 'worker.js assigns self.onmessage');

await runScenario('init -> ready', async () => {
  const id = nextId();
  const res = await sendAndWait({ id, type: 'init' }, ['ready', 'error']);
  assert(res.response.type === 'ready', "expected {type:'ready'}");
  assert(engineModule && typeof engineModule.callMain === 'function', 'engine Module initialized');
  assert(!arcExists(), '/arc does not exist before any staging list');
});

// Fixtures. `hostile.7z` carries a control-char name: the engine LISTS it
// sanitized ('cr.txt_' for a stored 'cr.txt\r') but EXTRACTS it under its real
// name, so the listed path is present in the archive yet missed by a FILTERED
// 7zz run — exactly the case the listing cache must NOT skip.
const contentA = enc.encode('Hello from the stage-cache test!\n'.repeat(20));
const contentB = enc.encode('Nested payload with unicode: ünicode ✓ 7-Zip\n'.repeat(20));
const contentCr = enc.encode('control-char payload, listed sanitized\n');

const PLAIN_FIXTURE = [
  { path: 'hello.txt', data: contentA },
  { path: 'sub/nested.txt', data: contentB },
];
const HOSTILE_FIXTURE = [
  { path: 'plain.txt', data: contentA },
  { path: 'cr.txt\r', data: contentCr },
  { path: 'sub/inner.txt', data: contentB },
];

let plainBytes = null;
let hostileBytes = null;
let zipBytes = null;
let secretBytes = null;

await runScenario('fixtures: compress plain / hostile-name / zip / header-encrypted archives', async () => {
  plainBytes = await compressFixture(PLAIN_FIXTURE, 'plain.7z', '7z');
  hostileBytes = await compressFixture(HOSTILE_FIXTURE, 'hostile.7z', '7z');
  zipBytes = await compressFixture(PLAIN_FIXTURE, 'bundle.zip', 'zip');
  secretBytes = await compressFixture(PLAIN_FIXTURE, 'secret.7z', '7z', {
    password: 'hunter2',
    encryptHeaders: true,
  });
  assert(asBuffer(plainBytes).byteLength > 32, 'plain fixture non-trivial');
  assert(asBuffer(zipBytes).subarray(0, 2).equals(Buffer.from([0x50, 0x4b])), 'zip PK signature');
  assert(asBuffer(secretBytes).subarray(0, 2).equals(Buffer.from([0x37, 0x7a])), '7z signature');
  // The control-char entry must have survived compress, and the listing must
  // sanitize it — the whole of scenario 9 depends on that.
  const lid = nextId();
  const lres = await sendAndWait(
    { id: lid, type: 'list', archive: { name: 'hostile.7z', data: hostileBytes } },
    ['list-result', 'error']
  );
  assert(lres.response.type === 'list-result', 'hostile fixture lists: ' + lres.response.message);
  const paths = lres.response.entries.filter((e) => !e.isFolder).map((e) => e.path).sort();
  assert(
    paths.includes('cr.txt_') && !paths.some((p) => p.includes('\r')),
    `listing sanitizes the control char (got ${JSON.stringify(paths)})`
  );
  assertJobDirCleaned(lid);
});

await runScenario('1 stage-once: keyed list stages under /arc, cleans /job<id>, drops raw', async () => {
  const { id, res } = await stageKeyed('key-1', 'plain.7z', plainBytes);
  assert(arcExists(), '/arc exists after a staging list');
  const dirs = arcChildren();
  assert(dirs.length === 1, `exactly one dir under /arc (got ${JSON.stringify(dirs)})`);
  const arcPath = stagedPath();
  assert(arcPath.endsWith('/plain.7z'), `staged file keeps the archive base name (${arcPath})`);
  assert(
    asBuffer(engineModule.FS.readFile(arcPath)).equals(Buffer.from(asBuffer(plainBytes))),
    'staged bytes are byte-identical to the request payload'
  );
  assertJobDirCleaned(id);
  assert(rootJobDirs().length === 0, `no /job* dirs left in / (got ${JSON.stringify(rootJobDirs())})`);
  assert(res.response.raw === undefined, 'list-result no longer carries raw');
  const listed = res.response.entries.filter((e) => !e.isFolder).map((e) => e.path).sort();
  assert(
    listed.length === 2 && listed[0] === 'hello.txt' && listed[1] === 'sub/nested.txt',
    `entries parsed from the STAGED path (got ${JSON.stringify(listed)})`
  );
});

await runScenario('2 cache hit: keyed extract/test with NO bytes at all', async () => {
  const ext = await keyedExtract('key-1');
  assert(ext.res.response.type === 'extract-result', 'keyed extract succeeded: ' + ext.res.response.message);
  const got = filesOf(ext.res);
  assert(got.size === 2, `2 files extracted from the cache (got ${[...got.keys()]})`);
  assert(got.get('hello.txt').equals(Buffer.from(contentA)), 'hello.txt byte-identical');
  assert(got.get('sub/nested.txt').equals(Buffer.from(contentB)), 'sub/nested.txt byte-identical');
  assert(
    Array.isArray(ext.res.transfer) && ext.res.transfer.length === 2,
    'both ArrayBuffers sent in the transfer list'
  );
  assertJobDirCleaned(ext.id);

  const tid = nextId();
  const tres = await sendAndWait({ id: tid, type: 'test', archiveKey: 'key-1' }, ['test-result', 'error']);
  assert(tres.response.type === 'test-result', 'keyed test answered test-result');
  assert(tres.response.ok === true, 'keyed test ok:true');
  assert(typeof tres.response.raw === 'string' && tres.response.raw.length > 0, 'test-result keeps its raw tail');
  assertJobDirCleaned(tid);

  // No re-stage churn: still exactly one staged archive, same path.
  assert(arcChildren().length === 1, '/arc still holds exactly one archive');
  assert(stagedPath().endsWith('/plain.7z'), 'the same staged file is reused');
  assert(rootJobDirs().length === 0, 'keyed jobs cleaned their /job<id> trees');
});

await runScenario('3 unknown key: exact errors for extract/test and non-string keys', async () => {
  for (const key of ['nope', 'another-missing-key', 42, '']) {
    const ext = await keyedExtract(key);
    assert(ext.res.response.type === 'error', `key ${JSON.stringify(key)}: extract errored`);
    assert(
      ext.res.response.message === 'extract: unknown archiveKey',
      `key ${JSON.stringify(key)}: exact extract error (got '${ext.res.response.message}')`
    );
    const tid = nextId();
    const tres = await sendAndWait({ id: tid, type: 'test', archiveKey: key }, ['test-result', 'error']);
    assert(tres.response.type === 'error', `key ${JSON.stringify(key)}: test errored`);
    assert(
      tres.response.message === 'test: unknown archiveKey',
      `key ${JSON.stringify(key)}: exact test error (got '${tres.response.message}')`
    );
  }
  // A key that is present but not a string at all (undefined) is LEGACY mode:
  // with no archive payload it keeps the long-standing missing-payload error.
  const lid = nextId();
  const lres = await sendAndWait({ id: lid, type: 'extract' }, ['extract-result', 'error']);
  assert(
    lres.response.type === 'error' && lres.response.message === 'request is missing the archive payload',
    `legacy extract without payload keeps its error (got '${lres.response.message}')`
  );
  // Worker keeps serving after every rejection: valid keyed AND legacy jobs.
  const ext = await keyedExtract('key-1', { paths: ['hello.txt'] });
  assert(ext.res.response.type === 'extract-result', 'valid keyed extract still works');
  assert([...filesOf(ext.res).keys()].join() === 'hello.txt', 'valid keyed extract returns the selection');
  const lid2 = nextId();
  const lres2 = await sendAndWait(
    { id: lid2, type: 'extract', archive: { name: 'plain.7z', data: plainBytes } },
    ['extract-result', 'error']
  );
  assert(lres2.response.type === 'extract-result', 'legacy byte extract still works');
  assert(filesOf(lres2).size === 2, 'legacy byte extract returns both files');
  assertJobDirCleaned(lid2);
});

await runScenario('4 eviction: staging a second key drops the first', async () => {
  await stageKeyed('key-A', 'plain.7z', plainBytes);
  const pathA = stagedPath();
  await stageKeyed('key-B', 'bundle.zip', zipBytes);
  const dirs = arcChildren();
  assert(dirs.length === 1, `exactly one child dir under /arc (got ${JSON.stringify(dirs)})`);
  assert(stagedPath() !== pathA, 'the staged path changed with the new key');
  assert(stagedPath().endsWith('/bundle.zip'), 'the surviving staged archive is the newer one');

  const extA = await keyedExtract('key-A');
  assert(extA.res.response.type === 'error', 'extract with the evicted key errors');
  assert(
    extA.res.response.message === 'extract: unknown archiveKey',
    `evicted key error (got '${extA.res.response.message}')`
  );
  const extB = await keyedExtract('key-B', { paths: ['hello.txt'] });
  assert(extB.res.response.type === 'extract-result', 'the newer key still works');
  assert(filesOf(extB.res).get('hello.txt').equals(Buffer.from(contentA)), 'zip keyed extract byte-identical');
});

await runScenario('5 evict message: no reply of any kind, /arc gone, legacy unaffected', async () => {
  await stageKeyed('key-evict', 'plain.7z', plainBytes);
  assert(arcExists() && arcChildren().length === 1, 'staged before the evict');
  const before = messages.length;
  context.self.onmessage({ data: { type: 'evict' } }); // fire-and-forget: no id
  await tick(400);
  assert(
    messages.length === before,
    `evict posted NO reply (got ${messages.length - before} new: ` +
    JSON.stringify(messages.slice(before).map((m) => m.msg && m.msg.type)) + ')'
  );
  assert(!arcExists(), '/arc removed by the evict');
  assert(rootJobDirs().length === 0, 'evict left no /job dirs behind');

  const ext = await keyedExtract('key-evict');
  assert(ext.res.response.type === 'error', 'keyed extract after evict errors');
  assert(
    ext.res.response.message === 'extract: unknown archiveKey',
    `post-evict error (got '${ext.res.response.message}')`
  );
  const lid = nextId();
  const lres = await sendAndWait(
    { id: lid, type: 'extract', archive: { name: 'plain.7z', data: plainBytes } },
    ['extract-result', 'error']
  );
  assert(lres.response.type === 'extract-result', 'legacy byte extract still works after evict');
  assert(filesOf(lres).size === 2, 'legacy extract returns both files');
  assertJobDirCleaned(lid);
});

await runScenario('6 legacy coexistence: byte jobs never evict the keyed cache', async () => {
  await stageKeyed('key-keep', 'plain.7z', plainBytes);
  const keepPath = stagedPath();

  const lid = nextId();
  const lres = await sendAndWait(
    { id: lid, type: 'extract', archive: { name: 'plain.7z', data: plainBytes } },
    ['extract-result', 'error']
  );
  assert(lres.response.type === 'extract-result', 'legacy extract succeeded');
  assert(filesOf(lres).size === 2, 'legacy extract returned both files');
  assertJobDirCleaned(lid);

  const tid = nextId();
  const tres = await sendAndWait(
    { id: tid, type: 'test', archive: { name: 'plain.7z', data: plainBytes } },
    ['test-result', 'error']
  );
  assert(tres.response.type === 'test-result' && tres.response.ok === true, 'legacy test succeeded');
  assertJobDirCleaned(tid);

  // A legacy list has no key: it must neither stage nor evict.
  const lid2 = nextId();
  const lres2 = await sendAndWait(
    { id: lid2, type: 'list', archive: { name: 'plain.7z', data: plainBytes } },
    ['list-result', 'error']
  );
  assert(lres2.response.type === 'list-result', 'legacy list succeeded');
  assertJobDirCleaned(lid2);

  assert(arcChildren().length === 1, '/arc still holds exactly one archive');
  assert(stagedPath() === keepPath, 'the keyed staged file survived the legacy jobs');
  const ext = await keyedExtract('key-keep', { paths: ['sub/nested.txt'] });
  assert(ext.res.response.type === 'extract-result', 'keyed extract still works after legacy jobs');
  assert(filesOf(ext.res).get('sub/nested.txt').equals(Buffer.from(contentB)), 'keyed extract byte-identical');
});

await runScenario('7 fallback skip (absent path): ONE engine run keyed, TWO legacy', async () => {
  await stageKeyed('key-miss', 'plain.7z', plainBytes);
  const keyed = await keyedExtract('key-miss', { paths: ['definitely/missing.bin'] });
  assert(keyed.res.response.type === 'extract-result', 'absent path answers extract-result, not error');
  assert((keyed.res.response.files || []).length === 0, 'zero files for an absent path');
  assert(engineRuns(keyed.res) === 1, `ONE 7zz run: the FULL re-run was skipped (got ${engineRuns(keyed.res)})`);
  assertJobDirCleaned(keyed.id);

  // No listing cache (legacy bytes) -> today's unconditional re-run.
  const lid = nextId();
  const lres = await sendAndWait(
    {
      id: lid,
      type: 'extract',
      archive: { name: 'plain.7z', data: plainBytes },
      paths: ['definitely/missing.bin'],
    },
    ['extract-result', 'error']
  );
  assert(lres.response.type === 'extract-result', 'legacy absent path answers extract-result');
  assert((lres.response.files || []).length === 0, 'legacy zero files for an absent path');
  assert(engineRuns(lres) === 2, `TWO 7zz runs without a cache (got ${engineRuns(lres)})`);
  assertJobDirCleaned(lid);
});

await runScenario('8 fallback skip (empty directory): one run, zero files, no error', async () => {
  const fixture = buildDirFixture();
  const fileKeys = Object.keys(fixture.meta.files);
  assert(fileKeys.length > 0, 'dir fixture meta lists files');
  const folders = fixture.meta.folders || [];
  // A listed directory with NO file entry underneath it (the fixture's
  // 'docs/empty-dir'): selecting it is a FILTERED coverage miss that a FULL
  // re-run cannot turn into files either.
  const emptyDir = folders.find((f) => !fileKeys.some((k) => k.startsWith(f + '/')));
  assert(emptyDir, `dir fixture has an empty directory (folders=${JSON.stringify(folders)})`);

  const { res: listRes } = await stageKeyed('key-emptydir', 'with-dirs.7z', fixture.bytes);
  const listedFolders = listRes.response.entries.filter((e) => e.isFolder).map((e) => e.path);
  assert(listedFolders.includes(emptyDir), `the empty dir is a listed folder entry (${emptyDir})`);

  const ext = await keyedExtract('key-emptydir', { paths: [emptyDir] });
  assert(ext.res.response.type === 'extract-result', 'empty-dir selection answers extract-result');
  assert((ext.res.response.files || []).length === 0, 'zero files for an empty directory');
  assert(engineRuns(ext.res) === 1, `ONE 7zz run for the empty directory (got ${engineRuns(ext.res)})`);
  assertJobDirCleaned(ext.id);

  // A directory that DOES hold files must still be extracted (no over-skip).
  const withFiles = folders.find((f) => fileKeys.some((k) => k.startsWith(f + '/')));
  assert(withFiles, 'dir fixture has a non-empty directory');
  const ext2 = await keyedExtract('key-emptydir', { paths: [withFiles] });
  assert(ext2.res.response.type === 'extract-result', 'non-empty dir selection answered');
  const got = filesOf(ext2.res);
  const expected = fileKeys.filter((k) => k.startsWith(withFiles + '/')).sort();
  assert(
    expected.length > 0 && [...got.keys()].sort().join() === expected.join(),
    `subtree [${expected}] extracted (got [${[...got.keys()].sort()}])`
  );
  for (const k of expected) {
    assert(
      got.get(k).equals(Buffer.from(fixture.meta.files[k], 'base64')),
      `'${k}' byte-identical from the staged archive`
    );
  }
});

await runScenario('9 no wrong skip: a present-but-FILTERED-missed path still re-runs', async () => {
  const LISTED = 'cr.txt_'; // the listing's sanitized form of the stored 'cr.txt\r'

  // FIRST prove the fixture really does trigger today's fallback: a LEGACY
  // byte extract (no listing cache) misses it under the CLI filter and must
  // re-run in FULL mode to find it.
  const lid = nextId();
  const lres = await sendAndWait(
    { id: lid, type: 'extract', archive: { name: 'hostile.7z', data: hostileBytes }, paths: [LISTED] },
    ['extract-result', 'error']
  );
  assert(lres.response.type === 'extract-result', 'legacy hostile extract answered');
  const legacyRuns = engineRuns(lres);
  assert(legacyRuns === 2, `fixture produces a FILTERED miss (legacy runs = ${legacyRuns}, expected 2)`);
  const legacyFiles = filesOf(lres);
  assert(legacyFiles.size === 1, `legacy returns exactly one file (got ${[...legacyFiles.keys()]})`);
  assertJobDirCleaned(lid);

  // THEN the keyed path: the listing cache says "present" (the requested path
  // IS a listing path), so the FULL re-run must NOT be skipped.
  const { res: listRes } = await stageKeyed('key-hostile', 'hostile.7z', hostileBytes);
  const listed = listRes.response.entries.filter((e) => !e.isFolder).map((e) => e.path);
  assert(listed.includes(LISTED), `staged listing contains '${LISTED}' (${JSON.stringify(listed)})`);

  const ext = await keyedExtract('key-hostile', { paths: [LISTED] });
  assert(ext.res.response.type === 'extract-result', 'keyed hostile extract answered');
  assert(engineRuns(ext.res) === 2, `keyed run count still TWO (got ${engineRuns(ext.res)}) — no wrong skip`);
  const keyedFiles = filesOf(ext.res);
  assert(keyedFiles.size === 1, `keyed returns exactly one file (got ${[...keyedFiles.keys()]})`);
  const [returnedPath] = [...keyedFiles.keys()];
  assert(
    keyedFiles.get(returnedPath).equals(Buffer.from(contentCr)),
    'the returned file is byte-identical to the fixture payload'
  );
  assert(
    [...legacyFiles.keys()].join() === [returnedPath].join(),
    `keyed and legacy results agree on the returned path (${returnedPath})`
  );
  assertJobDirCleaned(ext.id);

  // Sanity: an ancestor directory of the same entry is "maybe present" too.
  const ext2 = await keyedExtract('key-hostile', { paths: ['sub'] });
  assert(ext2.res.response.type === 'extract-result', 'subtree selection answered');
  assert(filesOf(ext2.res).get('sub/inner.txt').equals(Buffer.from(contentB)), 'sub/inner.txt byte-identical');
});

await runScenario('10 mixed coverage: present + absent -> re-run, real file only', async () => {
  await stageKeyed('key-mixed', 'hostile.7z', hostileBytes);
  const ext = await keyedExtract('key-mixed', { paths: ['cr.txt_', 'bogus.bin'] });
  assert(ext.res.response.type === 'extract-result', 'mixed selection answered extract-result');
  assert(engineRuns(ext.res) === 2, `the present path forces the FULL re-run (got ${engineRuns(ext.res)})`);
  const got = filesOf(ext.res);
  assert(got.size === 1, `only the real file is returned (got ${[...got.keys()]})`);
  assert([...got.values()][0].equals(Buffer.from(contentCr)), 'the returned file is byte-identical');
  assertJobDirCleaned(ext.id);

  // Two absent paths: both provably empty -> a single FILTERED pass.
  const ext2 = await keyedExtract('key-mixed', { paths: ['bogus.bin', 'also/missing.txt'] });
  assert(ext2.res.response.type === 'extract-result', 'two absent paths answered extract-result');
  assert((ext2.res.response.files || []).length === 0, 'zero files for two absent paths');
  assert(engineRuns(ext2.res) === 1, `one run for two provably-empty paths (got ${engineRuns(ext2.res)})`);
  assertJobDirCleaned(ext2.id);
});

await runScenario('11 zip: keyed list + keyed subset extract', async () => {
  const { res: listRes } = await stageKeyed('key-zip', 'bundle.zip', zipBytes);
  const listed = listRes.response.entries.filter((e) => !e.isFolder).map((e) => e.path).sort();
  assert(
    listed.length === 2 && listed[0] === 'hello.txt' && listed[1] === 'sub/nested.txt',
    `zip listing (got ${JSON.stringify(listed)})`
  );
  assert(arcChildren().length === 1, 'the zip replaced the previous staged archive');

  const ext = await keyedExtract('key-zip', { paths: ['sub/nested.txt'] });
  assert(ext.res.response.type === 'extract-result', 'zip keyed extract answered: ' + ext.res.response.message);
  const got = filesOf(ext.res);
  assert([...got.keys()].join() === 'sub/nested.txt', `exact zip subset (got ${[...got.keys()]})`);
  assert(got.get('sub/nested.txt').equals(Buffer.from(contentB)), 'zip payload byte-identical');
  assertJobDirCleaned(ext.id);

  const extAll = await keyedExtract('key-zip');
  assert(filesOf(extAll.res).size === 2, 'unfiltered keyed zip extract returns both files');
});

await runScenario('12 password/key interplay: -mhe=on cache, per-request password', async () => {
  // A header-encrypted archive cannot be listed without the password, so the
  // cache only exists after a SUCCESSFUL keyed list.
  const badListId = nextId();
  const badList = await sendAndWait(
    { id: badListId, type: 'list', archive: { name: 'secret.7z', data: secretBytes }, archiveKey: 'key-pw-none' },
    ['list-result', 'error']
  );
  assert(badList.response.type === 'error', 'listing a header-encrypted archive without a password errors');
  assertJobDirCleaned(badListId);
  // The bytes stay staged but the listing cache is empty -> a keyed extract
  // keeps today's fallback behavior (no wrong skip possible).
  const noCache = await keyedExtract('key-pw-none', { paths: ['hello.txt'] });
  assert(noCache.res.response.type === 'error', 'extract without the password errors (engine, not unknown-key)');
  assert(
    noCache.res.response.message !== 'extract: unknown archiveKey',
    `engine error, not unknown-key (got '${noCache.res.response.message}')`
  );

  const { res: listRes } = await stageKeyed('key-pw', 'secret.7z', secretBytes, 'hunter2');
  const listed = listRes.response.entries.filter((e) => !e.isFolder);
  assert(listed.length === 2, 'header-encrypted archive lists 2 entries with the password');
  assert(listed.every((e) => e.encrypted === true), 'entries flagged encrypted');

  const wrong = await keyedExtract('key-pw', { paths: ['hello.txt'], password: 'definitely-wrong' });
  assert(wrong.res.response.type === 'error', 'wrong password on a keyed extract errors');
  assert(
    wrong.res.response.message !== 'extract: unknown archiveKey',
    `wrong password is an engine error (got '${wrong.res.response.message}')`
  );
  assertJobDirCleaned(wrong.id);

  const right = await keyedExtract('key-pw', { paths: ['hello.txt'], password: 'hunter2' });
  assert(right.res.response.type === 'extract-result', 'correct password extracts: ' + right.res.response.message);
  assert(filesOf(right.res).get('hello.txt').equals(Buffer.from(contentA)), 'decrypted payload byte-identical');

  // The cache survives the failed attempts and the key is unchanged.
  assert(arcChildren().length === 1, 'still exactly one staged archive');
  const tid = nextId();
  const tres = await sendAndWait(
    { id: tid, type: 'test', archiveKey: 'key-pw', password: 'hunter2' },
    ['test-result', 'error']
  );
  assert(tres.response.type === 'test-result' && tres.response.ok === true, 'keyed test with the password passes');
  assertJobDirCleaned(tid);
});

await runScenario('13 defensive stat: a vanished staged file drops the map entry', async () => {
  await stageKeyed('key-stat', 'plain.7z', plainBytes);
  const arcPath = stagedPath();
  engineModule.FS.unlink(arcPath); // simulate external MEMFS interference

  const ext = await keyedExtract('key-stat');
  assert(ext.res.response.type === 'error', 'keyed extract with a vanished file errors');
  assert(
    ext.res.response.message === 'extract: unknown archiveKey',
    `vanished staged file -> unknown archiveKey (got '${ext.res.response.message}')`
  );

  // Resurrect the bytes at the SAME path: the request must STILL fail, proving
  // the map entry was dropped (not merely stat-guarded per call).
  engineModule.FS.writeFile(arcPath, new Uint8Array(asBuffer(plainBytes)));
  const ext2 = await keyedExtract('key-stat');
  assert(ext2.res.response.type === 'error', 'extract still errors after the file came back');
  assert(
    ext2.res.response.message === 'extract: unknown archiveKey',
    `the map entry was dropped (got '${ext2.res.response.message}')`
  );

  // Worker healthy: re-stage under the same key and extract again.
  const { res: listRes } = await stageKeyed('key-stat', 'plain.7z', plainBytes);
  assert(listRes.response.entries.length > 0, 're-staging the same key works');
  const ext3 = await keyedExtract('key-stat', { paths: ['hello.txt'] });
  assert(ext3.res.response.type === 'extract-result', 'worker healthy after the defensive-stat path');
  assert(filesOf(ext3.res).get('hello.txt').equals(Buffer.from(contentA)), 're-staged extract byte-identical');
  assert(arcChildren().length === 1, 'exactly one staged archive at the end');
  assert(rootJobDirs().length === 0, 'no /job dirs left at the end');
});

await runScenario('14 keyed requests IGNORE archive bytes carried alongside the key', async () => {
  await stageKeyed('key-ign', 'plain.7z', plainBytes);
  const keepPath = stagedPath();
  const junk = bufOf(enc.encode('junk-bytes-that-are-not-an-archive'));

  // §1.2: archiveKey takes precedence — bytes next to a VALID key are never
  // staged, never read; the answer comes from the cached archive.
  const id = nextId();
  const res = await sendAndWait(
    {
      id,
      type: 'extract',
      archiveKey: 'key-ign',
      paths: ['hello.txt'],
      archive: { name: 'junk.7z', data: junk },
    },
    ['extract-result', 'error']
  );
  assert(
    res.response.type === 'extract-result',
    'keyed extract with junk bytes alongside succeeded: ' + res.response.message
  );
  const got = filesOf(res);
  assert([...got.keys()].join() === 'hello.txt', 'answer came from the staged archive, not the junk bytes');
  assert(got.get('hello.txt').equals(Buffer.from(contentA)), 'byte-identical');
  assertJobDirCleaned(id);
  assert(stagedPath() === keepPath, '/arc unchanged: the junk bytes were not staged');

  // Unknown key + VALID bytes: the key still wins — no silent legacy fallback.
  const eid = nextId();
  const eres = await sendAndWait(
    { id: eid, type: 'extract', archiveKey: 'no-such-key', archive: { name: 'plain.7z', data: plainBytes } },
    ['extract-result', 'error']
  );
  assert(
    eres.response.type === 'error' && eres.response.message === 'extract: unknown archiveKey',
    `unknown key + valid bytes -> keyed error, not a legacy fallback (got '${eres.response.message}')`
  );
  assertJobDirCleaned(eid);

  const tid = nextId();
  const tres = await sendAndWait(
    { id: tid, type: 'test', archiveKey: 'no-such-key', archive: { name: 'plain.7z', data: plainBytes } },
    ['test-result', 'error']
  );
  assert(
    tres.response.type === 'error' && tres.response.message === 'test: unknown archiveKey',
    `test: unknown key + valid bytes -> keyed error (got '${tres.response.message}')`
  );
  assertJobDirCleaned(tid);
  assert(stagedPath() === keepPath, 'keyed requests never stage anything');
});

await runScenario('15 list precedence: only a non-empty string key + bytes stages', async () => {
  await stageKeyed('key-prec', 'plain.7z', plainBytes);
  const keepPath = stagedPath();

  // archiveKey:'' + bytes -> LEGACY list (answers fine, neither stages nor evicts).
  const l1id = nextId();
  const l1 = await sendAndWait(
    { id: l1id, type: 'list', archiveKey: '', archive: { name: 'plain.7z', data: plainBytes } },
    ['list-result', 'error']
  );
  assert(l1.response.type === 'list-result', "list with archiveKey:'' answered list-result: " + l1.response.message);
  const listed1 = (l1.response.entries || []).filter((e) => !e.isFolder).map((e) => e.path).sort();
  assert(listed1.length === 2 && listed1[0] === 'hello.txt', `legacy list parsed both entries (${listed1})`);
  assertJobDirCleaned(l1id);

  // Non-string key + bytes -> LEGACY too (a staging key must be a string).
  const l2id = nextId();
  const l2 = await sendAndWait(
    { id: l2id, type: 'list', archiveKey: 42, archive: { name: 'plain.7z', data: plainBytes } },
    ['list-result', 'error']
  );
  assert(l2.response.type === 'list-result', 'list with archiveKey:42 answered list-result: ' + l2.response.message);
  assertJobDirCleaned(l2id);

  assert(stagedPath() === keepPath, 'legacy lists neither staged nor evicted the keyed cache');
  const ext = await keyedExtract('key-prec', { paths: ['hello.txt'] });
  assert(ext.res.response.type === 'extract-result', 'the keyed cache survived the legacy lists');

  // Key + NO bytes -> the pinned missing-payload error: a LIST can never
  // produce an unknown-archiveKey error (§1.2).
  const l3id = nextId();
  const l3 = await sendAndWait({ id: l3id, type: 'list', archiveKey: 'never-staged-key' }, ['list-result', 'error']);
  assert(l3.response.type === 'error', 'keyed list without bytes errored');
  assert(
    l3.response.message === 'request is missing the archive payload',
    `list never reports unknown-key (got '${l3.response.message}')`
  );
  assertJobDirCleaned(l3id);
  assert(stagedPath() === keepPath, 'still exactly the one staged archive');
});

await runScenario('16 failed staging list: evict-before-write drops the previous key', async () => {
  const { res: sA } = await stageKeyed('key-fail-A', 'plain.7z', plainBytes);
  assert(sA.response.type === 'list-result', 'first staging list succeeded');

  const junk = bufOf(enc.encode('garbage-not-an-archive'));
  const bId = nextId();
  const sB = await sendAndWait(
    { id: bId, type: 'list', archive: { name: 'broken.7z', data: junk }, archiveKey: 'key-fail-B' },
    ['list-result', 'error']
  );
  assert(sB.response.type === 'error', 'staging a garbage archive errored');
  assert(
    String(sB.response.message).startsWith('Listing archive'),
    `engine listing failure surfaced (got '${sB.response.message}')`
  );
  assertJobDirCleaned(bId);

  // Evict-before-write ran even though the staging FAILED: key-fail-A is gone.
  const eA = await keyedExtract('key-fail-A');
  assert(
    eA.res.response.type === 'error' && eA.res.response.message === 'extract: unknown archiveKey',
    `previous key was evicted by the failed staging (got '${eA.res.response.message}')`
  );

  // The failed archive's BYTES remain staged (record registered after the
  // write); only its listing cache is null, so extract reaches the engine.
  assert(arcChildren().length === 1, 'exactly one staged dir remains');
  assert(stagedPath().endsWith('/broken.7z'), `the garbage bytes remain staged (${stagedPath()})`);
  const eB = await keyedExtract('key-fail-B');
  assert(eB.res.response.type === 'error', 'extract against the garbage archive errored');
  assert(
    eB.res.response.message !== 'extract: unknown archiveKey',
    `key is KNOWN -> an engine error, not unknown-key (got '${eB.res.response.message}')`
  );

  // Engine still healthy afterwards.
  const { res: sC } = await stageKeyed('key-fail-C', 'plain.7z', plainBytes);
  assert(sC.response.type === 'list-result', 're-staging after the failure works');
  const ext = await keyedExtract('key-fail-C', { paths: ['hello.txt'] });
  assert(ext.res.response.type === 'extract-result', 'keyed extract after recovery');
  assert(filesOf(ext.res).get('hello.txt').equals(Buffer.from(contentA)), 'byte-identical after recovery');
});

await runScenario('17 evict posted mid-job runs only AFTER the job completed', async () => {
  await stageKeyed('key-ord', 'plain.7z', plainBytes);
  assert(arcExists(), 'staged before the evict');

  const eid = nextId();
  const startIdx = messages.length;
  context.self.onmessage({ data: { id: eid, type: 'extract', archiveKey: 'key-ord' } });
  context.self.onmessage({ data: { type: 'evict' } }); // queued behind the running job
  const r = await waitTerminal(eid, ['extract-result', 'error'], startIdx);
  assert(r.response.type === 'extract-result', 'in-flight extract completed: ' + r.response.message);
  const got = filesOf(r);
  assert(
    got.size === 2 &&
      got.get('hello.txt').equals(Buffer.from(contentA)) &&
      got.get('sub/nested.txt').equals(Buffer.from(contentB)),
    `the staged archive was not deleted mid-run (got ${[...got.keys()]})`
  );
  assertJobDirCleaned(eid);

  await tick(300); // let the serial inbox drain the queued evict
  assert(!arcExists(), '/arc removed by the evict AFTER the job finished');
  const idless = messages.slice(startIdx).filter((m) => m.msg && m.msg.id === undefined);
  assert(idless.length === 0, `evict posted no replies at all (got ${JSON.stringify(idless.map((m) => m.msg.type))})`);

  const e2 = await keyedExtract('key-ord');
  assert(
    e2.res.response.type === 'error' && e2.res.response.message === 'extract: unknown archiveKey',
    `keyed extract after the evict -> unknown key (got '${e2.res.response.message}')`
  );

  // Second evict on an already-empty store: still no reply, worker healthy.
  const before = messages.length;
  context.self.onmessage({ data: { type: 'evict' } });
  await tick(200);
  assert(messages.length === before, 'evict on an empty store posted nothing');

  const lid = nextId();
  const lres = await sendAndWait(
    { id: lid, type: 'extract', archive: { name: 'plain.7z', data: plainBytes } },
    ['extract-result', 'error']
  );
  assert(lres.response.type === 'extract-result', 'legacy byte extract still works after the evicts');
  assert(filesOf(lres).size === 2, 'legacy extract returned both files');
  assertJobDirCleaned(lid);
});

await runScenario('18 backslash-spelled request: no wrong skip, keyed ≡ legacy', async () => {
  const { res: listRes } = await stageKeyed('key-bslash', 'plain.7z', plainBytes);
  assert(listRes.response.type === 'list-result', 'staged');

  // 'sub\nested.txt' cannot be matched against the cached listing with
  // certainty (§5: selNorm unifies backslashes, but the FILTERED run may miss)
  // -> the FULL re-run must happen and the file must come back.
  const keyed = await keyedExtract('key-bslash', { paths: ['sub\\nested.txt'] });
  assert(
    keyed.res.response.type === 'extract-result',
    'keyed backslash extract answered: ' + keyed.res.response.message
  );
  const kGot = filesOf(keyed.res);
  assert([...kGot.keys()].join() === 'sub/nested.txt', `the file was returned (got ${JSON.stringify([...kGot.keys()])})`);
  assert(kGot.get('sub/nested.txt').equals(Buffer.from(contentB)), 'byte-identical');
  assert(
    engineRuns(keyed.res) === 2,
    `TWO 7zz runs: the listing index said "maybe present" and the re-run happened (got ${engineRuns(keyed.res)})`
  );
  assertJobDirCleaned(keyed.id);

  // Legacy path: identical result and identical run count.
  const lid = nextId();
  const lres = await sendAndWait(
    {
      id: lid,
      type: 'extract',
      archive: { name: 'plain.7z', data: plainBytes },
      paths: ['sub\\nested.txt'],
    },
    ['extract-result', 'error']
  );
  assert(lres.response.type === 'extract-result', 'legacy backslash extract answered: ' + lres.response.message);
  const lGot = filesOf(lres);
  assert(
    [...lGot.keys()].join() === 'sub/nested.txt' && lGot.get('sub/nested.txt').equals(Buffer.from(contentB)),
    'legacy returned the same file byte-identical'
  );
  assert(engineRuns(lres) === 2, `legacy also re-ran (got ${engineRuns(lres)})`);
  assertJobDirCleaned(lid);
});

await runScenario('19 case-variant request: the skip is RESULT-identical to the re-run', async () => {
  // Reuses the archive staged by scenario 18: the cache persists across jobs.
  const keyed = await keyedExtract('key-bslash', { paths: ['HELLO.TXT'] });
  assert(keyed.res.response.type === 'extract-result', 'keyed case-variant extract answered');
  assert((keyed.res.response.files || []).length === 0, 'zero files: selection is case-sensitive, no folding');
  assert(
    engineRuns(keyed.res) === 1,
    `ONE 7zz run: provably absent under the cached listing -> re-run skipped (got ${engineRuns(keyed.res)})`
  );
  assertJobDirCleaned(keyed.id);

  // Legacy (no listing cache) pays the FULL re-run and reaches the same answer.
  const lid = nextId();
  const lres = await sendAndWait(
    { id: lid, type: 'extract', archive: { name: 'plain.7z', data: plainBytes }, paths: ['HELLO.TXT'] },
    ['extract-result', 'error']
  );
  assert(lres.response.type === 'extract-result', 'legacy case-variant extract answered');
  assert((lres.response.files || []).length === 0, 'legacy also returned zero files — results identical');
  assert(engineRuns(lres) === 2, `legacy paid TWO 7zz runs (got ${engineRuns(lres)})`);
  assertJobDirCleaned(lid);

  // Exact-case path still extracts from the same cache (no poisoning).
  const exact = await keyedExtract('key-bslash', { paths: ['hello.txt'] });
  assert(exact.res.response.type === 'extract-result', 'exact-case extract answered');
  assert(filesOf(exact.res).get('hello.txt').equals(Buffer.from(contentA)), 'exact-case path byte-identical');

  assert(arcChildren().length === 1, 'exactly one staged archive at the end');
  assert(rootJobDirs().length === 0, 'no /job dirs left at the end');
});

// ---------------------------------------------------------------- summary ---

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`scenarios: ${results.length}, passed: ${results.length - failed.length}, failed: ${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(`  FAILED: ${f.name}`);
}
console.log(failed.length ? 'RESULT: FAIL' : 'RESULT: PASS (all stage-cache scenarios green)');

// The emscripten glue sets process.exitCode = <rc> of every callMain; decide
// the exit status explicitly here instead.
process.exitCode = failed.length ? 1 : 0;
