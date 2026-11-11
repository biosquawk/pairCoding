> **HISTORYCZNY dokument / dowody dokładnie ówczesnych rewizji.** Ten plik nie
> opisuje bieżącego providera ani statusu wydania. Aktualne: [README](../../../README.md),
> [Windows start (w tym raport §7)](../../../docs/windows-start.md). ETAP8 IMPLEMENTED /
> PENDING_FINAL_QA; pełna kampania po implementacji9. Poniższe oryginalne wyniki,
> w tym FAIL/NOT_RUN, pozostają bez zmian i nie są nowym PASS.

# JEDEN request native Windows — przygotowany, JESZCZE NIE WYSŁANY DO ROOT

## Warunek uruchomienia — K, nie operator, uzupełnia znane dane

Baza przygotowania55baa0556cc7cc683c794365a7980aff4b04377f NIE jest finalQAsha.
Najpierw K integruje i odbiera P6 testpatch (w tym helpers.ts) oraz P2 trzy przypadki
w tests/qa/mvp2-reconcile.config.ts, wraz z korektą P2 finish-network-loss wskazaną przez K491e2313. Potem K przydziela P3 finalny40-znakowy SHA,
weryfikuje dokładny diff i wysyła JEDEN request z tym dokumentem, archive Git tego SHA,
SHA256 archive, listą wszystkich tracked plików i SHA256 każdego pliku. Nie wysyłać
wielu rozłącznych próśb do ROOT. Ten dokument bez powyższych danych nie zleca kampanii.
P3 po frozenSHA potwierdza aktualność komend/discovery (P2 config musi mieć3cases).

Jest to sprawdzenie QA źródeł, NIE smoke paczki użytkowej. Produkcyjny klient nadal 5 s.
Nie kopiować WSL node_modules. Nie modyfikować produktu/fixtures/testów/config ani limitów.
Nie uruchamiać npm test, dawnych G1/G2/29, crash21 ani restore3 na608 ponownie.
Nie restartować/nie zajmować właścicielskiego8080, nie używać8765..8768.

## Jedna wyłączna sesja

Windows Node25.6.1 x64, istniejący Edge, normalny aktywny pulpit. K potwierdza brak innej
sesji focus/clipboard. P2 potwierdził kolejność P3→P2→AC027 (message e27b2551).
ROOT rozpakowuje zaufany archive do NOWEGO podkatalogu:
`C:\Users\dbobe\AppData\Local\Temp\thalamus-paircoach-20261110-qa\mvp2-<first7-finalSHA>`.
Nie nakłada na stare evidence. Sprawdza SHA256 archive oraz każdy tracked plik przed/po.
Runtime/trace mogą zawierać efemeryczne tokeny QA: zachować do odczytu K, nie do ZIP klienta.

K przekazuje `$Revision` i `$RepoDir` jako konkretne wartości z finalnego archive.
Nie wpisywać55baa, cecdee0 lub nieprzeczytanego commitu jako finalnego wyniku.

