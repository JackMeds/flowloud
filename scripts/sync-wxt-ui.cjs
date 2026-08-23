const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'extension-wxt', '.output', 'chrome-mv3');
const extensionRoot = path.join(projectRoot, 'extension');
const registryPath = path.join(extensionRoot, 'react-ui-build.json');

function ensureInside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`拒绝访问发布目录之外的路径：${candidate}`);
  }
}

function copyFile(relativeSource, relativeTarget, files) {
  const source = path.join(sourceRoot, relativeSource);
  const target = path.join(extensionRoot, relativeTarget);
  ensureInside(sourceRoot, source);
  ensureInside(extensionRoot, target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  files.push(relativeTarget.replaceAll('\\', '/'));
}

if (!fs.existsSync(path.join(sourceRoot, 'popup.html')) || !fs.existsSync(path.join(sourceRoot, 'options.html')) || !fs.existsSync(path.join(sourceRoot, 'document-workbench.html'))) {
  throw new Error('找不到 WXT 构建结果，请先运行 wxt build。');
}

if (fs.existsSync(registryPath)) {
  const previous = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  for (const relative of Array.isArray(previous.files) ? previous.files : []) {
    const target = path.join(extensionRoot, String(relative));
    ensureInside(extensionRoot, target);
    if (fs.existsSync(target) && fs.statSync(target).isFile()) fs.unlinkSync(target);
  }
}

const files = [];
copyFile('popup.html', 'popup-react.html', files);
copyFile('options.html', 'options-react.html', files);
copyFile('document-workbench.html', 'document-workbench.html', files);
for (const directory of ['chunks', 'assets']) {
  const sourceDirectory = path.join(sourceRoot, directory);
  if (!fs.existsSync(sourceDirectory)) continue;
  for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (directory === 'assets' && !/^(?:components-.*\.css|pdf\.worker-.*\.mjs)$/u.test(entry.name)) continue;
    copyFile(path.join(directory, entry.name), path.join(directory, entry.name), files);
  }
}

fs.writeFileSync(registryPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), files }, null, 2)}\n`);
console.log(`已同步 React Popup 与设置中心：${files.length} 个文件。`);
