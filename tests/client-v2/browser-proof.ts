/** Scoped real-browser rendering/behavior proof of production components with controlled props/callbacks.
 * NOT App/HTTP/WS/Docker/Monaco integration. Existing browser+private libraries only, no installs. */
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { project, run } from './fixtures';
const output = process.env.RUNTIME_PROOF_DIR;
if (!output || !process.env.RUNTIME_BROWSER || !process.env.RUNTIME_REVISION) throw new Error('Provide RUNTIME_PROOF_DIR/RUNTIME_BROWSER/RUNTIME_REVISION.');
await mkdir(output,{recursive:true});
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:path.join(process.cwd(),'.tmp/vite-client-v2'),plugins:[react(),tailwind()],server:{host:'127.0.0.1',port:0},logLevel:'warn'});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const errors:string[]=[];
try {
  await server.listen();
  const address=server.httpServer!.address();assert.ok(address && typeof address==='object');
  browser=await chromium.launch({headless:true,executablePath:process.env.RUNTIME_BROWSER,timeout:15000});
  const page=await browser.newPage({viewport:{width:1365,height:900}});
  page.setDefaultTimeout(8000);
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(data=>{window.runtimeFixture=data;},{project:project(),run:run()});
  const html='<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"/></head><body><div id="root"></div><script type="module" src="/tests/client-v2/browser-entry.tsx"></script></body></html>';
  const transformed=await server.transformIndexHtml('/runtime-client-v2-fixture',html);
  await page.route('**/runtime-client-v2-fixture',route=>route.fulfill({contentType:'text/html',body:transformed}));
  await page.goto(`http://127.0.0.1:${address.port}/runtime-client-v2-fixture`);
  await page.getByRole('button',{name:'Ustawienia wykonania'}).click();
  const dialog=page.getByRole('dialog');await dialog.waitFor();
  // Tests-only task has no fake main. Named descriptors, multiline selectors, one save callback.
  const paths=dialog.getByLabel('Ścieżki testów');await paths.fill('../escape.txt');
  await dialog.getByRole('button',{name:'Zapisz ustawienia'}).click();await dialog.getByRole('alert').waitFor();
  assert.equal(await page.getByLabel('Zapisy').textContent(),'0');assert.equal(await paths.inputValue(),'../escape.txt');
  await paths.fill('tests/Zażółć 😀.txt');
  await dialog.getByRole('button',{name:'Zapisz ustawienia'}).click();
  await page.getByText('409 VERSION_CONFLICT — zachowaj formularz',{exact:false}).waitFor();
  assert.equal(await paths.inputValue(),'tests/Zażółć 😀.txt');assert.equal(await page.getByLabel('Zapisy').textContent(),'1');
  await page.screenshot({path:path.join(output,'desktop-conflict-1365x900.png')});
  // Tab stays in dialog, Escape closes without a second save, opener focus returns.
  await dialog.getByRole('button',{name:'Anuluj — bez zapisu'}).focus();await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>Boolean(document.activeElement?.closest('[role="dialog"]'))),true);
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  assert.equal(await page.getByRole('button',{name:'Ustawienia wykonania'}).evaluate(el=>document.activeElement===el),true);
  // Offline and permission gates preserve editable fields; no callback runs.
  await page.getByRole('button',{name:'Przełącz offline',exact:true}).click();await page.getByRole('button',{name:'Ustawienia wykonania'}).click();
  assert.equal(await dialog.getByRole('button',{name:'Zapisz ustawienia'}).isDisabled(),true);await dialog.getByLabel('Ścieżki testów').fill('draft/offline.txt');
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'Przełącz offline',exact:true}).click();
  await page.getByRole('button',{name:'Przełącz uprawnienie',exact:true}).click();await page.getByRole('button',{name:'Ustawienia wykonania'}).click();
  assert.equal(await dialog.getByRole('button',{name:'Zapisz ustawienia'}).isDisabled(),true);await page.keyboard.press('Escape');await page.getByRole('button',{name:'Przełącz uprawnienie',exact:true}).click();
  // Modal draft not overwritten when authoritative version changes behind it.
  await page.getByRole('button',{name:'Ustawienia wykonania'}).click();await dialog.getByLabel('Ścieżki testów').fill('keep/version-conflict.txt');
  await page.getByRole('button',{name:'Zmień wersję',exact:true}).evaluate(el=>(el as HTMLButtonElement).click());
  await page.getByText('Konflikt wersji. Zachowano wpisane pola',{exact:false}).waitFor();assert.equal(await dialog.getByLabel('Ścieżki testów').inputValue(),'keep/version-conflict.txt');
  assert.equal(await dialog.getByRole('button',{name:'Zapisz ustawienia'}).isDisabled(),true);await page.keyboard.press('Escape');
  // Mobile migration requires explicit action and retains original until save.
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Legacy',exact:true}).click();
  await page.getByText('LEGACY_RUN_PROFILE_REQUIRES_MIGRATION.',{exact:false}).waitFor();assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true);await page.screenshot({path:path.join(output,'mobile-migration-390x844.png')});
  await dialog.getByRole('button',{name:'Przygotuj migrację V2'}).click();await dialog.getByLabel('Ścieżki testów').waitFor();
  const rect=await dialog.boundingBox();assert.ok(rect && rect.x>=0 && rect.x+rect.width<=390 && rect.y>=0 && rect.y+rect.height<=844);
  await dialog.getByLabel('Włącz testy').uncheck();await dialog.getByRole('button',{name:'Zapisz ustawienia'}).click();await page.getByText('409 VERSION_CONFLICT — zachowaj formularz',{exact:false}).waitFor();
  assert.match((await page.getByLabel('Wynik testu').textContent())!,/"runProfiles":\[\]/);assert.equal(await dialog.getByLabel('Włącz testy').isChecked(),false);
  await page.screenshot({path:path.join(output,'mobile-disabled-draft-390x844.png')});await page.keyboard.press('Escape');
  // A server-confirmed save closes only after confirmation; changed configuration preserves draft.
  await page.getByRole('button',{name:'Ustawienia wykonania'}).click();await dialog.getByLabel('Ścieżki testów').fill('keep/config.txt');
  await page.getByRole('button',{name:'Zmień generację',exact:true}).evaluate(el=>(el as HTMLButtonElement).click());
  await page.getByText('Konflikt wersji. Zachowano wpisane pola',{exact:false}).waitFor();assert.equal(await dialog.getByLabel('Ścieżki testów').inputValue(),'keep/config.txt');
  assert.equal(await dialog.getByRole('button',{name:'Zapisz ustawienia'}).isDisabled(),true);await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Potwierdź następny zapis',exact:true}).click();await page.getByRole('button',{name:'Ustawienia wykonania'}).click();
  await dialog.getByRole('button',{name:'Zapisz ustawienia'}).click();await dialog.waitFor({state:'detached'});
  // Same-run Stop retry; manual editor remains available. Loading state explicit.
  await page.getByRole('button',{name:'Niepotwierdzony Stop',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Uruchom testy',exact:true}).isDisabled(),true);
  await page.getByLabel('Ręczna edycja',{exact:true}).fill('still editable');await page.screenshot({path:path.join(output,'mobile-stop-unconfirmed-390x844.png')});
  await page.getByRole('button',{name:'Ponów Stop',exact:true}).click();assert.equal(await page.getByLabel('Wynik testu').textContent(),'Stop run1');
  await page.getByRole('button',{name:'Ładowanie',exact:true}).click();await page.getByText('Ładowanie gotowości środowiska…',{exact:false}).waitFor();
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'proof.json'),JSON.stringify({revision:process.env.RUNTIME_REVISION,utc:new Date().toISOString(),browser:browser.version(),node:process.version,viewports:['1365x900','390x844'],status:'PASS_COMPONENT_BROWSER_ONLY',pageErrors:errors,boundary:'Actual production RuntimeSettingsV2/RuntimeStatusV2 React components; controlled props and onSave/onRun/onStop, NOT live API/App/Docker/LSP proof.'},null,2));
  console.log('PASS component browser proof: failed/conflict draft, permissions/offline, keyboard/Escape/focus, mobile migration/[]disable, same-run Stop and manual editing; 0 pageerrors.');
} catch (error) {
  await writeFile(path.join(output,'failure.json'),JSON.stringify({utc:new Date().toISOString(),revision:process.env.RUNTIME_REVISION,error:String(error),pageErrors:errors},null,2));
  throw error;
} finally { await browser?.close();await server.close(); }