```powershell
# Te dwie wartości dostarcza K w finalnym, jednym requestcie, bez zgadywania przez ROOT.
$Revision = Read-Host 'Exact FINALNY QA SHA od K'
$RepoDir = Read-Host 'Nowy katalog rozpakowanego Git archive tego SHA'
if ($Revision -notmatch '^[a-f0-9]{40}$') { throw 'Brak exact SHA' }
if ($Revision -in @('55baa0556cc7cc683c794365a7980aff4b04377f','cecdee0bf5148278bfa6525d014db5c91ed6c912')) { throw 'To nie frozen QA z P2/P6' }
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $RepoDir
if (-not (Test-Path tests/qa/mvp2-reconcile.config.ts)) { throw 'Brak scalonych trzech P2 cases: STOP' }
$env:PAIRCOACH_QA_REVISION = $Revision
$env:PAIRCOACH_QA_BROWSER = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path -LiteralPath $env:PAIRCOACH_QA_BROWSER)) { throw 'Brak Edge: nie skip, podaj rzeczywisty Chromium' }
$env:PAIRCOACH_QA_PORT = '18083'
if (Get-NetTCPConnection -LocalPort 18083 -State Listen -ErrorAction SilentlyContinue) { throw 'Testport zajęty: nie zabijać procesu ani reuseExistingServer' }
New-Item -ItemType Directory -Force artifacts/g3/tmp | Out-Null
$env:TEMP = (Resolve-Path artifacts/g3/tmp).Path
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force artifacts/mvp2-native | Out-Null
Start-Transcript -Path artifacts/mvp2-native/operator.log
try {
    node --version
    npm.cmd --version
    (Get-Item -LiteralPath $env:PAIRCOACH_QA_BROWSER).VersionInfo | Select-Object ProductVersion, FileVersion
    npm.cmd ci --include=dev --no-audit --no-fund
    Write-Output "NPM_CI_EXIT=$LASTEXITCODE"
    if ($LASTEXITCODE -ne 0) { throw 'Instalacja FAIL; zachowaj log' }
    npm.cmd run typecheck
    Write-Output "TYPECHECK_EXIT=$LASTEXITCODE"
    if ($LASTEXITCODE -ne 0) { throw 'tsc FAIL' }
    node --import tsx --test tests/qa/g3/controls.test.ts
    Write-Output "HARNESS6_EXIT=$LASTEXITCODE"
    if ($LASTEXITCODE -ne 0) { throw 'Harness/real OS ACL niegotowy: nie uruchamiaj browsera' }
    node node_modules/playwright/cli.js test --config tests/qa/g3.config.ts --list
    Write-Output "DISCOVERY19_EXIT=$LASTEXITCODE"
    if ($LASTEXITCODE -ne 0) { throw 'Discovery19 FAIL' }
    node node_modules/playwright/cli.js test --config tests/qa/mvp2-reconcile.config.ts --list
    Write-Output "P2_DISCOVERY3_EXIT=$LASTEXITCODE"
    if ($LASTEXITCODE -ne 0) { throw 'P2 discovery FAIL' }
    node node_modules/playwright/cli.js test --config tests/qa/metrics.config.ts --list --grep 'AC-027 TEST-027:'
    Write-Output "METRICS_DISCOVERY1_EXIT=$LASTEXITCODE"
    if ($LASTEXITCODE -ne 0) { throw 'Metrics discovery FAIL' }
    # Operator sprawdza dokładne liczby:19 /3 /1; inne liczby = STOP do K, nie poprawka discovery.
    # Tylko import aktualnego configu, nie atrapa. Oczekiwane1server,reference=1,port18083,reuse=false.
    node --import tsx --input-type=module -e "const c=(await import('./tests/qa/metrics.config.ts')).default; console.log(JSON.stringify({webServer:c.webServer,workers:c.workers,retries:c.retries,timeout:c.timeout},null,2))"
    if ($LASTEXITCODE -ne 0) { throw 'Resolved config FAIL' }
    npm.cmd run build
    Write-Output "BUILD_EXIT=$LASTEXITCODE"
    if ($LASTEXITCODE -ne 0) { throw 'Build FAIL' }

    # Etap1 — P3:19 nowych rzeczywistych GUI, jedna próba, headed, workers1/retries0.
    node node_modules/playwright/cli.js test --config tests/qa/g3.config.ts
    $g3Exit = $LASTEXITCODE
    Write-Output "P3_GUI19_EXIT=$g3Exit"
    # Etap2 dopiero po zamknięciu browsera/listenerów etapu1; żadnego równoległego okna.
    # P2 owns exact3: slow restore+finish UNKNOWN/late-result, real draft conflict, hardkill/restart/no replay.
    node node_modules/playwright/cli.js test --config tests/qa/mvp2-reconcile.config.ts
    $p2Exit = $LASTEXITCODE
    Write-Output "P2_GUI3_EXIT=$p2Exit"
    if (($g3Exit -ne 0) -or ($p2Exit -ne 0)) { throw 'Funkcjonalny FAIL: zachowaj WS/traces/fixtures, bez auto-rerun/nowej100. K dobierze dalszy zakres' }

    # Etap3 — tylko pełna kampania100, NIE stare2AC011 controls.
    $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
    $env:PAIRCOACH_QA_LOAD_NOTE = "CPU at start=$cpu%; shared host; no exclusive load isolation"
    Write-Output $env:PAIRCOACH_QA_LOAD_NOTE
    node node_modules/playwright/cli.js test --config tests/qa/metrics.config.ts --grep 'AC-027 TEST-027:'
    $metricsExit = $LASTEXITCODE
    Write-Output "AC027_FULL100_EXIT=$metricsExit"
    if ($metricsExit -ne 0) { throw 'AC027 FAIL: zachowaj pierwotne100/przerwany przebieg, nie koryguj progów/retry' }
} finally {
    Get-ChildItem -Recurse -File -Filter '*playwright-report.json' | Select-Object FullName
    Stop-Transcript
}
```

## Oczekiwane dane i odczyt wyniku

Oddzielnie:6harness;19P3 GUI;3P2 GUI;1case100trials. Nie sumować jako29AC ani nową29Runner.
TEST015 expiry celowo czeka60s, limit85s pozostaje niezmieniony. OS ACL dotyczy tylko własnego
nowego snapshots-v1 i jest zdejmowany finally. Brak capability oznacza NOT_RUN właściwego etapu,
nie PASS/skip i nie blokadę niezależnego odczytu źródeł. Gdy teardown nie jest potwierdzony,
nie zaczynaj kolejnego browsera: podaj własne PID i stan, nie globalny taskkill.

Zachować: transcript+komendy/exity/rewizja/Win+Node+Edge/CPU/RAM/load, wszystkie
artifacts/g3 (case-* z realnymi plikami, facts/snapshots, results/traces/attachments/report),
wszystkie P2 artefakty według jego configu, cały tests/qa/.runtime oraz wszystkie odnalezione
reference-playwright-report.json (historycznie reporter zagnieżdżał ścieżkę), AC027-reference.json.
Nie wymuszać jednego oczekiwanego pathname dla istniejącego reportera.

AC027 musi mieć cztery tablice po100 skończonych próbek, ownerWasCoach=true dla wszystkich,
p95 nearest-rank oraz max, max<100/50/200/200ms, aktywny plik≤100KiB i100files. Przy konflikcie
obie wersje+decyzja KEEP_LOCAL+nowy CODE_CHANGED/ACK/dysk; pierwotne próbki bez resetu.
Jeśli case przerwany przed100, to FAIL/incomplete, nie wynik progów i nie PASS po30próbach.
Generowanie AI pozostaje osobno, nie przypisuj modelowi czasu renderowania.

ROOT odsyła źródłowy archive/hash i porównanie WSZYSTKICH tracked plików po wykonaniu,
osobno PASS/FAIL/flaky/NOT_RUN, minimalny expected/actual pierwszego FAIL oraz odczytywalne ścieżki.
K/P3 czytają wyniki, a K wykonuje odbiór. Same logi/summary nie są ACCEPTED ani sygnałem alarmu.
