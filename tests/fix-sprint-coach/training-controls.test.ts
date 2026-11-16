import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {transformSync} from 'esbuild';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TrainingControls} from '../../src/components/TrainingControls';
import {emptyLiveState} from '../../src/services/liveMapper';
import type {ClientState} from '../../src/services/liveTypes';
import type {PairCoachClient} from '../../src/services/PairCoachClient';
function markup(extra:Partial<ClientState>={},showDetails=true){
  const state={...emptyLiveState(),isOffline:false,writeOwner:'STUDENT',sessionStatus:'RUNNING',aiStatus:'READY',coachMode:'ACTIVE_WATCHING',...extra} as ClientState;
  state.projectSettings={...state.projectSettings,aiConsent:extra.projectSettings?.aiConsent??true};
  const forbidden=()=>{throw Error('Rendering must never resume, start, or grant consent');};
  return renderToStaticMarkup(createElement(TrainingControls,{state,showDetails,client:{resumeTimer:forbidden,startTimer:forbidden} as unknown as PairCoachClient,onSettings:forbidden}));
}
test('paused task offers a real explicit resume control, separate READY provider explanation; rendering never resumes',()=>{
  const html=markup({sessionStatus:'PAUSED',coachMode:'MUTED_MANUAL'});
  assert.match(html,/Trening i trener/);assert.match(html,/Wznów trening/);assert.match(html,/nie analizuje ani nie odpowiada podczas pauzy/);
  assert.match(html,/gotowy \(READY\), nie oznacza trwającej analizy/);assert.doesNotMatch(html,/Trener aktywny/);
  assert.match(markup({sessionStatus:'STOPPED',coachMode:'UNAVAILABLE'}),/Rozpocznij trening/);
  assert.match(markup({sessionStatus:'PAUSED',isOffline:true}),/disabled=""/);
});
test('coach status distinguishes real THINKING, active observation, manual mute, veto, no consent and failure',()=>{
  assert.match(markup({aiStatus:'THINKING'}),/Trener analizuje… \(THINKING\)/);
  assert.match(markup(),/Trener aktywny/);assert.doesNotMatch(markup(),/Wznów trening/);
  assert.match(markup({coachMode:'MUTED_MANUAL'}),/nie wyłącza wyciszenia/);
  assert.match(markup({coachMode:'COOLDOWN_AFTER_VETO'}),/po wecie/);
  assert.match(markup({aiStatus:'FAILED',coachMode:'UNAVAILABLE'}),/awaria dostawcy AI/);
  assert.match(markup({aiStatus:'OFF',coachMode:'UNAVAILABLE'}),/wyłączony lub niedostępny/);
  const without=markup({projectSettings:{...emptyLiveState().projectSettings,aiConsent:false}});
  assert.match(without,/brak zgody AI/);assert.match(without,/Ustawienia zgody AI/);assert.doesNotMatch(without,/Trener aktywny/);
});

// HUMAN46be3113: Task retains actions/errors, while policy/provider details belong to Chat.
test('task omits coach/provider details and empty wrapper; chat retains both',()=>{
  const app=readFileSync('src/App.tsx','utf8');
  assert.match(app,/<TrainingControls[^>]*showDetails=\{sidebarTab==='chat'\}/);
  assert.equal(markup({},false),'','no padded/bordered empty section in Task');
  assert.match(markup({},true),/Trener aktywny/);
  assert.match(markup({},true),/gotowy \(READY\), nie oznacza trwającej analizy/);
  assert.equal(markup({coachMode:'MUTED_MANUAL'},false),'','policy detail stays in Chat');
  assert.equal(markup({aiStatus:'THINKING'},false),'','analysis detail stays in Chat');
});
test('task retains explicit resume/start, consent, offline/provider errors and run admission status',()=>{
  const paused=markup({sessionStatus:'PAUSED'},false);
  assert.match(paused,/Wznów trening/);assert.match(paused,/Trening wstrzymany/);
  assert.doesNotMatch(paused,/Dostawca AI:|Trener aktywny/);
  assert.match(markup({sessionStatus:'STOPPED'},false),/Rozpocznij trening/);
  assert.match(markup({sessionStatus:'PAUSED',isOffline:true},false),/disabled=""/);
  assert.match(markup({isOffline:true},false),/Brak połączenia/);
  assert.match(markup({aiStatus:'FAILED'},false),/awaria dostawcy AI/);
  const without=markup({projectSettings:{...emptyLiveState().projectSettings,aiConsent:false}},false);
  assert.match(without,/brak zgody AI/);assert.match(without,/Ustawienia zgody AI/);
  assert.match(markup({runtime:{pending:'RUN'} as ClientState['runtime']},false),/Run\/Test: przygotowanie/);
});
test('sidebar drag and window resize share the CSS viewport cap and leave room for the editor',()=>{
  const app=readFileSync('src/App.tsx','utf8');
  const constant=app.match(/const SIDEBAR_MAX_VIEWPORT_PERCENT = \d+;/)?.[0];
  assert.ok(constant,'one viewport percentage for JS and CSS');
  assert.ok(app.includes('SIDEBAR_MAX_VIEWPORT_PERCENT}vw)'),'CSS uses the same cap');
  const start=app.indexOf('  // Resizable Splitter mouse handlers');
  const effect=app.slice(start,app.indexOf('  // Tab management',start));
  const listeners=new Map<string,Function>();
  let width=340,cleanup:Function|undefined;
  const horizontal={current:true},vertical={current:false};
  const win={innerWidth:1280,addEventListener:(name:string,fn:Function)=>listeners.set(name,fn),
    removeEventListener:(name:string,fn:Function)=>{assert.equal(listeners.get(name),fn);listeners.delete(name);}};
  runInNewContext(transformSync(constant+'\n'+effect,{loader:'ts',target:'es2022'}).code,{useEffect:(fn:()=>Function)=>{cleanup=fn();},window:win,
    document:{body:{style:{}}},isDraggingHorizontalRef:horizontal,isDraggingVerticalRef:vertical,
    setFileTreeWidth:(next:number|((previous:number)=>number))=>{width=typeof next==='function'?next(width):next;},
    setBottomPanelHeight:()=>{throw Error('horizontal drag must not resize console');}});
  const drag=(x:number)=>listeners.get('mousemove')!({clientX:x});
  drag(700);assert.equal(width,700,'can exceed 50% of a 1280px window');
  drag(2000);assert.equal(width,896,'70% maximum leaves 30% for editor/splitter');
  drag(10);assert.equal(width,160,'minimum usable sidebar width');
  drag(800);win.innerWidth=800;listeners.get('resize')!();assert.equal(width,560);
  drag(700);assert.equal(width,560,'drag after resize uses current viewport');
  win.innerWidth=1600;listeners.get('resize')!();assert.equal(width,560,'enlarging does not force expansion');
  drag(900);assert.equal(width,900,'larger viewport is not stuck at prior cap');
  listeners.get('mouseup')!();drag(100);assert.equal(width,900,'mouseup ends resizing');
  cleanup!();assert.equal(listeners.size,0,'all resize/mouse listeners cleaned up');
});
