# Celowana QA GATE002 — tylko rzeczywisty adapter, provider kontrolowany

Baza produktu: `15da84219655179efc86e69c77d7d9bc6bf05a54` (K integrate-g2).
Nie jest to GATE002 PASS ani dowód Gemini. Linux Node probes i browser mają osobne wyniki.
G1 pięciu przypadków i AC027 NIE uruchamiaj tym zakresem; nie używaj `windows-browser.ps1`.

## Windows / ROOT po review K

1. Odbierz od K **zaakceptowany integrated SHA zawierający te pliki**, rozpakuj jego czysty
   archive w nowym katalogu QA. Zapisz exact SHA. Nie kopiuj `node_modules` z WSL.
2. W PowerShell przejdź do tego repo (katalog z `package.json`), Node >=22.22.0,
   lokalny Edge lub Chromium. Operator ma Node25.6.1 i Edge pod ścieżką poniżej.
3. Wykonaj po kolei, zatrzymując się przy każdym niezerowym exit code:

```powershell
node --version
npm --version
# Wpisz dokładny zaakceptowany przez K SHA, także gdy archive nie ma .git:
$env:PAIRCOACH_QA_REVISION = 'TU_DOKLADNY_ZAAKCEPTOWANY_SHA_OD_K'
New-Item -ItemType Directory -Force tests/qa/.runtime/g2/tmp | Out-Null
$env:TEMP = (Resolve-Path tests/qa/.runtime/g2/tmp).Path
$env:TMP = $env:TEMP
$env:PAIRCOACH_QA_BROWSER = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
node node_modules/playwright/cli.js test --config tests/qa/g2.config.ts --list
if ($LASTEXITCODE -ne 0) { throw 'G2 discovery failed' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'build failed' }
node node_modules/playwright/cli.js test --config tests/qa/g2.config.ts
if ($LASTEXITCODE -ne 0) { throw 'G2 browser failed: preserve JSON/traces, do not weaken assertions' }
```

Discovery: **5 tests**, wyłącznie TEST007/008/009/012/025+026. Nie uruchamia smoke ani metrics.
Serwer nie jest współdzielonym procesem na8080: każdy przypadek uruchamia rzeczywisty
`createPairCoachServer` na własnym loopback/port0 i zamyka tylko swój serwer. Klient
korzysta z istniejącego mapowania same-origin. Brak testowych endpointów, mutacji instancji
adaptera, ręcznego acquireCoach/write/emit lub zastępowania ACK.

Zachowaj logi komend i exit codes, `tests/qa/.runtime/g2/playwright-report.json`,
`tests/qa/.runtime/g2/results/` (załączniki provider-context/dysk, traces przy FAIL)
i katalogi fixture `tests/qa/.runtime/g2/case-*`. Są tam wyłącznie syntetyczne dane QA;
trace może zawierać efemeryczny token QA, nigdy nie używaj rzeczywistych sekretów.
Raportuj 5 PASS/FAIL oddzielnie od NOT_RUN i flaky. Brak retries/skip/xfail.

## Linux lokalnie (nie dowodzi Windows ani browser)

Z root repo, z własnym działającym Node i istniejącym `npm ci`:

```bash
mkdir -p tests/qa/.runtime/g2/tmp
export TMPDIR="$PWD/tests/qa/.runtime/g2/tmp"
node --import tsx --test tests/qa/g2/probes.test.ts
node node_modules/playwright/cli.js test --config tests/qa/g2.config.ts --list
```

3 Node probes: autonomiczne opóźnione AI + realny zapis/stale negatywny i fresh pozytywny;
cooldown; zgoda/wykluczenia/Host/Origin/token/ścieżki/symlink. Rzeczywisty adapter ładowany
przez istniejący **scoped tsx/cjs/api**: Playwright ESM sam nie obsługuje importu JSON
schematu produktu. Nie zmieniamy produktu, nie generujemy zastępczego serwera.

## Stałe oracles / przypadki

- 007: edycja bez CHAT uruchamia AI; przez >=2.1s oczekiwania realne klawisze i CODE_CHANGED/OK ACK
  zapisują nową treść. Provider ignoruje abort aż do kontrolowanego zwrotu starego planu;
  zero przejęć/zapisów tego planu, max1 actual call. Nowy plan to dodatnia kontrola.
- 008: prawdziwa dwukrokowa demonstracja i opóźniony wyłącznie rzeczywisty pierwszy STEP_RENDERED.
  W czasie COACH użytkownik zaznacza inną linię, kopiuje Ctrl+C do prawdziwego clipboardu,
  przewija i nie może wpisać x. Kroki wstawiają dokładnie na linii1, nie w zaznaczenie.
  Obowiązuje NIEZMIENIONY produktowy timeout2s; jeśli wygasł, zachowaj trace, nie zwiększaj go.
- 009: HINT+pointer rzeczywiście renderują się w Monaco, fokus i owner pozostają po stronie
  ucznia. Następny realny x+ACK wygasza obie kotwice starej wersji.
- 012: rzeczywiste weto; czekanie/przewijanie/whitespace nie wyzwala provider call.
  Potwierdzony nowy kod dopiero po2s lub bezpośredni CHAT automatycznie odblokowują analizę.
  Świeży Run jako trzeci rodzaj faktu: NOT_RUN w tej bazie bez G3; bez sztucznego RUN_STATE.
- 025/026: zgoda OFF to zero calls przy sprawnej ręcznej edycji. ON: realne syntetyczne
  pliki sekretów nie wchodzą do kontekstu nawet przy **/*; dokładny token jest redagowany.
  Node probe dodatkowo atakuje prawdziwy Host/Origin/ścieżki/symlink i sprawdza dodatni GET.

Pełne Gemini, natywne Windows junction/ACL, G3 Runner/nowy Run, raporty i cały AC025/026
poza opisanymi powierzchniami pozostają osobnymi dowodami. Nie traktuj provider-double jako Gemini.
