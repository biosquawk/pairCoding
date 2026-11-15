import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {readLearningPack,installLearningTask,DEFAULT_PACK_PATH} from '../../src/server/sprint/LearningPack';

test('all twelve ordinary exercises use the same prepared toolchain; installation never includes references',t=>{
 const pack=readLearningPack();assert.equal(pack.tasks.length,12);assert.equal(pack.topics.length,5);
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'material-assets-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const pom=fs.readFileSync(path.join(DEFAULT_PACK_PATH,'tasks/get-item/pom.xml'));
 const profile=JSON.parse(fs.readFileSync(path.join(DEFAULT_PACK_PATH,'tasks/get-item/settings.v2.json'),'utf8'));
 const material=fs.readFileSync(path.join(DEFAULT_PACK_PATH,'material.md'),'utf8');
 for(const task of pack.tasks){
  const source=path.join(DEFAULT_PACK_PATH,task.exercisePath);
  assert.deepEqual(fs.readFileSync(path.join(source,'pom.xml')),pom,task.id);
  const settings=JSON.parse(fs.readFileSync(path.join(source,'settings.v2.json'),'utf8'));
  const withoutHealth=(s:any)=>({...s,runProfiles:s.runProfiles.map((p:any)=>({...p,task:{...p.task,entry:{...p.task.entry,healthPath:'endpoint-specific'}}}))});
  assert.deepEqual(withoutHealth(settings),withoutHealth(profile),task.id);
  assert.equal(settings.aiConsent,false);assert(!settings.contextPatterns.some((p:string)=>p.includes('reference')));
  for(const sourceId of task.sourceIds){const fragment=pack.sources.find(s=>s.id===sourceId)!;assert(material.includes(fragment.text));if(fragment.quote)assert(fragment.text.includes(fragment.quote));}
  const installed=installLearningTask(base,pack,task);
  assert.deepEqual(fs.readFileSync(path.join(installed,'src/main/java/demo/ApiApplication.java')),fs.readFileSync(path.join(source,'src/main/java/demo/ApiApplication.java')));
  const reference=fs.readFileSync(path.join(DEFAULT_PACK_PATH,'references',task.id,'ApiApplication.java'));
  assert.notDeepEqual(reference,fs.readFileSync(path.join(installed,'src/main/java/demo/ApiApplication.java')),task.id);
  assert.equal(fs.existsSync(path.join(installed,'references')),false);
  assert.deepEqual(fs.readFileSync(path.join(installed,'.paircoach/settings.json')),fs.readFileSync(path.join(source,'settings.v2.json')));
  const edited=path.join(installed,'src/main/java/demo/ApiApplication.java');fs.writeFileSync(edited,'student draft');
  assert.equal(installLearningTask(base,pack,task,DEFAULT_PACK_PATH,true),installed);
  assert.equal(fs.readFileSync(edited,'utf8'),'student draft');
 }
});
