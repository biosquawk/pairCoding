/** Strict bounded structural validation, non-mutating. This NEVER grants authentication/freshness/ACK authority. */
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import * as R from './runtime-v2.schema';
import * as L from './language-v2.schema';
import type { MutationIdentity, MutationOutcomeV2, ReconcileMutationRequestV2 } from './runtime-mutation-v2';
import type { ProjectV2 } from './runtime-v2';
import { ProtocolV2Schema } from './protocol-v2.schema';
import type { ExecutionView, ImageLock, RunProfileV2, RunRequestV2, RuntimeCatalog, RuntimeConfigV1, RuntimeProfile, RunV2, SettingsV2, TaskField, TaskRunConfig, UpdateSettingsRequestV2 } from './runtime-v2';
import type { AnalysisSource, CancelRequest, CompleteRequest, CompleteResult, CompletionItem, DiagnosticsResult, DocumentStamp, LanguageClientMessage, LanguageFileOperation, LanguageServerMessage, LanguageView, OpenOrChange } from './language-v2';
import { LANGUAGE_LIMITS as B } from './language-v2';
const ajv = new Ajv2020({ strict: true, allErrors: false, coerceTypes: false, removeAdditional: false, useDefaults: false, ownProperties: true });
addFormats(ajv);
/** Reject prototypes, accessors, symbols, sparse arrays, cycles and oversized pre-parsed input before AJV. */
function plainJSON(value: unknown, budget = 50000, depth = 32): boolean {
  const seen = new Set<object>();
  const visit = (v: unknown, d: number): boolean => {
    if (--budget < 0 || d < 0) return false;
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v !== 'object' || seen.has(v)) return false;
    const a = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (a ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return false;
    seen.add(v);
    if (Object.getOwnPropertySymbols(v).length) return false;
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (a && Object.keys(descriptors).length !== (v as unknown[]).length + 1) return false;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (a && key === 'length') continue;
      if (a && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= (v as unknown[]).length)) return false;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor,'value') || ['__proto__','constructor','prototype'].includes(key)) return false;
      if (!visit(descriptor.value,d-1)) return false;
    }
    seen.delete(v);
    return true;
  };
  try { return visit(value,depth); } catch { return false; }
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
function guard<T>(schema: object, semantic: (v: T) => boolean = () => true, maxBytes = 4*1024*1024): (value: unknown) => value is T {
  const validate = ajv.compile(schema);
  return (value: unknown): value is T => {
    try { return plainJSON(value) && bytes(value) <= maxBytes && Boolean(validate(value)) && semantic(value as T); }
    catch { return false; }
  };
}
const unique = (values: readonly unknown[]) => new Set(values).size === values.length;
const fieldsValid = (fields: TaskField[]) => unique(fields.map(f=>f.key)) && fields.every(f => {
  if (!unique(f.choices.map(c=>c.value))) return false;
  if (f.input === 'CHOICE') return f.choices.length > 0 && f.min === null && f.max === null &&
    (f.key !== 'entry.kind' || f.choices.every(c=>['SCRIPT','MODULE','JAVA_MAIN','SPRING_BOOT','TESTS'].includes(c.value)));
  if (f.choices.length) return false;
  if (f.input === 'INTEGER') return ['entry.containerPort','timeoutMs'].includes(f.key) && f.min !== null && f.max !== null &&
    f.min <= f.max && (f.key === 'timeoutMs' ? f.min >= 1000 && f.max <= 300000 : f.min >= 1 && f.max <= 65535);
  if (f.min !== null || f.max !== null) return false;
  if (f.key === 'entry.kind' || f.key === 'entry.containerPort' || f.key === 'timeoutMs') return false;
  return f.input === (['workingDirectory','entry.path','tests.paths'].includes(f.key) ? 'PATH' : 'TEXT');
});
const profileValid = (p: RunProfileV2) => p.task.entry.kind !== 'TESTS' || p.kind === 'RUN_TESTS';
export const validateTaskRunConfig = guard<TaskRunConfig>(R.TaskRunConfigSchema);
export const validateRunProfileV2 = guard<RunProfileV2>(R.RunProfileV2Schema,profileValid);
export const validateSettingsV2 = guard<SettingsV2>(R.SettingsV2Schema,s=>unique(s.runProfiles.map(p=>p.kind)) && s.runProfiles.every(profileValid));
export const validateRuntimeConfigV1 = guard<RuntimeConfigV1>(R.RuntimeConfigV1Schema);
export const validateTaskField = guard<TaskField>(R.TaskFieldSchema,f=>fieldsValid([f]));
const runtimeProfileValid = (p: RuntimeProfile) => fieldsValid(p.taskFields) && unique(p.expectedTools.map(t=>t.name)) &&
  (p.adapterFamily === 'java-maven' ? p.compilerRelease !== null && p.analysis.languageLevel === String(p.compilerRelease) && ['builtin','jdt'].includes(p.language.provider) : p.compilerRelease === null && p.language.provider !== 'jdt') &&
  (p.language.provider === 'jdt' ? p.language.imageLockKey !== null && p.language.serverJvm !== null : p.language.serverJvm === null) &&
  (['jdt','pylsp'].includes(p.language.provider) ? p.language.imageLockKey !== null : p.language.imageLockKey === null) &&
  (p.language.provider !== 'pylsp' || p.adapterFamily === 'python') &&
  (p.adapterFamily !== 'python' || ['builtin','pylsp'].includes(p.language.provider));
