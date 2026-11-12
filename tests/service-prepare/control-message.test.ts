import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixture';
test('UNKNOWN notice always explains possible first admission, even immediately after a transport error',async t=>{
  const f=await fixture(t);f.post=async()=>{throw Error('packet may never have arrived');};
  await f.live.prepareRuntimeEnvironment();assert.match(f.maintenance().message!,/packet may never/);
  assert.match(f.maintenance().message!,/może wykonać pierwsze przygotowanie/);assert.match(f.maintenance().message!,/Dokończ przygotowanie/);
  await f.snapshot();assert.match(f.maintenance().message!,/może wykonać pierwsze przygotowanie/);
});
test('disabled control explains exact existing source/control/Run fence without blocking manual editor',async t=>{
  const f=await fixture(t);f.live.saveFileContent('main.txt','still editable');
  assert.equal(f.maintenance().canPrepare,false);assert.match(f.maintenance().message!,/potwierdzenie zapisu/);
  assert.equal(f.live.getState().files[0].content,'still editable');assert.equal(f.posts().length,0);
});
