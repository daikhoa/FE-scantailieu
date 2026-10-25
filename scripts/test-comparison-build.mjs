// Safari can reevaluate a worker entry when a lazy chunk imports it back.
// Inspect emitted imports, including dynamic chunks, rather than only source imports.
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';

const directory = resolve(process.argv[2] ?? 'dist/assets');
const entries = (await readdir(directory)).filter((file) =>
  /^comparison\.worker-.*\.js$/.test(file),
);
assert.equal(entries.length, 1, 'Expected one emitted comparison worker');
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
const entry = resolve(directory, entries[0]);
const visited = new Set([entry]);
async function inspect(file, trail) {
  for (const dependency of await imports(file)) {
    assert.notEqual(
      dependency,
      entry,
      `Worker entry re-import: ${[...trail, dependency].map((file) => basename(file)).join(' -> ')}`,
    );
    if (visited.has(dependency)) continue;
    visited.add(dependency);
    await inspect(dependency, [...trail, dependency]);
  }
}
await inspect(entry, [entry]);
console.log(
  `Comparison build: ${visited.size} emitted modules checked; no worker entry re-import.`,
);
