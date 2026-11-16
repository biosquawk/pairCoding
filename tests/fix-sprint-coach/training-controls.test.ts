import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TrainingControls} from '../../src/components/TrainingControls';
import {emptyLiveState} from '../../src/services/liveMapper';
import type {ClientState} from '../../src/services/liveTypes';
import type {PairCoachClient} from '../../src/services/PairCoachClient';
function markup(extra:Partial<ClientState>={}){
  const state={...emptyLiveState(),isOffline:false,writeOwner:'STUDENT',sessionStatus:'RUNNING',aiStatus:'READY',coachMode:'ACTIVE_WATCHING',...extra} as ClientState;
  state.projectSettings={...state.projectSettings,aiConsent:extra.projectSettings?.aiConsent??true};
  const forbidden=()=>{throw Error('Rendering must never resume, start, or grant consent');};
  return renderToStaticMarkup(createElement(TrainingControls,{state,client:{resumeTimer:forbidden,startTimer:forbidden} as unknown as PairCoachClient,onSettings:forbidden}));
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
