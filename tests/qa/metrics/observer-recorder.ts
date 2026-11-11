import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Page, TestInfo } from '@playwright/test';

export const digest = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
export const sourceHashes = () => Object.fromEntries(['reference.spec.ts', 'observer.ts', 'observer-predicates.ts',
  'observer-recorder.ts', 'calibration.spec.ts', 'calibration.config.ts', '../metrics.config.ts', '../../../playwright.config.ts'].map(file => [file, digest(readFileSync(`tests/qa/metrics/${file}`))]));
export const percentile = (values: any[]) => ({ count: values.length,
  missingOrInvalid: values.filter(v => !Number.isFinite(v) || v < 0).length,
  p95: values.length && values.every(v => Number.isFinite(v) && v >= 0)
    ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1] : null,
  max: values.length && values.every(v => Number.isFinite(v) && v >= 0) ? Math.max(...values) : null });

/** Full texts stay in process for exact comparisons; durable wire data are allowlisted + SHA256. */
export class MetricRecorder {
  errors: any[] = [];
  events: any[] = [];
  saves: any[] = [];
  private raw: any[] = [];
  readonly streamPath: string;
  constructor(readonly info: TestInfo) {
    this.streamPath = info.outputPath('AC027-wire-and-dom.jsonl');
    writeFileSync(this.streamPath, '');
  }
  private redact(entry: any) {
    const clean = { ...entry };
    for (const key of ['content', 'localContent', 'diskContent']) if (typeof clean[key] === 'string') {
      const content = clean[key]; delete clean[key];
      clean[`${key}Evidence`] = { sha256: digest(content), bytesUTF8: Buffer.byteLength(content), length: content.length,
        markerLines: content.split('\n').filter((line: string) => /^# (qa_probe_|qa_calibration_)/.test(line)) };
    }
    return clean;
  }
  record(batch: any[]) {
    try {
      const safe = batch.map(e => this.redact(e));
      appendFileSync(this.streamPath, safe.map(e => JSON.stringify(e)).join('\n') + '\n');
      this.raw.push(...batch); this.events.push(...safe);
    } catch (e) { this.errors.push({ stage: 'durableStream', name: (e as Error).name }); throw e; }
  }
  async install(page: Page) {
    await page.exposeBinding('__qaMetricRecord', (_source, batch: any[]) => this.record(batch));
  }
  save(trial: number, content: string, completed: boolean) {
    const record = { kind: 'diskReadback', trial, completed, atWall: new Date().toISOString(),
      sha256: digest(content), bytesUTF8: Buffer.byteLength(content) };
    this.saves.push({ ...record, content }); this.record([record]);
  }
  pairs(trials: any[]) {
    const acks = this.raw.filter(e => e.kind === 'wire' && e.direction === 'in' && e.type === 'ACK');
    const writes = this.raw.filter(e => e.kind === 'wire' && e.direction === 'out' && e.type === 'CODE_CHANGED');
    return trials.map(trial => {
      const decision = [...this.raw].reverse().find(e => e.kind === 'choice' && e.trial === trial.trial);
      const after = decision?.choice === 'KEEP_LOCAL' ? decision.at : 0;
      const expected = decision?.choice === 'KEEP_LOCAL' ? decision.localContent : null;
      const read = [...this.saves].reverse().find(s => s.trial === trial.trial);
      return { trial: trial.trial, marker: trial.marker, after, expectedSHA256: typeof expected === 'string' ? digest(expected) : null,
        choice: decision?.choice ?? null, disk: read ? this.redact({ ...read, content: read.content }) : null,
        writes: writes.filter(w => w.trial === trial.trial).map(w => {
          const replies = acks.filter(a => a.payload.replyTo === w.messageId);
          return { write: this.redact(w),
            filters: { path: w.payload.path === 'main.py', sentAfterDecision: w.at >= after,
              exactMarker: w.content.includes(`# ${trial.marker}\n`), expectedContent: expected === null || w.content === expected,
              matchingAckPresent: replies.length > 0, exactDisk: Boolean(read && read.content === w.content),
              completedOracle: read?.completed === true },
            acknowledgements: replies.map(a => ({ ack: a, filters: {
              replyTo: a.payload.replyTo === w.messageId, statusOK: a.payload.status === 'OK', errorNull: a.payload.error === null,
              versionGreater: a.payload.documentVersion > w.payload.baseVersion,
              epochEqual: a.payload.controlEpoch === w.payload.controlEpoch, receiveAfterSend: a.at >= w.at,
              sameSession: a.sessionId === w.sessionId, sameConnection: a.connection === w.connection,
            } })), missingAck: replies.length === 0 };
        }) };
    });
  }
  staleRendered(trials: any[]) {
    return trials.flatMap(v => v.veto?.activeInterventionId ? this.events.filter(e => e.kind === 'wire'
      && e.direction === 'out' && e.type === 'STEP_RENDERED' && e.at >= v.veto.at
      && e.sessionId === v.veto.sessionId && e.payload.interventionId === v.veto.activeInterventionId)
      .map(event => ({ trial: v.trial, revokedIntervention: v.veto.activeInterventionId, event })) : []);
  }
  recoverObserved(previous: any) {
    const vetoes: any[] = [];
    const hints: any[] = [];
    const connections: any[] = [];
    let identity: any = previous?.identity ?? null;
    for (const e of this.raw) {
      const v = vetoes.find(v => v.trial === e.trial);
      if (e.kind === 'armed') vetoes.push({ trial: e.trial, marker: e.marker, baseline: e.baseline,
        validBase: e.validBase, ownerWasCoach: e.validBase, localMs: null, ackMs: null, secondEscapeAt: null, keys: [], veto: null });
      if (e.kind === 'key' && v) v.keys.push(e);
      if (e.kind === 'secondEscape' && v) { v.secondEscapeAt = e.at; v.validAtEscape = e.validAtEscape; v.escapeState = e.state; }
      if (e.kind === 'ready' && v) { v.localMs = e.observedAt - v.secondEscapeAt; v.readiness = e; }
      if (e.kind === 'vetoAck' && v) { (v.ackFilters ||= []).push(e); if (e.ackMs !== null) v.ackMs = e.ackMs; }
      if (e.kind === 'open') connections.push({ connection: e.connection, openedAt: e.at, closedAt: null });
      if (e.kind === 'close') { const c = connections.find(c => c.connection === e.connection); if (c) c.closedAt = e.at; }
      if (e.kind === 'wire') {
        if (e.identity && !identity) identity = e.identity;
        if (e.direction === 'out' && e.type === 'VETO_ESCAPE' && v) { v.messageId = e.messageId; v.veto = { ...e, ...e.payload }; }
        if (e.hint) hints.push({ ...e.hint });
      }
      if (e.kind === 'hintRenderRejected') { const h = hints.find(h => h.id === e.id); if (h) { h.valid = false; h.renderFilters = e.filters; } }
      if (e.kind === 'hintRendered') { const h = hints.find(h => h.id === e.id); if (h) { h.renderMs = e.renderMs; h.renderedAt = e.at; } }
    }
    // A final successful snapshot has richer failed-predicate detail, but never hides a streamed start.
    const combined = vetoes.map(v => ({ ...(previous?.vetoes?.find((old: any) => old.trial === v.trial) || {}), ...v }));
    return { ...(previous || {}), vetoes: combined, hints: hints.map(h => ({ ...(previous?.hints?.find((old: any) => old.id === h.id) || {}), ...h })), identity,
      connections: previous?.connections || connections, recordingErrors: previous?.recordingErrors || [], streamRecovery: true };
  }
  async snapshot(page: Page) {
    return page.evaluate(async () => {
      const recorder = (window as any).__qaMetric;
      if (!recorder) throw new Error('Metric observer absent');
      // Await outstanding delivery, but preserve evidence even if flush reports a recording error.
      try { await recorder.flush(); } catch { /* recordingErrors below is fatal at acceptance */ }
      return recorder.output;
    });
  }
  async report(name: string, report: any) {
    const artifact = this.info.outputPath(`${name}.json`);
    try { writeFileSync(artifact, JSON.stringify(report, null, 2)); }
    catch (e) { this.errors.push({ stage: 'reportWrite', name: (e as Error).name }); throw e; }
    await this.info.attach(name, { path: artifact, contentType: 'application/json' });
  }
}
