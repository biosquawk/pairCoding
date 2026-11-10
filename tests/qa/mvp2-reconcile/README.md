# MVP2 GUI reconciliation (P2, test-only)

Base product: `55baa0556cc7cc683c794365a7980aff4b04377f`. K supplies the final
integrated SHA before ROOT execution. This is **not a GUI PASS receipt**.
Ownership: only this directory and `tests/qa/mvp2-reconcile.config.ts`.
No product, G3/metrics/helper, timeout, package or lock edits.

## Three exact GUI cases

1. **MVP2-1** — `Start sesji` → settings title `Ustawienia projektu (AI Consent, Task Mode, Profile)`
   → snapshot `MVP2 original` → `Poproś o przywrócenie` → `Tak, wykonaj`.
   A separate real backend sleeps6500ms at BEFORE_PUBLICATION. The React role-alert
   must show `Brak ACK decyzji; wynik nieznany` at the unchanged production5s;
   no terminal ACK exists yet. A late exact replyTo ACK OK removes only this
   uncertainty/card. One accepted envelope, one pre-restore backup, one PUBLISHED
   and COMMITTED; reconnect after terminal cannot restore again. Real disk matches seed.
   Then `🏁 Zakończ` → `Potwierdź i Wygeneruj Raport`;6500ms at real file capture.
   UNKNOWN includes the original requestId; late matching report + authenticated GET
   and FINISHED clear it; one finishPOST/one final snapshot, real READY report rendering.
2. **MVP2-2** — normal accepted real restore with actual server frames parked by the
   explicit WS latency fixture. Disk changes for real; the GUI still legally owns the
   old document. Normal Monaco keyboard typing makes a retained unsent CODE_CHANGED
   draft (latency fixture parks the save; no model/store/dispatch APIs).
   Deliver unchanged real server frames → `Konflikt synchronizacji:`.
   `Porównaj zachowane wersje` exposes both literal `Draft lokalny konfliktu` and
   `Wersja z dysku konfliktu`. No silent disk write across >150ms. Both versions and
   envelope are attached BEFORE any resolution. `Połącz ponownie` authorizes a fresh
   snapshot without sending the parked save; `Załaduj wersję z dysku` then archives
   both versions in actual localStorage and clears conflict without a new restore.
3. **MVP2-3** — accept via GUI, real child reaches BEFORE_PUBLICATION with a durable
   journal/captured human bytes. Parent SIGKILLs only that owned child; no graceful
   cleanup. Restart same root/data/token/port. Technical rollback restores human bytes,
   signed ROLLED_BACK exists, no PUBLISHED/COMMITTED. `Połącz ponownie` sees a changed
   session and SESSION_REPLACED, never replays old consent. Second hard restart leaves
   data hashes and retained source+backup identical, no forward effect or second rollback.

## One native Windows session, after P3 and before AC027

ROOT executes only after K provides the exact integrated SHA. Never beside another
focus/clipboard session and never change/stop live8080. Each case chooses port0 and
asserts it is not8080 or8765..8768; restart uses only the same owned ephemeral port.
Use the already clean Windows npm installation from the combined QA run; if none,
`npm ci` on that exact archive first. From the candidate repo in PowerShell:

```powershell
$ErrorActionPreference = 'Stop'
$env:PAIRCOACH_QA_REVISION = (git rev-parse HEAD) # or K's exact archive SHA, no fake value
$env:PAIRCOACH_QA_BROWSER = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
Remove-Item Env:PAIRCOACH_QA_HEADLESS -ErrorAction SilentlyContinue
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
node --import tsx --test tests/qa/mvp2-reconcile/controls.test.ts
if ($LASTEXITCODE -ne 0) { throw 'Harness controls failed' }
npx playwright test --config tests/qa/mvp2-reconcile.config.ts --list
if ($LASTEXITCODE -ne 0) { throw 'Discovery failed' }
# Exactly3 cases, no inherited webServer, retries0/skips0/workers1.
npx playwright test --config tests/qa/mvp2-reconcile.config.ts
if ($LASTEXITCODE -ne 0) { throw 'GUI acceptance failed: preserve artifacts before retry' }
```

Record all command exits, Node/OS/browser version and exact source SHA. Preserve
`artifacts/mvp2-reconcile/` (runtime dirs, JSON report, trace, screenshots, attachments)
BEFORE any rerun. Expected controls3PASS; GUI3PASS only after actual execution.
All screenshots are1600x1000 and prove their individual rendered state, not all behavior.

## Limits and evidence

6500ms checkpoint latency is deliberate fault/latency injection, NOT a native scaled
restore/performance benchmark. Test late-result waits20s are explicit and do not
change production client5s. Report text is injected only at the AI boundary; real
ReportService/snapshot/facts/HTTP/WS remain in use. This is NOT real Codex/Gemini proof.
Wire attachments redact HELLO token, record exact request/reply correlation, request
counts, actual auth presence and delivery timestamps. Runtime checkpoints + FS hashes
separate forward effects from technical rollback. No raw external provider is called.

Local WSL browser preflight currently fails: libnspr4.so missing (exit127). No local
GUI/visual/keyboard/mobile PASS is claimed. Three self-tests validate harness/discovery,
auth/restart/rebind and exact ACK observation; they do not substitute for these GUI cases.
