/** Real browser DOM reconciliation of App/SprintPanel/SessionPanel, file-only.
 * Only transport and Monaco are replaced; NOT live HTTP/Docker/AI evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {compile} from '@tailwindcss/node';
import {Scanner} from '@tailwindcss/oxide';
import {chromium,expect} from '@playwright/test';
import {MockBackendSimulator} from '../../src/services/simulator';
import {readLearningPack} from '../../src/server/sprint/LearningPack';

test('App keeps one current sprint and Next action across repeated task/environment/chat switches', {timeout:60_000}, async t => {
  await fs.mkdir(path.resolve('target'),{recursive:true});
  const tmp=await fs.mkdtemp(path.resolve('target/app-panels-'));
  t.after(()=>fs.rm(tmp,{recursive:true,force:true}));
  // Compile the real product stylesheet without touching the served dist.
  const css=await compile(await fs.readFile('src/index.css','utf8'),{base:process.cwd(),onDependency:()=>{}});
  const candidates=new Scanner({sources:[{base:path.resolve('src'),pattern:'**/*.{ts,tsx}',negated:false}]}).scan();
  await fs.writeFile(path.join(tmp,'App.css'),css.build(candidates));
  const pack=readLearningPack(), ids=['get-item','create-item','update-item'];
  const simulated=new MockBackendSimulator().getFullState();
  const initial={...simulated,transportMode:'LIVE_BACKEND',locale:'pl',
    pendingPaths:[],taskReadError:null,connectionError:null,storageError:null,chatEntries:[],workspaceVersion:1,
    files:simulated.files.map(file=>file.path===simulated.scenario.taskFilePath
      ? {...file,content:'# Long task\n\n'+Array.from({length:100},(_,i)=>'Task paragraph '+i+' with instructions.').join('\n\n')} : file),
    projectSettings:{...simulated.projectSettings,aiConsent:false}};
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
    const listeners=new Set(),actions=[],messages=[];
    const notify=()=>{for(const listener of listeners)listener(state);};
    const publish=()=>{state={...state,durableProject:{...state.durableProject,
      exercisePath:'/fixture/'+ids[taskIndex],sprint:view().sprint,workspace:{...state.durableProject.workspace,sidebarTab:'files'}}};for(const listener of listeners)listener(state);};
    globalThis.__appPanelsClient={transportMode:'LIVE_BACKEND',getState:()=>state,
      onStateChanged:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
      readSprint:async()=>view(),sprintAction:async kind=>{actions.push(kind+':'+ids[taskIndex]);
        taskIndex=(taskIndex+1)%ids.length;publish();return view();},
      updateProjectSettings:async settings=>{state={...state,projectSettings:settings,workspaceVersion:state.workspaceVersion+1};notify();return true;},
      selectFile:path=>{state={...state,activePath:path};notify();},
      sendChatMessage:async message=>{messages.push(message);return true;},
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
        state={...state,durableProject:{...state.durableProject,id:'other-project',workspace:{...state.durableProject.workspace,sidebarTab:'task'}}};
        for(const listener of listeners)listener(state);
      }),
      returnA:()=>act(async()=>{taskIndex=0;publish();}),
      clearChat:()=>act(async()=>{state={...state,chatEntries:[]};notify();}),
      longChat:()=>act(async()=>{state={...state,chatEntries:Array.from({length:40},(_,i)=>({
        id:'scroll-'+i,sender:'COACH',message:'Long chat message '+i+'\\n'+('Current task context. '.repeat(20)),timestamp:0}))};notify();}),
      browserEvents:()=>{globalThis.IS_REACT_ACT_ENVIRONMENT=false;},
      unread:()=>{state={...state,chatEntries:[{id:'automatic',sender:'COACH',message:'Fixture automatic hint',timestamp:0}]};notify();},
      state:()=>({activePath:state.activePath,files:state.files.map(f=>f.path),aiConsent:state.projectSettings.aiConsent,
        workspaceVersion:state.workspaceVersion,messages:[...messages]}),
      snapshot:()=>({taskId:ids[taskIndex],actions:[...actions],
        panels:[...document.querySelectorAll('section[aria-label="Sprint nauki"]')].map(p=>({
          title:p.querySelector('strong')?.textContent,text:p.textContent,
          visible:p.getClientRects().length>0&&!p.closest('[hidden]')})),
        next:[...document.querySelectorAll('#sidebar-panel-task button')].filter(b=>b.textContent==='Dalej').length}),
      close:()=>{globalThis.IS_REACT_ACT_ENVIRONMENT=true;return act(async()=>root.unmount());}
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
  await fs.writeFile(path.join(tmp,'index.html'),'<!doctype html><html><head><link rel="stylesheet" href="App.css"></head><body><div id="root"></div><script src="App.js"></script></body></html>');
  // Chromium's Unix singleton socket must fit even when the checkout/TMPDIR is long.
  const browser=await chromium.launch({headless:true,env:{...process.env,TMPDIR:'target'},
    executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
  t.after(()=>browser.close());
  const context=await browser.newContext();
  const external:string[]=[],errors:string[]=[];
  await context.route(/^https?:/,route=>{external.push(route.request().url());return route.abort();});
  const page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(['error','warning'].includes(message.type()))errors.push(message.text());});
  // tsx/esbuild names nested evaluation callbacks with this identity helper.
  await page.addInitScript('globalThis.__name = (fn) => fn;');
  await page.addInitScript(()=>{
    (window as any).__scrollCalls=[];
    const original=Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView=function(options){
      (window as any).__scrollCalls.push({tag:this.tagName,options});
      return original.call(this,options);
    };
  });
  await page.setViewportSize({width:1440,height:900});
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
  // Real CSS + actual SessionPanel auto-scroll, not a scrollToTop workaround.
  const geometry=()=>page.evaluate(()=>{
    const panel=document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!;
    const rect=(e:Element)=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height};};
    const training=panel.querySelector('section[aria-label="Trening i trener"]')!;
    const sprint=panel.querySelector('section[aria-label="Sprint nauki"]');
    const ancestors=[];
    for(let node:HTMLElement|null=panel;node;node=node.parentElement)
      ancestors.push({tag:node.tagName,id:node.id,scrollTop:node.scrollTop,...rect(node)});
    return {panel:rect(panel),training:rect(training),sprint:sprint?rect(sprint):null,ancestors,
      scrollers:[...panel.querySelectorAll<HTMLElement>('*')].filter(e=>getComputedStyle(e).overflowY==='auto')
        .map(e=>({scrollTop:e.scrollTop,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,...rect(e)})),
      scrollCalls:(window as any).__scrollCalls};
  });
  const beforeChat=await geometry();
  await page.evaluate(()=>(window as any).__appPanels.longChat());
  await page.evaluate(()=>(window as any).__appPanels.click('#sidebar-tab-chat'));
  await expect.poll(async()=>{const g=await geometry();return g.scrollers.some(s=>s.scrollTop>100&&Math.abs(s.scrollTop+s.clientHeight-s.scrollHeight)<2);},
    {timeout:10000}).toBe(true);
  const afterScroll=await geometry();
  assert.ok(afterScroll.scrollCalls.some((call:any)=>call.options?.behavior==='smooth'),'actual chatBottom.scrollIntoView effect ran');
  await page.evaluate(()=>(window as any).__appPanels.click('#sidebar-tab-task'));
  const returnedTask=await geometry();
  console.log(JSON.stringify({stage:'chat-autoscroll-return-task',beforeChat,afterScroll,returnedTask}));
  for(const [name,r] of Object.entries({training:returnedTask.training,sprint:returnedTask.sprint})) {
    assert.ok(r&&r.height>0&&r.top>=returnedTask.panel.top-1&&r.bottom<=returnedTask.panel.bottom+1,
      name+' stays fully inside task viewport after chat autoscroll');
    for(const ancestor of returnedTask.ancestors)
      assert.ok(r.top>=ancestor.top-1&&r.bottom<=ancestor.bottom+1,name+' is not clipped by '+ancestor.tag+'#'+ancestor.id);
  }
  assert.ok(returnedTask.ancestors.every(a=>a.scrollTop===0),'chat must not scroll task panel or its ancestors');
  await expect(page.locator('#sidebar-tab-task')).toHaveAttribute('aria-selected','true');
  await expect(page.locator('#sidebar-panel-files')).toBeHidden();
  // Negative/control: long markdown still scrolls, without moving fixed actions.
  await page.locator('#sidebar-panel-task').getByText('Task paragraph 99 with instructions.',{exact:true}).evaluate(e=>e.scrollIntoView());
  const afterTaskScroll=await geometry();
  console.log(JSON.stringify({stage:'task-scroll-controls-fixed',afterTaskScroll}));
  assert.ok(afterTaskScroll.scrollers.some(s=>s.scrollTop>100),'long task body remains scrollable');
  assert.deepEqual(afterTaskScroll.training,returnedTask.training,'task scrolling does not move training controls');
  assert.deepEqual(afterTaskScroll.sprint,returnedTask.sprint,'task scrolling does not move sprint actions');
  // End the long-chat geometry fixture before the existing unread-badge scenario.
  await page.evaluate(()=>(window as any).__appPanels.clearChat());
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
  // Real App + settings + FileTree + chat. Only transport/Monaco remain substituted.
  await page.evaluate(()=>(window as any).__appPanels.returnA());
  await assertCurrent('returned A for consent');
  // Reproduce the LIVE ordering: return-A -> files -> consent -> automatic unread -> files -> chat.
  await page.evaluate(()=>(window as any).__appPanels.browserEvents());
  await page.locator('#sidebar-tab-files').click();
  const before=await page.evaluate(()=>(window as any).__appPanels.state());
  const leaf=page.getByRole('button',{name:'Otwórz plik '+before.activePath,exact:true});
  await expect(leaf).toHaveCount(1);
  await leaf.click();
  await page.getByTitle('Ustawienia projektu (AI Consent, Task Mode, Profile)',{exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Ustawienia Projektu i Trenera AI',exact:true});
  await dialog.getByLabel('Zgoda na asystę Trenera AI (aiConsent)',{exact:true}).check();
  await dialog.getByRole('button',{name:'Zapisz Ustawienia',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  const saved=await page.evaluate(()=>(window as any).__appPanels.state());
  assert.equal(saved.aiConsent,true);
  assert.equal(saved.workspaceVersion,before.workspaceVersion+1);
  assert.equal(saved.activePath,before.activePath,'settings preserve the active file');
  assert.deepEqual(saved.files,before.files,'settings preserve file inventory');
  await expect(page.locator('#sidebar-tab-files')).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('tab',{name:'Czat',exact:true})).toHaveCount(1);
  await page.evaluate(()=>(window as any).__appPanels.unread());
  // Negative selector control: unread badge is part of the accessible name, not a lost tab/control.
  await expect(page.getByRole('tab',{name:'Czat',exact:true})).toHaveCount(0);
  console.log('Unread chat accessibility: '+await page.locator('#sidebar-tab-chat').ariaSnapshot());
  await expect(page.locator('#sidebar-tab-chat')).toHaveAccessibleName('CzatNieprzeczytane wiadomości');
  await page.locator('#sidebar-tab-files').click();
  await expect(leaf).toHaveCount(1);
  await leaf.click();
  const chatTab=page.getByRole('tablist',{name:'Panel projektu',exact:true}).locator('#sidebar-tab-chat');
  await expect(chatTab).toHaveCount(1);
  await expect(chatTab).toHaveAttribute('aria-controls','sidebar-panel-chat');
  await chatTab.click();
  await expect(chatTab).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('tab',{name:'Czat',exact:true})).toHaveCount(1);
  const chat=page.locator('#sidebar-panel-chat');
  await chat.getByPlaceholder(/^Napisz do Trenera AI/).fill('Fixture explicit current-task HINT');
  await chat.getByTitle('Wyślij wiadomość',{exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__appPanels.state().messages))
    .toEqual(['Fixture explicit current-task HINT']);
  assert.equal((await page.evaluate(()=>(window as any).__appPanels.state())).activePath,before.activePath);
  console.log(JSON.stringify({stage:'consent-unread-chat',settingsSaved:true,filesPreserved:true,
    exactChatNameWithUnread:0,stableChatTab:1,explicitMessages:1}));
  await page.evaluate(()=>(window as any).__appPanels.close());
  assert.deepEqual(errors,[],'no duplicate-key, reconciliation, or React warnings');
  assert.deepEqual(external,[],'file-only fixture never contacts a server');
});
