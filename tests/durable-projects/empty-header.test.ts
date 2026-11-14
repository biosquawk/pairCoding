import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement, type ComponentProps} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {HeaderBar} from '../../src/components/HeaderBar';
import {setUiLocale} from '../../src/i18n';
const base={writeOwner:'SYNCING',coachMode:'UNAVAILABLE',aiStatus:'OFF',sessionStatus:'STOPPED',elapsedMs:0,limitMs:0,pauseOnHidden:false,taskMode:'IMPLEMENTATION',capabilities:{},executionStatus:'IDLE',isDevSimulatorOpen:false} as ComponentProps<typeof HeaderBar>;
function render(emptyWorkspaceLabel?:string,writeOwner=base.writeOwner){return renderToStaticMarkup(createElement(HeaderBar,{...base,emptyWorkspaceLabel,writeOwner}));}
// HUMAN a036ae40: EMPTY is expected, not a claim of write ownership or an unconfirmed source save.
test('empty project/exercise header is neutral in PL and EN; active exercise retains real ownership warnings',()=>{
 try {
  for(const locale of ['pl','en'] as const){
   setUiLocale(locale);
   for(const label of ['Brak otwartego projektu','Brak otwartego ćwiczenia']){
    const html=render(label);
    assert.match(html,locale==='pl'?new RegExp(label):/No (?:project|exercise) is open/);
    assert.doesNotMatch(html,/Synchronizacja|Zapis niepotwierdzony|Synchronization|Save unconfirmed|Piszesz Ty|You are writing/);
   }
  }
  setUiLocale('pl');
  assert.match(render(),/Synchronizacja \/ Zapis niepotwierdzony/);
  assert.match(render(undefined,'STUDENT'),/Piszesz Ty/);
  assert.match(render(undefined,'COACH'),/Pisze trener/);
 }finally{setUiLocale('pl');}
});
