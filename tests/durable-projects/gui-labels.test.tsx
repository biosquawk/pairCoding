import assert from 'node:assert/strict';
import {test} from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {setUiLocale,t,problemText,stateText} from '../../src/i18n';
import {SessionPanel} from '../../src/components/BottomPanel';
import {HeaderBar} from '../../src/components/HeaderBar';
import {FolderPicker} from '../../src/components/FolderPicker';
import {RuntimeSettingsV2} from '../../src/components/RuntimeSettingsV2';

// These exercise real owned components, not browser/Monaco/native/backend acceptance.
test('explicit locale translates labels both ways, not historical content; diagnostics retain codes',()=>{
  setUiLocale('pl');assert.equal(t('Otwórz projekt'),'Otwórz projekt');
  setUiLocale('en');assert.equal(t('Otwórz projekt'),'Open project');
  assert.equal(t('Edytor pliku {0}',{0:'Ćwiczenie.java'}),'File editor Ćwiczenie.java');
  assert.equal(stateText('READY'),'Ready (READY)');
  const close=problemText('CLOSE_PROJECT_FIRST: Close the current project before opening another project with the same exercise.');
  assert.match(close,/Close the current project/);assert.match(close,/CLOSE_PROJECT_FIRST/);
  const unknown=problemText('SOME_NEW_CODE: raw details 42');
  assert.match(unknown,/Operation failed/);assert.match(unknown,/SOME_NEW_CODE: raw details 42/);
  setUiLocale('pl');assert.equal(t('Open project'),'Otwórz projekt');
  assert.match(problemText('CLOSE_PROJECT_FIRST: diagnostic'),/Zamknij/);
});

const panel={taskContent:'ZADANIE_ORIGINAL_ENGLISH_user_content',chatEntries:[{id:'m1',sender:'STUDENT' as const,message:'HISTORIA_ORYGINALNA_PL_untranslated',timestamp:1}],activeProposal:null,activeRun:null,report:null,height:260,isMaximized:false,isCollapsed:false,onSelectTab:()=>{},onSendMessage:()=>true,onProposalResponse:()=>{},onRetryReport:()=>{},onToggleCollapse:()=>{},onToggleMaximize:()=>{}};
test('same panel owns left chat/composer and task; bottom exposes only console/report',()=>{
  setUiLocale('en');
  const chat=renderToStaticMarkup(<SessionPanel {...panel} sidebar activeTab="chat"/>);
  assert.match(chat,/HISTORIA_ORYGINALNA_PL_untranslated/);assert.match(chat,/Message the AI Coach/);
  assert.equal((chat.match(/<textarea/g)??[]).length,1);
  const task=renderToStaticMarkup(<SessionPanel {...panel} sidebar activeTab="task"/>);
  assert.match(task,/ZADANIE_ORIGINAL_ENGLISH_user_content/);assert.doesNotMatch(task,/<textarea/);
  const bottom=renderToStaticMarkup(<SessionPanel {...panel} activeTab="console"/>);
  assert.match(bottom,/Console/);assert.match(bottom,/Report/);
  assert.doesNotMatch(bottom,/<textarea|HISTORIA_ORYGINALNA|ZADANIE_ORIGINAL/);
  assert.doesNotMatch(bottom,/>Chat<|>Exercise</);
  setUiLocale('pl');
});

test('picker exposes localized actionable transition failure within the dialog',()=>{
  setUiLocale('en');
  const html=renderToStaticMarkup(<FolderPicker mode="project" list={async()=>({path:'/fixture',parent:null,directories:[]})} open={async()=>false} blocked={null} actionError="CLOSE_PROJECT_FIRST: diagnostic" onClose={()=>{}}/>);
  assert.match(html,/Choose project file/);assert.match(html,/role="alert"/);assert.match(html,/Close the current project/);
  setUiLocale('pl');
});

test('runtime settings empty and failure surfaces follow explicit locale',()=>{
  setUiLocale('en');
  const html=renderToStaticMarkup(<RuntimeSettingsV2 open settings={null} expectedWorkspaceVersion={1} execution={null} connected={false} canSave={false} onSave={async()=>({ok:false,message:'not used'})} onClose={()=>{}}/>);
  assert.match(html,/Execution settings V2/);assert.match(html,/Old or unknown settings are unchanged/);assert.match(html,/Cancel — without saving/);
  setUiLocale('pl');
});


test('empty console instructions name the actual toolbar buttons in PL and EN; raw logs stay unchanged',()=>{
  const header={writeOwner:'STUDENT',coachMode:'UNAVAILABLE',aiStatus:'OFF',sessionStatus:'STOPPED',elapsedMs:0,limitMs:0,pauseOnHidden:false,taskMode:'IMPLEMENTATION',capabilities:{canRunMain:true,canRunTests:true},executionStatus:'IDLE',isDevSimulatorOpen:false} as React.ComponentProps<typeof HeaderBar>;
  try {
    for(const locale of ['pl','en','pl'] as const){
      setUiLocale(locale);
      const toolbar=renderToStaticMarkup(<HeaderBar {...header} locale={locale}/>);
      const empty=renderToStaticMarkup(<SessionPanel {...panel} activeTab="console"/>);
      const labels=locale==='pl'?['Uruchom','Uruchom testy']:['Run Main','Run Tests'];
      for(const label of labels){
        assert.ok(toolbar.includes('>'+label+'</span>'),'actual toolbar label: '+label);
        assert.ok(empty.includes('&quot;'+label+'&quot;'),'console instruction must name: '+label);
      }
      if(locale==='pl')assert.doesNotMatch(empty,/Run Main|Run Tests/);
      const raw='RAW_OUTPUT Run Main Uruchom NIE_TLUMACZ';
      const activeRun={logs:[{id:'raw',type:'STDOUT',text:raw}]} as NonNullable<React.ComponentProps<typeof SessionPanel>['activeRun']>;
      const output=renderToStaticMarkup(<SessionPanel {...panel} activeTab="console" activeRun={activeRun}/>);
      assert.ok(output.includes(raw));
      assert.doesNotMatch(output,/Brak danych wyjściowych konsoli|No console output/);
    }
  }finally{setUiLocale('pl');}
});
