/**
 * Isolated browser fixture: REAL HTTP/WS + workspace + gate + React/Monaco.
 * Only the coach provider/coordinator is deterministic and manually triggered.
 * This proves client/gate races, NOT Gemini or autonomous coach integration.
 * No test endpoints are added. QA commands use the ordinary authenticated chat.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createPairCoachServer, type ServiceContext, type CoachService } from '../../../src/server/http';
import type { ChatEntry } from '../../../src/shared/protocol';

const runtime = path.resolve('tests/qa/.runtime');
fs.mkdirSync(runtime, { recursive: true });
const base = fs.mkdtempSync(path.join(runtime, 'browser-'));
const rootPath = path.join(base, 'project'), dataDir = path.join(base, 'data');
fs.mkdirSync(rootPath); fs.mkdirSync(dataDir);
const reference = process.env.PAIRCOACH_QA_REFERENCE === '1';
const main = reference ? 'value = 0\n' + '# reference filler '.padEnd(78, '.') .concat('\n').repeat(1150) : 'value = 0\n';
fs.writeFileSync(path.join(rootPath, 'challenge.md'), '# QA fixture\nEdit main.py. This is not a real training result.\n');
fs.writeFileSync(path.join(rootPath, 'main.py'), main);
if (reference) for (let i = 0; i < 98; i++) fs.writeFileSync(path.join(rootPath, `reference-${i}.txt`), `fixture ${i}\n`);
const manifest = { rootPath, dataDir, base, reference, mainBytes: Buffer.byteLength(main),
  fileCount: reference ? 100 : 2, vetoCutoffMs: [] as number[], committedSteps: [] as { id: string; epoch: number; version: number }[] };
const manifestPath = path.join(runtime, 'browser-manifest.json');
const saveManifest = () => {
  const temporary = `${manifestPath}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  fs.renameSync(temporary, manifestPath);
};
saveManifest();
let hintCounter = 0;

function fixtureCoach(ctx: ServiceContext): CoachService {
  ctx.workspace.updateSettings({ ...ctx.workspace.settings, aiConsent: true });
  ctx.session.setAiStatus('READY'); // deterministic fixture provider; NOT real Gemini readiness
  // Upper-bound timing of the actual synchronous cutoff path, no replacement implementation.
  const veto = ctx.session.veto.bind(ctx.session);
  ctx.session.veto = () => {
    const started = performance.now(); const result = veto();
    manifest.vetoCutoffMs.push(performance.now() - started); saveManifest(); return result;
  };
  let plan: { requestId: string; interventionId: string; workspaceVersion: number; epoch: number | null; step: number; stepId: string | null } | null = null;
  let next: ReturnType<typeof setTimeout> | undefined;
  function abort() { clearTimeout(next); plan = null; }
  function step() {
    if (!plan || plan.epoch === null) return;
    const state = ctx.session.getSession();
    if (state.controlEpoch !== plan.epoch || state.writeOwner !== 'COACH') { abort(); return; }
    const before = ctx.workspace.getDocument('main.py');
    const textBlock = `# coach_fixture_step_${++plan.step}\n`;
    const line = before.content.split('\n').length;
    const after = ctx.gate.write({ clientId: ctx.session.leaseClientId!, sessionId: state.sessionId,
      actor: 'COACH', controlEpoch: plan.epoch, path: 'main.py', baseVersion: before.version,
      content: before.content + textBlock });
    const stepId = randomUUID(); plan.stepId = stepId;
    manifest.committedSteps.push({ id: stepId, epoch: plan.epoch, version: after.version }); saveManifest();
    ctx.emit('COACH_STEP_EDIT', { stepId, interventionId: plan.interventionId, controlEpoch: plan.epoch,
      path: 'main.py', baseVersion: before.version, version: after.version, workspaceVersion: ctx.workspace.workspaceVersion,
      range: { startLine: line, startColumn: 1, endLine: line, endColumn: 1 }, textBlock,
      contentHash: createHash('sha256').update(after.content).digest('hex') });
  }
  return {
    trigger(reason: string, message?: ChatEntry) {
      if (reason !== 'CHAT') return;
      if (message?.text === 'QA:HINT') {
        const doc = ctx.workspace.getDocument('main.py');
        ctx.emit('COACH_HINT_BUBBLE', { id: randomUUID(), severity: 'NEUTRAL', text: `QA_HINT_RENDER_${++hintCounter}`,
          path: doc.path, documentVersion: doc.version, range: null, evidenceIds: [] });
      } else if (message?.text === 'QA:DEMO') {
        abort();
        plan = { requestId: randomUUID(), interventionId: randomUUID(), workspaceVersion: ctx.workspace.workspaceVersion,
          epoch: null, step: 0, stepId: null };
        ctx.emit('CONTROL_PREPARE', { requestId: plan.requestId, purpose: 'QA manually requested real committed demonstration',
          path: 'main.py', basedOnWorkspaceVersion: plan.workspaceVersion });
      }
    },
    controlReady(payload) {
      if (!plan || payload.requestId !== plan.requestId) return;
      if (!payload.ready || payload.workspaceVersion !== plan.workspaceVersion || ctx.workspace.workspaceVersion !== plan.workspaceVersion) { abort(); return; }
      plan.epoch = ctx.session.acquireCoach(plan.interventionId); step();
    },
    stepRendered(payload) {
      if (!plan || payload.stepId !== plan.stepId || payload.interventionId !== plan.interventionId) return;
      if (payload.documentVersion !== ctx.workspace.getDocument('main.py').version) return;
      if (plan.step >= 2) { abort(); ctx.session.releaseCoach(); }
      else next = setTimeout(step, 300); // presentation pacing, not a network latency injection
    },
    abort, close: abort,
  };
}
const port = Number(process.env.PAIRCOACH_QA_PORT || 8080);
if ([8765, 8766, 8767, 8768].includes(port)) throw new Error('Reserved platform port forbidden');
if (!fs.existsSync('dist/index.html')) throw new Error('Build missing: run npm run build before browser fixture');
const app = createPairCoachServer({ rootPath, dataDir, port, staticDir: path.resolve('dist'),
  devBootstrap: true, enableCoach: true, coachFactory: fixtureCoach });
const actual = await app.listen();
console.log(`QA real backend + built frontend ready at http://127.0.0.1:${actual}; fixture=${base}; reference=${reference}`);
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await app.close(); saveManifest();
  // Preserve the browser fixture for disk/manifest evidence; ignored .runtime is never committed.
  process.exitCode = 0;
}
process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