export const validateRuntimeProfile = guard<RuntimeProfile>(R.RuntimeProfileSchema,runtimeProfileValid);
export const validateRuntimeCatalog = guard<RuntimeCatalog>(R.RuntimeCatalogSchema,c=>unique(c.profiles.map(p=>p.id)) && c.profiles.every(runtimeProfileValid));
export const validateImageLock = guard<ImageLock>(R.ImageLockSchema,l=>unique(l.images.map(i=>i.key)) && l.images.every(i=>unique(i.tools.map(t=>t.name))));
/** Additional trusted-backend cross-file validation. Does not inspect/pull images or establish daemon readiness. */
export function validateCatalogImageReferences(catalog: unknown, lock: unknown, selectedProfileId?: string): boolean {
  return validateRuntimeCatalog(catalog) && validateImageLock(lock) &&
    (selectedProfileId === undefined || catalog.profiles.some(p=>p.id===selectedProfileId)) && catalog.profiles.every(p=>{
    const image = lock.images.find(i=>i.key === p.imageLockKey);
    // Whole catalog remains structurally/semantically checked. Absent inactive assets
    // are not readiness; every supplied pin still has to match its declared tools.
    if (!image && selectedProfileId !== undefined && p.id !== selectedProfileId) return true;
    return image && p.expectedTools.every(t=>image.tools.some(actual=>actual.name === t.name && actual.version === t.version)) &&
      (p.language.imageLockKey === null || lock.images.some(i=>i.key === p.language.imageLockKey));
  });
}
/** Adapter must ALSO verify selectors/tooling/effective pom against actual sealed project before plan construction. */
export function validateTaskForProfile(profile: unknown, run: unknown): boolean {
  if (!validateRuntimeProfile(profile) || !validateRunProfileV2(run)) return false;
  const kind = run.task.entry.kind, family = profile.adapterFamily;
  if (family === 'java-maven' && run.task.tests.paths.length !== 0) return false;
  if (run.kind === 'RUN_TESTS' && family !== 'java-maven' && run.task.tests.paths.length === 0) return false;
  if (kind === 'SPRING_BOOT') return family === 'java-maven' && [21,27].includes(profile.compilerRelease!);
  if (kind === 'JAVA_MAIN') return family === 'java-maven';
  if (kind === 'MODULE' && family !== 'python') return false;
  if (kind === 'SCRIPT' && family === 'java-maven') return false;
  return !(kind === 'TESTS' && family !== 'java-maven' && run.task.tests.paths.length === 0);
}
export const validateRunRequestV2 = guard<RunRequestV2>(R.RunRequestV2Schema);
export const validateUpdateSettingsRequestV2 = guard<UpdateSettingsRequestV2>(R.UpdateSettingsRequestV2Schema,v=>validateSettingsV2(v.settings));
export const validateExecutionView = guard<ExecutionView>(R.ExecutionViewSchema,v=>fieldsValid(v.runtime.taskFields) &&
  (v.runtime.state === 'READY' ? v.runtime.problem === null && v.runtime.profileId !== null : v.runtime.problem !== null) &&
  Object.values(v.modes).every(m=>m.canRun ? m.problem === null && v.runtime.state === 'READY' : m.problem !== null));
