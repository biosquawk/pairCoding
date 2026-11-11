// Image-internal allowlisted version probes. NEVER run on host for runtime evidence.
import { spawnSync } from 'node:child_process';
const checks={node:['/opt/paircoach/node/bin/node',['--version'],/^v(\S+)/],typescript:['/opt/paircoach/node/bin/node',['/opt/paircoach/tools/node_modules/typescript/bin/tsc','--version'],/^Version (\S+)/],python:['/usr/local/bin/python3',['--version'],/^Python (\S+)/],pytest:['/usr/local/bin/python3',['-m','pytest','--version'],/^pytest (\S+)/],java:['/opt/java/openjdk/bin/java',['-version'],/(?:openjdk|java) version "([^"]+)"/],javac:['/opt/java/openjdk/bin/javac',['-version'],/^javac (\S+)/],maven:['/usr/share/maven/bin/mvn',['--version'],/Apache Maven (\S+)/]};
if(process.argv.length<3 || process.argv.slice(2).some(n=>!Object.hasOwn(checks,n))) throw new Error('Explicit allowlisted tools required');
const tools=[];
for(const name of process.argv.slice(2)) {
 const [exe,args,pattern]=checks[name],r=spawnSync(exe,args,{shell:false,encoding:'utf8',timeout:10000,maxBuffer:65536,env:{PATH:'/opt/paircoach/node/bin:/opt/java/openjdk/bin:/usr/share/maven/bin:/usr/local/bin:/usr/bin:/bin',JAVA_HOME:'/opt/java/openjdk',HOME:'/workspace/.paircoach/runtime/home',PYTHONPATH:'/cache/0/site-packages',PYTEST_DISABLE_PLUGIN_AUTOLOAD:'1'}});
 if(r.error||r.status!==0) throw new Error(`Tool unavailable: ${name}`);
 const raw=(r.stdout+r.stderr).replace(/\u001b\[[0-9;]*m/g,''), version=raw.match(pattern)?.[1];
 if(!version) throw new Error(`Unrecognized actual version: ${name}`); tools.push({name,version,raw});
}
console.log(JSON.stringify({tools}));
