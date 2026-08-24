import { test } from '../fixtures';
import { assertNoExtensionErrors, runContinuationScenario } from '../scenarios';
import type { RealSiteCase } from '../site-cases';
import http from 'node:http';

test('local deterministic page verifies refresh injection and automatic continuation', async ({ reader, diagnostics }) => {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Flowloud E2E</title></head><body><main><article><h1>自动回归</h1><p>这是第一句话。这是第二句话。这是保持播放状态的第三句话。</p><p>刷新页面后悬浮播放器应自动出现。</p></article></main></body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法启动本地浏览器测试服务器');
  const target: RealSiteCase = {
    id: 'local-continuation',
    url: `http://127.0.0.1:${address.port}/article`,
    kind: 'article',
    scenario: 'continuation',
    timeoutMs: 20_000,
    minSegments: 3,
    requiresAuth: false,
    allowedPageNoise: [],
  };
  try {
    await runContinuationScenario(reader, target);
    assertNoExtensionErrors(diagnostics);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
