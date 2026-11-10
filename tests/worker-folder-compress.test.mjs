/*
 * worker-folder-compress.test.mjs — Node integration test for the FOLDER half
 * of the compress protocol (the optional `dirs` field) and for the compress
 * LISTFILE overflow guard in <repo>/worker.js, driven against the REAL 7zz wasm
 * build shipped in <repo>/wasm.
 *
 * Harness copied from tests/worker-stage-cache.test.mjs /
 * tests/worker-integration.mjs: a vm context stubs the Worker environment
 * exactly per the contract (self.onmessage / self.postMessage / importScripts /
 * self.location / fetch / console), the emscripten factory is wrapped
 * transparently so `engineModule` exposes Module.FS for MEMFS assertions, and
 * every fixture is built with the worker's own 'compress' op.
 *
 * Covered (W# = the worker-side scenario list of the feature contract):
 *   W1   dirs-only 7z: 'photos' stored as a directory entry
 *   W2   dirs-only zip: same, detected via 'Folder = +'
 *   W3   mixed files + a separate empty dir, nested paths + extract roundtrip
 *   W4   nested empties ['a','a/b'] — each entry exactly once, no crash
 *   W4b  a deep empty dir path stores only the requested dir (ancestors implicit)
 *   W4c  a dir that is the parent of a queued file: one entry, no duplicate
 *   W5   dir path == a file path -> duplicate input path
 *   W6   the same dir twice -> duplicate input path
 *   W7   dir 'a/b' while file 'a' exists -> conflicts with a file
 *   W8   ''/null/'..' (and the observed '  ') -> invalid directory path
 *   W9   '-x' -> leading-dash rejection (message shared with files)
 *   W10  {files} vs {files,dirs:[]} vs {files,dirs:null} -> byte-identical
 *   W11  listfile mode: 4000 long paths compress + list + extract roundtrip
 *   W11b listfile mode preserves UTF-8 names (files and empty dirs)
 *   W11c listfile mode preserves whitespace-edged names (quoted listfile lines)
 *   W12  listfile mode carrying dirs:['e']
 *   W12b listfile mode keeps the password switches working
 *   W13  listfile mode + '\n' in a name -> rejected
 *   W14  argv mode + '\n' in a name -> still accepted (legacy, unchanged)
 *   W15  listfile mode + a leading '"' name -> rejected
 *   W16  dirs:['a/../b'] normalizes to 'b'
 *   W17  legacy regressions: tests/worker-integration.mjs is run UNMODIFIED
 *        as its own suite (see the report; nothing is pinned here)
 *
 * DEVIATION NOTE (W8): the contract expected dirs:['  '] to be rejected as an
 * invalid directory path. safeRelPath does not strip whitespace (a segment of
 * spaces is a legal name, and the FILES side has always accepted it), so '  '
 * is accepted and stored as a directory literally named '  '. Pinned as
 * observed, matching legacy file-path behavior; no new validation was added.
 * Also pinned as observed (W8b, not covered by the contract): a NON-ARRAY dirs
 * is treated like an absent one instead of being iterated, so a string cannot
 * create one directory per character.
 *
 * W10 NOTE: 7z stores each entry's mtime and MEMFS stamps files with
 * Date.now(), so two otherwise identical compress jobs differ ONLY in those
 * timestamp fields (measured: rewriting the same two files changed 36 bytes of
 * a 208-byte archive, while rebuilding the UNCHANGED files 1.2 s later was
 * byte-identical). W10 therefore freezes Date.now for the two jobs it compares,
 * which isolates exactly what it asks: that `dirs:[]`/null/absent change
 * nothing. The wait harness times out on performance.now(), not Date.now(), so
 * the freeze cannot mask a hang.
 *
 * Run: node tests/worker-folder-compress.test.mjs   (any cwd)
 * Prints "SKIPPED (wasm not built)" and exits 0 when <repo>/wasm is missing.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TESTS_DIR, '..');
const require_ = createRequire(import.meta.url);

const WASM_DIR = path.join(REPO, 'wasm');
const WORKER_JS = path.join(REPO, 'worker.js');
const JOB_TIMEOUT_MS = 180000;

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
const workerSource = fs.readFileSync(WORKER_JS, 'utf8');
vm.runInContext(workerSource, context, { filename: WORKER_JS });

// ------------------------------------------------------------ test plumbing ---

const results = [];
function assert(cond, what) {
  if (!cond) throw new Error('assertion failed: ' + what);
}

async function runScenario(name, fn) {
  const t0 = performance.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}  (${Math.round(performance.now() - t0)} ms)`);
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

// performance.now() on purpose: scenario W10 freezes Date.now (see the header
// note), and a frozen timeout clock could never fire.
function waitTerminal(id, terminalTypes, startIdx, timeoutMs = JOB_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
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
      if (performance.now() - t0 > timeoutMs) {
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

function rootJobDirs() {
  if (!engineModule) return [];
  return engineModule.FS.readdir('/').filter((n) => /^job\d+$/.test(n));
}

const enc = new TextEncoder();

function bufOf(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}
function asBuffer(ab) {
  return Buffer.from(new Uint8Array(ab));
}

// ------------------------------------------------------------- job helpers ---

// One compress job. `spec.files` / `spec.dirs` are attached ONLY when the key is
// present, so "dirs absent" is genuinely absent (not undefined-valued).
async function compressJob(spec) {
  const id = nextId();
  const msg = {
    id,
    type: 'compress',
    archiveName: spec.archiveName || 'folder.7z',
    format: spec.format || '7z',
    level: spec.level === undefined ? '1' : spec.level,
  };
  if ('files' in spec) {
    msg.files = (spec.files || []).map((f) => ({ path: f.path, data: bufOf(f.data) }));
  }
  if ('dirs' in spec) msg.dirs = spec.dirs;
  if (spec.password !== undefined) {
    msg.password = spec.password;
    msg.encryptHeaders = !!spec.encryptHeaders;
  }
  const res = await sendAndWait(msg, ['compress-result', 'error']);
  assertJobDirCleaned(id);
  return { id, res, msg };
}

// Compress and require success; returns the archive bytes.
async function compressOk(spec, what) {
  const job = await compressJob(spec);
  assert(
    job.res.response.type === 'compress-result',
    `${what}: expected compress-result, got error '${job.res.response.message}'`
  );
  const arc = job.res.response.archive;
  assert(arc && typeof arc.name === 'string' && arc.name.length > 0, `${what}: archive.name present`);
  assert(arc.data && typeof arc.data.byteLength === 'number', `${what}: archive.data is binary`);
  assert(
    Array.isArray(job.res.transfer) && job.res.transfer.length === 1 && job.res.transfer[0] === arc.data,
    `${what}: archive ArrayBuffer sent in the transfer list`
  );
  return { ...job, bytes: arc.data, name: arc.name };
}

async function listArchive(name, bytes, password) {
  const id = nextId();
  const msg = { id, type: 'list', archive: { name, data: bytes } };
  if (password !== undefined) msg.password = password;
  const res = await sendAndWait(msg, ['list-result', 'error']);
  assertJobDirCleaned(id);
  return { id, res };
}

async function listOk(name, bytes, password, what) {
  const l = await listArchive(name, bytes, password);
  assert(l.res.response.type === 'list-result', `${what}: list failed: ${l.res.response.message}`);
  return l.res.response.entries;
}

async function extractAll(name, bytes) {
  const id = nextId();
  const res = await sendAndWait({ id, type: 'extract', archive: { name, data: bytes } }, [
    'extract-result',
    'error',
  ]);
  assertJobDirCleaned(id);
  const byPath = new Map();
  for (const f of res.response.files || []) byPath.set(f.path, asBuffer(f.data));
  return { id, res, byPath };
}

const folderPaths = (entries) => entries.filter((e) => e.isFolder).map((e) => e.path).sort();
const filePaths = (entries) => entries.filter((e) => !e.isFolder).map((e) => e.path).sort();

function assertError(res, id, expectedMessage) {
  assert(res.response.type === 'error', `id ${id}: expected {type:'error'}, got '${res.response.type}'`);
  assert(
    res.response.message === expectedMessage,
    `id ${id}: expected error '${expectedMessage}', got '${res.response.message}'`
  );
}

// ------------------------------------------------------- listfile-mode facts ---

// The guard's budget, parsed out of the worker source so the assertion tracks
// the real constant instead of a copy that can drift.
const capMatch = workerSource.match(/var MAX_COMPRESS_ARGV_BYTES = (\d+) \* (\d+);/);
assert(capMatch, 'worker.js declares MAX_COMPRESS_ARGV_BYTES as a byte budget');
const MAX_COMPRESS_ARGV_BYTES = Number(capMatch[1]) * Number(capMatch[2]);
assert(MAX_COMPRESS_ARGV_BYTES === 512 * 1024, `budget is 512 KiB (got ${MAX_COMPRESS_ARGV_BYTES})`);
assert(
  workerSource.includes("'@' + jobDir + '/paths.txt'"),
  'worker.js builds an ABSOLUTE listfile reference under /job<id>'
);

// Mirror of the worker's argv byte accounting (utf8Length(arg) + 1 NUL each)
// for the FULL candidate argv, used to prove which mode a batch takes.
function candidateArgvBytes(id, archiveName, paths, format, level, password) {
  const args = ['a', `/job${id}/out/${archiveName}`].concat(paths, [
    '-bd',
    '-y',
    '-t' + format,
    '-mx' + level,
  ]);
  if (password) args.push('-p' + password);
  let total = 0;
  for (const a of args) total += Buffer.byteLength(String(a), 'utf8') + 1;
  return total;
}

// A batch whose inline argv is provably over the budget: 4000 files with
// ~140-byte relative paths (~559 KiB of marshalled strings). Level 1 keeps the
// engine run short; these scenarios assert protocol and results, not ratio.
const BIG_COUNT = 4000;
const BIG_PAD = 'z'.repeat(112);
let bigBatchCache = null;
function bigBatch() {
  if (bigBatchCache) return bigBatchCache;
  const out = [];
  for (let i = 0; i < BIG_COUNT; i++) {
    out.push({
      path: `batch/dir${i % 40}/file-${String(i).padStart(5, '0')}-${BIG_PAD}.txt`,
      data: enc.encode(`payload ${i}\n`),
    });
  }
  bigBatchCache = out;
  return out;
}
const bigPaths = () => bigBatch().map((f) => f.path);

// ---------------------------------------------------------------- scenarios ---

assert(typeof context.self.onmessage === 'function', 'worker.js assigns self.onmessage');

await runScenario('init -> ready', async () => {
  const id = nextId();
  const res = await sendAndWait({ id, type: 'init' }, ['ready', 'error']);
  assert(res.response.type === 'ready', "expected {type:'ready'}");
  assert(engineModule && typeof engineModule.callMain === 'function', 'engine Module initialized');
});

const contentA = enc.encode('folder-compress payload A\n'.repeat(12));
const contentB = enc.encode('nested payload with unicode: ünicode ✓ 7-Zip\n'.repeat(12));
const contentC = enc.encode('top level payload C\n'.repeat(8));

await runScenario('empty batch: files:[] with dirs absent / null / [] keeps the legacy error', async () => {
  for (const spec of [{ files: [] }, { files: [], dirs: null }, { files: [], dirs: [] }, {}]) {
    const job = await compressJob(spec);
    assertError(job.res, job.id, 'compress: no input files');
  }
  // A dirs-only request is NOT an empty batch (W1 covers the success path).
  assert(rootJobDirs().length === 0, 'no /job dirs left behind by the failed batches');
});

await runScenario('W1 dirs-only 7z: {files:[],dirs:["photos"]} stores a directory entry', async () => {
  const arc = await compressOk(
    { files: [], dirs: ['photos'], archiveName: 'photos-only.7z', format: '7z' },
    'W1'
  );
  const sig = asBuffer(arc.bytes).subarray(0, 6);
  assert(
    sig[0] === 0x37 && sig[1] === 0x7a && sig[2] === 0xbc && sig[3] === 0xaf && sig[4] === 0x27 && sig[5] === 0x1c,
    'W1: archive starts with the 7z signature'
  );
  const entries = await listOk(arc.name, arc.bytes, undefined, 'W1');
  assert(entries.length === 1, `W1: exactly one entry (got ${entries.length}: ${JSON.stringify(entries)})`);
  const e = entries[0];
  assert(e.path === 'photos', `W1: entry path is 'photos' (got '${e.path}')`);
  // 7z marks directories ONLY via 'Attributes = D drwxrwxrwx' (no Folder
  // field); parseSltListing turns that into isFolder === true.
  assert(e.isFolder === true, 'W1: entry is a directory (Attributes "D ...")');
  assert(e.size === 0, 'W1: directory entry has size 0');
  assert(e.encrypted === false, 'W1: not encrypted');
});

await runScenario('W2 dirs-only zip: the folder is detected via "Folder = +"', async () => {
  const arc = await compressOk(
    { files: [], dirs: ['photos'], archiveName: 'photos-only.zip', format: 'zip' },
    'W2'
  );
  const sig = asBuffer(arc.bytes).subarray(0, 4);
  assert(sig[0] === 0x50 && sig[1] === 0x4b, 'W2: archive starts with the zip signature');
  const entries = await listOk(arc.name, arc.bytes, undefined, 'W2');
  assert(entries.length === 1, `W2: exactly one entry (got ${entries.length})`);
  assert(entries[0].path === 'photos', `W2: entry path is 'photos' (got '${entries[0].path}')`);
  assert(entries[0].isFolder === true, 'W2: entry is a directory (zip emits Folder = +)');
  assert(entries[0].size === 0, 'W2: directory entry has size 0');
});

await runScenario('W3 mixed files + a separate empty dir, nested paths, extract roundtrip', async () => {
  const files = [
    { path: 'docs/readme.txt', data: contentA },
    { path: 'docs/sub/notes.txt', data: contentB },
    { path: 'root.txt', data: contentC },
  ];
  const arc = await compressOk(
    { files, dirs: ['empty/photos'], archiveName: 'mixed.7z', format: '7z' },
    'W3'
  );
  const entries = await listOk(arc.name, arc.bytes, undefined, 'W3');
  const gotFiles = filePaths(entries);
  const wantFiles = files.map((f) => f.path).sort();
  assert(
    gotFiles.length === wantFiles.length && gotFiles.every((p, i) => p === wantFiles[i]),
    `W3: files listed exactly [${wantFiles.join(', ')}] (got [${gotFiles.join(', ')}])`
  );
  // The requested empty dir IS stored; 7z does not add entries for the
  // intermediate directories of the FILE paths (observed: only 'empty/photos').
  const folders = folderPaths(entries);
  assert(
    folders.length === 1 && folders[0] === 'empty/photos',
    `W3: only the requested empty dir is a folder entry (got [${folders.join(', ')}])`
  );
  for (const e of entries) {
    if (e.isFolder) assert(e.size === 0, `W3: folder '${e.path}' has size 0`);
    else assert(e.size > 0, `W3: file '${e.path}' has a non-zero size`);
  }

  const x = await extractAll(arc.name, arc.bytes);
  assert(x.res.response.type === 'extract-result', 'W3: extract answered: ' + x.res.response.message);
  // extract-result carries regular FILES only (walkOutDir), so the empty
  // directory yields no entry here — the three files must be byte-identical.
  assert(x.byPath.size === 3, `W3: 3 files extracted (got ${x.byPath.size}: ${[...x.byPath.keys()]})`);
  for (const f of files) {
    assert(x.byPath.has(f.path), `W3: '${f.path}' came back`);
    assert(x.byPath.get(f.path).equals(Buffer.from(f.data)), `W3: '${f.path}' byte-identical`);
  }
  assert(
    Array.isArray(x.res.transfer) && x.res.transfer.length === 3,
    'W3: all three ArrayBuffers sent in the transfer list'
  );
});

await runScenario('W4 nested empties dirs:["a","a/b"]: both listed once, no crash', async () => {
  const arc = await compressOk(
    { files: [{ path: 'top.txt', data: contentC }], dirs: ['a', 'a/b'], archiveName: 'nested-empty.7z' },
    'W4'
  );
  const entries = await listOk(arc.name, arc.bytes, undefined, 'W4');
  const folders = folderPaths(entries);
  assert(
    folders.length === 2 && folders[0] === 'a' && folders[1] === 'a/b',
    `W4: folders are exactly [a, a/b] (got [${folders.join(', ')}])`
  );
  assert(folders.filter((p) => p === 'a').length === 1, 'W4: 7zz de-duplicated the nested dir (one entry each)');
  const files = filePaths(entries);
  assert(files.length === 1 && files[0] === 'top.txt', `W4: file entry is top.txt (got [${files.join(', ')}])`);
});

await runScenario('W4b a deep empty dir path stores only the requested dir', async () => {
  const arc = await compressOk(
    { files: [{ path: 'keep.txt', data: contentC }], dirs: ['deep/a/b'], archiveName: 'deep-empty.7z' },
    'W4b'
  );
  const entries = await listOk(arc.name, arc.bytes, undefined, 'W4b');
  const folders = folderPaths(entries);
  // OBSERVED: 7z stores ONLY the directory that was requested — its ancestors
  // stay implicit (extraction re-creates them from the entry path), so a deep
  // empty dir costs exactly one entry.
  assert(
    folders.length === 1 && folders[0] === 'deep/a/b',
    `W4b: the requested dir alone is stored (got [${folders.join(', ')}])`
  );
  assert(filePaths(entries).join(',') === 'keep.txt', 'W4b: the file entry is unchanged');
});

await runScenario('W4c a dir that is the PARENT of a queued file: one entry, no duplicate', async () => {
  // Measured on this build: 7zz de-duplicates a directory passed alongside its
  // own contents, so a caller that sends a non-empty dir does not double-add
  // anything (the app only ever sends EMPTY dirs, but the protocol must not
  // depend on that).
  const arc = await compressOk(
    {
      files: [{ path: 'd/dfile.txt', data: contentA }, { path: 'other.txt', data: contentC }],
      dirs: ['d'],
      archiveName: 'w4c.7z',
    },
    'W4c'
  );
  const entries = await listOk(arc.name, arc.bytes, undefined, 'W4c');
  const files = filePaths(entries);
  assert(
    files.length === 2 && files.join(',') === 'd/dfile.txt,other.txt',
    `W4c: each file appears exactly once (got [${files.join(', ')}])`
  );
  assert(files.filter((p) => p === 'd/dfile.txt').length === 1, 'W4c: no duplicate entry for the file under the dir');
  const x = await extractAll(arc.name, arc.bytes);
  assert(x.byPath.get('d/dfile.txt').equals(Buffer.from(contentA)), 'W4c: payload byte-identical');
});

await runScenario('W5 dir path equal to a file path -> duplicate input path', async () => {
  const job = await compressJob({
    files: [{ path: 'x.txt', data: contentA }],
    dirs: ['x.txt'],
    archiveName: 'w5.7z',
  });
  assertError(job.res, job.id, 'compress: duplicate input path: x.txt');
  // Order is irrelevant: dirs are validated against the file list either way.
  const job2 = await compressJob({
    files: [{ path: 'nested/x.txt', data: contentA }],
    dirs: ['nested/x.txt'],
    archiveName: 'w5b.7z',
  });
  assertError(job2.res, job2.id, 'compress: duplicate input path: nested/x.txt');
});

await runScenario('W6 the same dir twice -> duplicate input path', async () => {
  const job = await compressJob({ files: [], dirs: ['dup', 'dup'], archiveName: 'w6.7z' });
  assertError(job.res, job.id, 'compress: duplicate input path: dup');
});

await runScenario('W7 dir "a/b" while file "a" exists -> conflicts with a file', async () => {
  const job = await compressJob({
    files: [{ path: 'a', data: contentA }],
    dirs: ['a/b'],
    archiveName: 'w7.7z',
  });
  assertError(job.res, job.id, 'compress: directory path conflicts with a file: a/b');
  assert(rootJobDirs().length === 0, 'W7: the failed job still cleaned up /job<id>');
  // The worker stays healthy after the failure.
  const arc = await compressOk({ files: [{ path: 'a', data: contentA }], archiveName: 'w7-after.7z' }, 'W7-after');
  assert(asBuffer(arc.bytes).byteLength > 32, 'W7: worker still compresses after the conflict error');
});

await runScenario('W8 invalid dir paths: "", null, ".." -> invalid directory path', async () => {
  for (const bad of ['', null, '..', './', 'a/../..']) {
    const job = await compressJob({ files: [], dirs: [bad], archiveName: 'w8.7z' });
    assertError(job.res, job.id, 'compress: invalid directory path in request');
  }
  // A non-array dirs field is treated exactly like an absent one (NOT walked
  // one character at a time, which would create a directory per letter).
  const job2 = await compressJob({ files: [{ path: 'f.txt', data: contentA }], dirs: 'nope', archiveName: 'w8b.7z' });
  assert(job2.res.response.type === 'compress-result', 'W8b: a non-array dirs still compresses');
  const entries = await listOk('w8b.7z', job2.res.response.archive.data, undefined, 'W8b');
  assert(filePaths(entries).join(',') === 'f.txt', 'W8b: only the requested file is in the archive');
  assert(folderPaths(entries).length === 0, 'W8b: a non-array dirs created no directory entries');
});

await runScenario('W8-observed dirs:["  "] is a legal name (whitespace is not stripped)', async () => {
  // DEVIATION from the contract's expectation, pinned as observed: safeRelPath
  // keeps a spaces-only segment (the files side always has), so the directory
  // is created and stored under its literal two-space name.
  const arc = await compressOk({ files: [], dirs: ['  '], archiveName: 'w8-spaces.7z' }, 'W8-spaces');
  const entries = await listOk(arc.name, arc.bytes, undefined, 'W8-spaces');
  assert(entries.length === 1, `W8-spaces: one entry (got ${entries.length})`);
  assert(entries[0].path === '  ', `W8-spaces: path is two spaces (got ${JSON.stringify(entries[0].path)})`);
  assert(entries[0].isFolder === true, 'W8-spaces: stored as a directory');
});

await runScenario('W9 dirs:["-x"] -> leading-dash rejection (message shared with files)', async () => {
  const job = await compressJob({ files: [], dirs: ['-x'], archiveName: 'w9.7z' });
  assertError(job.res, job.id, 'compress: paths starting with "-" are not supported: -x');
  const job2 = await compressJob({ files: [], dirs: ['sub', '-x'], archiveName: 'w9b.7z' });
  assertError(job2.res, job2.id, 'compress: paths starting with "-" are not supported: -x');
  // The rule looks at the FIRST character of the whole relative path (exactly
  // like the files side), so a dash in a later segment is a legal name and is
  // stored: it cannot be mistaken for a switch by the engine.
  const arc = await compressOk(
    { files: [{ path: 'ok.txt', data: contentA }], dirs: ['sub/-deeper'], archiveName: 'w9c.7z' },
    'W9c'
  );
  const entries = await listOk(arc.name, arc.bytes, undefined, 'W9c');
  assert(folderPaths(entries).join(',') === 'sub/-deeper', 'W9c: an interior leading dash is stored as-is');
  assert(filePaths(entries).join(',') === 'ok.txt', 'W9c: the file entry is unchanged');
});

await runScenario('W10 {files} vs {files,dirs:[]} vs {files,dirs:null} -> byte-identical archives', async () => {
  const files = [
    { path: 'one.txt', data: contentA },
    { path: 'sub/two.txt', data: contentB },
  ];
  const specs = [
    { files, archiveName: 'det.7z' }, // dirs genuinely absent
    { files, dirs: [], archiveName: 'det.7z' },
    { files, dirs: null, archiveName: 'det.7z' },
  ];
  const built = [];
  // Freeze the MEMFS timestamp source so the comparison isolates the dirs
  // field instead of entry mtimes (see the header note).
  const realNow = Date.now;
  const frozen = realNow();
  try {
    Date.now = () => frozen;
    for (const spec of specs) built.push(await compressOk(spec, 'W10'));
  } finally {
    Date.now = realNow;
  }
  const base = asBuffer(built[0].bytes);
  for (let i = 1; i < built.length; i++) {
    const other = asBuffer(built[i].bytes);
    assert(
      other.equals(base),
      `W10: variant ${i} byte-identical to the legacy form (${other.byteLength} vs ${base.byteLength} bytes)`
    );
  }
  const listings = [];
  for (const arc of built) listings.push(await listOk(arc.name, arc.bytes, undefined, 'W10'));
  for (let i = 1; i < listings.length; i++) {
    assert(
      JSON.stringify(listings[i]) === JSON.stringify(listings[0]),
      `W10: variant ${i} lists identically to the legacy form`
    );
  }
  assert(filePaths(listings[0]).join(',') === 'one.txt,sub/two.txt', 'W10: legacy listing content');
  assert(folderPaths(listings[0]).length === 0, 'W10: no folder entries for implicit parents');
});

await runScenario('W11 listfile mode: 4000 long paths compress, list and extract roundtrip', async () => {
  const files = bigBatch();
  const paths = bigPaths();
  const arc = await compressOk({ files, archiveName: 'big.7z', format: '7z', level: '1' }, 'W11');

  // Prove WHICH mode ran: the inline argv for this batch is over the worker's
  // budget, so the guard must have moved the names into /job<id>/paths.txt.
  // (Success alone is the real point — an unguarded argv of this size is on the
  // path to the allocateUTF8OnStack brick — but paths.txt is gone by the time
  // the job replies, so the observable is the byte accounting + the source.)
  const argv = candidateArgvBytes(arc.id, arc.name, paths, '7z', '1');
  assert(
    argv > MAX_COMPRESS_ARGV_BYTES,
    `W11: inline argv (${argv} B) exceeds the ${MAX_COMPRESS_ARGV_BYTES} B budget -> listfile mode`
  );
  assert(
    workerSource.includes('if (argvBytes(args) > MAX_COMPRESS_ARGV_BYTES)'),
    'W11: worker.js switches to listfile mode above the budget'
  );

  const entries = await listOk(arc.name, arc.bytes, undefined, 'W11');
  assert(entries.length === BIG_COUNT, `W11: ${BIG_COUNT} entries listed (got ${entries.length})`);
  const gotFiles = filePaths(entries);
  const want = paths.slice().sort();
  assert(
    gotFiles.length === want.length && gotFiles.every((p, i) => p === want[i]),
    'W11: every requested path is in the listing, exactly once'
  );
  assert(folderPaths(entries).length === 0, 'W11: no folder entries for implicit parents');

  const x = await extractAll(arc.name, arc.bytes);
  assert(x.res.response.type === 'extract-result', 'W11: extract answered: ' + x.res.response.message);
  assert(x.byPath.size === BIG_COUNT, `W11: ${BIG_COUNT} files extracted (got ${x.byPath.size})`);
  let mismatched = 0;
  for (const f of files) {
    const got = x.byPath.get(f.path);
    if (!got || !got.equals(Buffer.from(f.data))) mismatched++;
  }
  assert(mismatched === 0, `W11: every extracted file byte-identical (${mismatched} mismatches)`);
  assert(rootJobDirs().length === 0, 'W11: no /job dirs left (paths.txt cleaned up with the job)');
});

await runScenario('W11b listfile mode preserves UTF-8 names (files and dirs)', async () => {
  // paths.txt is written with FS.writeFile(path, STRING), which the emscripten
  // glue encodes as UTF-8 (stringToUTF8Array) — the same bytes the engine would
  // have received on the argv. A Latin-1 slip here would corrupt every
  // non-ASCII name in a large folder pick, so pin it end to end.
  const unicode = [
    { path: '日本語のフォルダ/名前.txt', data: contentA },
    { path: 'emoji-✓-name.txt', data: contentB },
    { path: 'spaced name with ü.txt', data: contentC },
  ];
  const dirs = ['空っぽ', 'nested/✓-empty'];
  const files = bigBatch().concat(unicode);
  const arc = await compressOk({ files, dirs, archiveName: 'big-utf8.7z', level: '1' }, 'W11b');
  const argv = candidateArgvBytes(arc.id, arc.name, bigPaths().concat(unicode.map((f) => f.path), dirs), '7z', '1');
  assert(argv > MAX_COMPRESS_ARGV_BYTES, `W11b: over budget (${argv} B) -> listfile mode`);

  const entries = await listOk(arc.name, arc.bytes, undefined, 'W11b');
  const gotFiles = filePaths(entries);
  for (const f of unicode) {
    assert(gotFiles.includes(f.path), `W11b: '${f.path}' listed with its real UTF-8 name`);
  }
  const folders = folderPaths(entries);
  for (const d of dirs) {
    assert(folders.includes(d), `W11b: empty dir '${d}' listed`);
  }
  assert(gotFiles.length === BIG_COUNT + unicode.length, `W11b: ${BIG_COUNT + unicode.length} files (got ${gotFiles.length})`);

  const x = await extractAll(arc.name, arc.bytes);
  for (const f of unicode) {
    assert(x.byPath.has(f.path), `W11b: '${f.path}' extracted under the same name`);
    assert(x.byPath.get(f.path).equals(Buffer.from(f.data)), `W11b: '${f.path}' byte-identical`);
  }
});

await runScenario('W11c listfile mode preserves whitespace-edged names (quoted listfile lines)', async () => {
  // 7zz TRIMS an unquoted listfile line before resolving it, so a name with a
  // leading/trailing space or tab used to match nothing on disk — the engine
  // only warned (rc 1, tolerated) and the archive came back silently missing
  // those entries while the worker still replied compress-result. The listfile
  // body therefore quotes every line; this pins the round trip AND the
  // argv-mode agreement for the same names.
  const odd = [
    { path: ' lead.txt', data: contentA },
    { path: 'trail.txt ', data: contentB },
    { path: 'both ends ', data: contentC },
    { path: 'spaced dir /inner .txt', data: contentA },
    { path: '\ttab.txt', data: contentB },
  ];
  const oddDirs = ['  ', ' spaced ', 'ok-dir'];

  // argv mode (small batch) is the reference: these names are legal there and
  // always have been.
  const small = await compressOk(
    { files: odd, dirs: oddDirs, archiveName: 'odd-small.7z', level: '1' },
    'W11c-argv'
  );
  const smallEntries = await listOk(small.name, small.bytes, undefined, 'W11c-argv');
  const smallFiles = filePaths(smallEntries);
  assert(
    smallFiles.includes(' lead.txt') && smallFiles.includes('trail.txt ') && smallFiles.includes('both ends '),
    'W11c: argv mode stores space-edged names exactly (' + JSON.stringify(smallFiles) + ')'
  );
  assert(
    folderPaths(smallEntries).every((d) => oddDirs.includes(d)) && oddDirs.every((d) => folderPaths(smallEntries).includes(d)),
    'W11c: argv mode stores whitespace-only/spaced dirs exactly (' + JSON.stringify(folderPaths(smallEntries)) + ')'
  );
  const smallX = await extractAll(small.name, small.bytes);
  assert(smallX.byPath.has('\ttab.txt'), 'W11c: argv mode stores the tab-edged name (listing renders it "_tab.txt")');

  // listfile mode must agree entry for entry.
  const files = bigBatch().concat(odd);
  const arc = await compressOk(
    { files, dirs: oddDirs, archiveName: 'odd-big.7z', level: '1' },
    'W11c-listfile'
  );
  const argv = candidateArgvBytes(
    arc.id,
    arc.name,
    bigPaths().concat(odd.map((f) => f.path), oddDirs),
    '7z',
    '1'
  );
  assert(argv > MAX_COMPRESS_ARGV_BYTES, `W11c: over budget (${argv} B) -> listfile mode`);

  // The silent-drop mechanism was a warning-only rc, so pin the absence of one.
  const warned = arc.res.related.filter(
    (m) => m.msg.type === 'progress' && /WARNING|No such file/i.test(String(m.msg.line))
  );
  assert(warned.length === 0, 'W11c: the engine warned about nothing (' + JSON.stringify(warned.map((w) => w.msg.line)) + ')');

  const entries = await listOk(arc.name, arc.bytes, undefined, 'W11c-listfile');
  assert(
    entries.length === BIG_COUNT + odd.length + oddDirs.length,
    `W11c: every entry made it in (${entries.length} != ${BIG_COUNT + odd.length + oddDirs.length})`
  );
  const gotFiles = filePaths(entries);
  for (const f of [' lead.txt', 'trail.txt ', 'both ends ', 'spaced dir /inner .txt']) {
    assert(gotFiles.includes(f), `W11c: listfile mode stores '${f}' exactly`);
  }
  const folders = folderPaths(entries);
  for (const d of oddDirs) {
    assert(folders.includes(d), `W11c: listfile mode stores dir '${d}' exactly`);
  }

  const x = await extractAll(arc.name, arc.bytes);
  for (const f of odd) {
    assert(x.byPath.has(f.path), `W11c: '${JSON.stringify(f.path)}' extracted under the same name`);
    assert(x.byPath.get(f.path).equals(Buffer.from(f.data)), `W11c: '${JSON.stringify(f.path)}' byte-identical`);
  }
  assert(x.byPath.size === BIG_COUNT + odd.length, `W11c: ${BIG_COUNT + odd.length} files extracted (got ${x.byPath.size})`);
});

await runScenario('W12 listfile-mode batch that also carries dirs:["e"]', async () => {
  const files = bigBatch();
  const arc = await compressOk(
    { files, dirs: ['e'], archiveName: 'big-dirs.7z', format: '7z', level: '1' },
    'W12'
  );
  const argv = candidateArgvBytes(arc.id, arc.name, bigPaths().concat(['e']), '7z', '1');
  assert(argv > MAX_COMPRESS_ARGV_BYTES, `W12: over budget (${argv} B) -> listfile mode`);
  const entries = await listOk(arc.name, arc.bytes, undefined, 'W12');
  assert(entries.length === BIG_COUNT + 1, `W12: ${BIG_COUNT + 1} entries (got ${entries.length})`);
  const folders = folderPaths(entries);
  assert(folders.length === 1 && folders[0] === 'e', `W12: folder entry 'e' present (got [${folders.join(', ')}])`);
  assert(
    filePaths(entries).length === BIG_COUNT,
    'W12: the dir rode along in the listfile without disturbing the files'
  );
});

await runScenario('W12b listfile mode keeps the password switches working', async () => {
  const arc = await compressOk(
    {
      files: bigBatch(),
      dirs: ['e'],
      archiveName: 'big-secret.7z',
      format: '7z',
      level: '1',
      password: 'sekrit',
      encryptHeaders: true,
    },
    'W12b'
  );
  const argv = candidateArgvBytes(arc.id, arc.name, bigPaths().concat(['e']), '7z', '1', 'sekrit');
  assert(argv > MAX_COMPRESS_ARGV_BYTES, `W12b: over budget (${argv} B) -> listfile mode`);
  const entries = await listOk(arc.name, arc.bytes, 'sekrit', 'W12b');
  assert(entries.length === BIG_COUNT + 1, `W12b: ${BIG_COUNT + 1} entries (got ${entries.length})`);
  // OBSERVED: every FILE entry is encrypted, while the directory entry carries
  // no data and is listed 'Encrypted = -' even under -mhe=on.
  const files = entries.filter((e) => !e.isFolder);
  assert(files.length === BIG_COUNT, `W12b: ${BIG_COUNT} file entries (got ${files.length})`);
  assert(files.every((e) => e.encrypted === true), 'W12b: every file encrypted (-p survived the switch to listfile)');
  const folders = entries.filter((e) => e.isFolder);
  assert(folders.length === 1 && folders[0].path === 'e', 'W12b: the empty dir rode along');
  assert(folders[0].encrypted === false, 'W12b: a directory entry is listed unencrypted (no data to encrypt)');
  // The two no-password requests below make the engine prompt for a password,
  // hit the forced-EOF stdin and THROW out of callMain — run7z catches it and
  // the worker logs '[7zip-web worker] callMain threw: <ptr>' on stderr. That
  // noise is expected here; the scenario after this one proves the engine is
  // still healthy afterwards.
  const noPw = await listArchive(arc.name, arc.bytes);
  assert(
    noPw.res.response.type === 'error' || (noPw.res.response.entries || []).length === 0,
    'W12b: listing without the password does not reveal the entries (-mhe=on)'
  );
  const x = await extractAll(arc.name, arc.bytes);
  assert(x.res.response.type === 'error', 'W12b: extract without the password fails');
});

await runScenario('W13 listfile mode + "\\n" in a name -> rejected', async () => {
  const weird = 'batch/dir0/broken\nname.txt';
  const files = bigBatch().concat([{ path: weird, data: contentC }]);
  const job = await compressJob({ files, archiveName: 'w13.7z', level: '1' });
  assertError(
    job.res,
    job.id,
    'compress: names with line breaks are not supported in large batches: ' + weird
  );
  // '\r' is rejected by the same rule.
  const cr = 'batch/dir1/carriage\rreturn.txt';
  const job2 = await compressJob({ files: bigBatch().concat([{ path: cr, data: contentC }]), archiveName: 'w13b.7z', level: '1' });
  assertError(
    job2.res,
    job2.id,
    'compress: names with line breaks are not supported in large batches: ' + cr
  );
  assert(rootJobDirs().length === 0, 'W13: rejected batches still cleaned up /job<id>');
});

await runScenario('W14 argv mode + "\\n" in a name: legacy acceptance is unchanged', async () => {
  // OBSERVED against the real engine (small batch, argv mode): rc 0, the entry
  // is LISTED with the control character sanitized to '_' (exactly how the
  // 'l -slt' listing treats hostile names elsewhere) and EXTRACTS under its
  // real name. No new validation was added to argv mode.
  const weird = 'line1\nline2.txt';
  const arc = await compressOk(
    { files: [{ path: weird, data: contentA }, { path: 'plain.txt', data: contentC }], archiveName: 'w14.7z' },
    'W14'
  );
  const entries = await listOk(arc.name, arc.bytes, undefined, 'W14');
  const listed = filePaths(entries);
  assert(
    listed.length === 2 && listed.includes('line1_line2.txt') && listed.includes('plain.txt'),
    `W14: listing sanitizes the control char (got [${listed.map((p) => JSON.stringify(p)).join(', ')}])`
  );
  const x = await extractAll(arc.name, arc.bytes);
  assert(x.res.response.type === 'extract-result', 'W14: extract answered: ' + x.res.response.message);
  assert(x.byPath.has(weird), 'W14: the file extracts under its REAL name (with the line break)');
  assert(x.byPath.get(weird).equals(Buffer.from(contentA)), 'W14: payload byte-identical');
});

await runScenario('W15 listfile mode + a leading quote name -> rejected', async () => {
  // The rule is about the FIRST character of the path: only a line that STARTS
  // with '"' is at risk of 7zz stripping wrapping quotes off it.
  const quoted = '"quoted".txt';
  const files = bigBatch().concat([{ path: quoted, data: contentC }]);
  const job = await compressJob({ files, archiveName: 'w15.7z', level: '1' });
  assertError(
    job.res,
    job.id,
    'compress: names starting with a quote are not supported in large batches: ' + quoted
  );
  // A quote anywhere else in the path is fine (7zz only strips WRAPPING quotes).
  const inner = bigBatch().concat([{ path: 'batch/dir1/in"side.txt', data: contentC }]);
  const arc = await compressOk({ files: inner, archiveName: 'w15b.7z', level: '1' }, 'W15b');
  const argv = candidateArgvBytes(arc.id, arc.name, bigPaths().concat(['batch/dir1/in"side.txt']), '7z', '1');
  assert(argv > MAX_COMPRESS_ARGV_BYTES, `W15b: over budget (${argv} B) -> listfile mode`);
  const entries = await listOk(arc.name, arc.bytes, undefined, 'W15b');
  assert(
    filePaths(entries).includes('batch/dir1/in"side.txt'),
    'W15b: an interior quote survives listfile mode'
  );
  assert(rootJobDirs().length === 0, 'W15: rejected batch still cleaned up /job<id>');
});

await runScenario('W16 dirs:["a/../b"] normalizes via safeRelPath to "b"', async () => {
  const arc = await compressOk(
    { files: [{ path: 'keep.txt', data: contentC }], dirs: ['a/../b'], archiveName: 'w16.7z' },
    'W16'
  );
  const entries = await listOk(arc.name, arc.bytes, undefined, 'W16');
  assert(folderPaths(entries).join(',') === 'b', `W16: folder entry is 'b' (got [${folderPaths(entries).join(', ')}])`);
  assert(filePaths(entries).join(',') === 'keep.txt', 'W16: file entry unchanged');
  // Normalization happens BEFORE the duplicate check, so 'a/../b' and 'b'
  // collide exactly like two spellings of the same file path would.
  const job = await compressJob({ files: [], dirs: ['a/../b', 'b'], archiveName: 'w16b.7z' });
  assertError(job.res, job.id, 'compress: duplicate input path: b');
});

await runScenario('aftermath: engine healthy, MEMFS clean', async () => {
  assert(rootJobDirs().length === 0, 'no /job dirs left at the end');
  const arc = await compressOk(
    { files: [{ path: 'final.txt', data: contentA }], dirs: ['final-empty'], archiveName: 'final.7z' },
    'final'
  );
  const entries = await listOk(arc.name, arc.bytes, undefined, 'final');
  assert(filePaths(entries).join(',') === 'final.txt', 'final: file listed');
  assert(folderPaths(entries).join(',') === 'final-empty', 'final: empty dir listed');
  assert(rootJobDirs().length === 0, 'still no /job dirs left');
});

// ---------------------------------------------------------------- summary ---

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`scenarios: ${results.length}, passed: ${results.length - failed.length}, failed: ${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(`  FAILED: ${f.name}`);
}
console.log(failed.length ? 'RESULT: FAIL' : 'RESULT: PASS (all folder-compress scenarios green)');

// The emscripten glue sets process.exitCode = <rc> of every callMain; decide
// the exit status explicitly here instead.
process.exitCode = failed.length ? 1 : 0;
