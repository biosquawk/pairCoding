import { CodexCoachProvider } from './coach/CodexProvider';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { WorkspaceService } from './WorkspaceService';
import { SessionController } from './SessionController';
import { WriteGate } from './WriteGate';
import { CoachAdapter, type CoachProvider } from './CoachAdapter';
import { ReportService, REPORT_SYSTEM_PROMPT, type FrozenFacts, type ReportSummary } from './ReportService';
import { isContextPathAllowed, matchesContextPattern, redactSecrets } from './coach/context';
import type { Settings } from '../shared/protocol';
import {projectRunFacts, type RunFacts} from './coach/runFacts';
import type { ChatEntry, CoachDecision, Proposal, Report, Run } from '../shared/protocol';
import { apiError, CommandLedger, TransportError, validateRequest, type CommandLedgerOptions, type ClientMessage } from './transport';
import { validateTaskForProfile, validateReconcileMutationRequestV2, validateMutationOutcomeV2, validateV2WireShape, validateV2Request } from '../shared/validation-v2';
import type { ProjectV2, RunRequestV2, SessionBundleV2, UpdateSettingsRequestV2 } from '../shared/runtime-v2';
import type { LanguageView } from '../shared/language-v2';
import { validateLanguageClientMessage } from '../shared/validation-v2';
import type { LanguageDockerDriver } from './language/DockerLanguageDriver';
import type { LanguageBootstrapV2 } from '../shared/language-authority-v2';
import { createRuntimeExecution } from './runtime-coordinator/RuntimeExecution';
import { retainRuntimeExecutionLayout } from './runtime-coordinator/RuntimeExecutionLayout';
import { createRuntimeDockerTransport } from './runtime-coordinator/RuntimeDockerTransport';
import type { DockerTransport } from './execution/DockerTransport';
import type { RuntimeEnvironment, RuntimeReadinessDependencies } from './runtime-config';
import { createRuntimeStartup, requireRuntimeWorkspace, type RuntimeStartup } from './runtime-coordinator/RuntimeStartup';
import { validateRuntimeOpenProjectRequest, validateRuntimeClientMessage, validateRuntimeNetworkPrepareRequest } from './runtime-coordinator/RuntimeHttpValidation';
import { readRuntimeProject, applyRuntimeSettingsMetadata } from './runtime-coordinator/RuntimeProject';
import { runtimeTaskFields } from './runtime-config';
import { RuntimeSettingsMutation } from './runtime-coordinator/RuntimeSettingsMutation';
import { DurableMutationJournal } from './runtime-coordinator/MutationJournal';
import { RuntimeRunMutation } from './runtime-coordinator/RuntimeRunMutation';
import { RuntimeNetworkMaintenance, type RuntimeNetworkPrepareRequest } from './runtime-coordinator/RuntimeNetworkMaintenance';
import { RuntimeClientOwnership } from './runtime-coordinator/RuntimeClientOwnership';
import type { ReconcileMutationRequestV2 } from '../shared/runtime-mutation-v2';

/** Network AI receives structural Run facts, never local stdout/stderr or future Run fields. */
export type ReportAIFacts = Pick<FrozenFacts, 'session'|'snapshot'|'chat'|'events'> & {
  runs: RunFacts[];
  [key:string]: unknown;
};
export interface ServerOptions {
  rootPath?: string; dataDir?: string; token?: string; port?: number;
  /** Programmatic options, not HTTP/config/env discovery surfaces. Production composition is index. */
  runtimeArguments?: readonly string[]; runtimeEnvironment?: RuntimeEnvironment;
  runtimeTransport?: Pick<DockerTransport, 'run'>;
  /** Inert historical test seam. Lightweight never constructs a language driver/owner. */
  runtimeLanguageDriver?: LanguageDockerDriver;
  /** Trusted programmatic dependency only, never an env/task/HTTP selector. */
  dockerExecutable?: string;
  runtimeReadiness?: RuntimeReadinessDependencies;
  ledgerOptions?: CommandLedgerOptions; openLedgerOptions?: CommandLedgerOptions;
  devBootstrap?: boolean; staticDir?: string; enableCoach?: boolean; enableExecution?: boolean;
  reportGenerate?: (facts: ReportAIFacts, signal: AbortSignal) => Promise<string>;
  coachProvider?: CoachProvider;
  coachFactory?: (context: ServiceContext) => CoachService;
  executionFactory?: (context: ServiceContext) => ExecutionServices;
}
export interface ServiceContext {
  workspace: WorkspaceService; session: SessionController; gate: WriteGate;
  emit: (type: string, payload: unknown) => void;
  onProposal: (decision: Extract<CoachDecision, {kind:'PROPOSE'}>) => void;
  /** Custom coach services must honor this policy for admission and late asynchronous decisions. */
  canAnalyze?: () => boolean;
  /** Admit a synchronous current context read after SAME FIFO release, excluding language capture. */
  readContext?: <T>(read: () => T, signal: AbortSignal) => Promise<T>;
}
export interface CoachService {
  trigger(reason: 'EDIT'|'CHAT'|'RUN'|'START'|'OVERTIME', message?: ChatEntry): void;
  updateRun?(run:Run):void;
  controlReady(payload: any): void; stepRendered(payload: any): void; abort(): void; close(): void;
}
export interface ExecutionServices {
  runner: { setApprovedProfiles(profiles: any[]):void; start(profile: any): Run; get(id: string): Run; stop(id:string): Promise<Run>; stopAll():Promise<void>; list():Run[] };
  reports: { finish(reason: Report['reason'],facts:any):Report; get(sessionId:string):Report; retry(sessionId:string):Report; list?():ReportSummary[]; close():void };
}
function fail(status: number, code: string, message: string): never { throw new TransportError(status,code,message); }
const clone = <T>(value:T):T => structuredClone(value);

