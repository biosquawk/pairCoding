import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {LearningPack,LearningTask,KnowledgeFragment} from '../../shared/sprint';
import {canonicalDirectory,readRecord,privateDirectory,createRecord} from '../runtime-coordinator/storage';
import {TransportError} from '../transport';
export const DEFAULT_PACK_PATH=fileURLToPath(new URL('../../../learning-packs/rest-spring/',import.meta.url));
const fail=(message:string):never=>{throw new TransportError(409,'LEARNING_PACK_INVALID',message);};
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(v);
const safe=(v:unknown):v is string=>typeof v==='string'&&v.length<1024&&v.split('/').every(id);
export function readLearningPack(root=DEFAULT_PACK_PATH):LearningPack {
  canonicalDirectory(root);
  const read=(file:string)=>JSON.parse(readRecord(path.join(root,file),262144)!.toString('utf8'));
  const c=read('curriculum.json'),k=read('knowledge-index.json');
  if(!c||!id(c.id)||!id(c.version)||typeof c.title!=='string'||!Array.isArray(c.topics)||!c.topics.length||
    c.topics.length>20||c.topics.some((t:any)=>!id(t.id)||typeof t.title!=='string')||
    !Array.isArray(c.tasks)||c.tasks.length>100||!Array.isArray(k.sources)||k.sources.length>100)fail('Invalid curriculum or index.');
  const sources=k.sources as KnowledgeFragment[];
  if(new Set(sources.map(s=>s.id)).size!==sources.length||sources.some(s=>!id(s.id)||
    !['AUTHOR_TRAINING','USER_MATERIAL','REFERENCE'].includes(s.sourceKind)||typeof s.sourceTitle!=='string'||
    s.sourceTitle.length>200||typeof s.section!=='string'||s.section.length>120||typeof s.text!=='string'||s.text.length>4000||
    (s.quote!==undefined&&(typeof s.quote!=='string'||s.quote.length>240||!s.text.includes(s.quote)))))fail('Unknown source or quote not present in fragment.');
  const tasks=c.tasks as LearningTask[];
  if(new Set(tasks.map(t=>t.id)).size!==tasks.length||tasks.some(t=>!id(t.id)||!c.topics.some((topic:any)=>topic.id===t.topicId)||
    !safe(t.exercisePath)||t.exercisePath!=='tasks/'+t.id||typeof t.title!=='string'||t.title.length>160||
    !Number.isInteger(t.difficulty)||t.difficulty<1||t.difficulty>5||!Number.isInteger(t.estimatedMinutes)||t.estimatedMinutes<1||t.estimatedMinutes>240||
    !['IMPLEMENTATION','BUGFIX'].includes(t.kind)||typeof t.ready!=='boolean'||!Array.isArray(t.sourceIds)||!t.sourceIds.length||
    t.sourceIds.some(s=>!sources.some(source=>source.id===s))))fail('Invalid task or unknown source.');
  for(const t of tasks)canonicalDirectory(path.join(root,t.exercisePath));
  return {id:c.id,version:c.version,title:c.title,topics:c.topics,tasks,sources};
}
/** Install source-only exercise trees, once. Never replace a student's existing bytes.
 * No references, other exercises or private metadata enter an exercise workspace. */
export function installLearningTask(projectDirectory:string,pack:LearningPack,task:LearningTask,root=DEFAULT_PACK_PATH,allowExisting=false):string {
  const base=path.join(projectDirectory,'sprint-'+pack.id+'-'+pack.version);
  privateDirectory(base);privateDirectory(path.join(base,'tasks'));
  const destination=path.join(base,task.exercisePath);
  if(fs.existsSync(destination)){if(!allowExisting)fail('Unowned existing exercise; choose a fresh training project.');canonicalDirectory(destination);return destination;}
  const copy=(source:string,target:string,depth:number)=>{
    if(depth>12)fail('Exercise tree too deep.');
    canonicalDirectory(source);privateDirectory(target);
    for(const e of fs.readdirSync(source,{withFileTypes:true})) {
      if(e.isSymbolicLink()||!/^[-.a-zA-Z0-9]+$/.test(e.name)||e.name==='target'||e.name==='references')fail('Unsafe exercise asset.');
      const from=path.join(source,e.name),to=path.join(target,e.name);
      if(e.isDirectory())copy(from,to,depth+1);
      else createRecord(to,readRecord(from,262144)!);
    }
  };
  const staged=path.join(base,'install-'+randomUUID());
  copy(path.join(root,task.exercisePath),staged,0);
  privateDirectory(path.join(staged,'.paircoach'));
  createRecord(path.join(staged,'.paircoach','settings.json'),readRecord(path.join(staged,'settings.v2.json'),262144)!);
  if(fs.existsSync(destination))fail('Exercise appeared during installation.');
  fs.renameSync(staged,destination);
  return destination;
}
export function learningTaskPath(projectDirectory:string,pack:LearningPack,task:LearningTask):string {
  return path.join(projectDirectory,'sprint-'+pack.id+'-'+pack.version,task.exercisePath);
}
