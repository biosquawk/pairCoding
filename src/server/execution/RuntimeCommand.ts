/** Independent executor grammar for K run-execution-convention-v1. NEVER import adapter plan builders. */
import type {
  ExecutionPlan
} from './ports';
import type {
  AdapterFamily, JavaRelease, RunKind, TaskRunConfig
} from '../../shared/runtime-v2';
import {
  validateTaskForProfile
} from '../../shared/validation-v2';
import {
  canonicalJson, requireThat, safeRelative
} from './files';
export const EXECUTION_COMMAND_ENV = Object.freeze({
  CI:'true',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'UTC',PYTHONDONTWRITEBYTECODE:'1'
});
export const RUNTIME_EXECUTABLE='/opt/paircoach/node/bin/node';
export const RUNTIME_DISPATCHER='/opt/paircoach/runtime-task.mjs';
export interface RuntimeTaskSpec {
  schemaVersion:1;
  family:AdapterFamily;
  release:JavaRelease|null;
  preview:boolean;
  runId:string;
  manifestSha256:string;
  mode:RunKind;
  task:TaskRunConfig;
  cache:'/cache/0'
}
export function validateRuntimeCommand(plan:ExecutionPlan):RuntimeTaskSpec {
  try {
    const c=plan.command;
    requireThat(c.executable===RUNTIME_EXECUTABLE&&c.args.length===2&&c.args[0]===RUNTIME_DISPATCHER,'Exact trusted dispatcher/executable required');
    requireThat(c.workingDirectory==='/workspace'&&canonicalJson(c.environment)===canonicalJson(EXECUTION_COMMAND_ENV),'Exact cwd/environment required');
    const encoded=c.args[1];
    requireThat(typeof encoded==='string'&&encoded.length>0&&encoded.length<=4096&&/^[A-Za-z0-9_-]+$/.test(encoded),'Strict bounded unpadded base64url required');
    const bytes=Buffer.from(encoded,'base64url');
    requireThat(bytes.toString('base64url')===encoded,'Noncanonical base64url');
    const json=new TextDecoder('utf-8',{
      fatal:true
    }).decode(bytes);
    const value=JSON.parse(json);
    requireThat(value&&typeof value==='object'&&!Array.isArray(value)&&canonicalJson(value)===json,'Canonical JSON required (no duplicate keys)');
    const keys=['cache','family','manifestSha256','mode','preview','release','runId','schemaVersion','task'];
    requireThat(canonicalJson(Object.keys(value).sort())===canonicalJson(keys),'Exact task specification fields required');
    const spec=value as RuntimeTaskSpec;
    requireThat(spec.schemaVersion===1&&spec.family===plan.profile.adapterFamily&&spec.release===plan.profile.compilerRelease&&spec.preview===plan.profile.analysis.preview&&spec.runId===plan.ownership.runId&&spec.manifestSha256===plan.input.identity.manifestSha256&&spec.mode===plan.mode&&spec.cache==='/cache/0','Task specification identity mismatch');
    requireThat(plan.caches.length===1&&plan.caches[0].readOnly===true,'Exactly one prepared read-only cache required');
    requireThat(validateTaskForProfile(plan.profile,{
      kind:spec.mode,task:spec.task,timeoutMs:plan.timeoutMs
    }),'Task does not match approved profile');
    const literalPath=(p:string)=>safeRelative(p)&&!p.split('/').some(s=>s.startsWith('-'));
    requireThat(spec.task.workingDirectory==='.'||literalPath(spec.task.workingDirectory),'Literal task cwd required');
    requireThat(spec.task.tests.paths.every(literalPath)&&spec.task.tests.names.every(s=>/^[A-Za-z0-9_$.*?#()[\]:-]+$/.test(s)&&!s.startsWith('-')),'Literal selectors required');
    const entry=spec.task.entry;
    if('path' in entry)requireThat(literalPath(entry.path),'Literal entry path required');
    // Neutral structural service comparison: no Java/Spring dispatch in the executor.
    if('containerPort' in entry)requireThat(plan.mode==='RUN_MAIN'&&plan.service&&entry.containerPort===plan.service.containerPort&&entry.healthPath===plan.service.healthPath,'Service task/plan mismatch');
    else requireThat(plan.service===null,'Unexpected service plan');
    return spec;
  } catch(error) {
    throw new Error('TASK_CONFIG_INVALID: '+(error instanceof Error?error.message:String(error)),{
      cause:error
    });
  }
}
