import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPairCoachServer } from '../../src/server/http';

for(const enableExecution of [false,true])test(`startup error remains primary when cleanup ${enableExecution?'also fails':'succeeds'}`,async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'startup-errors-')),root=path.join(base,'project');fs.mkdirSync(root,{mode:0o700});
  const marker=path.join(root,'main.js');fs.writeFileSync(marker,'UNCHANGED\n');
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  // Deliberately invalid workspace authority: preserve the guard, never repair this negative fixture.
  const app=createPairCoachServer({rootPath:root,dataDir:path.join(base,'wrong-authority'),port:0,enableCoach:false,enableExecution});
  let error:any;try{await app.listen();assert.fail('Startup must fail');}catch(e){error=e;}
  assert.equal(error.code,'INVALID_V2_DATA_DIR');
  if(enableExecution) {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause,error.errors[0]);assert.equal(error.cause.code,'INVALID_V2_DATA_DIR');
    assert.equal(error.errors[1].code,'RUN_RECOVERY_REQUIRED');
    await assert.rejects(app.close(),{code:'RUN_RECOVERY_REQUIRED'},'failed cleanup is not a successful close');
  } else {assert.equal(error instanceof AggregateError,false);await app.close();}
  assert.equal(fs.readFileSync(marker,'utf8'),'UNCHANGED\n');
  assert.equal(fs.existsSync(path.join(root,'.paircoach')),false);
});

test('ordinary start and repeated close remain successful',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'startup-normal-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const app=createPairCoachServer({rootPath:root,dataDir:path.join(root,'.paircoach'),port:0,enableCoach:false,enableExecution:false});
  const port=await app.listen();assert.ok(port>0);await app.close();await app.close();
});
