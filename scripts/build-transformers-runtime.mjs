import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const wxtRoot = path.join(projectRoot, 'extension-wxt');
const vendorRoot = path.join(projectRoot, 'extension', 'vendor', 'transformers');
const kokoroVendorRoot = path.join(projectRoot, 'extension', 'vendor', 'kokoro');
const requireFromWxt = createRequire(path.join(wxtRoot, 'package.json'));
const esbuild = requireFromWxt('esbuild');
async function packageRootFromEntry(entryPath) {
  let directory = path.dirname(entryPath);
  for (;;) {
    try {
      await fs.access(path.join(directory, 'package.json'));
      return directory;
    } catch (_) {
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error(`找不到依赖包根目录：${entryPath}`);
      directory = parent;
    }
  }
}
const kokoroRoot = await packageRootFromEntry(requireFromWxt.resolve('@uzen/kokoro-js'));
const requireFromKokoro = createRequire(path.join(kokoroRoot, 'package.json'));
const transformersRoot = await packageRootFromEntry(requireFromKokoro.resolve('@huggingface/transformers'));
const onnxRoot = await packageRootFromEntry(requireFromKokoro.resolve('onnxruntime-web'));
const phonemizerRoot = await packageRootFromEntry(requireFromKokoro.resolve('phonemizer'));
const pinyinRoot = await packageRootFromEntry(requireFromKokoro.resolve('pinyin-pro'));
const readPackage = async (root) => JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const kokoroPackage = await readPackage(kokoroRoot);
const transformersPackage = await readPackage(transformersRoot);
const onnxPackage = await readPackage(onnxRoot);
const phonemizerPackage = await readPackage(phonemizerRoot);
const pinyinPackage = await readPackage(pinyinRoot);

await fs.mkdir(vendorRoot, { recursive: true });
await fs.mkdir(kokoroVendorRoot, { recursive: true });
for (const directory of [vendorRoot, kokoroVendorRoot]) {
  for (const entry of await fs.readdir(directory).catch(() => [])) {
    if (/\.(?:wasm|mjs)$/u.test(entry) || ['transformers.web.min.js', 'PINYIN-PRO-LICENSE', 'af_heart.bin', 'kokoro.web.min.js', 'runtime-build.json'].includes(entry)) {
      await fs.rm(path.join(directory, entry), { force: true });
    }
  }
}

const kokoroOutput = path.join(kokoroVendorRoot, 'kokoro.web.min.js');
const result = await esbuild.build({
  stdin: {
    contents: `
      import { KokoroTTS } from './dist/kokoro.js';
      import { AutoTokenizer, StyleTextToSpeech2Model, env } from '@huggingface/transformers';
      export async function flowloudCreateKokoro(repoId, options = {}) {
        const offline = options.flowloudOffline === true;
        env.allowRemoteModels = true;
        env.allowLocalModels = false;
        env.useBrowserCache = false;
        env.useCustomCache = true;
        const modelCache = await caches.open(options.cacheKey);
        env.customCache = modelCache;
        env.remoteHost = 'https://huggingface.co/';
        env.fetch = offline
          ? async () => { throw Object.assign(new Error('Kokoro 离线校验期间禁止访问远程模型。'), { code: 'offline_cache_miss' }); }
          : globalThis.fetch.bind(globalThis);
        if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.wasmPaths = options.wasmPaths;
        const shared = {
          revision: options.revision,
          dtype: options.dtype || (options.device === 'webgpu' ? 'fp32' : 'q4'),
          device: options.device || 'wasm',
          progress_callback: options.progress_callback,
        };
        const [model, tokenizer] = await Promise.all([
          StyleTextToSpeech2Model.from_pretrained(repoId, shared),
          AutoTokenizer.from_pretrained(repoId, shared),
        ]);
        // Transformers.js 4.2 probes tokenizer metadata without forwarding the
        // requested revision. Persist a main-key alias containing the pinned
        // revision response so a cold offline restart can resolve that probe.
        const pinnedTokenizerConfig = 'https://huggingface.co/' + repoId + '/resolve/' + encodeURIComponent(options.revision) + '/tokenizer_config.json';
        const mainTokenizerConfig = 'https://huggingface.co/' + repoId + '/resolve/main/tokenizer_config.json';
        if (!(await modelCache.match(mainTokenizerConfig))) {
          const pinnedResponse = await modelCache.match(pinnedTokenizerConfig);
          if (pinnedResponse) await modelCache.put(mainTokenizerConfig, pinnedResponse);
        }
        const tts = new KokoroTTS(model, tokenizer);
        const callable = async (input, runOptions = {}) => {
          const voice = String(runOptions.speaker_embeddings || runOptions.voice || 'zf_001');
          const speed = Number(runOptions.speed || 1);
          const originalFetch = globalThis.fetch;
          globalThis.fetch = async (resource, init) => {
            const url = new URL(typeof resource === 'string' ? resource : resource.url, globalThis.location?.href);
            if (url.pathname.startsWith('/kokoro/voices/')) {
              const name = url.pathname.split('/').at(-1);
              const remoteVoiceUrl = options.voicePath + '/' + name;
              const cachedVoice = await (await caches.open('kokoro-voices')).match(remoteVoiceUrl);
              if (cachedVoice) return cachedVoice;
              if (offline) throw Object.assign(new Error('Kokoro 音色缓存缺失。'), { code: 'offline_cache_miss' });
              return originalFetch(remoteVoiceUrl, init);
            }
            return originalFetch(resource, init);
          };
          try {
            const audio = await tts.generate(String(input || ''), { voice, speed });
            return { audio: audio.audio, sampling_rate: audio.sampling_rate };
          } finally {
            globalThis.fetch = originalFetch;
          }
        };
        callable.voices = tts.voices;
        callable.dispose = () => model?.dispose?.();
        return callable;
      }
    `,
    resolveDir: kokoroRoot,
    sourcefile: 'flowloud-kokoro-runtime.mjs',
    loader: 'js',
  },
  outfile: kokoroOutput,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome120', 'edge120'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  treeShaking: true,
  metafile: true,
  conditions: ['browser', 'default'],
  alias: {
    '@huggingface/transformers': path.join(transformersRoot, 'dist', 'transformers.web.js'),
    phonemizer: path.join(phonemizerRoot, 'dist', 'phonemizer.js'),
    'pinyin-pro': path.join(pinyinRoot, 'dist', 'index.mjs'),
  },
});

