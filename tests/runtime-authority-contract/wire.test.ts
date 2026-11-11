/** UNIT central wire shape/semantics only: never authenticates, commits a save or starts a runner. */
import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import legacy from '../../src/shared/ws.schema.json';
import { validateMutationOutcomeV2, validateReconcileMutationRequestV2, validateV2WireShape } from '../../src/shared/validation-v2';
import type { MutationIdentity, MutationOutcomeV2 } from '../../src/shared/runtime-mutation-v2';
import type { SessionBundleV2 } from '../../src/shared/runtime-v2';
import { project, run, settings } from '../client-v2/fixtures';
const request = (): MutationIdentity => ({ projectId: 'p1', kind: 'RUN', request: { requestId: 'request1', clientId: 'client1', sessionId: 's1', expectedWorkspaceVersion: 1, configurationGeneration: 'cfg1', mode: 'RUN_TESTS' } });
const outcome = (): MutationOutcomeV2 => ({ mutation: request(), state: 'COMMITTED', result: run(), current: { project: project(), run: run() } } as MutationOutcomeV2);
const bundle = (): SessionBundleV2 => ({ project: project(), session: { sessionId:'s1',projectId:'p1',lifecycle:'READY',workspaceVersion:1,controlEpoch:0,writeOwner:'STUDENT',coachMode:'UNAVAILABLE',cooldownAfterVeto:false,presence:'FOCUSED',aiStatus:'OFF',timer:{status:'STOPPED',elapsedMs:0,limitMs:null,pauseOnHidden:true,manualPaused:false,serverTime:'2026-11-11T00:00:00Z'},activeFilePath:null,interventionId:null,lastServerSeq:0 }, activeDocument:null,proposals:[],lastRun:null,report:null,chat:[],languageBootstrap:null });

test('required closed bootstrap accepts null or exact three neutral fields; never defaulted', () => {
  const good = bundle(); assert.equal(validateV2WireShape('SessionBundle', good), true);
  const missing = { ...good }; delete (missing as any).languageBootstrap;
  assert.equal(validateV2WireShape('SessionBundle', missing), false);
  for (const provider of ['builtin','remote','off']) assert.equal(validateV2WireShape('SessionBundle', { ...good, languageBootstrap: { connectionGeneration:'conn1',shadowGeneration:'shadow1',provider } }), true);
  for (const languageBootstrap of [{}, { connectionGeneration:'conn1',shadowGeneration:'shadow1',provider:'jdt' },
    { connectionGeneration:'',shadowGeneration:'shadow1',provider:'remote' }, { connectionGeneration:'conn1',provider:'remote' },
    { connectionGeneration:'conn1',shadowGeneration:'shadow1',provider:'remote',ready:true }])
    assert.equal(validateV2WireShape('SessionBundle', { ...good, languageBootstrap }), false);
  assert.equal(good.languageBootstrap, null);
});

test('V2 optional exact language source ID only; all legacy required fields/constraints preserved', () => {
  const message = { protocolVersion:'3.0',messageId:'save1',sessionId:'s1',clientId:'client1',type:'CODE_CHANGED',payload:{path:'src/main.py',baseVersion:1,controlEpoch:0,content:'code\n',editKind:'TYPING'} };
  assert.equal(validateV2WireShape('ClientMessage',message), true);
  const extended = { ...message, payload: { ...message.payload, languageDocumentMessageId:'change1' } };
  assert.equal(validateV2WireShape('ClientMessage',extended), true);
  for (const languageDocumentMessageId of [null,'',1,'a'.repeat(129)]) assert.equal(validateV2WireShape('ClientMessage',{ ...extended,payload:{...extended.payload,languageDocumentMessageId} }), false);
  for (const field of Object.keys(message.payload)) {
    const broken: any = structuredClone(extended); delete broken.payload[field]; assert.equal(validateV2WireShape('ClientMessage',broken), false,field);
  }
  assert.equal(validateV2WireShape('ClientMessage',{...extended,payload:{...extended.payload,saveReceiptId:'forged'}}),false);
  const ajv = new Ajv2020({strict:false}); addFormats(ajv); ajv.addSchema(legacy,'legacy');
  const old = ajv.compile({ $ref:'legacy#/$defs/ClientMessage' });
  assert.equal(old(message),true); assert.equal(old(extended),false);
});

