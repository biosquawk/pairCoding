# JDT21_PREVIEW_API_DIAGNOSTIC_DISCREPANCY — source/binary diagnosis

**Finding remains OPEN / product correction NOT IMPLEMENTED. FULL5a remains FAIL.**
Scope: additive investigation only, base `2d7e556638bc1d2438c6b9d9bc2f6318e7a88d79`.
No Docker, Java execution, host toolchain installation, product/DTO/spike mutation, or FULL retry.

## Conclusion supported by the pinned binary

This is not another missing-preview-flag hypothesis. The actual compiler deliberately takes a different branch for **older-than-its-latest compliance**, even with preview disabled:

- Distribution: JDT LS `1.63.0-202610191322`, archive SHA256 `b1f2abe0b3cccb462cf64fb4a5587c7d09df60cf8be7748b152cbd89d018bdc4`.
- Compiler: `org.eclipse.jdt.core.compiler.batch_3.46.200.v20261008-1115.jar`, SHA256 `f667bb3666d9875a2309fa2447a19e6cdd960281473bd7125a22c5a435246d21`.
- Its own manifest pins **compiler source** `eclipse-jdt/eclipse.jdt.core@5a4dd839342e057849b378ec912c47035db65dbb`, NOT the separately built core bundle's `79ceacffdea9ca0b7f57ce3476a57e34bc154188`. Core jar SHA256 `70b4bb168aab096ee7f33da7b72f470f4172fe3e18e80289dd89cf344937ed22`.
- LS core manifest pins `eclipse/eclipse.jdt.ls@d98abba8f04cf041542d9ebb6df0d472a1395606`; jar SHA256 `6e5e5e39d82e9ac04925e8b3f432ef6fe81284441e99952d2f720779c9e2831b`.

`raw/jdt-ProblemReporter.java:9620–9636` (`previewAPIUsed`):
preview disabled + compliance < latest → **PreviewAPIUsed**, then `computeSeverity(PreviewAPIUsed)`;
only compliance >= latest enters **PreviewAPIDisabled**, with Error for nonreflective API / Warning for reflective API.
`raw/jdt-ClassFileConstants.java:146–150,190–191` makes latest **27**, independent of the assigned project VM or server JVM.
`raw/jdt-ProblemReporter.java:648–650` maps PreviewAPIUsed to the PreviewFeatureUsed irritant.
`raw/jdt-CompilerOptions.java:880–881,2239–2240` maps that irritant to reportPreviewFeatures.
The observed effective report policy is warning. Public pinned `raw/jdt-JavaCore.java:2730–2742` permits warning/info/ignore, not error: **no guessed report=error fix**.

This is also present in the **actual jar bytecode**, not just a source inference:
`bytecode.json`, method previewAPIUsed, offsets381(compliance),384(latest),387(lcmp),388(ifge399),391(ldc4195412),399(ldc4195415).
`getLatestJDKLevel` returns `4653056 == 71<<16` (JDK27); target21 is `65<<16`.
ProblemReporter.class SHA256 `034a2e65e3aa20cde5fd1ebe891c7d27fda6b2d56da2725357df68334f0c0be9`.
The read-only Python inspector checks archive and jar hashes before reading class bytes; it does not run the compiler.

`raw/jdt-IProblem.java:377,2333,2339`: Compliance=0x00400000; +1108 = **4195412**, +1111 =4195415.
`raw/jdt-messages.properties:915,918` ties these to the observed preview-use wording vs disabled wording.
`raw/jdtls-BaseDiagnosticsHandler.java:255,357–365` preserves problemID and maps compiler error/warning to LSP Error/Warning. No evidence of a transport severity downgrade is needed to explain this observation.

## Annotation / API / release path, and javac contrast

