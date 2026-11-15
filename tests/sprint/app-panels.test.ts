/** Actual React DOM reconciliation of App/SprintPanel/SessionPanel in jsdom.
 * Only the transport and Monaco surface are replaced; no HTTP/browser/Docker/AI proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import React, {act} from 'react';
import {MockBackendSimulator} from '../../src/services/simulator';
import {readLearningPack} from '../../src/server/sprint/LearningPack';

test('App keeps one current sprint and Next action across repeated task/environment/chat switches', async t => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {url:'http://app.test'});
  const saved = new Map<string,PropertyDescriptor|undefined>();
  for (const [name,value] of Object.entries({window:dom.window,document:dom.window.document,
    HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})) {
    saved.set(name,Object.getOwnPropertyDescriptor(globalThis,name));
    Object.defineProperty(globalThis,name,{value,configurable:true,writable:true});
  }
  // jsdom has no layout/scrolling; this is unrelated to reconciliation.
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const errors: string[] = [], originalError = console.error;
  console.error = (...args) => {errors.push(args.map(String).join(' '));};
  await fs.mkdir(path.resolve('target'),{recursive:true});
  const tmp = await fs.mkdtemp(path.resolve('target/app-panels-'));
  const {createRoot}=await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    try {await act(async () => root.unmount());}
    finally {
      console.error=originalError;dom.window.close();delete (globalThis as any).__appPanelsClient;
      for (const [name,descriptor] of saved) {
        if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete (globalThis as any)[name];
      }
      await fs.rm(tmp,{recursive:true,force:true});
    }
  });
  const pack=readLearningPack(), ids=['get-item','create-item','update-item'];
  let taskIndex=0;
  const view=()=>({pack,sprint:{sprintId:'sprint',packId:pack.id,packVersion:pack.version,topics:['http'],
    startLevel:1,budgetMinutes:45,elapsedMs:0,status:'ACTIVE',activeAttemptId:'attempt-'+taskIndex,
    attempts:[{attemptId:'attempt-'+taskIndex,taskId:ids[taskIndex],sessionId:'session-'+taskIndex,
      startedAt:'2026-11-15T00:00:00Z',outcome:'IN_PROGRESS',runs:[],help:false,selfAssessment:null}],
    recommendation:{taskId:ids[(taskIndex+1)%ids.length],reason:'AVAILABLE_IN_SELECTED_TOPICS'},requests:[]}});
  const project={id:'project',name:'Fixture',projectFile:'/fixture/project.paircoding.json',
    exercisePath:'/fixture/'+ids[0],workspace:{openTabs:[],activePath:null,sidebarTab:'task',bottomTab:'console'},sprint:view().sprint};
  let state:any={...new MockBackendSimulator().getFullState(),transportMode:'LIVE_BACKEND',locale:'pl',
    durableProject:project,pendingPaths:[],taskReadError:null,connectionError:null,storageError:null};
  const listeners=new Set<(s:any)=>void>(), actions: string[]=[];
  const publish=()=>{state={...state,durableProject:{...state.durableProject,exercisePath:'/fixture/'+ids[taskIndex],sprint:view().sprint}};
    for(const listener of listeners)listener(state);};
  (globalThis as any).__appPanelsClient={transportMode:'LIVE_BACKEND',getState:()=>state,
    onStateChanged:(listener:(s:any)=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);},
    readSprint:async()=>view(),sprintAction:async(kind:string)=>{actions.push(kind+':'+ids[taskIndex]);
      taskIndex=(taskIndex+1)%ids.length;publish();return view();},
    saveProjectWorkspace:async()=>true,sendWindowState:()=>{},getEditorLanguageBinding:()=>null,getReportHistoryScope:()=>null};
  const outfile=path.join(tmp,'App.mjs');
  await build({entryPoints:[path.resolve('src/App.tsx')],outfile,bundle:true,platform:'node',format:'esm',
    packages:'external',jsx:'automatic',sourcemap:'inline',plugins:[{name:'isolated-app-ports',setup(b){
      b.onResolve({filter:/\/services\/PairCoachClient$/},()=>({path:'client',namespace:'fixture'}));
      b.onResolve({filter:/\/components\/EditorPanel$/},()=>({path:'editor',namespace:'fixture'}));
      b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='client'
        ? 'export const client=globalThis.__appPanelsClient;'
        : 'export const EditorPanel=()=>null;',loader:'js'}));
    }}]});
  const {default:App}=await import(pathToFileURL(outfile).href);
  await act(async()=>root.render(React.createElement(App)));
  const doc=dom.window.document;
  const click=async(element:HTMLElement)=>{await act(async()=>element.click());};
  const tab=async(name:string)=>{const node=doc.getElementById('sidebar-tab-'+name);assert.ok(node);await click(node);};
  const panels=()=>[...doc.querySelectorAll<HTMLElement>('section[aria-label="Sprint nauki"]')];
  const next=()=>[...doc.querySelectorAll<HTMLButtonElement>('#sidebar-panel-task button')].filter(b=>b.textContent==='Dalej');
  const assertCurrent=(stage:string)=>{
    console.log(JSON.stringify({stage,sprints:panels().length,next:next().length,
      titles:panels().map(p=>p.querySelector('strong')?.textContent)}));
    assert.equal(panels().length,1,stage+': exactly one sprint in DOM, not a stale orphan');
    assert.equal(panels()[0].closest('[hidden]'),null,stage+': sprint is visible in selected task tab');
    assert.equal(next().length,1,stage+': exactly one Next, never first/nth');
    const title=pack.tasks.find(task=>task.id===ids[taskIndex])!.title;
    assert.equal(panels()[0].querySelector('strong')?.textContent,title,stage+': current task');
    for(const old of ids.filter(id=>id!==ids[taskIndex])) {
      assert.ok(!panels()[0].textContent?.includes(pack.tasks.find(task=>task.id===old)!.title),stage+': no stale task');
    }
  };
  assertCurrent('initial');
  for(let cycle=0;cycle<6;cycle++) {
    await tab(cycle%2?'chat':'environment');
    const inactivePanels=panels().length;
    await tab('task');assertCurrent('return '+cycle);
    assert.equal(inactivePanels,0,'leaving task removes its sprint, including hidden orphan nodes');
    const currentId=ids[taskIndex];await click(next()[0]);
    assert.equal(actions.at(-1),'next:'+currentId,'the unique action addresses the current task');
    assert.equal(actions.length,cycle+1,'one click sends only one action');
    assertCurrent('next '+cycle);
  }
  // Project identity must still remount the cache, even if the exercise path is unchanged.
  taskIndex=1; // Different backend view, deliberately unchanged exercisePath/sprint reference.
  state={...state,durableProject:{...state.durableProject,id:'other-project'}};
  await act(async()=>{for(const listener of listeners)listener(state);});
  assertCurrent('other project');
  assert.deepEqual(errors,[],'no duplicate-key, reconciliation, or React warnings');
});
