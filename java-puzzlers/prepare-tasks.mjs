import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const consent=process.argv.includes('--ai-consent');
if(process.argv.slice(2).some(arg=>arg!=='--ai-consent'))throw Error('Usage: node java-puzzlers/prepare-tasks.mjs [--ai-consent]');
for(const task of JSON.parse(fs.readFileSync(path.join(root,'SOURCE.json'),'utf8')).exercises){
 if(!/^\d{2}-[a-z-]+$/.test(task.folder))throw Error('Invalid task folder');
 const project=path.join(root,task.folder),data=path.join(project,'.paircoach'),target=path.join(data,'settings.json');
 if(fs.lstatSync(project).isSymbolicLink())throw Error('Task folder must not be a link');
 if(!fs.existsSync(data))fs.mkdirSync(data,{mode:0o700});
 const st=fs.lstatSync(data);
 if(st.isSymbolicLink()||!st.isDirectory()||(process.platform!=='win32'&&(st.mode&0o077)))throw Error('Unsafe task settings directory');
 if(fs.existsSync(target)){console.log(task.folder+': existing settings preserved');continue;}
 const settings=JSON.parse(fs.readFileSync(path.join(project,'settings.v2.json'),'utf8'));settings.aiConsent=consent;
 fs.writeFileSync(target,JSON.stringify(settings,null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log(task.folder+': initialized, aiConsent='+consent);
}
