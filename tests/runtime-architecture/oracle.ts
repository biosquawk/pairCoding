import * as ts from 'typescript/unstable/ast';
import { API, SymbolFlags } from 'typescript/unstable/sync';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import path from 'node:path';
import fs from 'node:fs';

/** AC103 deliberately examines syntax and local runtime dependency edges, not source text.
 * It is a bounded architectural regression oracle, not a proof about arbitrary JS evaluation.
 * Unknown computed module specifiers fail closed. No application modules are executed.
 */
export type Sources = ReadonlyMap<string, string>;
export interface Finding {
  root: string; file: string; line: number; column: number;
  rule: 'implementation-import' | 'host-execution' | 'unresolved-import' | 'computed-import' | 'language-condition' | 'tool-dispatch';
  detail: string; chain: string[];
}
const slash = (p: string) => p.replaceAll('\\', '/');
export function isProtectedFile(file: string): boolean {
  return /^src\/components\/.+\.[cm]?[jt]sx?$/.test(file) || [
    'src/App.tsx', 'src/server/WriteGate.ts', 'src/server/SessionController.ts',
    'src/server/WorkspaceService.ts', 'src/server/Runner.ts', 'src/services/monacoLspBridge.ts',
    'src/services/LiveBackend.ts', 'src/services/PairCoachClient.ts',
  ].includes(file);
}
export function readSources(root: string): Map<string, string> {
  const result = new Map<string, string>();
  function walk(dir: string) {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const name = `${dir}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`AC103 source symlink is not scanned: ${name}`);
      if (entry.isDirectory()) walk(name);
      else if (/\.(?:[cm]?[jt]sx?|json)$/.test(name)) result.set(name, fs.readFileSync(path.join(root, name), 'utf8'));
    }
  }
  walk('src'); return result;
}
const families = /^(?:java(?:-maven(?:-(?:11|17|21|27))?)?|python(?:-3\.13)?|javascript(?:-node)?|typescript(?:-node)?|node|spring(?:[-_]boot)?|java_maven|java_main|docker|maven|mvn|javac|pytest|pip|pylsp|jdt(?:ls)?)(?:[.-])?$/i;
const tools = /^(?:docker(?:\.exe)?|mvn(?:\.cmd)?|maven|java(?:\.exe)?|javac(?:\.exe)?|python(?:3(?:\.13)?)?(?:\.exe)?|pip3?|pytest|tsc|npm|node(?:\.exe)?)$/i;
const selectors = /^(?:language|languageId|adapterFamily|family|profile|profileId|activeProfile|runtimeProfile|runtimeProfileId|toolchain|backend|executable|kind|mode)$/;
const processModule = (name: string) => ['child_process', 'node:child_process', 'execa', 'cross-spawn', 'shelljs'].includes(name);
function forbiddenModule(name: string): boolean {
  const clean = name.replace(/\.[cm]?[jt]sx?$/, '');
  const parts = clean.split('/');
  return parts.includes('runtime-adapters') || parts.some(p => /^(?:DockerExecutor|dockerode|docker(?:[-_].*)?|maven(?:[-_].*)?|java(?:[-_].*)?|python(?:[-_].*)?|spring(?:[-_].*)?|pylsp|jdtls)$/i.test(p)) ||
    /(?:^|\/)server\/(?:execution|language)\//.test(clean) && !/\/(?:ports)$/.test(clean);
}
interface Edge { node: ts.Node; spec?: string; target?: string; typeOnly: boolean }

export function inspectArchitecture(sources: Sources, roots = [...sources.keys()].filter(isProtectedFile)): Finding[] {
  const files = new Map([...sources].map(([file, text]) => [slash(file), text]));
  const prefix = slash(path.resolve('tests/runtime-architecture/.virtual')) + '/';
  // TypeScript 7 publishes its parser/checker through the bundled native API, not
  // legacy createProgram. Use that EXISTING dependency, with an in-memory FS only.
  const config = prefix + 'tsconfig.json';
  const virtual = Object.fromEntries([...files].map(([file, text]) => [prefix + file, text]));
  virtual[config] = JSON.stringify({ compilerOptions: { target: 'esnext', module: 'esnext',
    moduleResolution: 'bundler', jsx: 'react-jsx', noLib: true, noEmit: true,
    allowJs: true, paths: { '@/*': ['./*'] } }, files: [...files.keys()].filter(f => !f.endsWith('.json')) });
  for (const [file, text] of files) if (file.endsWith('.json')) JSON.parse(text);
  const vfs = createVirtualFileSystem(virtual);
  const api = new API({ fs: { ...vfs, readFile: name => vfs.readFile!(name) ?? null } });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    const project = snapshot.getProject(config);
    if (!project) throw new Error('AC103 TypeScript parser did not create virtual project');
    const syntaxErrors = project.program.getSyntacticDiagnostics();
    if (syntaxErrors.length) throw new Error(`AC103 cannot analyze syntactically invalid source (${syntaxErrors.length} diagnostics)`);
    const checker = project.checker;
    const sourceFile = (file: string) => {
      const ast = project.program.getSourceFile(prefix + file);
      if (!ast) throw new Error(`AC103 missing parsed source: ${file}`);
      return ast;
    };
    // Finite local TS/bundler resolution: relative, repository @/* alias, extension
    // substitution and directory index. External packages remain named graph sinks;
    // this oracle never reads/evaluates dependency package code.
    function resolveModule(spec: string, from: string, specNode?: ts.Node): string | undefined {
      if (specNode && ts.isStringLiteralLikeNode(specNode)) {
        const moduleSymbol = checker.getSymbolAtLocation(specNode);
        const moduleFile = moduleSymbol?.declarations.find(d => d.kind === ts.SyntaxKind.SourceFile)?.resolve();
        if (moduleFile && ts.isSourceFile(moduleFile)) {
          const target = slash(moduleFile.fileName).replace(prefix, '');
          if (files.has(target)) return target;
        }
      }
      const base = spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)) : spec.startsWith('@/') ? spec.slice(2) : undefined;
      if (base === undefined) return undefined;
      const extension = path.posix.extname(base);
      const stem = base.slice(0, base.length - extension.length);
      const substitutions = extension === '.mjs' ? ['.mts','.d.mts','.mjs'] : extension === '.cjs' ? ['.cts','.d.cts','.cjs'] :
        ['.js','.jsx'].includes(extension) ? ['.ts','.tsx','.d.ts','.js','.jsx'] : [];
      const candidates = substitutions.length ? substitutions.map(ext => stem + ext) :
        [base, ...['.ts','.tsx','.d.ts','.js','.jsx'].map(ext => base + ext),
          ...['.ts','.tsx','.d.ts','.js','.jsx'].map(ext => base + '/index' + ext)];
      return candidates.find(candidate => files.has(candidate));
    }
    const symbolCache = new Map<ts.Node, ts.Node | undefined>();
    function declaration(node: ts.Node): ts.Node | undefined {
      if (!symbolCache.has(node)) {
        let symbol = checker.getSymbolAtLocation(node);
        if (symbol && (symbol.flags & SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
        symbolCache.set(node, symbol?.valueDeclaration?.resolve());
      }
      return symbolCache.get(node);
    }
    const unwrap = (node: ts.Node): ts.Node => {
      while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertion(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
      return node;
    };
    function initializer(node: ts.Node): ts.Node | undefined {
      const decl = declaration(node);
      if (decl && (ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl) || ts.isPropertyDeclaration(decl) || ts.isEnumMember(decl))) return decl.initializer;
      if (decl && ts.isBindingElement(decl)) {
        const owner = decl.parent.parent;
        if (ts.isVariableDeclaration(owner) && owner.initializer && ts.isObjectBindingPattern(decl.parent)) {
          const object = resolve(owner.initializer);
          const key = (decl.propertyName ?? decl.name)?.getText();
          if (ts.isObjectLiteralExpression(object)) { const prop = object.properties.find(p => ('name' in p ? p.name?.getText() : undefined)?.replace(/^['"]|['"]$/g, '') === key);
            if (prop && ts.isPropertyAssignment(prop)) return prop.initializer; }
        }
      }
      return undefined;
    }
    function resolve(node: ts.Node, seen = new Set<ts.Node>()): ts.Node {
      node = unwrap(node);
      if (seen.has(node)) return node;
      seen.add(node);
      if (ts.isIdentifier(node)) { const value = initializer(node); if (value) return resolve(value, seen); }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const object = resolve(node.expression, seen);
        const key = ts.isPropertyAccessExpression(node) ? node.name.text : strings(node.argumentExpression)[0];
        if (ts.isObjectLiteralExpression(object) && key) {
          const prop = object.properties.find(p => ('name' in p ? p.name?.getText() : undefined)?.replace(/^['"]|['"]$/g, '') === key);
          if (prop && ts.isPropertyAssignment(prop)) return resolve(prop.initializer, seen);
        }
        const value = initializer(node); if (value) return resolve(value, seen);
      }
      return node;
    }
    function strings(node: ts.Node | undefined, seen = new Set<ts.Node>()): string[] {
      if (!node || seen.has(node)) return [];
      seen.add(node); node = resolve(node);
      if (ts.isStringLiteralLikeNode(node)) return [node.text];
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const a = strings(node.left, seen), b = strings(node.right, seen);
        return a.flatMap(x => b.map(y => x + y));
      }
      if (ts.isTemplateExpression(node)) {
        let result = [node.head.text];
        for (const span of node.templateSpans) { const values = strings(span.expression, seen); result = result.flatMap(x => values.map(y => x + y + span.literal.text)); }
        return result;
      }
      if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(e => strings(e, new Set(seen)));
      if (ts.isConditionalExpression(node)) return [...strings(node.whenTrue, seen), ...strings(node.whenFalse, seen)];
      return [];
    }
    function selector(node: ts.Node, seen = new Set<ts.Node>()): boolean {
      node = unwrap(node); if (seen.has(node)) return false; seen.add(node);
      if (ts.isIdentifier(node)) {
        const value = initializer(node);
        const decl = declaration(node);
        if (!value && decl && ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent)) return selectors.test((decl.propertyName ?? decl.name)?.getText() ?? '');
        // A binding alias is followed before considering its spelling (scope/shadowing matters).
        return value ? selector(value, seen) : selectors.test(node.text);
      }
      if (ts.isPropertyAccessExpression(node)) return selectors.test(node.name.text);
      if (ts.isElementAccessExpression(node)) return strings(node.argumentExpression).some(s => selectors.test(s));
      return false;
    }
    // REQ-LIGHT-001 / ARCHITECTURE §3 / HUMAN358b0048: this designated editor
    // adapter owns local JS/TS worker configuration, NOT runtime/tool selection.
    // Recognize only the existing direct getter ternary, with real parameter and
    // namespace-import bindings. No resolve()/alias expansion or file-wide bypass.
    function localWorkerPredicate(file: string, node: ts.Node): boolean {
      if (file !== 'src/services/builtinLanguageRegistry.ts' || !ts.isBinaryExpression(node) ||
        node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
        !ts.isIdentifier(node.left) || !ts.isStringLiteral(node.right) || node.right.text !== 'javascript') return false;
      const choice = node.parent;
      if (!ts.isConditionalExpression(choice) || choice.condition !== node) return false;
      const language = declaration(node.left);
      if (!language || !ts.isParameterDeclaration(language) || language.initializer || language.dotDotDotToken || language.questionToken ||
        !language.type || !ts.isUnionTypeNode(language.type) || language.type.types.length !== 2) return false;
      const languages = language.type.types.map(t => ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? t.literal.text : '');
      if (!languages.includes('javascript') || !languages.includes('typescript')) return false;
      const factory = language.parent;
      // Exactly the workerFor => async model => { const getter = ... } shape.
      // A helper/alias or a second language predicate does not inherit permission.
      if (!ts.isArrowFunction(factory) || factory.parameters.length !== 1 || !ts.isArrowFunction(factory.body) ||
        !factory.body.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) || !ts.isBlock(factory.body.body)) return false;
      const getter = choice.parent;
      if (!ts.isVariableDeclaration(getter) || getter.initializer !== choice ||
        !ts.isVariableDeclarationList(getter.parent) || !(getter.parent.flags & ts.NodeFlags.Const) ||
        !ts.isVariableStatement(getter.parent.parent) || getter.parent.parent.parent !== factory.body.body) return false;
      const binding = factory.parent;
      if (!ts.isVariableDeclaration(binding) || binding.initializer !== factory || !ts.isIdentifier(binding.name) || binding.name.text !== 'workerFor' ||
        !ts.isVariableDeclarationList(binding.parent) || !(binding.parent.flags & ts.NodeFlags.Const) ||
        !ts.isVariableStatement(binding.parent.parent) || !ts.isBlock(binding.parent.parent.parent)) return false;
      const registry = binding.parent.parent.parent.parent;
      if (!ts.isFunctionDeclaration(registry) || registry.name?.text !== 'createBuiltinLanguageRegistry' ||
        registry.parent !== sourceFile(file) || !registry.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) return false;
      const receiver = (branch: ts.Node, name: string): ts.Node | undefined => {
        if (!ts.isPropertyAccessExpression(branch) || branch.questionDotToken || branch.name.text !== name) return undefined;
        const group = branch.expression;
        if (!ts.isPropertyAccessExpression(group) || group.questionDotToken || group.name.text !== 'typescript' || !ts.isIdentifier(group.expression)) return undefined;
        return declaration(group.expression);
      };
      const monaco = receiver(choice.whenTrue, 'getJavaScriptWorker');
      if (!monaco || monaco !== receiver(choice.whenFalse, 'getTypeScriptWorker') || !ts.isParameterDeclaration(monaco) ||
        monaco.parent !== registry || monaco.initializer || monaco.dotDotDotToken || monaco.questionToken ||
        !monaco.type || !ts.isTypeQueryNode(monaco.type) || !ts.isIdentifier(monaco.type.exprName)) return false;
      // Follow the *raw* type namespace symbol, not an arbitrary value alias with
      // the spelling monaco/typescript. External package internals are not executed.
      const namespaces = checker.getSymbolAtLocation(monaco.type.exprName)?.declarations ?? [];
      return namespaces.some(ref => {
        const ns = ref.resolve();
        if (!ns || !ts.isNamespaceImport(ns) || !ts.isImportClause(ns.parent) || ns.parent.phaseModifier !== ts.SyntaxKind.TypeKeyword) return false;
        const imported = ns.parent.parent;
        return ts.isImportDeclaration(imported) && ts.isStringLiteral(imported.moduleSpecifier) && imported.moduleSpecifier.text === 'monaco-editor';
      });
    }
    const edges = new Map<string, Edge[]>();
    function requireCall(node: ts.Node, seen = new Set<ts.Node>()): boolean {
      node = unwrap(node); if (seen.has(node)) return false; seen.add(node);
      if (ts.isIdentifier(node)) {
        const value = initializer(node); if (value) return requireCall(value, seen);
        // An actual local parameter/function named require is not Node's loader.
        return node.text === 'require' && !declaration(node);
      }
      return false;
    }
    for (const file of files.keys()) {
      if (file.endsWith('.json')) continue;
      const found: Edge[] = [];
      const add = (node: ts.Node, specNode: ts.Node | undefined, typeOnly = false) => {
        const values = strings(specNode);
        if (!values.length) { found.push({node, typeOnly}); return; }
        for (const spec of values) {
          found.push({ node, spec, target: resolveModule(spec, file, specNode), typeOnly });
        }
      };
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node)) {
          const clause = node.importClause, bindings = clause?.namedBindings;
          const typeOnly = !!clause && (clause.phaseModifier === ts.SyntaxKind.TypeKeyword || !clause.name && !!bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(e => e.isTypeOnly));
          add(node, node.moduleSpecifier, typeOnly);
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
          add(node, node.moduleSpecifier, node.isTypeOnly || !!node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every(e => e.isTypeOnly));
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node, node.moduleReference.expression, node.isTypeOnly);
        else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || requireCall(node.expression))) add(node, node.arguments[0]);
        node.forEachChild(visit);
      };
      visit(sourceFile(file)); edges.set(file, found);
    }
    const findings: Finding[] = [];
    for (const root of roots) {
      if (!files.has(root)) throw new Error(`AC103 missing protected source: ${root}`);
      const visited = new Set<string>();
      const emit = (file: string, node: ts.Node, rule: Finding['rule'], detail: string, chain: string[]) => {
        const pos = sourceFile(file).getLineAndCharacterOfPosition(node.getStart());
        findings.push({ root, file, line: pos.line + 1, column: pos.character + 1, rule, detail, chain });
      };
      function walk(file: string, chain: string[]) {
        if (visited.has(file)) return; visited.add(file);
        if (file.endsWith('.json')) return; // parsed JSON data is not a runtime code edge

        for (const edge of edges.get(file) ?? []) {
          const identity = edge.target ?? edge.spec;
          if (!identity) { if (!edge.typeOnly) emit(file, edge.node, 'computed-import', 'Module target cannot be statically resolved', chain); continue; }
          if (forbiddenModule(identity)) emit(file, edge.node, 'implementation-import', identity, chain);
          if (edge.typeOnly) continue;
          if (processModule(identity)) emit(file, edge.node, 'host-execution', identity, chain);
          if (!edge.target && (edge.spec?.startsWith('.') || edge.spec?.startsWith('@/'))) emit(file, edge.node, 'unresolved-import', identity, chain);
          if (edge.target) walk(edge.target, [...chain, edge.target]);
        }
        // Only the existing central semantic DTO validator is allowed to reject
        // incompatible family/config combinations. Its imports AND executable
        // dispatch remain checked; shared/ is NOT a general behavior exemption.
        const dataValidator = file === 'src/shared/validation-v2.ts';
        const languagePredicate = (part: ts.Node): boolean => {
          if (ts.isBinaryExpression(part) && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(part.operatorToken.kind)) {
            return selector(part.left) && strings(part.right).some(s => families.test(s)) || selector(part.right) && strings(part.left).some(s => families.test(s));
          }
          if (ts.isCallExpression(part) && ts.isPropertyAccessExpression(part.expression)) {
            const call = part.expression, arg = part.arguments[0];
            if (['includes', 'startsWith', 'endsWith'].includes(call.name.text) && arg &&
              (selector(arg) && strings(call.expression).some(s => families.test(s)) || selector(call.expression) && strings(arg).some(s => families.test(s)))) return true;
            if (call.name.text === 'test' && arg && selector(arg) && ts.isRegularExpressionLiteral(call.expression) && call.expression.text.split(/[^a-z0-9_]+/i).some(s => families.test(s))) return true;
          }
          return false;
        };
        const visit = (node: ts.Node) => {
          if (!dataValidator && languagePredicate(node) && !localWorkerPredicate(file, node)) emit(file, node, 'language-condition', 'Language/tool-specific predicate at neutral boundary', chain);
          if (!dataValidator && ts.isCaseClause(node) && ts.isSwitchStatement(node.parent.parent) && selector(node.parent.parent.expression) && strings(node.expression).some(s => families.test(s))) emit(file, node.expression, 'language-condition', 'Language/tool-specific switch dispatch', chain);
          if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            const callee = resolve(node.expression);
            if (ts.isElementAccessExpression(callee) && selector(callee.argumentExpression)) {
              const table = resolve(callee.expression);
              if (ts.isObjectLiteralExpression(table) && table.properties.some(p => 'name' in p && p.name && families.test(p.name.getText().replace(/^['"]|['"]$/g, '')))) emit(file, node, 'tool-dispatch', 'Language-keyed callable dispatch table', chain);
            }
            const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
            if (/^(?:spawn(?:Sync)?|exec(?:File)?(?:Sync)?|execa|run|execute|launch|start|shell|compile)$/.test(name) && node.arguments?.[0] && strings(node.arguments[0]).some(s => tools.test(s.split(/[\\/]/).at(-1) ?? ''))) emit(file, node, 'tool-dispatch', 'Tool executable dispatched by neutral boundary', chain);
            if (ts.isNewExpression(node) && /^(?:DockerExecutor|JavaMavenAdapter|PythonAdapter|MavenAdapter|JdtLanguageServer|PylspLanguageServer)$/.test(name)) emit(file, node, 'tool-dispatch', `Concrete implementation constructed: ${name}`, chain);
          }
          node.forEachChild(visit);
        };
        visit(sourceFile(file));
      }
      walk(root, [root]);
    }
    return findings.sort((a, b) => a.root.localeCompare(b.root) || a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule));
  } finally { api.close(); }
}
