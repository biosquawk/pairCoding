import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { boundedSelection, boundedFiles, sourceInventory, sourceRoots, assertLcovInventory } from '../../scripts/coverage-policy.mjs';
import { selectTests, testArguments } from '../../scripts/runtime-test.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const json = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const write = (dir, name, body) => { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };

test('coverage is explicit ACTIVE subset; canonical full test and retirement filters remain intact', () => {
  const canonical = selectTests(root), selection = boundedSelection(root);
  assert.equal(json('package.json').scripts.test, 'node scripts/runtime-test.mjs');
  assert.equal(new Set(boundedFiles).size, boundedFiles.length);
  assert.ok(selection.notRun.length > 0);
  assert.deepEqual(new Set([...selection.active, ...selection.notRun]), new Set(canonical.active));
  assert.deepEqual(selection.superseded, canonical.superseded);
  assert.deepEqual(selection.supersededCases, canonical.supersededCases);
  for (const group of testArguments(selection)) {
    if (group.lane === 'tsx') assert.deepEqual(group.args.slice(0, 2), ['--import', 'tsx']);
    else assert.ok(!group.args.includes('tsx'));
    for (const c of selection.supersededCases.filter(c => group.args.includes(c.file))) {
      assert.ok(group.args.includes('--test-skip-pattern'), c.file);
    }
  }
});
test('QG and c8 cover identical production roots including tooling, no complexity exclusions', () => {
  const config = json('.c8rc.json'), runner = json('.quality-runner.json');
  assert.equal(config.all, true);
  assert.equal(config['exclude-after-remap'], true);
  assert.deepEqual(json('.quality-policy.json').source_roots, sourceRoots);
  assert.deepEqual(config.include, sourceRoots.map(r => ['src', 'scripts'].includes(r) ? r + '/**' : r));
  assert.deepEqual(config.exclude, ['**/*.d.ts', '**/*.d.mts', '**/*.d.cts', '**/*.test.*', '**/*.spec.*']);
  for (const lang of ['javascript', 'typescript']) {
    assert.match(runner[lang].coverage_command[0], /[/\\]node(?:\.exe)?$/);
    assert.deepEqual(runner[lang].coverage_command.slice(1), ['scripts/coverage.mjs']);
    assert.deepEqual(runner[lang].test_command, [...runner[lang].coverage_command, '--tests']);
    assert.deepEqual(runner[lang].coverage_reports, ['coverage/lcov.info']);
  }
  const inventory = sourceInventory(root);
  for (const file of ['src/App.tsx', 'src/server/index.ts', 'scripts/package-windows.mjs', 'vite.config.ts', 'java-puzzlers/prepare-tasks.mjs']) assert.ok(inventory.included.includes(file));
  assert.ok(inventory.included.length > 150);
});
test('inventory rejects missing/extra/duplicate LCOV and unknown production sources', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-boundary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/new.ts', 'export const uncovered = 1;\n');
  write(dir, 'examples/task/main.ts', 'export const task = 1;\n');
  const inventory = sourceInventory(dir);
  assert.deepEqual(inventory.included, ['src/new.ts']);
  assert.equal(inventory.excluded.length, 1);
  assert.throws(() => assertLcovInventory('', inventory, dir), /missing/);
  assert.throws(() => assertLcovInventory('SF:src/new.ts\nSF:other.ts\n', inventory, dir), /unexpected/);
  assert.throws(() => assertLcovInventory('SF:src/new.ts\nSF:src/new.ts\n', inventory, dir), /duplicates/);
  assert.equal(assertLcovInventory('SF:src/new.ts\n', inventory, dir).sourceFiles, 1);
  write(dir, 'unclassified.ts', 'export const platform = 1;\n');
  assert.throws(() => sourceInventory(dir), /Unclassified source/);
});
test('real c8 maps TS/TSX lines and retains a never-imported production TSX at measured zero', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-maps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  write(dir, 'package.json', '{"type":"module"}');
  write(dir, 'tsconfig.json', '{"compilerOptions":{"jsx":"react"}}');
  write(dir, 'src/branch.ts', 'export function choose(n: number) {\n  if (n > 0) return "positive";\n  return "other";\n}\n');
  write(dir, 'src/view.tsx', 'const React = { createElement: (tag: string) => ({tag}) };\nexport const View = () => <main/>;\n');
  write(dir, 'src/never.tsx', 'export const Never = () => <aside/>;\n');
  write(dir, 'run.test.ts', 'import test from "node:test"; import assert from "node:assert/strict"; import {choose} from "./src/branch.ts"; import {View} from "./src/view.tsx"; test("mapped", () => { assert.equal(choose(1), "positive"); assert.equal(View().tag, "main"); });');
  write(dir, '.c8rc.json', JSON.stringify({ ...json('.c8rc.json'), include: ['src/**'] }));
  // This fixture launches an independent test runner, not a nested Node test context.
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/c8/bin/c8.js'), '--config', '.c8rc.json',
    process.execPath, '--import', pathToFileURL(path.join(root, 'node_modules/tsx/dist/loader.mjs')).href,
    '--test', 'run.test.ts'], { cwd: dir, encoding: 'utf8', timeout: 20_000, env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const lcov = fs.readFileSync(path.join(dir, 'coverage/lcov.info'), 'utf8');
  assert.equal(assertLcovInventory(lcov, sourceInventory(dir), dir).sourceFiles, 3);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, 'coverage/coverage-summary.json'), 'utf8'));
  assert.equal(summary[path.join(dir, 'src/never.tsx')].lines.pct, 0);
  assert.equal(summary[path.join(dir, 'src/view.tsx')].lines.pct, 100);
  const records = lcov.split('end_of_record');
  // V8 ranges on tsx's compact output may mark a whole line as executed.
  // The unexecuted branch must still map to its ORIGINAL TS line, not generated JS.
  assert.match(records.find(r => r.includes('SF:src/branch.ts')), /BRDA:3,\d+,\d+,0/);
  assert.ok(!lcov.includes('node_modules') && !lcov.includes('run.test.ts'));
});
