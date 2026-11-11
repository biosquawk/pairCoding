/** Explicit public preparation. Plan is read-only. Neither this plan nor generated selectors
 * grant WriteGate/ACK, Docker readiness, offline, LSP, native or final acceptance authority. */
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { canonicalDirectory, readPrivate, receiptWriter, stamp, syncDirectory } from './runtime-files.mjs';
import { dependencyHash } from './runtime-dependencies.mjs';
import { validatePrepareRequest, validateProductionRequest, resolvePreparedToolchainIdentity, prepare } from './runtime-prepare.mjs';
import { stageInputs } from './runtime-stage-inputs.mjs';
import { prepareLanguageImages } from './runtime-language-prepare.mjs';

const installed = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (ok, why) => { if (!ok) throw new Error(why); };
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const json = file => JSON.parse(decode(readPrivate(file, 4 * 1024 * 1024).bytes));
const sha = /^sha256:[a-f0-9]{64}$/;
const within = (a, b) => { const r = path.relative(a, b); return r === '' || r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
let acceptedPromise;
async function accepted() {
  // Installed dependency ONLY: no npx/download/child process/Node loader install fallback.
  return acceptedPromise ??= (async () => {
    // Node >=22.22 in-memory TS transform: tsx's file cache writes even on a plan.
    // Hook only this installed src tree, only for these unchanged accepted modules.
    // No TSX_DISABLE_CACHE/env mutation, temp cache, subprocess or emitted files.
    const sourceRoot = pathToFileURL(path.join(installed, 'src') + path.sep).href;
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.')) {
          const base = fileURLToPath(new URL(specifier, context.parentURL));
          for (const candidate of [base + '.ts', path.join(base, 'index.ts')]) {
            if (fs.existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context);
          }
        }
        return nextResolve(specifier, context);
      },
      load(url, context, nextLoad) {
        if (url.startsWith(sourceRoot) && url.endsWith('.json')) return { format: 'module', shortCircuit: true,
          source: 'export default JSON.parse(' + JSON.stringify(decode(readPrivate(fileURLToPath(url), 4 * 1024 * 1024).bytes)) + ');' };
        if (url.startsWith(sourceRoot) && url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
          source: stripTypeScriptTypes(decode(readPrivate(fileURLToPath(url), 4 * 1024 * 1024).bytes), { mode: 'transform', sourceUrl: url }) };
        return nextLoad(url, context);
      },
    });
    let validation, inventory, adapters, config, xml, pom;
    try {
      [validation, inventory, adapters, config, xml, pom] = await Promise.all([
        import('../src/shared/validation-v2.ts'), import('../src/server/execution/ImmutableInput.ts'),
        import('../src/server/runtime-adapters/index.ts'), import('../src/server/runtime-config/index.ts'),
        import('fast-xml-parser'), import('./runtime-pom.mjs'),
      ]);
    } finally { hooks.deregister(); }
    return { ...validation, ...inventory, ...adapters, ...config, ...xml, ...pom };
  })();
}

