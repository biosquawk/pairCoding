import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as codec from '../../src/language/uriCodec';
import { LanguageBootPublisher } from '../../src/server/language/LanguageBootPublisher';
import { buildLanguageProviderConfiguration } from '../../src/server/language/LanguageProviderConfiguration';
import { LanguageShadowStore, type TrustedLanguageSnapshot } from '../../src/server/language/LanguageShadowStore';
import { assertRealDirectory, sha256 } from '../../src/server/language/LanguageProcessJournal';
import { NodeLanguageJournalDurability, type LanguageJournalDurability } from '../../src/server/language/LanguageJournalDurability';
import { profile } from '../runtime-contract/fixtures';

// Real owned filesystem + actual shadow/configuration/codec. Prepared inventory below is synthetic;
// publication proves durability/binding, NOT genuine preparation, Docker or real provider import.
function fixture(t: TestContext, family: 'java-maven' | 'python' = 'java-maven') {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'boot-publication-'));
  const clear = (dir: string): void => { for (const name of readdirSync(dir)) {
    const path = join(dir, name), s = lstatSync(path);
    if (s.isDirectory() && !s.isSymbolicLink()) clear(path); else if (s.isFile() && !s.isSymbolicLink()) chmodSync(path, 0o644);
  } };
  t.after(() => { clear(root); rmSync(root, { recursive: true, force: true }); });
  const owned = join(root, 'owned'), source = join(root, 'source'); [owned, source].forEach(p => mkdirSync(p));
  const content = 'original source'; writeFileSync(join(source, 'main.txt'), content);
  const config = buildLanguageProviderConfiguration(profile(family), { family, workingDirectory: '.', dependencySha256: 'c'.repeat(64), toolchainSha256: 'b'.repeat(64),
    files: ['tools.json', 'dependencies-prepared.json', ...(family === 'java-maven' ? ['effective-pom.xml', 'm2/example.jar'] : ['site-packages/example.py'])]
      .map(path => ({ path, bytes: 1, sha256: 'f'.repeat(64) })) });
  const snapshot: TrustedLanguageSnapshot = { leaseId: 'lease1', projectRoot: source, overlays: [], dependencies: null,
    files: [{ path: 'main.txt', bytes: Buffer.byteLength(content), sha256: sha256(content) }],
    identity: { projectId: 'p', sessionId: 's', profileId: 'profile', configurationGeneration: 'config', providerGeneration: 'provider', shadowGeneration: 'shadow',
      connectionGeneration: 'connection', provider: config.provider, imageId: `sha256:${'a'.repeat(64)}`, toolchainSha256: 'b'.repeat(64), dependencyManifestSha256: 'c'.repeat(64),
      analysisSettingsSha256: config.analysisSettingsSha256 } };
  const store = new LanguageShadowStore(owned, codec), shadow = store.materialize('diagnostics', { capture: () => snapshot, isCurrent: s => s === snapshot });
  const publisher = new LanguageBootPublisher(s => store.assertIntegrity(s));
  return { root, source, store, shadow, config, publisher };
}
test('durable exclusive boot publication binds actual shadow/configuration and preserves original source', t => {
  const f = fixture(t), publication = f.publisher.publish(f.shadow, f.config);
  f.publisher.assertPublished(f.shadow, f.config, publication);
  assert.equal(publication.launchId, f.shadow.launchId); assert.equal(publication.inputManifestSha256, f.shadow.inputManifestSha256);
  assert.equal(publication.analysisSettingsSha256, f.config.analysisSettingsSha256);
  assert.equal(publication.manifestSha256, sha256(readFileSync(publication.manifestPath)));
  const manifest = JSON.parse(readFileSync(publication.manifestPath, 'utf8'));
  assert.deepEqual(manifest.config, f.config); assert.equal(manifest.phase, 'diagnostics');
  assert.equal(readFileSync(join(f.shadow.bootDirectory, 'maven-settings.xml'), 'utf8'), f.config.bootFiles['maven-settings.xml']);
  assert.deepEqual(readdirSync(f.shadow.stateDirectory), []); assert.equal(readFileSync(join(f.source, 'main.txt'), 'utf8'), 'original source');
  assert.ok(Object.isFrozen(publication.files[0])); assert.throws(() => f.publisher.publish(f.shadow, f.config), /already published/);
});
test('Python has an actual bound launch manifest even with no generated settings file', t => {
  const f = fixture(t, 'python'), p = f.publisher.publish(f.shadow, f.config);
  assert.deepEqual(p.files, []); assert.deepEqual(readdirSync(f.shadow.bootDirectory), ['language-launch.json']);
  f.publisher.assertPublished(f.shadow, f.config, p); assert.equal(existsSync(join(f.shadow.bootDirectory, 'maven-settings.xml')), false);
});
test('settings/argv/hash/provider drift fails before any boot file and poisons that launch, never repairs', t => {
  for (const patch of [{ settings: {} }, { argv: ['/bin/sh', '-c', 'unexpected'] }, { analysisSettingsSha256: '0'.repeat(64) }, { provider: 'pylsp' as const }]) {
    const f = fixture(t); assert.throws(() => f.publisher.publish(f.shadow, { ...f.config, ...patch }), /hash mismatch|configuration/);
    assert.deepEqual(readdirSync(f.shadow.bootDirectory), []); assert.throws(() => f.publisher.publish(f.shadow, f.config), /publication failed/);
  }
});
test('unsafe boot names reject without following paths or creating outside files', t => {
  for (const name of ['../escape.xml', '/escape.xml', 'x/y.xml', 'x\\y.xml', 'CON.xml', 'language-launch.json', 'trail.']) {
    const f = fixture(t); assert.throws(() => f.publisher.publish(f.shadow, { ...f.config, bootFiles: { [name]: 'bad' } }), /configuration/);
    assert.deepEqual(readdirSync(f.shadow.bootDirectory), []); assert.equal(existsSync(join(f.root, 'escape.xml')), false);
  }
});
test('preexisting regular/symlink/hardlink settings are never overwritten; original target unchanged', t => {
  for (const kind of ['file', 'symlink', 'hardlink']) {
    const f = fixture(t), target = join(f.root, 'target.xml'), path = join(f.shadow.bootDirectory, 'maven-settings.xml');
    writeFileSync(target, 'target bytes');
    if (kind === 'file') writeFileSync(path, 'keep'); else if (kind === 'symlink') symlinkSync(target, path); else linkSync(target, path);
    assert.throws(() => f.publisher.publish(f.shadow, f.config), /EEXIST/); assert.equal(readFileSync(target, 'utf8'), 'target bytes');
    assert.equal(readFileSync(path, 'utf8'), kind === 'file' ? 'keep' : 'target bytes');
  }
});
test('manifest collision preserves old bytes and never issues success for partial publication', t => {
  const f = fixture(t), path = join(f.shadow.bootDirectory, 'language-launch.json'); writeFileSync(path, 'existing unrelated record');
  assert.throws(() => f.publisher.publish(f.shadow, f.config), /EEXIST/); assert.equal(readFileSync(path, 'utf8'), 'existing unrelated record');
  assert.equal(existsSync(join(f.shadow.bootDirectory, 'maven-settings.xml')), true);
  assert.throws(() => f.publisher.publish(f.shadow, f.config), /publication failed/);
});
test('regular boot files fsync using writable descriptors and exact directory durability policy', t => {
  const f = fixture(t), real = new NodeLanguageJournalDurability(assertRealDirectory); let files = 0, directories = 0;
  const durability: LanguageJournalDurability = { policy: real.policy, file: fd => {
    assert.ok(fstatSync(fd).isFile()); assert.equal(writeSync(fd, Buffer.alloc(0), 0, 0, 0), 0); real.file(fd); files++;
  }, directory: path => { real.directory(path); directories++; } };
  const publisher = new LanguageBootPublisher(s => f.store.assertIntegrity(s), durability), p = publisher.publish(f.shadow, f.config);
  assert.equal(files, 2); assert.equal(directories, 2); assert.equal(publisher.durabilityPolicy, real.policy); publisher.assertPublished(f.shadow, f.config, p);
});
test('file and directory flush failures propagate and prohibit retry/overwrite in the same launch', t => {
  for (const where of ['file', 'directory'] as const) {
    const f = fixture(t), real = new NodeLanguageJournalDurability(assertRealDirectory);
    const publisher = new LanguageBootPublisher(s => f.store.assertIntegrity(s), { policy: 'WIN32_FILE_FSYNC_RENAME_READBACK',
      file: fd => { if (where === 'file') throw new Error('EPERM regular fsync'); real.file(fd); },
      directory: () => { throw new Error('EIO directory fsync'); } });
    assert.throws(() => publisher.publish(f.shadow, f.config), where === 'file' ? /EPERM/ : /EIO/);
    assert.throws(() => publisher.publish(f.shadow, f.config), /publication failed/);
  }
});
test('boot or manifest replacement and copied/foreign publication cannot pass private readback', t => {
  for (const what of ['settings', 'manifest', 'hardlink']) {
    const f = fixture(t), p = f.publisher.publish(f.shadow, f.config);
    const path = what === 'manifest' ? p.manifestPath : join(f.shadow.bootDirectory, 'maven-settings.xml');
    chmodSync(path, 0o644);
    if (what === 'hardlink') linkSync(path, join(f.root, 'aliased'));
    else writeFileSync(path, 'tampered');
    assert.throws(() => f.publisher.assertPublished(f.shadow, f.config, p), /tampered|Unsafe/);
  }
  const f = fixture(t), p = f.publisher.publish(f.shadow, f.config);
  assert.throws(() => f.publisher.assertPublished(f.shadow, f.config, structuredClone(p)), /Unknown/);
  assert.throws(() => new LanguageBootPublisher(s => f.store.assertIntegrity(s)).assertPublished(f.shadow, f.config, p), /Unknown/);
});
test('stale/tampered shadow and escaped boot directory cannot acquire publication authority', t => {
  const f = fixture(t); chmodSync(join(f.shadow.workspaceDirectory, 'main.txt'), 0o644); writeFileSync(join(f.shadow.workspaceDirectory, 'main.txt'), 'tampered');
  assert.throws(() => f.publisher.publish(f.shadow, f.config), /contents mismatch/); assert.deepEqual(readdirSync(f.shadow.bootDirectory), []);
  const g = fixture(t); assert.throws(() => g.publisher.publish({ ...g.shadow, bootDirectory: g.root }, g.config), /outside exact owned launch/);
});
