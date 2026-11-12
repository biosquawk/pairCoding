/** Trusted argv selection only; no receipt validation/readiness or Docker proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { parseRuntimeStartupArguments, RuntimeStartupArgumentError } from '../../src/server/runtime-coordinator/RuntimeStartup';

test('language receipt is explicit immutable optional startup selection, coexists with maximum existing selectors',()=>{
  assert.equal(parseRuntimeStartupArguments([]).languageReceiptPath,undefined);
  const receipt=path.join(os.tmpdir(),'not-discovered','receipt.json');
  const roots=Array.from({length:16},(_,i)=>path.join(os.tmpdir(),'selected-language-'+i));
  const args=['--runtime-config',path.join(os.tmpdir(),'config.json'),...roots.flatMap(p=>['--prepared-runtime',p]),'--language-receipt',receipt];
  const parsed=parseRuntimeStartupArguments(args);args[args.length-1]=path.join(os.tmpdir(),'replacement');
  assert.equal(parsed.languageReceiptPath,receipt);assert.deepEqual(parsed.preparedRuntimeRoots,roots);
  assert.ok(Object.isFrozen(parsed));assert.ok(Object.isFrozen(parsed.preparedRuntimeRoots));
});
test('language selector rejects missing/duplicate/relative/control/overlong values and unknown discovery forms',()=>{
  const absolute=path.join(os.tmpdir(),'private.json');
  for(const args of [ ['--language-receipt'],['--language-receipt',''],['--language-receipt','relative.json'],
    ['--language-receipt',absolute,'--language-receipt',absolute],['--language-receipt',absolute+'\nsecret'],
    ['--language-receipt',absolute+'\x7fsecret'],['--language-receipt',path.join(os.tmpdir(),'s'.repeat(1025))],
    ['--language-receipt='+absolute],['--language-receipts',absolute],
  ]) assert.throws(()=>parseRuntimeStartupArguments(args),e=>e instanceof RuntimeStartupArgumentError&&!e.message.includes('secret'));
});

import fs from 'node:fs';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {createPairCoachServer} from '../../src/server/http';
import {validateV2WireShape} from '../../src/shared/validation-v2';

for(const selected of [false,true])test('actual HTTP invalid-config manual editor survives '+(selected?'explicit absent receipt':'omitted receipt')+' without readiness/bootstrap invention',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'language-selector-http-')),project=path.join(root,'project');
  fs.mkdirSync(project);fs.writeFileSync(path.join(project,'source.js'),'ORIGINAL\n');
  const config=path.join(root,'absent-runtime.json'),receipt=path.join(root,'absent-language-receipt.json');
  const argv=['--runtime-config',config,...selected?['--language-receipt',receipt]:[]];
  const token='unit-selector-token';let dockerCalls=0;
  const app=createPairCoachServer({port:0,rootPath:project,token,runtimeEnvironment:{},runtimeArguments:argv,
    runtimeTransport:{async run(){dockerCalls++;throw Error('No Docker expected for invalid configuration');}}});
  let ws:WebSocket|undefined;
  t.after(async()=>{ws?.terminate();await app.close();fs.rmSync(root,{recursive:true,force:true});});
  const port=await app.listen(),sessionId=app.session.state.sessionId;
  ws=new WebSocket(`ws://127.0.0.1:${port}/ws/session`);
  const frames:any[]=[],listeners=new Set<()=>void>();
  ws.on('message',data=>{frames.push(JSON.parse(data.toString()));for(const check of listeners)check();});
  const wait=(predicate:(value:any)=>boolean)=>new Promise<any>((resolve,reject)=>{
    const timer=setTimeout(()=>{listeners.delete(check);reject(Error('Expected selector HTTP frame not received'));},3000);
    const check=()=>{const found=frames.find(predicate);if(found){clearTimeout(timer);listeners.delete(check);resolve(found);}};
    listeners.add(check);check();
  });
  const send=(type:string,payload:unknown)=>{const messageId=randomUUID();ws!.send(JSON.stringify({protocolVersion:'3.0',messageId,sessionId,clientId:'tab',type,payload}));return messageId;};
  await once(ws,'open');send('HELLO',{token,lastServerSeq:0});
  const snapshot=await wait(m=>m.type==='SESSION_SNAPSHOT');assert.ok(validateV2WireShape('ServerMessage',snapshot));
  assert.equal(snapshot.payload.languageBootstrap,null);assert.equal(snapshot.payload.project.capabilities.language.state,'OFF');
  const id=send('CODE_CHANGED',{path:'source.js',baseVersion:1,controlEpoch:app.session.state.controlEpoch,content:'MANUAL\n',editKind:'TYPING'});
  const ack=await wait(m=>m.type==='ACK'&&m.payload.replyTo===id);
  assert.equal(ack.payload.status,'OK');assert.equal(ack.payload.documentVersion,2);
  assert.equal(fs.readFileSync(path.join(project,'source.js'),'utf8'),'MANUAL\n');
  assert.equal(dockerCalls,0);assert.equal(fs.existsSync(receipt),false);
  assert.equal(fs.existsSync(config),false);assert.equal(frames.some(m=>m.type==='LANGUAGE_STATUS'&&m.payload.state==='ON'),false);
});
