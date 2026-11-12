import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectArchitecture, isProtectedFile, type Finding } from './oracle';

const root = 'src/components/Probe.tsx';
function scan(code: string, extra: Record<string, string> = {}) {
  return inspectArchitecture(new Map(Object.entries({ [root]: code, ...extra })), [root]);
}
function rejects(code: string, rule: Finding['rule'], extra: Record<string, string> = {}) {
  const findings = scan(code, extra);
  assert.ok(findings.some(f => f.rule === rule), JSON.stringify(findings));
  assert.ok(findings.every(f => f.root === root && f.line > 0 && f.column > 0 && f.chain[0] === root));
  return findings;
}

test('policy includes actual GUI, core, Runner, bridge and transport boundaries, not startup composition', () => {
  for (const file of [root, 'src/components/nested/View.tsx', 'src/App.tsx',
    'src/server/WriteGate.ts', 'src/server/SessionController.ts', 'src/server/WorkspaceService.ts',
    'src/server/Runner.ts', 'src/services/monacoLspBridge.ts', 'src/services/LiveBackend.ts', 'src/services/PairCoachClient.ts']) assert.equal(isProtectedFile(file), true, file);
  assert.equal(isProtectedFile('src/server/index.ts'), false);
  assert.equal(isProtectedFile('src/server/runtime-adapters/java.ts'), false);
});

for (const [name, code, rule, files] of [
  ['direct adapter import with alias', `import {build as b} from '../server/runtime-adapters/index'; b();`, 'implementation-import', {'src/server/runtime-adapters/index.ts': 'export function build() {}'}],
  ['namespace executor import', `import * as engine from '../server/execution/DockerExecutor'; engine.start();`, 'implementation-import', {'src/server/execution/DockerExecutor.ts': 'export function start() {}'}],
  ['external Docker implementation', `import Factory from 'dockerode'; new Factory();`, 'implementation-import', {}],
  ['implementation types are not neutral ports', `import type {DockerExecutor} from '../server/execution/DockerExecutor'; type X = DockerExecutor;`, 'implementation-import', {'src/server/execution/DockerExecutor.ts': 'export interface DockerExecutor {}'}],
  ['barrel reexport', `export {build as renamed} from '../barrel';`, 'implementation-import', {'src/barrel.ts': `export * from './server/runtime-adapters/java';`, 'src/server/runtime-adapters/java.ts': 'export function build() {}'}],
  ['side effect transitive dependency', `import '../helper';`, 'implementation-import', {'src/helper.ts': `import './server/language/jdt';`, 'src/server/language/jdt.ts': 'export const start = 1;'}],
  ['dynamic literal import', `export const go = () => import('../server/execution/docker');`, 'implementation-import', {'src/server/execution/docker.ts': 'export const x = 1;'}],
  ['dynamic alias and concatenation', `const dir='../server/'; const target=dir+'runtime-adapters/python'; export const go=()=>import(target);`, 'implementation-import', {'src/server/runtime-adapters/python.ts': 'export const x = 1;'}],
  ['dynamic template', 'const part="runtime-adapters/python"; export const go=()=>import(`../server/${part}`);', 'implementation-import', {'src/server/runtime-adapters/python.ts': 'export const x = 1;'}],
  ['dynamic conditional includes forbidden branch', `declare const active:boolean; const target=active?'../safe':'../server/runtime-adapters/java'; import(target);`, 'implementation-import', {'src/safe.ts': '', 'src/server/runtime-adapters/java.ts': ''}],
  ['unbounded dynamic module fails closed', `declare const target:string; export const go=()=>import(target);`, 'computed-import', {}],
  ['require alias', `const loader=require; loader('../server/runtime-adapters/python');`, 'implementation-import', {'src/server/runtime-adapters/python.ts': ''}],
  ['import equals require', `import Exec = require('../server/execution/DockerExecutor');`, 'implementation-import', {'src/server/execution/DockerExecutor.ts': ''}],
  ['path alias resolved rather than ignored', `import {x} from '@/src/barrel'; x();`, 'implementation-import', {'src/barrel.ts': `export {x} from './server/runtime-adapters/java';`, 'src/server/runtime-adapters/java.ts': 'export const x=()=>{};'}],
  ['host spawn import alias', `import {spawn as invoke} from 'node:child_process'; invoke(profile.executable, []);`, 'host-execution', {}],
  ['host spawn transitive helper', `import {go} from '../helper'; go();`, 'host-execution', {'src/helper.ts': `import * as proc from 'child_process'; export const go=()=>proc.spawn('java');`}],
  ['unresolved relative import fails closed', `import {x} from '../missing'; x();`, 'unresolved-import', {}],
] as const) test(name, () => { rejects(code, rule, files); });

