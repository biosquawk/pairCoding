# AC103 developer architecture boundary oracle

Run from repository root using the existing Node >=22.22 and installed TypeScript 7 dependency:

```
node --import tsx --test tests/runtime-architecture/*.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

`detector.test.ts` tests the detector with explicit violating/permitted in-memory fixtures.
`repository.test.ts` applies exactly the same oracle to the actual `src` tree. A fixture PASS
is **not** repository PASS. On the frozen pre-cutover base a7f13eae the repository test must
fail on Runner's host `node:child_process` dependency. Do not skip, mark expected-fail, or
allowlist that dependency. Re-run on the coherent integrated cutover before claiming AC103.

## Policy and mechanics

- All components, App, actual WriteGate/SessionController/WorkspaceService/Runner,
  monacoLspBridge, LiveBackend and PairCoachClient are protected roots.
- The existing TypeScript 7 parser/checker runs through `typescript/unstable/{ast,sync,fs}`
  and its bundled native compiler subprocess. Inputs are a virtual in-memory project;
  no source execution, emitted code, dependency installation, real project rewrite or
  container is involved. Parse errors fail, and API children are closed in `finally`.
- Runtime imports, export barrels, side effects, import-equals, dynamic imports and
  unshadowed require/loader aliases form a transitive graph. TypeScript resolves literal
  modules and symbol aliases; finite local resolution also handles static computed
  aliases, relative paths, the current `@/* -> ./*` alias, extension substitution and
  directory indexes. Missing local or unknown computed runtime imports fail closed.
  JSON is parsed data, not an executable source. External packages are named graph
  sinks, not scanned/evaluated dependency code; explicit toolchain package identities,
  adapter/executor/language implementations and host-process APIs are prohibited edges.
- Type-only neutral DTO/port edges do not create runtime dependencies. Direct type imports
  from implementation modules are still prohibited. Mixed value/type edges stay runtime.
- AST predicates identify actual runtime language/family/profile/kind selector comparisons,
  switch cases, membership/prefix/regex selection, including local/destructured/imported
  aliases, constants and enums. Callable language-keyed dispatch tables, concrete
  constructors and explicit tool command dispatch are checked. Comments, JSX labels,
  display metadata, syntax-coloring extension metadata and generic `profile.taskFields`
  rendering do not manufacture findings.
- The existing central `src/shared/validation-v2.ts` may validate family/config DTO
  compatibility. Only its **predicates** have that explicit exception; its imports and
  executable dispatch are still checked. No blanket shared-directory exemption exists.
  Unreachable startup composition is not a protected root; importing implementation
  dependencies through it into a protected root still violates the graph policy.

Each finding retains the protected root, actual file, 1-based UTF-16 line/column, rule,
module identity/detail and import chain. The oracle does not prove runtime correctness,
Monaco acceptance, Docker isolation or full architecture compliance. It is not a general
JavaScript abstract interpreter: reflective/eval/custom loader behavior, arbitrary
mutable/interprocedural computations, package internals, and arbitrary new resolver
plugins/aliases are outside the bounded model. Changes introducing those mechanisms
require explicit review and fixture-backed oracle extension, not an exemption. Its known
AST API is the locked TypeScript 7 implementation, not a legacy TS5 `createProgram` shim.
