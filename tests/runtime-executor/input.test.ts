import {
  test
} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  fixture
} from './fixtures';
import {
  verifyAcknowledgedInput
} from '../../src/server/execution/ImmutableInput';
test('UNIT filesystem: ACK bytes frozen; excluded credentials/dependencies/build; independent directories',async()=>{
  const f=await fixture();
  try{
    await fs.writeFile(path.join(f.workspace,'.env'),'TOKEN=secret');
    await fs.mkdir(path.join(f.workspace,'node_modules'));
    await fs.writeFile(path.join(f.workspace,'node_modules','old.js'),'stale');
    await fs.mkdir(path.join(f.workspace,'target'));
    await fs.writeFile(path.join(f.workspace,'target','old.xml'),'stale');
    const copy=await f.copy('run2');
    assert.deepEqual(copy.files.map(v=>v.path),['main.js','zażółć 😀.txt']);
    assert.equal(await fs.readFile(path.join(copy.immutableDirectory,'zażółć 😀.txt'),'utf8'),'A\r\nB');
    await fs.writeFile(path.join(f.workspace,'main.js'),'new draft');
    assert.equal(await fs.readFile(path.join(copy.immutableDirectory,'main.js'),'utf8'),'console.log("ACK")\n');
    assert.deepEqual(await fs.readdir(copy.buildDirectory),[]);
    assert.deepEqual(await fs.readdir(copy.artifactsDirectory),[]);
    assert.equal((await fs.stat(copy.immutableDirectory)).mode&0o222,0);
    await verifyAcknowledgedInput(copy);
  }finally{
    await f.cleanup();
  }
});
for(const mutation of ['edit','add','delete','rename','symlink','version'] as const)test(`UNIT filesystem: concurrent ${mutation} invalidates whole input, no manifest`,async()=>{
  const f=await fixture();
  try{
    let once=false;
    await assert.rejects(f.copy('race',async()=>{
      if(once)return;
      once=true;
      if(mutation==='edit')await fs.writeFile(path.join(f.workspace,'zażółć 😀.txt'),'changed');
      if(mutation==='add')await fs.writeFile(path.join(f.workspace,'extra'),'new');
      if(mutation==='delete')await fs.unlink(path.join(f.workspace,'zażółć 😀.txt'));
      if(mutation==='rename')await fs.rename(path.join(f.workspace,'zażółć 😀.txt'),path.join(f.workspace,'renamed'));
      if(mutation==='symlink'){
        await fs.unlink(path.join(f.workspace,'zażółć 😀.txt'));
        await fs.symlink('/etc/passwd',path.join(f.workspace,'zażółć 😀.txt'));
      }
      if(mutation==='version')f.ack.assertCurrent=async()=>{
        throw new Error('ACK advanced');
      };
    }),/RUN_INPUT_CHANGED/);
    await assert.rejects(fs.stat(path.join(f.runs,'race','input-manifest.json')));
  }finally{
    await f.cleanup();
  }
});
test('UNIT filesystem: complete inventory required, no unACKed file, case collision, hardlink or symlink',async()=>{
  const f=await fixture();
  try{
    await fs.writeFile(path.join(f.workspace,'unacknowledged'),'x');
    await assert.rejects(f.copy('extra'),/ACK inventory/);
    await fs.unlink(path.join(f.workspace,'unacknowledged'));
    await fs.writeFile(path.join(f.workspace,'MAIN.js'),'x');
    await assert.rejects(f.copy('case'),/Case-colliding/);
    await fs.unlink(path.join(f.workspace,'MAIN.js'));
    await fs.link(path.join(f.workspace,'main.js'),path.join(f.workspace,'hard'));
    await assert.rejects(f.copy('hardlink'),/Unsafe/);
    await fs.unlink(path.join(f.workspace,'hard'));
    await fs.symlink(path.join(f.workspace,'main.js'),path.join(f.workspace,'link'));
    await assert.rejects(f.copy('link'),/symlink/);
  }finally{
    await f.cleanup();
  }
});
test('UNIT filesystem: pre-copy authority failure and oversized file fail closed',async()=>{
  const f=await fixture();
  try{
    f.ack.assertCurrent=async()=>{
      throw new Error('not settled');
    };
    await assert.rejects(f.copy('unsettled'),/not settled/);
    f.ack.assertCurrent=async()=>{
    };
    await fs.writeFile(path.join(f.workspace,'big'),Buffer.alloc(4*1024*1024+1));
    await assert.rejects(f.copy('big'),/oversized/);
  }finally{
    await f.cleanup();
  }
});
