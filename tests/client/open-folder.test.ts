import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {LiveBackend} from '../../src/services/LiveBackend';
import {createPairCoachServer} from '../../src/server/http';
import {listFolders} from '../../src/server/FolderBrowser';

async function until(predicate:()=>boolean) {
  const deadline=Date.now()+10000;
  while(!predicate()){if(Date.now()>deadline)throw Error('Client did not settle');await delay(20);}
}
function files(root:string) {
  return fs.readdirSync(root,{recursive:true}).sort();
}

test('authenticated folder browsing is shallow, read-only and rejects invalid/link paths', {timeout:30000}, async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'paircoach-folder-list-'));
  const a=path.join(base,'01 Żółć'),b=path.join(base,'02 Test');
  fs.mkdirSync(a);fs.mkdirSync(b);fs.mkdirSync(path.join(b,'nested'));
  fs.writeFileSync(path.join(a,'challenge.md'),'# A');
  const link=path.join(base,'linked');fs.symlinkSync(b,link,process.platform==='win32'?'junction':'dir');
  const app=createPairCoachServer({rootPath:a,port:0,token:'folder-test',runtimeEnvironment:{},runtimeArguments:['--runtime-config',path.join(base,'missing.json')]});
  const port=await app.listen(),url=`http://127.0.0.1:${port}/api/folders`;
  t.after(async()=>{await app.close();fs.rmSync(base,{recursive:true,force:true});});
  const before=files(base),version=app.workspace.workspaceVersion;
  assert.equal((await fetch(url)).status,401);
  const response=await fetch(url,{headers:{Authorization:'Bearer folder-test'}});
  assert.equal(response.status,200);const body=await response.json();
  assert.equal(body.path,base);assert.equal(body.parent,path.dirname(base));
  assert.deepEqual(body.directories,[{name:path.basename(a),path:a},{name:path.basename(b),path:b}]);
  for(const invalid of ['', 'relative', '\0'])await assert.rejects(listFolders(invalid),{code:'INVALID_FOLDER'});
  await assert.rejects(listFolders(link),{code:'UNSAFE_ROOT'});
  await assert.rejects(listFolders(path.join(a,'challenge.md')),{code:'UNSAFE_ROOT'});
  await assert.rejects(listFolders(path.join(base,'absent')),{code:'FOLDER_UNAVAILABLE'});
  assert.equal((await listFolders(path.parse(base).root)).parent,null);
  assert.equal((await fetch(url+'?path='+encodeURIComponent(b)+'&extra=1',{headers:{Authorization:'Bearer folder-test'}})).status,400);
  assert.deepEqual(files(base),before,'browsing never initializes the selected sibling or modifies project metadata');
  assert.equal(app.workspace.workspaceVersion,version);
});

test('existing open/ACK path saves in the old folder before switching and preserves same-named files and failed opens', {timeout:30000}, async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'paircoach-folder-open-'));
  const a=path.join(base,'A'),b=path.join(base,'B');
  const settings={schemaVersion:2,taskFilePath:'challenge.md',taskMode:'IMPLEMENTATION',reviewNotesPath:'review.md',aiConsent:false,contextPatterns:['*.js'],runProfiles:[]};
  for(const [root,content] of [[a,'A original\n'],[b,'B original\n']]) {
    fs.mkdirSync(path.join(root,'.paircoach'),{recursive:true,mode:0o700});
    fs.writeFileSync(path.join(root,'challenge.md'),'# '+path.basename(root));
    fs.writeFileSync(path.join(root,'solution.js'),content);
    fs.writeFileSync(path.join(root,'.paircoach/settings.json'),JSON.stringify(settings),{mode:0o600});
  }
  const app=createPairCoachServer({rootPath:a,port:0,runtimeEnvironment:{},runtimeArguments:['--runtime-config',path.join(base,'missing.json')]});
  const port=await app.listen(),requests:string[]=[];
  const client=new LiveBackend({baseUrl:`http://127.0.0.1:${port}`,fetch:((url,options)=>{
    if(String(url).endsWith('/api/project/open'))requests.push(fs.readFileSync(path.join(app.workspace.rootPath,'solution.js'),'utf8'));
    return fetch(url,options);
  }) as typeof fetch});
  t.after(async()=>{client.close();await app.close();fs.rmSync(base,{recursive:true,force:true});});
  await client.connect();await until(()=>!client.getState().isOffline);
  await client.selectFile('solution.js');
  client.saveFileContent('solution.js','A saved before open\n');
  assert.equal(await client.openProject(b),true);
  await until(()=>!client.getState().isOffline&&client.getState().scenario.title===b);
  assert.equal(requests[0],'A saved before open\n','open POST comes after the actual old-project save');
  await client.selectFile('solution.js');
  assert.equal(client.getState().files.find(f=>f.path==='solution.js')?.content,'B original\n');
  client.saveFileContent('solution.js','B edited\n');
  assert.equal(await client.openProject(a),true);
  await until(()=>!client.getState().isOffline&&client.getState().scenario.title===a);
  await client.selectFile('solution.js');
  assert.equal(client.getState().files.find(f=>f.path==='solution.js')?.content,'A saved before open\n');
  assert.equal(fs.readFileSync(path.join(b,'solution.js'),'utf8'),'B edited\n');
  assert.equal(await client.openProject(path.join(base,'absent')),false);
  assert.equal(client.getState().scenario.title,a);
  assert.equal(app.workspace.rootPath,a);
  // An actual coach owner blocks both the client and the authoritative open route.
  app.session.state.writeOwner='COACH';
  const count=requests.length;
  assert.equal(await client.openProject(b),false);
  assert.equal(requests.length,count+1,'server rejects a stale client view of ownership');
  assert.match(client.getState().connectionError!,/CONTROL_UNAVAILABLE/);
  assert.equal(app.workspace.rootPath,a);
  app.session.state.writeOwner='STUDENT';
});
