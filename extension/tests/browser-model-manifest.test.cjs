const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../shared/browser-model-manifest.js');

class MemoryCache {
  constructor() { this.values = new Map(); }
  async match(key) { return this.values.get(String(key)); }
  async put(key, value) { this.values.set(String(key), value); }
  async delete(key) { return this.values.delete(String(key)); }
}

function rangeResponse(bytes, start, end, total) {
  return new Response(bytes.slice(start, end + 1), {
    status: 206,
    headers: { 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': String(end - start + 1) },
  });
}

function rangeResponse200(bytes, start, end, total) {
  return new Response(bytes.slice(start, end + 1), {
    status: 200,
    headers: { 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': String(end - start + 1) },
  });
}

test('manifest uses ModelScope by default and exposes the full catalog with four starters', () => {
  assert.equal(manifest.MODEL_SOURCES.modelscope.host, 'https://www.modelscope.cn/models/');
  assert.equal(manifest.BUILTIN_BROWSER_MODEL.sources.modelscope.revision, manifest.MODELSCOPE_REVISION);
  assert.equal(manifest.VOICE_CATALOG.length, 103);
  assert.deepEqual(manifest.STARTER_VOICE_IDS, ['zf_001', 'zf_002', 'zm_009', 'zm_010']);
  assert.match(manifest.voiceUrl({ source: 'modelscope', revision: manifest.MODELSCOPE_REVISION }, 'zf_001'), /modelscope\.cn\/models\/.*voices\/zf_001\.bin/u);
  assert.equal(manifest.variant('auto', 'wasm').id, 'fp32');
  assert.equal(manifest.variant('auto', 'webgpu').id, 'fp32');
  assert.match(manifest.MODEL_VARIANTS.fp16.label, /实验性/u);
  assert.match(manifest.MODEL_VARIANTS.quantized.label, /实验性/u);
});

test('resumable fetcher downloads 206 chunks concurrently and emits completion metadata', async () => {
  const bytes = Uint8Array.from({ length: 17 }, (_value, index) => index);
  const cache = new MemoryCache();
  let active = 0; let maxActive = 0; const ranges = []; const progress = [];
  const fetchImpl = async (_url, init = {}) => {
    active += 1; maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    const range = new Headers(init.headers).get('range');
    ranges.push(range);
    active -= 1;
    if (range === 'bytes=0-0') return rangeResponse(bytes, 0, 0, bytes.length);
    const match = range.match(/^bytes=(\d+)-(\d+)$/u);
    return rangeResponse(bytes, Number(match[1]), Number(match[2]), bytes.length);
  };
  const fetcher = manifest.createResumableFetcher({ fetchImpl, partialCache: cache, chunkSize: 4, concurrency: 4 });
  const response = await fetcher('https://example.test/model.bin', {}, { source: 'modelscope', file: 'model.bin', onProgress: (value) => progress.push(value) });
  assert.deepEqual(Array.from(new Uint8Array(await response.arrayBuffer())), Array.from(bytes));
  assert.ok(maxActive > 1);
  assert.ok(ranges.includes('bytes=0-0'));
  assert.equal(progress.at(-1).complete, true);
  assert.equal(progress.at(-1).rangeSupported, true);
});

test('resumable fetcher accepts ModelScope-style 200 responses with Content-Range', async () => {
  const bytes = Uint8Array.from({ length: 9 }, (_value, index) => index + 1);
  const ranges = [];
  const fetchImpl = async (_url, init = {}) => {
    const range = new Headers(init.headers).get('range');
    ranges.push(range);
    if (range === 'bytes=0-0') return rangeResponse200(bytes, 0, 0, bytes.length);
    const match = range.match(/^bytes=(\d+)-(\d+)$/u);
    return rangeResponse200(bytes, Number(match[1]), Number(match[2]), bytes.length);
  };
  const response = await manifest.createResumableFetcher({ fetchImpl, partialCache: new MemoryCache(), chunkSize: 4, concurrency: 3 })('https://example.test/model.bin');
  assert.deepEqual(Array.from(new Uint8Array(await response.arrayBuffer())), Array.from(bytes));
  assert.equal(ranges[0], 'bytes=0-0');
  assert.ok(ranges.includes('bytes=0-3'));
  assert.ok(ranges.includes('bytes=8-8'));
});

test('resumable fetcher resumes a valid cached chunk without requesting it again', async () => {
  const bytes = Uint8Array.from({ length: 8 }, (_value, index) => index + 10);
  const cache = new MemoryCache();
  const url = 'https://example.test/model.bin';
  await cache.put(`https://flowloud.invalid/download-part/${encodeURIComponent(url)}?chunk=0`, new Response(bytes.slice(0, 4)));
  const ranges = [];
  const fetchImpl = async (_url, init = {}) => {
    const range = new Headers(init.headers).get('range'); ranges.push(range);
    if (range === 'bytes=0-0') return rangeResponse(bytes, 0, 0, bytes.length);
    const match = range.match(/^bytes=(\d+)-(\d+)$/u);
    return rangeResponse(bytes, Number(match[1]), Number(match[2]), bytes.length);
  };
  const response = await manifest.createResumableFetcher({ fetchImpl, partialCache: cache, chunkSize: 4, concurrency: 2 })(url);
  assert.deepEqual(Array.from(new Uint8Array(await response.arrayBuffer())), Array.from(bytes));
  assert.equal(ranges.filter((range) => range === 'bytes=0-3').length, 0);
  assert.equal(ranges.filter((range) => range === 'bytes=4-7').length, 1);
});

test('resumable fetcher returns an ordinary response when the source ignores Range', async () => {
  const fetchImpl = async (_url, init = {}) => {
    assert.equal(new Headers(init.headers).get('range'), 'bytes=0-0');
    return new Response('complete', { status: 200, headers: { 'content-length': '8' } });
  };
  const response = await manifest.createResumableFetcher({ fetchImpl, partialCache: new MemoryCache() })('https://example.test/model.bin');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'complete');
});

test('resumable fetcher aborts workers promptly', async () => {
  const controller = new AbortController();
  const fetchImpl = async (_url, init = {}) => {
    await new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      init.signal.addEventListener('abort', abort, { once: true });
    });
  };
  const pending = manifest.createResumableFetcher({ fetchImpl, partialCache: new MemoryCache(), chunkSize: 4 })(
    'https://example.test/model.bin', { signal: controller.signal }, { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
