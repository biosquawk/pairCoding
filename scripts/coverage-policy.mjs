/** Explicit bounded measurement, NOT the full npm test campaign. */
import fs from 'node:fs';
import path from 'node:path';
import { selectTests } from './runtime-test.mjs';

export const sourceRoots = ['src', 'scripts', 'vite.config.ts', 'java-puzzlers/prepare-tasks.mjs'];
export const boundedFiles = [
  'tests/platform-coverage/coverage.test.mjs',
  'tests/core/core.test.ts',
  'tests/qa/g1-writegate.test.ts',
  'tests/client/safe-markdown-p2.test.ts',
  'tests/client/hint-bubble-p2.test.ts',
  'tests/lightweight-editor/currentness.test.ts',
  'tests/runtime-contract/runtime.test.ts',
  'tests/runtime-contract/ports.test.ts',
  'tests/runtime-architecture/repository.test.ts',
  'tests/runtime-architecture/detector.test.ts',
  'tests/runtime-packaging/source-closure.test.mjs',
  'tests/runtime-packaging/test-selection.test.mjs',
  'tests/runtime-packaging/test-support-closure.test.mjs',
  'tests/scripts/package-closure-p1.test.mjs',
  'tests/scripts/revision-verifier-p1.test.mjs',
];
export function boundedSelection(root) {
  const canonical = selectTests(root);
  for (const file of boundedFiles) {
    if (!canonical.active.includes(file)) throw Error('Bounded coverage test is not ACTIVE: ' + file);
  }
  const selected = new Set(boundedFiles);
  return { ...canonical, active: [...boundedFiles],
    tsx: canonical.tsx.filter(f => selected.has(f)),
    nativeMjs: canonical.nativeMjs.filter(f => selected.has(f)),
    notRun: canonical.active.filter(f => !selected.has(f)),
    status: 'BOUNDED_SUBSET_NOT_FULL_SUITE' };
}
const extension = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/;
const declarations = /\.d\.(?:ts|mts|cts)$/;
const ignored = new Set(['node_modules', '.git', '.metrics', 'coverage', 'target', 'build', 'dist',
  'artifacts', 'test-results', 'playwright-report', '.paircoach', '.paircoach-runtime']);
export function sourceInventory(root) {
  const included = [], excluded = [];
  function visit(relative) {
    for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (ignored.has(item.name) || item.name.startsWith('.paircoach-')) continue;
      const file = path.posix.join(relative, item.name);
      if (item.isSymbolicLink()) throw Error('Symlink in source inventory: ' + file);
      if (item.isDirectory()) { visit(file); continue; }
      if (!item.isFile() || !extension.test(file)) continue;
      const production = sourceRoots.some(r => file === r || file.startsWith(r + '/'));
      let reason;
      if (declarations.test(file)) reason = 'Type declarations; no executable code';
      else if (file.startsWith('tests/') || /\.(test|spec)\./.test(file) || file === 'playwright.config.ts') reason = 'Test source/support or test-only runner configuration';
      else if (production) { included.push(file); continue; }
      else if (file.startsWith('examples/') || file.startsWith('java-puzzlers/')) reason = 'Exercise input, executed in task runtime, not the platform (prepare-tasks.mjs is included)';
      else if (file.startsWith('docs/') || file.startsWith('investigations/')) reason = 'Historical QA/research source, not shipped platform runtime';
      else throw Error('Unclassified source; review product boundary: ' + file);
      excluded.push({ file, reason });
    }
  }
  visit('');
  return { sourceRoots, included: included.sort(), excluded: excluded.sort((a, b) => a.file.localeCompare(b.file)),
    generatedExclusions: [...ignored],
    note: 'All src files retained, including dormant/retired implementations. Types-only .ts retained conservatively; only .d.ts declarations excluded.' };
}
export function assertLcovInventory(lcov, inventory, root) {
  const files = lcov.split(/\r?\n/).filter(l => l.startsWith('SF:')).map(l => {
    const name = l.slice(3);
    return (path.isAbsolute(name) ? path.relative(root, name) : name).split(path.sep).join('/');
  });
  const actual = new Set(files), expected = new Set(inventory.included);
  const missing = [...expected].filter(f => !actual.has(f));
  const unexpected = [...actual].filter(f => !expected.has(f));
  if (actual.size !== files.length || missing.length || unexpected.length) {
    throw Error('LCOV source mismatch: ' + JSON.stringify({ missing, unexpected, duplicates: files.length - actual.size }));
  }
  return { status: 'EXACT_INVENTORY_MATCH', sourceFiles: files.length };
}
