/*
 * worker.js — 7-Zip WebAssembly engine worker (classic Worker script, no modules).
 *
 * Speaks the binding WORKER MESSAGE PROTOCOL with app.js:
 *   main -> worker: {id,type:'init'}
 *                   | {id,type:'list',archive:{name,data},archiveKey,password?}   (staging)
 *                   | {id,type:'extract'|'test',archiveKey,password?,paths?}      (keyed)
 *                   | {id,type:'list'|'extract'|'test',archive:{name,data},password?,paths?}
 *                   | {id,type:'compress',files:[{path,data}],dirs?:[path],archiveName,format,level,password?,encryptHeaders}
 *                   | {type:'evict'}                                              (no id)
 *   worker -> main: {id,type:'ready'|'progress'|'list-result'|'extract-result'|'compress-result'|'test-result'|'error',...}
 *
 * STAGE-ONCE ARCHIVE CACHE. A 'list' that carries BOTH a non-empty
 * 'archiveKey' string and archive bytes stages those bytes PERSISTENTLY under
 * /arc/<seq>/<name> (never inside /job<id>) and remembers the parsed listing
 * with them (unless it is too big for the coverage index to ever consult). Later 'extract'/'test' requests reference the same key and carry
 * NO bytes at all: the engine reads the staged file in place, so a big archive
 * is copied into MEMFS exactly once per open instead of once per operation.
 * Staging a new key evicts every previously staged archive first, so worker
 * MEMFS holds at most ONE archive copy at any time. '{type:'evict'}' (sent by
 * Clear, fire-and-forget: it carries no id and gets NO reply) drops the whole
 * store immediately. A keyed request whose key is unknown — never staged,
 * evicted, or lost with a restarted worker — answers
 * {type:'error', message:'extract: unknown archiveKey'} (or 'test: …'), which
 * app.js turns into a transparent re-stage + one retry.
 * The LEGACY byte form (archive:{name,data}, no archiveKey) keeps working
 * unchanged for all three ops: it stages into /job<id>/in, caches nothing and
 * evicts nothing.
 *
 * 'extract' additionally accepts an OPTIONAL paths:[string,...] field — entry
 * paths exactly as the 'l -slt' listing returned them — restricting the job to
 * that selection (FILTERED / FULL modes + post-filter, see runExtractJob).
 * Absent, null or empty paths keep the unfiltered full-extraction behavior.
 *
 * 'compress' additionally accepts an OPTIONAL dirs:[string,...] field —
 * relative directory paths, created inside the job's input tree and handed to
 * the engine together with the files. That is how the EMPTY directories of a
 * folder pick survive into the archive as real directory entries (7z marks
 * them 'Attributes = D ...', zip 'Folder = +'); non-empty ones would be
 * redundant, since their files already arrive via 'files'. Absent, null or
 * empty dirs keep the files-only behavior byte-for-byte.
 *
 * 'list-result' carries ONLY {id,type,entries} — the raw 'l -slt' text used to
 * ride along but nothing ever read it ('test-result' keeps its raw tail).
 *
 * The engine is single-threaded: exactly one job runs at a time; messages that
 * arrive during init or while another job is running are queued in order.
 * Every job lives in /job<id>/in and /job<id>/out and is removed recursively
 * when the job finishes (success OR failure); /arc is job-independent and
 * survives until eviction.
 *
 * Node-testable by contract: uses ONLY self.onmessage, self.postMessage,
 * importScripts, self.location, fetch, console and JS built-ins.
 */
'use strict';

