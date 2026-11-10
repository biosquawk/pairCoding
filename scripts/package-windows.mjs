// MVP2 source archive only. No implied acceptance, build, start or publication.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const help = `PairCoach MVP2 SOURCE — archiwum źródeł; odbiór uruchomienia jest osobny.
Użycie (z repo; Node + Git):
  node scripts/package-windows.mjs --help
  node scripts/package-windows.mjs --commit <pełne40SHA> --list
  node scripts/package-windows.mjs --commit <pełne40SHA> --dry-run
  node scripts/package-windows.mjs --commit <pełne40SHA> --output <nowyKatalogPozaRepo>
--list: ścieżki ze wskazanego commitu. --dry-run: plan i hashe, ZERO zapisów.
--output: ZIP + manifest.json + SHA256SUMS; nie nadpisuje istniejącego katalogu.
Pakuj uzgodniony exact commit MVP2; build, Windows/recovery i AI wymagają osobnych dowodów.
Nie uruchamia npm, serwera, AI, testów Windows, publikacji ani wdrożenia.
`;
const sha256 = data => createHash('sha256').update(data).digest('hex');
// Read STORE entries via the ZIP central directory, independently of git attributes.
function verifyArchive(zip, prefix, files) {
  const end = zip.length - 22; // git archive emits no ZIP archive comment beyond its commit comment
  let eocd = -1;
  for (let i = end; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Brak końca ZIP.');
  const expected = new Map(files.map(f => [prefix + f.path, f]));
  let cursor = zip.readUInt32LE(eocd + 16);
  const seen = new Set();
  for (let i = 0; i < zip.readUInt16LE(eocd + 10); i++) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Niepoprawny katalog ZIP.');
    const method = zip.readUInt16LE(cursor + 10), size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28), extra = zip.readUInt16LE(cursor + 30), comment = zip.readUInt16LE(cursor + 32);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const local = zip.readUInt32LE(cursor + 42);
    cursor += 46 + nameLength + extra + comment;
    if (name.endsWith('/')) {
      if (![...expected.keys()].some(p => p.startsWith(name))) throw new Error('Nadmiarowy katalog ZIP.');
      continue;
    }
    const file = expected.get(name);
    if (!file || seen.has(name) || method !== 0 || size !== file.bytes || zip.readUInt32LE(local) !== 0x04034b50) throw new Error('Lista/format ZIP niezgodne z manifestem.');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (sha256(zip.subarray(start, start + size)) !== file.sha256) throw new Error('Hash zawartości ZIP niezgodny z blobem Git.');
    seen.add(name);
  }
  if (seen.size !== files.length) throw new Error('ZIP pomija wymagane pliki (sprawdź atrybuty Git).');
}
function git(cwd, args) {
  const r = spawnSync('git', ['--no-pager', ...args], { cwd, shell: false, maxBuffer: 128 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`Git nie wykonał ${args[0]}; sprawdź repo/rewizję i uprawnienia.`);
  return r.stdout;
}
const text = b => b.toString('utf8').trim();
const top = new Set(['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'metadata.json', 'playwright.config.ts']);
// Allow tracked test sources/support, never raw QA output or local runtime data.
function allowed(name) {
  const parts = name.toLowerCase().split('/');
  if (parts.some(p => ['.git', '.paircoach', 'node_modules', '.runtime', 'runtime', 'tmp', '.tmp', 'artifacts', 'test-results', 'playwright-report', 'dist', 'coverage', 'credentials', 'secrets', 'logs', 'traces', 'screenshots', 'reports'].includes(p) ||
      p.startsWith('.env') || /\.(pem|key|pfx|p12|log)$/i.test(p))) return false;
  return top.has(name) || name.startsWith('src/') || /^docs\/windows[^/]*\.md$/.test(name) || /^scripts\/package[^/]*\.mjs$/.test(name) || name === 'scripts/clean.mjs' ||
    (name.startsWith('tests/') && (/\.(ts|tsx|js|jsx|mjs|cjs|json|xml|txt|md|py|java|ps1)$/.test(name) || name === 'tests/qa/.gitignore'));
}
// Deliberately finite contract, not a shell parser. Unknown/changed scripts require
// review; never execute package scripts while producing an archive.
function commandClosure(pkg, paths) {
  const contracts = {
    dev: ['vite --port 3000 --host 127.0.0.1', ['index.html', 'vite.config.ts'], ['vite']],
    build: ['vite build', ['index.html', 'vite.config.ts'], ['vite']],
    preview: ['vite preview', ['vite.config.ts'], ['vite'], 'Run build first; frontend preview only, not API'],
    clean: ['node scripts/clean.mjs', ['scripts/clean.mjs'], []],
    lint: ['tsc --noEmit', ['tsconfig.json'], ['typescript']],
    server: ['tsx src/server/index.ts', ['src/server/index.ts'], ['tsx']],
    start: ['tsx src/server/index.ts', ['src/server/index.ts'], ['tsx']],
    'dev:full': ['concurrently --kill-others "npm run server" "npm run dev"', ['src/server/index.ts', 'vite.config.ts', 'index.html'], ['concurrently', 'tsx', 'vite']],
    typecheck: ['tsc --noEmit', ['tsconfig.json'], ['typescript']],
    test: ['tsx --test tests/**/*.test.ts', ['playwright.config.ts'], ['tsx'], 'Test sources included; browser campaigns need browser/environment and separate explicit invocation'],
  };
  if (!pkg.scripts || typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts)) throw new Error('Brak poprawnych npm scripts.');
  for (const name of ['clean', 'build', 'start', 'typecheck']) {
    if (!Object.hasOwn(pkg.scripts, name)) throw new Error(`Brak wymaganego npm script: ${name}`);
  }
  if (Object.hasOwn(pkg.scripts, 'test') && ![...paths].some(p => /^tests\/.+\.test\.ts$/.test(p))) throw new Error('npm test: brak źródeł *.test.ts w ZIP.');
  if (Object.hasOwn(pkg.scripts, 'dev:full') && (!Object.hasOwn(pkg.scripts, 'dev') || !Object.hasOwn(pkg.scripts, 'server'))) throw new Error('npm dev:full: brak zależnych scripts dev/server.');
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const commands = [];
  for (const [name, command] of Object.entries(pkg.scripts)) {
    const contract = contracts[name];
    if (!contract || command !== contract[0]) throw new Error(`Nierozpoznany/zmieniony npm script: ${name}; wymagany review command closure.`);
    for (const file of contract[1]) if (!paths.has(file)) throw new Error(`npm ${name}: brak pliku w ZIP: ${file}`);
    for (const dependency of contract[2]) if (typeof deps[dependency] !== 'string' || !deps[dependency]) throw new Error(`npm ${name}: brak dependency: ${dependency}`);
    commands.push({ name, command, scope: 'ZIP_AFTER_NPM_CI',
      requiredFiles: contract[1], dependencies: contract[2], prerequisite: contract[3] ?? null,
      execution: 'NOT_RUN_BY_PACKAGER' });
  }
  return commands;
}
function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(help); return; }
  let commit, output, mode;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--commit' && !commit && args[i + 1]) commit = args[++i];
    else if (arg === '--output' && !mode && args[i + 1]) { mode = 'output'; output = args[++i]; }
    else if (['--list', '--dry-run'].includes(arg) && !mode) mode = arg.slice(2);
    else throw new Error('Niepoprawne/powtórzone argumenty. Użyj --help.');
  }
  if (!/^[a-f0-9]{40}$/.test(commit ?? '') || !mode) throw new Error('Podaj pełny commit40SHA i dokładnie jeden tryb; użyj --help.');
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const root = text(git(scriptDir, ['rev-parse', '--show-toplevel']));
  if (text(git(root, ['rev-parse', `${commit}^{commit}`])) !== commit) throw new Error('Niezgodna rewizja.');
  // Git checkout may convert LF to CRLF. Ignore only CR immediately before LF;
  // preserve every other byte, including lone CR, when checking packaging policy.
  const checkoutEol = bytes => bytes.filter((byte, i) => byte !== 0x0d || bytes[i + 1] !== 0x0a);
  if (!checkoutEol(fs.readFileSync(fileURLToPath(import.meta.url))).equals(checkoutEol(git(root, ['show', `${commit}:scripts/package-windows.mjs`])))) {
    throw new Error('Skrypt musi być zgodny ze wskazanym commitem (dopuszczalne wyłącznie LF/CRLF).');
  }
  const entries = git(root, ['ls-tree', '-r', '-z', commit]).toString('utf8').split('\0').filter(Boolean).map(row => {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
    if (!match) throw new Error('Nierozpoznany wpis git tree.');
    return { mode: match[1], type: match[2], oid: match[3], path: match[4] };
  });
  const selected = entries.filter(e => allowed(e.path)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const e of selected) {
    if (!['100644', '100755'].includes(e.mode) || e.type !== 'blob' || !/^[A-Za-z0-9._/-]+$/.test(e.path) || e.path.split('/').includes('..')) {
      throw new Error('Niedozwolony typ/ścieżka w allowlist (np. symlink/submodule).');
    }
  }
  const paths = new Set(selected.map(e => e.path));
  for (const name of [...top, 'src/server/index.ts', 'docs/windows-start.md', 'docs/windows-package.md', 'scripts/package-windows.mjs', 'scripts/clean.mjs']) {
    if (!paths.has(name)) throw new Error(`Brak wymaganego pliku: ${name}`);
  }
  const pkg = JSON.parse(git(root, ['show', `${commit}:package.json`]).toString('utf8'));
  const commands = commandClosure(pkg, paths);
  const packageId = `paircoach-v3-mvp2-${commit}`;
  if (mode === 'list') { process.stdout.write(selected.map(e => e.path).join('\n') + '\n'); return; }
  const files = selected.map(e => {
    const bytes = git(root, ['cat-file', 'blob', e.oid]);
    return { path: e.path, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const plan = { status: 'MVP2_SOURCE_RUNTIME_ACCEPTANCE_SEPARATE', packageId, sourceCommit: commit,
    releaseScope: 'MVP2 source candidate: snapshot/recovery/run/report; packaging does not establish Windows, GUI, recovery or final acceptance',
    format: 'git-archive-zip', prefix: `${packageId}/`, commands, files };
  if (mode === 'dry-run') { process.stdout.write(JSON.stringify(plan, null, 2) + '\n'); return; }
  const destination = path.resolve(output);
  // All inputs come from git blobs, never the working tree or runtime directories.
  // Existing parent required; resolve its links to prevent an output alias inside the repo.
  const parent = fs.realpathSync(path.dirname(destination));
  const target = path.join(parent, path.basename(destination));
  const realRoot = fs.realpathSync(root);
  if (target === realRoot || target.startsWith(realRoot + path.sep)) throw new Error('Wynik musi być poza repo.');
  if (fs.existsSync(target)) throw new Error('Katalog wyniku już istnieje; nie nadpisano. Odczytaj i uzgodnij poprzedni wynik.');
  const archive = git(root, ['-c', 'core.attributesFile=', '-c', 'core.autocrlf=false', 'archive', '--format=zip', '-0', `--prefix=${plan.prefix}`, commit, '--', ...selected.map(e => e.path)]);
  verifyArchive(archive, plan.prefix, files);
  const archiveName = `${packageId}.zip`;
  const manifest = { ...plan, archive: { name: archiveName, bytes: archive.length, sha256: sha256(archive) },
    tools: { node: process.version, git: text(git(root, ['--version'])), platform: process.platform, arch: process.arch },
    exclusions: 'raw QA runtime/logs/trace/reports/artifacts, node_modules, dist, .git, .env*, keys, local workspaces/session data; tracked test sources/support included by allowlist',
    limitations: ['No build/install/start/deployment verification', 'No automatic secret-content detection; review tracked source before distribution', 'ZIP reproducibility requires same Git version; verify hashes on final candidate'] };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  fs.mkdirSync(target); // exclusive, no automatic cleanup if a later write fails
  fs.writeFileSync(path.join(target, archiveName), archive, { flag: 'wx' });
  fs.writeFileSync(path.join(target, 'manifest.json'), manifestBytes, { flag: 'wx' });
  fs.writeFileSync(path.join(target, 'SHA256SUMS'), `${sha256(archive)}  ${archiveName}\n${sha256(manifestBytes)}  manifest.json\n`, { flag: 'wx' });
  process.stdout.write(JSON.stringify({ status: manifest.status, output: target, packageId, sourceCommit: commit, archiveSha256: manifest.archive.sha256 }) + '\n');
}
try { main(); } catch (error) { process.stderr.write(`BŁĄD: ${error.message}\n`); process.exitCode = 1; }
