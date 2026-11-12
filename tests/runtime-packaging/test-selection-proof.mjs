// Portable selection-only proof. Reuses existing platform-native node_modules;
// never installs or executes the repository test campaign.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const testCommand = 'tsx --test "tests/**/*.test.ts" "tests/**/*.test.mjs"';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function proveSelection({ source, evidence, native = false }) {
  source = fs.realpathSync(source);
  evidence = path.resolve(evidence);
  if (native) assert.equal(process.platform, 'win32', 'Native proof requires genuine win32 Node, not WSL');
  assert.equal(fs.existsSync(evidence), false, 'Evidence directory must be NEW; never overwrite a receipt');
  const packageBytes = fs.readFileSync(path.join(source, 'package.json'));
  assert.equal(JSON.parse(packageBytes).scripts.test, testCommand);
  const modules = fs.realpathSync(path.join(source, 'node_modules'));
  const tsxPackage = JSON.parse(fs.readFileSync(path.join(modules, 'tsx/package.json')));
  fs.mkdirSync(evidence); // Existing parent required; evidence and fixture retained even on FAIL.
  const fixture = path.join(evidence, 'selection fixture with spaces');
  fs.mkdirSync(fixture);
  fs.symlinkSync(modules, path.join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const write = (name, bytes) => {
    const dest = path.join(fixture, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, bytes);
  };
  write('package.json', JSON.stringify({ name: 'selection-only', private: true, type: 'module', scripts: { test: testCommand } }, null, 2) + '\n');
  const expected = ['ts', 'mjs'].flatMap(extension => [
    `tests/root.test.${extension}`, `tests/shallow/leaf.test.${extension}`,
    `tests/deep/one/two/leaf.test.${extension}`, `tests/space dir/spaced file.test.${extension}`,
  ]).sort();
  const excluded = [
    'tests/support/helper.ts', 'tests/support/helper.mjs', 'tests/not-a-test.ts',
    'tests/not-a-test.mjs', 'tests/root.test.js', 'examples/shallow/example.test.ts',
    'examples/shallow/example.test.mjs', 'test/outside.test.ts', 'test/outside.test.mjs',
  ].sort();
  for (const name of expected) {
    write(name, `import { test } from 'node:test';\nimport fs from 'node:fs';\n` +
      (name.endsWith('.ts') ? `const selected: string = ${JSON.stringify(name)};\n` : `const selected = ${JSON.stringify(name)};\n`) +
      `test(selected, () => fs.appendFileSync(process.env.PAIRCOACH_SELECTION_LOG, JSON.stringify({ selected, argv: process.argv, platform: process.platform, execPath: process.execPath, lifecycle: process.env.npm_lifecycle_script }) + '\\n'));\n`);
  }
  for (const name of excluded) write(name, "throw Error('EXCLUDED_FILE_EXECUTED');\n");
  const sources = [...expected, ...excluded, 'package.json'].sort().map(name => ({
    path: name, sha256: digest(fs.readFileSync(path.join(fixture, name))),
  }));
  const windows = process.platform === 'win32';
  // Process-local script shell only; no npm config file/global mutation.
  const scriptShell = windows ? process.env.ComSpec || 'cmd.exe' : '/bin/bash';
  const env = { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH,
    npm_config_script_shell: scriptShell, npm_config_update_notifier: 'false',
    npm_config_audit: 'false', npm_config_fund: 'false',
    PAIRCOACH_SELECTION_LOG: path.join(evidence, 'selected.jsonl') };
  // This is a separate npm selection fixture, not a recursive node:test worker.
  // Retaining Node's parent-worker marker makes its child runner silently skip files.
  const parentTestContext = env.NODE_TEST_CONTEXT ?? null;
  delete env.NODE_TEST_CONTEXT;
  const calls = [];
  const run = (label, command, args, cwd = fixture) => {
    const started = new Date().toISOString(), begin = performance.now();
    const r = spawnSync(command, args, { cwd, env, encoding: 'utf8', shell: false, maxBuffer: 8 * 1024 * 1024 });
    fs.writeFileSync(path.join(evidence, label + '.stdout'), r.stdout || '');
    fs.writeFileSync(path.join(evidence, label + '.stderr'), r.stderr || '');
    calls.push({ label, started, command, args, cwd, exit: r.status, signal: r.signal,
      error: r.error?.message ?? null, seconds: (performance.now() - begin) / 1000 });
    return r;
  };
  const npm = args => windows ? [scriptShell, ['/d', '/s', '/c', 'npm.cmd ' + args.join(' ')]] : ['npm', args];
  const [versionExe, versionArgs] = npm(['--version']);
  const npmVersion = run('npm-version', versionExe, versionArgs);
  const shellVersion = run('shell-version', scriptShell, windows ? ['/d', '/c', 'ver'] : ['--version']);
  const tsxVersion = run('tsx-version', process.execPath, [path.join(modules, 'tsx/dist/cli.mjs'), '--version']);
  const [exe, args] = npm(['test']);
  const actual = run('npm-test', exe, args);
  const records = fs.existsSync(env.PAIRCOACH_SELECTION_LOG) ? fs.readFileSync(env.PAIRCOACH_SELECTION_LOG, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const selected = records.map(r => r.selected).sort();
  const receipt = {
    utc: new Date().toISOString(), source, packageSHA256: digest(packageBytes), testCommand,
    evidence, fixture, platform: process.platform, arch: process.arch, osRelease: os.release(),
    harnessArgv: process.argv, node: process.version, execPath: process.execPath,
    npm: npmVersion.stdout?.trim(), tsx: tsxVersion.stdout?.trim(), tsxPackageVersion: tsxPackage.version,
    scriptShell, shellVersion: shellVersion.stdout?.trim(), modules, removedParentTestContext: parentTestContext,
    moduleLink: windows ? 'existing native dependency tree via junction' : 'existing dependency tree via symlink',
    calls, expected, excluded, selected, sources,
    excludedExecuted: /EXCLUDED_FILE_EXECUTED/.test((actual.stdout || '') + (actual.stderr || '')),
    status: 'FAIL', boundary: 'Synthetic npm selection ONLY; not production suite/native unless platform win32; no install/build/Docker/host actions',
  };
  const save = () => fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  save(); // Preserve evidence BEFORE asserting success.
  assert.equal(npmVersion.status, 0, npmVersion.stderr || npmVersion.error?.message);
  assert.equal(shellVersion.status, 0, shellVersion.stderr || shellVersion.error?.message);
  assert.equal(tsxVersion.status, 0, tsxVersion.stderr || tsxVersion.error?.message);
  assert.equal(actual.status, 0, actual.stderr || actual.error?.message);
  assert.equal(receipt.excludedExecuted, false);
  assert.deepEqual(selected, expected, 'Every expected TS/MJS sentinel exactly once; no unselected files');
  for (const record of records) {
    assert.equal(record.lifecycle, testCommand); assert.equal(record.platform, process.platform);
    assert.equal(fs.realpathSync(record.execPath), fs.realpathSync(process.execPath));
  }
  receipt.status = 'PASS'; save(); return receipt;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2), native = args.includes('--native');
    const value = key => args[args.indexOf(key) + 1];
    assert.ok(args.includes('--source') && args.includes('--evidence'), 'Use --source <frozen-repo> --evidence <new-directory> [--native]');
    assert.equal(args.length, native ? 5 : 4, 'Unexpected arguments');
    const result = proveSelection({ source: value('--source'), evidence: value('--evidence'), native });
    console.log(JSON.stringify({ status: result.status, selected: result.selected.length, platform: result.platform, evidence: result.evidence }));
  } catch (error) { console.error(error); process.exitCode = 1; }
}
