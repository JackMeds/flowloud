import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

function argsOf(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--')) continue;
    values[key.slice(2)] = argv[index + 1] || '';
    index += 1;
  }
  return values;
}

const args = argsOf(process.argv.slice(2));
const adapterId = args.adapter || 'flowloud-qwen';
const baseUrl = args['base-url'] || 'http://127.0.0.1:7811';
const text = args.text || '你好，这是 Flowloud 本地服务真实烟雾测试。';
const requestId = `real-smoke-${Date.now().toString(36)}`;
const require = createRequire(import.meta.url);
const providerV4 = require('../extension/shared/provider-v4.js');

if (!providerV4.LOCAL_ADAPTER_IDS.includes(adapterId)) {
  throw new Error(`Unsupported adapter: ${adapterId}`);
}

const item = providerV4.createLocalServiceProvider({
  adapterId,
  baseUrl,
  clientToken: args.token || '',
  model: args.model || '',
});
const health = await item.health({ requestId: `${requestId}-health` });
if (health?.ok === false || health?.ready === false) throw new Error('Local service health check did not report ready.');
const voices = await item.voices({ requestId: `${requestId}-voices` });
const selectedVoice = args.voice || voices[0]?.voiceId || voices[0]?.name || '';
if (!selectedVoice) throw new Error('Local service returned no voice and --voice was not provided.');
const result = await item.synthesize({
  input: text,
  voice: selectedVoice,
  model: args.model || '',
  response_format: args.format || 'wav',
  requestId,
  playbackId: `${requestId}-playback`,
});
const blob = result?.blob || result?.audio;
if (!blob || typeof blob.arrayBuffer !== 'function') throw new Error('Local service returned no audio Blob.');
const output = path.resolve(args.output || path.join('.tmp-provider-smoke', `${adapterId}-${Date.now()}.${args.format || 'wav'}`));
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, new Uint8Array(await blob.arrayBuffer()));
console.log(JSON.stringify({
  ok: true,
  providerId: item.id,
  adapterId,
  baseUrl,
  voice: selectedVoice,
  health,
  capabilities: item.capabilities,
  audioPath: output,
  audioBytes: blob.size,
}, null, 2));