(function () {
  var WASM_GLUE_PATH = './wasm/7zz.js';
  var WASM_BINARY_PATH = './wasm/7zz.wasm';
  var VALID_LEVELS = ['0', '1', '3', '5', '7', '9'];
  var RAW_TAIL_LINES = 60; // lines kept in 'raw' of test-result
  var ERROR_TAIL_LINES = 8; // output lines embedded in error messages
  var MAX_SELECTED_PATHS = 8192; // hard cap on extract 'paths' entries
  // Byte budget for the FILTERED-mode argv. callMain marshals every argv
  // string onto the engine's FIXED-SIZE wasm stack (allocateUTF8OnStack,
  // unchecked stackAlloc): past a few MB the stack pointer plows through
  // engine memory, main() aborts and EVERY later callMain aborts too — the
  // worker is permanently bricked until the page reloads. Measured on this
  // build: ~3.8 MB of filters still ran, ~5.7 MB bricked the engine. The
  // budget stays far below that; over-budget selections simply run FULL
  // extraction + post-filter instead (identical results, only slower).
  var MAX_FILTER_ARGV_BYTES = 512 * 1024;
  // Byte budget for the COMPRESS argv — the same fixed-stack hazard, from the
  // other direction: a folder pick routinely queues thousands of relative
  // paths, and every one of them is marshalled onto the wasm stack by
  // allocateUTF8OnStack. Over budget, compress switches to a 7zz LISTFILE
  // ('@<absolute path>' stays on the argv, the names go through MEMFS
  // instead), which measured BYTE-IDENTICAL to argv mode on this build
  // (5000 paths, 4714 B both ways). That identity depends on the listfile
  // lines being QUOTE-WRAPPED — an unquoted line is trimmed by the engine, so
  // whitespace-edged names would silently vanish from the archive. See
  // listfileBody and runCompressJob.
  var MAX_COMPRESS_ARGV_BYTES = 512 * 1024;
  // Listings bigger than this are NOT indexed for the coverage-fallback
  // decision (see allUncoveredProvablyEmpty below): building the file/ancestor
  // form sets costs one pass over every entry with up to four string forms
  // each, and past this size the index build could cost more than the FULL
  // re-run it might save. Over-cap listings keep the unconditional re-run
  // behavior (and are not retained — see runListJob).
  var COVERAGE_INDEX_MAX_ENTRIES = 65536;

  // ------------------------------------------------- stage-once archive store ---
  // Persistent MEMFS root for staged archives, deliberately OUTSIDE /job<id>
  // so withJob's cleanup never touches it. At most ONE archive lives here at a
  // time (a new staging list evicts all others first), which bounds worker
  // memory at one archive copy instead of one copy per operation.
  //
  // MEMORY CONSEQUENCE: while an archive is open the worker holds ONE copy of
  // its bytes (e.g. 185 MB) until Clear or the next open. That is a strict
  // reduction versus the old always-re-stage protocol, where the main thread
  // permanently held currentArchive.data (185 MB) PLUS every operation paid a
  // 185 MB slice copy in app.js PLUS a fresh 185 MB MEMFS write in the worker.
  // Now the main thread keeps only the (disk-backed) File reference and MEMFS
  // holds one copy in total.
  var ARC_ROOT = '/arc';

  // ---------------------------------------------------------------- state ---
  var Module = null; // emscripten Module, set once init resolves
  var initPromise = null; // in-flight/resolved init promise (reset on failure)
  var sawFirstMessage = false;
  var inbox = []; // messages received but not processed yet
  var pumping = false;
  var activeJobId = null; // job id whose output print()/printErr() route to
  var logLines = []; // output lines of the current callMain invocation
  // archiveKey (caller-generated opaque string) -> staged record
  // { dir, path, name, size, listing: Array|null }. The key is only ever a Map
  // key, never a path component: /arc/<stagedSeq>/ holds the bytes.
  var stagedArchives = new Map();
  var stagedSeq = 0;

  // ------------------------------------------------------------- plumbing ---

  function post(msg, transfer) {
    if (transfer && transfer.length) self.postMessage(msg, transfer);
    else self.postMessage(msg);
  }

  function errText(e) {
    if (e === null || e === undefined) return 'Unknown error';
    if (typeof e === 'string') return e;
    if (typeof e.message === 'string' && e.message) return e.message;
    try {
      return String(e);
    } catch (ignored) {
      return 'Unknown error';
    }
  }

  // Convert an incoming binary payload (ArrayBuffer or any typed-array view,
  // possibly from another realm in the Node test harness) to a Uint8Array.
  function toU8(data) {
    if (data === null || data === undefined) {
      throw new Error('missing binary payload');
    }
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return new Uint8Array(data); // ArrayBuffer (throws TypeError otherwise)
  }

  // Make an exactly-sized copy whose .buffer can go into a transfer list.
  function ownedCopy(bytes) {
    var copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return copy;
  }

  function baseName(p) {
    var s = String(p === null || p === undefined ? '' : p);
    s = s.replace(/\\/g, '/');
    var i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
  }

  // Basename safe to use as a single MEMFS file name (never empty, no NULs).
  function safeBaseName(p, fallback) {
    var s = baseName(p).replace(/\0/g, '');
    if (s === '' || s === '.' || s === '..') return fallback;
    return s;
  }

  // Normalize a caller-supplied relative path: '/' separators, no '.', no
  // leading '/', no escaping via '..', no empty segments. '' when unusable.
  function safeRelPath(p) {
    var s = String(p === null || p === undefined ? '' : p);
    s = s.replace(/\\/g, '/').replace(/\0/g, '');
    var segs = s.split('/');
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (out.length) out.pop();
        continue;
      }
      out.push(seg);
    }
    return out.join('/');
  }

  function writeFileDeep(FS, path, bytes) {
    var slash = path.lastIndexOf('/');
    if (slash > 0) FS.mkdirTree(path.slice(0, slash));
    FS.writeFile(path, bytes);
  }

  // Recursively delete a MEMFS path (no-op when it does not exist).
  function removeTree(FS, path) {
    var st;
    try {
      st = FS.stat(path);
    } catch (missing) {
      return;
    }
    if ((st.mode & 0o170000) === 0o040000) {
      var names = [];
      try {
        names = FS.readdir(path);
      } catch (unreadable) {
        names = [];
      }
      for (var i = 0; i < names.length; i++) {
        if (names[i] === '.' || names[i] === '..') continue;
        removeTree(FS, path + '/' + names[i]);
      }
      try {
        FS.rmdir(path);
      } catch (ignored) {}
    } else {
      try {
        FS.unlink(path);
      } catch (ignored) {}
    }
  }

  // Collect every regular file under absDir; rel paths are RELATIVE to absDir.
  function walkOutDir(FS, absDir, relPrefix, found) {
    var names;
    try {
      names = FS.readdir(absDir);
    } catch (unreadable) {
      return;
    }
    names = names.slice().sort();
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (name === '.' || name === '..') continue;
      var abs = absDir + '/' + name;
      var rel = relPrefix ? relPrefix + '/' + name : name;
      var st;
      try {
        st = FS.stat(abs);
      } catch (vanished) {
        continue;
      }
      var kind = st.mode & 0o170000;
      if (kind === 0o040000) walkOutDir(FS, abs, rel, found);
      else if (kind === 0o100000) found.push({ abs: abs, rel: rel });
      // anything else (links, devices) is not produced by MEMFS jobs
    }
  }

  // ----------------------------------------------------------------- init ---

  function onEnginePrint(line) {
    var s = typeof line === 'string' ? line : String(line);
    if (s.length && s.charCodeAt(s.length - 1) === 13) s = s.slice(0, -1);
    logLines.push(s);
    if (activeJobId !== null) {
      post({ id: activeJobId, type: 'progress', line: s });
    }
  }

  function loadEngine() {
    if (typeof create7zip === 'undefined') {
      importScripts(WASM_GLUE_PATH);
    }
    if (typeof create7zip !== 'function') {
      return Promise.reject(
        new Error('create7zip factory is not defined after importScripts(' + WASM_GLUE_PATH + ')')
      );
    }
    var wasmUrl = new URL(WASM_BINARY_PATH, self.location.href).href;
    return fetch(wasmUrl)
      .then(function (resp) {
        if (!resp || typeof resp.arrayBuffer !== 'function') {
          throw new Error('fetch(' + wasmUrl + ') returned no readable response');
        }
        if (resp.ok === false) {
          throw new Error('fetch(' + wasmUrl + ') failed with status ' + resp.status);
        }
        return resp.arrayBuffer();
      })
      .then(function (wasmBuf) {
        return create7zip({
          wasmBinary: new Uint8Array(wasmBuf),
          noInitialRun: true,
          // Force immediate EOF on stdin: 7-Zip prompts for a password when an
          // encrypted archive is opened without one; under Node the default
          // TTY read can throw or block, and in a browser worker the default
          // would be a blocking prompt path. EOF makes 7z fail cleanly, which
          // run7z() reports as {type:'error'}.
          stdin: function () {
            return null;
          },
          print: onEnginePrint,
          printErr: onEnginePrint,
          locateFile: function (p) {
            return new URL('./wasm/' + p, self.location.href).href;
          },
        });
      })
      .then(function (mod) {
        if (!mod || !mod.FS || typeof mod.callMain !== 'function') {
          throw new Error('7-Zip engine initialized without FS/callMain');
        }
        Module = mod;
        return Module;
      });
  }

  function ensureInit() {
    if (!initPromise) {
      initPromise = loadEngine().catch(function (e) {
        initPromise = null; // allow the next message to retry
        throw e;
      });
    }
    return initPromise;
  }

  // --------------------------------------------------------------- engine ---

  // Run one 7z command. callMain can THROW instead of returning an exit code
  // (the wasm build leaks C++ exception pointers on some fatal errors, e.g.
  // "no such file"), so it is always wrapped; a throw counts as a fatal error.
  function run7z(args) {
    logLines = [];
    var rc = 0;
    var crashed = false;
    try {
      rc = Module.callMain(args);
      if (typeof rc !== 'number' || isNaN(rc)) rc = 0;
    } catch (e) {
      crashed = true;
      rc = 2;
      console.error('[7zip-web worker] callMain threw:', e);
    }
    return { rc: rc, crashed: crashed, lines: logLines.slice() };
  }

  function tailOf(lines) {
    return lines
      .filter(function (l) {
        return l.trim() !== '';
      })
      .slice(-ERROR_TAIL_LINES)
      .join(' | ');
  }

  function jobFailure(r, what) {
    var reason = r.crashed
      ? what + ': the 7-Zip engine aborted'
      : what + ': 7-Zip exit code ' + r.rc;
    var tail = tailOf(r.lines);
    return new Error(tail ? reason + ' — ' + tail : reason);
  }

  function passwordArgs(msg) {
    var pw = msg && msg.password;
    return typeof pw === 'string' && pw !== '' ? ['-p' + pw] : [];
  }

  // Run fn inside a fresh /job<id> tree; always cleans up; never rejects.
  // Cleanup is strictly scoped to /job<id>: the persistent /arc store survives
  // every job (keyed jobs still create an unused /job<id>/in).
  function withJob(msg, fn) {
    var id = msg.id;
    var jobDir = '/job' + id;
    var inDir = jobDir + '/in';
    var outDir = jobDir + '/out';
    activeJobId = id;
    logLines = [];
    return Promise.resolve()
      .then(function () {
        Module.FS.mkdirTree(inDir);
        Module.FS.mkdirTree(outDir);
        return fn(id, jobDir, inDir, outDir, Module.FS);
      })
      .catch(function (e) {
        post({ id: id, type: 'error', message: errText(e) });
      })
      .then(function () {
        activeJobId = null;
        logLines = [];
        removeTree(Module.FS, jobDir);
      });
  }

  // ------------------------------------------------------------------ ops ---

  // Write the request's archive into inDir; returns its MEMFS path.
  function stageArchive(FS, inDir, archive) {
    if (!archive || typeof archive !== 'object') {
      throw new Error('request is missing the archive payload');
    }
    var arcPath = inDir + '/' + safeBaseName(archive.name, 'archive.bin');
    writeFileDeep(FS, arcPath, toU8(archive.data));
    return arcPath;
  }

  // Drop every staged archive (bytes AND cache). Called before staging a new
  // one and by the fire-and-forget {type:'evict'} message.
  function evictAllStaged(FS) {
    removeTree(FS, ARC_ROOT);
    stagedArchives.clear();
  }

  // A 'list' stages persistently only when it carries BOTH a usable key and
  // bytes. Every other combination stays on the legacy path (and a 'list'
  // never reports an unknown-key error: it is the request that CREATES keys).
  function isStagingListRequest(msg) {
    return (
      typeof msg.archiveKey === 'string' &&
      msg.archiveKey !== '' &&
      !!msg.archive &&
      msg.archive.data !== undefined &&
      msg.archive.data !== null
    );
  }

  // Resolve the archive a job runs against (archiveKey wins over inline bytes):
  //   1. archiveKey present (not undefined/null) -> KEYED mode: use the staged
  //      file IN PLACE (no copy — copying would defeat the whole cache; 'l',
  //      't' and 'x' only ever read the archive and write under /job<id>/out,
  //      and the sole chdir user, compress, never touches staged archives).
  //      A key that is not a non-empty string, was never staged, was evicted
  //      or whose file vanished answers '<op>: unknown archiveKey', which
  //      app.js recovers from by re-staging and retrying once. Bytes carried
  //      alongside a key are IGNORED.
  //   2. otherwise -> LEGACY mode: stage msg.archive into /job<id>/in exactly
  //      as before (no cache, no eviction).
  // Returns { arcPath, listing } — listing is the cached parsed 'l -slt' array
  // of a successful keyed list, or null.
  function resolveArchive(FS, inDir, msg, op) {
    if (msg.archiveKey !== undefined && msg.archiveKey !== null) {
      var rec =
        typeof msg.archiveKey === 'string' && msg.archiveKey !== ''
          ? stagedArchives.get(msg.archiveKey)
          : undefined;
      if (!rec) throw new Error(op + ': unknown archiveKey');
      try {
        FS.stat(rec.path); // defensive: /arc outlives jobs, but verify anyway
      } catch (vanished) {
        stagedArchives.delete(msg.archiveKey);
        throw new Error(op + ': unknown archiveKey');
      }
      return { arcPath: rec.path, listing: rec.listing };
    }
    return { arcPath: stageArchive(FS, inDir, msg.archive), listing: null };
  }

  function runListJob(msg) {
    return withJob(msg, function (id, jobDir, inDir, outDir, FS) {
      var arcPath;
      var rec = null;
      if (isStagingListRequest(msg)) {
        // STAGE-ONCE: evict everything else BEFORE writing these bytes, so
        // peak MEMFS stays at one archive plus this job's outputs.
        evictAllStaged(FS);
        var dir = ARC_ROOT + '/' + ++stagedSeq;
        FS.mkdirTree(dir);
        arcPath = dir + '/' + safeBaseName(msg.archive.name, 'archive.bin');
        var bytes = toU8(msg.archive.data);
        FS.writeFile(arcPath, bytes);
        // Registered only after the write succeeded; on an engine failure the
        // BYTES REMAIN (they were always re-sendable before) and listing stays
        // null, so a later keyed extract keeps today's fallback behavior.
        rec = {
          dir: dir,
          path: arcPath,
          name: msg.archive.name,
          size: bytes.byteLength,
          listing: null,
        };
        stagedArchives.set(msg.archiveKey, rec);
      } else {
        arcPath = stageArchive(FS, inDir, msg.archive);
      }
      var args = ['l', '-slt', arcPath, '-bd'].concat(passwordArgs(msg));
      var r = run7z(args);
      if (r.crashed || r.rc >= 2) throw jobFailure(r, 'Listing archive');
      var entries = parseSltListing(r.lines);
      // Cached with the bytes it describes — but only while the coverage
      // fallback can actually consult the cache: allUncoveredProvablyEmpty
      // bails out unconditionally past COVERAGE_INDEX_MAX_ENTRIES, so
      // retaining an over-cap parsed array (hundreds of MB in the worker
      // heap for entry-rich archives, on top of the staged bytes) would be
      // dead weight for the whole staged session. Over-cap listings keep
      // listing === null, which the fallback already treats identically
      // (unconditional FULL re-run).
      if (rec && entries.length <= COVERAGE_INDEX_MAX_ENTRIES) rec.listing = entries;
      // No 'raw': nothing ever read the ~700 KB listing text on the main
      // thread, and structured-cloning it per open was pure overhead.
      post({ id: id, type: 'list-result', entries: entries });
    });
  }

  function runTestJob(msg) {
    return withJob(msg, function (id, jobDir, inDir, outDir, FS) {
      var arcPath = resolveArchive(FS, inDir, msg, 'test').arcPath;
      var args = ['t', arcPath, '-bd'].concat(passwordArgs(msg));
      var r = run7z(args);
      post({
        id: id,
        type: 'test-result',
        ok: !r.crashed && (r.rc === 0 || r.rc === 1),
        raw: r.lines.slice(-RAW_TAIL_LINES).join('\n'),
      });
    });
  }

  // ------------------------------------------------ selective extraction ---

  // A selected path is filter-safe iff non-empty and free of wildcard
  // metachars. Mirrors 7-Zip's own DoesNameContainWildcard (Wildcard.cpp),
  // which flags exactly '*' and '?' — and there is NO escape for them, so an
  // unsafe path must never reach the command line (it would over-match).
  function isFilterSafePath(p) {
    return typeof p === 'string' && p.length > 0 && p.indexOf('*') === -1 && p.indexOf('?') === -1;
  }

  // Comparison form of a selected path: backslashes normalized to '/'.
  // Listing paths already use '/'; no trimming, no case folding (7-Zip
  // filters are case-sensitive and names may legitimately start/end with
  // spaces).
  function selNorm(p) {
    return String(p).replace(/\\/g, '/');
  }

  // UTF-8 byte length without allocating (surrogate pairs count as 4).
  function utf8Length(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length &&
               s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) < 0xe000) {
        n += 4;
        i++;
      } else n += 3;
    }
    return n;
  }

  // Total argv bytes a callMain invocation would marshal onto the wasm stack
  // (one NUL per argument; pointer slots are negligible against the strings).
  // Shared by the FILTERED-extract budget and the compress listfile guard —
  // both defend the same fixed-size stack.
  function argvBytes(args) {
    var total = 0;
    for (var i = 0; i < args.length; i++) total += utf8Length(args[i]) + 1;
    return total;
  }

  // Total argv bytes the FILTERED run would marshal onto the wasm stack
  // (one NUL per filter; pointer slots are negligible against the strings).
  function filterArgvBytes(paths) {
    return argvBytes(paths);
  }

  // Render relative paths as a 7zz LISTFILE body: one path per line, every line
  // wrapped in double quotes, '\n'-terminated. The quoting is load-bearing —
  // 7zz TRIMS an unquoted listfile line before resolving it, so a name with a
  // leading or trailing space or tab would match nothing on disk, and the
  // engine only WARNs about that (rc stays 1, which runCompressJob tolerates):
  // the archive would come back silently missing those entries. A quoted line
  // has its wrapping quotes stripped and the name kept EXACTLY, which is what
  // makes listfile mode match argv mode. Measured byte-exact on this build for
  // leading/trailing spaces and tabs, interior and trailing quotes, a leading
  // '@' (NOT re-parsed as a nested listfile), ';', '#', '%', '=', repeated
  // interior spaces, UTF-8 names and a 19k-character path.
  function listfileBody(paths) {
    var lines = [];
    for (var i = 0; i < paths.length; i++) lines.push('"' + paths[i] + '"');
    return lines.join('\n') + '\n';
  }

  // Validate the OPTIONAL 'paths' field of an extract request: an array of
  // non-empty strings (entry paths verbatim from the 'l -slt' listing),
  // de-duplicated with first-occurrence order preserved. Absent/null/[] ->
  // [] (full extraction, byte-identical to the unfiltered behavior).
  // Violations throw, which withJob turns into a {type:'error'} reply.
  function selectedExtractPaths(paths) {
    if (paths === undefined || paths === null) return [];
    if (!Array.isArray(paths)) {
      throw new Error('extract: paths must be an array of non-empty strings');
    }
    if (paths.length > MAX_SELECTED_PATHS) {
      throw new Error('extract: too many selected paths');
    }
    var out = [];
    var seen = new Set();
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      if (typeof p !== 'string' || p.length === 0) {
        throw new Error('extract: paths must be an array of non-empty strings');
      }
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
    return out;
  }

  // 7zz extract argv. filters === null -> FULL extraction (no '--', no
  // positional filters; 7z falls back to its universal wildcard). Otherwise
  // '--' goes AFTER every switch (-o, -bd, -y, -p<pw>) and IMMEDIATELY
  // BEFORE the filters: after '--' even '-o…' would be parsed as a positional
  // filter (silently empty output), and a leading '-' or '@' path is fatal
  // when parsed among the switches.
  function extractArgs(arcPath, outDir, msg, filters) {
    var args = ['x', arcPath, '-o' + outDir, '-bd', '-y'].concat(passwordArgs(msg));
    return filters && filters.length ? args.concat(['--'], filters) : args;
  }

  // POST-FILTER (applied in BOTH modes whenever a selection exists): keep a
  // found file only when one of its path forms equals a form of a requested
  // path, or starts with requestedForm + '/' (a requested directory selects
  // its whole subtree). Guarantees the exact selected set regardless of 7-Zip
  // filter matching semantics.
  //
  // A path has up to four comparison forms because the listing and the
  // extractor disagree about hostile names:
  //   selNorm    — backslashes normalized (the contract's base form);
  //   ctlNorm    — C0 controls and DEL replaced with '_', exactly how the
  //                'l -slt' listing sanitizes them (an entry 'cr.txt\r' is
  //                LISTED as 'cr.txt_' but EXTRACTS under its real name);
  //   safeRelPath — leading '/' stripped and '..' segments popped, exactly
  //                how the extractor reshapes stored names ('/root.txt' and
  //                '../escape.txt' both extract to plain relative paths);
  //   ctlNorm(safeRelPath(...)) — both transforms combined.
  // Matching any form of the requested path against any form of the found
  // path keeps those entries selectable without ever letting a form escape
  // the output sandbox (safeRelPath forms cannot contain '..' or a leading
  // '/'; they only ever match files the extractor already produced).
  function ctlNorm(s) {
    // eslint-disable-next-line no-control-regex
    return s.replace(/[\x00-\x1f\x7f]/g, '_');
  }

  function addPathForm(forms, f) {
    if (f.length > 0 && forms.indexOf(f) === -1) forms.push(f);
  }

  function pathForms(p) {
    var s = selNorm(p);
    var r = safeRelPath(s);
    var forms = [];
    addPathForm(forms, s);
    addPathForm(forms, ctlNorm(s));
    addPathForm(forms, r);
    addPathForm(forms, ctlNorm(r));
    return forms;
  }

  // Map every form of every requested path to the indices of the requests
  // owning it. Built ONCE per job: the per-file match cost is then a hash
  // lookup per (form, ancestor-prefix) pair instead of a linear scan over
  // all selections — O(files x depth) instead of O(files x selections),
  // which at the 8192-path cap used to stall the worker for tens of
  // seconds of synchronous string concat + regex work.
  function buildSelectionIndex(selected) {
    var owners = new Map();
    for (var i = 0; i < selected.length; i++) {
      var forms = pathForms(selected[i]);
      for (var j = 0; j < forms.length; j++) {
        var arr = owners.get(forms[j]);
        if (arr === undefined) {
          arr = [];
          owners.set(forms[j], arr);
        }
        arr.push(i);
      }
    }
    return owners;
  }

  // Walk one form of a found path (the whole string, then each ancestor
  // directory prefix) and mark every requested path it satisfies as
  // covered. Returns true on at least one hit.
  function markCoveredForm(formOwners, form, covered) {
    var matched = false;
    var end = form.length;
    while (end > 0) {
      var owners = formOwners.get(end === form.length ? form : form.slice(0, end));
      if (owners !== undefined) {
        matched = true;
        for (var i = 0; i < owners.length; i++) covered[owners[i]] = true;
      }
      var slash = form.lastIndexOf('/', end - 1);
      if (slash <= 0) break; // no further non-empty prefix
      end = slash;
    }
    return matched;
  }

  function keepSelectedFiles(found, formOwners, covered) {
    var out = [];
    for (var i = 0; i < found.length; i++) {
      var forms = pathForms(found[i].rel);
      var keep = false;
      for (var j = 0; j < forms.length; j++) {
        if (markCoveredForm(formOwners, forms[j], covered)) keep = true;
      }
      if (keep) out.push(found[i]);
    }
    return out;
  }

  // COVERAGE check for FILTERED mode: rc=0 + 'Everything is Ok' are printed
  // even when a filter matched NOTHING, so verify every requested path
  // produced at least one post-filtered file (covered[] is filled in by
  // keepSelectedFiles). A miss triggers one FULL re-run; a genuinely empty
  // directory still yields zero files after the re-run and is NOT an error.
  function selectionCovered(covered) {
    for (var i = 0; i < covered.length; i++) {
      if (!covered[i]) return false;
    }
    return true;
  }

  // LISTING-VALIDATED FALLBACK. A FILTERED coverage miss used to trigger a
  // FULL re-run (complete decompression) unconditionally — even when the
  // requested paths simply do not exist in the archive or select an empty
  // directory, which is by far the most common miss (7zz filters match
  // SILENTLY: rc=0 + 'Everything is Ok' on no-match). When the staged archive
  // carries a cached listing we can PROVE those requests yield no files and
  // skip the re-run.
  //
  // The index is built from the listing with the SAME 4-form closure
  // (pathForms) the post-filter uses on found files, plus every strict
  // ancestor prefix of every form (mirroring markCoveredForm). A requested
  // path is therefore "maybe present" exactly when the FULL-mode post-filter
  // could keep a file for it: it matches a listed FILE entry, or it is an
  // ancestor directory of one, at any depth. Anything else — absent paths, or
  // a directory tree whose listing holds no file entries (an empty dir) —
  // provably yields zero kept files, so skipping is result-identical to
  // re-running (walkOutDir collects regular files only, so both produce the
  // same empty extract-result).
  //
  // Both sides go through selNorm, so backslashes are unified in BOTH
  // directions; there is no case folding on either side (7z filters are
  // case-sensitive and requested paths come verbatim from the listing).
  function buildListingFileIndex(listing) {
    var fileForms = new Set();
    var fileAncestors = new Set();
    for (var i = 0; i < listing.length; i++) {
      if (listing[i].isFolder) continue; // folders never yield kept files
      var forms = pathForms(listing[i].path);
      for (var j = 0; j < forms.length; j++) {
        fileForms.add(forms[j]);
        var end = forms[j].length;
        var slash;
        while ((slash = forms[j].lastIndexOf('/', end - 1)) > 0) {
          fileAncestors.add(forms[j].slice(0, slash)); // strict ancestor prefixes
          end = slash;
        }
      }
    }
    return { fileForms: fileForms, fileAncestors: fileAncestors };
  }

  function pathYieldsNoFiles(p, index) {
    var forms = pathForms(p);
    for (var j = 0; j < forms.length; j++) {
      if (index.fileForms.has(forms[j]) || index.fileAncestors.has(forms[j])) return false;
    }
    return true; // provably absent, or a directory tree with no file entries
  }

  // True only when EVERY uncovered requested path provably yields no files.
  // No cache (legacy list, extract-only flow, failed list) or an over-cap
  // listing -> false, i.e. today's unconditional FULL re-run. Built lazily,
  // once per job, and only on a coverage miss.
  function allUncoveredProvablyEmpty(selected, covered, listing) {
    if (!listing || listing.length > COVERAGE_INDEX_MAX_ENTRIES) return false;
    var index = buildListingFileIndex(listing);
    for (var i = 0; i < selected.length; i++) {
      if (!covered[i] && !pathYieldsNoFiles(selected[i], index)) return false;
    }
    return true;
  }

  function runExtractJob(msg) {
    return withJob(msg, function (id, jobDir, inDir, outDir, FS) {
      var selected = selectedExtractPaths(msg.paths);
      var resolved = resolveArchive(FS, inDir, msg, 'extract');
      var arcPath = resolved.arcPath;
      var listing = resolved.listing; // cached 'l -slt' entries, or null
      // FILTERED mode (one CLI-filtered invocation) only when EVERY requested
      // path is filter-safe AND the filter argv fits the wasm-stack byte
      // budget (an over-budget argv would overflow the engine's fixed-size
      // stack and permanently brick callMain — see MAX_FILTER_ARGV_BYTES);
      // otherwise FULL extraction. Either way the walked output is
      // post-filtered to the exact selection; with no selection the behavior
      // is byte-identical to the original unfiltered extract.
      var filteredMode =
        selected.length > 0 &&
        selected.every(isFilterSafePath) &&
        filterArgvBytes(selected) <= MAX_FILTER_ARGV_BYTES;
      var formOwners = selected.length ? buildSelectionIndex(selected) : null;
      var covered = [];
      for (var ci = 0; ci < selected.length; ci++) covered.push(false);

      var r = run7z(extractArgs(arcPath, outDir, msg, filteredMode ? selected : null));
      if (r.crashed || r.rc >= 2) throw jobFailure(r, 'Extracting archive');
      var found = [];
      walkOutDir(FS, outDir, '', found);

      if (selected.length) {
        found = keepSelectedFiles(found, formOwners, covered);
        if (filteredMode && !selectionCovered(covered)) {
          // COVERAGE FALLBACK: some requested path produced zero files under
          // the CLI filter (filter-matching quirks: basename-only matching,
          // separator or case mismatches — or the path genuinely selects
          // nothing). Re-run ONCE in FULL mode and apply the same post-filter,
          // UNLESS the cached listing proves every uncovered request yields no
          // files at all: then the re-run would decompress the whole archive
          // to produce exactly the empty result we already have.
          if (!allUncoveredProvablyEmpty(selected, covered, listing)) {
            removeTree(FS, outDir);
            FS.mkdirTree(outDir);
            var rFull = run7z(extractArgs(arcPath, outDir, msg, null));
            if (rFull.crashed || rFull.rc >= 2) throw jobFailure(rFull, 'Extracting archive');
            found = [];
            walkOutDir(FS, outDir, '', found);
            found = keepSelectedFiles(found, formOwners, covered);
          }
        }
      }

      var files = [];
      var transfer = [];
      for (var i = 0; i < found.length; i++) {
        var copy = ownedCopy(FS.readFile(found[i].abs));
        files.push({ path: found[i].rel, data: copy.buffer });
        transfer.push(copy.buffer);
      }
      post({ id: id, type: 'extract-result', files: files }, transfer);
    });
  }

  function runCompressJob(msg) {
    return withJob(msg, function (id, jobDir, inDir, outDir, FS) {
      var files = msg.files;
      // OPTIONAL folder half of the request: relative directory paths created
      // in the input tree so empty folders survive into the archive. Absent,
      // null or [] leaves dirPaths empty and every step below byte-identical
      // to the files-only behavior. A non-array is treated the same way rather
      // than iterated (a string would otherwise be walked one CHARACTER at a
      // time and create a directory per letter) — same "fall back to the safe
      // default" posture as an unknown format/level.
      var dirs = Array.isArray(msg.dirs) ? msg.dirs : null;
      var hasFiles = !!(files && files.length);
      var hasDirs = !!(dirs && dirs.length);
      // No files AND no dirs is the same caller bug it always was, so the
      // legacy message is kept verbatim (a dirs-only batch is NOT empty).
      if (!hasFiles && !hasDirs) throw new Error('compress: no input files');
      var format = msg.format === 'zip' ? 'zip' : '7z';
      var level = VALID_LEVELS.indexOf(String(msg.level)) >= 0 ? String(msg.level) : '5';

      var relPaths = [];
      for (var i = 0; i < (hasFiles ? files.length : 0); i++) {
        var rel = safeRelPath(files[i] && files[i].path);
        if (!rel) throw new Error('compress: invalid input path in request');
        if (rel.charAt(0) === '-') {
          throw new Error('compress: paths starting with "-" are not supported: ' + rel);
        }
        if (relPaths.indexOf(rel) >= 0) {
          throw new Error('compress: duplicate input path: ' + rel);
        }
        writeFileDeep(FS, inDir + '/' + rel, toU8(files[i].data));
        relPaths.push(rel);
      }

      // Directories are created AFTER every file is on disk, in request order,
      // so mkdirTree fails loudly on a dir path that collides with an existing
      // FILE ('a/b' while 'a' is a file) instead of silently shadowing it. An
      // empty directory passed as an engine argument becomes a real directory
      // entry in both formats (7z: 'Attributes = D ...', zip: 'Folder = +'),
      // and 7zz de-duplicates a directory listed alongside its own contents —
      // each entry lands in the archive exactly once.
      var dirPaths = [];
      for (var d = 0; d < (hasDirs ? dirs.length : 0); d++) {
        var drel = safeRelPath(dirs[d]);
        if (!drel) throw new Error('compress: invalid directory path in request');
        if (drel.charAt(0) === '-') {
          throw new Error('compress: paths starting with "-" are not supported: ' + drel);
        }
        if (relPaths.indexOf(drel) >= 0 || dirPaths.indexOf(drel) >= 0) {
          throw new Error('compress: duplicate input path: ' + drel);
        }
        try {
          FS.mkdirTree(inDir + '/' + drel);
        } catch (conflict) {
          throw new Error('compress: directory path conflicts with a file: ' + drel);
        }
        dirPaths.push(drel);
      }
      var allPaths = relPaths.concat(dirPaths);

      // The archive is created as a single deterministic output file inside
      // /job<id>/out (named after the caller-supplied archiveName) and read
      // straight back — no need to walk the output tree.
      var arcName = safeBaseName(msg.archiveName, 'archive.' + format);
      var outPath = outDir + '/' + arcName;

      // Built once because BOTH argv forms below end with exactly this tail.
      var switches = ['-bd', '-y', '-t' + format, '-mx' + level];
      if (msg.password) {
        switches.push('-p' + msg.password);
        // -mhe=on (encrypt headers) is 7z-format-only and needs a password.
        if (msg.encryptHeaders && format === '7z') switches.push('-mhe=on');
      }

      var args = ['a', outPath].concat(allPaths, switches);
      // LISTFILE OVERFLOW GUARD. callMain copies every argv string onto the
      // engine's FIXED-SIZE wasm stack via allocateUTF8OnStack (an unchecked
      // stackAlloc): past a few MB the stack pointer plows through engine
      // memory, main() aborts and EVERY later callMain in this worker aborts
      // too — permanently bricked until the page reloads. Folder picks are
      // exactly how a caller reaches that with thousands of ~140-byte relative
      // paths, and unlike extract (which can fall back to a full run) compress
      // has nowhere else to go, so the names move into a MEMFS LISTFILE and
      // only its '@/abs/path' reference stays on the argv. Result-identical to
      // argv mode: measured on this build, 5000 plain paths produced
      // byte-identical archives either way, and the quoting below (see
      // listfileBody) keeps the awkward names identical too.
      if (argvBytes(args) > MAX_COMPRESS_ARGV_BYTES) {
        for (var li = 0; li < allPaths.length; li++) {
          var lp = allPaths[li];
          // A listfile is LINE-based, so an embedded break would silently
          // split one name into two entries — quoting cannot recover that.
          // A name STARTING with '"' is rejected as well: listfileBody wraps
          // every line in quotes, so such a name would arrive as a run of
          // three quotes and depend on the reader stripping exactly the outer
          // pair (it does on this build, but a name that already looks like a
          // quoted string is not worth that bet). Reject rather than corrupt.
          if (lp.indexOf('\n') >= 0 || lp.indexOf('\r') >= 0) {
            throw new Error(
              'compress: names with line breaks are not supported in large batches: ' + lp
            );
          }
          if (lp.charAt(0) === '"') {
            throw new Error(
              'compress: names starting with a quote are not supported in large batches: ' + lp
            );
          }
        }
        // paths.txt lives in /job<id>, NOT in inDir: inDir is the chdir target
        // whose contents are the inputs, so a listfile there would be a stray
        // candidate for a later wildcard. The '@' path MUST be ABSOLUTE —
        // measured on this build, a relative listfile path crashes callMain
        // (the lines INSIDE it still resolve against the cwd set below).
        FS.writeFile(jobDir + '/paths.txt', listfileBody(allPaths));
        args = ['a', outPath, '@' + jobDir + '/paths.txt'].concat(switches);
      }

      // Run with cwd = inDir so entry names are exactly the caller's relative
      // paths; input paths must be relative for that naming to hold.
      FS.chdir(inDir);
      var r;
      try {
        r = run7z(args);
      } finally {
        FS.chdir('/');
      }
      if (r.crashed || r.rc >= 2) throw jobFailure(r, 'Creating archive');

      var bytes;
      try {
        bytes = FS.readFile(outPath);
      } catch (missing) {
        throw jobFailure(r, 'Creating archive (output file ' + outPath + ' missing)');
      }
      var copy = ownedCopy(bytes);
      post(
        {
          id: id,
          type: 'compress-result',
          archive: {
            name: typeof msg.archiveName === 'string' && msg.archiveName !== '' ? msg.archiveName : arcName,
            data: copy.buffer,
          },
        },
        [copy.buffer]
      );
    });
  }

  // -------------------------------------------------- l -slt output parsing ---

  // Parse `l -slt` output: discard everything before the first '----------'
  // line, then read blank-line-separated 'Key = Value' blocks, one per entry.
  function parseSltListing(lines) {
    var entries = [];
    var inBody = false;
    var cur = null;

    function flush() {
      if (cur && cur.Path !== undefined) {
        var size = 0;
        if (cur.Size !== undefined && cur.Size !== '') {
          var parsed = parseInt(cur.Size, 10);
          size = isNaN(parsed) ? 0 : parsed;
        }
        // Directory detection differs by format: zip/tar emit 'Folder = +',
        // while 7z emits NO Folder field and marks directories only via
        // 'Attributes = D ...' (files: 'A ...' or ' -rw-...'). Tar entries
        // may also end with '/'. Accept all three signals.
        var attrs = (cur.Attributes !== undefined ? cur.Attributes : '').replace(/^ +/, '');
        var isFolder =
          cur.Folder === '+' || attrs.charAt(0) === 'D' || /\/$/.test(cur.Path);
        // 'Modified' carries fractional seconds ('... 09:32:58.0000000');
        // keep the human-readable whole-second form.
        var modified = cur.Modified !== undefined ? cur.Modified.split('.')[0] : '';
        entries.push({
          path: cur.Path.replace(/\/$/, ''),
          size: size,
          modified: modified,
          method: cur.Method !== undefined ? cur.Method : '',
          encrypted: cur.Encrypted === '+',
          isFolder: isFolder,
        });
      }
      cur = null;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!inBody) {
        if (line === '----------') inBody = true;
        continue;
      }
      if (line.trim() === '') {
        flush();
        continue;
      }
      var eq = line.indexOf('=');
      if (eq < 0) continue;
      var key = line.slice(0, eq).trim();
      var val = line.slice(eq + 1);
      if (val.charAt(0) === ' ') val = val.slice(1);
      if (key === 'Path' && cur && cur.Path !== undefined) flush(); // defensive
      if (!cur) cur = {};
      cur[key] = val;
    }
    flush();
    return entries;
  }

  // ------------------------------------------------------- message routing ---

  function dispatch(msg, first) {
    return ensureInit().then(
      function () {
        // 'ready' answers an explicit init and the very first message (which
        // implicitly triggered init).
        if (msg.type === 'init' || first) {
          post({ id: msg.id, type: 'ready' });
        }
        try {
          switch (msg.type) {
            case 'init':
              return undefined;
            case 'list':
              return runListJob(msg);
            case 'extract':
              return runExtractJob(msg);
            case 'compress':
              return runCompressJob(msg);
            case 'test':
              return runTestJob(msg);
            case 'evict':
              // Fire-and-forget from Clear: drop the staged archive at once.
              // No id, NO reply — app.js never waits for it (the worker inbox
              // is sequential, so an evict posted while a job is in flight
              // still only runs after that job completed).
              evictAllStaged(Module.FS);
              return undefined;
            default:
              post({
                id: msg.id,
                type: 'error',
                message: 'Unknown message type: ' + String(msg.type),
              });
              return undefined;
          }
        } catch (e) {
          post({ id: msg.id, type: 'error', message: errText(e) });
          return undefined;
        }
      },
      function (e) {
        post({ id: msg.id, type: 'error', message: 'Engine init failed: ' + errText(e) });
      }
    );
  }

  // Never rejects: every failure becomes an {type:'error'} reply, so the
  // sequential pump always continues.
  function processMessage(msg) {
    var first = !sawFirstMessage;
    sawFirstMessage = true;
    return dispatch(msg, first).catch(function (e) {
      try {
        post({ id: msg.id, type: 'error', message: errText(e) });
      } catch (postFailed) {
        console.error('[7zip-web worker] unable to report error:', e);
      }
    });
  }

  function loop() {
    if (inbox.length === 0) {
      pumping = false;
      return;
    }
    var msg = inbox.shift();
    // processMessage never rejects (it converts every failure into an
    // {type:'error'} reply), so the chain always continues.
    processMessage(msg).then(loop, loop);
  }

  function pump() {
    if (pumping) return;
    pumping = true;
    loop();
  }

  self.onmessage = function (ev) {
    var msg = ev && ev.data;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    inbox.push(msg);
    pump();
  };
})();
