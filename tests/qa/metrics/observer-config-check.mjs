/** RO check using the actually installed Playwright config + suite loader, no servers/browsers. */
import { createRequire } from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const common = require(path.join(path.dirname(require.resolve('playwright/package.json')), 'lib/common/index.js'));
const result = [];
for (const [config, file, count] of [
  ['tests/qa/metrics.config.ts', 'tests/qa/metrics/reference.spec.ts', 3],
  ['tests/qa/metrics/calibration.config.ts', 'tests/qa/metrics/calibration.spec.ts', 1],
  ['tests/qa/metrics/performance.config.ts', 'tests/qa/metrics/reference.spec.ts', 3],
]) {
  const resolved = await common.configLoader.loadConfigFromFile(path.resolve(config));
  const project = resolved.projects[0];
  assert.equal(resolved.webServers.length, 1);
  assert.equal(resolved.webServers[0].env.PAIRCOACH_QA_REFERENCE, '1');
  assert.equal(resolved.webServers[0].reuseExistingServer, false);
  assert.equal(path.resolve(resolved.webServers[0].cwd), process.cwd());
  assert.equal(project.project.timeout, 180000); assert.equal(project.expect.timeout, 5000);
  assert.equal(project.project.retries, 0); assert.equal(resolved.config.workers, 1);
  const suite = await common.testLoader.loadTestFile(path.resolve(file), resolved);
  const errors = [];
  common.poolBuilder.PoolBuilder.createForWorker(project).buildPools(suite, errors);
  assert.deepEqual(errors, []);
  const tests = suite.allTests(); assert.equal(tests.length, count);
  const effective = await Promise.all(tests.map(async (test) => {
    const chain = []; for (let s = test.parent; s; s = s.parent) chain.unshift(s);
    const use = { ...project.project.use };
    for (const s of chain) for (const item of s._use) Object.assign(use, item.fixtures);
    const registration = test._pool.resolve('trace');
    assert.notEqual(typeof registration.fn, 'function', 'The actual Playwright worker rejects function-valued trace options');
    use.trace = registration.fn;
    use.screenshot = test._pool.resolve('screenshot').fn;
    const trace = config.endsWith('/performance.config.ts') ? 'off' : 'retain-on-failure';
    assert.equal(use.trace, trace); assert.equal(use.screenshot, 'only-on-failure');
    return { title: test.title, trace: use.trace, screenshot: use.screenshot };
  }));
  if (config.endsWith('/performance.config.ts')) {
    assert.equal(String(project.project.grep), '/AC-027 TEST-027:/');
    assert.equal(tests.filter(test => project.project.grep.test(test.title)).length, 1);
  }
  result.push({ config, webServers: resolved.webServers, workers: resolved.config.workers,
    timeout: project.project.timeout, expectTimeout: project.expect.timeout, retries: project.project.retries, tests: effective });
}
console.log(JSON.stringify(result, null, 2));
