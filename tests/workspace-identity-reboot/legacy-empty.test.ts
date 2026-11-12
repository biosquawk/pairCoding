import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRuntimeWorkspace } from '../../src/server/runtime-coordinator/RuntimeWorkspace';
for(const tombstone of [false,true])test('unchanged genuine lazy e982 '+(tombstone?'tombstone':'empty')+' remains compatible without a historical stamp witness',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'unchanged-old-empty-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  if(tombstone)fs.writeFileSync(path.join(root,'a.ts'),'old\n');
  const seed=spawnSync(process.execPath,['--import','tsx',fileURLToPath(new URL('./legacy-empty-child.ts',import.meta.url)),root,String(tombstone)],{encoding:'utf8'});
  assert.equal(seed.status,0,seed.stderr);const expected=JSON.parse(seed.stdout.trim());
  const versionFile=path.join(root,'.paircoach/workspace-v2/versions.json'), before=fs.readFileSync(versionFile);
  assert.equal(fs.existsSync(path.join(root,'.paircoach/workspace-v1.json')),false);
  const core=await createRuntimeWorkspace({rootPath:root});
  try{assert.equal(core.workspace.projectId,expected.projectId);assert.equal(core.workspace.workspaceVersion,expected.workspaceVersion);assert.deepEqual(fs.readFileSync(versionFile),before);}
  finally{core.close();}
});
