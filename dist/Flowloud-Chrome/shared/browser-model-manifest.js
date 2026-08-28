/* Browser model metadata and resumable downloads.  This file is deliberately
 * dependency-free so it can be used by the service worker, offscreen document,
 * and Node contract tests. */
(function browserModelManifestModule(root, factory) {
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  root.FlowloudBrowserModelManifest = exported;
}(typeof globalThis !== 'undefined' ? globalThis : this, function makeBrowserModelManifest() {
  'use strict';

  const MODEL_ID = 'kokoro-zh';
  const REPO_ID = 'onnx-community/Kokoro-82M-v1.1-zh-ONNX';
  const MODELSCOPE_REVISION = '71bfd8ce077d1f8c70a183704da7c55c1c4cded6';
  const HUGGINGFACE_REVISION = '6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3';
  const CHUNK_SIZE = 4 * 1024 * 1024;
  const MAX_CONCURRENCY = 4;
  const MAX_RETRIES = 3;

  const MODEL_SOURCES = Object.freeze({
    modelscope: Object.freeze({
      id: 'modelscope', label: '魔搭社区', host: 'https://www.modelscope.cn/models/',
      revision: MODELSCOPE_REVISION, remotePathTemplate: '{model}/resolve/{revision}/',
      manualOnly: false,
    }),
    huggingface: Object.freeze({
      id: 'huggingface', label: 'Hugging Face（手动备用）', host: 'https://huggingface.co/',
      revision: HUGGINGFACE_REVISION, remotePathTemplate: '{model}/resolve/{revision}/',
      manualOnly: true,
    }),
  });

  // Transformers.js resolves these names from config.json.  The manifest is
  // also useful to the UI for an honest size estimate; the server's final
  // Content-Length remains the source of truth during a download.
  const MODEL_VARIANTS = Object.freeze({
    // The current v1.1-zh ONNX exports produce silent PCM with fp16/q8 in
    // this browser runtime. Keep those variants addressable for diagnostics,
    // but make the safe, audible fp32 path the automatic choice.
    auto: Object.freeze({ id: 'auto', label: '自动（fp32，WebGPU/WASM）', dtype: 'fp32', estimatedBytes: 342 * 1024 * 1024 }),
    fp16: Object.freeze({ id: 'fp16', label: 'fp16 · WebGPU（实验性）', dtype: 'fp16', estimatedBytes: 166 * 1024 * 1024 }),
    quantized: Object.freeze({ id: 'quantized', label: '量化 q8 · WASM（实验性）', dtype: 'q8', estimatedBytes: 130 * 1024 * 1024 }),
    fp32: Object.freeze({ id: 'fp32', label: 'fp32 · 高精度（推荐）', dtype: 'fp32', estimatedBytes: 342 * 1024 * 1024 }),
  });

  const MODEL_FILES = Object.freeze([
    'config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json',
    'onnx/model.onnx', 'onnx/model_fp16.onnx', 'onnx/model_quantized.onnx',
  ]);

  // Keep the complete catalog visible without downloading every 522 KB voice.
  // Kokoro's own runtime is the authoritative catalog; these entries provide a
  // stable display name and allow the cache manager to validate requested IDs.
  const VOICE_IDS = Object.freeze([
    'af_maple', 'af_sol', 'bf_vale',
    'zf_001', 'zf_002', 'zf_003', 'zf_004', 'zf_005', 'zf_006', 'zf_007', 'zf_008',
    'zf_017', 'zf_018', 'zf_019', 'zf_021', 'zf_022', 'zf_023', 'zf_024', 'zf_026',
    'zf_027', 'zf_028', 'zf_032', 'zf_036', 'zf_038', 'zf_039', 'zf_040', 'zf_042',
    'zf_043', 'zf_044', 'zf_046', 'zf_047', 'zf_048', 'zf_049', 'zf_051', 'zf_059',
    'zf_060', 'zf_067', 'zf_070', 'zf_071', 'zf_072', 'zf_073', 'zf_074', 'zf_075',
    'zf_076', 'zf_077', 'zf_078', 'zf_079', 'zf_083', 'zf_084', 'zf_085', 'zf_086',
    'zf_087', 'zf_088', 'zf_090', 'zf_092', 'zf_093', 'zf_094', 'zf_099',
    'zm_009', 'zm_010', 'zm_011', 'zm_012', 'zm_013', 'zm_014', 'zm_015', 'zm_016',
    'zm_020', 'zm_025', 'zm_029', 'zm_030', 'zm_031', 'zm_033', 'zm_034', 'zm_035',
    'zm_037', 'zm_041', 'zm_045', 'zm_050', 'zm_052', 'zm_053', 'zm_054', 'zm_055',
    'zm_056', 'zm_057', 'zm_058', 'zm_061', 'zm_062', 'zm_063', 'zm_064', 'zm_065',
    'zm_066', 'zm_068', 'zm_069', 'zm_080', 'zm_081', 'zm_082', 'zm_089', 'zm_091',
    'zm_095', 'zm_096', 'zm_097', 'zm_098', 'zm_100',
  ]);
  const STARTER_VOICE_IDS = Object.freeze(['zf_001', 'zf_002', 'zm_009', 'zm_010']);
  const VOICE_CATALOG = Object.freeze(VOICE_IDS.map((id) => {
    const chinese = id.startsWith('zf_') || id.startsWith('zm_');
    const female = id.startsWith('zf_') || id === 'af_maple' || id === 'af_sol' || id === 'bf_vale';
    const language = id.startsWith('af_') ? 'en-US' : id.startsWith('bf_') ? 'en-GB' : 'zh-CN';
    const number = id.slice(-3);
    return Object.freeze({
      id, name: id,
      label: chinese ? `中文${female ? '女' : '男'}声 ${number}` : `${language === 'en-GB' ? '英式' : '美式'}${female ? '女' : '男'}声 · ${id}`,
      lang: language, language, gender: female ? 'female' : 'male',
      sizeBytes: 522240,
      path: `voices/${id}.bin`,
    });
  }));
  const VOICE_BY_ID = Object.freeze(Object.fromEntries(VOICE_CATALOG.map((voice) => [voice.id, voice])));

  function source(value) {
    const id = String(value || 'modelscope').trim().toLowerCase();
    return MODEL_SOURCES[id] || MODEL_SOURCES.modelscope;
  }

  function variant(value, device) {
    const requested = String(value || 'auto').trim().toLowerCase();
    if (requested !== 'auto' && MODEL_VARIANTS[requested]) return MODEL_VARIANTS[requested];
    return MODEL_VARIANTS.fp32;
  }

  function modelKey(options) {
    const config = options || {};
    const sourceInfo = source(config.source || config.sourceId || config.modelSource);
    const revision = String(config.revision || sourceInfo.revision);
    const selected = variant(config.variant || config.dtype, config.device);
    return `flowloud-model-${String(config.repoId || REPO_ID)}@${revision}-${sourceInfo.id}-${selected.id}`;
  }

  function resolveUrl(sourceInfo, repoId, revision, file) {
    const base = String(sourceInfo.host || '').replace(/\/$/u, '');
    return `${base}/${String(repoId).replace(/^\//u, '')}/resolve/${encodeURIComponent(String(revision))}/${String(file).replace(/^\//u, '')}`;
  }

  function voiceUrl(options, voiceId) {
    const config = options || {};
    const sourceInfo = source(config.source || config.sourceId || config.modelSource);
    const repoId = String(config.repoId || REPO_ID);
    const revision = String(config.revision || sourceInfo.revision);
    return resolveUrl(sourceInfo, repoId, revision, `voices/${String(voiceId)}.bin`);
  }

  function responseHeader(response, name) {
    try { return response?.headers?.get?.(name) || ''; } catch (_) { return ''; }
  }

  function parseContentRange(value) {
    const match = String(value || '').match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/iu);
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = Number(match[3]);
    if (![start, end, total].every(Number.isFinite) || start < 0 || end < start || total <= end) return null;
    return { start, end, total };
  }

  function responseBytes(response) {
    if (!response) return Promise.resolve(new Uint8Array(0));
    if (typeof response.arrayBuffer === 'function') return response.arrayBuffer().then((value) => new Uint8Array(value));
    if (response.body instanceof Uint8Array) return Promise.resolve(response.body);
    return Promise.resolve(new Uint8Array(0));
  }

  function cacheKey(url, index) {
    return `https://flowloud.invalid/download-part/${encodeURIComponent(url)}?chunk=${index}`;
  }

  function clampConcurrency(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(parsed))) : MAX_CONCURRENCY;
  }

  async function closeResponseBody(response) {
    try { await response?.body?.cancel?.(); } catch (_) {}
  }

  async function deleteCachedPart(cache, key) {
    if (!cache || typeof cache.delete !== 'function') return false;
    try { return await cache.delete(key); } catch (_) { return false; }
  }

  /**
   * Return a fetch-compatible function.  A small 0-0 range probe determines
   * whether the source supports parallel ranges.  Each successful chunk is
   * cached independently, so an aborted/restarted download only requests the
   * missing pieces.  Sources that return 200 to the probe transparently fall
   * back to one ordinary request and report `rangeSupported: false`.  A few
   * CDNs (including the ModelScope endpoint) use HTTP 200 for a partial
   * response, so a matching Content-Range header is authoritative here.
   */
  function createResumableFetcher(options) {
    const config = options || {};
    const fetchImpl = config.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new TypeError('缺少模型下载 fetch 实现。');
    const partialCache = config.partialCache || null;
    // The production default is 4 MiB.  Tests and small voice artifacts may
    // intentionally use a smaller value, so only reject non-positive input.
    const chunkSize = Math.max(1, Number(config.chunkSize) || CHUNK_SIZE);
    const concurrency = clampConcurrency(config.concurrency);
    const maxRetries = Math.max(0, Math.min(MAX_RETRIES, Number(config.maxRetries) || MAX_RETRIES));
    const activeControllers = new Set();

    const request = async (url, init, meta) => {
      const signal = meta?.signal || init?.signal;
      if (signal?.aborted) throw Object.assign(new Error('模型下载已取消。'), { name: 'AbortError', code: 'cancelled' });
      const baseInit = Object.assign({}, init || {});
      const headers = new Headers(baseInit.headers || {});
      const probeInit = Object.assign({}, baseInit, { method: 'GET', headers: new Headers(headers) });
      probeInit.headers.set('range', 'bytes=0-0');
      let probe;
      try { probe = await fetchImpl(url, probeInit); } catch (error) {
        if (signal?.aborted) throw Object.assign(new Error('模型下载已取消。'), { name: 'AbortError', code: 'cancelled' });
        throw error;
      }
      const range = parseContentRange(responseHeader(probe, 'content-range'));
      let probeLength = Number(responseHeader(probe, 'content-length'));
      // ModelScope currently answers a Range request with HTTP 200 while still
      // returning the requested byte range and a Content-Range header. Treat
      // that response as a valid range probe; otherwise the one-byte probe
      // would be mistaken for the complete model file.
      if (Number(probe?.status) === 200 && range && !Number.isFinite(probeLength)) {
        try {
          const probeBytes = await responseBytes(probe.clone ? probe.clone() : probe);
          probeLength = probeBytes.byteLength;
        } catch (_) { probeLength = 0; }
      }
      const isRange = Boolean(range && range.start === 0 && range.end === 0
        && range.total > 0 && (Number(probe?.status) === 206 || probeLength === 1));
      const totalFromRange = range?.total || 0;
      if (!isRange) {
        const total = Number(responseHeader(probe, 'content-length')) || 0;
        const progress = meta?.onProgress;
        if (typeof progress === 'function') progress({
          source: meta?.source || '', file: meta?.file || url, loaded: 0, total,
          rangeSupported: false, concurrency: 1, resumed: false,
        });
        // A 200 probe is already a complete response.  Do not issue a second
        // request, since some CDNs bill each large request separately.
        return probe;
      }
      await closeResponseBody(probe);
      const total = totalFromRange;
      const chunks = Math.ceil(total / chunkSize);
      const bytes = new Array(chunks);
      let loaded = 0;
      let completed = 0;
      let resumed = 0;
      const progress = typeof meta?.onProgress === 'function' ? meta.onProgress : null;

      async function readPart(index) {
        const start = index * chunkSize;
        const end = Math.min(total - 1, start + chunkSize - 1);
        const key = cacheKey(url, index);
        if (partialCache?.match) {
          const cached = await partialCache.match(key);
          if (cached) {
            const cachedBytes = await responseBytes(cached);
            if (cachedBytes.byteLength === end - start + 1) {
              bytes[index] = cachedBytes; loaded += cachedBytes.byteLength; completed += 1; resumed += 1;
              progress?.({ source: meta?.source || '', file: meta?.file || url, loaded, total, rangeSupported: true, concurrency, chunks, completedChunks: completed, resumed });
              return;
            }
            await deleteCachedPart(partialCache, key);
          }
        }
        let lastError;
        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
          if (signal?.aborted) throw Object.assign(new Error('模型下载已取消。'), { name: 'AbortError', code: 'cancelled' });
          const controller = new AbortController();
          activeControllers.add(controller);
          const abort = () => controller.abort();
          if (signal) {
            if (signal.aborted) controller.abort();
            else signal.addEventListener?.('abort', abort, { once: true });
          }
          try {
            const partHeaders = new Headers(headers);
            partHeaders.set('range', `bytes=${start}-${end}`);
            const response = await fetchImpl(url, Object.assign({}, baseInit, { method: 'GET', headers: partHeaders, signal: controller.signal }));
            const partRange = parseContentRange(responseHeader(response, 'content-range'));
            const partBytes = await responseBytes(response);
            if (!partRange || partRange.start !== start || partRange.end !== end || partRange.total !== total
              || partBytes.byteLength !== end - start + 1) {
              const unsupported = new Error('模型源未正确返回 Range 分片。');
              unsupported.code = 'range_unsupported';
              throw unsupported;
            }
            bytes[index] = partBytes; loaded += partBytes.byteLength; completed += 1;
            if (partialCache?.put) await partialCache.put(key, new Response(partBytes, { status: 200, headers: { 'content-length': String(partBytes.byteLength) } }));
            progress?.({ source: meta?.source || '', file: meta?.file || url, loaded, total, rangeSupported: true, concurrency, chunks, completedChunks: completed, resumed });
            return;
          } catch (error) {
            lastError = error;
            if (error?.name === 'AbortError' || signal?.aborted) throw Object.assign(new Error('模型下载已取消。'), { name: 'AbortError', code: 'cancelled' });
            if (attempt < maxRetries) await new Promise((resolve) => setTimeout(resolve, 180 * (attempt + 1)));
          } finally {
            activeControllers.delete(controller);
            signal?.removeEventListener?.('abort', abort);
          }
        }
        throw lastError || new Error('模型分片下载失败。');
      }

      let cursor = 0;
      const workers = Array.from({ length: Math.min(concurrency, chunks) }, async () => {
        while (true) {
          const index = cursor;
          cursor += 1;
          if (index >= chunks) return;
          await readPart(index);
        }
      });
      try {
        await Promise.all(workers);
      } catch (error) {
        if (error?.code === 'range_unsupported') {
          // A proxy can accept the probe but strip Range on later requests.
          // Fall back to a single request rather than leaving a misleading
          // permanently-corrupt cache entry.
          for (const controller of activeControllers) controller.abort();
          return fetchImpl(url, Object.assign({}, baseInit, { method: 'GET', headers, signal }));
        }
        throw error;
      }
      const responseHeaders = new Headers(headers);
      responseHeaders.set('content-length', String(total));
      responseHeaders.set('accept-ranges', 'bytes');
      const output = typeof Blob === 'function' ? new Blob(bytes, { type: responseHeader(probe, 'content-type') || 'application/octet-stream' }) : bytes.reduce((all, chunk) => {
        const next = new Uint8Array(all.length + chunk.length); next.set(all); next.set(chunk, all.length); return next;
      }, new Uint8Array(0));
      for (let index = 0; index < chunks; index += 1) await deleteCachedPart(partialCache, cacheKey(url, index));
      progress?.({ source: meta?.source || '', file: meta?.file || url, loaded: total, total, rangeSupported: true, concurrency, chunks, completedChunks: chunks, resumed, complete: true });
      return new Response(output, { status: 200, headers: responseHeaders });
    };
    request.cancel = () => { for (const controller of activeControllers) controller.abort(); };
    request.constants = Object.freeze({ chunkSize, concurrency, maxRetries });
    return request;
  }

  const BUILTIN_BROWSER_MODEL = Object.freeze({
    modelId: MODEL_ID, repoId: REPO_ID, lang: 'zh-CN', license: 'Apache-2.0',
    voice: STARTER_VOICE_IDS[0], estimatedBytes: MODEL_VARIANTS.auto.estimatedBytes,
    sources: MODEL_SOURCES, variants: MODEL_VARIANTS, files: MODEL_FILES,
    voices: VOICE_CATALOG, starterVoiceIds: STARTER_VOICE_IDS,
  });

  return Object.freeze({
    MODEL_ID, REPO_ID, MODELSCOPE_REVISION, HUGGINGFACE_REVISION, CHUNK_SIZE,
    MAX_CONCURRENCY, MAX_RETRIES, MODEL_SOURCES, MODEL_VARIANTS, MODEL_FILES,
    VOICE_IDS, VOICE_CATALOG, VOICE_BY_ID, STARTER_VOICE_IDS,
    BUILTIN_BROWSER_MODEL, source, variant, modelKey, resolveUrl, voiceUrl,
    createResumableFetcher,
  });
}));
