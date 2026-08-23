const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const EXTENSION_ROOT = path.join(ROOT, 'extension');
const NODE_USER_AGENT = 'Flowloud-real-site-smoke/0.10';
const CONTROL_TEXT = /(?:点赞|举报|复制链接|登录后回复|topic owner|post actions)/iu;

function loadRuntime() {
  for (const name of [
    'QwenReaderText',
    'QwenReaderForumContent',
    'QwenReaderGenericThreadDetector',
    'QwenReaderNormalizedDocument',
    'QwenReaderDocument',
    'QwenReaderExtractors',
  ]) {
    delete globalThis[name];
  }
  for (const relativePath of [
    'shared/text.js',
    'shared/forum-content.js',
    'shared/generic-thread-detector.js',
    'shared/normalized-document.js',
    'shared/extractors.js',
  ]) {
    const absolutePath = path.join(EXTENSION_ROOT, relativePath);
    vm.runInThisContext(fs.readFileSync(absolutePath, 'utf8'), { filename: relativePath });
  }
  return {
    extractors: globalThis.QwenReaderExtractors,
    documentModel: globalThis.QwenReaderDocument,
  };
}

function locationFor(url) {
  const parsed = new URL(url);
  return {
    href: parsed.href,
    origin: parsed.origin,
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
    toString: () => parsed.href,
  };
}

function documentFor(url) {
  return {
    location: locationFor(url),
    title: '',
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

async function liveFetch(url, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  if (!headers.has('user-agent')) headers.set('user-agent', NODE_USER_AGENT);
  return fetch(url, { ...init, headers });
}

function validateResult(target, result, documentModel) {
  const blocks = Array.isArray(result && result.blocks) ? result.blocks : [];
  if (blocks.length < 2) throw new Error(`${target}: expected at least two readable blocks, got ${blocks.length}`);
  if (blocks.some((block) => !block.authorId || !block.sourceLocator)) {
    throw new Error(`${target}: author identity or source locator is missing`);
  }
  if (blocks.some((block) => CONTROL_TEXT.test(String(block.text || '')))) {
    throw new Error(`${target}: forum controls leaked into speech content`);
  }
  const normalized = documentModel.createDocument({
    url: result.url,
    pageKey: result.pageKey,
    adapterId: result.adapterId,
    blocks,
  });
  const segments = documentModel.toPlaybackSegments(normalized, 260);
  if (!segments.length || segments.some((segment) => !segment.sourceIdentity)) {
    throw new Error(`${target}: stable playback source identity is missing`);
  }
  if (new Set(segments.map((segment) => segment.sourceIdentity)).size !== segments.length) {
    throw new Error(`${target}: playback source identities are not unique`);
  }
  return {
    adapter: result.adapterId,
    blocks: blocks.length,
    segments: segments.length,
    authors: new Set(blocks.map((block) => block.authorId)).size,
    complete: result.complete !== false,
    warnings: result.warnings || [],
  };
}

async function checkTarget(target, url, runtime) {
  const result = await runtime.extractors.extractDocument(documentFor(url), { fetchFn: liveFetch });
  if (!result.blocks.length && result.warnings && result.warnings.includes(`${target}-api-unavailable`)) {
    return { target, status: 'blocked', reason: 'site API rejected the non-browser smoke request' };
  }
  return { target, status: 'passed', ...validateResult(target, result, runtime.documentModel) };
}

async function main() {
  const runtime = loadRuntime();
  const targets = [
    ['flarum', 'https://bbs.viva-la-vita.org/d/23351'],
    ['discourse', 'https://linux.do/t/topic/997705'],
  ];
  const results = [];
  for (const [target, url] of targets) {
    try {
      results.push(await checkTarget(target, url, runtime));
    } catch (error) {
      results.push({ target, status: 'failed', reason: error instanceof Error ? error.message : String(error) });
    }
  }
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
  if (results.some((result) => result.status === 'failed')) process.exitCode = 1;
  if (process.argv.includes('--require-all') && results.some((result) => result.status !== 'passed')) process.exitCode = 1;
}

void main();
