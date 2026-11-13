/** Bounded c8/V8 coverage with TS/TSX source maps; never invokes full npm test. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { testArguments } from './runtime-test.mjs';
import { boundedSelection, sourceInventory, assertLcovInventory } from './coverage-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = value => console.log(JSON.stringify(value));

// Only descendants of this invocation are targeted. No host-wide process discovery.
async function killOwnedTree(child, inheritGroup) {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    // Nested lanes remain in the c8 owner group; the outer runner reaps that
    // group on every exit. A lane timeout first terminates its direct runner.
    try { if (inheritGroup) child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    return;
  }
  await new Promise(resolve => {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: false });
    const timer = setTimeout(() => { killer.kill(); child.kill('SIGKILL'); resolve(); }, 2000);
    const done = () => { clearTimeout(timer); child.kill('SIGKILL'); resolve(); };
    killer.once('error', done);
    killer.once('exit', done);
  });
}

export async function runBounded(command, args, { timeout, cwd = root, env = process.env, stdio = 'inherit', inheritGroup = false }) {
  if (!Number.isFinite(timeout) || timeout <= 0) throw Error('Positive execution timeout required');
  const child = spawn(command, args, { cwd, stdio, shell: false, env, detached: process.platform !== 'win32' && !inheritGroup });
  let timedOut = false, cleanup;
  const clean = () => cleanup ??= killOwnedTree(child, inheritGroup);
  const result = await new Promise(resolve => {
    const timer = setTimeout(() => { timedOut = true; void clean(); }, timeout);
    const done = result => { clearTimeout(timer); resolve(result); };
    child.once('error', error => done({ error: error.message }));
    child.once('exit', (status, signal) => done({ status, signal }));
  });
  // Also remove an orphaned descendant after a successful direct child exit.
  await clean();
  if (timedOut || result.error || result.signal || result.status !== 0) {
    const error = Error('Coverage/baseline execution failed: ' + JSON.stringify({ command, args, ...result, timedOut }));
    error.timedOut = timedOut;
    throw error;
  }
}
async function tests() {
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
      await runBounded(process.execPath, args, { timeout: remaining, inheritGroup: process.env.PAIRCOACH_COVERAGE_OWNED_GROUP === '1', env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp } });
    } catch (error) {
      if (error.timedOut) throw error;
      failures.push(error.message);
    }
  }
  if (failures.length) throw Error(failures.join('\n'));
}
async function coverage() {
  // Fail before measurement for an unclassified/missing source, never silently shrink scope.
  const inventory = sourceInventory(root);
  const selection = boundedSelection(root);
  fs.mkdirSync(path.join(root, 'coverage'), { recursive: true });
  for (const name of ['lcov.info', 'coverage-summary.json', 'coverage-final.json', 'measurement.json']) {
    fs.rmSync(path.join(root, 'coverage', name), { force: true });
  }
  let failure;
  try {
    await runBounded(process.execPath, [path.join(root, 'node_modules/c8/bin/c8.js'), '--config', '.c8rc.json',
      process.execPath, 'scripts/coverage.mjs', '--tests'], { timeout: 240_000, env: { ...process.env, PAIRCOACH_COVERAGE_OWNED_GROUP: '1' } });
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
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--tests') await tests();
    else if (!args.length) await coverage();
    else throw Error('Usage: node scripts/coverage.mjs [--tests]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
