import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { inspectArchitecture, readSources, type Finding } from './oracle';

const adapter = 'src/services/builtinLanguageRegistry.ts';
const gui = 'src/components/LocalWorkerProbe.tsx';
// Read real production text and its dependency closure, never a hand-written adapter mock.
// The repository-wide test remains separate and unchanged.
const actual = readSources(fileURLToPath(new URL('../../', import.meta.url)));
const source = actual.get(adapter)!;
const selection = "const getter=language==='javascript'?monaco.typescript.getJavaScriptWorker:monaco.typescript.getTypeScriptWorker;";
assert.ok(source.includes(selection), 'Actual local worker selection must be exercised');
const entry = `import '../services/builtinLanguageRegistry';`;
const lineOf = (text: string, fragment: string) => {
  assert.ok(fragment && text.includes(fragment), `Missing injected source: ${fragment}`);
  return text.slice(0, text.indexOf(fragment)).split('\n').length;
};
function scan(text = source, extra: Record<string, string> = {}, root = gui) {
  return inspectArchitecture(new Map([...actual, [gui, entry], [adapter, text], ...Object.entries(extra)]), [root]);
}

test('actual adapter JS/TS Monaco getters are local editor configuration through a GUI runtime edge', () => {
  assert.deepEqual(scan(), []);
});

// Each injection coexists with the permitted getter in the SAME adapter. Checking
// the injected location/rule prevents that old false positive from masking a missed guard.
const violations: {name: string; rule: Finding['rule']; body: string; prefix?: string; extra?: Record<string, string>; file?: string; fragment?: string}[] = [
  {name: 'runtime implementation import', rule: 'implementation-import', body: '', prefix: `import '@/src/server/runtime-adapters/probe';`, extra: {'src/server/runtime-adapters/probe.ts': 'export const value=1;'}},
  {name: 'host execution', rule: 'host-execution', body: `invoke('java');`, prefix: `import {spawn as invoke} from 'node:child_process';`},
  {name: 'tool executable', rule: 'tool-dispatch', body: `execute('mvn', ['test']);`},
  {name: 'Java runtime predicate', rule: 'language-condition', body: `if(profile.family==='java') runTask();`},
  {name: 'Python runtime predicate', rule: 'language-condition', body: `if(profile.family==='python') runTask();`},
  {name: 'JS runtime predicate is not the local getter', rule: 'language-condition', body: `if(profile.family==='javascript') runTask();`},
  {name: 'TS runtime predicate is not the local getter', rule: 'language-condition', body: `if(profile.family==='typescript') runTask();`},
  {name: 'selector alias', rule: 'language-condition', body: `const selected=profile.family; if(selected==='java') runTask();`},
  {name: 'destructured selector alias', rule: 'language-condition', body: `const {family:selected}=profile; if(selected==='python') runTask();`},
  {name: 'imported literal alias', rule: 'language-condition', prefix: `import {TARGET as selectedTarget} from '@/src/localWorkerValues';`, body: `if(profile.family===selectedTarget) runTask();`, fragment: 'if(profile.family===selectedTarget)', extra: {'src/localWorkerValues.ts': `export const TARGET='python';`}},
  {name: 'helper predicate', rule: 'language-condition', prefix: `import '@/src/localWorkerHelper';`, body: '', file: 'src/localWorkerHelper.ts', fragment: `if(profile.family`, extra: {'src/localWorkerHelper.ts': `if(profile.family==='java') runTask();`}},
  {name: 'reexported predicate helper', rule: 'language-condition', prefix: `export * from '@/src/localWorkerBarrel';`, body: '', file: 'src/localWorkerHelper.ts', fragment: `if(profile.family`, extra: {'src/localWorkerBarrel.ts': `export * from './localWorkerHelper';`, 'src/localWorkerHelper.ts': `export const task=()=>{if(profile.family==='python') runTask();};`}},
  {name: 'reexported runtime implementation', rule: 'implementation-import', prefix: `export * from '@/src/localWorkerBarrel';`, body: '', file: 'src/localWorkerBarrel.ts', fragment: 'export *', extra: {'src/localWorkerBarrel.ts': `export * from './server/runtime-adapters/probe';`, 'src/server/runtime-adapters/probe.ts': 'export const task=()=>{};'}},
  {name: 'aliased host helper', rule: 'host-execution', prefix: `import {go as renamed} from '@/src/localWorkerHelper';`, body: `renamed();`, file: 'src/localWorkerHelper.ts', fragment: 'import ', extra: {'src/localWorkerHelper.ts': `import {spawn as invoke} from 'node:child_process'; export const go=()=>invoke('java');`}},
  {name: 'computed module target', rule: 'computed-import', body: `import(profile.moduleTarget);`},
  {name: 'missing module target', rule: 'unresolved-import', body: `import('@/src/missingLocalWorkerRuntime');`},
  {name: 'language keyed callable map', rule: 'tool-dispatch', body: `const handlers={java:runJava,python:runPython}; handlers[profile.family]();`},
  {name: 'runtime switch', rule: 'language-condition', body: `switch(profile.family){case 'java':runTask();}`},
  {name: 'membership predicate', rule: 'language-condition', body: `if(['java','python'].includes(profile.family))runTask();`},
];
for (const v of violations) for (const location of ['adapter', 'GUI'] as const) {
  test(`${location} retains ${v.name}`, () => {
    const target = location === 'adapter' ? adapter : gui;
    const injected = location === 'adapter'
      ? `${v.prefix ?? ''}\n${source.replace(selection, `${v.body}\n    ${selection}`)}`
      : `${v.prefix ?? ''}\n${entry}\nexport function probe(profile){${v.body}}`;
    const inputs = {...v.extra, [target]: injected};
    const findings = scan(location === 'adapter' ? injected : source, inputs);
    const file = v.file ?? target;
    const fragment = v.fragment ?? v.prefix ?? v.body;
    const line = lineOf(file === target ? injected : inputs[file], fragment);
    assert.ok(findings.some(f => f.rule === v.rule && f.file === file && f.line === line), JSON.stringify(findings));
    assert.ok(findings.every(f => f.root === gui && f.chain[0] === gui));
    if (location === 'adapter') assert.ok(findings.some(f => f.rule === v.rule && f.chain.includes(adapter)));
  });
}

