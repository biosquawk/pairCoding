import type { SettingsV2, RunProfileV2, RuntimeProfile } from '../../src/shared/runtime-v2';
import type { DocumentStamp, CompletionItem, DiagnosticsResult } from '../../src/shared/language-v2';
export const hash = 'a'.repeat(64);
export const testsOnly = ():RunProfileV2=>({ kind:'RUN_TESTS', timeoutMs:1000,
  task:{ workingDirectory:'.',entry:{kind:'TESTS'},tests:{paths:['tests/unit.py'],names:[]} } });
export const settings = ():SettingsV2=>({ schemaVersion:2,runProfiles:[testsOnly()],taskFilePath:null,
  taskMode:'IMPLEMENTATION',reviewNotesPath:'REVIEW.md',aiConsent:false,contextPatterns:[] });
export const profile = (family:RuntimeProfile['adapterFamily']='python'):RuntimeProfile=>({
  id:'python-3.13',label:'Python',adapterFamily:family,imageLockKey:'python',expectedTools:[{name:'python',version:'3.13.9'}],
  compilerRelease:family==='java-maven'?21:null,analysis:{languageLevel:family==='java-maven'?'21':'3.13',preview:false},
  language:family==='java-maven'?{provider:'jdt',imageLockKey:'jdt',serverJvm:'27.0.1'}:{provider:'pylsp',imageLockKey:'pylsp',serverJvm:null},taskFields:[],
});
export const stamp = ():DocumentStamp=>({ projectId:'p1',sessionId:'s1',path:'src/Zażółć 😀.py',profileId:'python-3.13',
  connectionGeneration:'c1',configurationGeneration:'cfg1',providerGeneration:'provider1',shadowGeneration:'shadow1',modelLifetime:'life1',
  localModelVersion:1,baseDocumentVersion:1,documentVersion:null,contentSha256:hash,controlEpoch:0,requestGeneration:1 });
export const item = ():CompletionItem=>({id:'i1',label:'method',detail:null,
  primary:{path:stamp().path,range:{startLine:1,startColumn:1,endLine:1,endColumn:1},text:'hello'},additionalTextEdits:[]});
export const diagnostics = ():DiagnosticsResult=>({sourceStamp:stamp(),presentationStamp:stamp(),association:null,
  provenance:{kind:'IMMUTABLE_GENERATION',launchId:'launch1',lspVersion:null,inputManifestSha256:hash},items:[],truncated:false});
