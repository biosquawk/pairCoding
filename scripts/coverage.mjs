/** Bounded c8/V8 coverage with TS/TSX source maps; never invokes full npm test. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { testArguments } from './runtime-test.mjs';
import { boundedSelection, sourceInventory, assertLcovInventory } from './coverage-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = value => console.log(JSON.stringify(value));
function run(command, args, timeout, env) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false, timeout, env });
  if (result.error || result.signal || result.status !== 0) {
    throw Error('Coverage/baseline execution failed: ' + JSON.stringify({ command, args,
      error: result.error?.message, signal: result.signal, status: result.status }));
  }
}
function tests() {
  const selection = boundedSelection(root);
  report(selection);
  const tmp = path.join(root, 'target/coverage-test-tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const deadline = Date.now() + 180_000;
  const failures = [];
  // Retain canonical TS/native-MJS lanes AND file-bound retirement case filters.
  for (const group of testArguments(selection)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error('Bounded test deadline exceeded');
    const args = [...group.args];
    args.splice(args.indexOf('--test') + 1, 0, '--test-timeout=' + Math.min(150_000, remaining));
    try {
      run(process.execPath, args, remaining + 1000, { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp });
    } catch (error) { failures.push(error.message); }
  }
  if (failures.length) throw Error(failures.join('\n'));
}
function coverage() {
  // Fail before measurement for an unclassified/missing source, never silently shrink scope.
  const inventory = sourceInventory(root);
  const selection = boundedSelection(root);
  fs.mkdirSync(path.join(root, 'coverage'), { recursive: true });
  for (const name of ['lcov.info', 'coverage-summary.json', 'coverage-final.json', 'measurement.json']) {
    fs.rmSync(path.join(root, 'coverage', name), { force: true });
  }
  let failure;
  try {
    run(process.execPath, [path.join(root, 'node_modules/c8/bin/c8.js'), '--config', '.c8rc.json',
      process.execPath, 'scripts/coverage.mjs', '--tests'], 240_000, process.env);
  } catch (error) { failure = error; }
  const lcov = fs.readFileSync(path.join(root, 'coverage/lcov.info'), 'utf8');
  const match = assertLcovInventory(lcov, inventory, root);
  fs.writeFileSync(path.join(root, 'coverage/inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'coverage/selection.json'), JSON.stringify(selection, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'coverage/measurement.json'), JSON.stringify({ ...match,
    status: failure ? 'MEASURED_WITH_TEST_FAILURE_NOT_PASS' : 'MEASURED_BOUNDED_SUBSET_NOT_FULL_SUITE', node: process.version,
    platform: process.platform, arch: process.arch, measuredAt: new Date().toISOString(),
    command: 'npm run coverage', selectedTestFiles: selection.active.length, unselectedActiveFiles: selection.notRun.length,
    maps: 'V8 source-map-cache via tsx; c8 remaps to original TS/TSX. Unexecuted source retained by all:true.' }, null, 2) + '\n');
  report(match);
  if (failure) throw failure;
}
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--tests') tests();
  else if (!args.length) coverage();
  else throw Error('Usage: node scripts/coverage.mjs [--tests]');
} catch (error) { console.error(error.message); process.exitCode = 1; }
