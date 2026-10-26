// Safari can reevaluate a worker entry when a lazy chunk imports it back.
// Inspect emitted imports, including dynamic chunks, rather than only source imports.
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';

const directory = resolve(process.argv[2] ?? 'dist/assets');
const entries = (await readdir(directory)).filter((file) =>
  /^(?:comparison\.worker|scanic-classical\.worker|scanic-frame|gcnet\.worker)-.*\.js$/.test(file),
);
assert.ok(
  entries.some((file) => file.startsWith('comparison.worker-')),
  'Missing comparison worker',
);
assert.ok(
  entries.some((file) => file.startsWith('scanic-classical.worker-')),
  'Missing scanner worker',
);
assert.ok(
  entries.some((file) => file.startsWith('scanic-frame-')),
  'Missing scanner iframe',
);
const graph = new Map();
async function imports(file) {
  if (graph.has(file)) return graph.get(file);
  const source = ts.createSourceFile(
    file,
    await readFile(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const paths = [];
  function visit(node) {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : undefined;
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.'))
      paths.push(resolve(dirname(file), specifier.text));
    ts.forEachChild(node, visit);
  }
  visit(source);
  graph.set(file, paths);
  return paths;
}
const entryPaths = new Set(entries.map((file) => resolve(directory, file)));
const visited = new Set();
async function inspect(file, trail) {
  for (const dependency of await imports(file)) {
    assert.equal(
      entryPaths.has(dependency),
      false,
      `Worker entry re-import: ${[...trail, dependency].map((file) => basename(file)).join(' -> ')}`,
    );
    if (visited.has(dependency)) continue;
    visited.add(dependency);
    await inspect(dependency, [...trail, dependency]);
  }
}
for (const entry of entryPaths) {
  visited.add(entry);
  await inspect(entry, [entry]);
}
console.log(
  `Build: ${entries.length} processing entries / ${visited.size} emitted modules checked; no entry re-import.`,
);
