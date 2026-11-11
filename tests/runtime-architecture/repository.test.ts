import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { inspectArchitecture, isProtectedFile, readSources } from './oracle';

test('AC103 actual repository protected boundaries contain no runtime implementation/host/dispatch coupling', () => {
  const sources = readSources(fileURLToPath(new URL('../../', import.meta.url)));
  const roots = [...sources.keys()].filter(isProtectedFile);
  for (const required of ['src/App.tsx', 'src/server/WriteGate.ts', 'src/server/SessionController.ts',
    'src/server/WorkspaceService.ts', 'src/server/Runner.ts', 'src/services/monacoLspBridge.ts',
    'src/services/LiveBackend.ts', 'src/services/PairCoachClient.ts']) assert.ok(roots.includes(required), `Missing boundary ${required}`);
  assert.ok(roots.some(f => f.startsWith('src/components/')), 'No actual components scanned');
  const findings = inspectArchitecture(sources, roots);
  assert.deepEqual(findings, [], JSON.stringify({ scannedRoots: roots, findings }, null, 2));
});
