/** Operator-only, explicit NEW scoped preparation after a retained failure. Not public CLI,
 * not a resume/overwrite/retry facility. Default plan reads only. No cleanup of old resources. */
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { canonicalDirectory, readPrivate, receiptWriter, syncDirectory } from './runtime-files.mjs';
import { buildOperatorPlan } from './runtime-operator.mjs';
import { prepare, validatePrepareRequest, validateProductionRequest, resolvePreparedToolchainIdentity, createDockerClientState, beginDockerCommand, finishDockerCommand } from './runtime-prepare.mjs';
import { prepareLanguageImages } from './runtime-language-prepare.mjs';
import { measuredImageEntry } from './runtime-prepare-cli.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = b => createHash('sha256').update(b).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (ok, why) => { if (!ok) throw new Error(why); };
const json = file => JSON.parse(readPrivate(file, 16 * 1024 * 1024).bytes);
const sha = /^sha256:[a-f0-9]{64}$/;
const remainingIds = ['java-maven-27--java-pattern', 'java-maven-21--spring-counter', 'java-maven-27--spring-counter'];
const previousIds = ['javascript-node--javascript-counter', 'typescript-node--typescript-counter', 'python-3.13--python-calculator', 'java-maven-11--java-pattern', 'java-maven-17--java-pattern', 'java-maven-21--java-pattern'];
const digestFile = (file, limit = 16 * 1024 * 1024) => ({ file, sha256: hash(readPrivate(file, limit).bytes) });
/** Bounded artifact-byte inventory, NOT Run source policy or ACK authority. */
export function artifactInventory(root) {
  canonicalDirectory(root); const files = []; let total = 0, directories = 0;
  const visit = (dir, rel = '', depth = 0) => {
    check(depth <= 64 && ++directories <= 20000, 'Artifact directory bound');
    canonicalDirectory(dir);
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), relative = rel ? rel + '/' + name : name, st = fs.lstatSync(file, { bigint: true });
      check(!st.isSymbolicLink() && (st.isFile() || st.isDirectory()), 'Artifact link/type refused');
      if (st.isDirectory()) visit(file, relative, depth + 1);
      else {
        check(files.length < 20000 && st.size <= 128n * 1024n * 1024n && (total += Number(st.size)) <= 2 * 1024 ** 3, 'Artifact byte/count bound');
        const bytes = readPrivate(file, 128 * 1024 * 1024).bytes;
        files.push({ path: relative, sha256: hash(bytes), bytes: bytes.length });
      }
    }
  }; visit(root); return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export function verifyPreparedReuse(job, engine) {
  validateProductionRequest(validatePrepareRequest(job.request));
  const file = path.join(job.request.outputRoot, 'receipt.json'), receipt = json(file), r = receipt.request;
  check(receipt.status === 'PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION' && equal(r, job.request) && equal(receipt.engine, engine), 'Reuse request/status/engine mismatch');
  const identity = resolvePreparedToolchainIdentity(r);
  check(receipt.toolchainHash === identity.toolchainHash && equal(receipt.dispatcherFiles, identity.dispatcherFiles), 'Reuse installed dispatcher/pins/tool identity mismatch');
  check(equal(artifactInventory(r.project.root).map(({ path, sha256 }) => ({ path, sha256 })), [...r.project.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), 'Reuse original project bytes mismatch');
  const cache = path.join(r.outputRoot, 'cache', r.family, identity.toolchainHash, r.dependencySha256), evidence = receipt.cacheEvidence;
  check(evidence?.root === cache && sha.test(receipt.imageId) && receipt.observedImage?.Id === receipt.imageId, 'Reuse actual cache/image correlation mismatch');
  const tools = readPrivate(path.join(cache, 'tools.json'), 65536), deps = readPrivate(path.join(cache, 'dependencies-prepared.json'), 65536);
  const actual = JSON.parse(tools.bytes), dependency = JSON.parse(deps.bytes);
  check(hash(tools.bytes) === evidence.tools?.sha256 && equal(actual, evidence.tools.actual) && hash(deps.bytes) === evidence.dependencies?.sha256 && equal(dependency, evidence.dependencies.actual), 'Reuse real cache proof changed');
  check(Array.isArray(actual) && r.expectedTools.every(t => actual.some(a => a.name === t.name && a.version === t.version)) && equal(actual, dependency.tools) && dependency.family === r.family && dependency.workingDirectory === r.workingDirectory && dependency.dependencySha256 === r.dependencySha256, 'Reuse actual tool/dependency identity mismatch');
  const lockedImage = measuredImageEntry(job.profile.imageLockKey, r.imageTag, receipt.observedImage, receipt.imageId, actual);
  const container = receipt.container;
  check(container && /^[a-f0-9]{64}$/.test(container.Id) && container.State?.Running === false && container.State.ExitCode === 0 && container.Config?.Image === receipt.imageId && container.Config.Labels?.['paircoach.installation'] === r.installationId && container.Config.Labels?.['paircoach.role'] === 'prepare', 'Reuse collected terminal ownership mismatch');
  check(receipt.commands.some(c => c.exit === 0 && equal(c.argv, ['docker', 'rm', container.Id])), 'Reuse exact-ID cleanup evidence missing');
  return { id: job.id, receipt: digestFile(file), request: r, engine: receipt.engine, toolchainHash: identity.toolchainHash, imageId: receipt.imageId, observedImage: receipt.observedImage,
    lockedImage, collectedContainerId: container.Id, cacheRoot: cache, cacheInventory: artifactInventory(cache) };
}
export function buildRemainderPlan(options) {
  check(options && Object.keys(options).sort().join(',') === 'failureEvidenceDirectory,outputRoot,previousPlanFile,previousPlanSha256,previousRoot', 'Explicit remainder source/root/failure options required');
  for (const k of ['previousRoot', 'outputRoot', 'previousPlanFile', 'failureEvidenceDirectory']) check(path.isAbsolute(options[k]) && path.resolve(options[k]) === options[k] && !/[,\x00-\x1f\x7f]/.test(options[k]), 'Explicit canonical remainder path required');
  canonicalDirectory(options.previousRoot); canonicalDirectory(path.dirname(options.outputRoot));
  try { fs.lstatSync(options.outputRoot); throw new Error('Remainder output already exists; no resume/overwrite'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const rel = path.relative(options.previousRoot, options.outputRoot);
  check(rel.startsWith('..' + path.sep) || path.isAbsolute(rel), 'Remainder output must be separate from previous root');
  const oldBytes = readPrivate(options.previousPlanFile, 4 * 1024 * 1024).bytes;
  check(/^[a-f0-9]{64}$/.test(options.previousPlanSha256) && hash(oldBytes) === options.previousPlanSha256, 'Original frozen plan SHA differs');
  const old = JSON.parse(oldBytes), fresh = buildOperatorPlan(options.outputRoot, 'PREPARE_ONLY');
  check(old.phase === 'PREPARE_ONLY' && old.offlineFixtureContainers === 0 && old.operatorRoot === options.previousRoot && old.jobs.length === 9 && equal(old.operatorEngine, fresh.operatorEngine), 'Original phase/engine/scope differs');
  const sessionFile = path.join(options.previousRoot, 'session/receipt.json'), session = json(sessionFile);
  check(session.status === 'FAILED_RETAIN_AND_RECONCILE' && session.planSha256 === options.previousPlanSha256 && equal(session.engine, fresh.operatorEngine), 'Original terminal failure not evidenced');
  const reuse = previousIds.map(id => { const jobs = old.jobs.filter(j => j.id === id); check(jobs.length === 1, 'Original reuse job missing/duplicated'); return verifyPreparedReuse(jobs[0], fresh.operatorEngine); });
  const stagingRoot = path.join(options.previousRoot, 'stage'), stagingInventory = artifactInventory(stagingRoot);
  const originalTools = artifactInventory(old.jobs[0].request.tools.root).map(({ path, sha256 }) => ({ path, sha256 }));
  check(equal(originalTools, old.jobs[0].request.tools.files), 'Original staged tool inventory mismatch');
  const lock = json(path.join(repo, 'runtimes/production-inputs.lock.json')), approvedStage = new Map();
  for (const a of [...lock.artifacts, ...lock.language.artifacts]) {
    const files = a.kind === 'npm' ? a.files.map(f => ({ path: 'tools/node_modules/' + a.name + '/' + f.path, sha256: f.sha256 }))
      : [{ path: a.kind === 'jdt' ? 'language/jdt.tar.gz' : 'wheels/' + a.filename, sha256: a.sha256 }];
    for (const f of files) { check(!approvedStage.has(f.path) || approvedStage.get(f.path) === f.sha256, 'Conflicting staged artifact pin'); approvedStage.set(f.path, f.sha256); }
  }
  check(equal(stagingInventory.map(({ path, sha256 }) => ({ path, sha256 })), [...approvedStage].map(([path, sha256]) => ({ path, sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), 'Original staged public artifact inventory differs from installed hashlock');
  const stagingReceipt = path.join(options.previousRoot, 'download-journal/receipt.json');
  check(json(stagingReceipt).status === 'STAGED_NOT_PREPARED', 'Original asset staging missing');
  const failed = old.jobs.find(j => j.id === remainingIds[0]), failedFile = path.join(failed.request.outputRoot, 'receipt.json'), failure = json(failedFile);
  check(failure.status === 'FAILED_RETAIN_AND_RECONCILE' && equal(failure.request, failed.request) && equal(failure.engine, fresh.operatorEngine) && sha.test(failure.imageId), 'Original Java27 failure correlation differs');
  const mismatchFile = path.join(options.failureEvidenceDirectory, 'tool-mismatch.json'), collectionFile = path.join(options.failureEvidenceDirectory, 'collection-receipt.json');
  const observed = json(mismatchFile);
  check(['java', 'javac'].every(n => observed.actual.some(t => t.name === n && t.version === '27.0.1.0.2') && observed.expected.some(t => t.name === n && t.version === '27.0.1.0')), 'Actual Java27 metadata correction evidence differs');
  const inspectFile = path.join(options.failureEvidenceDirectory, 'inspect-exact.stdout'), terminal = json(inspectFile);
  check(/^[a-f0-9]{64}$/.test(terminal.Id) && terminal.State?.Running === false && terminal.State.ExitCode === 1 && terminal.State.OOMKilled === false && terminal.ConfigImage === failure.imageId && terminal.Labels?.['paircoach.installation'] === failed.request.installationId && terminal.Labels?.['paircoach.role'] === 'prepare', 'Failed exact terminal identity unconfirmed');
  const jobs = remainingIds.map(id => { const job = fresh.jobs.find(j => j.id === id); check(job, 'Remainder job missing'); return job; });
  return { schemaVersion: 1, phase: 'PREPARE_ONLY_REMAINDER_AFTER_REVIEWED_FAILURE', scope: 'REUSE6_READONLY_PREPARE3_LANGUAGE2_NO_OFFLINE_OR_PRODUCT_ACCEPTANCE',
    options, maxHeavyConcurrency: 1, maxElapsedMs: 2700000, maxCommandMs: 480000, offlineFixtureContainers: 0, engine: fresh.operatorEngine,
    sourceInventory: fresh.sourceInventory, reuse, staging: { root: stagingRoot, receipt: digestFile(stagingReceipt), files: stagingInventory }, jobs,
    failure: { receipt: digestFile(failedFile), mismatch: digestFile(mismatchFile), collection: digestFile(collectionFile), inspect: digestFile(inspectFile), exactContainerId: terminal.Id, expectedImageId: failure.imageId,
      cleanup: 'SEPARATE_EXPLICIT_K_ROOT_REVIEW_REQUIRED_NOT_AUTHORIZED_BY_THIS_PLAN', requiredBeforeExecute: 'FRESH_EXACT_ID_INSPECT_NO_SUCH_CONTAINER' },
    languageKinds: ['java', 'python'] };
}
function make(dir, mode = 0o700) { canonicalDirectory(path.dirname(dir)); fs.mkdirSync(dir, { mode }); canonicalDirectory(dir); }
function put(file, bytes, mode = 0o600) {
  canonicalDirectory(path.dirname(file)); const fd = fs.openSync(file, 'wx', mode);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } syncDirectory(path.dirname(file));
}
function materialize(root, entries) {
  make(root, 0o755);
  for (const f of entries) {
    let dir = root;
    for (const part of f.path.split('/').slice(0, -1)) { dir = path.join(dir, part); try { make(dir, 0o755); } catch (e) { if (e.code !== 'EEXIST') throw e; canonicalDirectory(dir); } }
    const bytes = Buffer.from(f.bytes, 'base64'); check(hash(bytes) === f.sha256, 'Remainder planned asset mismatch'); put(path.join(root, f.path), bytes, 0o644);
  }
}
/** NOT called in developer checks. Requires independent K admission + separate ROOT exact-failure
 * collection/cleanup. Injected calls in tests are UNIT, never acquisition proof. */
export function executeRemainderPlan(plan, dependencies = {}) {
  check(equal((dependencies.buildPlan ?? buildRemainderPlan)(plan.options), plan), 'Frozen remainder/source/prior evidence differs');
  const root = plan.options.outputRoot, deadline = Date.now() + plan.maxElapsedMs;
  const publish = receiptWriter(root), receipt = { schemaVersion: 1, phase: plan.phase, status: 'STARTED_NOT_READY', planSha256: hash(JSON.stringify(plan, null, 2) + '\n'), commands: [], reused: plan.reuse.map(r => ({ id: r.id, receipt: r.receipt, cacheRoot: r.cacheRoot })), jobs: [], engine: plan.engine };
  let clientState;
  let publicationFailed = false;
  const save = () => { try { publish(receipt); } catch (e) { publicationFailed = true; throw e; } }; save();
  const endpoint = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock', configDirectory = path.join(root, 'docker-config');
  const invoke = (args, absent = false) => {
    check(Date.now() < deadline, 'Remainder budget exceeded; retain/reconcile');
    check(plan.sourceInventory.every(f => hash(readPrivate(path.join(repo, f.path), 4 * 1024 * 1024).bytes) === f.sha256), 'Frozen remainder source changed; retain/reconcile');
    const issued = beginDockerCommand(clientState), env = issued.env;
    const argv = ['--host', endpoint, '--config', issued.configDirectory, ...args], start = new Date().toISOString();
    const raw = (dependencies.spawnSync ?? spawnSync)('docker', argv, { shell: false, env, encoding: 'utf8', timeout: Math.max(1, Math.min(plan.maxCommandMs, deadline - Date.now())), maxBuffer: 4 * 1024 * 1024 });
    receipt.commands.push({ argv: ['docker', ...argv], startedAt: start, finishedAt: new Date().toISOString(), exit: raw.status, signal: raw.signal, error: raw.error?.message ?? null, stdout: raw.stdout, stderr: raw.stderr }); save();
    finishDockerCommand(clientState, issued);
    check(!raw.error && !raw.signal && (absent ? raw.status === 1 && /No such (?:object|container)/i.test(raw.stderr) : raw.status === 0), 'Docker operation unknown/failed or old failed resource still exists; retain/reconcile'); return raw;
  };
  const engineArgs = ['info', '--format', '{"ID":{{json .ID}},"ServerVersion":{{json .ServerVersion}},"OSType":{{json .OSType}},"Architecture":{{json .Architecture}}}'];
  const run = args => { check(equal(JSON.parse(invoke(engineArgs).stdout), plan.engine), 'Remainder engine changed'); return invoke(args); };
  try {
    clientState = createDockerClientState(root); receipt.clientState = clientState; save();
    check(equal(JSON.parse(invoke(engineArgs).stdout), plan.engine), 'Remainder engine changed before mutation');
    invoke(['container', 'inspect', plan.failure.exactContainerId], true); // NO rm/force/prune/cleanup authority here.
    // Reused image existence/config AND manifest proof are re-inspected; cache bytes stay read-only.
    // JSON object key order is not identity; exact fields/types and array order still are.
    for (const reused of plan.reuse) {
      const values = JSON.parse(run(['image', 'inspect', reused.imageId]).stdout);
      check(values.length === 1 && values[0].Id === reused.imageId && values[0].Config?.User === '10001:10001' && !values[0].Config.Entrypoint?.length && isDeepStrictEqual({ Id: values[0].Id, Descriptor: values[0].Descriptor ?? null, RepoDigests: values[0].RepoDigests ?? [] }, reused.observedImage), 'Reused image identity/manifest changed');
    }
    make(path.join(root, 'stage'));
    // Reuse frozen public downloaded bytes, not a second network acquisition.
    for (const file of plan.staging.files) {
      let dir = path.join(root, 'stage');
      for (const part of file.path.split('/').slice(0, -1)) { dir = path.join(dir, part); try { make(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; canonicalDirectory(dir); } }
      const bytes = readPrivate(path.join(plan.staging.root, file.path), 128 * 1024 * 1024).bytes; check(hash(bytes) === file.sha256, 'Staging changed'); put(path.join(root, 'stage', file.path), bytes);
    }
    for (const sub of ['projects', 'jobs', 'requests']) make(path.join(root, sub));
    for (const job of plan.jobs) {
      materialize(job.request.project.root, job.assets);
      put(path.join(root, 'requests', job.id + '.json'), Buffer.from(JSON.stringify(job.request, null, 2) + '\n'));
      const item = { id: job.id, status: 'PREPARE_INTENT' }; receipt.jobs.push(item); save();
      const prepared = (dependencies.prepare ?? prepare)(job.request, true, deadline, plan.engine, { endpoint, configDirectory, clientState, ...(dependencies.spawnSync ? { spawnSync: dependencies.spawnSync } : {}) });
      check(prepared.status === 'PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION' && equal(prepared.request, job.request) && equal(prepared.engine, plan.engine) && prepared.toolchainHash === resolvePreparedToolchainIdentity(job.request).toolchainHash, 'Remainder prepared correlation differs');
      check(equal(json(path.join(job.request.outputRoot, 'receipt.json')), prepared), 'New durable prepared receipt differs');
      item.prepareReceipt = path.join(job.request.outputRoot, 'receipt.json'); item.status = 'PREPARED_TOOLS_CHECKED_OFFLINE_DEFERRED'; save();
    }
    (dependencies.prepareLanguageImages ?? prepareLanguageImages)(root, json(path.join(repo, 'runtimes/production-inputs.lock.json')), { run, save, receipt }, plan.languageKinds);
    // Every prior receipt/cache byte is re-proven after new preparation; never rewrite old evidence.
    const old = json(plan.options.previousPlanFile);
    const reusedAfter = previousIds.map(id => verifyPreparedReuse(old.jobs.find(j => j.id === id), plan.engine));
    check(equal(reusedAfter, plan.reuse), 'Prior reuse evidence/cache bytes changed during remainder');
    receipt.status = 'REMAINDER_PREPARE_ONLY_COMPLETE_OFFLINE_DEFERRED_NOT_PRODUCT_ACCEPTANCE'; save(); return receipt;
  } catch (e) { receipt.status = 'FAILED_RETAIN_AND_RECONCILE'; receipt.error = e.message; if (!publicationFailed) save(); throw e; }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const [mode, file, expected] = process.argv.slice(2); check(process.argv.length === (mode === 'plan' ? 4 : 5), 'Usage: runtime-operator-remainder.mjs plan OPTIONS.json | execute PLAN.json SHA256');
    if (mode === 'plan') process.stdout.write(JSON.stringify(buildRemainderPlan(json(path.resolve(file))), null, 2) + '\n');
    else { const bytes = readPrivate(path.resolve(file), 4 * 1024 * 1024).bytes; check(mode === 'execute' && /^[a-f0-9]{64}$/.test(expected ?? '') && hash(bytes) === expected, 'Explicit frozen remainder hash required'); executeRemainderPlan(JSON.parse(bytes)); }
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
