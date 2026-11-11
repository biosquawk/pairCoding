/** Actual App + local Monaco + LiveBackend in Chromium. Authenticated HTTP/WS controlled doubles;
 * NOT real backend/container/LSP/AI/native integration. Reuses existing browser/libs, no installs. */
import {chromium,type Page} from '@playwright/test';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {bundle,doc} from './fixtures';
const output=process.env.RUNTIME_PROOF_DIR!;if(!output||!process.env.RUNTIME_BROWSER||!process.env.RUNTIME_REVISION)throw new Error('Proof env required');
await mkdir(output,{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:'.tmp/vite-cutover',plugins:[react(),tailwind()],server:{host:'127.0.0.1',port:0},logLevel:'warn'});
let page:Page|undefined;
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;const errors:string[]=[],requests:any[]=[];
try {
  await server.listen();const address=server.httpServer!.address();assert.ok(address&&typeof address==='object');
  browser=await chromium.launch({headless:true,executablePath:process.env.RUNTIME_BROWSER,timeout:15000});
  page=await browser.newPage({viewport:{width:1365,height:900}});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  const b={...bundle(),languageBootstrap:{connectionGeneration:'browser-server-connection',shadowGeneration:'browser-server-shadow',provider:'remote' as const}};
  let reconciliationReads=0;
  await page.addInitScript('globalThis.__name = (fn) => fn;');
  await page.addInitScript(data=>{
    let seq=0;const snapshot=data;(window as any).cutoverWire=[];
    const sendToClient=(socket:any,type:string,payload:unknown)=>{const messageId=`server${++seq}`;socket.onmessage?.({data:JSON.stringify({protocolVersion:'3.0',messageId,sessionId:'s1',seq,type,payload})});return messageId;};
    class Socket {
      readyState=0;onopen:any;onmessage:any;onerror:any;onclose:any;
      constructor(){queueMicrotask(()=>{this.readyState=1;this.onopen?.({});});}
      send(raw:string){const m=JSON.parse(raw);(window as any).cutoverWire.push(m);if(m.type==='HELLO')queueMicrotask(()=>sendToClient(this,'SESSION_SNAPSHOT',snapshot));
        if(m.type==='LANGUAGE_COMPLETE')queueMicrotask(()=>sendToClient(this,'COMPLETE_RESULT',{requestId:m.payload.requestId,stamp:m.payload.stamp,items:[],isIncomplete:false}));
        if(m.type==='CODE_CHANGED') {snapshot.project.workspaceVersion++;snapshot.session.workspaceVersion++;snapshot.activeDocument!.content=m.payload.content;snapshot.activeDocument!.version++;snapshot.project.files[0].version=snapshot.activeDocument!.version;
          queueMicrotask(()=>{const receiptId=sendToClient(this,'ACK',{replyTo:m.messageId,status:'OK',documentVersion:snapshot.activeDocument!.version,workspaceVersion:snapshot.project.workspaceVersion,controlEpoch:0,error:null});
            const source=(window as any).cutoverWire.find((s:any)=>s.messageId===m.payload.languageDocumentMessageId);
            if(source){const result={sourceStamp:source.payload.stamp,presentationStamp:{...source.payload.stamp,baseDocumentVersion:snapshot.activeDocument!.version,documentVersion:snapshot.activeDocument!.version},association:{saveReceiptId:'forged'},provenance:{kind:'IMMUTABLE_GENERATION',launchId:'controlled-generation',lspVersion:null,inputManifestSha256:source.payload.stamp.contentSha256},items:[{range:{startLine:1,startColumn:1,endLine:1,endColumn:2},severity:'WARNING',message:'FORGED MUST NOT RENDER',code:null}],truncated:false};
              sendToClient(this,'DIAGNOSTICS',result);result.association.saveReceiptId=receiptId;result.items[0].message='Verified controlled ACK input';sendToClient(this,'DIAGNOSTICS',result);}
          });}
        if(m.type==='VIEW_CHANGED')queueMicrotask(()=>sendToClient(this,'ACK',{replyTo:m.messageId,status:'OK',documentVersion:m.payload.documentVersion,workspaceVersion:snapshot.project.workspaceVersion,controlEpoch:0,error:null}));
      }
      close(){this.readyState=3;this.onclose?.({});}
    }
    (window as any).WebSocket=Socket;
  },b);
  await page.route('**/dev/bootstrap',r=>r.fulfill({json:{token:'browser-double'}}));
  await page.route('**/api/**',async r=>{
    const request=r.request(),url=new URL(request.url()),body=request.postDataJSON();requests.push({method:request.method(),path:url.pathname,body});
    if(url.pathname==='/api/project')return r.fulfill({json:b.project});
    if(url.pathname==='/api/session')return r.fulfill({json:b.session});
    if(url.pathname==='/api/snapshots')return r.fulfill({json:[]});
    if(url.pathname==='/api/file')return r.fulfill({json:doc(url.searchParams.get('path')??'main.txt')});
    if(url.pathname==='/api/project/settings')return r.fulfill({status:409,json:{code:'VERSION_CONFLICT',message:'Zachowaj formularz.'}});
    if(url.pathname==='/api/runtime/mutation/reconcile'){reconciliationReads++;return r.fulfill({json:reconciliationReads===1 ? {mutation:body.mutation,state:'UNKNOWN',result:null,current:null} : {mutation:body.mutation,state:'DEFINITIVELY_ABORTED',result:null,current:{project:b.project,run:null}}});}
    if(url.pathname==='/api/run')return r.abort('connectionfailed');
    return r.fulfill({status:404,json:{code:'NOT_IMPLEMENTED_DOUBLE',message:'Not part of browser proof'}});
  });
  const html='<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head><body><div id="root"></div><script type="module" src="/tests/frontend-cutover/browser-entry.tsx"></script></body></html>';
  const transformed=await server.transformIndexHtml('/fe-cutover',html);
  await page.route('**/fe-cutover',r=>r.fulfill({contentType:'text/html',body:transformed}));
  await page.goto(`http://127.0.0.1:${address.port}/fe-cutover`);
  await page.getByText('Połączono z backendem.',{exact:true}).waitFor();await page.locator('.monaco-editor textarea').first().waitFor();
  assert.match(await page.getByRole('button',{name:'Profil i ustawienia wykonania'}).innerText(),/AutoComp ON/);
  await page.getByRole('button',{name:'Profil i ustawienia wykonania'}).click();const dialog=page.getByRole('dialog');await dialog.waitFor();
  await dialog.getByLabel('Ścieżki testów').fill('../escape.txt');await dialog.getByRole('button',{name:'Zapisz ustawienia',exact:true}).click();await dialog.getByRole('alert').waitFor();assert.equal(requests.filter(r=>r.path==='/api/project/settings').length,0);
  await dialog.getByLabel('Ścieżki testów').fill('tests/keep.txt');await dialog.getByRole('button',{name:'Zapisz ustawienia',exact:true}).click();await page.getByText('VERSION_CONFLICT: Zachowaj formularz.',{exact:false}).waitFor();
  assert.equal(await dialog.getByLabel('Ścieżki testów').inputValue(),'tests/keep.txt');await page.screenshot({path:path.join(output,'desktop-save-unknown-1365x900.png')});
  await dialog.getByRole('button',{name:'Anuluj — bez zapisu'}).focus();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('[role="dialog"]')),true);
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  // Conservative unknown-save fence blocks Run too, even after a new authenticated snapshot.
  assert.equal(await page.getByRole('button',{name:'Run Tests',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Połącz ponownie',exact:true}).click();await page.getByText('Połączono z backendem.',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Run Tests',exact:true}).isDisabled(),true);
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Profil i ustawienia wykonania'}).click();await dialog.waitFor();assert.equal(await dialog.getByRole('button',{name:'Zapisz ustawienia',exact:true}).isDisabled(),true);
  const rect=await dialog.boundingBox();assert.ok(rect&&rect.x>=0&&rect.x+rect.width<=390&&rect.y>=0&&rect.y+rect.height<=844);assert.equal(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth),true);
  await dialog.getByLabel('Ścieżki testów').fill('draft/mobile.txt');await page.screenshot({path:path.join(output,'mobile-fence-draft-390x844.png')});await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  const check=page.getByRole('button',{name:'Sprawdź wynik operacji',exact:true});await check.click();
  await page.getByText('Odczyt nie rozstrzygnął dokładnego żądania w aktualnej sesji. Blokada zachowana.',{exact:false}).first().waitFor();
  assert.equal(await page.getByRole('button',{name:'Run Tests',exact:true}).isDisabled(),true);await check.click();
  await page.getByRole('alert').filter({hasText:'Wynik Run lub zapisu jest nieznany.'}).waitFor({state:'detached'});
  assert.equal(await page.getByRole('button',{name:'Run Tests',exact:true}).isEnabled(),true);
  assert.equal(reconciliationReads,2);assert.ok(requests.filter(r=>r.path==='/api/runtime/mutation/reconcile').every(r=>r.body.mutation.request.settings.runProfiles[0].task.tests.paths[0]==='tests/keep.txt'));
  await page.locator('.monaco-editor .view-lines').first().click({position:{x:60,y:10}});await page.keyboard.press('Control+End');await page.keyboard.type(' manual');
  await page.waitForFunction(()=>(window as any).cutoverWire.some((m:any)=>m.type==='CODE_CHANGED'&&m.payload.content.endsWith(' manual')));
  await page.getByText('Zapis oczekuje na ACK.',{exact:true}).waitFor({state:'detached'});
  await page.waitForFunction(()=>(window as any).cutoverInspect().markers.some((m:any)=>m.message==='Verified controlled ACK input'));
  assert.equal(await page.evaluate(()=>(window as any).cutoverInspect().markers.some((m:any)=>m.message==='FORGED MUST NOT RENDER')),false);
  const wire=await page.evaluate(()=>(window as any).cutoverWire);const save=wire.find((m:any)=>m.type==='CODE_CHANGED');assert.ok(save.payload.languageDocumentMessageId);assert.ok(wire.some((m:any)=>m.messageId===save.payload.languageDocumentMessageId&&m.payload.stamp.localModelVersion>1));
  await page.screenshot({path:path.join(output,'mobile-verified-ack-marker-390x844.png')});
  await page.keyboard.press('Control+z');
  await page.waitForFunction(()=>(window as any).cutoverWire.filter((m:any)=>m.type==='CODE_CHANGED').length>=2 && (window as any).cutoverWire.filter((m:any)=>m.type==='CODE_CHANGED').at(-1).payload.content==='draft');
  await page.getByText('Zapis oczekuje na ACK.',{exact:true}).waitFor({state:'detached'});assert.equal(requests.some(r=>r.path==='/api/run'),false);
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'proof.json'),JSON.stringify({status:'PASS_BOOTSTRAP_ACK_RECONCILE_APP_MONACO_CONTROLLED_TRANSPORT_ONLY',revision:process.env.RUNTIME_REVISION,utc:new Date().toISOString(),browser:browser.version(),viewports:['1365x900','390x844'],requests,reconciliationReads,inspection:await page.evaluate(()=>(window as any).cutoverInspect()),pageErrors:errors,boundary:'Actual App/Header/ProjectSettings/RuntimeSettings/LiveBackend/Monaco; controlled authenticated HTTP+WS, NOT production backend/LSP/Docker/AI/native.'},null,2));
  console.log('PASS bootstrap + genuine/forged ACK marker + immutable reconcile UI + actual App + local Monaco: neutral reachable V2 settings/validation/draft/keyboard/mobile, unknown Save fences Run/reconnect; editing remains. Controlled transport only.');
} catch(error) {if(page){await writeFile(path.join(output,'inspection.json'),JSON.stringify(await page.evaluate(()=>(window as any).cutoverInspect?.()),null,2));await page.screenshot({path:path.join(output,'failure.png')});}await writeFile(path.join(output,'failure.json'),JSON.stringify({revision:process.env.RUNTIME_REVISION,error:String(error),requests,pageErrors:errors},null,2));throw error;}
finally {await browser?.close();await server.close();}
