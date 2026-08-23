const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const provider = require('../shared/provider-v4.js');

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

async function startFixture() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const body = request.method === 'POST' ? await readJson(request) : {};
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    if (request.url === '/health') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, ready: true, capabilities: { transportStreaming: true } }));
      return;
    }
    if (request.url === '/v1/audio/voices') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ voices: [{ id: 'fixture-voice', name: 'Fixture Voice' }] }));
      return;
    }
    if (request.url === '/v1/audio/speech/cancel') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ cancelled: true }));
      return;
    }
    response.statusCode = 200;
    response.setHeader('content-type', 'audio/wav');
    response.write(Buffer.from([82, 73, 70, 70]));
    response.end(Buffer.from([1, 2, 3, 4]));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

for (const contract of [
  { adapterId: 'gpt-sovits', path: '/tts', streamPath: '/tts', bodyKey: 'text' },
  { adapterId: 'cosyvoice', path: '/inference_sft', streamPath: '/inference_sft', bodyKey: 'tts_text' },
  { adapterId: 'openai-local', path: '/v1/audio/speech', streamPath: '/v1/audio/speech/stream', bodyKey: 'input' },
]) {
  test(`Provider V4 ${contract.adapterId} completes a real loopback HTTP health, voices, synthesize and stream fixture`, async () => {
    const fixture = await startFixture();
    try {
      const item = provider.createLocalServiceProvider({
        adapterId: contract.adapterId,
        baseUrl: fixture.baseUrl,
        clientToken: 'fixture-token',
      });
      const health = await item.health({ requestId: `${contract.adapterId}-health` });
      assert.equal(health.ready, true);
      const voices = await item.voices({ requestId: `${contract.adapterId}-voices` });
      assert.equal(voices[0].id, 'local-service:fixture-voice');
      const audio = await item.synthesize({
        input: '真实回环协议测试', voice: 'local-service:fixture-voice', model: 'fixture-model',
        requestId: `${contract.adapterId}-speech`, response_format: 'wav',
      });
      assert.equal(audio.providerId, 'local-service');
      assert.equal(audio.blob.size, 8);
      const stream = item.stream({
        input: '流式回环测试', voice: 'local-service:fixture-voice', model: 'fixture-model',
        requestId: `${contract.adapterId}-stream`, response_format: 'wav',
      });
      const chunks = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      assert.equal(Buffer.concat(chunks).byteLength, 8);
      const speechRequests = fixture.requests.filter((entry) => [contract.path, contract.streamPath].includes(entry.url));
      assert.equal(speechRequests.length, 2);
      assert.equal(speechRequests[0].url, contract.path);
      assert.equal(speechRequests[1].url, contract.streamPath);
      assert.equal(speechRequests[0].body[contract.bodyKey], '真实回环协议测试');
      assert.equal(speechRequests[1].body[contract.bodyKey], '流式回环测试');
      assert.equal(speechRequests[0].headers.authorization, 'Bearer fixture-token');
    } finally {
      await fixture.close();
    }
  });
}

test('OpenAI-local cancellation reaches its declared remote cancellation endpoint with identity', async () => {
  const fixture = await startFixture();
  try {
    const item = provider.createLocalServiceProvider({ adapterId: 'openai-local', baseUrl: fixture.baseUrl });
    const result = await item.cancel({ requestId: 'cancel-request', playbackId: 'cancel-playback' });
    assert.equal(result.remoteCancelled, true);
    const request = fixture.requests.find((entry) => entry.url === '/v1/audio/speech/cancel');
    assert.deepEqual(request.body, { request_id: 'cancel-request', playback_id: 'cancel-playback' });
  } finally {
    await fixture.close();
  }
});
