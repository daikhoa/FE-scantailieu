// Optional local browser QA fixture. Never run as part of publication packaging.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const entries = (await readdir('dist/assets')).filter((name) =>
  /^comparison\.worker-.*\.js$/.test(name),
);
assert.equal(entries.length, 1);
const html = await readFile('tests/browser/comparison-worker-reentry-probe.html', 'utf8');
await writeFile(
  'dist/worker-reentry-probe.html',
  html.replace('__WORKER_ENTRY__', `./assets/${entries[0]}`),
);
console.log('Prepared /worker-reentry-probe.html for local preview. Production build clears it.');