const serviceUrlValid = (url:string) => {
  try { const u=new URL(url); return u.protocol === 'http:' && u.hostname === '127.0.0.1' && Number(u.port)>=1 && Number(u.port)<=65535 && !u.username && !u.password; }
  catch { return false; }
};
export const validateRunV2 = guard<RunV2>(R.RunV2Schema,v=>v.outputTail.length <= 65536 &&
  (v.status !== 'PROCESS_STOP_UNCONFIRMED' || v.processProblem?.code === 'PROCESS_STOP_UNCONFIRMED') &&
  (v.processProblem?.code !== 'PROCESS_STOP_UNCONFIRMED' || v.status === 'PROCESS_STOP_UNCONFIRMED') &&
  (v.testOutcome !== 'PASSED' || v.mode === 'RUN_TESTS' && v.status === 'SUCCEEDED' && v.exitCode === 0 && v.testCount !== null && v.testCount > 0) &&
  (!['STOPPING','PROCESS_STOP_UNCONFIRMED'].includes(v.status) || v.finishedAt === null) &&
  (v.serviceReadiness === null || (v.serviceReadiness.ready ? v.serviceReadiness.url !== null && serviceUrlValid(v.serviceReadiness.url) && v.status === 'RUNNING' : v.serviceReadiness.url === null)));
const stampValid = (s: DocumentStamp) => s.documentVersion === null || s.documentVersion === s.baseDocumentVersion;
export const validateDocumentStamp = guard<DocumentStamp>(L.DocumentStampSchema,stampValid);
const rangeValid = (r: CompletionItem['primary']['range']) => r.startLine < r.endLine || r.startLine === r.endLine && r.startColumn <= r.endColumn;
const comparePosition = (al:number,ac:number,bl:number,bc:number) => al-bl || ac-bc;
const disjoint = (item:CompletionItem) => {
  const ranges=[item.primary,...item.additionalTextEdits].map(e=>e.range)
    .sort((a,b)=>comparePosition(a.startLine,a.startColumn,b.startLine,b.startColumn) || comparePosition(a.endLine,a.endColumn,b.endLine,b.endColumn));
  return ranges.every((r,i)=>{
    if(i===0) return true;
    const prev=ranges[i-1],cmp=comparePosition(prev.endLine,prev.endColumn,r.startLine,r.startColumn);
    return cmp<0 || cmp===0 && (prev.startLine!==prev.endLine || prev.startColumn!==prev.endColumn) && (r.startLine!==r.endLine || r.startColumn!==r.endColumn);
  });
};
const editsValid = (item: CompletionItem, stamp?: DocumentStamp) => {
  const edits = [item.primary,...item.additionalTextEdits];
  return disjoint(item) && edits.every(e=>rangeValid(e.range) && e.text.length <= B.editUtf16 && (!stamp || e.path === stamp.path)) &&
    edits.reduce((n,e)=>n+new TextEncoder().encode(e.text).length,0) <= B.totalEditBytes;
};
export const validateCompletionItem = guard<CompletionItem>(L.CompletionItemSchema,item=>editsValid(item),B.responseBytes);
export const validateOpenOrChange = guard<OpenOrChange>(L.OpenOrChangeSchema,v=>stampValid(v.stamp) && v.content.length <= B.contentUtf16);
export const validateCompleteRequest = guard<CompleteRequest>(L.CompleteRequestSchema,v=>stampValid(v.stamp));
export const validateCancelRequest = guard<CancelRequest>(L.CancelRequestSchema,v=>stampValid(v.stamp));
export const validateCompleteResult = guard<CompleteResult>(L.CompleteResultSchema,v=>stampValid(v.stamp) && unique(v.items.map(i=>i.id)) && v.items.every(i=>editsValid(i,v.stamp)),B.responseBytes);
const same = (a: unknown,b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ak=Object.keys(a),bk=Object.keys(b);
  return ak.length === bk.length && ak.every(k=>Object.hasOwn(b,k) && same((a as Record<string,unknown>)[k],(b as Record<string,unknown>)[k]));
};
const diagnosticAssociationValid = (v: DiagnosticsResult) => {
  const a=v.sourceStamp,b=v.presentationStamp;
  if (!stampValid(a) || !stampValid(b) || !v.items.every(i=>rangeValid(i.range))) return false;
  if (same(a,b)) return v.association === null;
  const mutable = ['baseDocumentVersion','documentVersion','requestGeneration'];
  return v.association !== null && Object.keys(a).every(k=>mutable.includes(k) || a[k as keyof DocumentStamp] === b[k as keyof DocumentStamp]) &&
    b.baseDocumentVersion > a.baseDocumentVersion && b.documentVersion === b.baseDocumentVersion && b.requestGeneration >= a.requestGeneration;
};
export const validateDiagnosticsResult = guard<DiagnosticsResult>(L.DiagnosticsResultSchema,diagnosticAssociationValid,B.responseBytes);
/** Caller supplies authoritative saved ledger source (not another client field). Does not verify ACK link. */
export function matchesAnalysisSource(result: unknown, captured: Readonly<AnalysisSource>): result is DiagnosticsResult {
  return validateDiagnosticsResult(result) && same(result.sourceStamp,captured.sourceStamp) && same(result.provenance,captured.provenance);
}
export const validateLanguageFileOperation = guard<LanguageFileOperation>(L.LanguageFileOperationSchema,v=>
  v.kind === 'CREATE' ? v.content.length <= B.contentUtf16 : v.kind !== 'RENAME' || v.path !== v.newPath);
