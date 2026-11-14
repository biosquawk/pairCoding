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
   tabs, original chat timestamps/languages, timer (paused on restore), and context.
   Switching to another project referencing the currently open **same** exercise
   asks you to close the current project first: no bypass of the source owner's lease.
6. PL/EN explicitly controls future AI output. It never infers language from task text,
   translates old messages, or changes the configured teacher model/effort. A toggle
   aborts/revokes old-language analysis and pending report generation; late frames have
   explicit locale tags and are rejected by the client. Retry a cancelled report in
   the newly selected language. Existing completed reports remain historical.

The theme and left-sidebar UI implementation is integrated separately by K.

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

## Actual native Codex continuity (real acceptance still required)

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

An argv/unit check does NOT establish native continuity. Final acceptance must really
chat with configured Codex, save an invariant, switch exercises, close/restart/reopen,
then resume the recorded ID from **another existing current directory** using its
recorded --cd and the same private native store, after normal scratch cleanup.
Verify that persona, invariant and selected language survive, and that Q does not
inherit P. This real native/LIVE proof is deferred until the confirmed Terra test phase.

## Focused reproduction (after model gate)

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
tests, not a claim that the Terra-gated execution or real AI proof has occurred.

Final worker Quality Guard is a separate integrated-candidate phase: actual usage,
audit(refresh coverage, sonar), inspect, claim; exact SHA, LCOV and real tool outcomes
must be retained. No such run is claimed by this implementation checkpoint.
