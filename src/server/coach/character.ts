import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONFIG_PATH} from './codexConfig';

export interface CharacterPackage {
  readonly name:string;
  /** Paths within the private Codex working directory, never the student's files. */
  readonly files:ReadonlyArray<{readonly path:string;readonly content:Buffer}>;
}
export const CHARACTERS_PATH=fileURLToPath(new URL('../../../characters/',import.meta.url));

export function loadCharacter(configPath=process.env.PAIRCOACH_CONFIG||DEFAULT_CONFIG_PATH,charactersPath=CHARACTERS_PATH):CharacterPackage {
  const config=JSON.parse(fs.readFileSync(configPath,'utf8').replace(/^\uFEFF/,''));
  const name=config.character??'default';
  if(typeof name!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name))throw Error('COACH_CHARACTER_INVALID');
  const root=path.resolve(charactersPath,name);
  if(fs.lstatSync(root).isSymbolicLink()||!fs.statSync(root).isDirectory())throw Error('COACH_CHARACTER_UNSAFE');
  const files:{path:string;content:Buffer}[]=[];let size=0;
  const read=(source:string,destination:string)=>{
    const before=fs.lstatSync(source);
    if(before.isSymbolicLink()||!before.isFile())throw Error('COACH_CHARACTER_UNSAFE');
    if(files.length>=256||(size+=before.size)>1_048_576)throw Error('COACH_CHARACTER_SIZE_LIMIT');
    const content=fs.readFileSync(source),after=fs.lstatSync(source);
    if(content.length!==before.size||after.dev!==before.dev||after.ino!==before.ino||after.mtimeMs!==before.mtimeMs)
      throw Error('COACH_CHARACTER_CHANGED');
    files.push({path:destination,content});
  };
  read(path.join(root,'AGENTS.md'),'AGENTS.md');
  if(!files[0].content.toString('utf8').trim()||files[0].content.length>32768)throw Error('COACH_CHARACTER_AGENTS_LIMIT');
  const skills=path.join(root,'skills');
  const walk=(directory:string,destination:string,depth=0)=>{
    if(depth>8)throw Error('COACH_CHARACTER_DEPTH_LIMIT');
    if(fs.lstatSync(directory).isSymbolicLink())throw Error('COACH_CHARACTER_UNSAFE');
    for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      if(entry.isSymbolicLink())throw Error('COACH_CHARACTER_UNSAFE');
      const source=path.join(directory,entry.name),target=path.join(destination,entry.name);
      if(entry.isDirectory())walk(source,target,depth+1);else read(source,target);
    }
  };
  if(fs.existsSync(skills))walk(skills,path.join('.agents','skills'));
  return Object.freeze({name,files:Object.freeze(files)});
}

export async function copyCharacter(character:CharacterPackage,cwd:string):Promise<void> {
  for(const file of character.files) {
    const target=path.join(cwd,file.path);
    await fs.promises.mkdir(path.dirname(target),{recursive:true,mode:0o700});
    await fs.promises.writeFile(target,file.content,{mode:0o600,flag:'wx'});
  }
}