export const validateLanguageView = guard<LanguageView>(L.LanguageViewSchema,v=>v.state === 'FAILED' ? v.problem !== null : true);
export const validateLanguageClientMessage = guard<LanguageClientMessage>(L.LanguageClientMessageSchema,v=>{
  if (v.sessionId !== v.payload.stamp.sessionId) return false;
  switch(v.type) {
    case 'LANGUAGE_OPEN': return v.payload.reason === 'OPEN' && validateOpenOrChange(v.payload);
    case 'LANGUAGE_CHANGE': return v.payload.reason !== 'OPEN' && validateOpenOrChange(v.payload);
    case 'LANGUAGE_COMPLETE': return validateCompleteRequest(v.payload);
    case 'LANGUAGE_CANCEL': return validateCancelRequest(v.payload);
    case 'LANGUAGE_CLOSE': return validateDocumentStamp(v.payload.stamp);
  }
});
export const validateLanguageServerMessage = guard<LanguageServerMessage>(L.LanguageServerMessageSchema,v=>{
  switch(v.type) {
    case 'COMPLETE_RESULT': return v.sessionId === v.payload.stamp.sessionId && validateCompleteResult(v.payload);
    case 'DIAGNOSTICS': return v.sessionId === v.payload.sourceStamp.sessionId && validateDiagnosticsResult(v.payload);
    case 'LANGUAGE_STATUS': return validateLanguageView(v.payload);
  }
},B.responseBytes);
/** Actual bytes/UTF16 checks for a single atomic same-document edit set. Authority/hash/stamp equality is caller-owned. */
export function validateCompletionEdits(item: unknown, stamp: unknown, content: string): item is CompletionItem {
  if (!validateCompletionItem(item) || !validateDocumentStamp(stamp) || !editsValid(item,stamp) || content.length > B.contentUtf16) return false;
  const lines=content.split('\n');
  const offset=(line:number,column:number):number|null=>{
    const text=lines[line-1],i=column-1;
    if(text === undefined || i > text.length) return null;
    // UTF16 code-unit boundaries may not split a surrogate pair. No clamping.
    if(i>0 && i<text.length && /[\uD800-\uDBFF]/.test(text[i-1]) && /[\uDC00-\uDFFF]/.test(text[i])) return null;
    let n=i; for(let l=0;l<line-1;l++) n+=lines[l].length+1;
    return n;
  };
  const ranges = [item.primary,...item.additionalTextEdits].map(e=>({ start:offset(e.range.startLine,e.range.startColumn),end:offset(e.range.endLine,e.range.endColumn) }));
  if(ranges.some(r=>r.start === null || r.end === null)) return false;
  ranges.sort((a,b)=>a.start!-b.start! || a.end!-b.end!);
  // Adjacent nonempty edits allowed. Ambiguous insertions on another edit boundary are rejected atomically.
  return ranges.every((r,i)=>i===0 || (ranges[i-1].end! < r.start! || ranges[i-1].end === r.start && ranges[i-1].start! < ranges[i-1].end! && r.start! < r.end!));
}
const protocol = new Ajv2020({ strict: false, coerceTypes: false, removeAdditional: false, ownProperties: true });
addFormats(protocol); protocol.addSchema(ProtocolV2Schema,'v2');
const requests = new Map<string,ValidateFunction>();
export type V2RequestName = 'RunRequest' | 'UpdateSettingsRequest' | 'ReconcileMutationRequest';
export function validateV2Request(name: V2RequestName, value: unknown): boolean {
  if (name === 'RunRequest') return validateRunRequestV2(value);
  if (name === 'UpdateSettingsRequest') return validateUpdateSettingsRequestV2(value);
  if (name === 'ReconcileMutationRequest') return validateReconcileMutationRequestV2(value);
  return false;
}
/** Full future transport shape; per-message semantics still use the guards above plus existing state machine. */
export function validateV2WireShape(kind: 'ClientMessage' | 'ServerMessage' | 'Project' | 'SessionBundle' | 'ReconcileMutationRequest' | 'MutationOutcome', value: unknown): boolean {
  let validate=requests.get(kind);
  if(!validate) { validate=protocol.compile({ $ref:`v2#/$defs/${kind}` }); requests.set(kind,validate); }
  try { return plainJSON(value) && bytes(value) <= 8*1024*1024 && Boolean(validate(value)); } catch { return false; }
}

