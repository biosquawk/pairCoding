/** Real SprintPanel DOM, with an isolated client port; not live runtime proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';
import {readLearningPack} from '../../src/server/sprint/LearningPack';
import {MockBackendSimulator} from '../../src/services/simulator';

test('SprintPanel takes title/default topic from Java or REST pack; Start sends the real topic', {timeout:60_000},async t=>{
  await fs.mkdir('target',{recursive:true});
  const dir=await fs.mkdtemp(path.resolve('target/pack-panel-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const packs=[readLearningPack(fileURLToPath(new URL('../../learning-packs/java-concurrency/',import.meta.url))),readLearningPack()];
  await build({stdin:{contents:`
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {SprintPanel} from './src/components/SprintPanel';
    const packs=${JSON.stringify(packs)},state=${JSON.stringify(new MockBackendSimulator().getFullState())};
    const actions=[];let index=0;
    const client={readSprint:async()=>({pack:packs[index],sprint:null,currentVersion:null}),
      sprintAction:async(kind,extra)=>{actions.push({kind,...extra});return {pack:packs[index],sprint:null,currentVersion:null};}};
    const root=createRoot(document.getElementById('root'));
    globalThis.fixture={actions,render:i=>{index=i;root.render(React.createElement(SprintPanel,{key:i,client,state}));}};
  `,resolveDir:process.cwd()},outfile:path.join(dir,'panel.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',
    define:{'process.env.NODE_ENV':'"production"'}});
  await fs.writeFile(path.join(dir,'index.html'),'<!doctype html><div id="root"></div><script src="panel.js"></script>');
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined,env:{...process.env,TMPDIR:'target'}});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route(/^https?:/,route=>route.abort());
  await page.goto(pathToFileURL(path.join(dir,'index.html')).href);
  for(const [i,pack] of packs.entries()) {
    await page.evaluate(i=>(window as any).fixture.render(i),i);
    await expect(page.locator('section strong')).toHaveText(pack.title);
    const selected=page.locator('input[type=checkbox]:checked');
    await expect(selected).toHaveCount(1);
    await expect(selected.locator('..')).toHaveText(pack.topics[0].title);
    await expect(page.locator('section')).not.toContainText('HTTP-verified');
    await expect(page.locator('section')).not.toContainText('sprawdzeniu HTTP');
    if(i===0)await expect(page.locator('section')).not.toContainText('REST');
    await page.getByRole('button',{name:'Rozpocznij sprint',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window as any).fixture.actions.length)).toBe(i+1);
    const sent=await page.evaluate(()=>(window as any).fixture.actions.at(-1));
    assert.equal(sent.kind,'start');assert.deepEqual(sent.topics,[pack.topics[0].id]);
  }
  assert.deepEqual(errors,[]);
});
