import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {RuntimeStatusV2} from '../../src/components/RuntimeStatusV2';
import {execution} from '../client-v2/fixtures';
test('UNKNOWN/pending never displays READY from unrelated snapshot before explicit completion and fresh GET',()=>{
  for(const pending of [true,false]){
    const markup=renderToStaticMarkup(<RuntimeStatusV2 execution={execution()} language={null} run={null} connected canExecute onPrepare={()=>{}} onRun={()=>{}} onStop={()=>{}} onSettings={()=>{}} preparation={{pending,blocked:true,uncertain:!pending,canPrepare:false,canReconcile:!pending,message:null}}/>);
    assert.doesNotMatch(markup,/Środowisko: READY/);assert.match(markup,/Przygotowanie niepotwierdzone/);
  }
});