// Fail closed on lookalikes. No aliases, helper selectors, broadened languages,
// custom getter receiver or computed/optional getter access inherits the exception.
const lookalikes: [string, (s: string) => string][] = [
  ['non-Monaco receiver', s => s.replaceAll('monaco.typescript.get', 'runtime.typescript.get')],
  ['aliased receiver', s => s.replace(selection, `const alias=monaco; ${selection.replaceAll('monaco.typescript.get', 'alias.typescript.get')}`)],
  ['shadowed receiver', s => s.replace(selection, `const monaco=runtime; ${selection}`)],
  ['wrong namespace import', s => s.replace("from 'monaco-editor'", "from 'some-editor'")],
  ['untyped receiver', s => s.replace('monaco:typeof M', 'monaco:any')],
  ['wrong namespace type', s => s.replace('monaco:typeof M', 'monaco:typeof Runtime')],
  ['broadened Java parameter', s => s.replace("workerFor=(language:'javascript'|'typescript')", "workerFor=(language:'javascript'|'typescript'|'java')")],
  ['broadened Python parameter', s => s.replace("workerFor=(language:'javascript'|'typescript')", "workerFor=(language:'javascript'|'typescript'|'python')")],
  ['string parameter', s => s.replace("workerFor=(language:'javascript'|'typescript')", 'workerFor=(language:string)')],
  ['single-language parameter', s => s.replace("workerFor=(language:'javascript'|'typescript')", "workerFor=(language:'javascript')")],
  ['selector alias', s => s.replace(selection, `const selected=language; ${selection.replace("language===", "selected===")}`)],
  ['swapped getters', s => s.replace(selection, selection.replace('getJavaScriptWorker', 'temporary').replace('getTypeScriptWorker', 'getJavaScriptWorker').replace('temporary', 'getTypeScriptWorker'))],
  ['one wrong getter', s => s.replace('getTypeScriptWorker;', 'getRuntimeWorker;')],
  ['duplicate getter', s => s.replace('getTypeScriptWorker;', 'getJavaScriptWorker;')],
  ['getter call instead of getter reference', s => s.replace('getTypeScriptWorker;', 'getTypeScriptWorker();')],
  ['computed getter', s => s.replace('monaco.typescript.getTypeScriptWorker;', "monaco.typescript['getTypeScriptWorker'];")],
  ['optional getter', s => s.replace('monaco.typescript.getTypeScriptWorker;', 'monaco.typescript?.getTypeScriptWorker;')],
  ['runtime condition', s => s.replace("const getter=language==='javascript'", "const getter=profile.language==='javascript'")],
  ['Java condition', s => s.replace("const getter=language==='javascript'", "const getter=language==='java'")],
  ['Python condition', s => s.replace("const getter=language==='javascript'", "const getter=language==='python'")],
  ['loose equality', s => s.replace("const getter=language==='javascript'", "const getter=language=='javascript'")],
  ['different adapter function', s => s.replace('function createBuiltinLanguageRegistry(', 'function createRuntimeRegistry(')],
];
for (const [name, mutate] of lookalikes) test(`adapter rejects local worker lookalike: ${name}`, () => {
  const text = mutate(source);
  assert.notEqual(text, source, 'Mutation must apply to actual source');
  const getterLine = lineOf(text, 'const getter=');
  assert.ok(scan(text).some(f => f.rule === 'language-condition' && f.file === adapter && f.line === getterLine));
});

test('identical getter selection in a GUI component is not adapter configuration', () => {
  const findings = scan(source, {[gui]: source});
  assert.ok(findings.some(f => f.rule === 'language-condition' && f.file === gui && f.line === lineOf(source, selection)));
});
test('identical getter selection in a reexported helper is not the designated adapter', () => {
  const helper = 'src/services/localWorkerHelper.ts';
  const text = `export * from './localWorkerHelper';`;
  const findings = scan(text, {[helper]: source});
  assert.ok(findings.some(f => f.rule === 'language-condition' && f.file === helper && f.line === lineOf(source, selection) && f.chain.includes(adapter)));
});
