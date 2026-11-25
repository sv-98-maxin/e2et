#!/usr/bin/env node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '..');
const REAL_SRC = path.join(ROOT, 'src');
const LOWER = new Set(['cases', 'report', 'daemon', 'browser', 'ir', 'shared']);
const CYCLE_LAYERS = new Set(['cli', 'cases', 'report', 'daemon']);
const ACTION_PRIMITIVES = new Set(['interactions.ts', 'actions.ts', 'assert.ts', 'capture.ts', 'mock.ts']);

function layerOf(file, src) {
  const relative = path.relative(src, file);
  if (relative === 'cli.ts' || relative.startsWith(`cli${path.sep}`)) return 'cli';
  const top = relative.split(path.sep)[0];
  return LOWER.has(top) ? top : '';
}

function rel(file, root = ROOT) {
  return path.relative(root, file).replaceAll(path.sep, '/');
}

function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return { external: true };
  const target = path.resolve(path.dirname(fromFile), specifier);
  const base = target.endsWith('.js') || target.endsWith('.ts') ? target.slice(0, -3) : target;
  for (const file of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return { file };
  }
  return { missing: true };
}

function dependencies(files) {
  const graph = new Map([...files].map((file) => [file, new Set()]));
  const missing = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      const add = (specifier, line) => {
        const resolved = resolveImport(file, specifier);
        if (resolved.missing) {
          missing.push(`${rel(file)}:${line}: cannot resolve ${specifier}`);
          return;
        }
        if (!resolved.external && files.has(resolved.file)) graph.get(file).add(resolved.file);
      };
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const position = node.moduleSpecifier.getStart(source);
        add(node.moduleSpecifier.text, source.getLineAndCharacterOfPosition(position).line + 1);
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const position = node.moduleSpecifier.getStart(source);
        add(node.moduleSpecifier.text, source.getLineAndCharacterOfPosition(position).line + 1);
      }
      if (ts.isCallExpression(node)
        && node.expression?.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const position = node.arguments[0].getStart(source);
        add(node.arguments[0].text, source.getLineAndCharacterOfPosition(position).line + 1);
      }
      // TS type-position `import('...')` / `typeof import('...')` 同样是层依赖
      if (ts.isImportTypeNode(node)
        && ts.isLiteralTypeNode(node.argument)
        && ts.isStringLiteral(node.argument.literal)) {
        const position = node.argument.literal.getStart(source);
        add(node.argument.literal.text, source.getLineAndCharacterOfPosition(position).line + 1);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { graph, missing };
}

function productionFiles(src) {
  const files = new Set();
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') visit(file);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        files.add(file);
      }
    }
  };
  visit(src);
  return files;
}

function checkDirection(files, graph, src, root) {
  const violations = [];
  for (const file of files) {
    if (!LOWER.has(layerOf(file, src))) continue;
    for (const dependency of graph.get(file)) {
      if (layerOf(dependency, src) === 'cli') {
        violations.push(`${rel(file, root)} -> cli:${rel(dependency, root)}`);
      }
    }
  }

  const router = [...files].find((file) => path.relative(src, file) === path.join('cli', 'router.ts'));
  if (router) {
    for (const dependency of graph.get(router)) {
      if (layerOf(dependency, src) !== 'cli') {
        violations.push(`router ${rel(router, root)} -> ${layerOf(dependency, src) || 'root'}:${rel(dependency, root)}`);
      }
    }
  }

  const coordinator = [...files].find((file) => path.relative(src, file) === path.join('daemon', 'daemon.ts'));
  if (coordinator) {
    for (const dependency of graph.get(coordinator)) {
      if (layerOf(dependency, src) === 'browser' && ACTION_PRIMITIVES.has(path.basename(dependency))) {
        violations.push(`daemon coordinator ${rel(coordinator, root)} -> action primitive:${rel(dependency, root)}`);
      }
    }
  }
  return violations;
}

