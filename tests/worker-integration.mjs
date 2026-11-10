/*
 * worker-integration.mjs — Node integration test for <repo>/worker.js against
 * the REAL 7zz wasm build shipped in <repo>/wasm.
 *
 * Builds a vm context that stubs the Worker environment exactly per the
 * contract (self.onmessage / self.postMessage / importScripts / self.location /
 * fetch / console), loads worker.js into it and drives full jobs:
 *   init -> ready; compress (7z, level 5, nested path); list; extract
 *   roundtrip; test; SELECTIVE extraction via the optional 'paths' field
 *   (single file, directory subtree, multi-file, literal wildcard name,
 *   empty/omitted/null paths = full extraction, duplicates, nonexistent);
 *   password-protected compress with -mhe=on (correct and
 *   WRONG password); plus zip roundtrip, corrupted-archive recovery,
 *   back-to-back queueing and per-job MEMFS hygiene.
 *
 * Run: node tests/worker-integration.mjs   (from the repo root; any cwd works)
 * Prints "SKIPPED (wasm not built)" and exits 0 when <repo>/wasm is missing.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Repo root derived from this file's own location (tests/..), so the suite runs
// from any working directory and on any checkout path.
const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TESTS_DIR, '..');
const require_ = createRequire(import.meta.url);

const WASM_DIR = path.join(REPO, 'wasm');
const WORKER_JS = path.join(REPO, 'worker.js');
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

// Captured via a transparent wrapper around the real factory so tests can
// assert MEMFS job-dir hygiene; behaves identically for worker.js.
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

// Send a message to the worker and wait for a terminal reply for its id.
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

function assertJobDirCleaned(id) {
  if (!engineModule) return; // module capture unavailable — skip hygiene check
  const p = engineModule.FS.analyzePath('/job' + id);
  assert(!p.exists, `MEMFS job dir /job${id} removed after job finished`);
}

const enc = new TextEncoder();
const contentA = enc.encode('Hello from the worker integration test!\n'.repeat(40));
const contentB = enc.encode('Nested payload with unicode: ünicode ✓ 7-Zip\n'.repeat(60));

function bufOf(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}
function asBuffer(ab) {
  return Buffer.from(new Uint8Array(ab));
}
function expectError(res, id) {
  assert(
    res.response.type === 'error',
    `id ${id}: expected {type:'error'}, got '${res.response.type}'`
  );
  assert(
    typeof res.response.message === 'string' && res.response.message.length > 0,
    `id ${id}: error message must be a non-empty string`
  );
}

// ------------------------------------------------------------- scenarios ---

assert(typeof context.self.onmessage === 'function', 'worker.js assigns self.onmessage');

await runScenario('init -> ready', async () => {
  const id = nextId();
  const res = await sendAndWait({ id, type: 'init' }, ['ready', 'error']);
  assert(res.response.type === 'ready', "expected {type:'ready'}");
  assert(res.response.id === id, 'ready carries the request id');
  assert(engineModule && typeof engineModule.callMain === 'function', 'engine Module initialized');
  assert(typeof engineModule.FS.mkdirTree === 'function', 'Module.FS present');
});

let plainArchiveBytes = null;
let plainArchiveName = 'test-archive.7z';

await runScenario('compress two files (nested path) as 7z level 5', async () => {
  const id = nextId();
  const res = await sendAndWait(
    {
      id,
      type: 'compress',
      files: [
        { path: 'hello.txt', data: bufOf(contentA) },
        { path: 'sub/nested.txt', data: bufOf(contentB) },
      ],
      archiveName: plainArchiveName,
      format: '7z',
      level: '5',
    },
    ['compress-result', 'error']
  );
  if (res.response.type === 'error') throw new Error('worker error: ' + res.response.message);
  const arc = res.response.archive;
  assert(arc && arc.name === plainArchiveName, `archive.name === '${plainArchiveName}'`);
  assert(arc.data && typeof arc.data.byteLength === 'number', 'archive.data is a binary payload');
  const bytes = asBuffer(arc.data);
  assert(bytes.byteLength > 32, `archive has non-trivial size (got ${bytes.byteLength})`);
  const sig = bytes.subarray(0, 6);
  assert(
    sig[0] === 0x37 && sig[1] === 0x7a && sig[2] === 0xbc && sig[3] === 0xaf && sig[4] === 0x27 && sig[5] === 0x1c,
    'archive starts with the 7z signature'
  );
  assert(
    Array.isArray(res.transfer) && res.transfer.length === 1 && res.transfer[0] === arc.data,
    'archive ArrayBuffer sent in the transfer list'
  );
  assert(
    res.related.some((x) => x.msg.type === 'progress' && typeof x.msg.line === 'string'),
    'progress lines streamed for the job'
  );
  plainArchiveBytes = arc.data;
  assertJobDirCleaned(id);
});

await runScenario('list the archive -> entries match names/sizes', async () => {
  const id = nextId();
  const res = await sendAndWait(
    { id, type: 'list', archive: { name: plainArchiveName, data: plainArchiveBytes } },
    ['list-result', 'error']
  );
  if (res.response.type === 'error') throw new Error('worker error: ' + res.response.message);
  const entries = res.response.entries;
  assert(Array.isArray(entries), 'entries is an array');
  assert(res.response.raw === undefined, 'list-result no longer carries raw');
  const files = entries.filter((e) => !e.isFolder);
  const byPath = new Map(files.map((e) => [e.path, e]));
  assert(files.length === 2, `exactly 2 file entries (got ${files.length}: ${files.map((e) => e.path)})`);
  assert(byPath.has('hello.txt'), "entry 'hello.txt' listed");
  assert(byPath.has('sub/nested.txt'), "entry 'sub/nested.txt' listed (nested path preserved)");
  assert(byPath.get('hello.txt').size === contentA.byteLength, 'hello.txt size matches');
  assert(byPath.get('sub/nested.txt').size === contentB.byteLength, 'sub/nested.txt size matches');
  for (const e of files) {
    assert(typeof e.size === 'number', `${e.path}: size is a number`);
    assert(e.encrypted === false, `${e.path}: encrypted === false`);
    assert(typeof e.modified === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(e.modified), `${e.path}: modified raw string`);
    assert(typeof e.method === 'string' && e.method.length > 0, `${e.path}: method present`);
    assert(typeof e.isFolder === 'boolean', `${e.path}: isFolder boolean`);
  }
  for (const e of entries.filter((x) => x.isFolder)) {
    assert(e.path === 'sub', `unexpected folder entry '${e.path}'`);
  }
  assertJobDirCleaned(id);
});

await runScenario('extract -> byte-identical roundtrip incl. nested path', async () => {
  const id = nextId();
  const res = await sendAndWait(
    { id, type: 'extract', archive: { name: plainArchiveName, data: plainArchiveBytes } },
    ['extract-result', 'error']
  );
  if (res.response.type === 'error') throw new Error('worker error: ' + res.response.message);
  const files = res.response.files;
  assert(Array.isArray(files) && files.length === 2, `2 files extracted (got ${files && files.length})`);
  const byPath = new Map(files.map((f) => [f.path, asBuffer(f.data)]));
  assert(byPath.has('hello.txt') && byPath.has('sub/nested.txt'), 'relative paths preserved');
  assert(byPath.get('hello.txt').equals(Buffer.from(contentA)), 'hello.txt byte-identical');
  assert(byPath.get('sub/nested.txt').equals(Buffer.from(contentB)), 'sub/nested.txt byte-identical');
  assert(
    Array.isArray(res.transfer) && res.transfer.length === 2,
    'both ArrayBuffers sent in the transfer list'
  );
  assertJobDirCleaned(id);
});

await runScenario('test -> ok:true', async () => {
  const id = nextId();
  const res = await sendAndWait(
    { id, type: 'test', archive: { name: plainArchiveName, data: plainArchiveBytes } },
    ['test-result', 'error']
  );
  if (res.response.type === 'error') throw new Error('worker error: ' + res.response.message);
  assert(res.response.ok === true, 'ok === true');
  assert(typeof res.response.raw === 'string' && res.response.raw.length > 0, 'raw tail included');
  assertJobDirCleaned(id);
});

// ------------------------------------------------- selective extraction ---
//
// Fixture for the optional 'paths' extract field. Note: '-dash.txt' cannot be
// part of this fixture — the compress protocol rejects paths starting with
// '-' ('compress: paths starting with "-" are not supported'), so it is NOT
// trivially addable; leading-dash safety is covered by the '--' terminator in
// the worker's extract argv (asserted structurally) and the adversarial
// suite. The literal 'star*.txt' IS compressible and proves a wildcard-looking
// name extracts as itself.

const contentC = (() => {
  // Deterministic pseudo-random binary payload for sub/deep/x.bin.
  const out = new Uint8Array(4096);
  let seed = 0x2f6e2b1;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    out[i] = (seed >>> 16) & 0xff;
  }
  return out;
})();
const contentD = enc.encode('spaced name payload — ünicode ✓\n');
const contentE = enc.encode('STAR payload, literally named with a wildcard character\n');

const SEL_FIXTURE = [
  { path: 'root.txt', data: contentA },
  { path: 'sub/inner.txt', data: contentB },
  { path: 'sub/deep/x.bin', data: contentC },
  { path: 'spaced name.txt', data: contentD },
  { path: 'star*.txt', data: contentE },
];
const selArchiveName = 'selective.7z';
let selArchiveBytes = null;

// Send an extract against the selective fixture. `paths` is only attached when
// present in opts, so "omitted paths" is genuinely absent (not undefined-valued
// in the assertion sense). Returns a path -> Buffer map of the reply files.
async function extractSelected(id, opts) {
  const msg = { id, type: 'extract', archive: { name: selArchiveName, data: selArchiveBytes } };
  if ('paths' in opts) msg.paths = opts.paths;
  if (opts.password !== undefined) msg.password = opts.password;
  const res = await sendAndWait(msg, ['extract-result', 'error']);
  if (res.response.type === 'error') throw new Error('worker error: ' + res.response.message);
  const files = res.response.files;
  assert(Array.isArray(files), 'extract-result carries a files array');
  // The worker posts WITHOUT a transfer list when files is empty, so transfer
  // assertions are only valid for non-empty results.
  if (files.length > 0) {
    assert(
      Array.isArray(res.transfer) && res.transfer.length === files.length,
      `all ${files.length} ArrayBuffers sent in the transfer list`
    );
  }
  const byPath = new Map();
  for (const f of files) {
    assert(!byPath.has(f.path), `duplicate returned path '${f.path}'`);
    byPath.set(f.path, asBuffer(f.data));
  }
  return byPath;
}

// `expected` must be SORTED; also byte-checks every returned fixture file and
// the job-dir hygiene for the job id.
function assertExactSelection(byPath, expected, id) {
  const got = [...byPath.keys()].sort();
  assert(
    got.length === expected.length && got.every((p, i) => p === expected[i]),
    `returned exactly [${expected.join(', ')}] (got [${got.join(', ')}])`
  );
  for (const fx of SEL_FIXTURE) {
    if (byPath.has(fx.path)) {
      assert(byPath.get(fx.path).equals(Buffer.from(fx.data)), `'${fx.path}' byte-identical`);
    }
  }
  assertJobDirCleaned(id);
}

const ALL_SEL_PATHS = SEL_FIXTURE.map((f) => f.path).sort();

await runScenario('selective fixture: compress + list 5 files (nested, deep, spaced, wildcard-name)', async () => {
  const id = nextId();
  const res = await sendAndWait(
    {
      id,
      type: 'compress',
      files: SEL_FIXTURE.map((f) => ({ path: f.path, data: bufOf(f.data) })),
      archiveName: selArchiveName,
      format: '7z',
      level: '5',
    },
    ['compress-result', 'error']
  );
  if (res.response.type === 'error') throw new Error('worker error: ' + res.response.message);
  selArchiveBytes = res.response.archive.data;
  assert(selArchiveBytes && selArchiveBytes.byteLength > 32, 'fixture archive has non-trivial size');
  assertJobDirCleaned(id);

  const lid = nextId();
  const lres = await sendAndWait(
    { id: lid, type: 'list', archive: { name: selArchiveName, data: selArchiveBytes } },
    ['list-result', 'error']
  );
  if (lres.response.type === 'error') throw new Error('worker error: ' + lres.response.message);
  const listed = [...lres.response.entries.filter((e) => !e.isFolder).map((e) => e.path)].sort();
  assert(
    listed.length === ALL_SEL_PATHS.length && listed.every((p, i) => p === ALL_SEL_PATHS[i]),
    `fixture lists exactly [${ALL_SEL_PATHS.join(', ')}] (got [${listed.join(', ')}])`
  );
  assertJobDirCleaned(lid);
});

await runScenario("extract paths=['sub/inner.txt'] -> exactly that one file, byte-identical", async () => {
  const id = nextId();
  const byPath = await extractSelected(id, { paths: ['sub/inner.txt'] });
  assertExactSelection(byPath, ['sub/inner.txt'], id);
});

await runScenario("extract paths=['sub'] -> the whole subtree (inner.txt + deep/x.bin)", async () => {
  const id = nextId();
  const byPath = await extractSelected(id, { paths: ['sub'] });
  assertExactSelection(byPath, ['sub/deep/x.bin', 'sub/inner.txt'], id);
});

await runScenario("extract paths=['root.txt','spaced name.txt'] -> exactly those two files", async () => {
  const id = nextId();
  const byPath = await extractSelected(id, { paths: ['root.txt', 'spaced name.txt'] });
  assertExactSelection(byPath, ['root.txt', 'spaced name.txt'], id);
});

await runScenario("extract paths=['star*.txt'] -> the literal wildcard-named file only", async () => {
  // 'star*.txt' contains '*', so it is not filter-safe: the worker must run
  // FULL mode (or fall back to it) and post-filter. The contract pins the
  // RESULT, not the mode: exactly the file literally named 'star*.txt',
  // byte-identical — never a 7z wildcard over-match.
  const id = nextId();
  const byPath = await extractSelected(id, { paths: ['star*.txt'] });
  assertExactSelection(byPath, ['star*.txt'], id);
});

await runScenario('extract paths=[] / omitted / null -> full extraction, all byte-identical', async () => {
  const idEmpty = nextId();
  const byEmpty = await extractSelected(idEmpty, { paths: [] });
  assertExactSelection(byEmpty, ALL_SEL_PATHS, idEmpty);

  const idOmit = nextId();
  const byOmit = await extractSelected(idOmit, {});
  assertExactSelection(byOmit, ALL_SEL_PATHS, idOmit);

  const idNull = nextId();
  const byNull = await extractSelected(idNull, { paths: null });
  assertExactSelection(byNull, ALL_SEL_PATHS, idNull);

  for (const fx of SEL_FIXTURE) {
    assert(
      byEmpty.get(fx.path).equals(byOmit.get(fx.path)) && byOmit.get(fx.path).equals(byNull.get(fx.path)),
      `'${fx.path}' identical across paths=[] vs omitted vs null`
    );
  }
});

await runScenario('duplicate selected paths are de-duplicated (no duplicate files returned)', async () => {
  const id = nextId();
  const byPath = await extractSelected(id, { paths: ['root.txt', 'sub/inner.txt', 'root.txt', 'root.txt'] });
  assertExactSelection(byPath, ['root.txt', 'sub/inner.txt'], id);
});

await runScenario('nonexistent selected path -> empty extract-result, worker keeps serving', async () => {
  const id = nextId();
  const byPath = await extractSelected(id, { paths: ['nope.txt'] });
  assert(byPath.size === 0, `no files returned for a nonexistent path (got [${[...byPath.keys()]}])`);
  assertJobDirCleaned(id);
  // Health check: a valid selective job right after the empty one.
  const id2 = nextId();
  const byPath2 = await extractSelected(id2, { paths: ['root.txt'] });
  assertExactSelection(byPath2, ['root.txt'], id2);
});

let secretBytes = null;

await runScenario('password compress (encryptHeaders) -> list/extract with correct password', async () => {
  const id = nextId();
  const res = await sendAndWait(
    {
      id,
      type: 'compress',
      files: [
        { path: 'hello.txt', data: bufOf(contentA) },
        { path: 'sub/nested.txt', data: bufOf(contentB) },
      ],
      archiveName: 'secret.7z',
      format: '7z',
      level: '5',
      password: 'hunter2',
      encryptHeaders: true,
    },
    ['compress-result', 'error']
  );
  if (res.response.type === 'error') throw new Error('worker error: ' + res.response.message);
  assert(res.response.archive.name === 'secret.7z', 'archive.name === secret.7z');
  const sig = asBuffer(res.response.archive.data).subarray(0, 2);
  assert(sig[0] === 0x37 && sig[1] === 0x7a, '7z signature');
  secretBytes = res.response.archive.data;
  assertJobDirCleaned(id);

  // list with correct password
  const id2 = nextId();
  const listRes = await sendAndWait(
    { id: id2, type: 'list', archive: { name: 'secret.7z', data: secretBytes }, password: 'hunter2' },
    ['list-result', 'error']
  );
  if (listRes.response.type === 'error') throw new Error('list with correct password errored: ' + listRes.response.message);
  const files = listRes.response.entries.filter((e) => !e.isFolder);
  assert(files.length === 2, 'header-encrypted archive lists 2 entries with correct password');
  const byPath = new Map(files.map((e) => [e.path, e]));
  assert(byPath.get('hello.txt').size === contentA.byteLength, 'hello.txt size (encrypted list)');
  assert(byPath.get('sub/nested.txt').size === contentB.byteLength, 'sub/nested.txt size (encrypted list)');
  assert(files.every((e) => e.encrypted === true), 'entries flagged encrypted');
  assertJobDirCleaned(id2);

  // extract with correct password
  const id3 = nextId();
  const extRes = await sendAndWait(
    { id: id3, type: 'extract', archive: { name: 'secret.7z', data: secretBytes }, password: 'hunter2' },
    ['extract-result', 'error']
  );
  if (extRes.response.type === 'error') throw new Error('extract with correct password errored: ' + extRes.response.message);
  const ext = new Map(extRes.response.files.map((f) => [f.path, asBuffer(f.data)]));
  assert(ext.get('hello.txt').equals(Buffer.from(contentA)), 'encrypted roundtrip hello.txt');
  assert(ext.get('sub/nested.txt').equals(Buffer.from(contentB)), 'encrypted roundtrip sub/nested.txt');
  assertJobDirCleaned(id3);
});

await runScenario('WRONG password -> list reports error', async () => {
  const id = nextId();
  const res = await sendAndWait(
    { id, type: 'list', archive: { name: 'secret.7z', data: secretBytes }, password: 'definitely-wrong' },
    ['error', 'list-result']
  );
  expectError(res, id);
  assertJobDirCleaned(id);
});

await runScenario('WRONG password -> extract reports error', async () => {
  const id = nextId();
  const res = await sendAndWait(
    { id, type: 'extract', archive: { name: 'secret.7z', data: secretBytes }, password: 'definitely-wrong' },
    ['error', 'extract-result']
  );
  expectError(res, id);
  assertJobDirCleaned(id);
});

await runScenario('WRONG password -> test reports ok:false (not error)', async () => {
  const id = nextId();
  const res = await sendAndWait(
    { id, type: 'test', archive: { name: 'secret.7z', data: secretBytes }, password: 'definitely-wrong' },
    ['test-result', 'error']
  );
  assert(res.response.type === 'test-result', 'test always answers test-result');
  assert(res.response.ok === false, 'ok === false for wrong password');
  assertJobDirCleaned(id);
});

await runScenario('zip format roundtrip (encryptHeaders ignored for zip)', async () => {
  const id = nextId();
  const res = await sendAndWait(
    {
      id,
      type: 'compress',
      files: [
        { path: 'hello.txt', data: bufOf(contentA) },
        { path: 'sub/nested.txt', data: bufOf(contentB) },
      ],
      archiveName: 'bundle.zip',
      format: 'zip',
      level: '5',
      encryptHeaders: true, // must be ignored for zip (no password anyway)
    },
    ['compress-result', 'error']
  );
  if (res.response.type === 'error') throw new Error('worker error: ' + res.response.message);
  const zipBytes = res.response.archive.data;
  const sig = asBuffer(zipBytes).subarray(0, 2);
  assert(sig[0] === 0x50 && sig[1] === 0x4b, 'zip starts with PK signature');

  const id2 = nextId();
  const listRes = await sendAndWait(
    { id: id2, type: 'list', archive: { name: 'bundle.zip', data: zipBytes } },
    ['list-result', 'error']
  );
  if (listRes.response.type === 'error') throw new Error('zip list errored: ' + listRes.response.message);
  const files = listRes.response.entries.filter((e) => !e.isFolder);
  const byPath = new Map(files.map((e) => [e.path, e]));
  assert(byPath.has('hello.txt') && byPath.has('sub/nested.txt'), 'zip entries listed');
  assert(byPath.get('hello.txt').size === contentA.byteLength, 'zip hello.txt size');
  assert(files.every((e) => e.encrypted === false), 'zip entries not encrypted');

  const id3 = nextId();
  const extRes = await sendAndWait(
    { id: id3, type: 'extract', archive: { name: 'bundle.zip', data: zipBytes } },
    ['extract-result', 'error']
  );
  if (extRes.response.type === 'error') throw new Error('zip extract errored: ' + extRes.response.message);
  const ext = new Map(extRes.response.files.map((f) => [f.path, asBuffer(f.data)]));
  assert(ext.get('hello.txt').equals(Buffer.from(contentA)), 'zip roundtrip hello.txt');
  assert(ext.get('sub/nested.txt').equals(Buffer.from(contentB)), 'zip roundtrip sub/nested.txt');
  assertJobDirCleaned(id3);
});

await runScenario('corrupt archive -> error, worker keeps functioning', async () => {
  const garbage = Buffer.alloc(64);
  for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 37) & 0xff;
  const id = nextId();
  const res = await sendAndWait(
    { id, type: 'list', archive: { name: 'garbage.7z', data: garbage.buffer.slice(0) } },
    ['error', 'list-result']
  );
  expectError(res, id);
  assertJobDirCleaned(id);

  // engine still healthy afterwards
  const id2 = nextId();
  const ok = await sendAndWait(
    { id: id2, type: 'test', archive: { name: plainArchiveName, data: plainArchiveBytes } },
    ['test-result', 'error']
  );
  assert(ok.response.type === 'test-result' && ok.response.ok === true, 'worker still functional after error job');
  assertJobDirCleaned(id2);
});

await runScenario('back-to-back jobs are queued and processed sequentially', async () => {
  const idA = nextId();
  const idB = nextId();
  const startIdx = messages.length;
  // Fire two jobs WITHOUT waiting — the worker must queue and serialize them.
  context.self.onmessage({
    data: { id: idA, type: 'test', archive: { name: plainArchiveName, data: plainArchiveBytes } },
  });
  context.self.onmessage({
    data: { id: idB, type: 'list', archive: { name: plainArchiveName, data: plainArchiveBytes } },
  });
  const resA = await waitTerminal(idA, ['test-result', 'error'], startIdx);
  const resB = await waitTerminal(idB, ['list-result', 'error'], startIdx);
  assert(resA.response.type === 'test-result' && resA.response.ok === true, 'job A succeeded');
  assert(resB.response.type === 'list-result', 'job B succeeded');
  assert(resA.index < resB.index, 'job A completed before job B (sequential engine)');
  assertJobDirCleaned(idA);
  assertJobDirCleaned(idB);
});

await runScenario('unknown message type -> error reply', async () => {
  const id = nextId();
  const res = await sendAndWait({ id, type: 'frobnicate' }, ['error']);
  expectError(res, id);
});

// ---------------------------------------------------------------- summary ---

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`scenarios: ${results.length}, passed: ${results.length - failed.length}, failed: ${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(`  FAILED: ${f.name}`);
}
console.log(failed.length ? 'RESULT: FAIL' : 'RESULT: PASS (all scenarios green)');

// The emscripten glue sets process.exitCode = <rc> of every callMain; decide
// the exit status explicitly here instead.
process.exitCode = failed.length ? 1 : 0;
