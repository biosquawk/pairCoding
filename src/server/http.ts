import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { WorkspaceService } from './WorkspaceService';
import { MOCK_SCENARIOS } from '../data/mockScenarios';
import { SessionController } from './SessionController';
import { WriteGate } from './WriteGate';
import { CoachAdapter, type CoachProvider } from './CoachAdapter';
import { Runner } from './Runner';
import { ReportService, REPORT_SYSTEM_PROMPT, type FrozenFacts } from './ReportService';
import { isContextPathAllowed, matchesContextPattern, redactSecrets } from './coach/context';
import type { Settings } from '../shared/protocol';
import {projectRunFacts, type RunFacts} from './coach/runFacts';
import type { ChatEntry, CoachDecision, Proposal, Report, Run, SessionBundle } from '../shared/protocol';
import { apiError, CommandLedger, TransportError, validateMessage, validateRequest, type ClientMessage } from './transport';

/** Network AI receives structural Run facts, never local stdout/stderr or future Run fields. */
export type ReportAIFacts = Pick<FrozenFacts, 'session'|'snapshot'|'chat'|'events'> & {
  runs: RunFacts[];
  [key:string]: unknown;
};
export interface ServerOptions {
  rootPath?: string; dataDir?: string; token?: string; port?: number;
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
}
export interface CoachService {
  trigger(reason: 'EDIT'|'CHAT'|'RUN'|'START'|'OVERTIME', message?: ChatEntry): void;
  updateRun?(run:Run):void;
  controlReady(payload: any): void; stepRendered(payload: any): void; abort(): void; close(): void;
}
export interface ExecutionServices {
  runner: { setApprovedProfiles(profiles: any[]):void; start(profile: any): Run; get(id: string): Run; stop(id:string): Promise<Run>; stopAll():Promise<void>; list():Run[] };
  reports: { finish(reason: Report['reason'],facts:any):Report; get(sessionId:string):Report; retry(sessionId:string):Report; close():void };
}
function fail(status: number, code: string, message: string): never { throw new TransportError(status,code,message); }
const clone = <T>(value:T):T => structuredClone(value);

