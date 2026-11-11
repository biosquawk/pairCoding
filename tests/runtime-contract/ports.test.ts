import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { DurableTerminalReceipt, ExecutionPlan, ExecutionPort, TaskRuntimeAdapter } from '../../src/server/execution/ports';
import type { LanguageFeaturesPort, VerifiedLanguageAck } from '../../src/server/language/ports';
import type { CompletionAcceptanceFacade, DocumentStamp } from '../../src/shared/language-v2';
import { ProtocolV2Schema } from '../../src/shared/protocol-v2.schema';
import legacy from '../../src/shared/ws.schema.json';
import { validateV2Request, validateV2WireShape } from '../../src/shared/validation-v2';
import { settings, testsOnly } from './fixtures';
// Compile-only contract checks; not mocked integration tests or claimed execution evidence.
function compileContract(execution:ExecutionPort,language:LanguageFeaturesPort,adapter:TaskRuntimeAdapter,
  plan:ExecutionPlan,receipt:DurableTerminalReceipt,proof:VerifiedLanguageAck,stamp:DocumentStamp,facade:CompletionAcceptanceFacade) {
  const result:Promise<import('../../src/server/execution/ports').ExecutionHandle>=execution.start(plan);
  const cleanup:Promise<void>=execution.cleanup(receipt);
  language.acknowledge(proof);
  const sync:void=facade.invalidate('CONTROL_PREPARE');
  const accepted:import('../../src/shared/language-v2').AcceptanceResult=facade.accept({requestId:'r',stamp,item:null!});
  // @ts-expect-error An arbitrary public object is not a trusted ACK proof.
  language.acknowledge({saveReceiptId:'forged',previous:stamp,presentation:stamp});
  // @ts-expect-error Handle alone is not durable exit+collection receipt.
  execution.cleanup({runId:'r',opaqueId:'id'});
  return {result,cleanup,sync,accepted,adapter};
}
void compileContract;
test('additive future schema is detached from current legacy schema and rejects host fields at cutover',()=>{
  assert.notEqual(ProtocolV2Schema.$id,legacy.$id);
  assert.ok(Object.hasOwn(legacy.$defs.RunProfile.properties,'executable'));
  assert.ok(!Object.hasOwn(ProtocolV2Schema.$defs.Settings.properties,'executable'));
  const request={requestId:'r',clientId:'c',sessionId:'s',expectedWorkspaceVersion:0,settings:settings()};
  assert.equal(validateV2Request('UpdateSettingsRequest',request),true);
  assert.equal(validateV2Request('UpdateSettingsRequest',{...request,settings:{...settings(),runProfiles:[{...testsOnly(),executable:'node'}]}}),false);
});
test('new ports use only shared types: no implementation imports, CLI spawn or GUI dependency',()=>{
  for(const file of ['execution/ports.ts','language/ports.ts']) {
    const source=fs.readFileSync(new URL(`../../src/server/${file}`,import.meta.url),'utf8');
    const imports=source.split('\n').filter(line=>line.startsWith('import '));
    assert.ok(imports.every(line=>line.startsWith('import type ') && line.includes('../../shared/')),file);
    assert.doesNotMatch(source,/from ['"](?:node:child_process|.*(?:Runner|WriteGate|SessionController|components))/);
  }
});
test('ProjectV2 uses identical future Settings/Run/capabilities in complete schema, no duplicated host branch',()=>{
  const project={projectId:'p',sessionId:'s',rootPath:'/workspace',workspaceVersion:0,settings:{...settings(),runProfiles:[]},files:[],capabilities:{
    execution:{runtime:{profileId:'python-3.13',label:'Python',configurationGeneration:'cfg',state:'READY',problem:null,taskFields:[]},modes:{RUN_MAIN:{canRun:false,problem:{code:'DISABLED',message:'Disabled',recovery:'Save V2 profile',retryable:false}},RUN_TESTS:{canRun:true,problem:null}}},
    language:{projectId:'p',profileId:'python-3.13',configurationGeneration:'cfg',providerGeneration:'gen',state:'ON',autocomplete:'ON',docs:'N/A',problem:null},
  }};
  assert.equal(validateV2WireShape('Project',project),true);
  assert.equal(validateV2WireShape('Project',{...project,settings:{...project.settings,schemaVersion:1}}),false);
});
