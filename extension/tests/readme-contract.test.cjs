const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(extensionRoot, '..');
const projectReadme = fs.readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');
const extensionReadme = fs.readFileSync(path.join(extensionRoot, 'README.md'), 'utf8');

test('project README explains purpose, capabilities, model access, and quick use', () => {
  for (const heading of ['我们能实现什么', '我们是干什么用的', '支持什么模型和接入方式', '快速使用']) {
    assert.match(projectReadme, new RegExp(`## ${heading}`));
  }
  assert.match(projectReadme, /local-qwen/);
  assert.match(projectReadme, /browser-system/);
  assert.match(projectReadme, /local-qwen/);
  assert.match(projectReadme, /dist\\Flowloud-Edge/);
  assert.match(projectReadme, /edge:\/\/extensions\//);
  assert.match(projectReadme, /页面导览/);
});

test('extension README describes the popup-first floating-player experience', () => {
  assert.match(extensionReadme, /网页悬浮播放器/);
  assert.match(extensionReadme, /完整\/最小化/);
  assert.match(extensionReadme, /网页点读默认关闭/);
  assert.match(extensionReadme, /麦克风录制和批量上传音频/);
  assert.doesNotMatch(extensionReadme, /悬浮球|右侧栏|打开侧栏/);
});
