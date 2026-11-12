/** Real public source staging in an isolated umask-077 process; Docker/acquisition are NOT live. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const repo = process.cwd();
test('public staging normalizes ONLY new task copies for uid10001; original/settings/receipts remain private under umask077', {skip:process.platform !== 'linux'}, t => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? path.dirname(repo), 'stage-mode-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const childSource = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import {createHash} from 'node:crypto';
    import {buildPublicPreparePlan,executePublicPreparePlan} from './scripts/runtime-prepare-cli.mjs';
    process.umask(0o077); // child-only restrictive operator environment, never a product umask change
    const root=process.argv[1], project=path.join(root,'project'), output=path.join(root,'output');
    fs.mkdirSync(project,{mode:0o700});
    fs.cpSync('examples/java-pattern',project,{recursive:true});
    // Explicitly private source tree and a private config/secret must never be chmod'ed/copied.
    const makePrivate=dir=>{fs.chmodSync(dir,0o700);for(const name of fs.readdirSync(dir)){const p=path.join(dir,name);if(fs.lstatSync(p).isDirectory())makePrivate(p);else fs.chmodSync(p,0o600);}};
    makePrivate(project);
    fs.mkdirSync(path.join(project,'.paircoach'),{mode:0o700});
    const task=JSON.parse(fs.readFileSync(path.join(project,'task.v2.json')));
    fs.writeFileSync(path.join(project,'.paircoach/settings.json'),JSON.stringify({schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'notes.md',aiConsent:false,contextPatterns:[],runProfiles:task.runProfiles}),{mode:0o600});
    fs.writeFileSync(path.join(project,'.env'),'PRIVATE_UNIT_SECRET_DO_NOT_STAGE',{mode:0o600});
    const mode=p=>fs.lstatSync(p).mode&0o777;
    const tree=dir=>['.',...fs.readdirSync(dir,{recursive:true}).sort()].map(rel=>{const p=path.join(dir,rel),s=fs.lstatSync(p);return[rel,s.mode,s.uid,s.gid,s.ino,s.isFile()?createHash('sha256').update(fs.readFileSync(p)).digest('hex'):null];});
    const before=tree(project), plan=await buildPublicPreparePlan(['--project',project,'--profile','java-maven-21','--output',output]);
    assert.equal(fs.existsSync(output),false,'plan remains read-only');
    const engine={ID:'UNIT-staging-only',ServerVersion:'29.7.2',OSType:'linux',Architecture:'x86_64'};
    let staged=0;
    await assert.rejects(executePublicPreparePlan(plan,{
      spawnSync:(exe,args,options)=>{assert.equal(exe,'docker');assert.equal(args[4],'info');return{status:0,signal:null,stdout:JSON.stringify(engine),stderr:''};},
      stageInputs:async()=>{
        staged++;
        const input=plan.request.project.root;
        for(const rel of ['.',...fs.readdirSync(input,{recursive:true})]){
          const p=path.join(input,rel),s=fs.lstatSync(p);
          assert.equal(s.isSymbolicLink(),false);assert.equal(s.uid,process.getuid(),'new staged nodes remain owned by the caller');
          assert.equal(mode(p),s.isDirectory()?0o755:0o644,'uid10001 must traverse/read the staged bind mount');
        }
        for(const f of plan.sourceInventory)assert.deepEqual(fs.readFileSync(path.join(input,f.path)),fs.readFileSync(path.join(project,f.path)));
        assert.equal(fs.existsSync(path.join(input,'.paircoach')),false);assert.equal(fs.existsSync(path.join(input,'.env')),false);
        assert.equal(mode(output),0o700);assert.equal(mode(path.join(output,'receipt.json')),0o600);
        assert.equal(mode(path.join(output,'jobs')),0o700);
        assert.equal(mode(path.join(output,'docker-config')),0o700);
        assert.equal(mode(path.join(output,'docker-config/command-000001')),0o700);
        throw new Error('UNIT_STOP_AFTER_REAL_STAGING');
      }
    }),/UNIT_STOP_AFTER_REAL_STAGING/);
    assert.equal(staged,1);assert.deepEqual(tree(project),before,'original source identities, ownership, modes and bytes untouched');
    assert.equal(mode(path.join(output,'receipt.json')),0o600);assert.equal(mode(output),0o700);
    assert.equal(fs.existsSync(plan.runtimeConfig),false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(output,'receipt.json'))).status,'FAILED_RETAIN_AND_RECONCILE');
    assert.equal(process.umask(),0o077,'product must not relax the operator umask');
    console.log(JSON.stringify({umask:'077',stagedFiles:plan.sourceInventory.length,stagedDirs:'0755',stagedFilesMode:'0644',output:'0700',receipt:'0600',originalUnchanged:true,liveDocker:false}));
  `;
  const child=spawnSync(process.execPath,['--input-type=module','-e',childSource,root],{cwd:repo,env:{...process.env},encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
  assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr+child.stdout);
  const observation=JSON.parse(child.stdout);assert.equal(observation.originalUnchanged,true);
  console.log(observation);
});
