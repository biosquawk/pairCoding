# Durable training projects and explicit coach language

Owner scope: `GOAL-PC-PROJECTS-THEMES-LOCALE-20261114` and its layout annex.
A durable **training project** is not an exercise/runtime ProjectV2. Startup through
`src/server/index.ts` is an authenticated empty shell, even when runtime configuration
or the environment mentions an exercise. Programmatic `ServerOptions.rootPath` remains
an explicit trusted fixture/embedding seam; it is not automatic product startup.

## User path

1. Create a project in an existing backend-accessible directory (name + location), or
   open an existing `NAME.paircoding.json` through the backend folder picker.
2. A new project is empty. Use existing Open Folder to open an exercise. Different
   successive exercise folders belong to the **same** training project.
3. Source writes still require existing WriteGate and ACK. There is no source copy or
   competing source autosave in the project file. Workspace tabs, view coordinates,
   panel selections, chat, timer and coach context are saved automatically by the app.
4. Add an explicit protected training rule with `/rule Use Java 21 without streams.`
   or `Project rule: ...` / `Zasada projektu: ...` in chat. Only an actual STUDENT
   message in this syntax can change authoritative rules. Ordinary coaching can
   remember bounded operational notes, but cannot rewrite those rules.
5. Close Project flushes acknowledged state and clears the editor/chat/runtime binding.
   Open the project again after a page/backend restart to restore its latest exercise,
   tabs, original chat timestamps/languages, saved timer intent, and context.
   A real manual pause stays paused; reopening does not invent a manual pause.
   Clock/coaching still require valid current presence and the normal guards.
   Switching to another project referencing the currently open **same** exercise
   asks you to close the current project first: no bypass of the source owner's lease.
6. PL/EN explicitly controls future AI output. It never infers language from task text,
   translates old messages, or changes the configured teacher model/effort. A toggle
   aborts/revokes old-language analysis and pending report generation; late frames have
   explicit locale tags and are rejected by the client. Retry a cancelled report in
   the newly selected language. Existing completed reports remain historical.

## Theme and panel controls

The theme button cycles **Darcula** (default when no theme was previously selected),
**Solarized Dark**, and **Solarized Light**. The PL/EN flag immediately after A−/A+
selects the application and future coach language. The left sidebar contains
**Project files** (fresh-start default), **Task**, **Chat**, and **Environment**;
the bottom panel contains only **Console** and **Report**. Existing theme/font
preferences remain separate from exercise source files.

