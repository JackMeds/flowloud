import { spawn } from 'node:child_process';
import path from 'node:path';

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const [rawKey, inlineValue] = item.slice(2).split('=', 2);
    values[rawKey] = inlineValue ?? argv[++index];
  }
  return values;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`)));
  });
}

const mode = process.argv[2] || '';
const args = parseArgs(process.argv.slice(3));
const node = process.execPath;
const playwrightCli = path.resolve('node_modules', '@playwright', 'test', 'cli.js');
const pnpmCli = process.env.npm_execpath || '';

if (mode === 'target') {
  if (!args.url) throw new Error('缺少 --url，例如：pnpm e2e:target --url https://example.com --scenario continuation');
  new URL(args.url);
  await run(node, [playwrightCli, 'test', 'e2e/tests/target.spec.ts'], {
    env: {
      FLOWLOUD_TARGET_URL: args.url,
      FLOWLOUD_TARGET_SCENARIO: args.scenario || 'continuation',
    },
  });
} else if (mode === 'release') {
  if (!pnpmCli) throw new Error('请通过 pnpm e2e:release 运行发布验证。');
  await run(node, [pnpmCli, 'typecheck']);
  await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '../scripts/package-release.ps1']);
  await run(node, [playwrightCli, 'test']);
  if (args['with-browser-model']) {
    await run(node, ['../scripts/browser-model-smoke.mjs', '--model', 'kokoro-zh', '--mode', 'full', '--keep-cache']);
  }
} else {
  throw new Error(`未知 E2E 模式：${mode}`);
}
