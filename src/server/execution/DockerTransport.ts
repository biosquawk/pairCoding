import {
  spawn
} from 'node:child_process';
import * as fs from 'node:fs/promises';
import {
  canonicalDirectory, requireThat
} from './files';
export interface DockerReply {
  exitCode:number;
  stdout:string;
  stderr:string
}
/** Injected transport fakes prove unit behavior ONLY. Production default uses this shell:false CLI. */
export interface DockerTransport {
  run(args:readonly string[], options?:{
    timeoutMs?:number;
    maxBytes?:number
  }):Promise<DockerReply>
}
export class DockerCliTransport implements DockerTransport {
  constructor(readonly executable:string, readonly environment:Readonly<Record<string,string>>) {
    requireThat(executable.startsWith('/') || /^[A-Z]:[\\/]/i.test(executable),'Use absolute approved Docker executable');
    requireThat(Object.keys(environment).every(k=>['PATH','SystemRoot','WINDIR','DOCKER_HOST','DOCKER_CONFIG'].includes(k)),'Unapproved CLI environment');
    requireThat(typeof environment.DOCKER_CONFIG==='string'&&environment.DOCKER_CONFIG.length>0,'Dedicated empty DOCKER_CONFIG required');
    // DOCKER_CONFIG must be a dedicated credential-free directory, never a personal home/config.
  }
  async run(args:readonly string[], options:{
    timeoutMs?:number;
    maxBytes?:number
  }
  ={
  }):Promise<DockerReply> {
    await canonicalDirectory(this.environment.DOCKER_CONFIG);
    requireThat((await fs.readdir(this.environment.DOCKER_CONFIG)).length===0,'DOCKER_CONFIG must be an empty dedicated credential-free directory');
    const timeout=options.timeoutMs??10000,max=options.maxBytes??1024*1024;
    requireThat(timeout>0&&timeout<=30000&&max>0&&max<=16*1024*1024,'CLI bounds');
    return new Promise((resolve,reject)=>{
      const child=spawn(this.executable,[...args],{
        shell:false,env:{
          ...this.environment
        },stdio:['ignore','pipe','pipe'],windowsHide:true
      });
      const stdout:Buffer[]=[],stderr:Buffer[]=[];
      let size=0,failure:Error|null=null;
      const fail=(e:Error)=>{
        if(!failure){
          failure=e;
          child.kill('SIGKILL');
        }
      };
      const timer=setTimeout(()=>fail(new Error('Docker CLI timeout; operation outcome UNKNOWN, reconcile by inspect')),timeout);
      child.stdout.on('data',(b:Buffer)=>{
        size+=b.length;
        if(size>max)fail(new Error('Docker CLI output limit; operation outcome UNKNOWN'));
        else stdout.push(b);
      });
      child.stderr.on('data',(b:Buffer)=>{
        size+=b.length;
        if(size>max)fail(new Error('Docker CLI output limit; operation outcome UNKNOWN'));
        else stderr.push(b);
      });
      child.on('error',e=>{
        failure=e;
      });
      child.on('close',code=>{
        clearTimeout(timer);
        if(failure)reject(failure);
        else resolve({
          exitCode:code??-1,stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8')
        });
      });
    });
  }
}
