import { createHash } from 'node:crypto';
import type { AcceptanceState, DiagnosticsResult, DocumentStamp } from '../../src/shared/language-v2';
import type { ExecutionView, ProjectV2, RunV2, SettingsV2, TaskField } from '../../src/shared/runtime-v2';
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const stamp = (): DocumentStamp => ({ projectId:'p1',sessionId:'s1',path:'src/Zażółć 😀.txt',profileId:'profile1',
  connectionGeneration:'conn1',configurationGeneration:'cfg1',providerGeneration:'provider1',shadowGeneration:'shadow1',modelLifetime:'life1',
  localModelVersion:1,baseDocumentVersion:1,documentVersion:null,contentSha256:hash('hello'),controlEpoch:0,requestGeneration:1 });
export const authority = (): AcceptanceState => ({ stamp:stamp(),content:'hello',connected:true,synced:true,writeOwner:'STUDENT',controlPrepare:false,vetoPending:false,conflict:false,readOnly:false });
export const diagnostics = (): DiagnosticsResult => ({ sourceStamp:stamp(),presentationStamp:stamp(),association:null,
  provenance:{kind:'IMMUTABLE_GENERATION',launchId:'launch1',lspVersion:null,inputManifestSha256:hash('input')},items:[],truncated:false });
const field = (key: TaskField['key'], label: string, input: TaskField['input'] = 'TEXT'): TaskField => ({ key,label,input,help:`Podaj ${label.toLowerCase()}.`,required:false,choices:[],min:null,max:null });
export const fields = (): TaskField[] => [
  field('workingDirectory','Katalog','PATH'), { ...field('entry.kind','Wejście','CHOICE'),required:true,choices:[{value:'SCRIPT',label:'Skrypt'},{value:'TESTS',label:'Tylko testy'}] },
  field('entry.path','Plik','PATH'), field('tests.paths','Ścieżki testów','PATH'), field('tests.names','Nazwy testów'),
  {...field('timeoutMs','Limit czasu','INTEGER'),required:true,min:1000,max:300000},
];
export const settings = (): SettingsV2 => ({ schemaVersion:2,runProfiles:[{kind:'RUN_TESTS',timeoutMs:1000,task:{workingDirectory:'.',entry:{kind:'TESTS'},tests:{paths:['tests/spec.txt'],names:[]}}}],taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'REVIEW.md',aiConsent:false,contextPatterns:['src/**'] });
export const execution = (): ExecutionView => ({ runtime:{profileId:'profile1',label:'Profil zadania',configurationGeneration:'cfg1',state:'READY',problem:null,taskFields:fields()},
  modes:{RUN_MAIN:{canRun:false,problem:{code:'TASK_CONFIG_INVALID',message:'Program wyłączony.',recovery:'Włącz program w ustawieniach.',retryable:false}},RUN_TESTS:{canRun:true,problem:null}} });
export const project = (): ProjectV2 => ({ projectId:'p1',sessionId:'s1',rootPath:'/workspace',workspaceVersion:1,settings:settings(),files:[],
  capabilities:{execution:execution(),language:{projectId:'p1',profileId:'profile1',configurationGeneration:'cfg1',providerGeneration:'provider1',state:'ON',autocomplete:'ON',docs:'N/A',problem:null}} });
export const run = (): RunV2 => ({runId:'run1',mode:'RUN_TESTS',status:'RUNNING',exitCode:null,workspaceVersionAtStart:1,workspaceChangedDuringRun:false,testOutcome:'UNKNOWN',testCount:null,
  outputTail:'',outputTruncated:false,startedAt:'2026-11-11T21:00:00.000Z',finishedAt:null,profileId:'profile1',configurationGeneration:'cfg1',processProblem:null,serviceReadiness:null});
