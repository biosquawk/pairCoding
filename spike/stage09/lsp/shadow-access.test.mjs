import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, chmodSync, symlinkSync, linkSync, renameSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createPrivateOutput,assertPrivateOutput,createMutableShadow} from './shadow-access.mjs';
const mode=p=>statSync(p).mode&0o777;
const digest=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function fixture(t){const parent=mkdtempSync(join(tmpdir(),'pc-shadow-'));t.after(()=>rmSync(parent,{recursive:true,force:true}));return {parent,out:join(parent,'new-output')};}

test('umask022: effective writable descriptors/source and private boundary; no parent/source mutation',t=>{
  const {parent,out}=fixture(t),source=join(parent,'original.java');
  writeFileSync(source,'class Original {}\r\n',{mode:0o640});chmodSync(source,0o640);
  const before={hash:digest(source),mode:mode(source),parent:mode(parent)};
  // Isolated child ONLY: production harness never changes process-wide umask.
  const script=`
    import assert from 'node:assert/strict';
    import {statSync,readFileSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {createPrivateOutput,createMutableShadow} from ${JSON.stringify(new URL('./shadow-access.mjs',import.meta.url).href)};
    process.umask(0o022);
    const out=process.argv[1];createPrivateOutput(out);
    for(const kind of ['java27','java21','python']){
      const shadow=createMutableShadow(out,kind);
      for(const [path,text] of [['.project','descriptor'],['.classpath','classpath'],['.settings/org.eclipse.jdt.core.prefs','prefs'],['src/Demo.java','class Demo {}\\r\\n']]){
        const file=shadow.write(path,text);
        assert.equal(statSync(file).mode&0o777,0o666,'effective file0666 under umask022: '+path);
        assert.equal(readFileSync(file,'utf8'),text);
      }
      for(const path of ['', '.settings','src'])assert.equal(statSync(join(shadow.root,path)).mode&0o777,0o777);
      writeFileSync(join(shadow.root,'.project'),'modified descriptor');
      assert.equal(readFileSync(join(shadow.root,'.project'),'utf8'),'modified descriptor');
    }
    assert.equal(statSync(out).mode&0o777,0o700,'dedicated output0700');
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script,out],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.error?.message);
  assert.equal(digest(source),before.hash);assert.equal(mode(source),before.mode);assert.equal(mode(parent),before.parent);
});
test('NEW private output only; reject existing outputs and linked ancestors without chmod',t=>{
  const {parent,out}=fixture(t);mkdirSync(out,{mode:0o755});chmodSync(out,0o755);
  assert.throws(()=>createPrivateOutput(out));assert.equal(mode(out),0o755);
  assert.throws(()=>assertPrivateOutput(out));
  const link=join(parent,'linked');symlinkSync(out,link);
  assert.throws(()=>createPrivateOutput(join(link,'nested')));
  assert.throws(()=>createPrivateOutput(link));assert.equal(mode(out),0o755);
});
test('reject traversal, aliases, preexisting file/symlink/hardlink and directory injection; originals untouched',t=>{
  const {parent,out}=fixture(t);createPrivateOutput(out);
  const source=join(parent,'source');writeFileSync(source,'unchanged');chmodSync(source,0o640);
  const before={hash:digest(source),mode:mode(source)};
  const shadow=createMutableShadow(out,'java27');
  for(const path of ['../source','/absolute','a/../../source','a//b','./source','a/./b','a\\b','a\0b',''])assert.throws(()=>shadow.write(path,'BAD'),path);
  symlinkSync(source,join(shadow.root,'linked'));assert.throws(()=>shadow.write('linked','BAD'));
  linkSync(source,join(shadow.root,'hardlinked'));assert.throws(()=>shadow.write('hardlinked','BAD'));
  symlinkSync(parent,join(shadow.root,'dirlink'));assert.throws(()=>shadow.write('dirlink/source','BAD'));
  mkdirSync(join(shadow.root,'injected'));chmodSync(join(shadow.root,'injected'),0o700);
  assert.throws(()=>shadow.write('injected/file','BAD'));assert.equal(mode(join(shadow.root,'injected')),0o700);
  shadow.write('src/Demo.java','safe');assert.throws(()=>shadow.write('src/Demo.java','overwrite'));
  renameSync(join(shadow.root,'src'),join(shadow.root,'saved-src'));mkdirSync(join(shadow.root,'src'));
  assert.throws(()=>shadow.write('src/Other.java','BAD'));
  assert.equal(digest(source),before.hash);assert.equal(mode(source),before.mode);
  assert.equal(readFileSync(join(shadow.root,'saved-src/Demo.java'),'utf8'),'safe');
});
test('run boundary refuses permissive mode or symlink; invalid case creates no shadow',t=>{
  const {parent,out}=fixture(t);createPrivateOutput(out);assertPrivateOutput(out);
  for(const kind of ['../escape','java17','java27/x',''])assert.throws(()=>createMutableShadow(out,kind));
  const alias=join(parent,'alias');symlinkSync(out,alias);assert.throws(()=>assertPrivateOutput(alias));
  chmodSync(out,0o755);assert.throws(()=>createMutableShadow(out,'python'));assert.equal(mode(out),0o755);
});