test('full original request retained; closed discriminators reject guessed metadata/digest/mixed payload', () => {
  const mutation = request(); assert.equal(validateReconcileMutationRequestV2({mutation}), true);
  const save = { projectId:'p1',kind:'SAVE',request:{requestId:'save1',clientId:'client1',sessionId:'s1',expectedWorkspaceVersion:1,settings:settings()} };
  assert.equal(validateReconcileMutationRequestV2({mutation:save}), true);
  for (const value of [{ mutation:{...mutation,kind:'SAVE'} }, { mutation:{...save,kind:'RUN'} }, { mutation:{...mutation,request:{requestId:'request1'}} },
    { mutation:{...mutation,fingerprint:'a'.repeat(64)} }, {mutation,requestId:'extra'}, {mutation:null}])
    assert.equal(validateReconcileMutationRequestV2(value), false);
  const before = structuredClone(mutation); validateReconcileMutationRequestV2({mutation}); assert.deepEqual(mutation,before);
});

test('UNKNOWN carries no current; definitive requires actual current, result discriminated by mutation', () => {
  const value = outcome(); assert.equal(validateMutationOutcomeV2(value), true);
  assert.equal(validateMutationOutcomeV2({mutation:request(),state:'UNKNOWN',result:null,current:null}),true);
  assert.equal(validateMutationOutcomeV2({mutation:request(),state:'DEFINITIVELY_ABORTED',result:null,current:value.current}),true);
  for (const bad of [{...value,state:'UNKNOWN'}, {...value,state:'UNKNOWN',result:null}, {...value,state:'COMMITTED',current:null},
    {...value,state:'DEFINITIVELY_ABORTED'}, {...value,result:project()}, {...value,extra:true}, {...value,current:undefined}])
    assert.equal(validateMutationOutcomeV2(bad), false);
  const mutation = { projectId:'p1',kind:'SAVE',request:{requestId:'save1',clientId:'client1',sessionId:'s1',expectedWorkspaceVersion:0,settings:settings()} };
  assert.equal(validateMutationOutcomeV2({mutation,state:'COMMITTED',result:project(),current:value.current}),true);
  assert.equal(validateMutationOutcomeV2({mutation,state:'COMMITTED',result:run(),current:value.current}),false);
  assert.equal(validateMutationOutcomeV2({mutation,state:'COMMITTED',result:{...project(),settings:{...settings(),aiConsent:true}},current:value.current}),false);
});

test('cross-project/current/run mismatch rejected; old-session identity can reconcile in same project', () => {
  const value: any = outcome();
  for (const change of [
    (v:any) => {v.current.project.projectId='foreign';}, (v:any) => {v.current.run.configurationGeneration='foreign';},
    (v:any) => {v.result.configurationGeneration='foreign';}, (v:any) => {v.result.mode='RUN_MAIN';},
    (v:any) => {v.result.workspaceVersionAtStart=0;}, (v:any) => {v.current.project.capabilities.language.projectId='foreign';},
  ]) { const bad = structuredClone(value); change(bad); assert.equal(validateMutationOutcomeV2(bad),false); }
  const next = structuredClone(value); next.current.project.sessionId='new-session'; assert.equal(validateMutationOutcomeV2(next),true);
});

test('prototype/accessor/cycles/nonfinite JSON cannot enter reconciliation; bounded IDs', () => {
  const v:any = {mutation:request()}; v.mutation.request.expectedWorkspaceVersion=Infinity; assert.equal(validateReconcileMutationRequestV2(v),false);
  const inherited=Object.assign(Object.create({evil:true}),{mutation:request()}); assert.equal(validateReconcileMutationRequestV2(inherited),false);
  const accessor={};Object.defineProperty(accessor,'mutation',{enumerable:true,get(){assert.fail('getter must not run');}}); assert.equal(validateReconcileMutationRequestV2(accessor),false);
  const cycle:any={};cycle.mutation=cycle; assert.equal(validateReconcileMutationRequestV2(cycle),false);
  const long:any={mutation:request()};long.mutation.projectId='a'.repeat(129);assert.equal(validateReconcileMutationRequestV2(long),false);
});
