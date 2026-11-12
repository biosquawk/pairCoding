/** Retained synthetic raw evidence (not real user state). No listen/Docker/native reboot. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRuntimeWorkspace } from '../../src/server/runtime-coordinator/RuntimeWorkspace';
const output = process.argv[2];
if (!output || fs.existsSync(output)) throw Error('New explicit evidence directory required; never overwrite unknown evidence');
fs.mkdirSync(output,{recursive:true,mode:0o700});
const raw = (root:string) => {
  const result:Record<string,{sha256:string;bytes:number;rawBase64:string}>={};
  const walk=(d:string)=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(e.isFile()){const b=fs.readFileSync(p);result[path.relative(root,p)]={sha256:createHash('sha256').update(b).digest('hex'),bytes:b.length,rawBase64:b.toString('base64')};}}};walk(root);return result;
};
const revision=execFileSync('git',['rev-parse','HEAD','HEAD^{tree}'],{encoding:'utf8'}).trim();
for(const mode of ['lazy','signed']){
  const dir=path.join(output,mode);fs.mkdirSync(dir,{mode:0o700});const root=path.join(dir,'root');fs.mkdirSync(root,{mode:0o700});fs.writeFileSync(path.join(root,'a.ts'),'initial\n');
  const seeded=spawnSync(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixture-child.ts',import.meta.url)),root,mode,'1000000001'],{encoding:'utf8'});
  assert.equal(seeded.status,0,seeded.stderr);const original=JSON.parse(seeded.stdout.trim());
  fs.writeFileSync(path.join(dir,'original.json'),JSON.stringify(original,null,2),{mode:0o600});
  const before=raw(root);fs.writeFileSync(path.join(dir,'raw-before.json'),JSON.stringify(before,null,2),{mode:0o600});
  const core=await createRuntimeWorkspace({rootPath:root});
  const observed={projectId:core.workspace.projectId,workspaceVersion:core.workspace.workspaceVersion,version:core.workspace.getDocument('a.ts').version,settings:core.readSettings(),settingsOutcome:await core.settingsAuthority.reconcile(original.identity,o=>o)};
  assert.equal(observed.projectId,original.projectId);assert.equal(observed.workspaceVersion,original.workspaceVersion);assert.equal(observed.version,original.version);assert.deepEqual(observed.settingsOutcome,{state:'COMMITTED',receipt:original.receipt});core.close();
  const after=raw(root);for(const [p,b]of Object.entries(before))assert.deepEqual(after[p],b,p);
  const added=Object.keys(after).filter(p=>!before[p]);assert.deepEqual(added,mode==='lazy'?['.paircoach/workspace-v1.json']:[]);
  fs.writeFileSync(path.join(dir,'raw-after.json'),JSON.stringify(after,null,2),{mode:0o600});
  fs.writeFileSync(path.join(dir,'comparison.json'),JSON.stringify({revision,mode,original,observed,allOriginalRawBytesEqual:true,added},null,2),{mode:0o600});
  process.stdout.write(JSON.stringify({mode,projectId:observed.projectId,allOriginalRawBytesEqual:true,added})+'\n');
}
