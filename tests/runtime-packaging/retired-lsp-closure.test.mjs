// Task1 owner064364a7: retired mechanisms leave Git history, not active dangling imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript/unstable/ast');
const { API } = require('typescript/unstable/sync');
const { createVirtualFileSystem } = require('typescript/unstable/fs');
import { selectTests } from '../../scripts/runtime-test.mjs';
import { allowedSource, requiredFiles } from '../../scripts/verify-source-revision.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('active tests and runtime MJS graph have no absent explicit relative module', () => {
  const pending = [...selectTests(root).active,
    ...fs.readdirSync(path.join(root, 'scripts')).filter(n => n.endsWith('.mjs')).map(n => 'scripts/' + n)];
  const files = new Set(pending);
  // Runtime imports can lead to support fixtures; retain all MJS source files in virtual input.
  const collect = dir => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const file = dir + '/' + entry.name;
      if (entry.isDirectory()) collect(file);
      else if (entry.isFile() && file.endsWith('.mjs')) files.add(file);
    }
  };
  collect('tests');
  const prefix = path.join(root, '.closure-virtual') + '/', config = prefix + 'tsconfig.json';
  const virtual = Object.fromEntries([...files].map(file => [prefix + file, fs.readFileSync(path.join(root, file), 'utf8')]));
  virtual[config] = JSON.stringify({ compilerOptions: { allowJs: true, noLib: true, noEmit: true, jsx: 'react-jsx', module: 'esnext', moduleResolution: 'bundler' }, files: [...files] });
  const vfs = createVirtualFileSystem(virtual), api = new API({ fs: { ...vfs, readFile: name => vfs.readFile(name) ?? null } });
  try {
    const project = api.updateSnapshot({ openProjects: [config] }).getProject(config);
    assert.ok(project);
    const visited = new Set();
    while (pending.length) {
      const file = pending.pop();
      if (visited.has(file)) continue;
      visited.add(file);
      const ast = project.program.getSourceFile(prefix + file);
      assert.ok(ast, file);
      // Actual import nodes only: ignore import-looking text in fixture/child strings.
      const visit = node => {
        const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : null;
        if (specifier && ts.isStringLiteral(specifier) && /^\..*\.mjs$/.test(specifier.text)) {
          const resolved = path.normalize(path.join(path.dirname(file), specifier.text));
          assert.ok(fs.existsSync(path.join(root, resolved)), `${file} -> ${specifier.text}`);
          pending.push(resolved);
        }
        node.forEachChild(visit);
      };
      visit(ast);
    }
  } finally { api.close(); }

});

test('LSP producer/controller/recipes are retired, Run-only remainder and public prepare remain', () => {
  for (const file of ['scripts/runtime-language-prepare.mjs', 'scripts/runtime-operator-image-recovery.mjs',
    'docker/language-java.Dockerfile', 'docker/language-python.Dockerfile', 'runtimes/pylsp-requirements.lock']) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
    assert.equal(requiredFiles.includes(file), false, file);
  }
  assert.equal(allowedSource('scripts/runtime-language-prepare.mjs'), false);
  assert.equal(allowedSource('scripts/runtime-operator-image-recovery.mjs'), false);
  const remainder = fs.readFileSync(path.join(root, 'scripts/runtime-operator-remainder.mjs'), 'utf8');
  assert.doesNotMatch(remainder, /prepareLanguageImages|lock\.language|languageKinds/);
  assert.match(remainder, /retention\.retainRequired\(\)/);
  assert.match(remainder, /verifyPreparedReuse/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).scripts['runtime:prepare'], 'node scripts/runtime-prepare-cli.mjs');
});
