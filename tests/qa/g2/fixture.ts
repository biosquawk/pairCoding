/** Provider-only seam. Never substitutes CoachAdapter, transport, gate, or editor. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { require as tsRequire } from 'tsx/cjs/api';
// Playwright's ESM transform does not load the product's JSON schema import.
// Scoped existing tsx loader executes the real TS module, without editing/bundling product.
const { createPairCoachServer } = tsRequire('../../../src/server/http.ts', import.meta.url) as typeof import('../../../src/server/http');
import type { CoachProvider } from '../../../src/server/coach/provider';
import type { CoachContext } from '../../../src/server/coach/context';
import type { Settings } from '../../../src/shared/protocol';

export const seed = 'value = 0\n# read_only_selection\n' + Array.from({ length: 100 }, (_, i) => `# visible_line_${i}`).join('\n') + '\n';
export const canaries = {
  '.env.qa': 'G2_DENIED_ENV_CANARY', 'private.pem': 'G2_DENIED_PEM_CANARY',
  'private.key': 'G2_DENIED_KEY_CANARY', 'private.pfx': 'G2_DENIED_PFX_CANARY',
  '.git/config': 'G2_DENIED_GIT_CANARY', '.paircoach/secret.txt': 'G2_DENIED_DATA_CANARY',
  'credentials.json': 'G2_DENIED_CREDENTIALS_CANARY',
};
export const approved: Settings = { taskFilePath: 'challenge.md', taskMode: 'IMPLEMENTATION',
  reviewNotesPath: 'review.md', runProfiles: [], aiConsent: true, contextPatterns: ['**/*'] };
export const silent = { kind: 'SILENT', reason: 'Deterministic QA provider, not Gemini' };
const range = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 };
export function edit(context: Readonly<CoachContext>, text = '# g2_coach_first\n') {
  return { kind: 'EDIT', purpose: 'Deterministic provider data through real adapter', path: 'main.py',
    documentVersion: context.documents.find(d => d.path === 'main.py')!.version,
    workspaceVersion: context.workspaceVersion,
    steps: [{ range, textBlock: text }, { range, textBlock: '# g2_coach_second\n' }] };
}
export function hint(context: Readonly<CoachContext>, text = 'G2 anchored hint') {
  return { kind: 'HINT', severity: 'NEUTRAL', text, path: 'main.py',
    documentVersion: context.documents.find(d => d.path === 'main.py')!.version,
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 6 }, showPointer: true, evidenceIds: [] };
}
export type Call = { context: Readonly<CoachContext>; signal: AbortSignal; settled: boolean };
export class Provider implements CoachProvider {
  readonly name = 'G2_PROVIDER_ONLY_TEST_DOUBLE';
  readonly mode = 'INJECTED' as const;
  readonly calls: Call[] = [];
  inFlight = 0; maxInFlight = 0;
  constructor(readonly decideData: (context: Readonly<CoachContext>, signal: AbortSignal) => Promise<unknown> | unknown) {}
  async decide(context: Readonly<CoachContext>, signal: AbortSignal) {
    const call = { context: structuredClone(context), signal, settled: false };
    this.calls.push(call); this.inFlight++; this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try { return await this.decideData(context, signal); }
    finally { this.inFlight--; call.settled = true; }
  }
}
export function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(r => { resolve = r; });
  return { promise, resolve };
}
export async function fixture(provider: CoachProvider, consent = true, staticDir?: string) {
  const runtime = path.resolve('tests/qa/.runtime/g2'); fs.mkdirSync(runtime, { recursive: true });
  const base = fs.mkdtempSync(path.join(runtime, 'case-'));
  const rootPath = path.join(base, 'project'), dataDir = path.join(base, 'data');
  fs.mkdirSync(rootPath); fs.mkdirSync(dataDir);
  for (const [name, value] of Object.entries({ 'main.py': seed, 'challenge.md': '# G2 independent QA\n', ...canaries })) {
    const target = path.join(rootPath, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value);
  }
  // Synthetic ephemeral token, never read from operator environment.
  const token = `g2-qa-${randomUUID()}`;
  const app = createPairCoachServer({ rootPath, dataDir, port: 0, token, devBootstrap: true,
    enableCoach: true, coachProvider: provider, ...(staticDir ? { staticDir } : {}) });
  app.workspace.updateSettings({ ...approved, aiConsent: consent });
  const port = await app.listen();
  const baseURL = `http://127.0.0.1:${port}`;
  const disk = () => fs.readFileSync(path.join(rootPath, 'main.py'), 'utf8').replace(/\r\n/g, '\n');
  const close = () => app.close(); // keep dedicated disk fixture as evidence; no source mutation/cleanup
  return { app, base, rootPath, dataDir, token, port, baseURL, disk, close };
}
