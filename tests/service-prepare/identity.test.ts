import test from 'node:test';
import assert from 'node:assert/strict';
import {PairCoachClient} from '../../src/services/PairCoachClient';
import {MemoryStorage,storageKey} from './fixture';

test('own tab keeps clientId across reload, another tab never adopts global original clientId',()=>{
  const original=(globalThis as any).window,local=new MemoryStorage(),tab1=new MemoryStorage(),tab2=new MemoryStorage();
  const create=(sessionStorage:MemoryStorage)=>{
    (globalThis as any).window={location:{hash:'',protocol:'http:',hostname:'127.0.0.1',port:'8080',origin:'http://127.0.0.1:8080',search:'?mock=1'},localStorage:local,sessionStorage};
    const client=new PairCoachClient({mode:'MOCK_SIMULATOR'});return {client,id:(client as any).live.clientId};
  };
  try {
    const first=create(tab1);const again=create(tab1);assert.equal(first.id,again.id);
    local.setItem(storageKey,JSON.stringify({version:1,clientId:first.id,entries:[{projectId:'p1',phase:'UNKNOWN',receipt:null,request:{requestId:'original',clientId:first.id,sessionId:'s1',expectedWorkspaceVersion:1,configurationGeneration:'cfg1',controlEpoch:0}}]}));
    const other=create(tab2);assert.notEqual(other.id,first.id);
    assert.match((other.client as any).live.servicePreparation.snapshot().message,/innego klienta/);
    assert.equal((other.client as any).live.servicePreparation.snapshot().canPrepare,false);
    assert.equal(JSON.parse(local.getItem(storageKey)!).clientId,first.id);
    first.client.close();again.client.close();other.client.close();
  } finally {(globalThis as any).window=original;}
});
test('tab identity storage refusal never borrows localStorage clientId or permits prepare',()=>{
  const original=(globalThis as any).window,tab=new MemoryStorage();tab.failSet=true;
  try {
    (globalThis as any).window={location:{hash:'',protocol:'http:',hostname:'127.0.0.1',port:'8080',origin:'http://127.0.0.1:8080',search:'?mock=1'},localStorage:new MemoryStorage(),sessionStorage:tab};
    const client=new PairCoachClient({mode:'MOCK_SIMULATOR'});
    assert.match((client as any).live.servicePreparation.snapshot().message,/tożsamości karty/);assert.equal((client as any).live.servicePreparation.snapshot().canPrepare,false);client.close();
  } finally {(globalThis as any).window=original;}
});
