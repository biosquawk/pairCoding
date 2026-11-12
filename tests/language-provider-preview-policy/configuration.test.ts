import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildLanguageProviderConfiguration as build, readLanguageProviderConfiguration as read } from '../../src/server/language/LanguageProviderConfiguration';
import { validateRuntimeProfile } from '../../src/shared/validation-v2';
import { profile, cache } from './fixture';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const sections = (c: ReturnType<typeof build>, items: unknown[]) => read(c, 'workspace/configuration', {items});
for (const release of [11,17,21,27] as const) {
  test(`Java${release}: real build/read uses production catalog, target VM and no invented preview setting`, () => {
    const p = profile(release), before = structuredClone(p), input = cache(), snapshot = structuredClone(input);
    assert.equal(validateRuntimeProfile(p), true); assert.equal(p.analysis.preview, false);
    const c = build(p, input), java = c.settings.java as any;
    assert.equal(c.provider, 'jdt'); assert.match(c.argv[2], /exec \/opt\/jdk27\/bin\/java/);
    assert.equal(java.configuration.runtimes.find((r: any) => r.default).name, `JavaSE-${release}`);
    assert.equal(java.configuration.runtimes.filter((r: any) => r.default).length, 1);
    assert.deepEqual(sections(c,[{section:'java'}, {section:'java.configuration.runtimes'}]), [java,java.configuration.runtimes]);
    assert.deepEqual(sections(c,[{section:'java.analysis.preview'},{section:'java.settings.url'}, {section:'java.compile.enablePreviewFeatures'}]), [null,null,null]);
    // NEGATIVE finding, not success of explicit policy propagation: both values are currently ignored.
    const enabled = structuredClone(p); enabled.analysis.preview = true;
    assert.equal(validateRuntimeProfile(enabled), true);
    assert.deepEqual(build(enabled,input), c);
    assert.deepEqual(p,before); assert.deepEqual(input,snapshot);
    assert.equal(JSON.stringify(c).includes('reportPreviewFeatures'), false);
    assert.equal(JSON.stringify(c).includes('enablePreviewFeatures'), false);
  });
}
test('analysis hash binds all actual unsigned fields, not an absent preview policy; target changes are bound', () => {
  const hashes = [11,17,21,27].map(release => {
    const c = build(profile(release as 11|17|21|27),cache());
    const {analysisSettingsSha256, ...unsigned} = c;
    assert.equal(analysisSettingsSha256, hash(unsigned));
    const changed = structuredClone(unsigned); (changed.bootFiles as Record<string,string>)['new.properties']='policy=disabled';
    assert.notEqual(hash(changed), analysisSettingsSha256);
    changed.settings={}; assert.notEqual(hash(changed), analysisSettingsSha256);
    return analysisSettingsSha256;
  });
  assert.equal(new Set(hashes).size,4);
});
test('nested return values stay frozen and cannot smuggle policy via configuration request', () => {
  const c=build(profile(),cache()), java=c.settings.java as any;
  assert.equal(Object.isFrozen(c),true); assert.equal(Object.isFrozen(c.bootFiles),true);
  assert.equal(Object.isFrozen(java.configuration.runtimes[0]),true);
  assert.throws(()=>java.configuration.runtimes[0].default=false, TypeError);
  assert.throws(()=>{ (c.settings as any).java.analysis={preview:true}; }, TypeError);
  assert.deepEqual(sections(c,[{section:'java',scopeUri:'file:///other'}, {section:'__proto__'}, {section:'java.constructor'}, {section:'java',value:{preview:true}}]), [null,null,null,java]);
  assert.deepEqual(sections(c,[{}]),[c.settings]);
  assert.throws(()=>sections(c,Array(33).fill({})),/Invalid/);
});
test('invalid policy types/keys, language-level mismatch and incompatible server JVM fail closed', () => {
  for(const mutate of [(p:any)=>p.analysis.preview='disabled',(p:any)=>p.analysis.preview=null,
    (p:any)=>p.analysis.reportPreviewFeatures='error',(p:any)=>p.analysis.languageLevel='17',
    (p:any)=>p.language.serverJvm='21']) {
    const p=profile(); mutate(p); assert.throws(()=>build(p,cache()));
  }
});
test('Python build/read unchanged, no Java policy or boot files; scope remains exact and inputs immutable', () => {
  const p=profile('python'), input=cache('python'); input.workingDirectory='src/Zażółć space';
  const before=structuredClone({p,input}), c=build(p,input);
  assert.equal(c.provider,'pylsp'); assert.deepEqual(c.argv,['/usr/local/bin/python','-m','pylsp']);
  assert.deepEqual(c.bootFiles,{}); assert.equal('java' in c.settings,false);
  const jedi=(c.settings.pylsp as any).plugins.jedi;
  assert.deepEqual(jedi.extra_paths,['/workspace/src/Zażółć space','/workspace/.paircoach-dependencies/site-packages']);
  assert.deepEqual(sections(c,[{section:'pylsp.plugins.jedi',scopeUri:c.expectedProjectUri},{section:'java'}]),[jedi,null]);
  assert.deepEqual({p,input},before);
});
