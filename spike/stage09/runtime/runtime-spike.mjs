/** Additive A–B probe ONLY; never used by product Runner. No third-party deps. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, lstatSync, realpathSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

export const WORK = 'paircoach-seq09-ab-runtime';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const markerName = 'Zażółć space 😀.txt';
export const marker = 'PAIRCOACH_MAPPING_ąć_😀\r\n';
export function validateLock(lock) {
  assert.equal(lock.schemaVersion, 1); assert.equal(lock.platform, 'linux/amd64');
  assert.deepEqual(lock.profiles.map(p => p.id), ['java21', 'java27', 'python313']);
  for (const [i, p] of lock.profiles.entries()) {
    const repo = i < 2 ? 'eclipse-temurin' : 'python';
    assert.match(p.ref, new RegExp('^' + repo + '@sha256:[0-9a-f]{64}$'));
    assert.equal(p.repository, repo);
    assert.equal(p.expectedVersion, [21, 27, '3.13'][i]);
  }
  return lock;
}
export function inputFiles(id) {
  if (id === 'python313') return {
    [markerName]: marker,
    'main.py': `import sys,pathlib\nassert sys.version_info[:2] == (3,13), sys.version\nassert pathlib.Path('/input/${markerName}').read_bytes() == ${JSON.stringify(marker)}.encode('utf-8')\nprint('PYTHON_OK',sys.version)\npathlib.Path('/out/result.txt').write_text('PYTHON_OK')\n`,
  };
  const version = id === 'java21' ? 21 : 27;
  // SequencedCollection is since21. ScopedValue is final since25: release21 MUST reject it.
  const feature = version === 21 ? 'java.util.SequencedCollection<String> xs = java.util.List.of("JAVA_OK"); String value = xs.getFirst();' :
    'ScopedValue<String> key = ScopedValue.newInstance(); String value = ScopedValue.where(key,"JAVA_OK").call(() -> key.get());';
  return {
    [markerName]: marker,
    'Main.java': `import java.nio.file.*;\npublic class Main { public static void main(String[] args) throws Exception {\nif(Runtime.version().feature()!=${version}) throw new AssertionError(Runtime.version());\nString text=Files.readString(Path.of("/input/${markerName}"));\nif(!text.equals(${JSON.stringify(marker)})) throw new AssertionError("MAPPING");\n${feature}\nSystem.out.println(value+" RELEASE_${version}");\nFiles.writeString(Path.of("/out/result.txt"),value);\n} }\n`,
  };
}
export function commandFor(id) {
  if (id === 'python313') return ['python3', '-B', '/input/main.py'];
  const release = id === 'java21' ? 21 : 27, older = release === 21 ? 17 : 21;
  return ['sh', '-eu', '-c', `java -version; javac -version; echo EFFECTIVE_RELEASE=${release}; ` +
    `mkdir /out/negative; if javac -encoding UTF-8 --release ${older} -d /out/negative /input/Main.java > /out/negative.txt 2>&1; then echo UNEXPECTED_OLD_RELEASE_SUCCESS; exit 31; fi; ` +
    `test -s /out/negative.txt; javac -encoding UTF-8 --release ${release} -d /out /input/Main.java; ` +
    'java -cp /out Main'];
}
export function createArgs({ name, nonce, imageId, input, output, command }) {
  assert.match(name, /^paircoach-spike-p1-runtime-[a-f0-9-]+-(java21|java27|python313|control|stop)$/);
  assert.match(nonce, /^[a-f0-9-]{36}$/); assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  for (const p of [input, output]) assert(!/[\0\r\n,]/u.test(p), 'Unsafe mount path');
  return ['create', '--name', name, '--label', `paircoach.work=${WORK}`, '--label', `paircoach.nonce=${nonce}`,
    '--platform', 'linux/amd64', '--pull=never', '--user', '10001:10001', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=512m', '--memory-swap=512m',
    '--cpus=1', '--pids-limit=96', '--network=none', '--log-driver=json-file',
    '--log-opt=max-size=10m', '--log-opt=max-file=1', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,mode=1777',
    '--mount', `type=bind,src=${input},dst=/input,readonly`, '--mount', `type=bind,src=${output},dst=/out`,
    '--workdir=/out', '--env', 'HOME=/tmp', '--env', 'PYTHONDONTWRITEBYTECODE=1', '--entrypoint', command[0], imageId, ...command.slice(1)];
}
export function assertOwned(info, rec, nonce) {
  assert.equal(info.Id, rec.id); assert.equal(info.Name, '/' + rec.name);
  assert.equal(info.Config.Labels['paircoach.work'], WORK);
  assert.equal(info.Config.Labels['paircoach.nonce'], nonce);
  assert.equal(info.Image, rec.imageId);
}
export function assertStopped(info) {
  assert.equal(info.State.Running, false, 'PROCESS_STOP_UNCONFIRMED');
  assert(['exited', 'dead'].includes(info.State.Status), 'PROCESS_STOP_UNCONFIRMED');
}
export function snapshot(dir) {
  const result = {};
  function walk(root, prefix = '') {
    for (const name of readdirSync(root).sort()) {
      const file = path.join(root, name), rel = prefix + name, st = lstatSync(file);
      assert(!st.isSymbolicLink(), 'No symlinks');
      if (st.isDirectory()) { walk(file, rel + '/'); continue; }
      assert(st.isFile() && st.size <= 1024 * 1024 && Object.keys(result).length < 32, 'Bounded evidence');
      result[rel] = { size: st.size, sha256: hash(readFileSync(file)) };
    }
  }
  walk(dir); return result;
}
function save(file, data) {
  writeFileSync(file + '.tmp', JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(file + '.tmp', file);
}
export function execute(mode, output) {
  assert(['prepare', 'run', 'cleanup'].includes(mode));
  assert(path.isAbsolute(output), 'Use absolute output path');
  const lock = validateLock(JSON.parse(readFileSync(path.join(HERE, 'images.lock.json'))));
  let state;
  if (mode !== 'cleanup') {
    mkdirSync(output, { mode: 0o700 }); // exclusive new evidence directory, never overwrite
    state = { schemaVersion: 1, mode, work: WORK, nonce: randomUUID(), startedAt: new Date().toISOString(),
      environment: { platform: process.platform, arch: process.arch, node: process.version },
      lockSha256: hash(readFileSync(path.join(HERE, 'images.lock.json'))), status: 'RUNNING', commands: [], containers: [], images: {} };
  } else {
    state = JSON.parse(readFileSync(path.join(output, 'evidence.json')));
    assert.equal(state.work, WORK); assert.match(state.nonce, /^[a-f0-9-]{36}$/);
  }
  output = realpathSync(output);
  const persist = () => save(path.join(output, 'evidence.json'), state);
  function docker(args, timeout = 15000, allowFailure = false) {
    const startedAt = new Date().toISOString(), start = performance.now();
    const r = spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, windowsHide: true, shell: false });
    const index = state.commands.length;
    const rec = { argv: ['docker', ...args], cwd: process.cwd(), startedAt, wallMs: performance.now() - start,
      exit: r.status, signal: r.signal, error: r.error?.message ?? null, timeoutMs: timeout,
      stdout: `${index}.stdout.txt`, stderr: `${index}.stderr.txt` };
    writeFileSync(path.join(output, rec.stdout), r.stdout ?? ''); writeFileSync(path.join(output, rec.stderr), r.stderr ?? '');
    state.commands.push(rec); persist();
    if (!allowFailure) assert(!r.error && r.status === 0, `Docker operation failed: ${args[0]} (raw ${index})`);
    return r;
  }
  function inspect(rec) {
    const info = JSON.parse(docker(['inspect', rec.id ?? rec.name]).stdout)[0];
    if (rec.id === null) { rec.id = info.Id; persist(); }
    assertOwned(info, rec, state.nonce); return info;
  }
  function collect(rec) {
    const info = inspect(rec); assertStopped(info);
    docker(['logs', '--timestamps', rec.id]);
    rec.terminal = info.State; rec.finalInspect = info;
    rec.artifacts = snapshot(rec.output);
    rec.artifactsCollected = true; rec.stateDurableAt = new Date().toISOString(); persist();
  }
  function remove(rec) {
    const info = inspect(rec); assertStopped(info);
    assert(rec.artifactsCollected && rec.stateDurableAt, 'Collect and persist BEFORE rm');
    docker(['rm', rec.id]); rec.removed = true; persist();
  }
  function stop(rec) {
    const info = inspect(rec);
    if (info.State.Running) docker(['stop', '--time=2', rec.id], 10000);
    // An exited CLI is never confirmation of stopped container.
    rec.confirmedStop = inspect(rec); assertStopped(rec.confirmedStop); persist();
  }
  try {
    persist();
    const version = JSON.parse(docker(['version', '--format', '{{json .}}']).stdout);
    state.dockerVersion = version;
    const info = JSON.parse(docker(['info', '--format', '{{json .}}']).stdout);
    assert.equal(info.OSType, 'linux'); assert(['x86_64', 'amd64'].includes(info.Architecture));
    state.engine = { id: info.ID, os: info.OSType, architecture: info.Architecture, name: info.Name };
    if (mode === 'cleanup') {
      // Only exact journal IDs+name+image+two labels. No list/prune/rm -f; leave unknown state for operator.
      for (const rec of state.containers.filter(c => !c.removed)) {
        stop(rec); collect(rec); remove(rec);
      }
      state.cleanupStatus = 'OWNED_ONLY_COLLECTED_AND_REMOVED'; persist(); return state;
    }
    for (const p of lock.profiles) {
      if (mode === 'prepare') docker(['pull', '--platform=linux/amd64', p.ref], 180000);
      const image = JSON.parse(docker(['image', 'inspect', p.ref]).stdout)[0];
      assert.match(image.Id, /^sha256:[a-f0-9]{64}$/); assert.equal(image.Os, 'linux'); assert.equal(image.Architecture, 'amd64');
      state.images[p.id] = { ref: p.ref, imageId: image.Id, repoDigests: image.RepoDigests, inspect: image };
      persist();
    }
    if (mode === 'prepare') { state.status = 'PREPARED_IMAGES_ONLY'; persist(); return state; }
    function create(id, imageKey, files, command) {
      const base = path.join(output, id); mkdirSync(base);
      const input = path.join(base, 'input'), out = path.join(base, 'output');
      mkdirSync(input, { mode: 0o755 }); mkdirSync(out, { mode: 0o700 }); chmodSync(out, 0o777);
      // umask may remove output write bits; only generated per-run out gets 0777.
      // Parent evidence directory is private; never chmod source workspace.
      for (const [file, data] of Object.entries(files)) writeFileSync(path.join(input, file), data, { mode: 0o444 });
      const name = `paircoach-spike-p1-runtime-${state.nonce}-${id}`, imageId = state.images[imageKey].imageId;
      const rec = { name, id: null, imageId, input, output: out, inputBefore: snapshot(input), removed: false };
      state.containers.push(rec); persist(); // intent precedes create: unknown result MUST be reconciled by exact name
      const created = docker(createArgs({ name, nonce: state.nonce, imageId, input, output: out, command }));
      rec.id = created.stdout.trim(); assert.match(rec.id, /^[a-f0-9]{64}$/); persist();
      const checked = inspect(rec); rec.initialInspect = checked;
      assert.equal(checked.HostConfig.Privileged, false); assert.equal(checked.Config.User, '10001:10001');
      assert.equal(checked.HostConfig.NetworkMode, 'none');
      assert.equal(checked.Mounts.find(m => m.Destination === '/input')?.RW, false);
      docker(['start', rec.id]); return rec;
    }
    {
      for (const p of lock.profiles) {
        const rec = create(p.id, p.id, inputFiles(p.id), commandFor(p.id));
        const waited = docker(['wait', rec.id], 45000);
        assert.equal(waited.stdout.trim(), '0', `Compile/run failed: ${p.id}`);
        collect(rec);
        assert.equal(readFileSync(path.join(rec.output, 'result.txt'), 'utf8'), p.id === 'python313' ? 'PYTHON_OK' : 'JAVA_OK');
        if (p.id !== 'python313') {
          const bytes = readFileSync(path.join(rec.output, 'Main.class'));
          assert.equal(bytes.readUInt32BE(0), 0xcafebabe);
          assert.equal(bytes.readUInt16BE(6), p.expectedVersion + 44);
          rec.classMajor = bytes.readUInt16BE(6); rec.effectiveRelease = p.expectedVersion;
        }
        assert.deepEqual(snapshot(rec.input), rec.inputBefore, 'Input must remain unchanged');
        rec.mapping = { localPath: rec.input, containerPath: '/input', filename: markerName, sha256: hash(Buffer.from(marker)) };
        rec.result = 'PASS'; persist(); remove(rec);
      }
      const loop = ['python3', '-u', '-c', 'import time,signal,pathlib; signal.signal(signal.SIGTERM,signal.SIG_IGN); pathlib.Path("/out/ready").write_text("READY"); print("LOOP_READY",flush=True);\nwhile True: time.sleep(0.1)'];
      function ready(rec) {
        const deadline = Date.now() + 5000;
        while (!existsSync(path.join(rec.output, 'ready')) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        assert.equal(readFileSync(path.join(rec.output, 'ready'), 'utf8'), 'READY');
      }
      const control = create('control', 'python313', { [markerName]: marker }, loop);
      ready(control);
      const controlBefore = inspect(control); assert.equal(controlBefore.State.Running, true);
      const target = create('stop', 'python313', { [markerName]: marker }, loop);
      ready(target);
      assert.equal(inspect(target).State.Running, true);
      stop(target); assert.equal(target.confirmedStop.State.ExitCode, 137, 'Ignored SIGTERM must reach SIGKILL'); collect(target); remove(target);
      const controlAfter = inspect(control); assert.equal(controlAfter.State.Running, true);
      assert.equal(controlAfter.State.StartedAt, controlBefore.State.StartedAt);
      state.stopProof = { targetId: target.id, targetStopped: true, controlId: control.id,
        controlStartedAtBefore: controlBefore.State.StartedAt, controlStartedAtAfter: controlAfter.State.StartedAt,
        controlRunningAfterTargetStop: true, controlBefore, controlAfter };
      persist();
      // Control is owned by THIS probe; stop it only AFTER preservation proof has been persisted.
      stop(control); collect(control); remove(control);
    }
    state.status = 'PASS_AB_RUNTIME_SPIKE_ONLY'; state.finishedAt = new Date().toISOString(); persist(); return state;
  } catch (error) {
    state.status = 'FAIL_OR_BLOCKED'; state.error = String(error); state.finishedAt = new Date().toISOString(); persist();
    // One bounded reconciliation/stop attempt for exact owned resources, never rm on uncertain state.
    // No automatic retry of the failed compile/pull/start hypothesis.
    if (mode === 'run') for (const rec of state.containers.filter(c => !c.removed)) {
      try { stop(rec); collect(rec); remove(rec); }
      catch (cleanupError) { rec.cleanupError = String(cleanupError); persist(); }
    }
    throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, output, ...extra] = process.argv.slice(2);
  try {
    assert(extra.length === 0 && output, 'Usage: node runtime-spike.mjs prepare|run|cleanup ABS_NEW_OUTPUT');
    execute(mode, output);
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
