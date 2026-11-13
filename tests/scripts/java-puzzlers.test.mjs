import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {allowedSource} from '../../scripts/verify-source-revision.mjs';
const source=fileURLToPath(new URL('../../java-puzzlers/',import.meta.url));
test('ten independent puzzles ship sources/settings and preserve local task settings on preparation',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pc-puzzler-prepare-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.cpSync(source,root,{recursive:true,filter:p=>!p.split(path.sep).includes('.paircoach')&&!p.split(path.sep).includes('target')});
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'SOURCE.json'),'utf8'));assert.equal(manifest.exercises.length,10);
 for(const task of manifest.exercises){for(const name of ['pom.xml','challenge.md','settings.v2.json','src/main/java/demo/Puzzler.java','src/test/java/demo/PuzzlerTest.java']){assert.ok(fs.existsSync(path.join(root,task.folder,name)));assert.equal(allowedSource('java-puzzlers/'+task.folder+'/'+name),true);}
 assert.equal(allowedSource('java-puzzlers/'+task.folder+'/.paircoach/settings.json'),false);assert.equal(allowedSource('java-puzzlers/'+task.folder+'/target/classes/a.class'),false);}
 const run=(...args)=>spawnSync(process.execPath,[path.join(root,'prepare-tasks.mjs'),...args],{encoding:'utf8'});
 assert.equal(run().status,0);const first=path.join(root,manifest.exercises[0].folder,'.paircoach/settings.json');assert.equal(JSON.parse(fs.readFileSync(first,'utf8')).aiConsent,false);
 const custom=fs.readFileSync(first,'utf8').replace('false','true');fs.writeFileSync(first,custom);assert.equal(run('--ai-consent').status,0);assert.equal(fs.readFileSync(first,'utf8'),custom,'existing settings never overwritten');
 assert.notEqual(run('--unknown').status,0);
});
