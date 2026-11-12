/** Neutral run lifecycle. This class never starts a host task or chooses a language/tool/image. */
import { randomUUID } from 'node:crypto';
import type { RunProfileV2, RunRequestV2, RunV2, RuntimeProblem, RuntimeProfile } from '../../shared/runtime-v2';
import type { AdapterOutcome, AcknowledgedRunInput, CollectedArtifacts, DurableTerminalReceipt, DurableUnstartedCancellationReceipt,
  ExecutionExit, ExecutionHandle, ExecutionPlan, ExecutionPort, PlanContext, TaskRuntimeAdapter } from '../execution/ports';
import { validateRunV2 } from '../../shared/validation-v2';
import { AppError, validId } from '../errors';
import { canonicalJson, sha256 } from '../execution/files';

export interface RuntimeRunAdmission {
  projectId: string;
  request: RunRequestV2;
  profile: RuntimeProfile;
  runProfile: RunProfileV2;
  adapter: TaskRuntimeAdapter;
  /** Must capture under the real WriteGate lease; includes exact approved ownership/cache/image data. */
  capture(runId: string): Promise<PlanContext>;
  /** Revalidate current project/session/configuration/settings AFTER each awaited pre-start step. */
  assertCurrent(): void;
  /** Synchronous durable original QUEUED acceptance, after final validated immutable plan,
   * before ANY execution.start. Throwing must prevent the process invocation. Internal only. */
  admitOriginal?(run: RunV2, plan: ExecutionPlan): void;
}
export interface RuntimeRunnerOptions {
  execution: ExecutionPort;
  getWorkspaceVersion(): number;
  emit(type: 'RUN_STATE' | 'RUN_OUTPUT', payload: unknown): void;
  /** Exact frozen DockerExecutor helper. Receipts are never minted/cast in this coordinator. */
  persistTerminal(handle: ExecutionHandle, outcome: AdapterOutcome): Promise<DurableTerminalReceipt>;
  /** Durable private original Stop intent/final public state, never a terminal receipt. */
  retainState?(plan: ExecutionPlan, run: RunV2, requested: 'USER'|'TIMEOUT'|null): void;
  now?: () => number;
  newRunId?: () => string;
}
type Job = {
  sessionId: string; run: RunV2; plan: ExecutionPlan | null; adapter: TaskRuntimeAdapter;
  handle: ExecutionHandle | null; exit: ExecutionExit | null; collection: CollectedArtifacts | null;
  outcome: AdapterOutcome | null; receipt: DurableTerminalReceipt | null;
  attemptedStart: boolean; starting: boolean; requested: 'USER' | 'TIMEOUT' | null; outputSeq: number;
  timer?: ReturnType<typeof setTimeout>; poll?: ReturnType<typeof setInterval>;
  unsubscribe?: () => void; waitAbort: AbortController;
  stopAttempt?: Promise<void>; settlement?: Promise<void>;
};
const snapshot = <T>(value: T): T => structuredClone(value);
const sameHandle = (a: ExecutionHandle, b: ExecutionHandle) => a.runId === b.runId && a.opaqueId === b.opaqueId;
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b,k) && same((a as Record<string,unknown>)[k],(b as Record<string,unknown>)[k]));
};
function requireThat(ok: unknown, message: string): asserts ok { if (!ok) throw new AppError(409,'RUN_INPUT_CHANGED',message); }
const problem = (code: string, message: string): RuntimeProblem => ({ code,message,
  recovery:'Retry Stop for this same Run; retain ownership and the original request. Manual editing remains available.',retryable:true });
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

export class RuntimeRunner {
  private jobs = new Map<string,Job>();
  private readonly unsettled = new Set<Job>();
  private readonly now: () => number;
  constructor(private readonly options: RuntimeRunnerOptions) { this.now = options.now ?? Date.now; }