export function createPairCoachServer(options: ServerOptions = {}) {
  const token = options.token || randomBytes(32).toString('hex');
  const devBootstrap = options.devBootstrap ?? process.env.NODE_ENV !== 'production';
  const port = options.port ?? 8080;
  if(!Number.isInteger(port) || port<0 || port>65535) fail(400,'INVALID_PORT','Use a valid loopback port.');
  if ([8765,8766,8767,8768].includes(port)) fail(400,'PORT_FORBIDDEN','Port zastrzeżony.');
  // Construct/recover the real canonical V2 core before listen, never a mock/temp project.
  // A configured Docker transport is a separate composition step; absence cannot run a host task.
  const startupOptions = { argv: [...(options.runtimeArguments ?? [])],
    environment: options.runtimeEnvironment, dataDir:options.dataDir };
  const startupTransports = new WeakMap<RuntimeStartup, { transport: DockerTransport; install(transport: DockerTransport): void }>();
  const constructStartup = async (root?: string) => {
    let installed: DockerTransport | undefined = options.runtimeTransport;
    const transport: DockerTransport = { run: (args, bounds) => {
      if(!installed) throw new TransportError(503, 'DOCKER_CLI_UNAVAILABLE', 'Canonical runtime transport is not available. Manual editing remains available.');
      return installed.run(args, bounds);
    } };
    const value = await createRuntimeStartup({ ...startupOptions, explicitWorkspaceRoot: root, transport });
    startupTransports.set(value, { transport, install(value) { installed = value; } });
    return value;
  };
  let startup: RuntimeStartup;
  let workspace!: WorkspaceService, session!: SessionController, gate!: WriteGate;
  function currentCore() {
    if(!startup) fail(409,'PROJECT_INITIALIZING','Canonical project recovery has not completed. Await listen before accessing the core.');
    if(closing) fail(503,'SESSION_CLOSED','Server is closed.');
    return requireRuntimeWorkspace(startup);
  }
  const makeCore = (root: string) => constructStartup(root);
  const sessionLedgerOptions={...options.ledgerOptions};
  const makeLedgers=()=>({ledger:new CommandLedger(sessionLedgerOptions),proposalOutcomes:new CommandLedger(sessionLedgerOptions)});
  let {ledger,proposalOutcomes}=makeLedgers();
  // OpenProjectRequest has no old sessionId: never forget an open receipt on adoption.
  const openLedger=new CommandLedger({...options.openLedgerOptions,
    limitMessage:options.openLedgerOptions?.limitMessage ?? 'Osiągnięto budżet otwarć projektów tego serwera. Zachowaj dane i uruchom ponownie lokalny serwer.'});
  let chat:ChatEntry[] = [], proposals:Proposal[] = [], report:Report|null = null, lastRun:Run|null = null;
  const facts:unknown[] = [];
  let seq = 0, closing = false, transitioning = false, persistingFinish = false;
  let controlPreparing = false; // Existing CONTROL_PREPARE is not represented by Session.writeOwner yet.
  let coach:CoachService|undefined, execution:ExecutionServices|undefined;
  let reports:ExecutionServices['reports']|undefined;
  let runtimeExecution: ReturnType<typeof createRuntimeExecution> | undefined;
  const peers = new Map<WebSocket,{id:string;clientId:string|null; authenticated:boolean; refreshing:boolean; readinessDeferred:boolean; alive:boolean; count:number; since:number; queued:number; queue:Promise<void>; handshakeGeneration:string|null;leaseSession:SessionController|null}>();
  const server = http.createServer((req,res) => { void handleHttp(req,res); });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.maxHeadersCount = 64;
  const wss = new WebSocketServer({ noServer:true, maxPayload: 6*1024*1024, perMessageDeflate:false });

  function envelope(type:string,payload:unknown,messageId:string=randomUUID()) {
    const message = {protocolVersion:'3.0',messageId,sessionId:session.state.sessionId,seq:++seq,type,payload};
    session.state.lastServerSeq = seq;
    if(type==='SESSION_SNAPSHOT') (payload as SessionBundleV2).session.lastServerSeq=seq;
    return message;
  }
  // All authenticated peers see every seq, including targeted ACKs. Payloads contain no credentials.
  function emit(type:string,payload:unknown,messageId?:string) {
    if (closing) return;
    if (type==='SESSION_REPORT' && (payload as Report).sessionId!==session.state.sessionId) return;
    if(type==='CONTROL_PREPARE')controlPreparing=true;
    if(type==='CONTROL_STATE')controlPreparing=false;
    const message = envelope(type,payload,messageId), encoded = JSON.stringify(message);
    if (['COACH_STEP_EDIT','CONTROL_STATE'].includes(type)) facts.push(clone(message));
    if (type==='RUN_STATE') {
      lastRun = clone(payload as Run);
      if (lastRun.finishedAt) facts.push({type:'RUN',run:clone(lastRun)});
    }
    if (type==='SESSION_REPORT') report = clone(payload as Report);
    if (type==='CHAT_REPLY' || type==='COACH_HINT_BUBBLE') { chat.push({messageId:message.messageId,author:'COACH',text:(payload as {text:string}).text,createdAt:new Date().toISOString()});chat=chat.slice(-100); }
    for (const [ws,p] of peers) if (p.authenticated && ws.readyState===WebSocket.OPEN) {
      if (ws.bufferedAmount > 8*1024*1024) { ws.close(1013,'Slow consumer'); continue; }
      ws.send(encoded);
    }
    // A full snapshot resets the existing client's PREPARE/step cache. Publish readiness
    // only after the actual control handoff has settled, never over an in-flight intervention.
    if(type==='CONTROL_STATE' && session.state.writeOwner==='STUDENT')queueMicrotask(()=>{
      for(const [ws,peer] of peers)if(peer.readinessDeferred)refreshReadiness(ws);
    });
    // Coach updates can publish more frames. Send this sequence before reentering emit.
    if (type==='RUN_STATE' && (payload as Run).finishedAt) {
      coach?.updateRun?.(clone(payload as Run));
      if(!transitioning && !coach?.updateRun) {session.noteNewFact('RUN');coach?.trigger('RUN');}
    }
  }
  async function getProject(measureReadiness=true,admitRead?:<T>(read:()=>T)=>Promise<T>):Promise<ProjectV2> {
    return readProject(measureReadiness,admitRead);
  }
  async function readProject(measureReadiness:boolean,admitRead?:<T>(read:()=>T)=>Promise<T>): Promise<ProjectV2> {
    const bound = startup, core = currentCore();
    const assertCurrent = () => {
      if (startup !== bound || closing || transitioning) fail(409, 'PROJECT_STATE_CHANGED', 'Project binding changed during the read. Preserve drafts and synchronize.');
    };
    const project = await readRuntimeProject({ core, sessionId:core.session.state.sessionId, configuration:bound.configuration,
      readiness:options.runtimeReadiness ?? runtimeExecution?.readiness ?? { execution:{ readiness:async()=> { throw binding?.runtimeError ?? Error('Execution composition unavailable'); } }, probe:bound.prepared },
      measureReadiness, admitRead, assertCurrent, readLanguage:()=>languageProjection(bound) });
    if(binding?.runtimeError && core.readSettings().settings !== null) {
      const problem = {code:'RUNTIME_STATE_UNAVAILABLE',message:'Execution state or owned Docker client configuration cannot be safely initialized.',
        recovery:'Place the runtime configuration outside original/prepared sources, retain prior ownership and repair the private canonical runtime state. Manual editing remains available.',retryable:true};
      project.capabilities.execution.runtime.state='CONFIG_ERROR';project.capabilities.execution.runtime.problem=problem;
      project.capabilities.execution.modes={RUN_MAIN:{canRun:false,problem},RUN_TESTS:{canRun:false,problem}};
    }
    return project;
  }
  function assertMutationScope(bound:RuntimeStartup, clientId:string) {
    if(startup!==bound || transitioning || closing) fail(409,'PROJECT_STATE_CHANGED','Mutation binding changed; retain the exact original request.');
    currentCore().session.assertClient(clientId,currentCore().session.state.sessionId);
  }
  function languageProjection(bound:RuntimeStartup):LanguageView {
    // Server conveys configuration only, never browser worker readiness.
    const configured=bound.configuration.resolved??bound.configuration.local;
    const local=['builtin','off'].includes(configured?.profile.language.provider??'');
    const problem=local ? null : bound.configuration.problem ?? {
      code:'LOCAL_LANGUAGE_UNAVAILABLE',message:'Local language features are not configured.',
      recovery:'Repair the runtime configuration; manual editing remains available.',retryable:true};
    return {projectId:requireRuntimeWorkspace(bound).workspace.projectId,
      profileId:configured?.profile.id ?? 'unconfigured',configurationGeneration:bound.configuration.configurationGeneration,
      providerGeneration:bound.configuration.configurationGeneration,state:'OFF',autocomplete:'OFF',docs:'N/A',problem};
  }
  async function saveSettings(original:UpdateSettingsRequestV2):Promise<ProjectV2> {
    const request=clone(original), bound=startup, owner=binding!, core=currentCore();
    assertMutationScope(bound,request.clientId);core.session.assertClient(request.clientId,request.sessionId);
    owner.clients.assertBound(request.clientId,request.sessionId);
    const epoch=core.session.state.controlEpoch, source=core.readSettings(), configuration=bound.configuration;
    const assertAdmission=()=>{
      assertMutationScope(bound,request.clientId);core.session.assertClient(request.clientId,request.sessionId);
      if(core.session.state.controlEpoch!==epoch || core.session.state.writeOwner!=='STUDENT') fail(409,'WRITE_OWNER_CONFLICT','Student control changed during SAVE.');
      if(bound.configuration!==configuration || core.workspace.workspaceVersion!==request.expectedWorkspaceVersion ||
          core.readSettings().sourceSha256!==source.sourceSha256) fail(409,'PROJECT_STATE_CHANGED','SAVE source/version/configuration changed.');
    };
    let capabilities:ProjectV2['capabilities']|undefined;
    const operation=owner.saves.execute({request,humanConfirmed:true,expectedSourceSha256:source.sourceSha256},(lease,files)=>{
      lease.assertCurrent();assertAdmission();
      if(!capabilities) throw Error('No prepared original SAVE capabilities');
      const project:ProjectV2={projectId:core.workspace.projectId,rootPath:core.workspace.rootPath,sessionId:request.sessionId,
        workspaceVersion:request.expectedWorkspaceVersion+1,files,settings:clone(request.settings),capabilities:clone(capabilities)};
      if(!validateV2WireShape('Project',project)) throw Error('Invalid original postcommit Project');
      return project;
    },()=>{
      // Called by actual authority AFTER durable commit, under the same root exclusion and BEFORE
      // publishing the new version. No late-response/stale UI application to a replacement core.
      applyRuntimeSettingsMetadata(core.workspace,request.settings);
    },async()=>{
      assertAdmission();
      // SAVE confirms persistence, not execution admission. Never hold its original HTTP
      // confirmation behind engine/cache/tool probes. The immutable staged result is an
      // explicitly unmeasured, fail-closed projection; the ordinary post-response snapshot
      // performs current readiness. Run still has its independent real admission checks.
      const selected=configuration.resolved??configuration.local;
      const pending={code:'RUNTIME_READINESS_PENDING',message:'Execution readiness has not been measured for these saved settings.',
        recovery:'Keep editing. The connected session will receive actual runtime readiness separately.',retryable:true};
      const problem=configuration.problem??pending;
      const execution:ProjectV2['capabilities']['execution']={runtime:{profileId:selected?.profile.id??null,label:selected?.profile.label??'',
        configurationGeneration:configuration.configurationGeneration,taskFields:runtimeTaskFields(selected?.profile),
        state:configuration.problem?'CONFIG_ERROR':'PREPARE_REQUIRED',problem},
        modes:{RUN_MAIN:{canRun:false,problem},RUN_TESTS:{canRun:false,problem}}};
      if(configuration.resolved)for(const mode of ['RUN_MAIN','RUN_TESTS'] as const) {
        const run=request.settings.runProfiles.find(p=>p.kind===mode);
        if(!run || !validateTaskForProfile(configuration.resolved.profile,run))execution.modes[mode]={canRun:false,
          problem:{code:'TASK_CONFIG_INVALID',message:'Task selectors are absent or incompatible with the active runtime.',
            recovery:'Review task selectors in project settings.',retryable:false}};
      }
      const language=languageProjection(bound);
      if(owner.runtimeError) {
        const problem={code:'RUNTIME_STATE_UNAVAILABLE',message:'Execution state cannot be safely initialized.',
          recovery:'Repair canonical private runtime storage. Manual editing remains available.',retryable:true};
        execution.runtime.state='CONFIG_ERROR';execution.runtime.problem=problem;
        execution.modes={RUN_MAIN:{canRun:false,problem},RUN_TESTS:{canRun:false,problem}};
      }
      capabilities={execution,language};
    });
    const outcome=await owner.track(operation);
    if(outcome.state==='UNKNOWN') fail(503,'MUTATION_OUTCOME_UNKNOWN','Retain the exact original SAVE and reconcile its durable outcome before any new RUN/SAVE.');
    if(outcome.state==='DEFINITIVELY_ABORTED') fail(409,'MUTATION_DEFINITIVELY_ABORTED','The original SAVE was definitively aborted. Refresh state before a new request.');
    return clone(outcome.result);
  }
  async function startRun(original:RunRequestV2) {
    const request=clone(original), bound=startup, owner=binding!;
    assertMutationScope(bound,request.clientId);
    currentCore().session.assertClient(request.clientId,request.sessionId);
    owner.clients.assertBound(request.clientId,request.sessionId);
    if(!owner.runs) fail(503,'RUNTIME_UNAVAILABLE','Neutral runtime is unavailable. Repair runtime configuration; no host fallback exists.');
    const outcome=await owner.track(owner.runs.execute(request));
    if(outcome.state==='UNKNOWN') fail(503,'MUTATION_OUTCOME_UNKNOWN','Retain the exact original RUN and reconcile before any new RUN/SAVE.');
    if(outcome.state==='DEFINITIVELY_ABORTED') fail(409,'MUTATION_DEFINITIVELY_ABORTED','Original RUN was definitively aborted; use a new request only after synchronization.');
    return clone(outcome.result);
  }
  async function prepareServiceNetwork(original:RuntimeNetworkPrepareRequest) {
    const request=clone(original),bound=startup,owner=binding!,core=currentCore();
    const epoch=core.session.state.controlEpoch,version=core.workspace.workspaceVersion,generation=bound.configuration.configurationGeneration;
    const authorize=(retained:boolean)=>{
      assertMutationScope(bound,request.clientId);
      owner.clients.assertBound(request.clientId,request.sessionId);
      if(!retained)core.session.assertClient(request.clientId,request.sessionId);
      if(core.session.state.writeOwner!=='STUDENT' || core.session.state.controlEpoch!==(retained?epoch:request.controlEpoch))
        fail(409,'STALE_EPOCH','Maintenance requires unchanged student control.');
      if(core.session.state.lifecycle==='FINISHED')fail(409,'SESSION_FINISHED','Finished session cannot prepare a network.');
      if(core.workspace.workspaceVersion!==(retained?version:request.expectedWorkspaceVersion) || bound.configuration.configurationGeneration!==(retained?generation:request.configurationGeneration))
        fail(409,'PROJECT_STATE_CHANGED','Maintenance requires the exact source/configuration.');
      owner.mutations.assertNoPendingRuns();
      if(owner.runtime?.runner.list().some(r=>['QUEUED','RUNNING','STOPPING','PROCESS_STOP_UNCONFIRMED'].includes(r.status)))
        fail(409,'RUN_IN_PROGRESS','Active/unsettled Run excludes service network maintenance.');
    };
    if(!owner.runtime)fail(503,'RUNTIME_UNAVAILABLE','Repair/select a verified runtime first; maintenance never falls back to host execution.');
    return owner.track(owner.network.execute(request,authorize,(recovery,context,stage)=>owner.runtime!.prepareServiceNetwork(request,recovery,context,stage,()=>authorize(recovery))));
  }
  function currentRuntimeRun() {
    // Read the genuine active neutral owner, including output/version changes not RUN_STATE events.
    // Do not invent V2 profile identity for a legacy injected executionFactory.
    return execution ? null : runtimeExecution?.runner.list(session.state.sessionId).at(-1) ?? null;
  }
  async function reconcileMutation(body:ReconcileMutationRequestV2) {
    const mutation=clone(body.mutation), bound=startup, owner=binding!, core=currentCore(), request=mutation.request;
    assertMutationScope(bound,request.clientId);
    if(mutation.projectId!==core.workspace.projectId) fail(403,'MUTATION_SCOPE_FORBIDDEN','Cannot reconcile a mutation from another project.');
    owner.clients.assertBound(request.clientId,request.sessionId);
    const operation=mutation.kind==='SAVE' ? owner.saves.recover(mutation.request) : owner.runs ? owner.runs.recover(mutation.request) : owner.mutations.reconcile({
      projectId:mutation.projectId,sessionId:request.sessionId,clientId:request.clientId,requestId:request.requestId,kind:'RUN',payload:request});
    const outcome=await owner.track(operation);
    assertMutationScope(bound,request.clientId);
    // UNKNOWN must NOT supply a current snapshot as if it proved the original effect.
    const current=outcome.state==='UNKNOWN' ? null : {project:await getProject(),run:currentRuntimeRun()};
    assertMutationScope(bound,request.clientId);
    const response={mutation,...outcome,current};
    if(!validateMutationOutcomeV2(response)) throw Error('Actual reconcile result violates the frozen contract');
    return response;
  }
  async function getBundle(measureReadiness=false,onMaterialized?:()=>void):Promise<SessionBundleV2> {
    return readBundle(measureReadiness,onMaterialized);
  }
  async function readBundle(measureReadiness:boolean,onMaterialized?:()=>void):Promise<SessionBundleV2> {
    const bound=startup, core=currentCore();
    let settingsHash!:string|null, activePath!:string|null;
    let activeDocument:SessionBundleV2['activeDocument']=null,materialized=false;
    const project=await getProject(measureReadiness,read=>core.workspace._withQueuedRead(()=>{
      if(startup!==bound)fail(409,'PROJECT_STATE_CHANGED','Project binding changed before source materialization.');
      if(!materialized) {
        settingsHash=core.readSettings().sourceSha256;
        activePath=core.session.state.activeFilePath || core.workspace.settings.taskFilePath;
        if(activePath) {
          try {activeDocument=core.workspace.getDocument(activePath);}
          catch(error) {
            // Selected-file errors remain explicit file-GET problems. Never hide
            // a root/version authority failure or an unrelated WORKSPACE_BUSY.
            if(!['FILE_NOT_FOUND','FILE_TOO_LARGE','NOT_A_FILE','UNSUPPORTED_ENCODING','UNSAFE_PATH','PATH_CASE_CONFLICT','DISK_CONFLICT'].includes((error as {code?:string}).code??''))throw error;
          }
        }
        const source=read(); // settings + guarded file projection in THIS synchronous admission
        onMaterialized?.();materialized=true;
        return source;
      }
      return read(); // final readable/source validation, after any intervening capture terminal
    }));
    if(startup!==bound) fail(409,'PROJECT_STATE_CHANGED','Project binding changed.');
    const state=core.session.getSession();
    if((state.activeFilePath || core.workspace.settings.taskFilePath)!==activePath)fail(409,'PROJECT_STATE_CHANGED','Selected document changed during readiness.');
    if(core.workspace.workspaceVersion!==project.workspaceVersion || state.workspaceVersion!==project.workspaceVersion ||
      core.readSettings().sourceSha256!==settingsHash) fail(409,'PROJECT_STATE_CHANGED','Snapshot changed while preparing the actual binding.');
    if(languageProjection(bound).providerGeneration!==project.capabilities.language.providerGeneration)fail(409,'PROJECT_STATE_CHANGED','Local provider configuration changed during snapshot.');
    return {session:state,project,activeDocument,proposals:clone(proposals),lastRun:clone(currentRuntimeRun()),report:clone(report),chat:clone(chat),languageBootstrap:binding?.bootstrap()??null};
  }
  /** Read-only, one in-flight measurement per authenticated peer. Never holds the source
   * FIFO across a probe or queues CODE_CHANGED/Veto behind readiness. No cached authority. */
  function refreshReadiness(ws:WebSocket) {
    const peer=peers.get(ws), bound=startup;
    if(!peer?.authenticated || peer.refreshing)return;
    if(controlPreparing || session.state.writeOwner!=='STUDENT'){peer.readinessDeferred=true;return;}
    const generation=peer.handshakeGeneration;
    const current=()=>{
      if(peers.get(ws)!==peer || !peer.authenticated || peer.handshakeGeneration!==generation ||
          startup!==bound || closing || transitioning || ws.readyState!==WebSocket.OPEN)return false;
      try {
        const core=currentCore();
        core.session.assertClient(peer.clientId!,core.session.state.sessionId);
        binding!.clients.assertBound(peer.clientId!,core.session.state.sessionId);
        return true;
      } catch { return false; }
    };
    peer.refreshing=true;peer.readinessDeferred=false;
    void (async()=>{
      while(current()) {
        const core=currentCore();
        let version:number|undefined,hash:string|null|undefined,epoch:number|undefined,viewPath:string|null|undefined;
        const changed=()=>version!==undefined && (core.workspace.workspaceVersion!==version || core.readSettings().sourceSha256!==hash || core.session.state.controlEpoch!==epoch || core.session.state.activeFilePath!==viewPath);
        try {
          const bundle=await getBundle(true,()=>{
            if(!current())fail(409,'PROJECT_STATE_CHANGED','Readiness peer changed before source materialization.');
            version=core.workspace.workspaceVersion;hash=core.readSettings().sourceSha256;epoch=core.session.state.controlEpoch;viewPath=core.session.state.activeFilePath;
          });
          if(!current())return;
          if(controlPreparing || core.session.state.writeOwner!=='STUDENT'){peer.readinessDeferred=true;return;}
          // An intervening edit/settings/Veto may invalidate a measured projection, never
          // the original edit ACK. Re-read only on witnessed source/control change.
          if(changed() || bundle.session.lastServerSeq!==core.session.state.lastServerSeq)continue;
          emit('SESSION_SNAPSHOT',bundle);return;
        } catch(error) {
          if(current() && (error as {code?:string}).code==='PROJECT_STATE_CHANGED' && changed())continue;
          if(current())emit('ERROR',apiError(error));
          return; // A failed read grants nothing; a later refresh/reconnect retries.
        }
      }
    })().catch(error=>{if(current())emit('ERROR',apiError(error));}).finally(()=>{
      peer.refreshing=false;
      if(peers.get(ws)===peer && peer.authenticated && peer.handshakeGeneration!==generation)refreshReadiness(ws);
      else if(peer.readinessDeferred && current() && !controlPreparing && session.state.writeOwner==='STUDENT')refreshReadiness(ws);
    });
  }
  function refreshConnectedReadiness() { for(const [ws,peer] of peers)if(peer.authenticated)refreshReadiness(ws); }
  async function snapshot() { const bundle=await getBundle(); emit('SESSION_SNAPSHOT',bundle);
    if(bundle.project.capabilities.execution.runtime.problem?.code==='RUNTIME_READINESS_PENDING')refreshConnectedReadiness();
  }
  function postProposal(decision:Extract<CoachDecision,{kind:'PROPOSE'}>) {
    // Defense in depth for stale/injected CoachService implementations bypassing the adapter.
    if(decision.proposalKind==='GENERATE_TESTS') {
      emit('ERROR',{code:'COACH_RESPONSE_REJECTED',message:'Generowanie testów jest niedostępne; zachowano pracę.',retryable:false,requestId:null,currentVersion:null});
      return;
    }
    const proposal:Proposal = {proposalId:randomUUID(),kind:decision.proposalKind,questionText:decision.questionText,yesLabel:'Tak, wykonaj',noLabel:'Nie, pracuję dalej',basedOnWorkspaceVersion:workspace.workspaceVersion,expiresAt:new Date(Date.now()+60000).toISOString(),paths:decision.paths,snapshotId:decision.snapshotId,resetTimer:false};
    proposals=proposals.filter(p=>Date.parse(p.expiresAt)>Date.now()).slice(-9); proposals.push(proposal); emit('ACTION_PROPOSAL',proposal);
  }
  type Core = ReturnType<typeof currentCore>;
  // Preparation owns its core, listeners and services. Nothing may publish to the old binding.
  async function prepareBinding(core:Core, owner:RuntimeStartup) {
    const {workspace:boundWorkspace,session:boundSession}=core;
    let active=false, disposed=false;
    let boundCoach:CoachService|undefined, boundExecution:ExecutionServices|undefined;
    let boundReports:ExecutionServices['reports']|undefined;
    let boundRuntime: ReturnType<typeof createRuntimeExecution> | undefined, runtimeError:unknown;
    let localBootstrap:LanguageBootstrapV2|null=null;
    let layout:ReturnType<typeof retainRuntimeExecutionLayout>|undefined;
    let mutations:DurableMutationJournal|undefined, clients:RuntimeClientOwnership|undefined;
    let saves:RuntimeSettingsMutation|undefined, runs:RuntimeRunMutation|undefined, network:RuntimeNetworkMaintenance|undefined;
    const pending=new Set<Promise<unknown>>();
    function track<T>(operation:Promise<T>):Promise<T> {pending.add(operation);void operation.finally(()=>pending.delete(operation)).catch(()=>{});return operation;}
    const listeners:{source:WorkspaceService|SessionController;event:string;handler:(...args:any[])=>void}[]=[];
    const publish=(type:string,payload:unknown)=>{
      if(!active)return;
      emit(type,payload);
    };
    const boundContext:ServiceContext={...core,emit:publish,onProposal:decision=>{if(active)postProposal(decision);},
      canAnalyze:()=>active && !transitioning && !closing,
      readContext:async<T>(read:()=>T,signal:AbortSignal):Promise<T>=>{
        const assertBound=()=>{
          if(signal.aborted || !active || disposed || startup!==owner || transitioning || closing)
            fail(409,'COACH_CONTEXT_REVOKED','Actual coach project binding changed during context admission.');
        };
        const checked=()=>{assertBound();const value=read();assertBound();return value;};
        assertBound();
        // Ordinary mutation FIFO only: no language source/capture/readiness dependency.
        await boundWorkspace._withQueuedMutation(async()=>{});
        const value=checked();
        assertBound();return value;
      }};
    const on=(source:WorkspaceService|SessionController,event:string,handler:(...args:any[])=>void)=>{
      source.on(event,handler);listeners.push({source,event,handler});
    };
    async function dispose() {
      if(disposed)return;
      disposed=true;active=false;
      await Promise.allSettled([...pending]);
      await network?.close();
      await mutations?.close();
      // Continue cleanup even if a closing report cannot persist INTERRUPTED on a failed disk.
      for(const {source,event,handler} of listeners)source.off(event,handler);
      try {boundCoach?.close();} finally {
        try {boundReports?.close();} finally {core.close();}
      }
    }
    try {
      // One canonical journal per real project, independent of config/daemon readiness.
      mutations=new DurableMutationJournal(path.join(boundWorkspace.dataDir,'runtime-mutations'));
      clients=new RuntimeClientOwnership(path.join(boundWorkspace.dataDir,'runtime-clients'),boundWorkspace.projectId);
      saves=new RuntimeSettingsMutation(core,mutations);
      network=new RuntimeNetworkMaintenance(path.join(boundWorkspace.dataDir,'runtime-network-maintenance'),boundWorkspace.projectId);
      if(options.enableExecution) {
        try {
          const admissions=mutations.runAdmissions();
          layout = retainRuntimeExecutionLayout(boundWorkspace.dataDir,path.join(path.dirname(owner.arguments.runtimeConfigPath), '.paircoach-runtime'),
            boundWorkspace.rootPath, boundWorkspace.projectId, admissions.map(a=>a.stage.plan),owner.arguments.preparedRuntimeRoots);
          const client = startupTransports.get(owner)!;
          if(!options.runtimeTransport) client.install(createRuntimeDockerTransport({ stateDirectory:layout.stateDirectory, executable:options.dockerExecutable }));
          boundRuntime = createRuntimeExecution({core, configuration:owner.configuration, prepared:owner.prepared, layout,
            transport:client.transport, serviceNetwork:`paircoach-${layout.installationId}-service-http-v1`, emit:(type,payload)=>{
              // Old-session owners remain queryable/stoppable but NEVER become the new
              // session's lastRun/coach facts/report or authenticated Run stream.
              if(boundRuntime?.runner.belongsToSession((payload as {runId:string}).runId,boundSession.state.sessionId))publish(type,payload);
            },
            assertCurrent:()=>{if(disposed || startup!==owner || transitioning || closing) fail(409,'PROJECT_STATE_CHANGED','Runtime binding changed during admission.');}});
        } catch(error) {runtimeError=error;} // ONLY execution is unavailable; real editor/recovery stay live.
      }
      // Original admission recovery is independent of today's configuration/daemon availability.
      runs=new RuntimeRunMutation(core,mutations,boundRuntime ?? {start:async()=>fail(503,'RUNTIME_UNAVAILABLE','Neutral runtime is unavailable; no host fallback exists.')});
      if(boundRuntime) {
        try {
          await boundRuntime.recover(mutations.runAdmissions(),(identity,stage)=>runs!.validate(identity.payload as RunRequestV2,stage),
            (identity,stage)=>mutations!.revokeRunDispatch(identity,stage));
          // Publish only original acceptance recovery, never a new start/current result.
          for(const a of mutations.runAdmissions())await runs.recover(a.identity.payload as RunRequestV2);
        } catch(error) {runtimeError=error;}
      }
      if(options.executionFactory) { boundExecution=options.executionFactory(boundContext); boundReports=boundExecution.reports; }
      else if(options.enableExecution) {
        // Reports are independent from Run availability; NEVER instantiate the legacy host Runner.
        boundReports=new ReportService({dataDir:boundWorkspace.dataDir,projectId:boundWorkspace.projectId,emit:(type,payload)=>{
          if(!persistingFinish)publish(type,payload);
        },generate:reportGenerator()});
      }
      boundCoach=options.enableCoach ? (options.coachFactory?.(boundContext) ??
        new CoachAdapter({...boundContext,provider:options.coachProvider,sensitiveValues:[token,process.env.GEMINI_API_KEY||'']})) : undefined;
      on(boundWorkspace,'external',(payload:unknown)=>{boundCoach?.abort();publish('EXTERNAL_FILE_SYNC',payload);publish('SESSION_STATE',boundSession.getSession());});
      on(boundSession,'state',()=>publish('SESSION_STATE',boundSession.getSession()));
      on(boundSession,'overtime',()=>{publish('CHAT_REPLY',{replyTo:null,text:'Limit czasu minął. Możesz dalej pisać i samodzielnie zakończyć próbę.'});if(active)boundCoach?.trigger('OVERTIME');});
      on(boundWorkspace,'watcherError',(error:unknown)=>publish('ERROR',apiError(error)));
      on(boundSession,'control',(payload:unknown)=>publish('CONTROL_STATE',payload));
      on(boundSession,'veto',()=>boundCoach?.abort());
      return {execution:boundExecution,runtime:boundRuntime,runtimeError,bootstrap:()=>clone(localBootstrap),connectLocal(connectionGeneration:string){
        const resolved=owner.configuration.resolved??owner.configuration.local;
        localBootstrap=resolved && ['builtin','off'].includes(resolved.profile.language.provider) ? {
          connectionGeneration,shadowGeneration:randomUUID(),provider:resolved.profile.language.provider as 'builtin'|'off',
          features:resolved.profile.language.provider==='builtin' ? clone(resolved.config.languageFeatures) : {completion:false,diagnostics:false}} : null;
      },mutations,clients,saves,runs,network,track,activate(){active=true;coach=boundCoach;execution=boundExecution;reports=boundReports;runtimeExecution=boundRuntime;},dispose};
    } catch(error) {await dispose();throw error;}
  }
  let binding:Awaited<ReturnType<typeof prepareBinding>>|undefined;
  // Catch immediately to avoid an unhandled rejection if the caller has not called listen yet.
  const initialized = constructStartup(options.rootPath).then(async value => {
    startup=value;
    try {
      if(closing) {value.close();return {error:new TransportError(503,'SESSION_CLOSED','Server closed during recovery.')};}
      if(value.core) {
        ({workspace,session,gate}=value.core);
        binding=await prepareBinding(value.core,value);binding.activate();
      }
      return {error:null};
    } catch(error) { value.close();return {error}; }
  }, error => ({error}));
  async function ready() { const result=await initialized; if(result.error) throw result.error; }
  function reportGenerator():((facts:FrozenFacts,signal:AbortSignal)=>Promise<string>)|undefined {
    const configured=options.reportGenerate;
    const apiKey=process.env.GEMINI_API_KEY;
    const useCodex=process.env.PAIRCOACH_COACH_PROVIDER?.trim().toLowerCase()==='codex';
    if(!configured && !useCodex && !apiKey) return undefined; // ReportService's explicit local-facts fallback.
    const codexProvider=!configured && useCodex ? new CodexCoachProvider() : undefined;
    return async (frozen,signal)=>{
      if(frozen.aiConsent!==true) throw new Error('AI_CONSENT_REQUIRED');
      const settings=frozen.settings as Settings;
      const allowed=(p:string)=>isContextPathAllowed(p) && settings.contextPatterns.some(pattern=>matchesContextPattern(p,pattern));
      const material=frozen.finalMaterial as ReturnType<WorkspaceService['readSnapshot']>;
      let bytes=0;
      const omittedPaths:string[]=[];
      const documents: {path:string;content:string}[]=[];
      for(const file of material.files) {
        if(file.rawBase64===null || !allowed(file.path)) continue;
        const content=Buffer.from(file.rawBase64,'base64').toString('utf8').replace(/^\uFEFF/,'').replace(/\r\n/g,'\n');
        const safe=redactSecrets(content,[token,apiKey||'']);
        if(bytes+Buffer.byteLength(safe)>262144) {omittedPaths.push(file.path);continue;}
        bytes+=Buffer.byteLength(safe);documents.push({path:file.path,content:safe});
      }
      const events=(frozen.events as {type?:string;payload?:any}[]).flatMap(e=>{
        if(e.type==='VETO_EXECUTED') return [e];
        if(e.type==='COACH_STEP_EDIT' && allowed(e.payload?.path||'')) return [{type:e.type,payload:{
          path:e.payload.path,interventionId:e.payload.interventionId,range:e.payload.range,
          version:e.payload.version,workspaceVersion:e.payload.workspaceVersion}}];
        return [];
      });
      const safe:ReportAIFacts={session:clone(frozen.session),snapshot:{...clone(frozen.snapshot),paths:frozen.snapshot.paths.filter(allowed)},
        runs:frozen.runs.map(projectRunFacts),
        chat:clone(frozen.chat),events,aiConsent:true,
        taskMode:settings.taskMode,documents,omittedPaths,systemPrompt:REPORT_SYSTEM_PROMPT};
      // Metadata and pasted chat can contain the API token too. Raw process output is never projected.
      const projected=JSON.parse(JSON.stringify(safe,(_key,value)=>typeof value==='string'?redactSecrets(value,[token,apiKey||'']):value)) as ReportAIFacts;
      signal.throwIfAborted();
      if(configured) return configured(projected,signal);
      if(codexProvider) return codexProvider.generateReport(projected, REPORT_SYSTEM_PROMPT, signal);
      const {GoogleGenAI}=await import('@google/genai');
      signal.throwIfAborted();
      const ai=new GoogleGenAI({apiKey:apiKey!});
      const response=await ai.models.generateContent({model:process.env.GEMINI_MODEL||'gemini-2.5-flash',contents:JSON.stringify(projected),
        config:{systemInstruction:REPORT_SYSTEM_PROMPT,abortSignal:signal}});
      signal.throwIfAborted();
      if(!response.text) throw new Error('REPORT_EMPTY_RESPONSE');
      return response.text;
    };
  }
  function sameToken(candidate:string) {
    const a=Buffer.from(candidate),b=Buffer.from(token); return a.length===b.length && timingSafeEqual(a,b);
  }
  function currentPort() { const addr=server.address(); return typeof addr==='object' && addr ? addr.port : port; }
  function trust(req:IncomingMessage) {
    const host=req.headers.host;
    const hosts=[`127.0.0.1:${currentPort()}`,`localhost:${currentPort()}`];
    if (!host || !hosts.includes(host)) fail(403,'HOST_FORBIDDEN','Niedozwolony Host.');
    const origin=req.headers.origin;
    const origins=hosts.map(h=>`http://${h}`);
    if (devBootstrap) origins.push('http://127.0.0.1:3000','http://localhost:3000');
    if (origin && !origins.includes(origin)) fail(403,'ORIGIN_FORBIDDEN','Niedozwolony Origin.');
  }
  function authorize(req:IncomingMessage) {
    const header=req.headers.authorization || '';
    if (!header.startsWith('Bearer ') || !sameToken(header.slice(7))) fail(401,'UNAUTHORIZED','Brak lub niepoprawny token lokalnej sesji.');
  }
  function respond(res:ServerResponse,status:number,value:unknown) {
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(JSON.stringify(value));
  }
  async function readBody(req:IncomingMessage) {
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) fail(400,'CONTENT_TYPE','Wymagany JSON.');
    let size=0; const chunks:Buffer[]=[];
    for await(const chunk of req) {
      size+=chunk.length;
      if(size>6*1024*1024) fail(413,'BODY_TOO_LARGE','Przekroczono limit żądania.');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail(400,'INVALID_JSON','Niepoprawny JSON.'); }
  }
  function validateOpenProject(body:unknown):boolean {
    // Reuse the strict existing OpenProject schema with V2 Settings via a V2 request validator.
    return validateRuntimeOpenProjectRequest(body);
  }
  function authInput(clientId:string,sessionId:string,controlEpoch:number,actor:'STUDENT'|'COACH'='STUDENT') { return {clientId,sessionId,controlEpoch,actor}; }
  function assertVersion(value:number) { if(value!==workspace.workspaceVersion) fail(409,'WORKSPACE_VERSION_CONFLICT','Projekt zmienił się; zsynchronizuj stan.'); }
  function vetoKey(id:string) { return `${session.state.sessionId}:VETO:${id}`; }
  async function veto(id:string,clientId:string,sessionId:string,payload:any) {
    session.assertClient(clientId,sessionId);
    return ledger.run(vetoKey(id),{clientId,sessionId,...payload},()=>{
      session.assertClient(clientId,sessionId);
      // The cutoff is synchronous, before any provider abort await.
      const previousEpoch=session.state.controlEpoch;
      const result=session.veto();
      if(result.controlEpoch!==previousEpoch) facts.push({type:'VETO_EXECUTED',at:new Date().toISOString(),epoch:result.controlEpoch});
      coach?.abort(); return clone(result);
    });
  }
  async function stopRuntimeForTransition(requireNoPendingAdmission=true) {
    if(options.enableExecution && !options.executionFactory && (!runtimeExecution || binding?.runtimeError))
      fail(409,'RUN_RECOVERY_REQUIRED','Runtime ownership could not be recovered; finish/project replacement cannot forget retained Runs. Editing remains available.');
    await runtimeExecution?.stopAll();
    if(requireNoPendingAdmission && options.enableExecution && !options.executionFactory)binding?.mutations.assertNoPendingRuns();
  }
  async function finish(reason:Report['reason']) {
    if(transitioning) fail(409,'SESSION_TRANSITION','Poczekaj na utrwalenie bieżącej operacji; lokalny draft pozostaje niezapisany.');
    if (!reports) fail(503,'REPORTS_NOT_ENABLED','Reports are not enabled.');
    if(session.state.lifecycle==='FINISHED') return reports.get(session.state.sessionId);
    transitioning=true;
    try {
      coach?.abort(); session.releaseCoach();
      await execution?.runner.stopAll();
      await stopRuntimeForTransition();
      const finalSnapshot=await workspace.createSnapshotAsync('Stan końcowy próby');
      const finalMaterial=workspace.readSnapshot(finalSnapshot.snapshotId);
      const finalSession=session.getSession();
      // Persist the prospective closed state first; a storage error must not announce FINISHED.
      finalSession.lifecycle='FINISHED';finalSession.controlEpoch++;finalSession.writeOwner='STUDENT';
      finalSession.interventionId=null;finalSession.coachMode='UNAVAILABLE';finalSession.timer.status='STOPPED';
      const frozen:FrozenFacts={session:finalSession,snapshot:clone(finalSnapshot),finalMaterial:clone(finalMaterial),
        settings:clone(workspace.settings),aiConsent:workspace.settings.aiConsent,
        runs:clone(execution?.runner.list() ?? runtimeExecution?.runner.list(session.state.sessionId) ?? []),chat:clone(chat),events:clone(facts)};
      persistingFinish=true;
      try { report=reports.finish(reason,frozen); } finally {persistingFinish=false;}
      session.finish();emit('SESSION_REPORT',report);return clone(report);
    } finally { transitioning=false; }
  }
  async function handleHttp(req:IncomingMessage,res:ServerResponse) {
    let requestId:string|null=null;
    try {
      await ready();
      trust(req);
      if(req.headers.origin) res.setHeader('Access-Control-Allow-Origin',req.headers.origin);
      res.setHeader('Vary','Origin');
      const url=new URL(req.url || '/','http://127.0.0.1');
      if(req.method==='OPTIONS') {
        res.writeHead(204,{'Access-Control-Allow-Methods':'GET, POST, PUT, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'600'});res.end();return;
      }
      if(url.pathname==='/dev/bootstrap' && req.method==='GET') {
        if (!devBootstrap) fail(404,'NOT_FOUND','Bootstrap developerski jest wyłączony.');
        respond(res,200,{token}); return;
      }
      if (!url.pathname.startsWith('/api/')) { serveStatic(url,res,req.method);return; }
      authorize(req);
      // UNBOUND keeps auth/static/bootstrap available, but never publishes a fictitious project/session.
      if(url.pathname!=='/api/project/open') currentCore();
      if(req.method==='GET') {
        let value:unknown;
        if(url.pathname==='/api/project') {
          // Explicit measured read for operators/manual refresh; editor bootstrap is cheap.
          if(url.search && (url.searchParams.size!==1 || url.searchParams.get('readiness')!=='actual'))
            fail(400,'VALIDATION_ERROR','Use no query for editor state or readiness=actual for a measured runtime read.');
          value=await getProject(url.searchParams.get('readiness')==='actual');
        }
        else if(url.pathname==='/api/session') value=session.getSession();
        else if(url.pathname==='/api/file') value=workspace.getDocument(url.searchParams.get('path')||'');
        else if(url.pathname==='/api/snapshots') value=workspace.listSnapshots();
        else if(url.pathname==='/api/session/report') {
          const requestedId=url.searchParams.get('sessionId') ?? '';
          if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestedId)) fail(400,'INVALID_ID','Niepoprawny identyfikator sesji.');
          value=reports ? reports.get(requestedId) : (requestedId===session.state.sessionId ? report : null);
          if(!value) fail(404,'REPORT_NOT_FOUND','Brak raportu tej sesji.');
        } else if(url.pathname==='/api/session/reports') {
          if(!reports?.list) fail(503,'GATE003_NOT_ENABLED','Historia raportów nie jest jeszcze włączona.');
          value={reports:reports.list()};
        } else if(/^\/api\/run\/[A-Za-z0-9._:-]+$/.test(url.pathname)) {
          if(!execution && !runtimeExecution) fail(503,'GATE003_NOT_ENABLED','Runner nie jest jeszcze włączony.'); value=(execution?.runner ?? runtimeExecution!.runner).get(url.pathname.split('/')[3]);
        } else fail(404,'NOT_FOUND','Nieznany endpoint.');
        respond(res,200,value);
        if(url.pathname==='/api/project' && (value as ProjectV2).capabilities.execution.runtime.problem?.code==='RUNTIME_READINESS_PENDING')refreshConnectedReadiness();
        return;
      }
      if(req.method==='POST' && url.pathname==='/api/runtime/service-network/prepare') {
        const body:unknown=await readBody(req);
        if(!validateRuntimeNetworkPrepareRequest(body))fail(400,'VALIDATION_ERROR','Maintenance requires only the exact original request/client/session/version/configuration/epoch.');
        requestId=body.requestId;
        respond(res,200,await prepareServiceNetwork(body));return;
      }
      if(req.method==='POST' && url.pathname==='/api/runtime/mutation/reconcile') {
        const body:unknown=await readBody(req);
        if(!validateReconcileMutationRequestV2(body)) fail(400,'VALIDATION_ERROR','Reconcile requires the exact original immutable request.');
        respond(res,200,await reconcileMutation(body as ReconcileMutationRequestV2));return;
      }
      const routes:Record<string,[string,number]>={
        'POST /api/project/open':['OpenProjectRequest',201], 'PUT /api/project/settings':['UpdateSettingsRequest',200],
        'POST /api/file':['FileOperationRequest',200], 'POST /api/session/start':['StartSessionRequest',200],
        'POST /api/session/veto':['VetoRequest',200], 'POST /api/run':['RunRequest',202],
        'POST /api/session/finish':['FinishRequest',202], 'POST /api/session/report/retry':['SessionCommand',202],
      };
      const key=`${req.method} ${url.pathname}`;
      const stopMatch=req.method==='POST' && /^\/api\/run\/[A-Za-z0-9._:-]+\/stop$/.test(url.pathname);
      const route=routes[key] || (stopMatch ? ['SessionCommand',202] as [string,number]:undefined);
      if(!route) fail(404,'NOT_FOUND','Nieznana komenda.');
      const body=await readBody(req); requestId=typeof body?.requestId==='string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.requestId) ? body.requestId:null;
      if(!(route[0]==='RunRequest' || route[0]==='UpdateSettingsRequest' ? validateV2Request(route[0],body) :
        route[0]==='OpenProjectRequest' ? validateOpenProject(body) : validateRequest(route[0],body))) fail(400,'VALIDATION_ERROR','Komenda niezgodna z kontraktem.');
      if(url.pathname==='/api/session/veto') {
        const op=await veto(body.requestId,body.clientId,body.sessionId,{controlEpoch:body.controlEpoch,activeInterventionId:body.activeInterventionId,lastAppliedSeq:body.lastAppliedSeq});
        respond(res,route[1],await op.result);return;
      }
      if(url.pathname!=='/api/project/open') session.assertClient(body.clientId,body.sessionId);
      if(url.pathname==='/api/project/settings') {
        // Durable result authority, not an expiring in-memory HTTP receipt.
        const project=await saveSettings(body as UpdateSettingsRequestV2);
        respond(res,200,project);
        if(project.capabilities.execution.runtime.problem?.code==='RUNTIME_READINESS_PENDING')refreshConnectedReadiness();
        return;
      }
      if(url.pathname==='/api/run') {
        // SAME durable journal, not the expiring HTTP command ledger.
        respond(res,202,await startRun(body as RunRequestV2));return;
      }
      const commandLedger=url.pathname==='/api/project/open' ? openLedger : ledger;
      const operation=commandLedger.run(`HTTP:${body.requestId}`,{route:key,body},async()=>{
        if(closing) fail(503,'SESSION_CLOSED','Serwer zamyka sesję.');
        if(url.pathname!=='/api/project/open') session.assertClient(body.clientId,body.sessionId);
        if(transitioning && !stopMatch) fail(409,'SESSION_TRANSITION','Trwa bezpieczna zmiana sesji; zachowaj draft.');
        if(url.pathname==='/api/project/open') {
          if(startup.core?.session.leaseClientId && startup.core.session.leaseClientId!==body.clientId) fail(409,'LEASE_CONFLICT','Inna karta posiada dzierżawę.');
          if(transitioning) fail(409,'SESSION_TRANSITION','Project transition is already in progress.');
          transitioning=true;
          let next:RuntimeStartup|undefined, prepared:Awaited<ReturnType<typeof prepareBinding>>|undefined, adopted=false;
          try {
            // Reserve transition BEFORE awaiting construction/recovery. GET/snapshot refuses mixed bindings.
            if(startup.core && path.resolve(body.rootPath)===startup.core.workspace.rootPath) {
              session.claimLease(body.clientId); binding!.clients.bind(body.clientId,session.state.sessionId); transitioning=false; return await getProject(false);
            }
            next=await makeCore(body.rootPath);
            const nextCore=requireRuntimeWorkspace(next);
            // Open is NOT a settings SAVE. Its opening form is never authority or persisted.
            nextCore.session.claimLease(body.clientId);
            // Reject an unsafe/unaccounted old owner before the next binding can
            // create runtime state (its config parent may be the old workspace).
            await execution?.runner.stopAll();
            await stopRuntimeForTransition();
            prepared=await prepareBinding(nextCore,next);
            prepared.clients.bind(body.clientId,nextCore.session.state.sessionId);
            if(closing) fail(503,'SESSION_CLOSED','Server is closing; project was not adopted.');
            const previous=binding, previousStartup=startup, previousLedger=ledger, previousProposals=proposalOutcomes;
            startup=next;({workspace,session,gate}=nextCore);binding=prepared;controlPreparing=false;
            ({ledger,proposalOutcomes}=makeLedgers());adopted=true;
            previousLedger.retire();previousProposals.retire();
            chat=[];proposals=[];report=null;lastRun=null;facts.length=0;
            // ONE global sequence, including project changes; never reuse old sequence numbers.
            try {if(previous)await previous.dispose();else previousStartup.close();} catch { /* adopted authority is not rolled back */ }
            binding.activate();
            for(const [ws,p] of peers) {p.authenticated=false;p.handshakeGeneration=null;ws.close(1012,'Project changed; reconnect');}
            transitioning=false;
            return await getProject(false);
          } finally {
            try {if(!adopted && next){if(prepared){await prepared.execution?.runner.stopAll();await prepared.runtime?.stopAll();await prepared.dispose();}else next.close();}}
            finally {transitioning=false;}
          }
        }
        if(url.pathname==='/api/file') { await gate.mutateAsync({...body,actor:'STUDENT'});await snapshot();return getProject(false); }
        if(url.pathname==='/api/session/start') { const state=session.start(body.limitMs,body.pauseOnHidden);coach?.trigger('START');return clone(state); }
        if(stopMatch) { if(!execution && !runtimeExecution) fail(503,'GATE003_NOT_ENABLED','Runner nie jest jeszcze włączony.');return (execution?.runner ?? runtimeExecution!.runner).stop(url.pathname.split('/')[3]); }
        if(url.pathname==='/api/session/finish') { assertVersion(body.expectedWorkspaceVersion); return finish(body.reason); }
        if(url.pathname==='/api/session/report/retry') { if(!reports) fail(503,'REPORTS_NOT_ENABLED','Raport nie jest jeszcze włączony.'); report=reports.retry(body.sessionId);return clone(report); }
        return fail(404,'NOT_FOUND','Nieznana komenda.');
      });
      respond(res,route[1],await operation.result);
    } catch(error) {
      if(!res.headersSent) respond(res,(error as any)?.status || 500,apiError(error,requestId)); else res.end();
    }
  }
  function serveStatic(url:URL,res:ServerResponse,method?:string) {
    if(method!=='GET' && method!=='HEAD') fail(404,'NOT_FOUND','Nieznany zasób.');
    const root=path.resolve(options.staticDir || path.join(process.cwd(),'dist'));
    let relative:string;
    try { relative=decodeURIComponent(url.pathname); } catch { return fail(400,'INVALID_PATH','Niepoprawny URL.'); }
    if(relative.includes('\0') || relative.includes('\\') || relative.split('/').includes('..')) fail(403,'PATH_FORBIDDEN','Niedozwolona ścieżka.');
    const file=path.resolve(root,relative==='/' ? 'index.html':relative.slice(1));
    if(!file.startsWith(root+path.sep)) fail(403,'PATH_FORBIDDEN','Niedozwolona ścieżka.');
    if(!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(404,'NOT_FOUND','Zbuduj UI: npm run build.');
    const real=fs.realpathSync(file),rootReal=fs.realpathSync(root);
    if(!real.startsWith(rootReal+path.sep)) fail(403,'PATH_FORBIDDEN','Niedozwolony zasób.');
    const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2','.ttf':'font/ttf'};
    // Keep headers uncommitted until data arrives so an open/early read error can be a 500.
    res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Referrer-Policy','no-referrer');
    if(method==='HEAD') {res.end();return;}
    const source=fs.createReadStream(file);
    const stop=()=>{source.destroy();};
    res.once('close',stop);
    res.once('error',stop);
    source.on('error',error=>{
      source.unpipe(res);
      source.destroy();
      if(res.destroyed || res.writableEnded) return;
      if(res.headersSent) res.destroy();
      else respond(res,500,apiError(error));
    });
    source.once('close',()=>{
      res.off('close',stop);
      res.off('error',stop);
    });
    source.pipe(res);
  }
  server.on('upgrade',(req,socket,head)=>{
    try { trust(req); if(req.url!=='/ws/session') fail(404,'NOT_FOUND','Nieznany WS.');
      if(peers.size>=16) fail(429,'CONNECTION_LIMIT','Zbyt wiele połączeń.');
      wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
    } catch(error) { socket.write(`HTTP/1.1 ${(error as any)?.status||403} Forbidden\r\nConnection: close\r\n\r\n`);socket.destroy(); }
  });
  wss.on('connection',(ws)=>{
    const peer={id:randomUUID(),clientId:null as string|null,authenticated:false,refreshing:false,readinessDeferred:false,alive:true,count:0,since:Date.now(),queued:0,queue:Promise.resolve(),handshakeGeneration:null,leaseSession:null as SessionController|null};peers.set(ws,peer);
    const helloDeadline=setTimeout(()=>{if(!peer.authenticated) ws.close(1008,'HELLO required');},3000);
    ws.on('pong',()=>{peer.alive=true;});
    ws.on('message',(data)=>{
      if(++peer.queued>64){peer.queued--;ws.close(1008,'Admission queue limit');return;}
      const raw=data.toString();
      // Controls must remain responsive during a pending source transaction.
      // receive still validates the complete envelope, authentication and current scope.
      let immediateControl=false;
      try {
        const type=JSON.parse(raw)?.type;
        immediateControl=['VETO_ESCAPE','PING','WINDOW_STATE','TIMER_ACTION'].includes(type) || (transitioning && type!=='HELLO');
      } catch { /* normal validator closes */ }
      const operation=()=>receive(ws,raw).finally(()=>{peer.queued--;});
      if(immediateControl) void operation();
      else peer.queue=peer.queue.then(operation,operation);
    });
    ws.on('error',()=>{ /* close handler revokes this connection; no token-bearing errors logged */ });
    ws.on('close',()=>{
      clearTimeout(helloDeadline);peers.delete(ws);
      if(peer.handshakeGeneration && peer.leaseSession && peer.clientId && ![...peers.values()].some(p=>(p.authenticated || p.handshakeGeneration!==null) && p.clientId===peer.clientId && p.leaseSession===peer.leaseSession)) {
        coach?.abort();peer.leaseSession.releaseLease(peer.clientId);
      }
    });
  });
  function ack(message:ClientMessage,status:'OK'|'DUPLICATE'|'REJECTED',documentVersion:number|null=null,error:unknown=null) {
    emit('ACK',{replyTo:message.messageId,status,documentVersion,workspaceVersion:workspace.workspaceVersion,controlEpoch:session.state.controlEpoch,error:error ? apiError(error,message.messageId):null});
  }
  async function receive(ws:WebSocket,raw:string) {
    const peer=peers.get(ws);if(!peer) return;
    let message:ClientMessage|undefined;
    try {
      const now=Date.now();if(now-peer.since>=1000) {peer.since=now;peer.count=0;}
      if(++peer.count>1000) {ws.close(1008,'Rate limit');return;}
      const parsed:unknown=JSON.parse(raw);
      if(!validateRuntimeClientMessage(parsed)) fail(400,'VALIDATION_ERROR','Wiadomość niezgodna z protokołem.');message=clone(parsed);
      await ready(); currentCore();
      if(message.type==='HELLO') {
        if(!sameToken(message.payload.token)) { ws.close(1008,'Unauthorized');return; }
        if(message.sessionId!==session.state.sessionId) fail(409,'SESSION_CONFLICT','Sesja uległa zmianie.');
        if(!session.claimLease(message.clientId)) {ws.close(1008,'Lease conflict');return;}
        try {binding!.clients.bind(message.clientId,message.sessionId);} catch(error) {session.releaseLease(message.clientId);throw error;}
        const helloGeneration=randomUUID(), helloBinding=startup;
        peer.clientId=message.clientId;peer.handshakeGeneration=helloGeneration;peer.leaseSession=session;
        // Revoke a prior same-client peer BEFORE any new snapshot/control publication.
        for(const [old,p] of peers) if(old!==ws && p.clientId===message.clientId) {p.authenticated=false;p.handshakeGeneration=null;old.close(1012,'Replaced by reconnect');}
        // A reconnect invalidates any old in-flight coach intervention, never replays steps.
        coach?.abort();session.releaseCoach();controlPreparing=false;session.clearEditorView();peer.clientId=message.clientId;
        // Revoke immediately, then await the SAME real root FIFO before reading a snapshot.
        // Reading inside another held capture is correctly WORKSPACE_BUSY, not a cached bootstrap.
        await helloBinding.core!.workspace._withQueuedRead(()=>undefined);
        if(peer.handshakeGeneration!==helloGeneration || startup!==helloBinding || closing)return;
        binding?.connectLocal(helloGeneration);
        const bundle=await getBundle();
        if(!peers.has(ws) || ws.readyState!==WebSocket.OPEN || peer.handshakeGeneration!==helloGeneration || startup!==helloBinding || closing) return;
        peer.authenticated=true;emit('SESSION_SNAPSHOT',bundle);
        if(bundle.project.capabilities.execution.runtime.problem?.code==='RUNTIME_READINESS_PENDING')refreshReadiness(ws);
        return;
      }
      if(!peer.authenticated || message.clientId!==peer.clientId) {ws.close(1008,'HELLO required');return;}
      const admitted=startup, admittedGate=gate,admittedOwner=binding!;
      const transitionControl=['PING','VETO_ESCAPE','WINDOW_STATE','TIMER_ACTION','PROPOSAL_RESPONSE'].includes(message.type);
      const assertPeerCurrent=()=>{
        if(startup!==admitted || closing || peers.get(ws)!==peer || !peer.authenticated ||
          peer.clientId!==message!.clientId || ws.readyState!==WebSocket.OPEN) fail(409,'PEER_REVOKED','Connection authority is no longer current.');
        session.assertClient(message!.clientId,message!.sessionId);
        if(transitioning&&!transitionControl) fail(409,'SESSION_TRANSITION','Trwa utrwalanie sesji; zachowaj lokalny draft.');
      };
      assertPeerCurrent();
      if(validateLanguageClientMessage(message))
        fail(400,'REMOTE_LANGUAGE_DISABLED','Remote language messages are retired. Use local editor features; manual editing remains available.');
      const p=message.payload;
      if(message.type==='VETO_ESCAPE') {
        const op=await veto(message.messageId,message.clientId,message.sessionId,p);await op.result;ack(message,op.duplicate?'DUPLICATE':'OK');return;
      }
      // Heartbeat is effect-free. Keep validation/auth/session checks above, but no history.
      if(message.type==='PING') {ack(message,'OK');return;}
      const command=message;
      const commandLedger=ledger;
      if(command.type==='CODE_CHANGED') {
        // Only the envelope identity is reserved ahead of commit. A sequence is allocated by
        // emit at the ORIGINAL broadcast, never before an asynchronous held preparation.
        // The ledger retains this original payload/identity, not latest workspace state or
        // a guessed baseVersion+1; replay cannot mint a different language receipt.
        const operation=commandLedger.run(`WS:${command.messageId}`,command,async()=>{
          assertPeerCurrent();
          const receiptId=randomUUID();
          let receipt: {messageId:string;payload:{replyTo:string;status:'OK';documentVersion:number;
            workspaceVersion:number;controlEpoch:number;error:null}} | undefined;
          const input={...authInput(command.clientId,command.sessionId,p.controlEpoch),path:p.path,baseVersion:p.baseVersion,content:p.content};
          const captureCommit=(document:Readonly<import('../shared/protocol').Document>)=>{
            receipt={messageId:receiptId,payload:{replyTo:command.messageId,status:'OK',documentVersion:document.version,
              workspaceVersion:workspace.workspaceVersion,controlEpoch:session.state.controlEpoch,error:null}};
          };
          const publish=()=>{
            if(!receipt)throw Error('Missing original commit-time receipt');
            // Old peer/control revocation cannot change the genuine already-committed result.
            // Never publish an old project's result into a replacement project/session.
            if(startup===admitted&&!closing)emit('ACK',receipt.payload,receipt.messageId);
          };
          await admittedGate.writeAsync(input,assertPeerCurrent,document=>{captureCommit(document);publish();});
          if(!receipt)throw Error('Missing original committed CODE_CHANGED receipt');
          // A coach observer cannot retroactively turn the already committed/published save
          // into REJECTED or replace its retained transaction receipt.
          if(startup===admitted&&!closing&&!transitioning&&peer.authenticated&&peers.get(ws)===peer&&session.state.controlEpoch===input.controlEpoch) {
            try {coach?.trigger('EDIT');} catch(error) {emit('ERROR',apiError(error,command.messageId));}
          }
          return receipt;
        });
        const receipt=await admittedOwner.track(operation.result);
        assertPeerCurrent();
        if(operation.duplicate)emit('ACK',{...receipt.payload,status:'DUPLICATE'},receipt.messageId);
        return;
      }
      const op=commandLedger.run(`WS:${message.messageId}`,message,async()=>{
        if(closing) fail(503,'SESSION_CLOSED','Serwer zamyka sesję.');
        assertPeerCurrent();
        if(transitioning && !['PING','PROPOSAL_RESPONSE','WINDOW_STATE','TIMER_ACTION'].includes(command.type)) fail(409,'SESSION_TRANSITION','Trwa utrwalanie sesji; zachowaj lokalny draft.');
        switch(command.type) {
          case 'VIEW_CHANGED': {
            const viewVersion=session.setEditorView(command.clientId,command.sessionId,{path:p.path,documentVersion:p.documentVersion,cursor:p.cursor,selection:p.selection});
            emit('SESSION_STATE',session.getSession());return viewVersion;
          }
          case 'CONTROL_READY': coach?.controlReady(p);return null;
          case 'STEP_RENDERED': coach?.stepRendered(p);return null;
          case 'WINDOW_STATE': session.setPresence(p.presence);if(p.presence!=='FOCUSED') coach?.abort();return null;
          case 'TIMER_ACTION': session.timerAction(p.action,p.pauseOnHidden);if(p.action==='PAUSE') coach?.abort();return null;
          case 'CHAT_MESSAGE': {
            const entry:ChatEntry={messageId:command.messageId,author:'STUDENT',text:p.text,createdAt:new Date().toISOString()};chat.push(entry);chat=chat.slice(-100);session.noteNewFact('CHAT');coach?.trigger('CHAT',entry);return null;
          }
          case 'PROPOSAL_REQUEST': {
            const stored=workspace.listSnapshots().find(s=>s.snapshotId===p.snapshotId);
            if(!stored) fail(404,'SNAPSHOT_NOT_FOUND','Nie znaleziono kopii.');
            postProposal({kind:'PROPOSE',proposalKind:'RESTORE_SNAPSHOT',questionText:'Przywrócić wskazaną kopię? Bieżące pliki zostaną zabezpieczone.',snapshotId:p.snapshotId,paths:stored.paths,resetTimer:false});return null;
          }
          case 'PROPOSAL_RESPONSE': {
            const outcome=proposalOutcomes.run(`${command.sessionId}:${p.proposalId}`,
              {clientId:command.clientId,accepted:p.accepted,basedOnWorkspaceVersion:p.basedOnWorkspaceVersion},async()=>{
              if(transitioning) fail(409,'SESSION_TRANSITION','Trwa utrwalanie sesji; zachowaj lokalny draft.');
              const proposal=proposals.find(item=>item.proposalId===p.proposalId);
              if(!proposal) fail(409,'STALE_PROPOSAL','Propozycja została już rozliczona albo wygasła.');
              try {
                if(p.accepted) {
                  if(Date.parse(proposal.expiresAt)<=Date.now() || proposal.basedOnWorkspaceVersion!==p.basedOnWorkspaceVersion || proposal.basedOnWorkspaceVersion!==workspace.workspaceVersion) fail(409,'STALE_PROPOSAL','Projekt zmienił się lub propozycja wygasła.');
                  if(proposal.kind==='RESTORE_SNAPSHOT'||proposal.kind==='RETRY_FROM_SNAPSHOT') {
                    transitioning=true;
                    try {
                      coach?.abort();session.releaseCoach();
                      await gate.restoreSnapshot({...authInput(command.clientId,command.sessionId,session.state.controlEpoch),
                        snapshotId:proposal.snapshotId!,paths:proposal.paths,expectedWorkspaceVersion:proposal.basedOnWorkspaceVersion});
                    } catch(error) {
                      // Only documented pre-effect failures map to stale. Ambiguous recovery stays visible.
                      if(['SNAPSHOT_BACKUP_FAILED','DISK_CONFLICT','WORKSPACE_VERSION_CONFLICT'].includes((error as {code?:string}).code||''))
                        fail(409,'STALE_PROPOSAL','Nie można bezpiecznie wykonać kopii lub projekt zmienił się. Pliki nie zostały przywrócone.');
                      throw error;
                    } finally {transitioning=false;}
                  } else if(proposal.kind==='FINISH_EXERCISE') await finish('COMPLETED');
                  else fail(503,'GENERATION_UNAVAILABLE','Generowanie testów wymaga aktualnego, zwalidowanego planu AI; istniejące asercje pozostają chronione.');
                }
                return null;
              } finally {
                proposals=proposals.filter(item=>item.proposalId!==p.proposalId);await snapshot();
              }
            });
            await outcome.result;return {proposalDuplicate:outcome.duplicate};
          }
          default: return fail(400,'UNKNOWN_MESSAGE','Nieobsługiwany komunikat.');
        }
      });
      const version=await op.result;assertPeerCurrent();ack(message,op.duplicate || (version as {proposalDuplicate?:boolean}|null)?.proposalDuplicate?'DUPLICATE':'OK',typeof version==='number'?version:null);
    } catch(error) {
      if(message && peer.authenticated) ack(message,'REJECTED',null,error);
      else { if(ws.readyState===WebSocket.OPEN) ws.close(1008,'Invalid or unauthorized message'); }
    }
  }
  const heartbeat=setInterval(()=>{
    for(const [ws,p] of peers) {if(!p.alive) {ws.terminate();continue;}p.alive=false;ws.ping();}
  },5000);heartbeat.unref();
  let listenPromise:Promise<number>|undefined, closePromise:Promise<void>|undefined, socketAttempt:Promise<void>|undefined;
  const listen=():Promise<number> => {
    if(closing) return Promise.reject(new TransportError(503,'SESSION_CLOSED','Server is closed.'));
    return listenPromise ??= (async()=>{
      await ready();
      if(closing) fail(503,'SESSION_CLOSED','Server is closed.');
      await (socketAttempt=new Promise<void>((resolve,reject)=>{
        const failed=(error:Error)=>{server.off('listening',listening);reject(error);};
        const listening=()=>{server.off('error',failed);resolve();};
        server.once('error',failed);server.once('listening',listening);
        server.listen(port,'127.0.0.1');
      }));
      if(closing) fail(503,'SESSION_CLOSED','Server closed while listening.');
      return currentPort();
    })().catch(async error=>{
      try { await close(); }
      catch(cleanupError) {
        const failure=new AggregateError([error,cleanupError],
          `Server startup failed: ${error instanceof Error?error.message:String(error)}; cleanup also failed`,{cause:error});
        // Preserve the original transport classification, alongside both failures.
        if(error && typeof error==='object') for(const key of ['code','status'] as const)
          if(key in error) Object.assign(failure,{[key]:error[key]});
        throw failure;
      }
      throw error;
    });
  };
  const close=():Promise<void> => {
    if(closePromise)return closePromise;
    closing=true;clearInterval(heartbeat);
    return closePromise=(async()=>{
      const result=await initialized;
      await socketAttempt?.catch(()=>{});
      ledger.close();proposalOutcomes.close();openLedger.close();
      try {
        await execution?.runner.stopAll();await stopRuntimeForTransition(false);
      } finally {
        try {if(binding)await binding.dispose();else if(!result.error)startup.close();} finally {
          for(const [ws,p] of peers){p.authenticated=false;ws.terminate();}wss.close();
          if(server.listening)await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
        }
      }
    })();
  };
  return {
    server, get workspace(){return currentCore().workspace;},get session(){return currentCore().session;},get gate(){return currentCore().gate;},
    listen, close,
  };
}