export function createPairCoachServer(options: ServerOptions = {}) {
  const token = options.token || randomBytes(32).toString('hex');
  const devBootstrap = options.devBootstrap ?? process.env.NODE_ENV !== 'production';
  const port = options.port ?? 8080;
  if ([8765,8766,8767,8768].includes(port)) fail(400,'PORT_FORBIDDEN','Port zastrzeżony.');
  let rootPath = options.rootPath || process.env.PAIRCOACH_WORKSPACE_DIR;
  if (!rootPath) {
    rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'paircoach-workspace-'));
    for(const file of MOCK_SCENARIOS[0].files) {
      const target=path.join(rootPath,file.path);
      if(file.kind==='DIRECTORY') fs.mkdirSync(target,{recursive:true});
      else { fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,file.content); }
    }
  }
  const dataRoot = options.dataDir || process.env.PAIRCOACH_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'PairCoach','sessions');
  const makeWorkspace = (root:string) => new WorkspaceService(root, path.join(dataRoot,createHash('sha256').update(path.resolve(root)).digest('hex').slice(0,24)));
  // Recovery can refuse a root. Never leave its watchers/clock alive or publish a half-open session.
  function makeCore(root:string) {
    const nextWorkspace=makeWorkspace(root);
    let nextSession:SessionController|undefined;
    try {
      nextSession=new SessionController(nextWorkspace);
      const nextGate=new WriteGate(nextWorkspace,nextSession);
      return {workspace:nextWorkspace,session:nextSession,gate:nextGate};
    } catch(error) { nextSession?.close();nextWorkspace.close();throw error; }
  }
  let {workspace,session,gate}=makeCore(rootPath);
  const ledger = new CommandLedger();
  const proposalOutcomes = new CommandLedger();
  let chat:ChatEntry[] = [], proposals:Proposal[] = [], report:Report|null = null, lastRun:Run|null = null;
  const facts:unknown[] = [];
  let seq = 0, closing = false, transitioning = false, persistingFinish = false;
  let coach:CoachService|undefined, execution:ExecutionServices|undefined;
  const peers = new Map<WebSocket,{clientId:string|null; authenticated:boolean; alive:boolean; count:number; since:number}>();
  const server = http.createServer((req,res) => { void handleHttp(req,res); });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.maxHeadersCount = 64;
  const wss = new WebSocketServer({ noServer:true, maxPayload: 6*1024*1024, perMessageDeflate:false });

  function envelope(type:string,payload:unknown) {
    const message = {protocolVersion:'3.0',messageId:randomUUID(),sessionId:session.state.sessionId,seq:++seq,type,payload};
    session.state.lastServerSeq = seq;
    if(type==='SESSION_SNAPSHOT') (payload as SessionBundle).session.lastServerSeq=seq;
    return message;
  }
  // All authenticated peers see every seq, including targeted ACKs. Payloads contain no credentials.
  function emit(type:string,payload:unknown) {
    if (closing) return;
    const message = envelope(type,payload), encoded = JSON.stringify(message);
    if (['COACH_STEP_EDIT','CONTROL_STATE'].includes(type)) facts.push(clone(message));
    if (type==='RUN_STATE') {
      lastRun = clone(payload as Run);
      if (lastRun.finishedAt) { facts.push({type:'RUN',run:clone(lastRun)}); coach?.updateRun?.(lastRun); if(!transitioning) {session.noteNewFact('RUN');coach?.trigger('RUN');} }
    }
    if (type==='SESSION_REPORT') report = clone(payload as Report);
    if (type==='CHAT_REPLY') { chat.push({messageId:message.messageId,author:'COACH',text:(payload as {text:string}).text,createdAt:new Date().toISOString()});chat=chat.slice(-100); }
    for (const [ws,p] of peers) if (p.authenticated && ws.readyState===WebSocket.OPEN) {
      if (ws.bufferedAmount > 8*1024*1024) { ws.close(1013,'Slow consumer'); continue; }
      ws.send(encoded);
    }
  }
  function getBundle():SessionBundle {
    const state = session.getSession();
    const activePath = state.activeFilePath || workspace.settings.taskFilePath;
    let activeDocument = null;
    if (activePath) { try { activeDocument=workspace.getDocument(activePath); } catch { /* explicit file GET reports read error */ } }
    return {session:state,project:workspace.getProject(state.sessionId),activeDocument,proposals:clone(proposals),lastRun:clone(lastRun),report:clone(report),chat:clone(chat)};
  }
  function snapshot() { emit('SESSION_SNAPSHOT',getBundle()); }
  function postProposal(decision:Extract<CoachDecision,{kind:'PROPOSE'}>) {
    const proposal:Proposal = {proposalId:randomUUID(),kind:decision.proposalKind,questionText:decision.questionText,yesLabel:'Tak, wykonaj',noLabel:'Nie, pracuję dalej',basedOnWorkspaceVersion:workspace.workspaceVersion,expiresAt:new Date(Date.now()+60000).toISOString(),paths:decision.paths,snapshotId:decision.snapshotId,resetTimer:false};
    proposals=proposals.filter(p=>Date.parse(p.expiresAt)>Date.now()).slice(-9); proposals.push(proposal); emit('ACTION_PROPOSAL',proposal);
  }
  type Core = ReturnType<typeof makeCore>;
  // Preparation owns its core, listeners and services. Nothing may publish to the old binding.
  function prepareBinding(core:Core) {
    const {workspace:boundWorkspace,session:boundSession}=core;
    let active=false, disposed=false;
    let boundCoach:CoachService|undefined, boundExecution:ExecutionServices|undefined;
    const listeners:{source:WorkspaceService|SessionController;event:string;handler:(...args:any[])=>void}[]=[];
    const publish=(type:string,payload:unknown)=>{if(active)emit(type,payload);};
    const boundContext:ServiceContext={...core,emit:publish,onProposal:decision=>{if(active)postProposal(decision);}};
    const on=(source:WorkspaceService|SessionController,event:string,handler:(...args:any[])=>void)=>{
      source.on(event,handler);listeners.push({source,event,handler});
    };
    function dispose() {
      if(disposed)return;disposed=true;active=false;
      // Continue cleanup even if a closing report cannot persist INTERRUPTED on a failed disk.
      for(const {source,event,handler} of listeners)source.off(event,handler);
      try {boundCoach?.close();} finally {
        try {boundExecution?.reports.close();} finally {boundSession.close();boundWorkspace.close();}
      }
    }
    try {
      if(options.executionFactory)boundExecution=options.executionFactory(boundContext);
      else if(options.enableExecution) {
        // Prepare fallible persistent storage before creating other execution resources.
        const reports=new ReportService({dataDir:boundWorkspace.dataDir,emit:(type,payload)=>{
          if(!persistingFinish)publish(type,payload);
        },generate:reportGenerator()});
        try {boundExecution={reports,runner:new Runner({rootPath:boundWorkspace.rootPath,
          getWorkspaceVersion:()=>boundWorkspace.workspaceVersion,emit:publish})};}
        catch(error){reports.close();throw error;}
      }
      boundCoach=options.enableCoach ? (options.coachFactory?.(boundContext) ??
        new CoachAdapter({...boundContext,provider:options.coachProvider,sensitiveValues:[token,process.env.GEMINI_API_KEY||'']})) : undefined;
      on(boundWorkspace,'external',(payload:unknown)=>{boundCoach?.abort();publish('EXTERNAL_FILE_SYNC',payload);publish('SESSION_STATE',boundSession.getSession());});
      on(boundSession,'state',()=>publish('SESSION_STATE',boundSession.getSession()));
      on(boundSession,'overtime',()=>{publish('CHAT_REPLY',{replyTo:null,text:'Limit czasu minął. Możesz dalej pisać i samodzielnie zakończyć próbę.'});if(active)boundCoach?.trigger('OVERTIME');});
      on(boundWorkspace,'watcherError',(error:unknown)=>publish('ERROR',apiError(error)));
      on(boundSession,'control',(payload:unknown)=>publish('CONTROL_STATE',payload));
      on(boundSession,'veto',()=>boundCoach?.abort());
      return {execution:boundExecution,activate(){active=true;coach=boundCoach;execution=boundExecution;},dispose};
    } catch(error) {dispose();throw error;}
  }
  let binding:ReturnType<typeof prepareBinding>;
  try {binding=prepareBinding({workspace,session,gate});binding.activate();}
  catch(error) {wss.close();throw error;}
  function reportGenerator():((facts:FrozenFacts,signal:AbortSignal)=>Promise<string>)|undefined {
    const configured=options.reportGenerate;
    const apiKey=process.env.GEMINI_API_KEY;
    if(!configured && !apiKey) return undefined; // ReportService's explicit local-facts fallback.
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
  function authInput(clientId:string,sessionId:string,controlEpoch:number,actor:'STUDENT'|'COACH'='STUDENT') { return {clientId,sessionId,controlEpoch,actor}; }
  function assertVersion(value:number) { if(value!==workspace.workspaceVersion) fail(409,'WORKSPACE_VERSION_CONFLICT','Projekt zmienił się; zsynchronizuj stan.'); }
  function vetoKey(id:string) { return `${session.state.sessionId}:VETO:${id}`; }
  async function veto(id:string,clientId:string,sessionId:string,payload:any) {
    session.assertClient(clientId,sessionId);
    return ledger.run(vetoKey(id),{clientId,sessionId,...payload},()=>{
      // The cutoff is synchronous, before any provider abort await.
      const previousEpoch=session.state.controlEpoch;
      const result=session.veto();
      if(result.controlEpoch!==previousEpoch) facts.push({type:'VETO_EXECUTED',at:new Date().toISOString(),epoch:result.controlEpoch});
      coach?.abort(); return clone(result);
    });
  }
  async function finish(reason:Report['reason']) {
    if(transitioning) fail(409,'SESSION_TRANSITION','Poczekaj na utrwalenie bieżącej operacji; lokalny draft pozostaje niezapisany.');
    if (!execution) fail(503,'GATE003_NOT_ENABLED','Runner i raport oczekują odbioru bramki GATE-003.');
    if(session.state.lifecycle==='FINISHED') return execution.reports.get(session.state.sessionId);
    transitioning=true;
    try {
      coach?.abort(); session.releaseCoach();
      await execution.runner.stopAll();
      const finalSnapshot=await workspace.createSnapshot('Stan końcowy próby');
      const finalMaterial=workspace.readSnapshot(finalSnapshot.snapshotId);
      const finalSession=session.getSession();
      // Persist the prospective closed state first; a storage error must not announce FINISHED.
      finalSession.lifecycle='FINISHED';finalSession.controlEpoch++;finalSession.writeOwner='STUDENT';
      finalSession.interventionId=null;finalSession.coachMode='UNAVAILABLE';finalSession.timer.status='STOPPED';
      const frozen:FrozenFacts={session:finalSession,snapshot:clone(finalSnapshot),finalMaterial:clone(finalMaterial),
        settings:clone(workspace.settings),aiConsent:workspace.settings.aiConsent,
        runs:clone(execution.runner.list()),chat:clone(chat),events:clone(facts)};
      persistingFinish=true;
      try { report=execution.reports.finish(reason,frozen); } finally {persistingFinish=false;}
      session.finish();emit('SESSION_REPORT',report);return clone(report);
    } finally { transitioning=false; }
  }
  async function handleHttp(req:IncomingMessage,res:ServerResponse) {
    let requestId:string|null=null;
    try {
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
      if(req.method==='GET') {
        let value:unknown;
        if(url.pathname==='/api/project') value=workspace.getProject(session.state.sessionId);
        else if(url.pathname==='/api/session') value=session.getSession();
        else if(url.pathname==='/api/file') value=workspace.getDocument(url.searchParams.get('path')||'');
        else if(url.pathname==='/api/snapshots') value=workspace.listSnapshots();
        else if(url.pathname==='/api/session/report') {
          if(url.searchParams.get('sessionId')!==session.state.sessionId) fail(404,'SESSION_NOT_FOUND','Nie znaleziono sesji.');
          value=execution?.reports.get(session.state.sessionId) ?? report;
          if(!value) fail(404,'REPORT_NOT_FOUND','Brak raportu tej sesji.');
        } else if(/^\/api\/run\/[A-Za-z0-9._:-]+$/.test(url.pathname)) {
          if(!execution) fail(503,'GATE003_NOT_ENABLED','Runner nie jest jeszcze włączony.'); value=execution.runner.get(url.pathname.split('/')[3]);
        } else fail(404,'NOT_FOUND','Nieznany endpoint.');
        respond(res,200,value);return;
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
      if(!validateRequest(route[0],body)) fail(400,'VALIDATION_ERROR','Komenda niezgodna z kontraktem.');
      if(url.pathname==='/api/session/veto') {
        const op=await veto(body.requestId,body.clientId,body.sessionId,{controlEpoch:body.controlEpoch,activeInterventionId:body.activeInterventionId,lastAppliedSeq:body.lastAppliedSeq});
        respond(res,route[1],await op.result);return;
      }
      if(url.pathname!=='/api/project/open') session.assertClient(body.clientId,body.sessionId);
      const operation=ledger.run(`HTTP:${body.requestId}`,{route:key,body},async()=>{
        if(transitioning && !stopMatch) fail(409,'SESSION_TRANSITION','Trwa bezpieczna zmiana sesji; zachowaj draft.');
        if(url.pathname==='/api/project/open') {
          if(session.leaseClientId && session.leaseClientId!==body.clientId) fail(409,'LEASE_CONFLICT','Inna karta posiada dzierżawę.');
          const next=makeCore(body.rootPath);
          let prepared:ReturnType<typeof prepareBinding>|undefined;
          let project:ReturnType<WorkspaceService['getProject']>;
          try {
            next.workspace.updateSettings(body.settings);
            next.session.claimLease(body.clientId);
            prepared=prepareBinding(next);
            project=next.workspace.getProject(next.session.state.sessionId);
          } catch(error) {
            if(prepared)prepared.dispose();else {next.session.close();next.workspace.close();}
            throw error;
          }
          transitioning=true;
          let adopted=false;
          try {
            // Every fallible new-binding preparation completed before touching the current session.
            await execution?.runner.stopAll();
            const previous=binding;
            ({workspace,session,gate}=next);binding=prepared;adopted=true;
            chat=[];proposals=[];report=null;lastRun=null;facts.length=0;seq=0;
            // Old close/abort callbacks cannot publish against the new core or revoke its lease.
            try {previous.dispose();} catch { /* cleanup continued through core close; do not undo adoption */ }
            binding.activate();
            for(const [ws,p] of peers) {p.authenticated=false;ws.close(1012,'Project changed; reconnect');}
            return project;
          } finally {
            try {if(!adopted){await prepared.execution?.runner.stopAll();prepared.dispose();}}
            finally {transitioning=false;}
          }
        }
        if(url.pathname==='/api/project/settings') { assertVersion(body.expectedWorkspaceVersion);coach?.abort();session.releaseCoach();workspace.updateSettings(body.settings);snapshot();return workspace.getProject(session.state.sessionId); }
        if(url.pathname==='/api/file') { gate.mutate({...body,actor:'STUDENT'});snapshot();return workspace.getProject(session.state.sessionId); }
        if(url.pathname==='/api/session/start') { const state=session.start(body.limitMs,body.pauseOnHidden);coach?.trigger('START');return clone(state); }
        if(url.pathname==='/api/run') {
          assertVersion(body.expectedWorkspaceVersion);
          if(!execution) fail(503,'GATE003_NOT_ENABLED','Runner nie jest jeszcze włączony.');
          const profile=workspace.settings.runProfiles.find(p=>p.kind===body.mode);
          if(!profile) fail(409,'RUN_PROFILE_MISSING','Skonfiguruj zatwierdzony profil uruchomienia.');
          execution.runner.setApprovedProfiles(workspace.settings.runProfiles);lastRun=execution.runner.start(profile);return clone(lastRun);
        }
        if(stopMatch) { if(!execution) fail(503,'GATE003_NOT_ENABLED','Runner nie jest jeszcze włączony.');return execution.runner.stop(url.pathname.split('/')[3]); }
        if(url.pathname==='/api/session/finish') { assertVersion(body.expectedWorkspaceVersion); return finish(body.reason); }
        if(url.pathname==='/api/session/report/retry') { if(!execution) fail(503,'GATE003_NOT_ENABLED','Raport nie jest jeszcze włączony.'); report=execution.reports.retry(body.sessionId);return clone(report); }
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
    res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'no-cache','Referrer-Policy':'no-referrer'});
    if(method==='HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  }
  server.on('upgrade',(req,socket,head)=>{
    try { trust(req); if(req.url!=='/ws/session') fail(404,'NOT_FOUND','Nieznany WS.');
      if(peers.size>=16) fail(429,'CONNECTION_LIMIT','Zbyt wiele połączeń.');
      wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
    } catch(error) { socket.write(`HTTP/1.1 ${(error as any)?.status||403} Forbidden\r\nConnection: close\r\n\r\n`);socket.destroy(); }
  });
  wss.on('connection',(ws)=>{
    const peer={clientId:null as string|null,authenticated:false,alive:true,count:0,since:Date.now()};peers.set(ws,peer);
    const helloDeadline=setTimeout(()=>{if(!peer.authenticated) ws.close(1008,'HELLO required');},3000);
    ws.on('pong',()=>{peer.alive=true;});
    ws.on('message',(data)=>{void receive(ws,data.toString());});
    ws.on('error',()=>{ /* close handler revokes this connection; no token-bearing errors logged */ });
    ws.on('close',()=>{
      clearTimeout(helloDeadline);peers.delete(ws);
      if(peer.authenticated && peer.clientId && ![...peers.values()].some(p=>p.authenticated && p.clientId===peer.clientId)) {
        coach?.abort();session.releaseLease(peer.clientId);
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
      const parsed=JSON.parse(raw);
      if(!validateMessage(parsed)) fail(400,'VALIDATION_ERROR','Wiadomość niezgodna z protokołem.');message=parsed;
      if(message.type==='HELLO') {
        if(!sameToken(message.payload.token)) { ws.close(1008,'Unauthorized');return; }
        if(message.sessionId!==session.state.sessionId) fail(409,'SESSION_CONFLICT','Sesja uległa zmianie.');
        if(!session.claimLease(message.clientId)) {ws.close(1008,'Lease conflict');return;}
        // A reconnect invalidates any old in-flight coach intervention, never replays steps.
        coach?.abort();session.releaseCoach();peer.clientId=message.clientId;peer.authenticated=true;
        snapshot();return;
      }
      if(!peer.authenticated || message.clientId!==peer.clientId) {ws.close(1008,'HELLO required');return;}
      session.assertClient(message.clientId,message.sessionId);
      const p=message.payload;
      if(message.type==='VETO_ESCAPE') {
        const op=await veto(message.messageId,message.clientId,message.sessionId,p);await op.result;ack(message,op.duplicate?'DUPLICATE':'OK');return;
      }
      const command=message;
      const op=ledger.run(`WS:${message.messageId}`,message,async()=>{
        if(transitioning && !['PING','PROPOSAL_RESPONSE','WINDOW_STATE','TIMER_ACTION'].includes(command.type)) fail(409,'SESSION_TRANSITION','Trwa utrwalanie sesji; zachowaj lokalny draft.');
        switch(command.type) {
          case 'CODE_CHANGED': {
            const doc=gate.write({...authInput(command.clientId,command.sessionId,p.controlEpoch),path:p.path,baseVersion:p.baseVersion,content:p.content});
            coach?.trigger('EDIT');
            return doc.version;
          }
          case 'PING': return null;
          case 'VIEW_CHANGED': {
            if(p.path!==null) workspace.getDocument(p.path);
            session.state.activeFilePath=p.path;emit('SESSION_STATE',session.getSession());return null;
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
                proposals=proposals.filter(item=>item.proposalId!==p.proposalId);snapshot();
              }
            });
            await outcome.result;return {proposalDuplicate:outcome.duplicate};
          }
          default: return fail(400,'UNKNOWN_MESSAGE','Nieobsługiwany komunikat.');
        }
      });
      const version=await op.result;ack(message,op.duplicate || (version as {proposalDuplicate?:boolean}|null)?.proposalDuplicate?'DUPLICATE':'OK',typeof version==='number'?version:null);
    } catch(error) {
      if(message && peer.authenticated) ack(message,'REJECTED',null,error);
      else { if(ws.readyState===WebSocket.OPEN) ws.close(1008,'Invalid or unauthorized message'); }
    }
  }
  const heartbeat=setInterval(()=>{
    for(const [ws,p] of peers) {if(!p.alive) {ws.terminate();continue;}p.alive=false;ws.ping();}
  },5000);heartbeat.unref();
  return {
    server, get workspace(){return workspace;},get session(){return session;},get gate(){return gate;},
    async listen():Promise<number> { await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});return currentPort(); },
    async close():Promise<void> {
      closing=true;clearInterval(heartbeat);
      try {await execution?.runner.stopAll();} finally {
        try {binding.dispose();} finally {
          for(const ws of peers.keys())ws.terminate();wss.close();
          if(server.listening)await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
        }
      }
    },
  };
}