for (const [name, code] of [
  ['Spring task variant dispatch', `if(task.entry.kind==='SPRING_BOOT') runSpring();`],
  ['boolean alias', `const supported=profile.family==='python'; if(supported) runPython();`],
  ['enum selector', `enum K {Java='java'}; if(profile.family===K.Java) runTask();`],
  ['language comparison', `if (document.languageId === 'java') runTask();`],
  ['alias of language selector', `const selected = profile.adapterFamily; const other = selected; if(other === 'python') runTask();`],
  ['destructured alias', `const {adapterFamily: selected} = profile; if(selected === 'java') runTask();`],
  ['literal constant alias', `const kind = 'java'; if(profile.family===kind) runTask();`],
  ['object constant alias', `const kinds={j:'java'} as const; if(profile.family===kinds.j) runTask();`],
  ['reversed comparison and negation', `if ('SPRING_BOOT' !== task.kind && profile.language==='python') runTask();`],
  ['ternary', `const command=profile.family==='java' ? buildJava() : buildPython();`],
  ['switch', `switch(profile.adapterFamily) {case 'java': runJava(); break; case 'python': runPython();}`],
  ['short circuit', `profile.family==='python' && runPython();`],
  ['array includes', `const families=['java','python']; if(families.includes(profile.family)) runTask();`],
  ['prefix selection', `if(profile.profileId.startsWith('java-')) runJava();`],
  ['regex selector', `if (/java|python/.test(profile.family)) runTask();`],
  ['bracket property', `if(profile['adapterFamily']==='python') runTask();`],
] as const) test(name, () => { rejects(code, 'language-condition'); });

for (const [name, code] of [
  ['callable dispatch map', `const handlers={java: javaRun, python: pythonRun}; handlers[profile.family]();`],
  ['aliased callable dispatch map', `const handlers={java: javaRun}; const f=handlers[profile.family]; f();`],
  ['tool command alias', `const tool='mvn'; start(tool, ['test']);`],
  ['concrete executor construction', `new DockerExecutor(options);`],
] as const) test(name, () => { rejects(code, 'tool-dispatch'); });

for (const [name, code, files] of [
  ['comments and JSX labels are not code dependencies', `// import Docker from 'dockerode'; if(language==='java') mvn();\n/** python Maven Spring */\nexport const label=<span title="docker">Java / Python / Spring Boot</span>;`, {}],
  ['literal metadata is not runtime dispatch', `const profile={label:'Java', family:'java', taskFields:[{label:'Python', key:'main'}]}; const commandExample='mvn test';`, {}],
  ['neutral data-driven task fields', `export const View=({profile})=><>{profile.taskFields.map(f=><label key={f.key}>{f.label}</label>)}</>;`, {}],
  ['display label condition is not language dispatch', `if(profile.label==='java') display(profile.label);`, {}],
  ['syntax-coloring extension metadata', `const extensions={'.java':'java','.py':'python'}; function color(path){if(path.endsWith('.java')) return 'java'; return extensions[path];}`, {}],
  ['label spelling is scoped rather than grep', `const language='label'; if(language==='java') display(language);`, {}],
  ['local function named require is not module loader', `function require(label:string){return label}; require('dockerode');`, {}],
  ['shadowed loader parameter is not Node require', `function show(require:(s:string)=>void){ require('dockerode'); }`, {}],
  ['type-only neutral DTO imports', `import type {RuntimeProfile} from '../shared/runtime-v2'; import {type LanguageView} from '../shared/language-v2';`, {'src/shared/runtime-v2.ts': 'export interface RuntimeProfile {}', 'src/shared/language-v2.ts': 'export interface LanguageView {}'}],
  ['neutral Execution/Language ports', `import type {ExecutionPort} from '../server/execution/ports'; import type * as L from '../server/language/ports';`, {'src/server/execution/ports.ts': 'export interface ExecutionPort {}', 'src/server/language/ports.ts': 'export interface LanguageFeaturesPort {}'}],
  ['type-only reexport does not create runtime helper edge', `export {type ExecutionPort} from '../server/execution/ports';`, {'src/server/execution/ports.ts': 'export interface ExecutionPort {}'}],
  ['type-only namespace and import type syntax', `import type * as DTO from '../shared/runtime-v2'; type X=import('../shared/runtime-v2').RuntimeProfile;`, {'src/shared/runtime-v2.ts': 'export interface RuntimeProfile {}'}],
  ['neutral delegation through injected port', `export function start(port, plan){return port.start(plan)};`, {}],
  ['unreachable approved startup composition', `export const value='data';`, {'src/server/index.ts': `import {DockerExecutor} from './execution/DockerExecutor'; const e=new DockerExecutor();`, 'src/server/execution/DockerExecutor.ts': 'export class DockerExecutor {}'}],
  ['type-only helper does not transitively create runtime import', `import type {View} from '../view';`, {'src/view.ts': `import 'dockerode'; export interface View {}` }],
] as const) test(name, () => assert.deepEqual(scan(code, files), []));

