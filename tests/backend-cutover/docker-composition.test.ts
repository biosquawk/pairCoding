/** Credential-free default composition UNIT/real filesystem; ZERO Docker commands or host tasks. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRuntimeDockerTransport } from '../../src/server/runtime-coordinator/RuntimeDockerTransport';
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-composition-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
test('UNIT missing approved CLI refuses before spawn, creates only dedicated owned empty config, no global env mutation', async t => {
  const root = fixture(t), before = { ...process.env }, transport = createRuntimeDockerTransport({stateDirectory:root,executable:path.join(root, 'missing-docker')});
  assert.deepEqual(fs.readdirSync(path.join(root, 'docker-config')), []);
  await assert.rejects(transport.run(['info']), { code: 'DOCKER_CLI_UNAVAILABLE' });
  assert.ok(JSON.stringify({ ...process.env }) === JSON.stringify(before), 'Global environment unchanged'); assert.deepEqual(fs.readdirSync(root), ['docker-config']);
});
test('UNIT relative override/linked owned config refuses without PATH discovery or credential cleanup', async t => {
  const root = fixture(t);
  assert.throws(() => createRuntimeDockerTransport({stateDirectory:root,executable:'docker'}), { code: 'INVALID_DOCKER_EXECUTABLE' });
  const target = path.join(root, 'target'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'config.json'), 'NEVER_READ');
  fs.symlinkSync(target, path.join(root, 'docker-config'));
  assert.throws(() => createRuntimeDockerTransport({stateDirectory:root}), /Unsafe/);
  assert.equal(fs.readFileSync(path.join(target, 'config.json'), 'utf8'), 'NEVER_READ');
});
test('UNIT default transport construction does not inspect Docker or copy inherited credentials/endpoint', t => {
  const root = fixture(t), before = { ...process.env };
  assert.equal(typeof createRuntimeDockerTransport({stateDirectory:root}).run, 'function');
  assert.deepEqual(fs.readdirSync(path.join(root, 'docker-config')), []); assert.ok(JSON.stringify({ ...process.env }) === JSON.stringify(before), 'Global environment unchanged');
});
test('UNIT dirty dedicated config is refused WITHOUT reading/deleting contents or attempting CLI', t => {
  const root = fixture(t), config = path.join(root, 'docker-config'); fs.mkdirSync(config, { mode:0o700 });
  const unexpected = path.join(config, 'unexpected.txt'); fs.writeFileSync(unexpected, 'KEEP');
  assert.throws(() => createRuntimeDockerTransport({stateDirectory:root,executable:path.join(root,'missing')}), {code:'DOCKER_CLIENT_CONFIG_DIRTY'});
  assert.equal(fs.readFileSync(unexpected, 'utf8'), 'KEEP');
});