function cycles(graph, src, root) {
  const cyclesFound = [];
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  let nextIndex = 0;
  const connect = (node) => {
    index.set(node, nextIndex);
    low.set(node, nextIndex);
    nextIndex++;
    stack.push(node);
    onStack.add(node);
    for (const dependency of graph.get(node) ?? []) {
      if (!index.has(dependency)) {
        connect(dependency);
        low.set(node, Math.min(low.get(node), low.get(dependency)));
      } else if (onStack.has(dependency)) {
        low.set(node, Math.min(low.get(node), index.get(dependency)));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component = [];
      for (;;) {
        const current = stack.pop();
        onStack.delete(current);
        component.push(current);
        if (current === node) break;
      }
      if (component.length > 1 || (component.length === 1 && graph.get(component[0])?.has(component[0]))) {
        const layers = component.map((file) => layerOf(file, src));
        const browserOnly = layers.every((layer) => layer === 'browser');
        const relevant = layers.some((layer) => CYCLE_LAYERS.has(layer));
        if (!browserOnly && relevant) {
          cyclesFound.push(component.map((file) => rel(file, root)).sort().join(' <-> '));
        }
      }
    }
  };
  for (const node of graph.keys()) if (!index.has(node)) connect(node);
  return [...new Set(cyclesFound)];
}

function runChecks(files, src, root = ROOT) {
  const { graph, missing } = dependencies(files);
  return {
    violations: checkDirection(files, graph, src, root),
    missing,
    cycles: cycles(graph, src, root),
  };
}

function selfTest() {
  const src = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'e2et-arch-'));
  const write = (layer, file, text) => {
    const target = path.join(src, layer, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    return target;
  };
  const shared = write('shared', 'shared.ts', 'export const value = 1;\n');
  const cases = write('cases', 'case.ts', `import { value } from '../shared/shared.js';\nexport const result = value;\n`);
  const handler = write('cli', 'handler.ts', `import { result } from '../cases/case.js';\nexport const run = result;\n`);
  const context = write('cli', 'context.ts', `import { value } from '../shared/shared.js';\nexport const context = value;\n`);
  const router = write('cli', 'router.ts', `import { run } from './handler.js';\nimport { context } from './context.js';\nexport const entry = run + context;\n`);
  const daemonClient = write('daemon', 'client.ts', `import { value } from '../shared/shared.js';\nexport const client = value;\n`);
  const files = new Set([shared, cases, handler, context, router, daemonClient]);
  const resetLegal = () => {
    fs.writeFileSync(shared, 'export const value = 1;\n');
    fs.writeFileSync(cases, `import { value } from '../shared/shared.js';\nexport const result = value;\n`);
    fs.writeFileSync(router, `import { run } from './handler.js';\nimport { context } from './context.js';\nexport const entry = run + context;\n`);
  };

  const legal = runChecks(files, src, src);
  const legalFailures = [...legal.violations, ...legal.missing, ...legal.cycles];
  if (legalFailures.length) throw new Error(`self-test legal: expected pass, got ${legalFailures.join(', ')}`);

  fs.writeFileSync(cases, `import type { X } from '../cli/router.js';\nexport const result = 1;\n`);
  const reverse = runChecks(files, src, src);
  if (!reverse.violations.some((violation) => violation.includes('cases/case.ts -> cli:cli/router.ts'))) {
    throw new Error('self-test reverse-type: expected violation');
  }
  resetLegal();
  fs.writeFileSync(cases, `export type Entry = typeof import('../cli/router.js').entry;\nexport const result = 1;\n`);
  const importType = runChecks(files, src, src);
  if (!importType.violations.some((violation) => violation.includes('cases/case.ts -> cli:cli/router.ts'))) {
    throw new Error('self-test import-type: expected violation');
  }
  if (!importType.cycles.some((cycle) => cycle.includes('cli/router.ts') && cycle.includes('cases/case.ts'))) {
    throw new Error('self-test import-type-cycle: expected violation');
  }
  resetLegal();
  fs.writeFileSync(shared, `import type { X } from '../cli/router.js';\nexport const value = 1;\n`);
  const sharedReverse = runChecks(files, src, src);
  if (!sharedReverse.violations.some((violation) => violation.includes('shared/shared.ts -> cli:cli/router.ts'))) {
    throw new Error('self-test shared-reverse: expected violation');
  }

  const browser = write('browser', 'page.ts', `import type { X } from '../cli/router.js';\nexport const page = 1;\n`);
  const ir = write('ir', 'ir.ts', `import type { X } from '../cli/router.js';\nexport const ir = 1;\n`);
  files.add(browser);
  files.add(ir);
  const lowerReverse = runChecks(files, src, src);
  if (!lowerReverse.violations.some((violation) => violation.includes('browser/page.ts -> cli:cli/router.ts'))
    || !lowerReverse.violations.some((violation) => violation.includes('ir/ir.ts -> cli:cli/router.ts'))) {
    throw new Error('self-test lower-reverse: expected browser and ir violations');
  }

  resetLegal();
  fs.writeFileSync(browser, `import { value } from '../shared/shared.js';\nexport const page = value;\n`);
  fs.writeFileSync(ir, `export const ir = 1;\n`);
  const report = write('report', 'report.ts', 'export const report = 1;\n');
  files.add(report);
  fs.writeFileSync(router, `import { report } from '../report/report.js';\nimport { page } from '../browser/page.js';\nimport { client } from '../daemon/client.js';\nimport { result } from '../cases/case.js';\nexport const entry = report + page + client + result;\n`);
  const routerOperations = runChecks(files, src, src);
  if (!routerOperations.violations.some((violation) => violation.includes('router cli/router.ts -> report:'))
    || !routerOperations.violations.some((violation) => violation.includes('router cli/router.ts -> browser:'))
    || !routerOperations.violations.some((violation) => violation.includes('router cli/router.ts -> cases:'))) {
    throw new Error('self-test router-operations: expected report, browser, and cases violations');
  }

  const actionPrimitive = write('browser', 'actions.ts', 'export const action = 1;\n');
  files.add(actionPrimitive);
  const coordinator = write('daemon', 'daemon.ts', `import { action } from '../browser/actions.js';\nexport const daemon = action;\n`);
  files.add(coordinator);
  const daemonPrimitive = runChecks(files, src, src);
  if (!daemonPrimitive.violations.some((violation) => violation.includes('daemon/daemon.ts -> action primitive:'))) {
    throw new Error('self-test daemon-primitive: expected violation');
  }

  fs.writeFileSync(coordinator, `import { client } from './client.js';\nexport const daemon = client;\n`);
  fs.writeFileSync(browser, `import { entry } from '../cli/router.js';\nimport { value } from '../shared/shared.js';\nexport const page = entry + value;\n`);
  const crossLayerCycle = runChecks(files, src, src);
  if (!crossLayerCycle.cycles.some((cycle) => cycle.includes('cli/router.ts') && cycle.includes('browser/page.ts'))) {
    throw new Error('self-test cross-layer-cycle: expected violation');
  }

  fs.writeFileSync(browser, `import { locator } from './locator-query.js';\nexport const page = locator;\n`);
  const browserOnly = write('browser', 'locator-query.ts', `import { page } from './page.js';\nexport const locator = page;\n`);
  files.add(browserOnly);
  const browserBaseline = runChecks(files, src, src);
  if (browserBaseline.cycles.some((cycle) => cycle.includes('browser/page.ts') && cycle.includes('browser/locator-query.ts'))) {
    throw new Error('self-test browser-baseline: expected browser-only cycle to be excluded');
  }

  fs.rmSync(src, { recursive: true, force: true });
  console.log('self-test: ok');
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return 0;
  }
  const files = productionFiles(REAL_SRC);
  const result = runChecks(files, REAL_SRC, ROOT);
  const failures = [...result.violations, ...result.missing, ...result.cycles];
  if (failures.length) {
    console.error('architecture check failed:');
    for (const failure of failures) console.error(`  ${failure}`);
    return 1;
  }
  console.log('architecture check: ok');
  return 0;
}

process.exitCode = main();
