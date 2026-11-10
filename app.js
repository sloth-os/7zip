/*
 * app.js — UI glue for the 7-Zip WASM PWA (classic script, loaded with defer).
 *
 * Owns the sequential request queue towards worker.js (the wasm engine is
 * single-threaded: exactly one job in flight at a time), file intake via
 * #dropzone / #file-input, the archive and compress panels, streamed progress,
 * downloads, install prompt, online/offline pill and build-info version pill.
 * Where the browser supports them it also wires up OS-level file handling:
 * launch-queue files ("Open with"), share-target files (Android share sheet)
 * and the native open / extract-to-folder / save-as pickers — all of it
 * feature-detected, so unsupported browsers keep the existing behavior.
 *
 * Every URL is RELATIVE — the site must work from any subpath and offline.
 */
(function () {
  'use strict';

  var ARCHIVE_EXTS = [
    '7z', 'zip', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'xz', 'txz',
    'zst', 'tzst', 'iso', 'cab', 'lzma', 'lzh', 'arj',
  ];
  var MAX_PROGRESS_LINES = 200;

  // Pinned base labels of the two selection buttons — updateSelectionUI()
  // appends ' (N)' while the selection is non-empty.
  var LABEL_EXTRACT_SELECTED = 'Extract selected';
  var LABEL_SELECTED_TO_FOLDER = 'Selected to folder…';

  // MIME type -> extensions map for the native pickers. Must cover exactly
  // the ARCHIVE_EXTS list above and mirror the manifest file_handlers entry
  // (extensions WITH the leading dot, per the picker/manifest specs).
  var ARCHIVE_ACCEPT = {
    'application/x-7z-compressed': ['.7z'],
    'application/zip': ['.zip'],
    'application/vnd.rar': ['.rar'],
    'application/x-tar': ['.tar'],
    'application/gzip': ['.gz', '.tgz'],
    'application/x-bzip2': ['.bz2', '.tbz'],
    'application/x-xz': ['.xz', '.txz'],
    'application/zstd': ['.zst', '.tzst'],
    'application/x-iso9660-image': ['.iso'],
    'application/vnd.ms-cab-compressed': ['.cab'],
    'application/x-lzma': ['.lzma'],
    'application/x-lzh-compressed': ['.lzh'],
    'application/x-arj': ['.arj'],
  };

  // Fixed-name cache sw.js stashes share-target files in (never versioned —
  // an unconsumed share must survive a service-worker update).
  var SHARED_CACHE = '7zip-web-shared';

  // ----------------------------------------------------------------- state ---
  var worker = null;
  var workerReadyPromise = null; // resolves once {type:'ready'} for init arrived
  var workerReadyResolve = null;
  var workerReadyReject = null;
  var initMessageId = 0;
  var nextId = 1;
  var pending = new Map(); // id -> { requestType, resolve, reject }
  var queue = []; // serialized outbound requests
  var busy = false;

  var queuedFiles = []; // { path, name, size, data: ArrayBuffer } for compress
  // The currently opened archive: { name, file: File, key: string }. It holds
  // NO bytes — the worker stages them once (stage-once cache) and every later
  // operation references them by `key`, so the main thread keeps only the
  // disk-backed File reference instead of a permanent heap copy.
  var currentArchive = null;
  var archiveKeySeq = 0; // monotonic within the page session
  var currentEntries = []; // entries rendered by the last renderEntries call
  var selectedPaths = new Set(); // entry.path strings the user checked
  var entryCheckboxes = []; // row checkbox elements built by the last render
  var objectUrls = []; // kept alive until Clear
  var progressLines = [];
  var deferredInstallPrompt = null;
  // Bumped by Clear: operation callbacks capture the generation at dispatch
  // time and become no-ops when it changes, so results of jobs that were
  // cleared mid-flight never touch the reset UI.
  var generation = 0;
  var staleProgressIds = new Set(); // ids whose progress lines Clear muted

  // Chunked listing render: a huge archive (50k+ entries) must not build every
  // row in one task — that freezes the UI for seconds. RENDER_CHUNK rows are
  // built per timer tick; a listing of at most RENDER_CHUNK entries renders
  // fully synchronously, i.e. indistinguishably from the old behavior.
  // renderToken is bumped by EVERY renderEntries call and is the cancellation
  // guard: a superseded render (or Clear) stops its pending chunk chain.
  var RENDER_CHUNK = 500;
  var renderToken = 0;

  // ------------------------------------------------------------------- dom ---
  var dropzone, fileInput, statusLine, progressOutput, btnOpenArchive;
  var archivePanel, archiveNameEl, entriesBody, btnExtractAll, btnExtractFolder, btnTestArchive;
  var entrySelectAll, btnExtractSelected, btnExtractSelectedFolder;
  var compressPanel, compressList, formatSelect, levelSelect, passwordInput, btnCompress;
  var downloadsEl, installBtn, netStatus, buildVersion, btnClear;
  var initialStatusText = '';

  function $(id) {
    return document.getElementById(id);
  }

  // --------------------------------------------------------------- helpers ---

  function setStatus(text, isError) {
    statusLine.textContent = text === null || text === undefined ? '' : String(text);
    if (isError) statusLine.classList.add('error');
    else statusLine.classList.remove('error');
  }

  function humanSize(n) {
    if (typeof n !== 'number' || isNaN(n)) return '';
    if (n < 1024) return n + ' B';
    var units = ['KiB', 'MiB', 'GiB', 'TiB'];
    var v = n;
    var u = -1;
    do {
      v /= 1024;
      u++;
    } while (v >= 1024 && u < units.length - 1);
    return (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + units[u];
  }

  function baseName(p) {
    var s = String(p || '').replace(/\\/g, '/');
    var i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function extOf(name) {
    var s = String(name || '').toLowerCase();
    var i = s.lastIndexOf('.');
    return i >= 0 && i < s.length - 1 ? s.slice(i + 1) : '';
  }

  function isArchiveName(name) {
    return ARCHIVE_EXTS.indexOf(extOf(name)) >= 0;
  }

  // Exact-sized detached copy so the local ArrayBuffer stays usable after
  // the original is handed to the worker in a transfer list. Compress-only:
  // queuedFiles[i].data is re-sent on every Compress click, so it must NOT be
  // transferred. The archive hot path transfers its buffer directly instead
  // (the list request is the only one that carries archive bytes, exactly once
  // per open) — copying a 185 MB archive per operation was the biggest
  // single cost of the old protocol.
  function transferCopy(buf) {
    return buf.slice(0);
  }

  // Opaque per-open key for the worker's stage-once archive cache. Unique
  // within the page session and used ONLY as a worker-side Map key — never as
  // a filesystem path component — so it needs no sanitization.
  function newArchiveKey() {
    archiveKeySeq += 1;
    return 'arc-' + Date.now().toString(36) + '-' + archiveKeySeq.toString(36);
  }

  function currentPassword() {
    var pw = passwordInput && passwordInput.value;
    return typeof pw === 'string' && pw !== '' ? pw : undefined;
  }

  // ------------------------------------------------------- worker plumbing ---

  function ensureWorker() {
    if (workerReadyPromise) return workerReadyPromise;
    worker = new Worker('./worker.js');
    worker.onmessage = onWorkerMessage;
    worker.onerror = onWorkerError;
    workerReadyPromise = new Promise(function (resolve, reject) {
      workerReadyResolve = resolve;
      workerReadyReject = reject;
    });
    // Init is the very first message; the worker replies {id, type:'ready'}.
    initMessageId = nextId++;
    pending.set(initMessageId, {
      requestType: 'init',
      resolve: function () {},
      reject: function () {},
    });
    worker.postMessage({ id: initMessageId, type: 'init' });
    return workerReadyPromise;
  }

  function onWorkerError(ev) {
    var message =
      (ev && ev.message ? 'Worker error: ' + ev.message : 'The 7-Zip worker failed to start.') +
      ' (Check that wasm/7zz.js and wasm/7zz.wasm are present.)';
    console.error('[7zip-web] worker error', ev);
    setStatus(message, true);
    failEverything(new Error(message));
  }

  function failEverything(err) {
    if (workerReadyReject) {
      workerReadyReject(err);
      workerReadyResolve = null;
      workerReadyReject = null;
    }
    workerReadyPromise = null; // allow a fresh Worker on the next operation
    if (worker) {
      worker.terminate();
      worker = null;
    }
    pending.forEach(function (entry) {
      entry.reject(err);
    });
    pending.clear();
    busy = false;
    pumpQueue();
  }

  function onWorkerMessage(ev) {
    var msg = ev && ev.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'progress') {
      if (staleProgressIds.has(msg.id)) return;
      appendProgressLine(msg.line);
      return;
    }

    if (msg.type === 'ready') {
      // 'ready' belongs to the init handshake; ignore stray ones (the worker
      // also announces readiness on an implicit first-message init).
      if (workerReadyResolve) {
        workerReadyResolve();
        workerReadyResolve = null;
        workerReadyReject = null;
      }
      var initEntry = pending.get(msg.id);
      if (initEntry && initEntry.requestType === 'init') pending.delete(msg.id);
      return;
    }

    var entry = pending.get(msg.id);
    if (!entry) {
      staleProgressIds.delete(msg.id); // cleared job finished — stop muting
      return;
    }

    if (msg.type === 'error') {
      pending.delete(msg.id);
      if (entry.requestType === 'init') {
        failEverything(new Error(msg.message || 'Worker initialization failed'));
        return;
      }
      entry.reject(new Error(msg.message || 'The 7-Zip worker reported an error'));
      finishCurrentRequest();
      return;
    }

    if (
      msg.type === 'list-result' ||
      msg.type === 'extract-result' ||
      msg.type === 'compress-result' ||
      msg.type === 'test-result'
    ) {
      pending.delete(msg.id);
      entry.resolve(msg);
      finishCurrentRequest();
    }
  }

  function finishCurrentRequest() {
    busy = false;
    pumpQueue();
  }

  // Sequential queue: only one request is in flight; the next one is
  // dispatched after the previous completes (success or failure).
  function sendRequest(requestType, payload) {
    return new Promise(function (resolve, reject) {
      queue.push({ requestType: requestType, payload: payload, resolve: resolve, reject: reject });
      pumpQueue();
    });
  }

  function pumpQueue() {
    if (busy || queue.length === 0) return;
    var item = queue.shift();
    busy = true;
    ensureWorker().then(
      function () {
        var id = nextId++;
        var msg = { id: id, type: item.requestType };
        var transfers = [];
        Object.keys(item.payload).forEach(function (key) {
          msg[key] = item.payload[key];
        });
        // Binary payloads travel as ArrayBuffers in the transfer list.
        if (msg.archive && msg.archive.data) {
          // The list request is the ONLY message that carries archive bytes,
          // exactly once per open: transfer the original buffer, never a slice
          // copy. After dispatch it is detached here and nothing resends it —
          // every later operation references the worker's staged copy by
          // archiveKey (see sendStagedRequest).
          transfers.push(msg.archive.data);
        }
        if (Array.isArray(msg.files)) {
          msg.files = msg.files.map(function (f) {
            var copy = transferCopy(f.data);
            transfers.push(copy);
            return { path: f.path, data: copy };
          });
        }
        pending.set(id, {
          requestType: item.requestType,
          resolve: item.resolve,
          reject: item.reject,
        });
        try {
          worker.postMessage(msg, transfers);
        } catch (e) {
          pending.delete(id);
          item.reject(e);
          finishCurrentRequest();
        }
      },
      function (err) {
        item.reject(err);
        finishCurrentRequest();
      }
    );
  }

  // ------------------------------------------------ staged-request plumbing ---
  //
  // Every operation except the opening 'list' travels WITHOUT archive bytes:
  // it names the worker's staged copy by archiveKey. The worker answers
  // '<op>: unknown archiveKey' when the staged copy is gone — it was evicted by
  // a newer open, dropped by Clear, or lost with a restarted worker — and this
  // helper turns that into a transparent recovery: re-read the File, re-stage
  // it under the SAME key, then retry the original request exactly once.

  function isUnknownKeyError(err) {
    var m = err && err.message;
    return m === 'extract: unknown archiveKey' || m === 'test: unknown archiveKey';
  }

  // requestType: 'extract' | 'test'. arc: the currentArchive object captured at
  // click time. gen: generation captured at click time. extra: optional plain
  // fields ({paths:[...]}) — must NOT contain 'archive', 'archiveKey' or
  // 'files' (msg.files is reserved for compress transferables).
  //
  // No deadlock: recovery only runs inside promise callbacks of an
  // already-settled request (finishCurrentRequest() cleared `busy` before the
  // rejection microtask runs) and every step goes through sendRequest, i.e.
  // through the same sequential queue — never a direct worker.postMessage.
  //
  // Silent: no status changes. The 'Extracting…'/'Testing…' status set at click
  // time stays on screen while the re-stage list runs (its progress lines do
  // flow into the progress pane, which is capped). The re-stage reply's entries
  // are ignored — the table is NOT re-rendered.
  function sendStagedRequest(requestType, arc, gen, extra) {
    var payload = { archiveKey: arc.key, password: currentPassword() };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];
      }
    }
    return sendRequest(requestType, payload).catch(function (err) {
      if (!isUnknownKeyError(err)) throw err;
      // Guarded at EVERY step: a newer open or a Clear abandons the recovery
      // before it sends anything, so a stale chain can never evict the newer
      // archive's staging. The abandoned error is flagged so callers stay quiet.
      if (gen !== generation || arc !== currentArchive) {
        err.stale = true;
        throw err;
      }
      return arc.file
        .arrayBuffer() // re-read from disk: the transferred buffer is detached
        .then(function (data) {
          if (gen !== generation || arc !== currentArchive) {
            err.stale = true;
            throw err;
          }
          return sendRequest('list', {
            archive: { name: arc.name, data: data },
            archiveKey: arc.key, // SAME key: the caller's payload stays valid
            password: currentPassword(),
          });
        })
        .then(function () {
          if (gen !== generation || arc !== currentArchive) {
            err.stale = true;
            throw err;
          }
          // ONE retry with the identical payload (key-based, holds no buffers).
          // If it fails too, that error propagates unmodified — no second
          // recovery, no ping-pong.
          return sendRequest(requestType, payload);
        });
    });
  }

  // ----------------------------------------------------- progress + status ---

  function appendProgressLine(line) {
    progressLines.push(String(line === undefined || line === null ? '' : line));
    while (progressLines.length > MAX_PROGRESS_LINES) progressLines.shift();
    progressOutput.textContent = progressLines.join('\n');
    progressOutput.scrollTop = progressOutput.scrollHeight; // autoscroll
  }

  // ------------------------------------------------------------ file intake ---

  function handleIncomingFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var firstArchive = null;
    var toQueue = [];
    files.forEach(function (file) {
      if (!firstArchive && isArchiveName(file.name)) firstArchive = file;
      else toQueue.push(file);
    });
    if (firstArchive) openArchive(firstArchive);
    if (toQueue.length) queueFilesForCompress(toQueue);
  }

  function openArchive(file) {
    var gen = generation;
    // The currentArchive object THIS open owns. A second openArchive with no
    // Clear in between leaves `generation` unchanged, so the gen guard alone
    // cannot tell a superseded open from the current one — and bumping the
    // generation here would silently kill unrelated in-flight jobs (e.g. a
    // compress download). The owned guard keeps a superseded chain from
    // rendering into, clearing, or erroring over the NEWER archive's table.
    var owned = null;
    setStatus('Reading "' + file.name + '"…');
    file
      .arrayBuffer()
      .then(function (data) {
        if (gen !== generation) return null;
        currentArchive = { name: file.name, file: file, key: newArchiveKey() };
        owned = currentArchive;
        // The archive just changed hands: drop the PREVIOUS archive's rows
        // and checked selection NOW, before the new listing arrives.
        // Otherwise stale checked rows survive the swap and "Extract
        // selected" would apply the old selection to the new archive's bytes.
        renderEntries([]);
        archiveNameEl.textContent = file.name;
        archivePanel.hidden = false;
        // Mixed drop: an archive opens while other files queue for compress —
        // keep the compress panel visible when the queue is not empty.
        compressPanel.hidden = queuedFiles.length === 0;
        // The ONLY byte-carrying request of the whole open/extract lifecycle:
        // pumpQueue transfers `data` (never a copy), so it is DETACHED once
        // dispatched and nothing may retain or resend it — later operations
        // name the worker's staged copy by archiveKey instead. If this open is
        // superseded before its list dispatches, the queued list still runs and
        // stages; the newer open's list then evicts it (self-healing).
        return sendRequest('list', {
          archive: { name: currentArchive.name, data: data },
          archiveKey: currentArchive.key,
          password: currentPassword(),
        });
      })
      .then(function (res) {
        if (gen !== generation || !res) return;
        if (owned !== currentArchive) return; // superseded by a newer open
        renderEntries(res.entries || []);
        setStatus(
          '"' + currentArchive.name + '": ' + (res.entries || []).length + ' entries listed'
        );
      })
      .catch(function (err) {
        if (gen !== generation) return;
        // A superseded open must not clear or error over the newer table.
        // owned === null: the swap never happened (e.g. arrayBuffer failed) —
        // keep the original clear-and-report behavior.
        if (owned !== null && owned !== currentArchive) return;
        renderEntries([]);
        setStatus(err && err.message ? err.message : String(err), true);
      });
  }

  // Build ONE entry row. Row state lives in the change-listener closure and in
  // the index-aligned entryCheckboxes array — the DOM contract offers neither
  // dataset attributes nor querySelectorAll.
  function buildRow(entry) {
    var tr = document.createElement('tr');
    if (entry.isFolder) tr.className = 'folder';

    // Checkbox column first; folders are selectable too (a selected
    // directory extracts its whole subtree). The change listener closes
    // over `entry` directly.
    var tdSelect = document.createElement('td');
    tdSelect.className = 'col-select';
    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'entry-select';
    // Rows built by a LATER chunk must reflect a select-all that already fired:
    // selectedPaths is the source of truth. On the synchronous path the
    // selection was just reset, so this is always false.
    checkbox.checked = selectedPaths.has(entry.path);
    checkbox.setAttribute('aria-label', 'Select ' + entry.path);
    checkbox.addEventListener('change', function () {
      if (checkbox.checked) {
        selectedPaths.add(entry.path);
      } else {
        // A listing MAY contain duplicate paths (legal in e.g. zip). The
        // Set is keyed by path, so unchecking ONE row must not drop the
        // shared key while another row with the same path is still checked
        // — otherwise the UI (a checked row) and the extract payload (path
        // missing) diverge. entryCheckboxes is index-aligned with
        // currentEntries; scan it instead of querying the DOM.
        var stillClaimed = false;
        for (var k = 0; k < entryCheckboxes.length; k++) {
          if (entryCheckboxes[k] === checkbox) continue;
          if (
            entryCheckboxes[k].checked &&
            currentEntries[k] &&
            currentEntries[k].path === entry.path
          ) {
            stillClaimed = true;
            break;
          }
        }
        if (!stillClaimed) selectedPaths.delete(entry.path);
      }
      updateSelectionUI();
    });
    tdSelect.appendChild(checkbox);
    entryCheckboxes.push(checkbox);

    var tdName = document.createElement('td');
    tdName.textContent = entry.isFolder ? entry.path + '/' : entry.path;
    if (entry.encrypted) tdName.title = 'Encrypted';

    var tdSize = document.createElement('td');
    tdSize.textContent = entry.isFolder ? '—' : humanSize(entry.size);

    var tdModified = document.createElement('td');
    tdModified.textContent = entry.modified || '';

    var tdMethod = document.createElement('td');
    tdMethod.textContent = entry.method || '';

    tr.appendChild(tdSelect);
    tr.appendChild(tdName);
    tr.appendChild(tdSize);
    tr.appendChild(tdModified);
    tr.appendChild(tdMethod);
    return tr;
  }

  // The '(no entries)' placeholder row (5-column span, pinned).
  function appendPlaceholderRow() {
    var trEmpty = document.createElement('tr');
    var tdEmpty = document.createElement('td');
    tdEmpty.colSpan = 5;
    tdEmpty.textContent = '(no entries)';
    trEmpty.appendChild(tdEmpty);
    entriesBody.appendChild(trEmpty);
  }

  // Render a listing in RENDER_CHUNK-row slices: the first chunk synchronously,
  // the rest one per setTimeout(0) tick, so a 50k-entry archive lists without
  // freezing the UI (the old code built every row — 5 cells plus a checkbox
  // closure each — in a single task). A listing of at most RENDER_CHUNK entries
  // takes the synchronous path only: one fragment, one append, one
  // updateSelectionUI(), i.e. indistinguishable from the unchunked behavior.
  function renderEntries(entries) {
    var token = ++renderToken;
    // Reset the selection state on every render: the checkboxes, the
    // selected-path set and the cached checkbox list all belong to THIS list.
    currentEntries = entries.slice();
    selectedPaths = new Set();
    entryCheckboxes = [];
    entriesBody.textContent = '';
    if (!entries.length) {
      appendPlaceholderRow();
      updateSelectionUI();
      return;
    }
    var index = 0;
    function buildChunk() {
      var frag = document.createDocumentFragment();
      var end = Math.min(index + RENDER_CHUNK, entries.length);
      // Chunks build strictly in order, so entryCheckboxes stays index-aligned
      // with currentEntries at every point in time.
      for (; index < end; index++) frag.appendChild(buildRow(currentEntries[index]));
      entriesBody.appendChild(frag);
      // Once per chunk: labels and counts stay truthful while rows stream in
      // (the O(rendered) select-all scan per chunk is negligible).
      updateSelectionUI();
    }
    buildChunk();
    (function schedule() {
      if (index >= entries.length) return;
      // setTimeout only: the test DOM stub has real Node timers but no
      // requestAnimationFrame. The token check IS the cancellation mechanism —
      // Clear and a superseding open both bump it, killing this chain.
      setTimeout(function () {
        if (token !== renderToken) return;
        buildChunk();
        schedule();
      }, 0);
    })();
  }

  // Selection-derived UI, computed ONLY from selectedPaths and the
  // entryCheckboxes array (never DOM queries): button enablement + counted
  // labels, and the select-all checked/indeterminate state.
  function updateSelectionUI() {
    var n = selectedPaths.size;
    var suffix = n > 0 ? ' (' + n + ')' : '';
    if (btnExtractSelected) {
      btnExtractSelected.disabled = n === 0;
      btnExtractSelected.textContent = LABEL_EXTRACT_SELECTED + suffix;
    }
    if (btnExtractSelectedFolder) {
      btnExtractSelectedFolder.disabled = n === 0;
      btnExtractSelectedFolder.textContent = LABEL_SELECTED_TO_FOLDER + suffix;
    }
    if (entrySelectAll) {
      var total = entryCheckboxes.length;
      var checked = 0;
      for (var i = 0; i < total; i++) {
        if (entryCheckboxes[i].checked) checked++;
      }
      entrySelectAll.checked = n > 0 && checked === total;
      entrySelectAll.indeterminate = checked > 0 && checked < total;
    }
  }

  function queueFilesForCompress(files) {
    setStatus('Reading ' + files.length + ' file' + (files.length > 1 ? 's' : '') + '…');
    Promise.all(
      files.map(function (file) {
        return file.arrayBuffer().then(function (data) {
          return {
            path: file.webkitRelativePath || file.name,
            name: file.name,
            size: data.byteLength,
            data: data,
          };
        });
      })
    ).then(
      function (items) {
        queuedFiles = queuedFiles.concat(items);
        renderCompressList();
        setStatus(
          queuedFiles.length +
            ' file' +
            (queuedFiles.length > 1 ? 's' : '') +
            ' queued for compression'
        );
      },
      function (err) {
        setStatus(err && err.message ? err.message : String(err), true);
      }
    );
  }

  function renderCompressList() {
    compressList.textContent = '';
    var frag = document.createDocumentFragment();
    queuedFiles.forEach(function (item, index) {
      var li = document.createElement('li');

      var label = document.createElement('span');
      label.textContent = item.path + ' — ' + humanSize(item.size);

      var removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn';
      removeBtn.textContent = 'Remove';
      removeBtn.setAttribute('aria-label', 'Remove ' + item.name + ' from the list');
      removeBtn.addEventListener('click', function () {
        queuedFiles.splice(index, 1);
        renderCompressList();
      });

      li.appendChild(label);
      li.appendChild(removeBtn);
      frag.appendChild(li);
    });
    compressList.appendChild(frag);
    compressPanel.hidden = queuedFiles.length === 0;
  }

  // -------------------------------------------------------------- downloads ---

  function addDownload(name, buffer) {
    var blob = new Blob([buffer]);
    var url = URL.createObjectURL(blob);
    objectUrls.push(url); // kept alive until Clear revokes them
    // Row wrapper: the download link plus (where supported) a "Save as…"
    // button writing the buffer to a real file via the native save picker.
    var row = document.createElement('div');
    row.className = 'download-row';
    var a = document.createElement('a');
    a.href = url;
    a.download = baseName(name);
    var label = document.createElement('span');
    label.textContent = a.download;
    var size = document.createElement('span');
    size.textContent = humanSize(buffer.byteLength);
    a.appendChild(label);
    a.appendChild(size);
    row.appendChild(a);
    if (typeof window.showSaveFilePicker === 'function') {
      var saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn btn-save-as';
      saveBtn.textContent = 'Save as…';
      saveBtn.addEventListener('click', function () {
        saveBufferAs(baseName(name), buffer);
      });
      row.appendChild(saveBtn);
    }
    downloadsEl.appendChild(row);
  }

  // ---------------------------------------------- native pickers (Chromium) ---
  // File System Access API flows. Every picker call must happen synchronously
  // inside a click handler (transient user activation) — hence the promise
  // chains hanging directly off the *Picker() calls.

  function onOpenArchive() {
    window
      .showOpenFilePicker({
        multiple: true,
        id: '7zip-open',
        startIn: 'downloads',
        types: [{ description: 'Archives', accept: ARCHIVE_ACCEPT }],
      })
      .then(function (handles) {
        return Promise.all(
          handles.map(function (handle) {
            return handle.getFile();
          })
        );
      })
      .then(function (files) {
        if (files.length) handleIncomingFiles(files);
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return; // picker dismissed
        setStatus(
          'Could not open the file picker: ' + (err && err.message ? err.message : err),
          true
        );
      });
  }

  // Extract straight into a user-chosen directory. Deliberately adds nothing
  // to the downloads list — the files land on the real file system.
  function onExtractToFolder() {
    if (!currentArchive) return;
    var gen = generation;
    window
      .showDirectoryPicker({ mode: 'readwrite', id: '7zip-extract', startIn: 'downloads' })
      .then(function (dirHandle) {
        if (gen !== generation) return null;
        // Captured here (not at click time): the picker may have been open for
        // a while, and the staged request must name the archive the status line
        // is about to announce.
        var arc = currentArchive;
        setStatus('Extracting "' + currentArchive.name + '" to folder…');
        return sendStagedRequest('extract', arc, gen, {}).then(function (res) {
          if (gen !== generation) return null;
          return writeFilesToDirectory(dirHandle, res.files || []);
        });
      })
      .then(function (result) {
        if (gen !== generation || !result) return;
        setStatus(
          result.failed
            ? 'Extracted ' + result.written + ' file(s); ' + result.failed + ' could not be written'
            : 'Extracted ' + result.written + ' file(s) to the chosen folder',
          !!result.failed
        );
      })
      .catch(function (err) {
        if (gen !== generation) return;
        if (err && err.stale) return; // recovery abandoned: a newer archive owns the UI
        if (err && err.name === 'AbortError') return; // dismissed or permission denied
        setStatus(err && err.message ? err.message : String(err), true);
      });
  }

  // Containment for archive entry paths written through directory handles —
  // the same algorithm as worker.js safeRelPath ('..' pops when possible and
  // is ignored at the root), plus drive-letter segments ("C:") are dropped
  // because these paths hit the real file system, not MEMFS.
  function safeExtractPath(p) {
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
      if (/^[A-Za-z]:$/.test(seg)) continue; // drive letter
      out.push(seg);
    }
    return out.join('/');
  }

  // Sequential on purpose: entries share parent directories, and one
  // unwritable file (permissions, illegal name, ...) must not abort the rest.
  async function writeFilesToDirectory(dirHandle, files) {
    var written = 0;
    var failed = 0;
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var rel = file ? safeExtractPath(file.path) : '';
      if (!rel || !file.data) {
        failed++;
        continue;
      }
      try {
        var segs = rel.split('/');
        var dir = dirHandle;
        for (var j = 0; j < segs.length - 1; j++) {
          dir = await dir.getDirectoryHandle(segs[j], { create: true });
        }
        var fileHandle = await dir.getFileHandle(segs[segs.length - 1], { create: true });
        var writable = await fileHandle.createWritable();
        await writable.write(new Blob([file.data]));
        await writable.close(); // nothing is on disk before close() resolves
        written++;
      } catch (err) {
        failed++;
        console.warn('[7zip-web] could not write "' + rel + '":', err);
      }
    }
    return { written: written, failed: failed };
  }

  // Save-picker filter: reuse the archive MIME type for known archive
  // extensions, otherwise offer a generic filter for the extension; with no
  // usable (or no spec-valid) extension the picker defaults are left alone.
  function typesForSave(name) {
    var ext = extOf(name);
    if (!ext) return null;
    var dotted = '.' + ext;
    // The File System Access spec only accepts suffixes of ASCII alphanumeric
    // characters (plus '+'), at most 16 code points — anything else (hyphens,
    // underscores, non-ASCII, longer names) makes showSaveFilePicker reject
    // with a TypeError, so those files fall back to the picker defaults.
    if (!/^\.[A-Za-z0-9+.]{1,15}$/.test(dotted)) return null;
    var mimes = Object.keys(ARCHIVE_ACCEPT).filter(function (mime) {
      return ARCHIVE_ACCEPT[mime].indexOf(dotted) >= 0;
    });
    var accept = {};
    if (mimes.length) {
      accept[mimes[0]] = [dotted];
      return [{ description: 'Archive file', accept: accept }];
    }
    accept['application/octet-stream'] = [dotted];
    return [{ description: 'All files', accept: accept }];
  }

  function saveBufferAs(suggestedName, buffer) {
    var options = { suggestedName: suggestedName, id: '7zip-save', startIn: 'downloads' };
    var types = typesForSave(suggestedName);
    if (types) options.types = types;
    window
      .showSaveFilePicker(options)
      .then(function (handle) {
        return handle.createWritable();
      })
      .then(function (writable) {
        // Keep the writable reference: close() must run on the same stream
        // the bytes were written to, and must be awaited.
        return writable.write(new Blob([buffer])).then(function () {
          return writable.close();
        });
      })
      .then(function () {
        setStatus('Saved "' + suggestedName + '"');
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return; // picker dismissed
        setStatus(err && err.message ? err.message : String(err), true);
      });
  }

  // ------------------------------------------------------------ operations ---

  function onTestArchive() {
    if (!currentArchive) return;
    var gen = generation;
    var arc = currentArchive;
    setStatus('Testing "' + currentArchive.name + '"…');
    sendStagedRequest('test', arc, gen, {}).then(
      function (res) {
        if (gen !== generation) return;
        if (res.ok) setStatus('"' + currentArchive.name + '": test passed — archive is OK');
        else setStatus('"' + currentArchive.name + '": test FAILED', true);
      },
      function (err) {
        if (gen !== generation) return;
        if (err && err.stale) return; // recovery abandoned: a newer archive owns the UI
        setStatus(err && err.message ? err.message : String(err), true);
      }
    );
  }

  function onExtractAll() {
    if (!currentArchive) return;
    var gen = generation;
    var arc = currentArchive;
    setStatus('Extracting "' + currentArchive.name + '"…');
    sendStagedRequest('extract', arc, gen, {}).then(
      function (res) {
        if (gen !== generation) return;
        var files = res.files || [];
        files.forEach(function (f) {
          addDownload(f.path, f.data);
        });
        setStatus('Extracted ' + files.length + ' file' + (files.length === 1 ? '' : 's') + ' from "' + currentArchive.name + '"');
      },
      function (err) {
        if (gen !== generation) return;
        if (err && err.stale) return; // recovery abandoned: a newer archive owns the UI
        setStatus(err && err.message ? err.message : String(err), true);
      }
    );
  }

  // Deterministic request order for the selection (Set iteration is insertion
  // order; sorting keeps repeated extractions of the same selection equal).
  function selectedPathsList() {
    return Array.from(selectedPaths).sort();
  }

  // Extract ONLY the checked entries as downloads. Same staged request shape as
  // onExtractAll (archiveKey, no bytes) plus the worker protocol's OPTIONAL
  // 'paths' field — never 'files': pumpQueue treats msg.files as transferable
  // binary payloads.
  function onExtractSelected() {
    if (!currentArchive) return;
    if (selectedPaths.size === 0) return; // defense-in-depth (button also disabled)
    var gen = generation;
    var arc = currentArchive;
    var paths = selectedPathsList();
    var n = paths.length;
    setStatus(
      'Extracting ' + n + ' selected ' + (n === 1 ? 'entry' : 'entries') +
        ' from "' + currentArchive.name + '"…'
    );
    sendStagedRequest('extract', arc, gen, { paths: paths }).then(
      function (res) {
        if (gen !== generation) return;
        var files = res.files || [];
        files.forEach(function (f) {
          addDownload(f.path, f.data);
        });
        if (files.length > 0) {
          setStatus('Extracted ' + files.length + ' file(s) from "' + currentArchive.name + '"');
        } else {
          setStatus(
            'Nothing extracted from the ' + n + ' selected ' + (n === 1 ? 'entry' : 'entries'),
            true
          );
        }
      },
      function (err) {
        if (gen !== generation) return;
        if (err && err.stale) return; // recovery abandoned: a newer archive owns the UI
        setStatus(err && err.message ? err.message : String(err), true);
      }
    );
  }

  // Extract ONLY the checked entries into a user-chosen directory. The picker
  // call MUST happen synchronously inside the click handler (transient user
  // activation) — nothing is awaited before it. Deliberately adds nothing to
  // the downloads list; the files land on the real file system.
  function onExtractSelectedToFolder() {
    if (!currentArchive) return;
    if (selectedPaths.size === 0) return; // defense-in-depth (button also disabled)
    var gen = generation;
    var paths = selectedPathsList();
    var n = paths.length;
    window
      .showDirectoryPicker({ mode: 'readwrite', id: '7zip-extract-selected', startIn: 'downloads' })
      .then(function (dirHandle) {
        if (gen !== generation) return null;
        var arc = currentArchive; // captured with the status line it announces
        setStatus(
          'Extracting ' + n + ' selected ' + (n === 1 ? 'entry' : 'entries') +
            ' from "' + currentArchive.name + '" to folder…'
        );
        return sendStagedRequest('extract', arc, gen, { paths: paths }).then(function (res) {
          if (gen !== generation) return null;
          return writeFilesToDirectory(dirHandle, res.files || []);
        });
      })
      .then(function (result) {
        if (gen !== generation || !result) return;
        setStatus(
          result.failed
            ? 'Extracted ' + result.written + ' file(s); ' + result.failed + ' could not be written'
            : 'Extracted ' + result.written + ' file(s) to the chosen folder',
          !!result.failed
        );
      })
      .catch(function (err) {
        if (gen !== generation) return;
        if (err && err.stale) return; // recovery abandoned: a newer archive owns the UI
        if (err && err.name === 'AbortError') return; // dismissed or permission denied
        setStatus(err && err.message ? err.message : String(err), true);
      });
  }

  function onCompress() {
    if (!queuedFiles.length) {
      setStatus('Nothing to compress — drop some files first', true);
      return;
    }
    var gen = generation;
    var format = formatSelect.value === 'zip' ? 'zip' : '7z';
    var level = levelSelect.value;
    var password = currentPassword();
    // No encrypt-headers checkbox in the DOM contract: headers are encrypted
    // whenever a password is set and the format is 7z.
    var encryptHeaders = !!password && format === '7z';
    var archiveName = baseName(queuedFiles[0].name) + '.' + format;

    setStatus('Compressing ' + queuedFiles.length + ' file' + (queuedFiles.length > 1 ? 's' : '') + '…');
    sendRequest('compress', {
      files: queuedFiles.map(function (f) {
        return { path: f.path, data: f.data };
      }),
      archiveName: archiveName,
      format: format,
      level: level,
      password: password,
      encryptHeaders: encryptHeaders,
    }).then(
      function (res) {
        if (gen !== generation) return;
        addDownload(res.archive.name, res.archive.data);
        setStatus('Created "' + res.archive.name + '" (' + humanSize(res.archive.data.byteLength) + ')');
      },
      function (err) {
        if (gen !== generation) return;
        setStatus(err && err.message ? err.message : String(err), true);
      }
    );
  }

  function onClear() {
    // Cancel the UI side of anything in flight: bump the generation so
    // pending callbacks no-op, mute their progress lines, and reject the
    // tracked requests. The worker itself cannot be interrupted mid-callMain;
    // its late replies hit the empty pending map and are ignored.
    generation++;
    pending.forEach(function (entry, id) {
      if (entry.requestType !== 'init') staleProgressIds.add(id);
      entry.reject(new Error('Cleared'));
    });
    pending.clear();
    busy = false;

    queuedFiles = [];
    currentArchive = null;
    renderCompressList();
    renderEntries([]);
    archivePanel.hidden = true;
    compressPanel.hidden = true;
    archiveNameEl.textContent = '';
    downloadsEl.textContent = '';
    objectUrls.forEach(function (url) {
      URL.revokeObjectURL(url);
    });
    objectUrls = [];
    progressLines = [];
    progressOutput.textContent = '';
    if (passwordInput) passwordInput.value = '';
    setStatus(initialStatusText);
    // Purge queued requests that still carry archive BYTES (an open's or a
    // recovery's staging 'list' waiting behind an in-flight job). pumpQueue
    // has no generation check, so they would otherwise dispatch AFTER the
    // evict below: the worker would re-stage a full archive copy this Clear
    // was supposed to drop — resident in MEMFS with currentArchive === null
    // until the next open or Clear — and the orphan's 'l -slt' output would
    // refill the progress pane just emptied (its id is minted after Clear,
    // so staleProgressIds cannot mute it). Rejecting here is silent: every
    // consumer gen-checks before touching the UI, and 'Cleared' is not an
    // unknown-key error, so no recovery is triggered. Keyed extract/test
    // requests deliberately STAY queued — they carry no bytes and, per the
    // stage-once design, fail with '<op>: unknown archiveKey' after the
    // evict, their recovery aborting silently on the generation check.
    for (var qi = queue.length - 1; qi >= 0; qi--) {
      if (queue[qi].payload && queue[qi].payload.archive) {
        queue[qi].reject(new Error('Cleared'));
        queue.splice(qi, 1);
      }
    }
    // Drop the worker's staged archive copy immediately (the next staging list
    // would evict it anyway — this is the eager path, that one the backstop for
    // a lost message). Fire-and-forget BY DESIGN: it bypasses the sendRequest
    // queue, carries no id and expects no reply, so nothing is awaited and no
    // round-trip is added. The worker's own inbox is sequential, so an evict
    // posted while a job is still running only executes after that job
    // completed — it can never delete a staged archive mid-run. Safe ordering:
    // `generation` was bumped above, so every callback that could observe the
    // eviction is already gen-guarded (late results hit the void; queued
    // post-Clear keyed requests fail with unknown-key and their recovery
    // aborts silently on the gen check).
    if (worker) {
      try {
        worker.postMessage({ type: 'evict' });
      } catch (e) {
        /* worker gone — the next staging list evicts anyway */
      }
    }
    pumpQueue();
  }

  // ------------------------------------------------------- PWA + environment ---

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(function (err) {
        console.warn('[7zip-web] service worker registration failed:', err);
      });
    }
  }

  // Desktop "Open with": the OS launches the installed PWA with file handles
  // queued on window.launchQueue. The queue buffers them until a consumer is
  // registered, so setting it here (at boot) cannot miss the launch.
  function setupLaunchQueue() {
    if (
      !('launchQueue' in window) ||
      !window.launchQueue ||
      typeof window.launchQueue.setConsumer !== 'function'
    ) {
      return;
    }
    window.launchQueue.setConsumer(function (params) {
      if (!params || !params.files || !params.files.length) return;
      Promise.all(
        params.files.map(function (handle) {
          return handle && typeof handle.getFile === 'function' ? handle.getFile() : handle;
        })
      )
        .then(function (files) {
          handleIncomingFiles(
            files.filter(function (f) {
              return f && typeof f.arrayBuffer === 'function';
            })
          );
        })
        .catch(function (err) {
          setStatus(
            'Could not read the launched file(s): ' + (err && err.message ? err.message : err),
            true
          );
        });
    });
  }

  // Android share sheet: sw.js stashed the shared files in SHARED_CACHE and
  // redirected here. Read ALL entries, delete ALL of them, and only then
  // process — in that order, so a reload can never ingest a share twice.
  // Returns a promise that never rejects: a broken cache must not break boot.
  function consumeSharedFiles() {
    if (!('caches' in window)) return Promise.resolve();
    return caches
      .open(SHARED_CACHE)
      .then(function (cache) {
        return cache.keys().then(function (keys) {
          if (!keys.length) return undefined;
          var fileKeys = keys.filter(function (key) {
            return !new URL(key.url).pathname.endsWith('/__shared/count');
          });
          return Promise.all(
            fileKeys.map(function (key) {
              return cache.match(key).then(function (resp) {
                return resp.blob().then(function (blob) {
                  var name = decodeURIComponent(resp.headers.get('X-File-Name') || '');
                  return new File(
                    [blob],
                    name || baseName(new URL(key.url).pathname),
                    { type: blob.type || '' }
                  );
                });
              });
            })
          ).then(function (files) {
            return Promise.all(
              keys.map(function (key) {
                return cache.delete(key);
              })
            ).then(function () {
              if (files.length) handleIncomingFiles(files);
            });
          });
        });
      })
      .catch(function (err) {
        console.warn('[7zip-web] could not consume shared files:', err);
      });
  }

  function updateNetStatus() {
    var online = navigator.onLine !== false;
    netStatus.classList.toggle('online', online);
    netStatus.classList.toggle('offline', !online);
    netStatus.textContent = online ? 'Online' : 'Offline';
  }

  function loadBuildInfo() {
    fetch('./build-info.json')
      .then(function (resp) {
        if (!resp.ok) throw new Error('build-info.json: HTTP ' + resp.status);
        return resp.json();
      })
      .then(function (info) {
        if (!info || !info.version) throw new Error('build-info.json: no version');
        var em = info.emscripten ? ' (emscripten ' + info.emscripten + ')' : '';
        buildVersion.textContent = 'v' + info.version + em;
      })
      .catch(function () {
        // Missing/failing build-info.json is normal offline and in dev — silent.
        buildVersion.textContent = 'local';
      });
  }

  function setupInstallPrompt() {
    window.addEventListener('beforeinstallprompt', function (ev) {
      ev.preventDefault();
      deferredInstallPrompt = ev;
      installBtn.hidden = false;
    });
    installBtn.addEventListener('click', function () {
      if (!deferredInstallPrompt) return;
      var promptEvent = deferredInstallPrompt;
      deferredInstallPrompt = null;
      installBtn.hidden = true;
      promptEvent.prompt();
      if (promptEvent.userChoice && typeof promptEvent.userChoice.then === 'function') {
        promptEvent.userChoice.catch(function () {});
      }
    });
    window.addEventListener('appinstalled', function () {
      deferredInstallPrompt = null;
      installBtn.hidden = true;
    });
  }

  function setupFileIntake() {
    dropzone.addEventListener('click', function (ev) {
      if (ev.target !== fileInput) fileInput.click();
    });
    dropzone.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        fileInput.click();
      }
    });
    fileInput.addEventListener('change', function () {
      handleIncomingFiles(fileInput.files);
      fileInput.value = ''; // allow re-selecting the same file
    });

    ['dragenter', 'dragover'].forEach(function (type) {
      dropzone.addEventListener(type, function (ev) {
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
        dropzone.classList.add('dragover');
      });
    });
    ['dragleave', 'dragend'].forEach(function (type) {
      dropzone.addEventListener(type, function (ev) {
        ev.preventDefault();
        dropzone.classList.remove('dragover');
      });
    });
    dropzone.addEventListener('drop', function (ev) {
      ev.preventDefault();
      dropzone.classList.remove('dragover');
      var dt = ev.dataTransfer;
      if (!dt) return;
      if (dt.files && dt.files.length) handleIncomingFiles(dt.files);
    });
    // Never let stray drops on the page navigate away.
    ['dragover', 'drop'].forEach(function (type) {
      window.addEventListener(type, function (ev) {
        if (ev.target !== dropzone && !dropzone.contains(ev.target)) ev.preventDefault();
      });
    });
  }

  // ------------------------------------------------------------------ boot ---

  function boot() {
    dropzone = $('dropzone');
    fileInput = $('file-input');
    statusLine = $('status-line');
    progressOutput = $('progress-output');
    btnOpenArchive = $('btn-open-archive');
    archivePanel = $('archive-panel');
    archiveNameEl = $('archive-name');
    entriesBody = $('entries-body');
    btnExtractAll = $('btn-extract-all');
    btnExtractFolder = $('btn-extract-folder');
    btnTestArchive = $('btn-test-archive');
    entrySelectAll = $('entry-select-all');
    btnExtractSelected = $('btn-extract-selected');
    btnExtractSelectedFolder = $('btn-extract-selected-folder');
    compressPanel = $('compress-panel');
    compressList = $('compress-list');
    formatSelect = $('format-select');
    levelSelect = $('level-select');
    passwordInput = $('password-input');
    btnCompress = $('btn-compress');
    downloadsEl = $('downloads');
    installBtn = $('install-btn');
    netStatus = $('net-status');
    buildVersion = $('build-version');
    btnClear = $('btn-clear');

    initialStatusText = statusLine ? statusLine.textContent.trim() : '';

    archivePanel.hidden = true;
    compressPanel.hidden = true;
    installBtn.hidden = true;

    setupFileIntake();
    setupInstallPrompt();
    setupLaunchQueue();
    consumeSharedFiles();

    btnExtractAll.addEventListener('click', onExtractAll);
    btnExtractSelected.addEventListener('click', onExtractSelected);
    btnTestArchive.addEventListener('click', onTestArchive);
    btnCompress.addEventListener('click', onCompress);
    btnClear.addEventListener('click', onClear);

    // Select-all header checkbox: mirror it onto every row checkbox and
    // rebuild the selection set from currentEntries (folders included).
    entrySelectAll.addEventListener('change', function () {
      var on = !!entrySelectAll.checked;
      selectedPaths.clear();
      for (var i = 0; i < entryCheckboxes.length; i++) {
        entryCheckboxes[i].checked = on;
      }
      if (on) {
        currentEntries.forEach(function (entry) {
          selectedPaths.add(entry.path);
        });
      }
      updateSelectionUI();
    });

    // Native pickers are feature-detected: on browsers without them (Firefox,
    // Safari) the buttons stay hidden and the dropzone / download links remain
    // the only intake and output, exactly as before.
    if (typeof window.showOpenFilePicker === 'function') {
      btnOpenArchive.addEventListener('click', onOpenArchive);
      btnOpenArchive.hidden = false;
    }
    if (typeof window.showDirectoryPicker === 'function') {
      btnExtractFolder.addEventListener('click', onExtractToFolder);
      btnExtractFolder.hidden = false;
      btnExtractSelectedFolder.addEventListener('click', onExtractSelectedToFolder);
      btnExtractSelectedFolder.hidden = false;
    }

    updateNetStatus();
    window.addEventListener('online', updateNetStatus);
    window.addEventListener('offline', updateNetStatus);

    loadBuildInfo();
    registerServiceWorker();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
