/** Scoped browser component proof. No production HTTP/WS, task runtime, AI or integrated-acceptance claim. */
import {chromium,expect,type Browser} from '@playwright/test';
import {createServer} from 'vite';
import fs from 'node:fs';import path from 'node:path';
const out=process.env.ACK_BROWSER_OUTPUT!;if(!out||fs.existsSync(out))throw Error('Provide NEW ACK_BROWSER_OUTPUT');fs.mkdirSync(out,{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:path.join(out,'vite-cache'),server:{host:'127.0.0.1',port:0},logLevel:'warn'});
let browser:Browser|undefined;const errors:string[]=[];
try{
 await server.listen();const a=server.httpServer!.address();if(!a||typeof a==='string')throw Error('No own listener');
 browser=await chromium.launch({headless:true,executablePath:process.env.PAIRCOACH_QA_BROWSER});const page=await browser.newPage({viewport:{width:1365,height:900}});page.on('pageerror',e=>errors.push(e.message));
 const html='<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><h1>Kontrolowana granica ACK — nie integracja backendu</h1><button id="ack">Potwierdź własny zapis</button><button id="release">Zwolnij stary wynik</button><button id="veto">Weto</button><output id="requests" aria-label="Wywołania providera">0</output><div id="editor" style="width:100%;height:450px"></div><pre id="content" aria-label="Bufor"></pre><script type="module" src="/tests/lightweight-editor/ack-browser-entry.ts"></script>';
 await page.route('**/ack-test',route=>route.fulfill({contentType:'text/html',body:html}));await page.goto(`http://127.0.0.1:${a.port}/ack-test`);
 await expect(page.locator('.monaco-editor .view-lines')).toBeVisible();await page.locator('.monaco-editor .view-lines').click({position:{x:80,y:25}});const input=page.getByRole('textbox',{name:'Edytor testowy ACK'});await expect(input).toBeAttached();await page.keyboard.press('Control+End');await page.keyboard.press('Control+Space');await expect(page.getByLabel('Wywołania providera')).toHaveText('1');
 await page.getByRole('button',{name:'Potwierdź własny zapis'}).click();await expect(page.getByLabel('Wywołania providera')).toHaveText('2');
 const option=page.getByRole('option',{name:'p2BufferAlpha',exact:true});await expect(option).toBeVisible();await page.screenshot({path:path.join(out,'fresh-after-ack-desktop.png')});
 await page.getByRole('button',{name:'Zwolnij stary wynik'}).click();await expect(option).toBeVisible();await page.keyboard.press('Enter');await expect(page.getByLabel('Bufor')).toHaveText('p2BufferAlpha\np2BufferAlpha');
 await page.keyboard.press('Control+z');await expect(page.getByLabel('Bufor')).toHaveText('p2BufferAlpha\np2BufferAl');
 await page.keyboard.press('Control+y');await expect(page.getByLabel('Bufor')).toHaveText('p2BufferAlpha\np2BufferAlpha');
 await page.keyboard.press('Control+z');await page.keyboard.press('Control+Space');await expect(option).toBeVisible();await page.getByRole('button',{name:'Weto',exact:true}).click();await expect(option).toHaveCount(0);await page.keyboard.press('Enter');await expect(page.getByLabel('Bufor')).toHaveText('p2BufferAlpha\np2BufferAl');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'veto-mobile-render-only.png')});expect(errors).toEqual([]);
 fs.writeFileSync(path.join(out,'proof.json'),JSON.stringify({status:'PASS_COMPONENT_ONLY',candidate:process.env.ACK_REVISION,node:process.version,browser:browser.version(),viewports:['1365x900','390x844'],steps:['dirty CtrlSpace: old local result held','own ACK: fresh request and option','late old reply does not replace fresh option','Enter -> one Undo/Redo unit','Veto blocks popup and Enter'],errors,boundary:'Actual Monaco/RuntimeWiring/bridge/currentDocumentWords; controlled ACK at caller boundary; NO LiveBackend/HTTP/WS/Docker/AI, NOT full TEST101/102/107'},null,2));
}catch(error){fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({error:String(error),errors}));throw error;}finally{await browser?.close();await server.close();fs.writeFileSync(path.join(out,'closure.json'),JSON.stringify({browserDisconnected:!browser?.isConnected(),serverClosed:!server.httpServer?.listening}));}
