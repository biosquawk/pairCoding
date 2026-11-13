/** Portable active TS+MJS campaign. Selection follows the owner's Lightweight matrix.
 * Retired source is reported SUPERSEDED, never PASS. No shell expansion or implicit installs. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {supersededDirectories,supersededCases} from './runtime-test-policy.mjs';

export function selectTests(root=process.cwd()) {
  const files=[];
  function visit(directory,relative) {
    for(const item of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      const name=relative+'/'+item.name;
      if(item.isSymbolicLink())throw Error('Symlink in test sources: '+name);
      if(item.isDirectory())visit(path.join(directory,item.name),name);
      else if(item.isFile() && /\.test\.(?:ts|mjs)$/.test(item.name))files.push(name);
    }
  }
  visit(path.join(root,'tests'),'tests');
  const superseded=files.filter(file=>supersededDirectories.some(dir=>file.startsWith(dir+'/')));
  const active=files.filter(file=>!superseded.includes(file));
  for(const extension of ['ts','mjs'])if(!active.some(file=>file.endsWith('.test.'+extension)))throw Error('No active '+extension+' test sources');
  // This MJS test imports the actual TS consumer. Native MJS public-prepare tests must NOT
  // inherit a global tsx hook: Node22 registerHooks/CommonJS would conflict with it.
  const tsxMjs=new Set(['tests/runtime-prepare-cli/prepared-selector.test.mjs']);
  return {active,superseded,status:'SELECTION_ONLY_NOT_TEST_RESULTS',
    supersededCases:[...supersededCases],
    tsx:active.filter(file=>file.endsWith('.ts') || tsxMjs.has(file)),
    nativeMjs:active.filter(file=>file.endsWith('.mjs') && !tsxMjs.has(file))};
}
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function testArguments(selection) {
  const groups=[];
  for(const [lane,files] of [['tsx',selection.tsx],['nativeMjs',selection.nativeMjs]]) {
    const cases=selection.supersededCases;
    // Real-daemon lifecycle timing is measured without another test file competing
    // for that engine. These remain active, unfiltered cases with unchanged deadlines.
    const isolated=files.filter(file=>['tests/execution/runner.test.ts','tests/integration/g3-public.test.ts'].includes(file));
    const matched=files.filter(file=>cases.some(c=>c.file===file));
    const ordinary=files.filter(file=>!matched.includes(file)&&!isolated.includes(file));
    // Bound simultaneous filesystem-heavy fixtures; keep the exact same active files/cases and deadlines.
    const flags=[...(lane==='tsx'?['--import','tsx']:[]),'--test','--test-concurrency=2'];
    let batch=[...flags],length=batch.join(' ').length;
    for(const file of ordinary){
      if(length+file.length+3>22000 && batch.length>flags.length){groups.push({lane,args:batch});batch=[...flags];length=batch.join(' ').length;}
      batch.push(file);length+=file.length+3;
    }
    if(batch.length>flags.length)groups.push({lane,args:batch});
    for(const file of isolated)groups.push({lane,args:[...flags,file]});
    // File-bound, anchored literal titles: an ordinary case with the SAME title in
    // another file is still active. Mixed files are never blanket-excluded.
    for(const file of matched){
      const skip='^(?:'+cases.filter(c=>c.file===file).map(c=>escape(c.title)).join('|')+')$';
      groups.push({lane,args:[...flags,'--test-skip-pattern',skip,file]});
    }
  }
  return groups;
}
export function runTests(root=process.cwd()) {
  const selection=selectTests(root);
  process.stdout.write(JSON.stringify({activeFiles:selection.active.length,supersededFiles:selection.superseded,
    supersededCases:selection.supersededCases,reason:'SUPERSEDED_BY_OWNER_LIGHTWEIGHT_POLICY_NOT_PASS'})+'\n');
  let failed=false;
  for(const group of testArguments(selection)){
    const result=spawnSync(process.execPath,group.args,{cwd:root,stdio:'inherit',shell:false,env:process.env});
    if(result.error || result.signal || result.status!==0)failed=true;
  }
  return failed?1:0;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if(process.argv.length===3 && process.argv[2]==='--list')console.log(JSON.stringify(selectTests(),null,2));
    else if(process.argv.length===2)process.exitCode=runTests();
    else throw Error('Usage: node scripts/runtime-test.mjs [--list]');
  } catch(error){console.error(error.message);process.exitCode=1;}
}
