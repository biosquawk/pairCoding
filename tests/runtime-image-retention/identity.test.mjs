import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { createImageRetention, imagePin, retentionReference, imageCommandOutput } from '../../scripts/runtime-image-retention.mjs';
import { receiptWriter } from '../../scripts/runtime-files.mjs';
import { privateRoot, dockerModel, engine, image, copy, json } from './fixture.mjs';
const tag='paircoach/runtime-java-maven-21:stage09';
function context(t,requiredPins=[]) {
 const root=privateRoot(t),out=path.join(root,'proof'),write=receiptWriter(out),receipt={status:'UNIT'},m=dockerModel();
 const c=createImageRetention({engine,requiredPins,run:args=>m.command(args),receipt,save:()=>write(receipt)});
 return {root,out,receipt,m,c};
}
function build(f){f.c.beforeBuild(tag);f.m.command(['build','--tag',tag,'UNIT']);return f.c.afterBuild(tag);}
const reverse=v=>Array.isArray(v)?v.map(reverse):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,reverse(x)])):v;
test('UNIT genuine OCI Id=Descriptor.digest and existing exact ref reuse; recursive object key order immaterial',t=>{
 const a=image('same');a.Descriptor.digest=a.Id;const p=imagePin(engine,a,'UNIT genuine descriptor'),f=context(t);
 f.m.seed(tag,a);f.m.seed(retentionReference(p),a);f.c.add(p);f.c.beforeBuild(tag);f.c.verifyAll();assert.equal(f.m.calls.some(a=>a[0]==='tag'),false);
 f.m.images.set(a.Id,reverse(a));f.c.verifyAll();assert.equal(retentionReference(p),retentionReference(reverse(p)));
 assert.equal(json(path.join(f.out,'receipt.json')).imageRetention.pins[0].pin.observedImage.Descriptor.digest,a.Id);
});
test('UNIT lifetime model: explicit prior pins retained BEFORE mutable retarget and postchecks cover ALL required IDs',t=>{
 const a=image('old'),p=imagePin(engine,a,'UNIT old leaf'),f=context(t,[p]);f.m.seed(tag,a);f.c.retainRequired();const next=build(f);f.c.verifyAll();
 assert.equal(f.c.pins().length,2);assert.notEqual(a.Id,next.observedImage.Id);assert.ok(f.m.images.has(a.Id));assert.deepEqual(f.m.removed,[]);
 const before=f.m.calls.findIndex(a=>a[0]==='build');assert.ok(f.m.calls.some((a,i)=>a[0]==='tag'&&a[1]===p.observedImage.Id&&i<before));
 f.m.images.delete(a.Id);assert.throws(()=>f.c.verifyAll(),/failed\/unknown/);
});
test('UNIT foreign/conflicting deterministic retention ref never overwritten or followed by build',t=>{
 const a=image('old'),p=imagePin(engine,a,'UNIT actual leaf'),f=context(t,[p]);f.m.seed(tag,a);f.m.seed(retentionReference(p),image('foreign'));
 assert.throws(()=>f.c.retainRequired(),/retention genuine manifest/);assert.equal(f.m.calls.some(a=>['tag','build','create'].includes(a[0])),false);
 assert.throws(()=>f.c.beforeBuild(tag),/stopped/);
});
test('UNIT unknown tag may have happened: durable intent retained, no read retry or later mutation',t=>{
 const f=context(t);f.c.beforeBuild(tag);f.m.command(['build','--tag',tag,'UNIT']);let at;
 f.m.hook=args=>{if(args[0]==='tag'){at=f.m.calls.length;return {status:null,signal:'SIGTERM',stdout:'',stderr:''};}};
 assert.throws(()=>f.c.afterBuild(tag),/unknown/);assert.equal(f.m.calls.length,at);assert.equal(f.receipt.imageRetention.operations.at(-1).status,'TAG_INTENT');
 assert.throws(()=>f.c.beforeBuild(tag),/stopped/);assert.equal(f.m.calls.length,at);
});
const mutations=[
 ['Id',a=>{a.Id='sha256:'+'a'.repeat(64);}],
 ['descriptor digest',a=>{a.Descriptor.digest='sha256:'+'b'.repeat(64);}],
 ['descriptor size',a=>{a.Descriptor.size++;}],
 ['descriptor size type',a=>{a.Descriptor.size=String(a.Descriptor.size);}],
 ['descriptor mediaType',a=>{a.Descriptor.mediaType='application/vnd.oci.image.manifest.v1+json';}],
 ['descriptor extra field',a=>{a.Descriptor.other=null;}],
 ['descriptor lost field',a=>{delete a.Descriptor.annotations;}],
 ['descriptor nested array order',a=>{a.Descriptor.annotations.b.reverse();}],
 ['descriptor no proof',a=>{a.Descriptor=null;}],
 ['RepoDigests wrong manifest digest',a=>{a.RepoDigests=['repo@sha256:'+'f'.repeat(64)];}],
 ['RepoDigests object not array',a=>{a.RepoDigests={};}],
 ['Config exact nested field',a=>{a.Config.Labels.kind='foreign';}],
 ['Config added field',a=>{a.Config.WorkingDir='/other';}],
 ['Config array order',a=>{a.Config.Env.reverse();}],
 ['Config user root',a=>{a.Config.User='0:0';}],
 ['Config entrypoint',a=>{a.Config.Entrypoint=['/bin/sh'];}],
 ['Config malformed entrypoint false',a=>{a.Config.Entrypoint=false;}],
];
for(const [name,mutate] of mutations)test('UNIT reject changed exact identity: '+name,t=>{
 const a=image('one'),f=context(t),p=imagePin(engine,a,'UNIT old exact leaf');f.m.seed(tag,a);f.c.add(p);mutate(f.m.images.get(a.Id));
 const count=f.m.calls.filter(a=>a[0]==='tag').length;assert.throws(()=>f.c.verifyAll());assert.equal(f.m.calls.filter(a=>a[0]==='tag').length,count);assert.equal(f.m.builds.length,0);
});
test('UNIT RepoDigest-only proof anchored to original genuine digest; alias order allowed, arbitrary new digest denied',t=>{
 const a=image('repo');a.Descriptor=null;a.RepoDigests=['repo@sha256:'+'d'.repeat(64),'another@sha256:'+'d'.repeat(64)];
 const f=context(t);f.m.seed(tag,a);f.c.add(imagePin(engine,a,'UNIT genuine RepoDigest'));f.m.images.get(a.Id).RepoDigests.reverse();f.c.verifyAll();f.m.images.get(a.Id).RepoDigests[0]='foreign@sha256:'+'e'.repeat(64);assert.throws(()=>f.c.verifyAll(),/manifest/);
});
test('UNIT all explicit pins/engine/count validated BEFORE any command or state publication',t=>{
 const a=image('pin'),p=imagePin(engine,a,'UNIT leaf'),root=privateRoot(t);let writes=0,calls=0;
 for(const pins of [[{...p,engine:{...engine,ID:'other'}}],[{...p,extra:true}],[{...p,source:''}],Array.from({length:65},()=>p),[{...p,observedImage:{...p.observedImage,Descriptor:null}}]]){
  const receipt={};assert.throws(()=>createImageRetention({engine,requiredPins:pins,run:()=>{calls++;},save:()=>{writes++;},receipt}));assert.deepEqual(receipt,{});
 }
 assert.equal(writes,0);assert.equal(calls,0);assert.deepEqual(fs.readdirSync(root),[]);
});
test('UNIT only exact missing local inspect is absence; daemon/timeout/partial/foreign-name failure is UNKNOWN',()=>{
 const args=['image','inspect',tag],raw={status:1,signal:null,stdout:'[]\n',stderr:`Error response from daemon: No such image: ${tag}\n`};assert.equal(imageCommandOutput(args,raw,true),null);
 for(const change of [{error:new Error('timeout')},{signal:'SIGKILL'},{status:null},{status:2},{stdout:'[{}]'},{stderr:'permission denied'},{stderr:`Error response from daemon: No such image: ${tag}-other`},{stderr:raw.stderr+'unrelated error'},{stderr:'No such image: '+tag}])assert.throws(()=>imageCommandOutput(args,{...raw,...change},true));
 assert.throws(()=>imageCommandOutput(['tag','a',tag],raw,true));assert.throws(()=>imageCommandOutput(args,raw,false));
});
test('UNIT known missing prior ID is fatal, never rebuilt or substituted from current profile tag',t=>{
 const old=image('missing'),f=context(t,[imagePin(engine,old,'UNIT known missing leaf')]);f.m.seed(tag,image('present-spring'));
 assert.throws(()=>f.c.retainRequired(),/failed\/unknown/);assert.equal(f.m.calls.some(a=>['tag','build','create','pull'].includes(a[0])),false);
 assert.throws(()=>f.c.beforeBuild(tag),/stopped/);
});
test('UNIT own alias growth/order and old mutable repository removal preserve exact Id/Descriptor/Config',t=>{
 const a=image('aliases'),f=context(t);f.m.nameDerived=true;f.m.seed(tag,a);f.c.beforeBuild(tag);
 const before=f.c.pins()[0];assert.equal(before.manifestDigest,a.Descriptor.digest);assert.equal(before.observedImage.RepoDigests.length,1);
 f.m.aliasReverse=true;build(f);f.c.verifyAll();const actual=JSON.parse(f.m.command(['image','inspect',a.Id]).stdout)[0];
 assert.equal(actual.RepoDigests.length,1,'old mutable repository disappeared, retained alias remains');assert.ok(actual.RepoDigests[0].startsWith('paircoach/retained-'));
 assert.equal(actual.Id,a.Id);assert.deepEqual(actual.Descriptor,a.Descriptor);assert.deepEqual(actual.Config,a.Config);
});
test('UNIT no Descriptor: stable genuine digest through own alias growth/removal; empty/ambiguous/different digests rejected',t=>{
 const a=image('no-descriptor');a.Descriptor=null;a.RepoDigests=['original@sha256:'+'a'.repeat(64)];const f=context(t),p=imagePin(engine,a,'UNIT captured genuine RepoDigest');
 f.m.seed(tag,a);f.c.add(p);const live=f.m.images.get(a.Id);live.RepoDigests=['retained@'+p.manifestDigest,'other@'+p.manifestDigest];f.c.verifyAll();
 live.RepoDigests=['retained@'+p.manifestDigest];f.c.verifyAll();live.RepoDigests=[];assert.throws(()=>f.c.verifyAll(),/manifest/);
 for(const digests of [[],['a@sha256:'+'a'.repeat(64),'b@sha256:'+'b'.repeat(64)]])assert.throws(()=>imagePin(engine,{...a,RepoDigests:digests},'UNIT ambiguous'),/manifest/);
});