const inputs = Object.keys(result.metafile.inputs).map((entry) => entry.replaceAll('\\', '/'));
if (!inputs.some((entry) => entry.includes('@uzen+kokoro-js@1.2.4'))) throw new Error('Kokoro bundle did not resolve @uzen/kokoro-js 1.2.4.');
// Transformers.js 4.2 imports onnxruntime-web/webgpu. ORT 1.26's WebGPU build
// uses the Asyncify pair for both WebGPU and its WASM execution provider.
const runtimeAssets = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];
for (const name of runtimeAssets) await fs.copyFile(path.join(onnxRoot, 'dist', name), path.join(vendorRoot, name));

try {
  await fs.copyFile(path.join(onnxRoot, 'LICENSE'), path.join(vendorRoot, 'ONNXRUNTIME-LICENSE'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  await fs.access(path.join(vendorRoot, 'ONNXRUNTIME-LICENSE'));
}
await fs.copyFile(path.join(transformersRoot, 'LICENSE'), path.join(kokoroVendorRoot, 'TRANSFORMERS-LICENSE'));
await fs.copyFile(path.join(kokoroRoot, 'LICENSE'), path.join(kokoroVendorRoot, 'LICENSE'));
await fs.copyFile(path.join(phonemizerRoot, 'LICENSE'), path.join(kokoroVendorRoot, 'PHONEMIZER-LICENSE'));
await fs.copyFile(path.join(pinyinRoot, 'LICENSE'), path.join(kokoroVendorRoot, 'PINYIN-PRO-LICENSE'));

const source = await fs.readFile(kokoroOutput);
const digest = crypto.createHash('sha256').update(source).digest('hex');
const metadata = {
  generatedAt: new Date().toISOString(), runtime: 'kokoro-only', kokoroJsVersion: kokoroPackage.version,
  transformersVersion: transformersPackage.version, onnxRuntimeVersion: onnxPackage.version,
  phonemizerVersion: phonemizerPackage.version, pinyinProVersion: pinyinPackage.version,
  modelRepo: 'onnx-community/Kokoro-82M-v1.1-zh-ONNX',
  modelRevision: '6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3',
  bundledVoices: [], runtimeAssets, sha256: digest,
};
await fs.writeFile(path.join(vendorRoot, 'runtime-build.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
await fs.writeFile(path.join(kokoroVendorRoot, 'runtime-build.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
console.log(`KOKORO RUNTIME PASS ${kokoroPackage.version} / Transformers ${transformersPackage.version} / ORT ${onnxPackage.version} / ${digest.slice(0, 12)}`);
