import { spawnSync } from 'node:child_process';
import { resolve, relative } from 'node:path';
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this command through npm run library:build.');
function run(script, args = [], capture = false) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.status !== 0) throw new Error(result.stderr || `Library build failed: ${script}`);
  return result.stdout;
}
run('scripts/build-docscan-wasm.mjs');
const output = run(resolve('../thuvien/browser/build.mjs'), ['--web-root', process.cwd()], true);
const built = JSON.parse(output.trim().split(/\r?\n/).at(-1));
const archive = relative(process.cwd(), built.archive).replaceAll('\\', '/');
if (!/^vendor\/docscan-browser-[a-zA-Z0-9.-]+\.tgz$/.test(archive))
  throw new Error('Unexpected SDK package path.');
run(npmCli, ['install', '--offline', '--ignore-scripts', '--save-exact', `./${archive}`]);
run('node_modules/typescript/bin/tsc', ['-p', 'tests/sdk/tsconfig.json']);
console.log(`Library SDK installed: ${built.id}`);
