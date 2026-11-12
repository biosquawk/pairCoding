import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {RuntimeStatusV2} from '../../src/components/RuntimeStatusV2';
import {execution,run} from '../client-v2/fixtures';
import type {ServicePreparationState} from '../../src/services/ServicePreparationV2';
const state=(patch:Partial<ServicePreparationState>={}):ServicePreparationState=>({pending:false,blocked:false,uncertain:false,canPrepare:true,canReconcile:false,message:null,...patch});
const html=(s:ServicePreparationState,patch:Record<string,unknown>={})=>renderToStaticMarkup(<RuntimeStatusV2 execution={execution()} language={null} run={null} connected canExecute preparation={s} onPrepare={()=>{}} onRun={()=>{}} onStop={()=>{}} onSettings={()=>{}} {...patch}/>);
test('real neutral control is labeled, described and explicitly separates per-mode readiness',()=>{
  const markup=html(state());assert.match(markup,/Przygotuj środowisko/);assert.match(markup,/aria-describedby="[^\"]+-prepare"/);
  assert.match(markup,/Nie uruchamia programu ani testów/);assert.match(markup,/disabled=""[^>]*>Uruchom program/);assert.doesNotMatch(markup,/disabled=""[^>]*>Uruchom testy/);
  assert.doesNotMatch(markup,/Java|Spring|Docker|installationId/);
});
test('UNKNOWN explicitly completes original, never falsely labels read-only recovery; manual editor not gated here',()=>{
  const markup=html(state({uncertain:true,blocked:true,canPrepare:false,canReconcile:true,message:'Oryginał może być wykonany po raz pierwszy.'}));
  assert.match(markup,/>Dokończ przygotowanie</);assert.match(markup,/Oryginał może być wykonany po raz pierwszy/);
  assert.doesNotMatch(markup,/Sprawdź status|read.only|Sprawdź wynik przygotowania/);
  assert.match(markup,/disabled=""[^>]*>Uruchom testy/);
});
test('offline/loading/permission/singleflight/active-run block prepare with accessible status',()=>{
  for(const [s,props] of [[state(),{connected:false}],[state({canPrepare:false}),{execution:null}],[state({canPrepare:false}),{}],[state({pending:true,blocked:true,canPrepare:false}),{}],[state(),{run:run()}]] as const){
    const markup=html(s,props);assert.match(markup,/disabled=""[^>]*aria-describedby="[^\"]+-prepare"/);assert.match(markup,/role="status" aria-live="polite"/);
  }
});
