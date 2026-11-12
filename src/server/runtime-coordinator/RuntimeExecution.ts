/** Actual composition of the public neutral Runner, accepted executor, adapters and SAME gate.
 * No host tasks, alternate implementations, automatic preparation or wire-owned execution policy.
 */
import path from 'node:path';
import fs from 'node:fs';
import { Runner } from '../Runner';
import { DockerExecutor } from '../execution/DockerExecutor';
import { DurableRunJournal } from '../execution/DurableRunJournal';
import { copyAcknowledgedInput, readRunSourceInventory } from '../execution/ImmutableInput';
import { createTaskRuntimeAdapterRegistry } from '../runtime-adapters';
import type { DockerTransport } from '../execution/DockerTransport';
import type { ExecutionHandle, ExecutionPlan, ExecutionPort, ExecutionReadiness, PlanContext } from '../execution/ports';
import type { RuntimeProfile, RunRequestV2, RunV2, ModeReadiness, SettingsV2 } from '../../shared/runtime-v2';
import type { RuntimeConfiguration, RuntimeReadinessDependencies } from '../runtime-config';
import { AppError } from '../errors';
import { canonical, readRecord, SerialQueue, sha256 } from './storage';
import { inspectRuntimeServiceNetwork, prepareRuntimeServiceNetwork } from './RuntimeServiceNetwork';
import { NetworkMaintenanceAbsence, type RuntimeNetworkPrepareRequest, type NetworkMaintenanceContext } from './RuntimeNetworkMaintenance';
import type { RuntimeWorkspace } from './RuntimeWorkspace';
import type { RuntimeExecutionLayout } from './RuntimeExecutionLayout';
import type { PreparedRuntimeResolver, VerifiedPreparedCache, PreparedRuntimeSelection } from './PreparedRuntimeResolver';

/** Original private execution policy. Kept with the original admission, not later config. */
export interface RetainedRunPolicy { managedCacheRoot: string; serviceNetwork: string | null }
export type OriginalRunAdmission = (run: RunV2, plan: ExecutionPlan, policy: RetainedRunPolicy) => void;

export interface RuntimeExecutionOptions {
  core: RuntimeWorkspace;
  configuration: RuntimeConfiguration;
  prepared: PreparedRuntimeResolver;
  layout: RuntimeExecutionLayout;
  transport: DockerTransport;
  serviceNetwork: string | null;
  emit(type: 'RUN_STATE' | 'RUN_OUTPUT', payload: unknown): void;
  /** Actual binding/transition guard, not a client flag. */
  assertCurrent(): void;
}
const denied = (code: string, message: string): ModeReadiness => ({ canRun: false,
  problem: { code, message, recovery: 'Correct runtime settings and explicitly prepare the selected profile. Preserve retained Run ownership; manual editing remains available.', retryable: true } });
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

