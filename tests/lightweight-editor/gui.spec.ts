/** External integrated REAL HTTP/WS backend only. Never route/fulfill/mock WS or install test app globals.
 * Existing isolated backend and project must be supplied by operator. No production server is started/stopped here.
 * This proves editor/save only, NOT Docker execution, real AI, native Windows or final seven-profile acceptance.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

test('integrated actual GUI: CtrlSpace local completion -> original CODE_CHANGED/ACK -> Undo/Redo -> refresh',async({page,browser,context},info)=>{
  const url=process.env.PAIRCOACH_GUI_URL,token=process.env.PAIRCOACH_GUI_TOKEN,path=process.env.PAIRCOACH_GUI_PATH,revision=process.env.PAIRCOACH_QA_REVISION;
  if(!url||!token||!path||!revision)throw Error('Set PAIRCOACH_GUI_URL/TOKEN/PATH and exact PAIRCOACH_QA_REVISION for isolated INTEGRATED backend.');
  const endpoint=new URL(url);expect(['127.0.0.1','localhost']).toContain(endpoint.hostname);
  expect([8080,8081,8765,8766,8767,8768]).not.toContain(Number(endpoint.port));
  const headers={Authorization:`Bearer ${token}`},frames:{direction:string;type:string;at:number;id?:string;replyTo?:string;content?:string;path?:string;status?:string;documentVersion?:number;workspaceVersion?:number;languageDocumentMessageId?:string;controlEpoch?:number;writeOwner?:string}[]=[];
  const currentness=process.env.PAIRCOACH_GUI_CURRENTNESS==='1';
  let currentnessObservation:{openedAt:number;frameStart:number;priorEpoch?:number;priorOwner?:string}|null=null;
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('websocket',ws=>{
    const capture=(direction:string,data:string|Buffer)=>{
      const m=JSON.parse(data.toString());if(typeof m.type!=='string')return;
      frames.push({direction,type:m.type,at:Date.now(),id:m.messageId,replyTo:m.payload?.replyTo,path:m.payload?.path,status:m.payload?.status,
        ...(m.type==='SESSION_STATE'?{controlEpoch:m.payload.controlEpoch,writeOwner:m.payload.writeOwner}:{}),
        ...(m.type==='CODE_CHANGED'?{content:m.payload.content,languageDocumentMessageId:m.payload.languageDocumentMessageId}:{}),
        ...(m.type==='ACK'?{documentVersion:m.payload.documentVersion,workspaceVersion:m.payload.workspaceVersion}:{})});
    };
    ws.on('framesent',e=>capture('send',e.payload));ws.on('framereceived',e=>capture('receive',e.payload));
  });
  const getDocument=async()=>{
    const response=await page.request.get(`${url}/api/file?path=${encodeURIComponent(path)}`,{headers});expect(response.ok()).toBe(true);return response.json();
  };
  // Read canonical source before interacting. GUI uses same authenticated service, no fake save reply.
  const original=await getDocument(),initialVersion=original.version;
  const marker='lightCompletionAlpha',prefix='lightCompletionAl';
  const append=process.env.PAIRCOACH_GUI_APPEND??`\n// ${marker}\n// ${prefix}`;
  let restored=false,cleanupError:string|null=null;
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  const paste=async(text:string)=>{await page.evaluate(value=>navigator.clipboard.writeText(value),text);await page.keyboard.press('Control+v');};
  const assertAck=async(content:string)=>{
    await expect.poll(()=>frames.filter(f=>f.type==='CODE_CHANGED'&&f.content===content).some(save=>frames.some(ack=>ack.type==='ACK'&&ack.replyTo===save.id&&Number(ack.documentVersion)>initialVersion))).toBe(true);
    await expect.poll(async()=>(await getDocument()).content).toBe(content);
  };
  try {
    await page.goto(`${url}/#token=${encodeURIComponent(token)}`);
    await expect(page.getByText('Połączono z backendem.',{exact:true})).toBeVisible();
    const tab=page.getByRole('tab',{name:path,exact:true});
    if(await tab.count())await tab.click();
    else await page.getByText(path.split('/').at(-1)!,{exact:true}).first().click();
    const input=page.getByRole('textbox',{name:`Edytor pliku ${path}`,exact:true});
    await expect(input).toBeVisible();await input.focus();await page.keyboard.press('Control+End');await paste(append);
    const dirty=original.content+append;await assertAck(dirty);
    const frameStart=frames.length;
    // Real keyboard movement queues the normal 120ms VIEW_CHANGED publication. Never
    // inject/replay a WS event: keep the list open across that actual backend response.
    if(currentness){await page.keyboard.press('ArrowLeft');await page.keyboard.press('ArrowRight');}
    await page.keyboard.press('Control+Space');
    const list=page.getByRole('listbox',{name:/Podpowiedzi kodu/});await expect(list).toBeVisible();
    if(currentness){
      const prior=[...frames.slice(0,frameStart)].reverse().find(f=>f.type==='SESSION_STATE');
      currentnessObservation={openedAt:Date.now(),frameStart,priorEpoch:prior?.controlEpoch,priorOwner:prior?.writeOwner};
    }
    const option=list.getByRole('option',{name:marker,exact:true});await expect(option).toBeVisible();
    if(currentnessObservation){
      const observation=currentnessObservation;
      await expect.poll(()=>frames.slice(frameStart).some(f=>f.type==='SESSION_STATE'&&f.at>=observation.openedAt)).toBe(true);
      const update=frames.slice(frameStart).find(f=>f.type==='SESSION_STATE'&&f.at>=observation.openedAt)!;
      expect(update.controlEpoch).toBe(observation.priorEpoch);expect(update.writeOwner).toBe(observation.priorOwner);
      const view=frames.slice(frameStart).find(f=>f.direction==='send'&&f.type==='VIEW_CHANGED');
      expect(view,'actual keyboard view publication required').toBeTruthy();
      await expect.poll(()=>frames.some(f=>f.type==='ACK'&&f.replyTo===view!.id)).toBe(true);
      await expect(list,'view-only SESSION_STATE must preserve an open completion').toBeVisible();
      await expect(option).toBeVisible();
    }
    // Choose using keyboard only; existing controlled widget consumes Enter, not the native widget.
    for(let i=0;await option.getAttribute('aria-selected')!=='true';i++){expect(i).toBeLessThan(100);await page.keyboard.press('ArrowDown');}
    await page.screenshot({path:info.outputPath('completion-desktop.png')});
    await page.keyboard.press('Enter');const completed=dirty.slice(0,-prefix.length)+marker;await assertAck(completed);
    await page.keyboard.press('Control+z');await assertAck(dirty);
    await page.keyboard.press('Control+y');await assertAck(completed);
    await page.reload();await expect(page.getByText('Połączono z backendem.',{exact:true})).toBeVisible();
    await expect(input).toBeVisible();
    expect((await getDocument()).content).toBe(completed);
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:info.outputPath('editor-mobile.png')});
    expect(frames.filter(f=>f.direction==='send'&&f.type.startsWith('LANGUAGE_'))).toHaveLength(0);
    expect(frames.filter(f=>f.type==='CODE_CHANGED').every(f=>f.languageDocumentMessageId===undefined)).toBe(true);
    expect(errors).toEqual([]);
    fs.writeFileSync(info.outputPath('proof.json'),JSON.stringify({revision,url,node:process.version,platform:process.platform,browser:browser.version(),path,
      profile:process.env.PAIRCOACH_GUI_PROFILE??'operator-supplied',docker:process.env.PAIRCOACH_GUI_DOCKER??'NOT_ASSERTED',
      inputSha256:createHash('sha256').update(original.content).digest('hex'),initialVersion,finalDocumentVersion:(await getDocument()).version,
      viewports:['1365x900','390x844'],currentnessObservation,frames,errors,
      boundary:'Actual integrated HTTP/WS and Monaco; editor/save/Undo/Redo only. No Docker execution, model AI or whole final acceptance.'},null,2));
  } finally {
    // Restore ONLY the tested isolated current file through the normal GUI/save path, not raw file writes/API mutation.
    try { if(!page.isClosed()){
      await page.setViewportSize({width:1365,height:900});
      const input=page.getByRole('textbox',{name:`Edytor pliku ${path}`,exact:true});
      if((await getDocument()).content===original.content)restored=true;
      else if(await input.isVisible()){
        await input.focus();await page.keyboard.press('Control+a');await paste(original.content);await assertAck(original.content);restored=true;
      }
    }
    } catch(e) {cleanupError=String(e);}
    fs.writeFileSync(info.outputPath('observed-frames.json'),JSON.stringify({revision,url,currentnessObservation,frames,errors},null,2));
    fs.writeFileSync(info.outputPath('cleanup.json'),JSON.stringify({restored,cleanupError,scope:'isolated task source only; backend process not touched'}));
    expect.soft(cleanupError,'GUI cleanup').toBeNull();expect.soft(restored,'exact original source restored').toBe(true);
  }
});
