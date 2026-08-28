import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifestVersion: 3,
  targetBrowsers: ['chrome', 'edge'],
  dev: {
    server: {
      host: '127.0.0.1',
      port: 3010,
      strictPort: true,
    },
  },
  // Chrome treats extension modulepreload requests as a different execution
  // world and emits a warning even when the module is loaded successfully.
  // The popup/options pages are small enough that native module loading is
  // preferable to noisy, unused preload entries.
  vite: () => ({
    build: {
      modulePreload: false,
    },
  }),
  manifest: {
    name: 'Flowloud / 流声',
    description: '把网页正文与论坛讨论变成可跟随、可控制的自然朗读。',
    permissions: ['storage', 'activeTab'],
    optional_host_permissions: [
      'http://127.0.0.1:7811/*',
      'https://www.modelscope.cn/*', 'https://modelscope.cn/*', 'https://*.modelscope.cn/*',
      'https://huggingface.co/*', 'https://*.huggingface.co/*', 'https://*.hf.co/*',
    ],
    action: {
      default_title: '打开 Flowloud 控制台',
    },
  },
});
