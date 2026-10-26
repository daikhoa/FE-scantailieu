// Safari can reevaluate a worker entry when a lazy chunk imports it back.
// Inspect emitted imports, including dynamic chunks, rather than only source imports.
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { existsSync } from 'node:fs';

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

// Production may use browser codecs/model runtimes, but cannot quietly resume JS raster math.
const forbidden = new Set(
  [
    'src/imaging/rendering/perspective-warp.ts',
    'src/imaging/rendering/region-perspective-warp.ts',
    'src/imaging/rendering/document-filter.ts',
    'src/imaging/rendering/enhanced-color.ts',
    'src/imaging/restoration/adaptive-enhancement.ts',
    'src/imaging/restoration/enhanced-appearance.ts',
  ].map((file) => resolve(file)),
);
const productionVisited = new Set();
async function inspectProduction(file) {
  assert.equal(forbidden.has(file), false, `Production imports legacy JS raster kernel: ${file}`);
  if (productionVisited.has(file)) return;
  productionVisited.add(file);
  const source = ts.createSourceFile(
    file,
    await readFile(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const dependencies = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const clause = node.importClause;
      const onlyTypes =
        clause?.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        !clause.name &&
        clause.namedBindings.elements.every((element) => element.isTypeOnly);
      if (!onlyTypes && ts.isStringLiteral(node.moduleSpecifier))
        dependencies.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      dependencies.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const dependency of dependencies) {
    if (!dependency.startsWith('.')) continue;
    const candidate = resolve(dirname(file), dependency);
    const target = ['.ts', '.tsx'].map((extension) => candidate + extension).find(existsSync);
    if (target) await inspectProduction(target);
  }
}
for (const entry of ['scanic-classical.worker.ts', 'scanic-frame.ts'])
  await inspectProduction(resolve('src/imaging/engines', entry));
console.log(
  'Production scanner: native raster path verified; legacy JS kernels remain comparison-only.',
);
