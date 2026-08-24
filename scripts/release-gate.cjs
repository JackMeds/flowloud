const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const extensionRoot = path.join(projectRoot, 'extension');

function listFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (['tests', 'node_modules', 'dist', 'release'].includes(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function extensionPath(relative) {
  const normalized = String(relative || '').replace(/^\//u, '').replaceAll('/', path.sep);
  const target = path.resolve(extensionRoot, normalized);
  const relation = path.relative(extensionRoot, target);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) throw new Error(`Manifest 路径越界：${relative}`);
  return target;
}

function assertFile(relative, label) {
  const target = extensionPath(relative);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`${label} 引用了不存在的文件：${relative}`);
}

function runReleaseGate() {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3) throw new Error('发布包必须使用 Manifest V3。');
  const requiredPermissions = ['storage', 'unlimitedStorage', 'offscreen', 'activeTab', 'scripting', 'tts'];
  const actualPermissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  for (const permission of requiredPermissions) {
    if (!actualPermissions.includes(permission)) throw new Error(`Manifest 缺少必要权限：${permission}`);
  }
  if (manifest.host_permissions?.length) throw new Error('远程与本地主机必须使用 optional_host_permissions。');
  if (!Array.isArray(manifest.optional_host_permissions) || !manifest.optional_host_permissions.includes('https://*/*')) {
    throw new Error('在线 TTS 的运行时精确 origin 请求必须有通用可选 HTTPS 范围作为上限。');
  }
  if (!manifest.optional_host_permissions.includes('http://*/*')) {
    throw new Error('用户配置的 HTTP 本地 Provider 必须有通用可选范围作为授权上限。');
  }
  if (!manifest.optional_host_permissions.some((pattern) => pattern.includes('localhost'))) throw new Error('Manifest 缺少 localhost 可选权限。');
  const extensionCsp = String(manifest.content_security_policy?.extension_pages || '');
  if (!extensionCsp.includes('connect-src') || !extensionCsp.includes('http:') || !extensionCsp.includes('https:')) {
    throw new Error('扩展 CSP 必须允许经运行时精确权限授权的 HTTP 回环地址与 HTTPS Provider。');
  }
  if (extensionCsp.includes('http://[::1]')) throw new Error('Chromium 不接受带 IPv6 字面量的 CSP host-source；应由 http: 与精确可选权限共同约束。');

  assertFile(manifest.background?.service_worker, 'background.service_worker');
  assertFile(manifest.action?.default_popup, 'action.default_popup');
  assertFile(manifest.options_page || manifest.options_ui?.page, 'options');
  for (const icon of Object.values(manifest.icons || {})) assertFile(icon, 'icon');
  for (const resourceGroup of manifest.web_accessible_resources || []) {
    for (const resource of resourceGroup.resources || []) assertFile(resource, 'web_accessible_resources');
  }
  const readerContent = (manifest.content_scripts || []).find((entry) => entry.js?.includes('content/reader.js'));
  if (!readerContent || !readerContent.matches?.includes('http://*/*') || !readerContent.matches?.includes('https://*/*')) {
    throw new Error('悬浮播放器必须作为全站内容脚本自动运行。');
  }
  if (readerContent.run_at !== 'document_idle' || !readerContent.css?.includes('content/page-highlight.css')) {
    throw new Error('全站阅读器缺少 document_idle 启动或页面高亮样式。');
  }
  for (const script of readerContent.js || []) assertFile(script, 'content_scripts.js');
  for (const stylesheet of readerContent.css || []) assertFile(stylesheet, 'content_scripts.css');
  for (const required of [
    'shared/provider-core.js', 'shared/provider-v4.js', 'shared/document-provider-v1.js', 'shared/settings-schema.js', 'offscreen.html',
    'content/reader-bootstrap.js',
    'document-workbench.html', 'vendor/transformers/runtime-build.json',
    'vendor/transformers/LICENSE', 'vendor/transformers/ONNXRUNTIME-LICENSE',
    'vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs', 'vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm', 'LICENSE',
    'vendor/kokoro/kokoro.web.min.js', 'vendor/kokoro/runtime-build.json',
    'vendor/kokoro/LICENSE', 'vendor/kokoro/PINYIN-PRO-LICENSE',
    'vendor/kokoro/TRANSFORMERS-LICENSE', 'vendor/kokoro/PHONEMIZER-LICENSE',
  ]) assertFile(required, '发布运行时');

  const reactBuild = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'react-ui-build.json'), 'utf8'));
  if (!Array.isArray(reactBuild.files) || !reactBuild.files.some((file) => /^assets\/pdf\.worker-.*\.mjs$/u.test(String(file)))) {
    throw new Error('React 发布同步缺少 PDF.js Worker 资产。');
  }

  const runtimeBuild = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'vendor', 'transformers', 'runtime-build.json'), 'utf8'));
  if (!runtimeBuild.transformersVersion || !runtimeBuild.onnxRuntimeVersion || !runtimeBuild.pinyinProVersion || !/^[a-f0-9]{64}$/u.test(String(runtimeBuild.sha256 || ''))) {
    throw new Error('浏览器模型运行库缺少可审计的版本或哈希。');
  }
  const kokoroBuild = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'vendor', 'kokoro', 'runtime-build.json'), 'utf8'));
  if (!kokoroBuild.kokoroJsVersion || !kokoroBuild.transformersVersion || !kokoroBuild.phonemizerVersion || !/^[a-f0-9]{64}$/u.test(String(kokoroBuild.sha256 || ''))) {
    throw new Error('Kokoro 运行库缺少可审计的固定版本或哈希。');
  }
  const kokoroSource = fs.readFileSync(path.join(extensionRoot, 'vendor', 'kokoro', 'kokoro.web.min.js'), 'utf8');
  if (/from\s*["'](?:@huggingface\/transformers|kokoro-js|phonemizer)/u.test(kokoroSource)) {
    throw new Error('Kokoro 运行库仍包含无法由扩展解析的裸模块依赖。');
  }

  const htmlFiles = listFiles(extensionRoot).filter((file) => file.endsWith('.html'));
  for (const file of htmlFiles) {
    const source = fs.readFileSync(file, 'utf8');
    if (/<script\b[^>]+src\s*=\s*["']https?:\/\//iu.test(source)) throw new Error(`发现远程脚本：${path.relative(extensionRoot, file)}`);
    for (const match of source.matchAll(/<(?:script|link)\b[^>]+(?:src|href)\s*=\s*["']([^"']+)["']/giu)) {
      const reference = match[1];
      if (/^(?:https?:|data:|#)/iu.test(reference)) continue;
      const target = reference.startsWith('/')
        ? extensionPath(reference)
        : path.resolve(path.dirname(file), reference.split(/[?#]/u)[0]);
      if (!fs.existsSync(target)) throw new Error(`${path.relative(extensionRoot, file)} 引用了不存在的资源：${reference}`);
    }
  }

  const inspected = listFiles(extensionRoot).filter((file) => /\.(?:js|mjs|cjs|html|json)$/iu.test(file));
  const forbidden = [
    { pattern: /\beval\s*\(/u, label: 'eval' },
    { pattern: /new\s+Function\s*\(/u, label: 'new Function' },
    { pattern: /import\s*\(\s*["']https?:\/\//u, label: '远程动态 import' },
    { pattern: /sk-[A-Za-z0-9_-]{20,}/u, label: '疑似 API Key' },
    { pattern: /BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY/u, label: '私钥' },
  ];
  for (const file of inspected) {
    if (file.includes(`${path.sep}vendor${path.sep}`)) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const rule of forbidden) {
      if (rule.pattern.test(source)) throw new Error(`${path.relative(extensionRoot, file)} 包含禁止发布的 ${rule.label}。`);
    }
  }

  const privacy = fs.readFileSync(path.join(projectRoot, 'docs', 'privacy.md'), 'utf8');
  const disclosure = fs.readFileSync(path.join(projectRoot, 'store-assets', 'PRIVACY-DISCLOSURE.md'), 'utf8');
  const listing = fs.readFileSync(path.join(projectRoot, 'store-assets', 'LISTING.zh-CN.md'), 'utf8');
  for (const term of ['OpenAI', '本地服务', 'chrome.storage.session', '文档与翻译工作台', '扫描 PDF']) {
    if (!privacy.includes(term)) throw new Error(`隐私政策缺少披露：${term}`);
  }
  for (const term of ['loopback', 'session-only', 'visible-tab screenshots', 'not persisted']) {
    if (!disclosure.includes(term)) throw new Error(`商店隐私披露缺少：${term}`);
  }
  for (const term of ['GPT-SoVITS', 'CosyVoice', '可选主机权限', 'OCR', 'PDF']) {
    if (!listing.includes(term)) throw new Error(`商店介绍缺少：${term}`);
  }

  return {
    ok: true,
    manifestVersion: manifest.manifest_version,
    version: manifest.version_name || manifest.version,
    filesInspected: inspected.length,
  };
}

if (require.main === module) {
  const result = runReleaseGate();
  console.log(`STORE GATE PASS ${result.version} (${result.filesInspected} files)`);
}

module.exports = { runReleaseGate };