export function parseArguments(argv) {
  const result = { execute: false };
  check(Array.isArray(argv) && argv.length <= 7, 'Usage: runtime:prepare --project ABS --profile catalogId --output NEW_ABS [--execute]');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--execute') { check(!result.execute, 'Duplicate --execute'); result.execute = true; continue; }
    check(['--project', '--profile', '--output'].includes(arg), 'Unknown prepare flag; only --project --profile --output [--execute] are supported');
    const key = arg.slice(2), value = argv[++i];
    check(!Object.hasOwn(result, key) && typeof value === 'string' && value.length > 0 && !value.startsWith('--'), 'Missing/duplicate prepare flag');
    result[key] = value;
  }
  check(typeof result.project === 'string' && typeof result.profile === 'string' && typeof result.output === 'string', 'Explicit --project --profile --output are required');
  check(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(result.profile), 'Invalid catalog profile ID');
  for (const key of ['project', 'output']) {
    const value = result[key];
    check(value.length <= 4096 && path.isAbsolute(value) && path.resolve(value) === value && !/[,\x00-\x1f\x7f]/.test(value), 'Project/output must be canonical absolute paths without control characters/commas');
  }
  return result;
}
function locations(args) {
  const project = canonicalDirectory(args.project), output = args.output;
  check(project !== path.parse(project).root && project !== process.env.HOME && project !== process.env.USERPROFILE, 'Project root/home is not an allowed preparation input');
  canonicalDirectory(path.dirname(output));
  try { fs.lstatSync(output); throw new Error('Output already exists: retain/reconcile its receipts; no retry, resume or overwrite'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  check(!within(project, output) && !within(output, project) && !within(installed, output) && !within(output, installed), 'Output must be separate from the project and installed package');
  const parent = fs.lstatSync(path.dirname(output), { bigint: true });
  check(process.platform === 'win32' || (parent.mode & 0o077n) === 0n, 'Output needs a private parent (POSIX 0700; Windows trusts inherited private-parent ACLs)');
  return { project, output, parentIdentity: [parent.dev, parent.ino].join(':') };
}
function settingsSnapshot(project) {
  const file = path.join(project, '.paircoach/settings.json');
  let read;
  try { read = readPrivate(file, 4 * 1024 * 1024); }
  catch { throw new Error('Save full V2 settings explicitly at <project>/.paircoach/settings.json first. Legacy/task fragments/custom dataDir discovery are not supported; original bytes are preserved.'); }
  return { file, sha256: hash(read.bytes), identity: stamp(read.stat), value: JSON.parse(decode(read.bytes)) };
}
async function sourceSnapshot(project, api) {
  const inventory = await api.readRunSourceInventory(project);
  check(inventory.length > 0, 'No approved current raw source files');
  return inventory.map(f => {
    const read = readPrivate(path.join(project, f.path), 4 * 1024 * 1024);
    check(read.bytes.length === f.bytes && hash(read.bytes) === f.sha256, 'Current raw source changed during inventory');
    return { ...f, identity: stamp(read.stat) };
  });
}
function sourceBytes(plan, relative) {
  const entry = plan.sourceInventory.find(f => f.path === relative);
  check(entry, 'Selected source/config missing from current raw inventory: ' + relative);
  const read = readPrivate(path.join(plan.project, relative), 4 * 1024 * 1024);
  check(hash(read.bytes) === entry.sha256 && stamp(read.stat) === entry.identity, 'Selected source/config changed');
  return read.bytes;
}
function validateSourcePom(bytes, profile, api) {
  const xml = decode(bytes);
  check(!/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml) && api.XMLValidator.validate(xml) === true, 'Invalid/unsafe selected source POM');
  const p = new api.XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: false }).parse(xml).project;
  check(p && !p.modules && !p.profiles, 'Select a single explicit Maven module without conditional profiles; effective POM is independently verified after acquisition');
  const props = p.properties ?? {}, list = v => v === undefined ? [] : Array.isArray(v) ? v : [v];
  const expand = (s, depth = 0) => {
    check(depth < 16 && typeof s === 'string', 'Explicit local POM compiler release/preview required; no parent/network inference in plan');
    return s.replace(/\$\{([^}]+)\}/g, (_, k) => { check(Object.hasOwn(props, k), 'Unresolved source POM property'); return expand(props[k], depth + 1); });
  };
  const plugins = list(p.build?.plugins?.plugin).concat(list(p.build?.pluginManagement?.plugins?.plugin));
  check(!plugins.some(v => v.artifactId === 'maven-toolchains-plugin'), 'Alternate Maven toolchain prohibited');
  const compiler = plugins.filter(v => v.artifactId === 'maven-compiler-plugin');
  const configs = compiler.flatMap(v => [v.configuration ?? {}, ...list(v.executions?.execution).map(e => e.configuration ?? {})]);
  const releases = [props['maven.compiler.release'], props['maven.compiler.testRelease'], ...configs.flatMap(c => [c.release, c.testRelease])].filter(v => v !== undefined);
  check(releases.length && releases.every(v => expand(v) === String(profile.compilerRelease)), 'TARGET_PROFILE_CONFLICT: explicit source POM release differs or is absent');
  for (const v of [props['java.version'], ...['source', 'target', 'testSource', 'testTarget'].flatMap(k => [props['maven.compiler.' + k], ...configs.map(c => c[k])])].filter(v => v !== undefined)) {
    check(expand(v) === String(profile.compilerRelease), 'TARGET_PROFILE_CONFLICT: source POM source/target differs');
  }
  for (const c of [props, ...configs]) {
    check(!c.executable && !c.jdkToolchain && c.fork !== 'true' && !c['maven.compiler.executable'] && c['maven.compiler.fork'] !== 'true' && !c.compilerArgs && !c.compilerArgument && (!c.compilerId || c.compilerId === 'javac') && (!c['maven.compiler.compilerId'] || c['maven.compiler.compilerId'] === 'javac'), 'Unreviewed compiler/toolchain override');
  }
  const previews = [props['maven.compiler.enablePreview'], ...configs.map(c => c.enablePreview)].filter(v => v !== undefined);
  check((previews.length ? previews : ['false']).every(v => expand(v) === String(profile.analysis.preview)), 'TARGET_PROFILE_CONFLICT: source POM preview differs');
  return 'SOURCE_CHECKED_EFFECTIVE_POM_PENDING_ACQUISITION';
}
async function validateTaskSources(plan, api) {
  const profile = plan.profile, adapter = api.createTaskRuntimeAdapterRegistry().get(profile);
  const prefix = p => plan.workingDirectory === '.' ? p : plan.workingDirectory + '/' + p;
  const files = new Set(plan.sourceInventory.map(f => f.path));
  for (const run of plan.settings.runProfiles) {
    const validated = await adapter.validate(profile, run);
    check(api.validateTaskForProfile(profile, run) && validated.valid, 'Task/profile conflict: ' + (validated.problem?.message ?? run.kind));
    const task = run.task;
    for (const rel of [...task.tests.paths, ...(task.entry.kind === 'SCRIPT' ? [task.entry.path] : [])]) check(files.has(prefix(rel)), 'Selected source absent: ' + prefix(rel));
    if (task.entry.kind === 'MODULE') check(files.has(prefix(task.entry.name.replaceAll('.', '/') + '.py')) || files.has(prefix(task.entry.name.replaceAll('.', '/') + '/__init__.py')), 'Selected Python module absent');
    if (task.entry.kind === 'JAVA_MAIN') check([...files].some(p => p.startsWith(plan.workingDirectory === '.' ? '' : plan.workingDirectory + '/') && (p === prefix(task.entry.className.replaceAll('.', '/') + '.java') || p.endsWith('/' + task.entry.className.replaceAll('.', '/') + '.java'))), 'Selected Java main source absent');
  }
  if (profile.adapterFamily === 'java-maven') plan.pom = validateSourcePom(sourceBytes(plan, prefix('pom.xml')), profile, api);
  if (['node', 'typescript'].includes(profile.adapterFamily)) {
    const pkg = JSON.parse(decode(sourceBytes(plan, prefix('package.json'))));
    check(pkg && typeof pkg === 'object' && !Array.isArray(pkg), 'Invalid selected package.json');
    if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.devDependencies ?? {}).length) check(files.has(prefix('package-lock.json')), 'Explicit package-lock.json required for dependencies');
    if (profile.adapterFamily === 'typescript') sourceBytes(plan, prefix('tsconfig.json'));
  }
  if (profile.adapterFamily === 'python') check(/^[A-Za-z0-9_.-]+==[^\s]+.*--hash=sha256:/m.test(decode(sourceBytes(plan, prefix('requirements.txt')))), 'Hash-locked requirements.txt including pytest is required');
}
export async function buildPublicPreparePlan(argv) {
  const args = parseArguments(argv), loc = locations(args), api = await accepted();
  const settings = settingsSnapshot(loc.project);
  check(api.validateSettingsV2(settings.value) && settings.value.runProfiles.length > 0, 'Save full strict V2 settings with an explicit task mode first; legacy/mixed/fragment bytes are never migrated');
  const catalog = json(path.join(installed, 'runtimes/catalog.json'));
  check(api.validateRuntimeCatalog(catalog), 'Invalid installed approved catalog');
  const profile = catalog.profiles.find(p => p.id === args.profile);
  check(profile, 'Unknown approved profile');
  const directories = [...new Set(settings.value.runProfiles.map(p => p.task.workingDirectory))];
  check(directories.length === 1, 'Different per-mode workingDirectory values need separately bound outputs; use one explicit task directory for this CLI');
  const lock = json(path.join(installed, 'runtimes/production-inputs.lock.json'));
  const plan = { schemaVersion: 1, status: 'PLAN_ONLY', scope: 'PUBLIC_PREPARE_NOT_RUNTIME_OR_FINAL_ACCEPTANCE', ...loc,
    profile, settingsFile: settings.file, settingsSha256: settings.sha256, settingsIdentity: settings.identity, settings: settings.value,
    workingDirectory: directories[0], sourceInventory: await sourceSnapshot(loc.project, api),
    limits: { maxHeavyConcurrency: 1, maxElapsedMs: 2700000, maxCommandMs: 480000 },
    offlineFixtureContainers: 0, languageRequired: profile.language.imageLockKey,
    preparedRuntime: path.join(loc.output, 'jobs', profile.id), runtimeConfig: path.join(loc.output, 'runtime-config.json'),
  };
  canonicalDirectory(plan.workingDirectory === '.' ? loc.project : path.join(loc.project, plan.workingDirectory));
  plan.dependencySha256 = dependencyHash(plan.sourceInventory);
  const tools = lock.artifacts.filter(a => a.kind === 'npm').flatMap(a => a.files.map(f => ({ path: 'node_modules/' + a.name + '/' + f.path, sha256: f.sha256 }))).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const key = profile.compilerRelease ? 'java' + profile.compilerRelease : profile.adapterFamily === 'python' ? 'python' : 'node';
  plan.request = { schemaVersion: 1, workingDirectory: plan.workingDirectory, installationId: 'public-' + hash(loc.output).slice(0, 24),
    family: profile.adapterFamily, key: profile.id, imageTag: `paircoach/runtime-${profile.id}:stage09`, baseImage: lock.images[key].reference,
    nodeImage: lock.images.node.reference, tools: { root: path.join(loc.output, 'assets/stage/tools'), files: tools },
    project: { root: path.join(loc.output, 'input'), files: plan.sourceInventory.map(({ path, sha256 }) => ({ path, sha256 })) },
    expectedTools: profile.expectedTools, dependencySha256: plan.dependencySha256, outputRoot: plan.preparedRuntime };
  validateProductionRequest(validatePrepareRequest(plan.request));
  plan.toolchain = resolvePreparedToolchainIdentity(plan.request);
  await validateTaskSources(plan, api);
  await assertOriginal(plan, api);
  check(Buffer.byteLength(JSON.stringify(plan)) <= 4 * 1024 * 1024, 'Public preparation plan limit');
  return plan;
}
async function assertOriginal(plan, api) {
  const settings = settingsSnapshot(plan.project);
  check(settings.identity === plan.settingsIdentity && settings.sha256 === plan.settingsSha256, 'Settings changed during preparation; retain/reconcile, no implicit retry');
  check(equal(await sourceSnapshot(plan.project, api), plan.sourceInventory), 'Current raw source changed during preparation; retain/reconcile');
}
function make(directory, mode = 0o700) {
  canonicalDirectory(path.dirname(directory)); fs.mkdirSync(directory, { mode }); canonicalDirectory(directory);
}
function put(file, bytes, mode = 0o600) {
  canonicalDirectory(path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), mode);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  check(readPrivate(file, 4 * 1024 * 1024).bytes.equals(bytes), 'Published file readback differs'); syncDirectory(path.dirname(file));
}
function copySource(plan) {
  make(plan.request.project.root, 0o755);
  for (const file of plan.sourceInventory) {
    let dir = plan.request.project.root;
    for (const part of file.path.split('/').slice(0, -1)) {
      dir = path.join(dir, part);
      try { make(dir, 0o755); } catch (e) { if (e.code !== 'EEXIST') throw e; canonicalDirectory(dir); }
    }
    put(path.join(plan.request.project.root, file.path), sourceBytes(plan, file.path), 0o644);
  }
}