test('mixed type/value import still follows runtime reexports', () => {
  rejects(`import { type T, start } from '../helper'; start();`, 'implementation-import', {
    'src/helper.ts': `export type T={}; export {start} from './server/runtime-adapters/java';`,
    'src/server/runtime-adapters/java.ts': 'export const start=()=>{};',
  });
});
test('cycle terminates and reports exact offending file/location/chain', () => {
  const findings=rejects(`import '../a';`, 'implementation-import', {
    'src/a.ts': `import './b';`, 'src/b.ts': `import './a';\nimport 'dockerode';`,
  });
  const f=findings.find(f=>f.rule==='implementation-import')!;
  assert.deepEqual(f.chain,[root,'src/a.ts','src/b.ts']);
  assert.equal(f.file,'src/b.ts'); assert.equal(f.line,2); assert.equal(f.column,1);
});

test('aliased imported selector literal resolves through actual TypeScript binding', () => {
  rejects(`import {JAVA as TARGET} from '../values'; if(profile.family===TARGET) go();`, 'language-condition', {'src/values.ts': `export const JAVA='java';`});
});
test('neutral JSON contract is data, not an unresolved executable module', () => {
  assert.deepEqual(scan(`import schema from '../shared/contract.json'; export const fields=schema.properties;`, {'src/shared/contract.json': '{"properties":{"language":{"enum":["java","python"]}}}'}), []);
});
test('invalid syntax is never a clean architecture verdict', () => {
  assert.throws(()=>scan(`export function (`), /syntactically invalid/);
});

test('runtime helper hidden in shared is not exempt from conditions', () => {
  rejects(`import '../shared/helper';`, 'language-condition', {'src/shared/helper.ts': `if(profile.family==='java') runTask();`});
});
test('central DTO validator is allowed to validate data, never to dispatch tools', () => {
  assert.deepEqual(scan(`import '../shared/validation-v2';`, {'src/shared/validation-v2.ts': `export const valid=(p)=>p.adapterFamily==='java-maven';`}), []);
  rejects(`import '../shared/validation-v2';`, 'tool-dispatch', {'src/shared/validation-v2.ts': `start('mvn');`});
});
test('JS extension substitution and directory barrels follow real compiler modules', () => {
  rejects(`import '../barrel/index.js';`, 'implementation-import', {'src/barrel/index.ts': `export * from '../server/runtime-adapters/java';`, 'src/server/runtime-adapters/java.ts': ''});
});
test('type-only import equals ports is permitted', () => {
  assert.deepEqual(scan(`import type E = require('../server/execution/ports');`, {'src/server/execution/ports.ts': 'export interface ExecutionPort {}'}), []);
});
test('neutral string metadata lookup is not callable dispatch', () => {
  assert.deepEqual(scan(`const labels={java:'Java',python:'Python'}; display(labels[profile.family]);`), []);
});

test('external Python/Spring runtime imports are actual module identities, not labels', () => {
  rejects(`import {PythonShell as Runner} from 'python-shell';`, 'implementation-import');
  rejects(`import start from '@runtime/spring-boot';`, 'implementation-import');
});
test('explicit absolute tool executable dispatch is detected without source text matching', () => {
  rejects(`execute('/usr/bin/mvn', ['test']);`, 'tool-dispatch');
});
