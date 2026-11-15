/** Real browser DOM reconciliation of App/SprintPanel/SessionPanel, file-only.
 * Only transport and Monaco are replaced; NOT live HTTP/Docker/AI evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
import {MockBackendSimulator} from '../../src/services/simulator';
import {readLearningPack} from '../../src/server/sprint/LearningPack';

test('App keeps one current sprint and Next action across repeated task/environment/chat switches', {timeout:60_000}, async t => {
  await fs.mkdir(path.resolve('target'),{recursive:true});
  const tmp=await fs.mkdtemp(path.resolve('target/app-panels-'));
  t.after(()=>fs.rm(tmp,{recursive:true,force:true}));
  const pack=readLearningPack(), ids=['get-item','create-item','update-item'];
  const initial={...new MockBackendSimulator().getFullState(),transportMode:'LIVE_BACKEND',locale:'pl',
    pendingPaths:[],taskReadError:null,connectionError:null,storageError:null};
  await build({stdin:{contents:`
    import React,{act} from 'react';
    import {createRoot} from 'react-dom/client';
    import App from './src/App';
    globalThis.IS_REACT_ACT_ENVIRONMENT=true;
    const pack=${JSON.stringify(pack)},ids=${JSON.stringify(ids)};
    let taskIndex=0;
    const view=()=>({pack,sprint:{sprintId:'sprint',packId:pack.id,packVersion:pack.version,topics:['http'],
      startLevel:1,budgetMinutes:45,elapsedMs:0,status:'ACTIVE',activeAttemptId:'attempt-'+taskIndex,
      attempts:[{attemptId:'attempt-'+taskIndex,taskId:ids[taskIndex],sessionId:'session-'+taskIndex,
        startedAt:'2026-11-15T00:00:00Z',outcome:'IN_PROGRESS',runs:[],help:false,selfAssessment:null}],
      recommendation:{taskId:ids[(taskIndex+1)%ids.length],reason:'AVAILABLE_IN_SELECTED_TOPICS'},requests:[]}});
    let state={...${JSON.stringify(initial)},durableProject:{id:'project',name:'Fixture',
      projectFile:'/fixture/project.paircoding.json',exercisePath:'/fixture/'+ids[0],
      workspace:{openTabs:[],activePath:null,sidebarTab:'task',bottomTab:'console'},sprint:view().sprint}};
    const listeners=new Set(),actions=[];
    const publish=()=>{state={...state,durableProject:{...state.durableProject,
      exercisePath:'/fixture/'+ids[taskIndex],sprint:view().sprint}};for(const listener of listeners)listener(state);};
    globalThis.__appPanelsClient={transportMode:'LIVE_BACKEND',getState:()=>state,
      onStateChanged:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
      readSprint:async()=>view(),sprintAction:async kind=>{actions.push(kind+':'+ids[taskIndex]);
        taskIndex=(taskIndex+1)%ids.length;publish();return view();},
      saveProjectWorkspace:async()=>true,sendWindowState:()=>{},getEditorLanguageBinding:()=>null,getReportHistoryScope:()=>null};
    const root=createRoot(document.getElementById('root'));
    globalThis.__appPanels={
      render:()=>act(async()=>root.render(React.createElement(App))),
      click:selector=>act(async()=>{
        const nodes=document.querySelectorAll(selector);
        if(nodes.length!==1)throw Error('Expected unique control '+selector+', got '+nodes.length);
        nodes[0].click();
      }),
      next:()=>act(async()=>{
        const nodes=[...document.querySelectorAll('#sidebar-panel-task button')].filter(b=>b.textContent==='Dalej');
        if(nodes.length!==1)throw Error('Expected unique Next, got '+nodes.length);
        nodes[0].click();
      }),
      otherProject:()=>act(async()=>{
        taskIndex=1; // Change view but retain exercisePath/sprint references: project key must remount cache.
        state={...state,durableProject:{...state.durableProject,id:'other-project'}};
        for(const listener of listeners)listener(state);
      }),
      snapshot:()=>({taskId:ids[taskIndex],actions:[...actions],
        panels:[...document.querySelectorAll('section[aria-label="Sprint nauki"]')].map(p=>({
          title:p.querySelector('strong')?.textContent,text:p.textContent,
          visible:p.getClientRects().length>0&&!p.closest('[hidden]')})),
        next:[...document.querySelectorAll('#sidebar-panel-task button')].filter(b=>b.textContent==='Dalej').length}),
      close:()=>act(async()=>root.unmount())
    };
  `,resolveDir:process.cwd(),loader:'js'},outfile:path.join(tmp,'App.js'),
    bundle:true,platform:'browser',format:'iife',jsx:'automatic',sourcemap:'inline',
    define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'isolated-app-ports',setup(b){
      b.onResolve({filter:/\/services\/PairCoachClient$/},()=>({path:'client',namespace:'fixture'}));
      b.onResolve({filter:/\/components\/EditorPanel$/},()=>({path:'editor',namespace:'fixture'}));
      b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='client'
        ? 'export const client=new Proxy({}, {get:(_,name)=>globalThis.__appPanelsClient[name]});'
        : 'export const EditorPanel=()=>null;',loader:'js'}));
    }}]});
  await fs.writeFile(path.join(tmp,'index.html'),'<!doctype html><html><body><div id="root"></div><script src="App.js"></script></body></html>');
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
  t.after(()=>browser.close());
  const context=await browser.newContext();
  const external:string[]=[],errors:string[]=[];
  await context.route(/^https?:/,route=>{external.push(route.request().url());return route.abort();});
  const page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(['error','warning'].includes(message.type()))errors.push(message.text());});
  await page.goto(pathToFileURL(path.join(tmp,'index.html')).href);
  await page.evaluate(()=>(window as any).__appPanels.render());
  const snapshot=()=>page.evaluate(()=>(window as any).__appPanels.snapshot());
  const assertCurrent=async(stage:string)=>{
    const s=await snapshot();
    console.log(JSON.stringify({stage,sprints:s.panels.length,next:s.next,titles:s.panels.map((p:{title:string})=>p.title)}));
    assert.equal(s.panels.length,1,stage+': exactly one sprint in DOM, not a stale orphan');
    assert.equal(s.panels[0].visible,true,stage+': sprint is visible in selected task tab');
    assert.equal(s.next,1,stage+': exactly one Next, never first/nth');
    assert.equal(s.panels[0].title,pack.tasks.find(task=>task.id===s.taskId)!.title,stage+': current task');
    for(const old of ids.filter(id=>id!==s.taskId)) {
      assert.ok(!s.panels[0].text.includes(pack.tasks.find(task=>task.id===old)!.title),stage+': no stale task');
    }
    return s;
  };
  await assertCurrent('initial');
  for(let cycle=0;cycle<6;cycle++) {
    await page.evaluate(tab=>(window as any).__appPanels.click('#sidebar-tab-'+tab),cycle%2?'chat':'environment');
    const inactivePanels=(await snapshot()).panels.length;
    await page.evaluate(()=>(window as any).__appPanels.click('#sidebar-tab-task'));
    const current=await assertCurrent('return '+cycle);
    assert.equal(inactivePanels,0,'leaving task removes its sprint, including hidden orphan nodes');
    await page.evaluate(()=>(window as any).__appPanels.next());
    const updated=await assertCurrent('next '+cycle);
    assert.equal(updated.actions.at(-1),'next:'+current.taskId,'unique action addresses current task');
    assert.equal(updated.actions.length,cycle+1,'one click sends only one action');
  }
  await page.evaluate(()=>(window as any).__appPanels.otherProject());
  await assertCurrent('other project');
  await page.evaluate(()=>(window as any).__appPanels.close());
  assert.deepEqual(errors,[],'no duplicate-key, reconciliation, or React warnings');
  assert.deepEqual(external,[],'file-only fixture never contacts a server');
});