/** Manifest proof must be supplied by actual inspect, NOT inferred from imageId. Docker containerd
 * may genuinely give equal Id and Descriptor.digest (OCI index); equality is NOT forbidden. */
export function measuredImageEntry(key, imageTag, observed, expectedImageId, tools) {
  check(observed && sha.test(observed.Id) && observed.Id === expectedImageId && Array.isArray(observed.RepoDigests), 'NOTREADY: actual image/config identity mismatch');
  const repos = observed.RepoDigests;
  check(repos.every(s => typeof s === 'string' && /^[a-z0-9][a-z0-9._/:+-]*@sha256:[a-f0-9]{64}$/.test(s)), 'NOTREADY: malformed RepoDigest');
  const descriptor = observed.Descriptor;
  if (descriptor !== null && descriptor !== undefined) check(typeof descriptor === 'object' && sha.test(descriptor.digest) && Number.isSafeInteger(descriptor.size) && descriptor.size > 0 && [
    'application/vnd.oci.image.manifest.v1+json', 'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
  ].includes(descriptor.mediaType), 'NOTREADY: malformed manifest/index Descriptor');
  const digest = descriptor?.digest ?? (repos.length ? repos[0].split('@')[1] : null);
  check(digest && (!repos.length || repos.some(s => s.endsWith('@' + digest))), 'NOTREADY: genuine matching manifest/index Descriptor or RepoDigest required (imageId alone is not proof)');
  check(Array.isArray(tools) && tools.length > 0 && tools.length <= 16 && new Set(tools.map(t => t.name)).size === tools.length && tools.every(t => t && typeof t.name === 'string' && typeof t.version === 'string' && t.version.length > 0), 'NOTREADY: actual tools required');
  // Prepared receipts bind this approved selector; genuine manifest/config identities remain separate.
  return { key, image: imageTag, imageId: observed.Id, digest, tools: tools.map(({ name, version }) => ({ name, version })) };
}
function languageTools(item, kind, profile, lock) {
  check(item?.status === 'BUILT_TOOLS_CHECKED_NOT_LSP_FUNCTIONAL_ACCEPTANCE' && Array.isArray(item.tools), 'NOTREADY: language tool probes incomplete');
  for (const probe of item.tools) check(probe.status === 'TOOL_PROBE_PASS_REMOVED' && /^[a-f0-9]{64}$/.test(probe.container?.Id) && probe.container.State?.Running === false && probe.container.State.ExitCode === 0 && probe.container.Config?.Image === item.observedImage.Id && probe.container.Config.Labels?.['paircoach.installation'] === 'stage09-runtime-assets' && probe.container.Config.Labels?.['paircoach.role'] === 'language-tool-probe', 'NOTREADY: language probe terminal/image ownership mismatch');
  if (kind === 'java') {
    const probes = ['jdt-server-java', ...[11, 17, 21, 27].map(r => 'target-javac-' + r)];
    check(item.tools.length === probes.length && new Set(item.tools.map(p => p.name.replace('paircoach-stage09-language-', ''))).size === probes.length, 'NOTREADY: Java language probe inventory');
    return probes.map(name => {
      const p = item.tools.find(p => p.name === 'paircoach-stage09-language-' + name);
      check(p, 'NOTREADY: Java probe missing');
      const version = (p.stdout + p.stderr).trim().match(name === 'jdt-server-java' ? /version "([^"]+)"/ : /^javac (\S+)/)?.[1];
      check(version && version === p.version && (name !== 'jdt-server-java' || version === profile.language.serverJvm), 'NOTREADY: actual Java language version differs');
      return { name: name === 'jdt-server-java' ? 'java' : name, version };
    });
  }
  check(item.tools.length === 1, 'NOTREADY: Python language probe inventory');
  const p = item.tools[0], actual = JSON.parse(p.stdout);
  check(equal(actual, p.inventory) && actual.python === lock.language.pylsp.pythonVersion && lock.language.artifacts.filter(a => a.kind === 'language-wheel').every(a => actual.packages?.[a.name] === a.version), 'NOTREADY: actual Python language inventory differs');
  return [{ name: 'python', version: actual.python }, ...['python-lsp-server', 'jedi', 'pyflakes'].map(name => ({ name, version: actual.packages[name] }))];
}
async function artifacts(plan, prepared, language, run, api, lock) {
  check(prepared.status === 'PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION' && equal(prepared.request, plan.request) && equal(prepared.engine, run.engine), 'NOTREADY: prepared request/status/engine correlation differs');
  check(equal({ toolchainHash: prepared.toolchainHash, dispatcherFiles: prepared.dispatcherFiles }, resolvePreparedToolchainIdentity(plan.request)), 'NOTREADY: installed producer identity differs');
  const cache = path.join(plan.preparedRuntime, 'cache', plan.profile.adapterFamily, prepared.toolchainHash, plan.dependencySha256);
  check(prepared.cacheEvidence?.root === cache, 'NOTREADY: cache root correlation differs');
  const toolsFile = readPrivate(path.join(cache, 'tools.json'), 65536), dependencyFile = readPrivate(path.join(cache, 'dependencies-prepared.json'), 65536);
  const tools = JSON.parse(decode(toolsFile.bytes)), deps = JSON.parse(decode(dependencyFile.bytes));
  check(hash(toolsFile.bytes) === prepared.cacheEvidence.tools?.sha256 && equal(tools, prepared.cacheEvidence.tools.actual) && hash(dependencyFile.bytes) === prepared.cacheEvidence.dependencies?.sha256 && equal(deps, prepared.cacheEvidence.dependencies.actual), 'NOTREADY: actual cache evidence changed');
  check(Array.isArray(tools) && equal(tools, deps.tools) && deps.family === plan.profile.adapterFamily && deps.workingDirectory === plan.workingDirectory && deps.dependencySha256 === plan.dependencySha256 && plan.profile.expectedTools.every(t => tools.some(a => a.name === t.name && a.version === t.version)), 'NOTREADY: current cache/tool identity differs');
  if (plan.profile.adapterFamily === 'java-maven') api.inspectEffectivePom(decode(readPrivate(path.join(cache, 'effective-pom.xml'), 4 * 1024 * 1024).bytes), plan.profile.compilerRelease, plan.profile.analysis.preview);
  const inspect = id => {
    const values = JSON.parse(run(['image', 'inspect', id]).stdout);
    check(Array.isArray(values) && values.length === 1 && values[0].Id === id && values[0].Config?.User === '10001:10001' && !values[0].Config.Entrypoint?.length, 'NOTREADY: actual image configuration changed');
    return { Id: values[0].Id, Descriptor: values[0].Descriptor ?? null, RepoDigests: values[0].RepoDigests ?? [] };
  };
  check(prepared.observedImage?.Id === prepared.imageId, 'NOTREADY: captured runtime configId differs');
  const observed = inspect(prepared.imageId);
  const images = [measuredImageEntry(plan.profile.imageLockKey, plan.request.imageTag, observed, prepared.imageId, tools)];
  if (plan.languageRequired !== null) {
    const kind = plan.profile.language.provider === 'jdt' ? 'java' : 'python', item = language.find(i => i.key === plan.languageRequired);
    check(item && equal(item.engine, run.engine), 'NOTREADY: language image/engine missing');
    const observed = inspect(item.observedImage?.Id);
    images.push(measuredImageEntry(plan.languageRequired, item.imageTag, observed, item.observedImage.Id, languageTools(item, kind, plan.profile, lock)));
  }
  const imageLock = { schemaVersion: 1, images }, catalog = { schemaVersion: 1, profiles: [plan.profile] };
  const runtimeConfig = { schemaVersion: 1, activeProfile: plan.profile.id, workspaceRoot: plan.project, runtimeCatalog: 'catalog.json', imageLock: 'images.lock.json', languageFeatures: { completion: true, diagnostics: true }, execution: { backend: 'docker', pullPolicy: 'never' } };
  check(api.validateImageLock(imageLock) && api.validateRuntimeCatalog(catalog) && api.validateCatalogImageReferences(catalog, imageLock) && api.validateRuntimeConfigV1(runtimeConfig), 'NOTREADY: generated existing-schema artifacts failed validation');
  return { imageLock, catalog, runtimeConfig, observedRuntimeImage: observed };
}
/** Injection is a developer seam, not an argv/env option. Production always uses the real bounded
 * producers and child transport. Callers must never present injected UNIT results as live proof. */
