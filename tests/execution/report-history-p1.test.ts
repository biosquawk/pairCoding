import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ReportService, type FrozenFacts } from '../../src/server/ReportService';

const digest = (s: string) => createHash('sha256').update(s).digest('hex');
function facts(sessionId: string, projectId = 'project-a'): FrozenFacts {
  return {
    session: {sessionId,projectId,lifecycle:'FINISHED',workspaceVersion:1,timer:{elapsedMs:0}} as any,
    snapshot:{snapshotId:'snapshot-'+sessionId,projectId,workspaceVersion:1} as any,
    runs:[],chat:[],events:[],aiConsent:false,
  };
}
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-history-p1-'));
  const services: ReportService[] = [];
  const service = (projectId?: string, emit = (_type: string, _payload: unknown) => {}) => {
    const s = new ReportService({dataDir:root, projectId, emit}); services.push(s); return s;
  };
  t.after(() => {services.forEach(s => s.close()); fs.rmSync(root,{recursive:true,force:true});});
  const dir = (sessionId: string) => path.join(root,'reports',digest(sessionId));
  return {root, service, dir};
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

// Windows file symlinks require privileges; a real directory junction at the same
// file slot exercises rejection before warm-cache use without Developer Mode.
// POSIX retains the exact file-symlink attack as well. No mocked filesystem.
function linkOutsideFile(target: string, link: string) {
  const destination = process.platform === 'win32' ? path.dirname(target) : target;
  fs.symlinkSync(destination, link, process.platform === 'win32' ? 'junction' : 'file');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(link), fs.realpathSync(destination));
}
const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';

test('history shares a dataDir safely: scoped reads/list/finish and warm cache enforce both frozen project IDs', async t => {
  const f=fixture(t), a=f.service('project-a'), b=f.service('project-b');
  const first=a.finish('COMPLETED',facts('a')), foreign=b.finish('COMPLETED',facts('b','project-b'));
  await flush();
  assert.equal(a.get('a').reportId,first.reportId);
  assert.throws(()=>a.get('b'),{code:'REPORT_NOT_FOUND'});
  assert.throws(()=>b.get('a'),{code:'REPORT_NOT_FOUND'});
  assert.throws(()=>a.finish('COMPLETED',facts('wrong','project-b')),{code:'REPORT_NOT_FOUND'});
  assert.deepEqual(a.list().map(r=>r.sessionId),['a']);
  assert.deepEqual(b.list().map(r=>r.reportId),[foreign.reportId]);
  assert.deepEqual(Object.keys(a.list()[0]).sort(),['reportId','sessionId','status','reason','sourceWorkspaceVersion','snapshotId','generatedAt'].sort());
  const file=path.join(f.dir('a'),'facts.json'), original=fs.readFileSync(file,'utf8');
  for (const mode of ['both','snapshot-only']) {
    const material=facts('a',mode==='both'?'project-b':'project-a');
    material.snapshot.projectId='project-b';
    const serialized=JSON.stringify(material);
    fs.writeFileSync(file,JSON.stringify({sha256:digest(serialized),serialized}));
    assert.throws(()=>a.get('a'),{code:'REPORT_NOT_FOUND'},'warm cache cannot override current persisted ownership');
    assert.equal(a.list().length,0);
  }
  fs.writeFileSync(file,original);
  assert.equal(a.get('a').reportId,first.reportId);
});

