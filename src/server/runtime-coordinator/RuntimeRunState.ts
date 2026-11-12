/** Private Stop intent/public terminal projection, separate from genuine executor receipts.
 * The real Workspace kernel owns this directory. Never used to authorize process cleanup. */
import path from 'node:path';
import fs from 'node:fs';
import type { ExecutionPlan } from '../execution/ports';
import type { RunV2 } from '../../shared/runtime-v2';
import { validateRunV2 } from '../../shared/validation-v2';
import { canonical, createRecord, privateDirectory, readRecord, replaceRecord, sha256 } from './storage';
export type RetainedRunState={run:RunV2;requested:'USER'|'TIMEOUT'|null};
export class RuntimeRunState {
  constructor(readonly directory:string){privateDirectory(directory);}
  private file(plan:ExecutionPlan){return path.join(this.directory,sha256(plan.ownership.runId)+'.json');}
  assertInventory(plans:readonly ExecutionPlan[]):void {
    const expected=new Set(plans.map(p=>path.basename(this.file(p))));
    const names=fs.readdirSync(this.directory);if(names.length>20004)throw Error('Run state inventory exceeds bound');
    for(const name of names) {
      if(/^\.next-[a-f0-9-]{36}$/.test(name)){readRecord(path.join(this.directory,name),128*1024);continue;}
      if(!expected.has(name))throw Error('Run state without unique original admission; preserve ownership');
    }
  }
  read(plan:ExecutionPlan):RetainedRunState|null {
    const bytes=readRecord(this.file(plan),128*1024,true);if(!bytes)return null;
    const {body,sha256:hash}=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
    const s=body?.state as RetainedRunState;
    if(!body || body.version!==1 || body.planSha256!==sha256(canonical(plan)) || hash!==sha256(canonical(body)) ||
      !s || !validateRunV2(s.run) || ![null,'USER','TIMEOUT'].includes(s.requested) ||
      s.run.runId!==plan.ownership.runId || s.run.profileId!==plan.profile.id || s.run.mode!==plan.mode ||
      s.run.configurationGeneration!==plan.input.identity.configurationGeneration || s.run.workspaceVersionAtStart!==plan.input.identity.workspaceVersion)
      throw Error('Invalid retained original Run state');
    return structuredClone(s);
  }
  retain(plan:ExecutionPlan,run:RunV2,requested:RetainedRunState['requested']):void {
    const prior=this.read(plan), state={run:structuredClone(run),requested};
    if(prior?.run.finishedAt && canonical(prior)!==canonical(state) || prior?.requested && prior.requested!==requested)
      throw Error('Retained Run terminal/Stop intent is immutable');
    const body={version:1,planSha256:sha256(canonical(plan)),state},bytes=Buffer.from(canonical({body,sha256:sha256(canonical(body))}));
    if(prior) {if(canonical(prior)!==canonical(state))replaceRecord(this.file(plan),bytes);}
    else createRecord(this.file(plan),bytes);
    if(canonical(this.read(plan))!==canonical(state))throw Error('Run state readback mismatch');
  }
}
