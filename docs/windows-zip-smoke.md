# ROOT/K — MVP2: świeży finalny ZIP na odrębnym Windows

**NOT_FINAL, procedura do wykonania**, nie receipt. Dopiero K podaje exact
finalacceptedSHA, ZIP/manifest/SHA256SUMS i zaufany hash. Bez finalSHA nie pakuj
właściwego ZIP. Ta próba sprawdza dystrybucję i podstawowy scenariusz użytkownika;
nie zastępuje P3 G3/19/AC027/100 ani native hard-kill/recovery. Nie powtarzaj
G1/G2/29 ani niezmienionych native60821/21+3/3. Produkcyjny timeout pozostaje 5 s.
Nie restartuj właścicielskich usług na8080/8081, nie ponawiaj alarmu.
Dla aktualnego Lightweight po weryfikacji/instalacji z §1 użyj prywatnej kopii
przykładu i publicznego `runtime:prepare` oraz startu z config według
[windows-polyglot §2–6](windows-polyglot.md#2-nowa-prywatna-kopia-przykładu-i-pełne-ustawienia).
Poniższy syntetyczny smoke nie zastępuje Spring21 ani native odbioru Lightweight.

## 1. Czysty katalog → hashe → npm ci → clean → build

Windows PowerShell, native Node >=22.22.0/npm, Edge/Chrome; bez WSL node_modules.
Otwórz PowerShell w katalogu przekazanej dostawy. Porównaj ZIP SHA256 z zaufanym
raportem K (nie tylko manifestem). Wszystkie komendy natywne: zapisz exit code.

```powershell
$ErrorActionPreference = 'Stop'
$m = Get-Content .\manifest.json -Raw | ConvertFrom-Json
$zip = Join-Path (Get-Location) $m.archive.name
if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower() -ne $m.archive.sha256) { throw 'ZIP hash FAIL' }
$mh = (Get-FileHash .\manifest.json -Algorithm SHA256).Hash.ToLower()
if (-not ((Get-Content .\SHA256SUMS) -contains "$mh  manifest.json")) { throw 'Manifest hash FAIL' }
$qa = Join-Path $env:LOCALAPPDATA ('Temp\PairCoachMVP2ZipQA-' + [guid]::NewGuid().ToString())
if (Test-Path $qa) { throw 'QA katalog istnieje — nie nadpisuj' }
New-Item -ItemType Directory -Path $qa | Out-Null
Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $qa 'install')
$app = Join-Path (Join-Path $qa 'install') $m.packageId
Set-Location $app
foreach ($f in $m.files) {
  if ((Get-FileHash -LiteralPath (Join-Path $app $f.path) -Algorithm SHA256).Hash.ToLower() -ne $f.sha256) { throw ('Source hash FAIL: ' + $f.path) }
}
$before = Get-FileHash package.json,package-lock.json -Algorithm SHA256
node --version
npm.cmd --version
[Environment]::OSVersion.VersionString
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci FAIL' }
$after = Get-FileHash package.json,package-lock.json -Algorithm SHA256
if (Compare-Object $before $after -Property Path,Hash) { throw 'Dependency files changed' }
npm.cmd run clean
if ($LASTEXITCODE -ne 0) { throw 'Clean FAIL' }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build FAIL' }
```

`clean` ma usunąć wyłącznie wygenerowany dist. Nie używaj --force, --omit=dev,
nie kopiuj plików źródeł ani dist z repo. W razie FAIL zachowaj fixture i log.

## 2. Nowy syntetyczny workspace + realne testy demonstracyjne

W tym samym oknie:

```powershell
$workspace = Join-Path $qa 'workspace'
$data = Join-Path $qa 'data'
New-Item -ItemType Directory -Path $workspace,$data | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $workspace 'challenge.md'), '# Zadanie: sum(a,b) ma dodawac dwie liczby.', $utf8)
[IO.File]::WriteAllText((Join-Path $workspace 'solution.js'), "function sum(a,b) { return a+b; }`nmodule.exports=sum;`nif(require.main===module) console.log(sum(2,3));`n", $utf8)
$tests = @'
const fs=require('node:fs'), assert=require('node:assert/strict');
const sum=require('./solution.js');
let failed=false;
try { assert.equal(sum(2,3),5); } catch { failed=true; }
fs.mkdirSync('target',{recursive:true});
fs.writeFileSync('target/run-'+process.env.PAIRCOACH_RUN_ID+'.xml',
  '<testsuite name="sum" tests="1" failures="'+Number(failed)+'" errors="0" skipped="0"><testcase name="two-plus-three">'+(failed?'<failure message="sum assertion failed"/>':'')+'</testcase></testsuite>');
console.log('One real assertion: '+(failed?'FAILED':'PASSED'));
process.exitCode=failed?1:0;
'@
[IO.File]::WriteAllText((Join-Path $workspace 'tests.cjs'), $tests, $utf8)
$env:PAIRCOACH_WORKSPACE_DIR = $workspace
$env:PAIRCOACH_DATA_DIR = $data
$env:NODE_ENV = 'development'
```

Własny istniejący natywny codex.exe i login ustaw jak **windows-start.md §2**;
PAIRCOACH_COACH_PROVIDER=codex i PAIRCOACH_CODEX_EXE. Nie wykonuj tam tworzenia
zadania z tamtej sekcji; publiczny `npm.cmd start` wykonaj tutaj w §3
z lokalnym `PAIRCOACH_HTTP_PORT=18080`. Nie odczytuj auth.json,
nie drukuj tokenów/całego env. Zapisz wersję CLI, nie dane uwierzytelnienia.

## 3. Publiczny start na 18080 i realny health/API

Sprawdź, że 18080 jest wolny. Obcy listener = przerwij tylko tę próbę,
nie zabijaj go i nie zmieniaj8080/8081. Bez nadpisania domyślny port to8080;
nie ma flagi `--port`. Ustawienie dotyczy tylko tego PowerShell i jego procesu:

```powershell
$env:PAIRCOACH_HTTP_PORT = '18080'
if (Get-NetTCPConnection -State Listen -LocalPort 18080 -ErrorAction SilentlyContinue) { throw 'Port 18080 zajety' }
npm.cmd start
```

Dla Lightweight użyj zamiast samego `npm.cmd start` jego publicznej postaci
z `--runtime-config` i `--prepared-runtime` według windows-polyglot §4,
po potwierdzonym własnym prepare. Nie używaj factoryhelpera zamiast produktu.
Zapisz rzeczywisty PID listenera oraz cwd `$app` i dokładny URL z logu serwera.
W drugim PowerShell sprawdź:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 18080 | Select-Object LocalAddress,LocalPort,OwningProcess
(Invoke-WebRequest 'http://127.0.0.1:18080/' -UseBasicParsing).StatusCode
try { Invoke-WebRequest 'http://127.0.0.1:18080/api/session' -UseBasicParsing | Out-Null; throw 'Brak 401' }
catch { if (-not $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 401) { throw } }
```

Wymagane: listener **127.0.0.1**, PID własnego procesu publicznego startu, GET/200 i bez tokenu401.
Samo exit0/start log to nie health. Brak osobnego endpointu /health nie oznacza
próby nieistniejącej ścieżki. Nie zapisuj odpowiedzi /dev/bootstrap.

## 4. Normalny GUI tego samego ZIP/backendu

Otwórz **http://127.0.0.1:18080/** w jednej karcie Edge bez mock/symulatora.

1. LIVE/Student → solution.js → Start sesji → zmień `a+b` na `a-b` i poczekaj
   na autosave/ACK. Porównaj bajty z plikiem na dysku. Włącz i zapisz zgodę AI;
   zapytaj w czacie: „Opisz bieżące działanie sum i zadanie, bez zmieniania kodu”.
   Odpowiedź musi odnieść się do
   rzeczywistego odejmowania/zadania, przez normalnego CodexProvider — nie
   osobny CLI probe, login status, fallback ani QA injection. Zachowaj krótki
   niesekretny fragment odpowiedzi i skorelowane ID. Weto nie jest Stop Run.
2. Po odebraniu realnej odpowiedzi wyłącz i zapisz zgodę AI na czas lokalnych
   kontroli Run/restore (nie mock; autonomiczny pokaz nie ma zmieniać fixture).
   Sprawdź/poprzez własną edycję ustaw `a-b` w solution.js i poczekaj na ACK.
   W ustawieniach rozwiń **Konfiguracja Run/Test i kontekstu AI**. Zatwierdź
   poniższy JSON przyciskiem **Zapisz Ustawienia** (dostosuj executable):

```json
[
 {"kind":"RUN_MAIN","executable":"C:/Program Files/nodejs/node.exe","args":["solution.js"],"cwd":".","timeoutMs":10000,"testReportFormat":"NONE","testReportGlob":null},
 {"kind":"RUN_TESTS","executable":"C:/Program Files/nodejs/node.exe","args":["tests.cjs"],"cwd":".","timeoutMs":10000,"testReportFormat":"JUNIT_XML","testReportGlob":"target/run-{runId}.xml"}
]
```

3. **Run Main** → Konsola: wynik -1, SUCCEEDED/exit0 (to nie PASSED testów).
   **Run Tests**: jeden rzeczywisty test nie przechodzi, FAILED; nie zmieniaj
   asercji/raportu. Popraw własnym wpisem `a-b` na `a+b`, poczekaj na zapis/ACK,
   ponów Run Tests: świeży raport związany z nowym runId, testCount1/PASSED.
   Sesja nadal aktywna. To dwie kontrolne próby scenariusza ZIP, nie powtórka29.
4. **Zakończ** → powód → **Potwierdź i Wygeneruj Raport** raz. Oczekuj
   FINISHED i raportu PENDING→READY/FAILED. READY z lokalnych faktów nie jest
   dowodem realnego Gemini. FAILED zachowuje fakty i udostępnia jawne Ponów.
   Nie żądaj błędu providera sztucznie w tym smoke; P3 ma osobny kontrolny case.
5. Po zakończeniu: zapisz marker w solution.js (manualna edycja pozostaje
   dostępna), sprawdź bajty. Ustawienia → **Kopie odzyskiwania (Snapshots)** →
   **Poproś o przywrócenie** końcowej kopii → **Nie, pracuję dalej**: marker
   pozostaje. Ponów samo żądanie nowej propozycji, tym razem **Tak, wykonaj**
   raz: marker znika zgodnie z zakresem, kopia sprzed restore dostępna. Raport
   końcowy nadal dotyczy wcześniejszego zamrożonego materiału.
6. Przy >5s UNKNOWN nie ponawiaj decyzji/finish, nie zmieniaj timeoutu. Odczytaj
   późny wynik i sprawdź pojedynczą mutację oraz zniknięcie odpowiedniego bannera.
   Mały fixture nie musi przekroczyć5s: wtedy ten wariant jest NOT_EXERCISED,
   nie PASS. P3 ma rzeczywisty duży GUI case na finalnym kandydacie; historyczny
   transport6083/3 sam nie dowodzi nowego GUI.

## 5. Stop → restart i powiązanie z pełnym odbiorem

Po zapisach zakończ tylko QA serwer Ctrl+C i sprawdź brak jego listenera18080.
Zachowaj workspace/data/drafty, zrób kopię do nowych nazw. W tym samym cwd,
środowisku i na tych samych ścieżkach uruchom §3 ponownie **bez tworzenia fixture**.
Sprawdź LIVE, treść plików, listę kopii, brak ponownej mutacji; stop i brak listenera.
Po końcowym zatrzymaniu usuń nadpisanie tylko z tej sesji PowerShell:
`Remove-Item Env:PAIRCOACH_HTTP_PORT -ErrorAction SilentlyContinue`.
To zwykły restart. **Nie oznaczaj go hard-kill recovery PASS**. Crash/restart,
obce zmiany, late ACK/finish GUI, drzewo Run i 19/100 rozliczają P3/ROOT osobno
na uzgodnionym exactSHA, bez drugiej równoległej sesji przeglądarkowej.

Zapis końcowy: czas UTC, exactSHA/packageId/ZIP SHA256, Windows/Node/npm/Git/Edge/
Codex, komendy/cwd/exit/status, obserwowane bajty/ID i ograniczenia. Osobno:
ZIP, npmci, clean, build, proces/health, API401, GUI/ACK, realCodex, RunMain,
RunTests neg/pos, finish/report, restore neg/pos, stop/restart, hardkill,
pełny19/100 i dostępność właściciela — **PASS/FAIL/NOT_RUN**.
Nie przenoś historycznych PASS na nowy run/ZIP. K po odczycie/kontrteście decyduje.
MVP1 live8080 pozostaje nietknięte. Rollback: osobna wcześniejsza instalacja i
jej zgodne dane; nową pracę zachować, nie podłączać staregoMVP1 do danychMVP2.