test('history validates containment before cache, excludes unsafe/corrupt/orphan entries and never traverses invalid IDs', async t => {
  const f=fixture(t), s=f.service('project-a');
  s.finish('COMPLETED',facts('a')); await flush();
  const original=s.get('a');
  for (const bad of ['', '../a','/absolute','a/b','%2e%2e']) assert.throws(()=>s.get(bad),{code:'INVALID_ID'});
  assert.throws(()=>s.get('missing'),{code:'REPORT_NOT_FOUND'});
  assert.equal(fs.existsSync(f.dir('missing')),false,'read must not create history entries');
  const outside=path.join(f.root,'outside');fs.mkdirSync(outside);
  const reportPath=path.join(f.dir('a'),'report.json'), saved=fs.readFileSync(reportPath);
  fs.writeFileSync(path.join(outside,'report.json'),saved);
  fs.unlinkSync(reportPath);linkOutsideFile(path.join(outside,'report.json'),reportPath);
  assert.throws(()=>s.get('a'),{code:'UNSAFE_REPORT_STORAGE'});assert.deepEqual(s.list(),[]);
  fs.unlinkSync(reportPath);fs.writeFileSync(reportPath,saved);
  const factsPath=path.join(f.dir('a'),'facts.json'), savedFacts=fs.readFileSync(factsPath);
  fs.writeFileSync(path.join(outside,'facts.json'),savedFacts);
  fs.unlinkSync(factsPath);linkOutsideFile(path.join(outside,'facts.json'),factsPath);
  assert.throws(()=>s.get('a'),{code:'UNSAFE_REPORT_STORAGE'});assert.deepEqual(s.list(),[]);
  fs.unlinkSync(factsPath);fs.writeFileSync(factsPath,savedFacts);
  fs.renameSync(f.dir('a'),f.dir('a')+'.saved');fs.symlinkSync(outside,f.dir('a'),directoryLinkType);
  assert.throws(()=>s.get('a'),{code:'UNSAFE_REPORT_STORAGE'});assert.deepEqual(s.list(),[]);
  fs.unlinkSync(f.dir('a'));fs.renameSync(f.dir('a')+'.saved',f.dir('a'));
  const orphan=f.dir('orphan');fs.mkdirSync(orphan);fs.writeFileSync(path.join(orphan,'facts.json'),savedFacts);
  assert.equal(s.list().length,1);assert.equal(fs.existsSync(path.join(orphan,'report.json')),false);
  fs.writeFileSync(reportPath,'{}');assert.deepEqual(s.list(),[]);
  fs.writeFileSync(reportPath,saved);assert.deepEqual(s.get('a'),original);
  const reports=path.join(f.root,'reports');fs.renameSync(reports,reports+'.saved');fs.symlinkSync(outside,reports,directoryLinkType);
  assert.throws(()=>s.get('a'),{code:'UNSAFE_REPORT_STORAGE'});assert.throws(()=>s.list(),{code:'UNSAFE_REPORT_STORAGE'});
  fs.unlinkSync(reports);fs.renameSync(reports+'.saved',reports);
  assert.deepEqual(fs.readFileSync(path.join(outside,'report.json')),saved,'outside report never modified');
  assert.deepEqual(fs.readFileSync(path.join(outside,'facts.json')),savedFacts,'outside facts never modified');
});

test('historical restart PENDING becomes REPORT_INTERRUPTED preserving facts/identity; explicit retry uses same facts', async t => {
  const f=fixture(t), s=f.service('project-a');
  const report=s.finish('ABANDONED',facts('interrupted'));await flush();s.close();
  const reportPath=path.join(f.dir('interrupted'),'report.json'), stored=JSON.parse(fs.readFileSync(reportPath,'utf8'));
  stored.status='PENDING';stored.generatedAt=null;stored.markdown=null;fs.writeFileSync(reportPath,JSON.stringify(stored));
  const before=fs.readFileSync(path.join(f.dir('interrupted'),'facts.json'),'utf8');
  const recovered=f.service('project-a'), failed=recovered.get('interrupted');
  assert.equal(failed.reportId,report.reportId);assert.equal(failed.error?.code,'REPORT_INTERRUPTED');
  assert.equal(recovered.list()[0].status,'FAILED');assert.equal(recovered.retry('interrupted').reportId,report.reportId);
  await flush();assert.equal(recovered.get('interrupted').status,'READY');
  assert.equal(fs.readFileSync(path.join(f.dir('interrupted'),'facts.json'),'utf8'),before);
});
