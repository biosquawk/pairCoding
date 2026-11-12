import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimeProfile, validateRuntimeCatalog, validateTaskForProfile } from '../../src/shared/validation-v2';
import { profile, testsOnly } from './fixtures';
import type { RuntimeProfile } from '../../src/shared/runtime-v2';

test('ROOT exact Python+builtin counter: reject profile, nested catalog and task admission without mutation', () => {
  const p = {id:'python-3.13',label:'Python',adapterFamily:'python',imageLockKey:'py',expectedTools:[{name:'python',version:'3.13.9'}],compilerRelease:null,analysis:{languageLevel:'3.13',preview:false},language:{provider:'builtin',imageLockKey:null,serverJvm:null},taskFields:[]};
  const before = JSON.stringify(p);
  assert.equal(validateRuntimeProfile(p),false);
  assert.equal(validateRuntimeCatalog({schemaVersion:1,profiles:[p]}),false);
  assert.equal(validateTaskForProfile(p,testsOnly()),false);
  assert.equal(JSON.stringify(p),before);
});

test('Python requires pylsp; built-in workers belong only to Node/TypeScript; valid controls retained', () => {
  const builtin = {provider:'builtin' as const,imageLockKey:null,serverJvm:null};
  const controls: RuntimeProfile[] = [profile(), profile('java-maven'),
    {...profile(),id:'javascript-node',adapterFamily:'node',language:builtin},
    {...profile(),id:'typescript-node',adapterFamily:'typescript',language:builtin},
  ];
  for (const p of controls) {
    assert.equal(validateRuntimeProfile(p),true,p.id);
    assert.equal(validateRuntimeCatalog({schemaVersion:1,profiles:[p]}),true,p.id);
  }
  for (const provider of ['builtin','off'] as const) {
    const p = {...profile(),language:{provider,imageLockKey:null,serverJvm:null}};
    assert.equal(validateRuntimeProfile(p),false,`python+${provider}`);
    assert.equal(validateRuntimeCatalog({schemaVersion:1,profiles:[p]}),false);
    assert.equal(validateTaskForProfile(p,testsOnly()),false);
  }
});

test('unsupported cross-family providers and Java release rules remain rejected', () => {
  for (const family of ['node','typescript','java-maven'] as const) {
    const p = {...profile(family),language:{provider:'pylsp',imageLockKey:'pylsp',serverJvm:null}};
    assert.equal(validateRuntimeProfile(p),false,`${family}+pylsp`);
  }
  for (const family of ['node','typescript','python'] as const) {
    const p = {...profile(family),language:{provider:'jdt',imageLockKey:'jdt',serverJvm:'27.0.1'}};
    assert.equal(validateRuntimeProfile(p),false,`${family}+jdt`);
  }
  assert.equal(validateRuntimeProfile({...profile('java-maven'),language:{provider:'builtin',imageLockKey:null,serverJvm:null}}),false);
  assert.equal(validateRuntimeProfile({...profile('java-maven'),compilerRelease:21,analysis:{languageLevel:'27',preview:false}}),false);
});