- Exact original didOpen bytes are `raw/Demo.java`; provenance/hash in `observations.json`. This is a read-only extraction, NOT a changed original snippet. It references ScopedValue type and newInstance().
- OpenJDK21.0.13+9 resolves via annotated tag10a4adb7 to source commit **ba94eace682733f66e623c089bcafcf4a1b8e39c** (`raw/openjdk-release-{ref,tag}.json`). All downloaded sources use the commit URL and SHA256 in `sources.json`; source release identity is not a byte-for-byte attestation of the Temurin image's class files.
- `raw/javac21-ScopedValue.java:239` has @PreviewFeature(SCOPED_VALUES), no reflective=true. `raw/javac21-PreviewFeature.java:53–60,77–78` has CLASS retention, reflective default false and title **Scoped Values**.
- `raw/jdt-ConstantPool.java:308–310`, `raw/jdt-BinaryTypeBinding.java:637–647` retain that binary annotation; `raw/jdt-ASTNode.java:471–473,610` passes it to previewAPIUsed. The reporter extracts title and reflective status at9582–9616, but the older-compliance branch bypasses the hard disabled-API policy regardless of reflective status.
- `raw/javac21-ClassReader.java:1513–1530` recognizes both real and synthetic ct.sym PreviewFeature annotations. `raw/javac21-Check.java:3831–3844` rejects nonreflective preview API when preview disabled, without ECJ's older-than-latest exemption. This matches ROOT's existing javac21 rejection; javac NOT re-run here.
- Release affects library selection, not ECJ's getLatestJDKLevel. `raw/jdt-ClasspathJrtWithReleaseOption.java:84–95,160–198`: ct.sym signatures for earlier releases, JRT when current release uses system-modules sentinel. `raw/javac21-CreateSymbols.java:1194–1208` rewrites PreviewFeature to synthetic annotation in ct.sym. **Actual image lib/modules/ct.sym bytes and selected class origin were NOT read in this task.** Observed genuine feature title/code plus actual VM21/release21 suffice for this branch explanation, not for claiming all cross-release annotation paths equivalent. A JVM27/ct.sym21 path may differ and must not be assumed safe from this one observation.

## Independent oracle constraint — preserve it, do not silently fix it

Frozen `spike/stage09/lsp/spike.mjs:165` requires BOTH `/ScopedValue/.test(d.message)` AND severity===1. The actual JDT text says **Scoped Values** (space), so it fails both gates. Even a hypothetical upstream PreviewAPIDisabled message**1111** with this feature title would still miss that literal.
Thus a real severity correction alone must NOT be promised as FULL PASS. No original predicate, snippet, messages, pins or timeouts were changed. `test_static_evidence.py` separately demonstrates this exact string mismatch; this is not permission to weaken the oracle.

## New falsifiable test and correction direction (NOT RUN / NOT an operator request)

First implement a separately reviewed **compiler-only** bounded diagnostic harness, not another LSP FULL. In a new own isolated diagnostic output, use the existing image `sha256:fea3e1e7a3012c541d476906ccb74b71df3e1ef49ef769e3fd6bd5aab8bbcdeb`, UID10001, no network/pull, RO source/toolchain, bounded writable output, existing caps/limits/ownership/collect-before-rm controls. Preserve `raw/Demo.java` exactly and verify compiler/JDK hashes before execution.

Planned in-container argv (each <=30s, distinct fresh output dirs, no shell):
1. `/opt/java/openjdk/bin/javac --release 21 -d /diag/out-javac /diag/src/Demo.java`.
2. `/opt/java/openjdk/bin/java -jar /opt/jdt/plugins/org.eclipse.jdt.core.compiler.batch_3.46.200.v20261008-1115.jar --release 21 -d /diag/out-ecj /diag/src/Demo.java`.
Prediction: javac21 nonzero + disabled-preview errors; exact ECJ emits PreviewAPIUsed warnings and (absent other errors) exits0. Both use actual target JDK21, removing LS/JVM27/Monaco from the comparison. Capture exit, stderr, toolchain version, effective options, annotation/class-origin hashes and fresh emitted-class inventory. If ECJ instead errors, the direct-batch prediction is falsified: investigate reconcile-specific options/class loading; do not relabel success. Add a separate ordinary type-error control (both must fail) and known-valid Java21 control (both succeed); never modify the frozen snippet/oracle for the primary case.

Minimal semantic correction candidate is an **upstream reviewed compiler fix + new explicit pin**, removing/restricting the older-compliance exemption for genuine nonreflective preview APIs while preserving reflective warning semantics, release library identity and stable APIs. This is a proposal, not a tested fix or permission to patch the pinned archive. It also does not by itself satisfy the frozen message constraint. Alternative architecture (actual target-javac validation of the same immutable project) requires explicit review/budgets; never synthesize or promote an existing marker. Do not change production/DTO/pins until K/ROOT decide an owned follow-up. The source-level cause is explained; the production release/API requirement and final oracle acceptance remain open.
