#!/usr/bin/env python3
"""One host operator execution only AFTER K safety read/reservation. No Docker mutations.
Preflight hashes code/JSON witnesses, not cache payload/source workload. No timeout/kill/retry.
"""
from pathlib import Path
import argparse,datetime,hashlib,json,os,signal,stat,subprocess,sys,time,traceback
HERE=Path(__file__).resolve().parent
h=lambda b:hashlib.sha256(b).hexdigest()
now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
def regular(p):
 s=p.lstat();assert stat.S_ISREG(s.st_mode) and not stat.S_ISLNK(s.st_mode),str(p);return s
def canonical_dir(p):
 assert p.is_absolute() and p.resolve()==p and p.is_dir(),str(p)
def exclusive_json(p,obj):
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:
  os.write(fd,(json.dumps(obj,indent=2)+'\n').encode());os.fsync(fd)
 finally:os.close(fd)
def main():
 assert sys.platform=='linux','This scoped observation is WSL Linux, NOT native Windows'
 spec=json.loads((HERE/'input-plan.json').read_text());freeze=json.loads((HERE/'freeze.json').read_text())
 parser=argparse.ArgumentParser();parser.add_argument('--node',default=spec['node']);parser.add_argument('--loader',default=spec['loader']);parser.add_argument('--docker',default=spec['dockerExecutable']);parser.add_argument('--output',default=spec['defaultOutput']);args=parser.parse_args()
 assert args.docker==spec['dockerExecutable'],'Only admitted absolute existing OCI executable; no shell/host fallback'
 # Executable/loader may be supplied for existing installation only; source, policy, data and clocks fixed.
 for p in [Path(args.node),Path(args.loader),Path(args.docker)]:assert p.is_absolute() and p.is_file(),str(p)
 assert subprocess.check_output([args.node,'--version'],env={'PATH':'/usr/bin:/bin'},text=True).strip()=='v22.22.0'
 assert h(Path(args.loader).read_bytes())==freeze['loaderSHA256']
 assert h(Path(spec['sourceManifest']).read_bytes())==freeze['sourceManifestSHA256']
 for rel,sha in freeze['files'].items():
  p=HERE/rel;regular(p);assert h(p.read_bytes())==sha,rel
 repo=Path(spec['repo']);canonical_dir(repo)
 assert subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip()==spec['revision']
 assert subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD^{tree}'],text=True).strip()==spec['tree']
 source_manifest=json.loads(Path(spec['sourceManifest']).read_text());assert len(source_manifest['files'])==532
 for f in source_manifest['files']:
  p=repo/f['path'];regular(p);assert h(p.read_bytes())==f['sha256'],f['path']
 assert subprocess.check_output(['git','-C',str(repo),'diff','--name-only'],text=True)==''
 module_link=Path(spec['nodeModulesParentLink']);assert module_link.is_symlink() and module_link.resolve()==Path(spec['nodeModules'])
 for f in spec['producerWitnesses']:
  p=Path(f['path']);regular(p);assert p.stat().st_size==f['bytes'] and h(p.read_bytes())==f['sha256'],str(p)
 # No recursive tree/source/cache pre-read, no docker preflight/warmup. Production selected path
 # performs live readonly info/inspect with the actual held gate DURING measurement.
 out=Path(args.output);parent=Path(spec['outputParent']);canonical_dir(parent)
 assert out==Path(spec['defaultOutput']) and out.parent==parent
 canonical_dir(out);assert list(out.iterdir())==[],'Nonempty output means reconcile, never overwrite/retry'
 canonical_dir(Path(spec['tmpdir']));canonical_dir(Path(spec['dockerConfig']));assert list(Path(spec['dockerConfig']).iterdir())==[]
 claim=out/'one-shot-intent.json'
 argv=[args.node,'--import',args.loader,str(HERE/'fullpath.mjs'),str(HERE/'input-plan.json'),str(out),args.docker]
 started=now();clock=time.monotonic();proof={'status':'INTENT_BEFORE_CHILD','workId':spec['workId'],'executionId':spec['executionId'],'revision':spec['revision'],'tree':spec['tree'],'freezeSHA256':h((HERE/'freeze.json').read_bytes()),'argv':argv,'cwd':str(repo),'output':str(out),'startedUTC':started,'preflight':'code+11 existing JSON witnesses only, no cache/source payload pre-read','policy':'ONE process, no timeout, no kill, no retry; inspect same marker/raw after UNKNOWN'}
 exclusive_json(claim,proof)
 env={'PATH':'/usr/bin:/bin','TMPDIR':spec['tmpdir'],'TSX_DISABLE_CACHE':'1','PAIRCOACH_MEASUREMENT_OPERATOR':'ONE_A8_HOST_REVIEWED'}
 proof['env']=env;exclusive_json(out/'runner-start.json',proof)
 def observe_signal(signum,_frame):
  with (out/'interrupt-observation.jsonl').open('a') as f:f.write(json.dumps({'signal':signum,'utc':now(),'action':'Observed only; child not signalled, continue wait/drain'})+'\n')
 signal.signal(signal.SIGINT,observe_signal);signal.signal(signal.SIGTERM,observe_signal)
 child=None
 try:
  with (out/'execute.stdout').open('xb') as stdout,(out/'execute.stderr').open('xb') as stderr:
   child=subprocess.Popen(argv,cwd=repo,env=env,stdout=stdout,stderr=stderr,start_new_session=True)
   exclusive_json(out/'child-identity.json',{'pid':child.pid,'utc':now(),'argv':argv})
   code=child.wait() # deliberately NO timeout, terminate, kill or subprocess retry
  exclusive_json(out/'runner-terminal.json',{'startedUTC':started,'endedUTC':now(),'elapsedSecondsIncludingNodeImportsAndFinalEmission':time.monotonic()-clock,'exitCode':code,'childPid':child.pid,'childExited':True,'scenarioTerminalPresent':(out/'measurement-terminal.json').is_file(),'measurementStarted':(out/'measurement-start.json').is_file(),'noRetry':True})
  print(json.dumps({'exitCode':code,'output':str(out),'claim':str(claim)}));return code
 except BaseException as error:
  # If a child exists, never abandon IO/lease/ownership on a wrapper exception.
  code=child.wait() if child is not None else None
  exclusive_json(out/'runner-error.json',{'utc':now(),'error':repr(error),'traceback':traceback.format_exc(),'childExitCode':code,'childStarted':child is not None,'doNotRetry':True})
  raise
if __name__=='__main__':
 try:sys.exit(main())
 except Exception:
  traceback.print_exc();sys.exit(2)