export function createRuntimeExecution(options: RuntimeExecutionOptions) {
  const { core, configuration, prepared, layout } = options;
  if (layout.projectId !== core.workspace.projectId || layout.workspaceRoot !== core.workspace.rootPath)
    throw new AppError(409, 'RUNTIME_OWNERSHIP_CHANGED', 'Execution layout does not belong to this exact project.');
  const adapters = createTaskRuntimeAdapterRegistry();
  const journal = new DurableRunJournal(layout.journalDirectory, layout.installationId);
  const byRun = new Map<string, DockerExecutor>();
  const maintenanceQueue = new SerialQueue();
  const check = () => { options.assertCurrent(); if (core.workspace.rootPath !== layout.workspaceRoot || core.workspace.projectId !== layout.projectId)
    throw new AppError(409, 'PROJECT_STATE_CHANGED', 'Execution project changed.'); };
  const executorFor = (selected: PreparedRuntimeSelection, profile: RuntimeProfile): DockerExecutor => new DockerExecutor({
    transport: options.transport, journal, policy: {
      installationId: layout.installationId, engineId: selected.engineId, runRoot: layout.runRoot,
      nonRootUser: '10001:10001', managedCacheRoot: selected.outputRoot, serviceNetwork: options.serviceNetwork,
      // Executor independently validates the COMPLETE dispatcher grammar before this exact structural guard.
      runtimes: [{ profile, image: selected.image, caches: selected.caches,
        commandAllowed: command => command.executable === '/opt/paircoach/node/bin/node' && command.args.length === 2 &&
          command.args[0] === '/opt/paircoach/runtime-task.mjs' }],
    },
  });
  const retained = (handle: ExecutionHandle) => {
    const executor = byRun.get(handle.runId);
    if (!executor) throw new AppError(409, 'RUN_HANDLE_UNAVAILABLE', 'No exact retained executor for this Run. Preserve the original request and reconcile.');
    return executor;
  };
  const readinessFor = (proposed?: SettingsV2): ExecutionPort['readiness'] => async (profile, generation) => {
    check();
    if (!configuration.resolved || generation !== configuration.configurationGeneration || !same(profile, configuration.resolved.profile))
      throw new AppError(409, 'CONFIGURATION_STALE', 'Runtime configuration changed.');
    const source = core.readSettings(), modes = {} as ExecutionReadiness['modes'];
    for (const mode of ['RUN_MAIN','RUN_TESTS'] as const) {
      const run = (proposed ?? source.settings)?.runProfiles.find(run => run.kind === mode);
      if (!run) { modes[mode] = denied('TASK_CONFIG_INVALID', 'This mode has no explicitly saved V2 task.'); continue; }
      const valid = await adapters.get(profile).validate(profile, run); check();
      if (!valid.valid) { modes[mode] = { canRun: false, problem: valid.problem }; continue; }
      try {
        const selected = await prepared.resolve(configuration.resolved, mode, run); check();
        if (mode === 'RUN_MAIN' && 'containerPort' in run.task.entry) {
          try {
            const receipt=await inspectRuntimeServiceNetwork({layout,transport:options.transport,engineId:selected.engineId,assertCurrent:check});check();
            if(!receipt || receipt.name!==options.serviceNetwork)throw Error('Missing exact owned bridge');
          } catch {
            check();modes[mode]=denied('SERVICE_NETWORK_PREPARE_REQUIRED','Explicitly prepare/reconcile the installation-owned internal service bridge and exact engine receipt; no external bridge/host fallback.');continue;
          }
        }
        modes[mode] = (await executorFor(selected, profile).readiness(profile, generation)).modes[mode]; check();
      } catch { modes[mode] = denied('PREPARE_REQUIRED', 'Current prepared runtime or exact owned execution state is not ready.'); }
    }
    if (core.readSettings().sourceSha256 !== source.sourceSha256) throw new AppError(409, 'PROJECT_STATE_CHANGED', 'Settings changed during readiness.');
    return { configurationGeneration: generation, modes };
  };
  const readiness = readinessFor();
  // All actual process operations go to the SAME executor retained at real capture, never a new policy
  // selected from a later draft/configuration. The wrapper is only neutral lifecycle routing.
  const port: ExecutionPort = {
    readiness,
    start: async plan => { const executor = byRun.get(plan.ownership.runId); if (!executor) throw Error('No captured execution policy'); return executor.start(plan); },
    subscribe: (h, listener) => retained(h).subscribe(h, listener),
    serviceReadiness: h => retained(h).serviceReadiness(h),
    wait: (h, signal) => retained(h).wait(h, signal), stop: (h, reason) => retained(h).stop(h, reason),
    collect: (h, exit) => retained(h).collect(h, exit), cleanup: receipt => retained(receipt.handle).cleanup(receipt),
    inspectOwnedOrphans: async installationId => {
      if (installationId !== layout.installationId) throw Error('Foreign installation');
      const result = [];
      for (const executor of new Set(byRun.values())) result.push(...await executor.inspectOwnedOrphans(installationId));
      return result.filter((orphan, index, all) => all.findIndex(other => same(other.handle, orphan.handle)) === index);
    },
  };
  const runner = new Runner({ execution: port, getWorkspaceVersion: () => core.workspace.workspaceVersion,
    emit: options.emit, persistTerminal: (handle, outcome) => retained(handle).persistTerminal(handle, outcome) });
  const dependencies: RuntimeReadinessDependencies = { execution: port, probe: prepared };
  async function start(original: RunRequestV2, admitOriginal?: OriginalRunAdmission) {
    const request = structuredClone(original); check();
    if(core.session.state.lifecycle==='FINISHED') throw new AppError(409,'SESSION_FINISHED','This session is finished; its Run/report facts are immutable.');
    core.session.assertClient(request.clientId, request.sessionId);
    const runtime = configuration.resolved, source = core.readSettings();
    if (!runtime || request.configurationGeneration !== configuration.configurationGeneration)
      throw new AppError(409, 'CONFIGURATION_STALE', 'Reload the current runtime configuration.');
    const run = source.settings?.runProfiles.find(run => run.kind === request.mode);
    if (!run) throw new AppError(409, source.problem?.code ?? 'TASK_CONFIG_INVALID', 'Explicitly save a valid V2 task for this mode.');
    const epoch = core.session.state.controlEpoch;
    const assertCurrent = () => {
      check(); core.session.assertClient(request.clientId, request.sessionId);
      if (core.session.state.controlEpoch !== epoch || core.session.state.writeOwner !== 'STUDENT')
        throw new AppError(409, 'WRITE_OWNER_CONFLICT', 'Student control changed during Run admission.');
      if (core.workspace.workspaceVersion !== request.expectedWorkspaceVersion || core.readSettings().sourceSha256 !== source.sourceSha256)
        throw new AppError(409, 'RUN_INPUT_CHANGED', 'Workspace or settings changed during Run admission.');
    };
    assertCurrent();
    let retainedPolicy: RetainedRunPolicy | undefined;
    return runner.start({ projectId: core.workspace.projectId, request, profile: runtime.profile,
      runProfile: run, adapter: adapters.get(runtime.profile), assertCurrent,
      admitOriginal: (result, plan) => {
        assertCurrent();
        if (!retainedPolicy) throw Error('No original captured execution policy');
        admitOriginal?.(result, plan, structuredClone(retainedPolicy));
      },
      capture: async runId => {
        let selected: VerifiedPreparedCache | undefined;
        let retainedLease: { assertCurrent(): void } | undefined;
        const input = await core.gate.captureRun({ clientId: request.clientId, sessionId: request.sessionId,
          controlEpoch: epoch, actor: 'STUDENT', runId, profileId: runtime.profile.id,
          configurationGeneration: runtime.configurationGeneration, expectedWorkspaceVersion: request.expectedWorkspaceVersion,
          runDirectory: path.join(layout.runRoot, runId) }, {
          inventory: readRunSourceInventory, assertCurrent,
          prepare: async lease => { retainedLease = lease; selected = await prepared.resolveCache(runtime, request.mode, run, lease); lease.assertCurrent(); },
          copy: async args => {
            if (!selected) throw Error('No current selected cache');
            const copied = await copyAcknowledgedInput(args);
            await args.acknowledgement.assertCurrent();
            // Repeat full raw cache verification after the real copy, with the SAME held token.
            const after = await prepared.resolveCache(runtime, request.mode, run, retainedLease!);
            if (!same(after, selected)) throw new AppError(409, 'RUN_INPUT_CHANGED', 'Prepared cache changed during immutable capture.');
            retainedLease!.assertCurrent();
            return copied;
          },
        });
        assertCurrent();
        if (!selected) throw Error('No current selected cache');
        const ownership = { installationId: layout.installationId, runId, profileId: runtime.profile.id,
          engineId: selected.engineId, imageId: selected.image.imageId,
          containerName: `paircoach-${layout.installationId}-${runtime.profile.id}-${runId}` };
        retainedPolicy = { managedCacheRoot: selected.outputRoot, serviceNetwork: options.serviceNetwork };
        byRun.set(runId, executorFor(selected, runtime.profile));
        return { ownership, input, profile: runtime.profile, lockedImage: selected.image, caches: selected.caches } satisfies PlanContext;
      },
    });
  }
  async function prepareServiceNetwork(original:RuntimeNetworkPrepareRequest,recovery:boolean,originalContext:NetworkMaintenanceContext|null,stage:(context:NetworkMaintenanceContext)=>void,assertAdmission:()=>void) {
    const request=structuredClone(original);
    return maintenanceQueue.run(()=>core.workspace._withQueuedMutation(async()=>{
      const source=core.readSettings(), runtime=configuration.resolved;
      const guard=()=>{check();assertAdmission();
        if((!recovery && (!runtime || request.configurationGeneration!==configuration.configurationGeneration ||
            core.workspace.workspaceVersion!==request.expectedWorkspaceVersion)) || core.readSettings().sourceSha256!==source.sourceSha256)
          throw new AppError(409,'PROJECT_STATE_CHANGED','Maintenance source/configuration changed.');
        if(runner.list().some(r=>['QUEUED','RUNNING','STOPPING','PROCESS_STOP_UNCONFIRMED'].includes(r.status)))
          throw new AppError(409,'RUN_IN_PROGRESS','Active/unsettled Run excludes network maintenance.');
      };
      guard();
      if((await journal.list()).some(r=>r.phase!=='REMOVED'))throw new AppError(409,'RUN_IN_PROGRESS','Durable orphan Run excludes network maintenance; reconcile that exact owner first.');
      guard();
      let engineId:string;
      if(recovery) {
        if(!originalContext)throw new NetworkMaintenanceAbsence('NOT_DISPATCHED');
        if(!same(originalContext.layout,layout))throw Error('Retained original maintenance layout mismatch; no replay');
        engineId=originalContext.engineId;
      } else {
        const run=source.settings?.runProfiles.find(r=>r.kind==='RUN_MAIN');
        if(!runtime || !run)throw new AppError(409,'PREPARE_REQUIRED','Select a verified prepared runtime and explicit main task first.');
        const selected=await prepared.resolve(runtime,'RUN_MAIN',run);guard();engineId=selected.engineId;
        stage({layout:structuredClone(layout),engineId});guard();
      }
      const context={layout,transport:options.transport,engineId,assertCurrent:guard};
      if(recovery) {
        // First reconcile fresh read-only receipt/engine, even for a previously committed reply.
        let receipt=null,absence=false;try {receipt=await inspectRuntimeServiceNetwork(context);absence=receipt===null;}catch {guard();}
        guard();if(receipt)return receipt;
        // Only the actual helper's original durable intent permits its reconciliation path.
        // No intent => NEVER replay dispatch after our own crash-before-helper boundary.
        const directory=path.join(layout.stateDirectory,'service-network');
        const names=fs.existsSync(directory)?fs.readdirSync(directory):[];
        if(names.length>386)throw Error('Unbounded service ledger');
        const hasOriginalIntent=names.filter(n=>/^intent-\d{3}\.json$/.test(n)).some(n=>{
          const value=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(readRecord(path.join(directory,n),65536)!));
          return value.requestId===request.requestId;
        });
        guard();if(!hasOriginalIntent){if(absence)throw new NetworkMaintenanceAbsence('NOT_DISPATCHED');throw Error('Original dispatch is unconfirmed; never retry create without its durable helper intent');}
      }
      try {return await prepareRuntimeServiceNetwork({...context,requestId:request.requestId});}
      catch(error) {
        guard();
        // Helper explicitly records a fresh same-engine absence before permitting a NEW
        // attempt. Preserve it and close only this original request, never infer no effect.
        const directory=path.join(layout.stateDirectory,'service-network');
        if(fs.existsSync(directory))for(const n of fs.readdirSync(directory).filter(n=>/^intent-\d{3}\.json$/.test(n))) {
          const bytes=readRecord(path.join(directory,n),65536)!,intent=JSON.parse(bytes.toString('utf8'));
          if(intent.requestId!==request.requestId)continue;
          const file=path.join(directory,n.replace('intent-','absence-')),proof=readRecord(file,65536,true);
          if(proof) {
            const value=JSON.parse(proof.toString('utf8'));
            if(value.schemaVersion===1 && value.kind==='ABSENCE_CONFIRMED' && value.intentSha256===sha256(bytes) &&
                await inspectRuntimeServiceNetwork(context)===null) {guard();throw new NetworkMaintenanceAbsence('ABSENCE_CONFIRMED');}
          }
        }
        throw error;
      }
    }));
  }
  return { runner, start:(original:RunRequestV2,admit?:OriginalRunAdmission)=>{const request=structuredClone(original);return maintenanceQueue.run(()=>start(request,admit));}, prepareServiceNetwork, readiness: dependencies,
    readinessForSettings: (settings: SettingsV2): RuntimeReadinessDependencies => ({ execution: { readiness: readinessFor(structuredClone(settings)) }, probe: prepared }), journal };
}