  /** Reservation/singleflight happens before the first await, not after expensive capture. */
  async start(admission: RuntimeRunAdmission): Promise<RunV2> {
    if (this.unsettled.size) throw new AppError(409,'RUN_IN_PROGRESS','Inne uruchomienie jest nadal aktywne.');
    const projectId = admission.projectId;
    const request = freeze(snapshot(admission.request)), profile = freeze(snapshot(admission.profile));
    const runProfile = freeze(snapshot(admission.runProfile));
    admission.assertCurrent();
    requireThat(request.mode === runProfile.kind && admission.adapter.family===profile.adapterFamily && validId(projectId) && validId(request.configurationGeneration) && validId(profile.id) &&
      Number.isSafeInteger(runProfile.timeoutMs) && runProfile.timeoutMs >= 1000 && runProfile.timeoutMs <= 300000,
    'Run admission does not match approved mode/configuration.');
    const runId = (this.options.newRunId ?? randomUUID)();
    requireThat(validId(runId) && !this.jobs.has(runId),'Run identity collision.');
    const job: Job = { sessionId:request.sessionId, run:{runId,mode:request.mode,status:'QUEUED',exitCode:null,
      workspaceVersionAtStart:request.expectedWorkspaceVersion,workspaceChangedDuringRun:false,
      testOutcome:request.mode==='RUN_TESTS'?'UNKNOWN':'NOT_APPLICABLE',testCount:null,outputTail:'',outputTruncated:false,
      startedAt:null,finishedAt:null,profileId:profile.id,configurationGeneration:request.configurationGeneration,
      processProblem:null,serviceReadiness:null}, plan:null,adapter:admission.adapter,handle:null,exit:null,
      collection:null,outcome:null,receipt:null,attemptedStart:false,starting:false,requested:null,outputSeq:0,waitAbort:new AbortController() };
    this.unsettled.add(job); this.jobs.set(runId,job); this.emitState(job);
    try {
      const validation=await admission.adapter.validate(snapshot(profile),snapshot(runProfile));
      admission.assertCurrent();
      if (!validation.valid) throw new AppError(409,validation.problem?.code??'TASK_CONFIG_INVALID','Approved task configuration is invalid.');
      const ready=await this.options.execution.readiness(snapshot(profile),request.configurationGeneration);
      admission.assertCurrent();
      requireThat(ready.configurationGeneration===request.configurationGeneration,'Readiness belongs to another configuration.');
      if (!ready.modes[request.mode].canRun) throw new AppError(503,ready.modes[request.mode].problem?.code??'PREPARE_REQUIRED','Runtime is not ready.');
      const context=await admission.capture(runId);
      admission.assertCurrent();
      this.checkContext(context,request,profile,runId,projectId);
      const plan=await admission.adapter.buildPlan(snapshot(context),snapshot(runProfile));
      admission.assertCurrent();
      requireThat(same(plan.ownership,context.ownership) && same(plan.input,context.input) && same(plan.profile,profile) &&
        same(plan.lockedImage,context.lockedImage) && same(plan.caches,context.caches) &&
        plan.mode===request.mode && plan.timeoutMs===runProfile.timeoutMs,'Adapter substituted approved plan authority.');
      job.plan=freeze(snapshot(plan));
      if (job.requested) throw new AppError(409,'RUN_CANCELLED_BEFORE_START','Run was cancelled before any process start.');
      admission.assertCurrent();
      admission.admitOriginal?.(snapshot(job.run), snapshot(job.plan));
      // No await between original acceptance and attemptedStart. Acceptance is not a claim
      // that a process started/finished; later/current Run state is a separate projection.
      // Set before calling the port. A rejected/lost start is NOT proof that no container was created.
      job.attemptedStart=true; job.starting=true;
      let handle: ExecutionHandle;
      try { handle=await this.options.execution.start(snapshot(job.plan)); } finally { job.starting=false; }
      requireThat(handle.runId===runId && validId(handle.opaqueId),'Execution returned another Run handle.');
      job.handle=freeze(snapshot(handle));
      this.observe(job);
      if(job.requested) await this.stopReason(job,job.requested);
      return this.get(runId);
    } catch (error) {
      if (job.attemptedStart) {
        this.uncertain(job,'RUN_START_UNCONFIRMED','Container creation/start is uncertain; no blind retry.');
        return this.get(runId);
      }
      // No execution.start invocation occurred. Failure here is an actual no-process admission failure.
      this.release(job);
      this.jobs.delete(runId);
      throw error;
    }
  }
  /** Trusted startup join only. Does not call start/subscribe/wait/Stop/collect/cleanup.
   * Unconfirmed owners remain separately retained until explicit same-owner Stop. */
  restore(input: { sessionId:string; original:RunV2; plan:ExecutionPlan; adapter:TaskRuntimeAdapter;
    handle:ExecutionHandle|null; exit:ExecutionExit|null; collection:CollectedArtifacts|null;
    outcome:AdapterOutcome|null; removed:boolean; noProcess:boolean; cancellation?:DurableUnstartedCancellationReceipt|null;
    retained:{run:RunV2;requested:'USER'|'TIMEOUT'|null}|null }):void {
    const r={...snapshot({...input,adapter:undefined}),adapter:input.adapter}, run=r.retained?.run ?? r.original;
    requireThat(!this.jobs.has(run.runId) && validateRunV2(run) && run.runId===r.plan.ownership.runId &&
      r.plan.input.sessionId===r.sessionId && r.adapter.family===r.plan.profile.adapterFamily,'Invalid restored Run owner');
    const job:Job={sessionId:r.sessionId,run,plan:freeze(r.plan),adapter:input.adapter,handle:r.handle,exit:r.exit,
      collection:r.collection,outcome:r.outcome,receipt:null,attemptedStart:!r.noProcess,starting:false,
      requested:r.retained?.requested??null,outputSeq:0,waitAbort:new AbortController()};
    if(r.noProcess) {
      // The composition proves exclusion + ORIGINAL_RUN_ADMISSION + complete executor
      // journal absence BEFORE any create. No exit code/receipt is invented.
      job.run.status='CANCELLED';job.run.finishedAt ??=new Date(this.now()).toISOString();
      job.run.processProblem=problem('RUN_NOT_DISPATCHED','Original accepted Run has no executor intent; no process effect was dispatched.');
      this.options.retainState?.(snapshot(job.plan!),snapshot(job.run),job.requested);
    } else if(r.cancellation) {
      requireThat(r.removed && r.handle && same(r.handle,r.cancellation.handle) && !r.exit && !r.collection && !r.outcome,
        'Cancellation is not a process exit/collection');
      this.applyCancellation(job,input.cancellation!);
    } else if(r.removed) {
      requireThat(r.handle && r.exit && r.collection && r.outcome,'Removed Run lacks durable terminal facts');
      const terminal=r.retained?.run;
      if(terminal?.finishedAt) {
        requireThat(terminal.exitCode===r.exit.exitCode && terminal.status===(job.requested==='USER'?'CANCELLED':job.requested==='TIMEOUT'?'TIMED_OUT':r.outcome.status) &&
          terminal.testOutcome===(job.requested?(run.mode==='RUN_TESTS'?'UNKNOWN':'NOT_APPLICABLE'):r.outcome.testOutcome) &&
          terminal.testCount===(job.requested?null:r.outcome.testCount) && same(terminal.processProblem,r.outcome.problem),
          'Retained terminal Run differs from executor journal');
      } else {
        job.run.status=job.requested==='USER'?'CANCELLED':job.requested==='TIMEOUT'?'TIMED_OUT':r.outcome.status;
        job.run.exitCode=r.exit.exitCode;job.run.finishedAt=r.exit.exitedAt;
        job.run.testOutcome=job.requested?(run.mode==='RUN_TESTS'?'UNKNOWN':'NOT_APPLICABLE'):r.outcome.testOutcome;
        job.run.testCount=job.requested?null:r.outcome.testCount;job.run.processProblem=r.outcome.problem;
      }
      job.run.serviceReadiness=null;
      this.options.retainState?.(snapshot(job.plan!),snapshot(job.run),job.requested);
    } else {
      requireThat(!run.finishedAt,'Public terminal state cannot precede executor removal');
      job.run.status='PROCESS_STOP_UNCONFIRMED';job.run.finishedAt=null;job.run.serviceReadiness=null;
      job.run.processProblem=problem('PROCESS_STOP_UNCONFIRMED','Recovered original Run ownership; explicitly Stop/reconcile this same Run, never replay create/start.');
      this.unsettled.add(job);
    }
    requireThat(validateRunV2(job.run),'Recovered Run violates V2');
    this.jobs.set(run.runId,job);
  }
  private checkContext(context: PlanContext, request: RunRequestV2, profile: RuntimeProfile, runId: string, projectId: string): void {
    const input: AcknowledgedRunInput=context.input;
    requireThat(context.ownership.runId===runId && context.ownership.profileId===profile.id &&
      input.identity.runId===runId && input.identity.profileId===profile.id &&
      input.identity.configurationGeneration===request.configurationGeneration && input.sessionId===request.sessionId && input.projectId===projectId &&
      input.identity.workspaceVersion===request.expectedWorkspaceVersion && same(context.profile,profile),
    'Capture substituted Run/session/profile/workspace authority.');
  }
  private observe(job: Job): void {
    job.run.status='RUNNING'; job.run.processProblem=null; job.run.startedAt ??= new Date(this.now()).toISOString();
    this.options.retainState?.(snapshot(job.plan!),snapshot(job.run),job.requested);
    job.unsubscribe=this.options.execution.subscribe(job.handle!,output=>this.output(job,output.stream,output.text));
    job.poll=setInterval(()=>this.checkVersion(job),20);job.poll.unref();
    job.timer=setTimeout(()=>{ void this.stopReason(job,'TIMEOUT').catch(()=>{}); },job.plan!.timeoutMs);job.timer.unref();
    this.emitState(job);
    void this.options.execution.serviceReadiness(job.handle!).then(value=>{
      if (!this.unsettled.has(job) || job.exit || !value) return;
      requireThat(sameHandle(value.handle,job.handle!),'Service readiness belongs to another Run.');
      job.run.serviceReadiness={ready:value.ready,url:value.url};
      if (value.problem) job.run.processProblem=snapshot(value.problem);
      this.emitState(job);
    }).catch(()=>{
      if (this.unsettled.has(job) && !job.exit) { job.run.processProblem=problem('SERVICE_READINESS_UNAVAILABLE','Service readiness is unavailable, not process completion.');this.emitState(job); }
    });
    void this.options.execution.wait(job.handle!,job.waitAbort.signal).then(async exit=>{
      if (!this.unsettled.has(job)) return;
      this.acceptExit(job,exit);
      if (job.stopAttempt) await job.stopAttempt.catch(()=>{});
      await this.settle(job);
    }).catch(()=>{ if(this.unsettled.has(job)) this.uncertain(job,'RUN_EXIT_UNCONFIRMED','Process exit or terminal settlement is not confirmed.'); });
  }
  private acceptExit(job: Job, exit: ExecutionExit): void {
    requireThat(job.handle && sameHandle(exit.handle,job.handle) && Number.isSafeInteger(exit.exitCode) &&
      typeof exit.exitedAt==='string' && Number.isFinite(Date.parse(exit.exitedAt)) && (!job.exit || same(job.exit,exit)),
    'Exit does not match retained Run.');
    job.exit=freeze(snapshot(exit));
    clearTimeout(job.timer);
  }
  get(runId: string): RunV2 { const job=this.job(runId);this.checkVersion(job);return snapshot(job.run); }
  list(sessionId?: string): RunV2[] { return [...this.jobs.values()].filter(j=>sessionId===undefined || j.sessionId===sessionId).map(j=>this.get(j.run.runId)); }
  belongsToSession(runId:string, sessionId:string):boolean { return this.jobs.get(runId)?.sessionId===sessionId; }
  async stop(runId: string): Promise<RunV2> { return this.stopReason(this.job(runId),'USER'); }
  async stopAll(): Promise<void> { for(const job of [...this.unsettled]) await this.stop(job.run.runId); }
  private async stopReason(job: Job, reason: 'USER'|'TIMEOUT'): Promise<RunV2> {
    if (!this.unsettled.has(job)) return this.get(job.run.runId);
    if (!job.exit && !job.requested) {
      // Persist intent BEFORE the first Stop effect. Restart must not turn a user Stop into success.
      if(job.plan)this.options.retainState?.(snapshot(job.plan),snapshot(job.run),reason);
      job.requested=reason;
    }
    clearTimeout(job.timer);
    // Start is awaiting capture/port: do not report a terminal result or start another Run.
    if (!job.attemptedStart || job.starting || !job.plan) throw new AppError(409,'RUN_ADMISSION_PENDING','Run admission has not settled; retain this Run.');
    if (!job.stopAttempt) {
      job.run.status='STOPPING';this.emitState(job);
      const attempt=(async()=>{
        if (!job.handle) {
          const orphans=await this.options.execution.inspectOwnedOrphans(job.plan!.ownership.installationId);
          const matching=orphans.filter(o=>same(o.ownership,job.plan!.ownership));
          requireThat(matching.length===1 && matching[0].handle.runId===job.run.runId && validId(matching[0].handle.opaqueId),
            'Uncertain start has no unique exact-owned recovery handle.');
          job.handle=freeze(snapshot(matching[0].handle));
        }
        if (!job.exit) {
          if(job.run.startedAt===null && this.options.execution.recoverUnstarted) {
            const recovered=await this.options.execution.recoverUnstarted(job.handle);
            if(recovered.confirmed) {
              this.applyCancellation(job,recovered.receipt);
              this.release(job);this.emitState(job);return;
            }
          }
          const stopped=await this.options.execution.stop(job.handle,reason);
          if (stopped.confirmed===true) this.acceptExit(job,stopped.exit);
          else if (!job.exit) throw new AppError(503,'PROCESS_STOP_UNCONFIRMED','Container Stop is not confirmed.');
        }
      })();
      job.stopAttempt=attempt;
      try { await attempt; }
      catch(error) {
        // A concurrent real wait may have established exit independently of a lost Stop response.
        if (!job.exit) { this.uncertain(job,'PROCESS_STOP_UNCONFIRMED','Container Stop is not confirmed.');throw error; }
      } finally { if(job.stopAttempt===attempt) job.stopAttempt=undefined; }
    } else await job.stopAttempt;
    if(this.unsettled.has(job))await this.settle(job);
    return this.get(job.run.runId);
  }
  private applyCancellation(job:Job,receipt:DurableUnstartedCancellationReceipt):void {
    requireThat(job.handle && job.plan && sameHandle(job.handle,receipt.handle) && same(job.plan.ownership,receipt.ownership) &&
      receipt.inputManifestSha256===job.plan.input.identity.manifestSha256 && job.run.startedAt===null && !job.exit && !job.collection && !job.outcome &&
      /^[a-f0-9]{64}$/.test(receipt.containerId) && receipt.planSha256===sha256(canonicalJson(job.plan)) && /^[a-f0-9]{64}$/.test(receipt.evidenceSha256) &&
      /^[a-f0-9]{64}$/.test(receipt.journalSha256) && Number.isFinite(Date.parse(receipt.confirmedAt)),
    'Cancellation receipt differs from original no-process Run');
    if(job.run.finishedAt)requireThat(job.run.status==='CANCELLED' && job.run.finishedAt===receipt.confirmedAt && job.run.exitCode===null &&
      job.run.testOutcome===(job.run.mode==='RUN_TESTS'?'UNKNOWN':'NOT_APPLICABLE') && job.run.testCount===null && job.run.processProblem?.code==='RUN_CANCELLED_UNSTARTED',
    'Retained cancellation differs from durable receipt');
    job.run.status='CANCELLED';job.run.startedAt=null;job.run.exitCode=null;job.run.finishedAt=receipt.confirmedAt;
    job.run.testOutcome=job.run.mode==='RUN_TESTS'?'UNKNOWN':'NOT_APPLICABLE';job.run.testCount=null;job.run.serviceReadiness=null;
    job.run.processProblem=problem('RUN_CANCELLED_UNSTARTED','Original Run cancelled before process dispatch; exact owned container removal durably confirmed.');
    this.options.retainState?.(snapshot(job.plan),snapshot(job.run),job.requested);
  }
  private async settle(job: Job): Promise<void> {
    if (!this.unsettled.has(job)) return;
    if (job.settlement) return job.settlement;
    const pending=(async()=>{
      try {
        requireThat(job.exit && job.handle && job.plan,'No confirmed exit for collection.');
        job.collection ??=freeze(snapshot(await this.options.execution.collect(job.handle,job.exit)));
        requireThat(sameHandle(job.collection.handle,job.handle) &&
          job.collection.inputManifestSha256===job.plan.input.identity.manifestSha256,'Collection substituted Run/input identity.');
        job.outcome ??=freeze(snapshot(await job.adapter.interpret(snapshot(job.plan),snapshot(job.exit),snapshot(job.collection))));
        requireThat(!(job.outcome.status==='SUCCEEDED' && job.exit.exitCode!==0),'Nonzero exit cannot succeed.');
        job.receipt ??=await this.options.persistTerminal(job.handle,snapshot(job.outcome));
        requireThat(sameHandle(job.receipt.handle,job.handle) && same(job.receipt.ownership,job.plan.ownership) &&
          same(job.receipt.exit,job.exit) && job.receipt.collectionSha256===job.collection.collectionSha256,
        'Durable receipt substituted terminal authority.');
        // Keep this exact genuine object; never reconstruct/cast a branded terminal receipt.
        await this.options.execution.cleanup(job.receipt);
        this.checkVersion(job);
        job.run.status=job.requested==='USER'?'CANCELLED':job.requested==='TIMEOUT'?'TIMED_OUT':job.outcome.status;
        job.run.exitCode=job.exit.exitCode;job.run.testOutcome=job.requested ? (job.run.mode==='RUN_TESTS'?'UNKNOWN':'NOT_APPLICABLE') : job.outcome.testOutcome;
        job.run.testCount=job.requested?null:job.outcome.testCount;job.run.processProblem=job.outcome.problem;
        job.run.serviceReadiness=null;job.run.finishedAt=job.exit.exitedAt;
        this.options.retainState?.(snapshot(job.plan),snapshot(job.run),job.requested);
        this.release(job);this.emitState(job);
      } catch(error) { this.uncertain(job,'RUN_SETTLEMENT_UNCONFIRMED','Exit/collection/terminal persistence/cleanup is not fully confirmed.');throw error; }
    })();
    job.settlement=pending;
    try { await pending; } finally { if(job.settlement===pending) job.settlement=undefined; }
  }
  private job(id: string): Job { const job=this.jobs.get(id);if(!job)throw new AppError(404,'RUN_NOT_FOUND','Run not found.');return job; }
  private checkVersion(job: Job): void {
    if (this.unsettled.has(job) && this.options.getWorkspaceVersion()!==job.run.workspaceVersionAtStart) job.run.workspaceChangedDuringRun=true;
  }
  private uncertain(job: Job, code: string, message: string): void {
    if(!this.unsettled.has(job))return;
    job.run.status='PROCESS_STOP_UNCONFIRMED';job.run.finishedAt=null;job.run.exitCode=null;job.run.serviceReadiness=null;
    job.run.testOutcome=job.run.mode==='RUN_TESTS'?'UNKNOWN':'NOT_APPLICABLE';job.run.testCount=null;
    // Frozen V2 couples this status to its canonical code. Keep the specific failed
    // lifecycle operation in safe fixed text, never lie about finality or relax the validator.
    job.run.processProblem=problem('PROCESS_STOP_UNCONFIRMED',code==='PROCESS_STOP_UNCONFIRMED'?message:`${code}: ${message}`);this.emitState(job);
  }
  private release(job: Job): void {
    clearTimeout(job.timer);clearInterval(job.poll);job.waitAbort.abort();
    try {job.unsubscribe?.();} catch { /* Terminal ownership was already settled; observer disposal is not a process operation. */ }
    this.unsettled.delete(job);
  }
  private emitState(job: Job): void { this.emit('RUN_STATE',snapshot(job.run)); }
  private emit(type: 'RUN_STATE'|'RUN_OUTPUT',payload: unknown): void {
    try { this.options.emit(type,payload); } catch { /* A transport observer cannot release or corrupt process ownership. */ }
  }
  private output(job: Job, stream: 'STDOUT'|'STDERR', text: string): void {
    if(!this.unsettled.has(job) || !['STDOUT','STDERR'].includes(stream) || typeof text!=='string')return;
    this.checkVersion(job);
    const bytes=Buffer.from(text,'utf8');
    for(let start=0;start<bytes.length;) {
      let end=Math.min(start+16384,bytes.length);
      while(end<bytes.length && (bytes[end]&0xc0)===0x80)end--;
      const chunk=bytes.subarray(start,end).toString('utf8');start=end;
      const tail=Buffer.from(job.run.outputTail+chunk,'utf8');
      let offset=Math.max(0,tail.length-65536);
      if(offset) {job.run.outputTruncated=true;while(offset<tail.length && (tail[offset]&0xc0)===0x80)offset++;}
      job.run.outputTail=tail.subarray(offset).toString('utf8');
      this.emit('RUN_OUTPUT',{runId:job.run.runId,outputSeq:++job.outputSeq,stream,chunk});
    }
  }
}
