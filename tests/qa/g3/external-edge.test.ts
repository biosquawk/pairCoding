// Pure QA setup controls. No browser is launched and no native visibility/teardown PASS is implied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { debugEndpoint, edgeArguments } from './external-edge';

test('QA external Edge arguments use one unique profile, ephemeral loopback debugger and no focus/headless/remote overrides', () => {
  const profile = 'C:\\QA fixtures\\owned-edge-UNIQUE';
  const args = edgeArguments(profile);
  assert.ok(args.includes('--remote-debugging-port=0'));
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.deepEqual(args.filter(a => a.startsWith('--user-data-dir=')), ['--user-data-dir=' + profile]);
  assert.equal(args.at(-1), 'about:blank');
  assert.equal(args.some(a => /headless|focus|no-sandbox|disable-web-security|remote-allow-origins/.test(a)), false);
  assert.ok(!args.includes('--disable-backgrounding-occluded-windows'));
  assert.ok(!args.includes('--disable-renderer-backgrounding'));
  assert.notDeepEqual(edgeArguments('OTHER_PROFILE'), args);
});

test('QA debugger endpoint accepts only a port, never an external URL/address/argv from the owned file', () => {
  assert.equal(debugEndpoint('43827\r\n/devtools/browser/id\r\n'), 'http://127.0.0.1:43827');
  assert.equal(debugEndpoint('1\n/path'), 'http://127.0.0.1:1');
  assert.equal(debugEndpoint('65535\n/path'), 'http://127.0.0.1:65535');
  for (const invalid of ['', '0', '-1', '65536', '70000', '123456', '12.5', ' 43827', '43827 ', 'https://elsewhere:1', '123;command', '1 2']) {
    assert.throws(() => debugEndpoint(invalid), /Invalid owned Edge debugging port/);
  }
});
