import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {HeaderBar} from '../../src/components/HeaderBar';
import {setUiLocale} from '../../src/i18n';
import {emptyLiveState} from '../../src/services/liveMapper';

const noop=()=>{};
const props:React.ComponentProps<typeof HeaderBar>={
  ...emptyLiveState(), elapsedMs:0, limitMs:60000, pauseOnHidden:false,
  writeOwner:'STUDENT', coachMode:'ACTIVE_WATCHING', aiStatus:'READY',
  sessionStatus:'RUNNING', taskMode:'IMPLEMENTATION', executionStatus:'IDLE',
  isDevSimulatorOpen:false, onEmergencyVeto:noop, onStartTimer:noop,
  onPauseTimer:noop, onResumeTimer:noop, onTogglePauseOnHidden:noop,
  onRunMain:noop, onRunTests:noop, onStopExecution:noop,
  onOpenFinishModal:noop, onToggleDevSimulator:noop,
};

for (const locale of ['pl','en'] as const) {
  test(`compact header labels retain descriptive veto and state tooltips (${locale})`,()=>{
    setUiLocale(locale);
    try {
      const html=renderToStaticMarkup(<HeaderBar {...props} locale={locale}/>);
      const visible=html.replace(/<[^>]*>/g,'');
      const logo=html.match(/<svg[^>]*aria-label="PC"[^>]*>[\s\S]*?<\/svg>/)?.[0];
      assert.ok(logo,'PC is an accessible inline vector monogram');
      assert.match(logo,/role="img"/);
      assert.match(logo,/width="26" height="26" viewBox="0 0 26 26"/);
      assert.match(logo,/bg-zinc-800 border border-zinc-700 text-zinc-300/);
      assert.match(logo,/stroke="currentColor"/);
      assert.equal((logo.match(/<path /g)??[]).length,2,'P and C are drawn paths');
      assert.doesNotMatch(logo,/gradient|<text/);
      assert.doesNotMatch(visible,/\bPC\b/,'logo is not text on a background');
      assert.match(visible,locale==='pl'?/Ty/:/You/);
      assert.doesNotMatch(visible,/Piszesz Ty|You are writing/);
      assert.match(visible,/AI: READY/);
      assert.doesNotMatch(visible,/Gotowy \(READY\)|Ready \(READY\)/);
      assert.match(visible,locale==='pl'?/Implementacja/:/Implementation/);
      assert.doesNotMatch(visible,/IMPLEMENTATION/);
      assert.match(html,locale==='pl'?/title="Tryb zadania: Implementacja \(IMPLEMENTATION\)"/:/title="Exercise mode: Implementation \(IMPLEMENTATION\)"/);
      const veto=html.match(/<button[^>]*aria-label="(?:Przerwij trenerowi|Interrupt coach)"[^>]*>[\s\S]*?<\/button>/)?.[0];
      assert.ok(veto,'veto has a full accessible name');
      assert.match(veto,/title="[^"]*2× Escape[^"]*"/);
      assert.match(veto,/<span>\?<\/span>/);
      assert.doesNotMatch(veto,/disabled=/);
      assert.match(visible,locale==='pl'?/Uruchom testy/:/Run Tests/);
      assert.match(visible,locale==='pl'?/Zakończ/:/Finish/);
    } finally { setUiLocale('pl'); }
  });
}