For the shortest launch path see [README](../README.md#projekt-treningowy-wygląd-i-język)
and the [Windows guide](windows-start.md#3-start-pusty--utwórzotwórz-projekt--ćwiczenie--zgoda-ai).

## Backend and typed client contract

Source of truth: `src/shared/durable-project.ts`, `src/services/liveTypes.ts`,
`src/services/PairCoachClient.ts` and `src/shared/ws.schema.json`.

`ClientState` includes `durableProject: DurableProject|null`, `projectError: string|null`
and `locale: 'pl'|'en'`. `DurableProject` has `id,name,directory,projectFile,exercisePath,
workspace,locale`. Workspace has `openTabs,activePath` plus optional `sidebarTab`,
`bottomTab`, `editorViews`. A view has exactly `selection`, `position`, `scrollTop`,
`scrollLeft`; no source bytes, arbitrary nested JSON or raw Monaco state. Keys must be
open tab paths; at most 100; ordered positive integer coordinates, finite bounded scroll.

Client methods (all return `Promise<boolean>`):
- `createDurableProject(directory,name)`
- `openDurableProject(projectFile)`
- `closeDurableProject()`
- `saveProjectWorkspace(workspace)`
- `setLocale('pl'|'en')`

Existing `openProject(rootPath)` means **open exercise**, not create a training project.
`listFolders()` works in the authenticated shell and returns existing `directories`
plus optional `projectFiles: {name,path}[]`; no upload and no recursion.

HTTP: authenticated `GET /api/durable-project` returns `DurableProjectState`.
POST `/api/durable-project/{create,open,close,workspace,locale}` uses
`{requestId,clientId,projectId,sessionId,...}` with `projectId/sessionId` null in the empty
shell. Extra fields are rejected. Action data: `directory,name,locale?` / `projectFile`
/ none / `workspace` / `locale`. When an exercise is bound, commands require its
current primary client/session identity. Receipts deduplicate the exact original request.
Project changes preserve single-flight and Run/control guards; clients flush source ACKs.
Do not mint a new request ID to retry an unknown mutation outcome.

`localizeDiagnostic(message,locale)` in `src/shared/localizeDiagnostic.ts` translates
application diagnostics/status only. Never apply it to user/task/code/chat or raw logs.
The UI should save workspace only for its current non-offline bound exercise, not while
restored state is still loading, and should key Monaco by durable ID + exercise ID.

## Storage, security and compatibility

Human-readable manifest v1: `NAME.paircoding.json` has `{schemaVersion:1,id,name}`.
The authoritative, bounded atomic record is `.pairCoding/codex/state.json`.
It contains active exercise, complete chat (up to 10,000 entries / 8 MiB record; explicit
visible failure rather than eviction), locale, session/timer, workspace, bounded
transitions/observations/notes and explicit rules, plus native session IDs by
character/model/effort. No exercise source is copied there. Model context still uses
an independently bounded recent history and operational memory.

Persistence reuses existing private directory, no-follow/single-hardlink record IO,
fsync/rename/readback and crash-releasing kernel JournalLease. Disk conflicts,
unsafe links, missing state and unsupported versions fail closed without overwriting
foreign state. Metadata/rule files and project manifests are excluded from source
editing, AI file context, snapshots and isolated Run input. Browser workspace writes
cannot mutate notes/rules/native paths. The store is not a new database or recovery
framework. Preserve a complete project directory for backup; restoring incompatible
versions is an explicit operation, not an automatic destructive migration.

## Actual native Codex continuity

Official OpenAI documentation, fetched 2026-11-14:
<https://developers.openai.com/codex/noninteractive/> documents
`codex exec resume <SESSION_ID>` for a specific recorded session.
Actual local CLI `0.168.0` help confirms `exec resume`, `--cd`, output schema and
`--ephemeral` semantics. This integration does **not** change account authentication,
use API-key auth, or substitute a worker model for the configured product teacher.

A durable call omits `--ephemeral`; only the real `thread.started.thread_id` is saved.
Later calls use that exact ID, never `--last` and never a generated UUID. Missing or
changed native sessions fail instead of silently starting another thread. The copied
character AGENTS.md/skills live in a stable safe
`.pairCoding/codex/teacher-<scope-hash>/` directory. Scratch schema/TMP files are still
removed. Subsequent native calls pass explicit `--cd` for the stable directory.
Operational context and explicit locale are injected again before each call. File,
shell, network, app and external MCP tools remain disabled; model memoryNote output
is bounded platform-committed operational memory, **not private chain-of-thought**.

`.pairCoding/codex/resume.json` contains actual ID, stable cwd, and shell-independent
interactive/noninteractive argv arrays. Run those argv with the same configured
account/CODEX_HOME, e.g. `codex --cd <recorded-cwd> resume <recorded-ID>` interactively,
or `codex --cd <recorded-cwd> exec resume <recorded-ID> 'next instruction'`.
Quote paths correctly for your own shell; do not execute concatenated untrusted path text.
Native account session journals remain in its private CODEX_HOME (not copied into the
project). Credentials/auth.json and raw reasoning events are never stored on the desk.

An argv/unit check does NOT establish native continuity. Existing acceptance evidence
is revision- and environment-specific, not a promise based on stored IDs:

- ROOT resumed P's exact actual native ID after cleanup and backend restart from
  `/tmp`, using the recorded stable `--cd` and the same private native store
  (`native-resume-after-restart-c383.json`). The earlier CLI argument failure is retained.
- On frozen host a72b5f9 (product-identical to source 016cac1; only a test differs),
  VERIFY observed actual R PL→EN→PL replies, a true THINKING cancellation, reopen
  and PL recall. ROOT's sanitized `r-native-turn-correlation-a72.json` matches all
  four successful requests to one actual native ID; VERIFY and K matched their
  message IDs/input hashes to GUI logs. The cancelled EN call is not claimed complete.
- `p-r-context-isolation-a72.json` supports the first P→R request on the same exercise
  with separate durable/native IDs and no protected P phrase in R's context. This is
  trusted ROOT extraction, not K/VERIFY access to private journals, nor proof of every
  timing/direction or a new literal-Q test. R is the authorized second-project proof;
  historical Q limitations and old P English-response FAIL are retained.

These artifacts are under the task's `SharedDesk/projectSpace/` root-host-proof;
independent reports are under `SharedDesk/deliveries/_drafts/VERIFY/pc-projects-theme-locale-20261114/`.
History/restart proof on c383 and manual-pause proof on 507 keep those revisions;
they are not relabelled as new 016 executions. R recall may also use restored chat,
so it does not isolate native-only memory. Old erroneous immutable language policy
in unreleased P is not migrated or erased. Future native sessions use a neutral
policy authorizing the app-controlled locale on each turn, without a new ID per language.

## Focused reproduction

Use Node >=22.22, existing deps and a writable test temp directory. No full historical
`npm test` or unbounded coverage campaign is needed for these changed-path tests:

```sh
node --import tsx --test tests/durable-projects/store.test.ts \
  tests/durable-projects/native-args.test.ts tests/durable-projects/http.test.ts \
  tests/durable-projects/locale-client.test.ts
```

Store tests use real FS/kernel leases. HTTP tests use real server/WS/WriteGate with an
injected AI provider and no Docker: they are explicitly not real AI or native resume
acceptance. Add scoped touched-path coach/WriteGate/runtime tests on the integrated
candidate; old auto-open-config-only HTTP fixtures must now explicitly select a root
or assert the new empty startup requirement, not revive withdrawn product behavior.

Locale mutation is single-flight. A lost/rejected response triggers authenticated
durable-state readback rather than assuming a rollback. If readback is unavailable
or its locale is invalid, chat/start/resume/accepted proposals and project switching
remain blocked with `LOCALE_SYNC_REQUIRED`; reconnect reads the authoritative locale
before releasing them. Existing local edits and veto remain available. A question
already waiting for editor ACK is invalidated by a language generation change.
The client transport-fault tests cover rejection, disconnect **after commit**,
failed/malformed readback, reconnect and concurrent flag clicks. These are authored
tests; real AI acceptance is supported separately by the bounded evidence above.

## Final measurement outcome — not a quality PASS

Workers entered the confirmed Terra/medium test phase. Existing focused 016 tests,
typecheck/build and real host a72 GUI evidence remain distinct from Quality Guard.
Final DEV audit on source 016 (build 34, sonar) is **BLOCKED**: two coverage-adapter
exit-1 attempts (`gui-labels.test.tsx` not ACTIVE; tests_executed 0) plus three known
parser SCAN_FAILED files: RuntimeExecutionLayout.ts, PairCoachClient.ts, paircoach.ts.
Coverage is UNKNOWN and freshness/provenance MISSING. A separate manual bounded
six-file run reports 61 PASS and 30.65% lines with 168-source inventory; it does not
prove successful audit coverage or full-suite execution. Historical configuration
bytes at audit time and cryptographic LCOV/run binding remain MISSING.

The disclosed temporary tooling used absolute host Node and six selected test files
instead of baseline 15; these are measurement-only deltas, not committed defaults
or a permanent reduction of active tests. All 168 sources remain in inventory.
The product retains portable `node` and the baseline test-selection policy.
DEV's original inspect NOT_FOUND is retained. ROOT's actual host inspect found
`src/server/http.ts` (OK lookup), but its unit is RED/evidence MISSING, not PASS.
One ROOT operator claim returned no result for more than eight minutes and was
stopped locally: **NO_RESULT_TIMEOUT**, no actual claim response, remote cancellation
unconfirmed. Do not label that call PASSED or REJECTED. The attempt receipt is
`root-host-proof/qg-final-claim-attempt-root.json`, not a fabricated raw claim.
VERIFY independently reviews the available receipts in `QG-RO-016.md`.

HUMAN ended costly measurement: no further scans/coverage/claims/recovery for this
scope, and no whole-repository repair merely to turn the gate green. Functional
acceptance is scoped and separate: Quality Guard is non-PASS and full Task 9 is not
accepted. Earlier c383 results and all original failures remain historical evidence.
This documentation does not claim publication, launch at 18120 or a completed
Run/Stop/full-product acceptance; those remain outside these bounded proofs.
