import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function loadPlaywright() {
  try {
    return require('../extension-wxt/node_modules/@playwright/test');
  } catch (error) {
    const wrapped = new Error('缺少正式 Playwright 依赖；请先在 extension-wxt 中运行 pnpm install。');
    wrapped.cause = error;
    throw wrapped;
  }
}