const mutationValid = (mutation: MutationIdentity): boolean => mutation.kind === 'RUN' ? validateRunRequestV2(mutation.request) : validateUpdateSettingsRequestV2(mutation.request);
/** Auth/lease and full original-request echo equality remain the authenticated caller's responsibility. */
export function validateReconcileMutationRequestV2(value: unknown): value is ReconcileMutationRequestV2 {
  return validateV2WireShape('ReconcileMutationRequest',value) && mutationValid((value as ReconcileMutationRequestV2).mutation);
}
const mutationProjectValid = (project: ProjectV2): boolean => validateSettingsV2(project.settings) &&
  validateExecutionView(project.capabilities.execution) && validateLanguageView(project.capabilities.language) &&
  project.capabilities.language.projectId === project.projectId &&
  project.capabilities.language.configurationGeneration === project.capabilities.execution.runtime.configurationGeneration &&
  (project.capabilities.execution.runtime.profileId === null || project.capabilities.language.profileId === project.capabilities.execution.runtime.profileId);
export function validateMutationOutcomeV2(value: unknown): value is MutationOutcomeV2 {
  if (!validateV2WireShape('MutationOutcome',value)) return false;
  const v = value as MutationOutcomeV2, m = v.mutation;
  if (!mutationValid(m)) return false;
  if (v.state === 'UNKNOWN') return true;
  const current = v.current;
  if (current.project.projectId !== m.projectId || !mutationProjectValid(current.project)) return false;
  if (current.run !== null && (!validateRunV2(current.run) ||
      current.run.configurationGeneration !== current.project.capabilities.execution.runtime.configurationGeneration ||
      current.run.profileId !== current.project.capabilities.execution.runtime.profileId ||
      current.run.workspaceVersionAtStart > current.project.workspaceVersion)) return false;
  if (v.state === 'DEFINITIVELY_ABORTED') return true;
  if (v.mutation.kind === 'RUN') {
    const run = v.result as RunV2, request = v.mutation.request;
    return validateRunV2(run) && run.mode === request.mode && run.configurationGeneration === request.configurationGeneration && run.workspaceVersionAtStart === request.expectedWorkspaceVersion;
  }
  const project = v.result as ProjectV2, request = v.mutation.request;
  return mutationProjectValid(project) && project.projectId === m.projectId && project.sessionId === request.sessionId &&
    project.workspaceVersion === request.expectedWorkspaceVersion + 1 && same(project.settings,request.settings);
}
