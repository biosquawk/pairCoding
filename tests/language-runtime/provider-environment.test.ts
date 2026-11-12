import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DockerLanguageProcess, LanguageProcessAdmission } from '../../src/server/language/DockerLanguageProcess';
import { DiskLanguageProcessJournal } from '../../src/server/language/LanguageProcessJournal';
import type { LanguageDockerDriver } from '../../src/server/language/DockerLanguageDriver';
// UNIT command capture only. No Docker contact or image-ready claim; a deliberate absent daemon stops launch.
test('pylsp fixed immutable PYTHONPATH is set only by owned Docker environment, never inherited', async t => {
  const root = mkdtempSync(join(tmpdir(), 'language-env-')); t.after(() => rmSync(root, { force: true, recursive: true }));
  const ownedRoot = join(root, 'owned'), journals = join(root, 'journal'); mkdirSync(ownedRoot); mkdirSync(journals);
  const driver: LanguageDockerDriver = { engineId: async () => 'engine', inspect: async () => null,
    attach: () => { throw new Error('No real attach'); }, command: async () => { throw new Error('No actual Docker'); } };
  for (const provider of ['pylsp', 'jdt'] as const) {
    const launchId = randomUUID(); mkdirSync(join(ownedRoot, launchId)); for (const dir of ['workspace', 'boot', 'state']) mkdirSync(join(ownedRoot, launchId, dir));
    const p = DockerLanguageProcess.prepare({ launchId, installationId: 'install', engineId: 'engine', projectId: 'project', sessionId: 'session', profileId: 'profile',
      providerGeneration: 'provider', configurationGeneration: 'config', shadowGeneration: 'shadow', connectionGeneration: 'connection', phase: 'completion',
      provider, imageId: `sha256:${'a'.repeat(64)}`, argv: provider === 'pylsp' ? ['/usr/local/bin/python', '-m', 'pylsp'] : ['/opt/jdk27/bin/java', '-version'] },
    { ownedRoot, driver, journal: new DiskLanguageProcessJournal(journals), admission: new LanguageProcessAdmission() });
    // Inspect private fixed builder (test ONLY, no public client/config option was added).
    const args = (p as unknown as { createArgv(): string[] }).createArgv();
    const env = args.flatMap((arg, i) => arg === '--env' ? [args[i+1]] : []);
    assert.equal(env.includes('PYTHONPATH=/opt/pylsp'), provider === 'pylsp'); assert.equal(env.some(s => /\/tmp\/pylsp|TOKEN|KEY/.test(s)), false);
    assert.deepEqual(env.filter(s => s.startsWith('PYTHONPATH=')), provider === 'pylsp' ? ['PYTHONPATH=/opt/pylsp'] : []);
  }
});