export async function executePublicPreparePlan(plan, dependencies = {}) {
  const api = await accepted();
  const rebuilt = await buildPublicPreparePlan(['--project', plan.project, '--profile', plan.profile.id, '--output', plan.output]);
  check(equal(rebuilt, plan), 'Preparation plan/source changed before execution');
  const publish = receiptWriter(plan.output), started = Date.now(), deadline = started + plan.limits.maxElapsedMs;
  const endpoint = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';
  const configDirectory = path.join(plan.output, 'docker-config');
  const receipt = { schemaVersion: 1, status: 'STARTED_NOT_READY', scope: plan.scope, startedAt: new Date().toISOString(), plan,
    endpoint, configDirectory, commands: [], language: [], originalProject: plan.project, rawSourceAuthority: 'CURRENT_RAW_ONLY_NOT_WRITEGATE_ACK', finalQa: 'NOT_RUN' };
  let publicationFailed = false;
  const save = () => { try { publish(receipt); } catch (e) { publicationFailed = true; throw e; } }; save();
  const budget = () => check(Date.now() < deadline, 'Public preparation time budget exceeded; retain/reconcile');
  const engineArgs = ['info', '--format', '{"ID":{{json .ID}},"ServerVersion":{{json .ServerVersion}},"OSType":{{json .OSType}},"Architecture":{{json .Architecture}}}'];
  const invoke = args => {
    budget(); canonicalDirectory(configDirectory);
    check(fs.readdirSync(configDirectory).length === 0, 'Dedicated Docker config changed; retain/reconcile');
    const argv = ['--host', endpoint, '--config', configDirectory, ...args], began = new Date().toISOString();
    const raw = (dependencies.spawnSync ?? spawnSync)('docker', argv, { shell: false, env: { PATH: process.env.PATH, HOME: path.join(plan.output, 'docker-home') }, encoding: 'utf8', timeout: Math.max(1, Math.min(plan.limits.maxCommandMs, deadline - Date.now())), maxBuffer: 4 * 1024 * 1024 });
    receipt.commands.push({ argv: ['docker', ...argv], endpoint, startedAt: began, finishedAt: new Date().toISOString(), exit: raw.status, signal: raw.signal, error: raw.error?.message ?? null, stdout: raw.stdout, stderr: raw.stderr }); save();
    check(!raw.error && !raw.signal && raw.status === 0, 'Unknown/failed Docker operation; retain exact receipts/resources and reconcile before retry'); return raw;
  };
  const observeEngine = () => {
    const e = JSON.parse(invoke(engineArgs).stdout);
    check(e && Object.keys(e).sort().join(',') === 'Architecture,ID,OSType,ServerVersion' && Object.values(e).every(v => typeof v === 'string' && v.length > 0 && v.length <= 256) && e.OSType === 'linux' && ['amd64', 'x86_64'].includes(e.Architecture), 'Unsupported/unconfirmed actual engine identity'); return e;
  };
  const run = args => {
    check(equal(observeEngine(), receipt.engine), 'Docker engine changed; retain/reconcile'); return invoke(args);
  };
  try {
    make(configDirectory); make(path.join(plan.output, 'docker-home')); make(path.join(plan.output, 'jobs'));
    receipt.engine = observeEngine(); run.engine = receipt.engine; save();
    await assertOriginal(plan, api);
    copySource(plan);
    await assertOriginal(plan, api); // complete source/settings identity fences around capture
    const staged = await api.readRunSourceInventory(plan.request.project.root);
    check(equal(staged, plan.sourceInventory.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }))), 'Staged raw input changed');
    receipt.status = 'CAPTURED_RAW_NOT_ACK'; save(); budget();
    await (dependencies.stageInputs ?? stageInputs)(path.join(plan.output, 'assets'));
    budget(); check(equal(observeEngine(), receipt.engine), 'Docker engine changed during acquisition');
    const produced = (dependencies.prepare ?? prepare)(plan.request, true, deadline, receipt.engine, { endpoint, configDirectory, ...(dependencies.spawnSync ? { spawnSync: dependencies.spawnSync } : {}) });
    receipt.prepareReceipt = path.join(plan.preparedRuntime, 'receipt.json'); save();
    const prepared = json(receipt.prepareReceipt);
    check(equal(prepared, produced), 'Actual durable prepared receipt differs from producer result');
    const lock = json(path.join(installed, 'runtimes/production-inputs.lock.json'));
    if (plan.languageRequired !== null) {
      const kinds = plan.profile.language.provider === 'jdt' ? ['java'] : ['python'];
      (dependencies.prepareLanguageImages ?? prepareLanguageImages)(path.join(plan.output, 'assets'), lock, { run, save, receipt }, kinds);
    }
    budget(); await assertOriginal(plan, api);
    // Missing OCI/evidence is an explicit NOTREADY, never a synthetic digest or usable config.
    let generated;
    try { generated = await artifacts(plan, prepared, receipt.language, run, api, lock); }
    catch (e) { receipt.status = 'NOTREADY'; receipt.problem = e.message; save(); return { schemaVersion: 1, status: receipt.status, output: plan.output, receipt: path.join(plan.output, 'receipt.json'), preparedRuntime: plan.preparedRuntime, runtimeConfig: null, problem: e.message }; }
    receipt.measuredArtifacts = generated; receipt.status = 'MEASURED_ARTIFACTS_PENDING_PUBLICATION'; save();
    const bytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
    put(path.join(plan.output, 'catalog.json'), bytes(generated.catalog));
    put(path.join(plan.output, 'images.lock.json'), bytes(generated.imageLock));
    // RuntimeConfig is published LAST, after all proof and actual guards; never a partial usable selector.
    put(plan.runtimeConfig, bytes(generated.runtimeConfig));
    const loaded = api.loadRuntimeConfiguration({ configPath: plan.runtimeConfig, environment: {}, explicitWorkspaceRoot: plan.project });
    check(loaded.resolved && loaded.resolved.profile.id === plan.profile.id && loaded.resolved.workspaceRoot === plan.project, 'Generated runtime configuration could not be independently loaded');
    receipt.status = 'PREPARED_CONFIG_GENERATED_NOT_ACCEPTANCE'; receipt.runtimeConfig = plan.runtimeConfig; save();
    return { schemaVersion: 1, status: receipt.status, output: plan.output, receipt: path.join(plan.output, 'receipt.json'), preparedRuntime: plan.preparedRuntime, runtimeConfig: plan.runtimeConfig,
      startupArgs: ['--prepared-runtime', plan.preparedRuntime, '--runtime-config', plan.runtimeConfig], finalQa: 'NOT_RUN' };
  } catch (e) {
    receipt.status = 'FAILED_RETAIN_AND_RECONCILE'; receipt.problem = e.message;
    if (!publicationFailed) save(); throw e;
  }
}
export async function main(argv, dependencies = {}) {
  const args = parseArguments(argv), plan = await buildPublicPreparePlan(argv);
  return args.execute ? executePublicPreparePlan(plan, dependencies) : plan;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await main(process.argv.slice(2)); process.stdout.write(JSON.stringify(result, null, 2) + '\n'); if (result.status === 'NOTREADY') process.exitCode = 2; }
  catch (error) { process.stderr.write(JSON.stringify({ schemaVersion: 1, status: 'REFUSED_OR_FAILED_RETAIN', problem: error.message }) + '\n'); process.exitCode = 1; }
}
