/** UNIT: real isolated filesystem, synthetic Docker inspect; no daemon/native proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {DockerExecutor} from '../../src/server/execution/DockerExecutor';
import {fixture, profile, imageId, digest} from './fixtures';

const otherDigest='sha256:'+'c'.repeat(64);
const descriptor={mediaType:'application/vnd.oci.image.manifest.v1+json',digest,size:1234};
interface Case {
  name:string;
  inspect:unknown;
  canRun:boolean;
  lockedDigest?:string;
  lockedId?:string;
}
const cases:Case[]=[
  {name:'registered manifest with matching config',inspect:[{Id:imageId,RepoDigests:['repo@'+digest]}],canRun:true},
  {name:'local Descriptor manifest with empty RepoDigests',inspect:[{Id:imageId,Descriptor:descriptor,RepoDigests:[]}],canRun:true},
  {name:'local Descriptor manifest without RepoDigests',inspect:[{Id:imageId,Descriptor:descriptor}],canRun:true},
  {name:'matching manifest among other registered digests',inspect:[{Id:imageId,RepoDigests:['registry.test:5000/team/repo@'+otherDigest,'repo@'+digest]}],canRun:true},
  {name:'missing all manifest proof',inspect:[{Id:imageId}],canRun:false},
  {name:'config ID alone is not a manifest proof',inspect:[{Id:imageId,RepoDigests:[]}],lockedDigest:imageId,canRun:false},
  {name:'wrong Descriptor manifest',inspect:[{Id:imageId,Descriptor:{...descriptor,digest:otherDigest},RepoDigests:[]}],canRun:false},
  {name:'wrong registered manifest',inspect:[{Id:imageId,RepoDigests:['repo@'+otherDigest]}],canRun:false},
  {name:'missing Descriptor digest',inspect:[{Id:imageId,Descriptor:{mediaType:descriptor.mediaType}}],canRun:false},
  {name:'nonstring Descriptor digest',inspect:[{Id:imageId,Descriptor:{digest:[digest]}}],canRun:false},
  {name:'missing config ID even with valid manifest',inspect:[{Descriptor:descriptor}],canRun:false},
  {name:'wrong config ID even with valid manifest',inspect:[{Id:otherDigest,Descriptor:descriptor,RepoDigests:['repo@'+digest]}],canRun:false},
  {name:'malformed equal config IDs',inspect:[{Id:'bad',Descriptor:descriptor}],lockedId:'bad',canRun:false},
  {name:'null image inspection',inspect:[null],canRun:false},
  {name:'multiple inspected images',inspect:[{Id:imageId,Descriptor:descriptor},{Id:imageId,Descriptor:descriptor}],canRun:false},
  {name:'nonarray RepoDigests cannot supply proof',inspect:[{Id:imageId,RepoDigests:'repo@'+digest}],canRun:false},
  {name:'nonstring RepoDigest cannot supply proof',inspect:[{Id:imageId,RepoDigests:[{digest}]}],canRun:false},
];
for(const [name,value] of [
  ['bare hex','b'.repeat(64)],['short sha256','sha256:abc'],['wrong algorithm','sha512:'+'b'.repeat(64)],
  ['uppercase hex','sha256:'+'B'.repeat(64)],['trailing whitespace',digest+' '],['empty','']
]) {
  cases.push({name:'invalid locked manifest: '+name,lockedDigest:value,inspect:[{Id:imageId,Descriptor:{...descriptor,digest:value},RepoDigests:['repo@'+value]}],canRun:false});
  cases.push({name:'invalid Descriptor manifest: '+name,inspect:[{Id:imageId,Descriptor:{...descriptor,digest:value},RepoDigests:[]}],canRun:false});
}
for(const value of ['@'+digest,'repo@@'+digest,'repo @'+digest,'repo@'+digest+'\n','repo@'+digest+'/extra']) {
  cases.push({name:'invalid registered reference '+JSON.stringify(value),inspect:[{Id:imageId,RepoDigests:[value]}],canRun:false});
}
for(const scenario of cases) test('image identity: '+scenario.name,async()=>{
  const f=await fixture();
  try {
    const run=f.fake.run.bind(f.fake);
    const image={...f.policy.runtimes[0].image,digest:scenario.lockedDigest??digest,imageId:scenario.lockedId??imageId};
    const inspected:string[][]=[];
    f.fake.run=async(args)=>{
      if(args[0]!=='image')return run(args);
      inspected.push([...args]);
      return {exitCode:0,stderr:'',stdout:JSON.stringify(scenario.inspect)};
    };
    const executor=new DockerExecutor({policy:{...f.policy,runtimes:[{...f.policy.runtimes[0],image}]},journal:f.journal,transport:f.fake});
    const got=await executor.readiness(profile,'config1');
    for(const mode of ['RUN_MAIN','RUN_TESTS'] as const){
      assert.equal(got.modes[mode].canRun,scenario.canRun);
      assert.equal(got.modes[mode].problem?.code??null,scenario.canRun?null:'IMAGE_MISSING');
    }
    assert.deepEqual(inspected,[['image','inspect',image.imageId]]);
    assert.ok(f.fake.calls.every(args=>args[0]==='info'),'Readiness must not pull/create/start a container');
  } finally {await f.cleanup();}
});
