# PairCoach MVP2 — Windows: instalacja i praca

> **Lightweight: IMPLEMENTED / PENDING_FINAL_QA.** To opis bieżącego kandydata,
> nie odbiór ani wydanie. Docker/polyglot i publiczne prepare są zaimplementowane;
> native Windows/PowerShell oraz świeży ZIP wymagają rzeczywistych dowodów
> na finalnym SHA. Ten dokument nie nadaje im statusu PASS.

MVP2 rozszerza MVP1 o snapshot/recovery, Run/Test i raport. Ten dokument opisuje
obsługę, **nie zastępuje odbioru**. Przed dystrybucją K wiąże instrukcję, ZIP
i wyniki Windows z jednym finalnym SHA. Dopóki nie ma tych wyników, kandydat
ma status **NOT_FINAL**. Nie używaj tej instrukcji do aktualizacji żywego MVP1.
Wykonuj pierwszą próbę na kopii zadania. Manifest identyfikuje źródła; rzeczywiste
PASS/FAIL/NOT_RUN oraz ograniczenia są w raporcie dostawy K.

## 1. Rozpakuj i zbuduj — jedno okno PowerShell

Wymagane: Windows, PowerShell, Node.js **>=22.22.0** z npm, Edge/Chrome,
internet do instalacji i AI oraz natywny `codex.exe` zalogowany na **Twoim**
koncie. Nie kopiuj node_modules z WSL ani auth.json. Nie potrzebujesz dodatkowego
klucza API dla wariantu Codex z logowaniem ChatGPT. Do Run/Test wymagany jest
Docker Desktop z engine Linux amd64/x86_64; JDK/Maven,
Node zadania i Python działają w kontenerach, bez hostowego fallbacku. Nie instaluj
dodatkowych usług Thalamusa ani hostowych toolchainów zadania. Poniżej jest jeden
bieżący przepływ Lightweight: prywatna kopia → pełne settings → publiczny prepare
→ publiczny start. Inne profile i topologię WSL opisuje
[przewodnik](windows-polyglot.md#1-platforma-i-profil).

Z katalogu dostawy K skopiuj **razem** ZIP, `manifest.json` i `SHA256SUMS` do
nowego folderu w Eksploratorze. Otwórz w nim PowerShell. Porównaj zaufany hash
ZIP z raportem K; sam manifest nie potwierdza zaufania do nadawcy. Wykonaj:

```powershell
$ErrorActionPreference = 'Stop'
$manifestPath = (Resolve-Path .\manifest.json).Path
# Hash manifestu otrzymaj niezależnie z zaufanego raportu/kanału K, nie z tego ZIP/SHA256SUMS.
$trustedManifestSha = Read-Host 'Wklej zaufany SHA256 manifest.json od K (64 male znaki hex)'
if ($trustedManifestSha -cnotmatch '^[a-f0-9]{64}$') { throw 'Brak zaufanego SHA256 manifestu' }
if ((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLower() -ne $trustedManifestSha) { throw 'Niezaufany manifest' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$zip = Join-Path (Get-Location) $manifest.archive.name
if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower() -ne $manifest.archive.sha256) { throw 'Hash ZIP niezgodny' }
$mh = (Get-FileHash .\manifest.json -Algorithm SHA256).Hash.ToLower()
if (-not ((Get-Content .\SHA256SUMS) -contains "$mh  manifest.json")) { throw 'Hash manifestu niezgodny' }
$homeDir = Join-Path $env:LOCALAPPDATA 'PairCoachMVP2'
New-Item -ItemType Directory -Path $homeDir -Force | Out-Null
$destination = Join-Path $homeDir ('install-' + $manifest.sourceCommit)
if (Test-Path $destination) { throw 'Ta instalacja już istnieje — nie nadpisuj jej' }
Expand-Archive -LiteralPath $zip -DestinationPath $destination
$app = Join-Path $destination $manifest.packageId
Set-Location $app
foreach ($file in $manifest.files) {
    $actual = (Get-FileHash -LiteralPath (Join-Path $app $file.path) -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $file.sha256) { throw ('Niezgodny plik: ' + $file.path) }
}
# Powyższe hashe obejmują też helper przed jego wykonaniem. Pełna walidacja
# zestawu/ścieżek/bajtów i nowej kopii następuje PRZED npm.
$verifiedApp = Join-Path $destination 'verified-source'
$identity = Join-Path $destination 'source-verification.json'
node .\scripts\verify-source-revision.mjs --source $app --revision $manifest.sourceCommit `
  --destination $verifiedApp --evidence $identity `
  --trusted-manifest $manifestPath --manifest-sha256 $trustedManifestSha
if ($LASTEXITCODE -ne 0) { throw 'Weryfikacja źródeł FAIL — npm NOT_RUN; zachowaj dowody' }
$app = $verifiedApp
Set-Location $app
node --version
npm.cmd --version
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci FAIL — zachowaj błąd, nie używaj --force' }
npm.cmd run clean
if ($LASTEXITCODE -ne 0) { throw 'Clean FAIL — zachowaj błąd' }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build FAIL — zachowaj błąd' }
```

`build` tworzy UI w `dist/`, nie samodzielny EXE. `npm start` używa TS/tsx;
nie stosuj `--omit=dev`. Instalacja, build i start to osobne wyniki.

## 2. Ustaw Codex, przygotuj prywatne zadanie i uruchom Lightweight

W **tym samym oknie** odszukaj natywny EXE, nie `codex.cmd` ani WSL:

```powershell
$codex = Join-Path $env:APPDATA 'npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
if (-not (Test-Path -LiteralPath $codex -PathType Leaf)) {
    $codex = (Get-Command codex.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
}
& $codex --version
& $codex login status
if ($LASTEXITCODE -ne 0) { throw 'Zaloguj własny Codex przed startem aplikacji' }
```

Pierwsza ścieżka to potwierdzona przez ROOT instalacja npm na Windows. Jeżeli
masz inną instalację i EXE nie jest w PATH, ustaw `$codex` na pełną
ścieżkę do **istniejącego natywnego codex.exe** znalezionego na swoim komputerze.
Przy braku logowania uruchom lokalnie `& $codex login` i wybierz własne konto
ChatGPT, potem powtórz `login status`. Nie przesyłaj plików logowania ani tokenów.
Samo poprawne logowanie **nie dowodzi**, że trener odpowiedział.

W tym samym oknie, w zweryfikowanym `$app` z §1, utwórz **nową prywatną**
kopię przykładu Java21. Nie pracuj w źródłowym `examples/` ani na jedynym
prywatnym zadaniu. `$template` zawiera TaskRunConfig, nie pełne SettingsV2:
prepare czyta `.paircoach/settings.json`, dlatego zapisujemy wszystkie pola.
Dla Spring21 zmień tylko `$example` na `spring-counter`; jego template zawiera
SPRING_BOOT i Main/Tests900000ms zamiast JAVA_MAIN120000ms.

```powershell
$base = Join-Path $env:LOCALAPPDATA ('PairCoachLightweight\' + [guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $base) { throw 'Katalog istnieje: zachowaj dane, nie nadpisuj ich' }
New-Item -ItemType Directory -Path $base | Out-Null
$base = (Resolve-Path -LiteralPath $base).Path
$example = 'java-pattern'
$profile = 'java-maven-21'
$project = Join-Path $base $example
Copy-Item -LiteralPath (Join-Path $app ('examples\' + $example)) -Destination $project -Recurse
$settingsDir = Join-Path $project '.paircoach'
if (Test-Path -LiteralPath $settingsDir) { throw 'Istniejace ustawienia: nie nadpisuj ich' }
New-Item -ItemType Directory -Path $settingsDir | Out-Null
$template = Get-Content -LiteralPath (Join-Path $project 'task.v2.json') -Raw | ConvertFrom-Json
$settings = [ordered]@{
    schemaVersion = 2
    taskFilePath = $null
    taskMode = 'IMPLEMENTATION'
    reviewNotesPath = 'review.md'
    aiConsent = $false
    contextPatterns = @()
    runProfiles = @($template.runProfiles)
}
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $settingsDir 'settings.json'), ($settings | ConvertTo-Json -Depth 20), $utf8)
# Usun tylko niezamierzone nadpisania tej sesji; nie ustawiaj alternatywnego dataDir.
Remove-Item Env:PAIRCOACH_RUNTIME_PROFILE -ErrorAction SilentlyContinue
Remove-Item Env:PAIRCOACH_WORKSPACE_DIR -ErrorAction SilentlyContinue
Remove-Item Env:PAIRCOACH_DATA_DIR -ErrorAction SilentlyContinue
$executeOut = Join-Path $base 'prepared'
$prepareLog = Join-Path $base 'prepare.log'
npm.cmd run runtime:prepare -- --project $project --profile $profile --output $executeOut --prepare-timeout-ms 3600000 --execute 2> $prepareLog
if ($LASTEXITCODE -ne 0) { throw 'Prepare nieukonczone: zachowaj output i odczytaj prepare.log' }
$runtimeConfig = (Resolve-Path -LiteralPath (Join-Path $executeOut 'runtime-config.json')).Path
$preparedRoot = (Resolve-Path -LiteralPath (Join-Path (Join-Path $executeOut 'jobs') $profile)).Path
$env:PAIRCOACH_COACH_PROVIDER = 'codex'
$env:PAIRCOACH_CODEX_EXE = $codex
$env:NODE_ENV = 'development'
$env:PAIRCOACH_HTTP_PORT = '18120'
if (Get-NetTCPConnection -State Listen -LocalPort 18120 -ErrorAction SilentlyContinue) { throw 'Port 18120 zajety: nie zatrzymuj obcego procesu' }
npm.cmd start -- --runtime-config $runtimeConfig --prepared-runtime $preparedRoot
```

Prepare korzysta z publicznego klienta Docker; na Windows wymagany jest lokalny
`npipe:////./pipe/docker_engine` i dostęp konta do Linux engine/bind mountów.
Nie przełączaj produktu przez `DOCKER_HOST`, TCP/proxy ani hostowy JDK/Maven.
Postęp jest w `$prepareLog`; w drugim oknie użyj `Get-Content -LiteralPath`
z pełną ścieżką tego logu i opcją `-Wait`.
Budżet3600000ms dotyczy prepare, nie Run. Sukces
`PREPARED_CONFIG_GENERATED_NOT_ACCEPTANCE` nie oznacza odbioru ani gotowości obu
trybów. Przy błędzie/przerwaniu zachowaj output/log; najpierw uzgodnij wynik,
nie ponawiaj w tym samym katalogu i nie dopisuj receiptów/pinów.

Wygenerowany config wybiera RuntimeProfile `java-maven-21`, prywatny workspace,
katalog/piny i `execution: { "backend": "docker", "pullPolicy": "never" }`.
`--prepared-runtime` wskazuje **jobs/<profile>**, nie cały output. Nie zmieniaj
POM dla nowszego JDK: target release projektu i JDK kontenera to różne rzeczy.
Inne profile, budżety i szczegóły prepare: [przewodnik §1–4](windows-polyglot.md).

Pozostaw okno otwarte. Otwórz dokładny URL wypisany przez serwer
(tu **http://127.0.0.1:18120/**) w jednej karcie Edge. Bez `PAIRCOACH_HTTP_PORT`
domyślny port nadal wynosi8080. Nie ma flagi `--port`; dozwolone wartości
i odmowy opisuje [przewodnik §4](windows-polyglot.md#4-start-i-zmiana-profilu).
To normalny LIVE, bez `?mock=1`, DevSimulatorBar i bez DevTools. UI pochodzi
z `dist/` tego samego serwera. `npm run preview` nie uruchamia backendu.
Nie zmieniaj NODE_ENV na production: standardowy start używa lokalnego
`/dev/bootstrap` do tokenu. Nie kopiuj odpowiedzi bootstrapu; token nie jest
hasłem użytkownika do wpisania. Serwer ma pozostać wyłącznie na loopback.

## Model Codex

W katalogu aplikacji znajduje się `paircoach.config.json`, z modelem `gpt-6.1-sol` i `reasoning_effort: "medium"`. Trener i raport uruchamiają lokalną instancję `codex exec --ephemeral --model gpt-6.1-sol` z `model_reasoning_effort="medium"`, używając własnego logowania ChatGPT. ComputerUse jest jawnie wyłączone (`features.computer_use=false`); aplikacja nie dopuszcza wykonywania narzędzi modelu ani interakcji z komputerem. `--ephemeral` dotyczy plików sesji CLI, nie usuwa danych raportu aplikacji. Po edycji pliku zrestartuj serwer. Opcjonalne nadpisania to `PAIRCOACH_CODEX_MODEL`, `PAIRCOACH_CODEX_REASONING_EFFORT` oraz `PAIRCOACH_CONFIG` (pełna ścieżka innego JSON). Nie są potrzebne dodatkowy klucz ani URL API.

## 3. Start → zgoda AI → edytuj/czat

1. Otwórz `src/main/java/demo/StrategyDemo.java` w drzewie prywatnego projektu z §2.
   Poczekaj na LIVE i prawo pisania; szary/offline nie jest gotowością.
2. **Ustawienia Projektu i Trenera AI → Zgoda na asystę Trenera AI → Zapisz
   Ustawienia**. To zgoda na wysłanie do dostawcy dozwolonego kontekstu zadania
   i wiadomości. Nie używaj sekretów ani prywatnego kodu w próbie. Domyślnie
   zgoda jest wyłączona; bez niej trener nie wysyła kontekstu.
3. Naciśnij przycisk z tytułem **Start sesji** (trójkąt przy zegarze).
   W przykładzie Java zmień `(a, b) -> a - b` na `(a, b) -> a + b`; poczekaj
   na zapis/ACK. Sprawdź też ten plik w prywatnym folderze zadania — sam widok
   edytora nie dowodzi zapisu. Przed poprawką test z przykładu celowo nie przechodzi.
4. Otwórz **Czat**, napisz: „Co oblicza calculate(2, 3) w aktualnym pliku?
   Odpowiedz krótko, bez zmieniania kodu.” Wyślij.
   Oczekuj rzeczywistej odpowiedzi o **calculate** i bieżącym kodzie, nie samego
   READY, zalogowania CLI, lokalnego fallbacku ani statycznego potwierdzenia.
   Jeśli AI zwróci błąd, zachowaj komunikat/status i zgłoś go bez sekretów.
5. **Przerwij trenerowi (2× Esc)** oddaje turę Tobie; nie cofa już zapisanych
   zmian. Undo/Redo to osobne akcje. Przy konflikcie zachowaj obie wersje,
   podejmij jawną decyzję i poczekaj na potwierdzenie zapisu. Nie odświeżaj
   strony z niezachowanym draftem.

Provider Codex jest wybierany przy starcie serwera; Gemini pozostaje alternatywą
w kodzie, nie wymaga go ta ścieżka. Wybór Gemini, klucz i jego realny wynik są
osobnym scenariuszem. Nie ustawiaj sekretów przez `VITE_*`, nie dodawaj `.env`
do paczki ani nie loguj całego środowiska. Surowe logi Run nie są kontekstem AI.
Run/Test wykonuje kod zadania w Dockerze na izolowanym wejściu potwierdzonego
zapisu, nie jako hostowe polecenie. Nie wymaga to uruchamiania ciężkiego LSP.
Lokalne możliwości edytora są niezależne od gotowości Docker:

- Java/Python: kolorowanie Monaco i Ctrl+Space — słowa **bieżącego bufora** po
  prefiksie, bez czekania na ACK. Bez metod po kropce, analizy innych plików,
  auto-importów czy obietnicy pełnego IDE. Diagnostyka podczas pisania jest
  **N/A**, również przy `languageFeatures.diagnostics: true`; błędy są po Run/Test.
- JS/TS: lokalny worker completion i diagnostyki; rzeczywisty `tsc` uruchamia
  się w kontenerze dopiero przy Run/Test. Błąd workera nie daje ON i nie blokuje
  ręcznego pisania.
- Docs mają stan **N/A**; nie wymagają instalowania LSP dla żadnego z tych profili.
- `languageFeatures.completion: false` wyłącza podpowiedzi, `diagnostics: false`
  lokalną diagnostykę JS/TS. `builtin` określa provider, nie automatyczne ON.
- Akceptacja podpowiedzi podlega WriteGate, CODE_CHANGED, autosave/ACK i Undo/Redo.
  CONTROL_PREPARE zamyka listę; Enter/Tab nie może wtedy zmienić bufora. Weto2×Esc
  pozostaje aktywne. Ręczna edycja i zapis nie czekają na Docker ani wiadomości LANGUAGE.

## 4. Zatrzymaj, wróć do zadania, zabezpiecz pracę

Poczekaj na autosave/ACK; niezapisany draft skopiuj osobno. W oknie serwera
naciśnij Ctrl+C i potwierdź zakończenie, jeśli pyta PowerShell. Nie zabijaj
wszystkich node.exe. Przed aktualizacją zachowaj poprzedni ZIP/instalację oraz
kopię **całego workspace i data** po zatrzymaniu. Nie aktualizuj w miejscu.

Przy ponownym starcie otwórz PowerShell w **tej samej** zweryfikowanej instalacji
`$app`. Odtwórz `$runtimeConfig` i `$preparedRoot` jako pełne istniejące ścieżki
z §2 oraz własny `$codex`; usuń niezamierzone nadpisania workspace/profilu/dataDir.
Ustaw ponownie PAIRCOACH_COACH_PROVIDER=codex, PAIRCOACH_CODEX_EXE, NODE_ENV=development
i PAIRCOACH_HTTP_PORT=18120 jak wyżej, sprawdź wolny port, a następnie wykonaj
`npm.cmd start -- --runtime-config $runtimeConfig --prepared-runtime $preparedRoot`.
Dane są w `<projekt>/.paircoach`; zachowaj też wygenerowany config, cache/receipty
i `.paircoach-runtime` obok config. Nie kopiuj ich między instalacjami/projektami.
**Nie wykonuj ponownie tworzenia plików/settings ani prepare tylko dla restartu.**
Po restarcie sprawdź zgodę AI; nie zakładaj trwałości sesji/timera lub ustawień.
Po zakończeniu usuń tylko lokalne nadpisanie:
`Remove-Item Env:PAIRCOACH_HTTP_PORT -ErrorAction SilentlyContinue`.

Jeżeli nowa wersja zawiedzie, zatrzymaj tylko własny proces, zachowaj nowe dane
i drafty, wróć do starej instalacji z jej odpowiednią kopią danych. Nie nadpisuj
nowszej pracy starszą. Nie usuwaj `.paircoach`, plików recovery ani danych
witryny przeglądarki „dla naprawy”. W razie zajętego wybranego portu nie zabijaj obcego
procesu; zgłoś konflikt lub wybierz inny wolny dozwolony port według §4 przewodnika. W feedbacku podaj commit z manifestu, wersje Node/Codex,
krótką czynność i błąd, bez tokenów, kluczy i prywatnych logów.

Dokumentacja OpenAI: [logowanie](https://developers.openai.com/codex/auth),
[tryb exec/--ephemeral](https://learn.chatgpt.com/docs/non-interactive-mode),
[modele](https://learn.chatgpt.com/docs/models).
Procedura odbioru odrębnej instalacji MVP2 z ZIP: `windows-zip-smoke.md`.

## 5. Docker RuntimeProfile + TaskRunConfig → Run Main / Run Tests / Stop

RuntimeProfile wybiera toolchain/obraz (tu `java-maven-21` w config z prepare).
TaskRunConfig w `runProfiles[].task` określa klasę/skrypt, katalog i wybór testów.
Stare profile z `executable`, hostowym Node, `args` i `testReportGlob` są dla
Lightweight **wycofane** — nie wklejaj ich ani nie uruchamiaj hostowego fallbacku.

Nowa kopia z §2 ma pełne SettingsV2 z oryginalnego template. W istniejącym projekcie
wybierz **Ustawienia Projektu i Trenera AI → Ustawienia wykonania V2** (także
przycisk **Profil i ustawienia wykonania** w nagłówku). Nie szukaj dawnego pola
JSON profili: w LIVE formularz V2 ma oddzielne sekcje **Program** i **Testy**.
Dla Java z §2 włącz oba tryby; w każdej sekcji ustaw:

| Pole formularza | Wartość |
|---|---|
| Run timeout (ms) | `120000` |
| Task directory | `.` |
| Entry | `JAVA_MAIN` |
| Main class | `demo.StrategyDemo` |
| Test sources | puste |
| Test names | `demo.StrategyDemoTest` |

Odpowiada to poniższemu `runProfiles` z `examples/java-pattern/task.v2.json`
(nie całemu settings ani tekstowi do wklejenia w pole GUI):

```json
[{"kind":"RUN_MAIN","timeoutMs":120000,"task":{"workingDirectory":".","entry":{"kind":"JAVA_MAIN","className":"demo.StrategyDemo"},"tests":{"paths":[],"names":["demo.StrategyDemoTest"]}}},{"kind":"RUN_TESTS","timeoutMs":120000,"task":{"workingDirectory":".","entry":{"kind":"JAVA_MAIN","className":"demo.StrategyDemo"},"tests":{"paths":[],"names":["demo.StrategyDemoTest"]}}}]
```

Wybierz **Zapisz ustawienia** w formularzu V2 i czekaj na potwierdzenie/zamknięcie.
Błąd pozostawia wpisane pola; nie wymuszaj Run przy konflikcie lub offline.
Oba wyłączone tryby zapisują `runProfiles: []`, co wyłącza Run/Test. Przy starych
ustawieniach wykonaj jawną migrację V2 zgodnie z komunikatem, zachowując kopię;
nie zastępuj istniejących settings samym fragmentem `runProfiles`.
Inny projekt wymaga własnej klasy/modułu i testów, nie zmiany kodu aplikacji.
Dla Spring/JS/TS/Python użyj odpowiadającego `examples/<przykład>/task.v2.json`
i właściwego publicznego prepare według [tabeli profili](windows-polyglot.md#1-platforma-i-profil).
Zmiana profilu wymaga własnego Stop, nowego prepare/outputu i restartu z nowym
config/jobs; nie przepisuj POM ani image pinów. Brak gotowości blokuje Run,
nie jest powodem obchodzenia guardów lub zatrzymywania obcego procesu.

W GUI czekaj na świeżą gotowość właściwego trybu, potem wybierz **Run Main** albo
**Run Tests** i obserwuj **Konsola**. Dla Java celowy błąd `a - b` daje FAILED;
po poprawce `a + b` i ACK oczekuj nowego JUnit z dodatnią liczbą testów i PASSED,
a Main wypisuje `5`. To oczekiwany przebieg, nie deklaracja wykonanego odbioru.
Exit0 bez świeżego JUnit daje UNKNOWN; raport z0testów daje NO_TESTS, nie PASSED.
Wynik jest przypisany do runId i wersji wejścia; edycja w trakcie może oznaczyć
workspaceChangedDuringRun. Run używa przypiętego obrazu/cache bez pobierania;
błędne środowisko lub brak obrazu nie przełącza wykonania na hosta.

Spring21 z §2: użyj jego template (Entry `SPRING_BOOT`, Service port `8080`,
Health path `/sum`, Test names `demo.CounterApplicationTest`, Test sources puste,
Run timeout900000ms w obu trybach). Otwórz `src/main/java/demo/CounterApplication.java`:
Tests na celowym `2 - 3` → FAILED, zmień tylko na `2 + 3` → ACK → nowe Tests
PASSED z testCount>0. Przed Main wybierz **Środowisko → Środowisko wykonania →
Przygotuj środowisko** i czekaj na potwierdzenie własnej sieci HTTP/NAT oraz świeżą gotowość.
To inne działanie niż publiczny prepare obrazu; bez ręcznego `docker network create`.
Main pozostaje RUNNING po HTTP200 `/sum` z wartością5 pod adresem pokazanym w GUI.
**Stop** ma zatrzymać właściwy kontener i zamknąć endpoint, nie tylko zmienić UI.
Wynik nieznany wymaga uzgodnienia tej samej operacji: **Dokończ przygotowanie**
dla sieci, **Sprawdź wynik operacji** dla Run/zapisu; nie czyść storage ani receiptów.
Weto trenera i Ctrl+C serwera nie zastępują potwierdzonego Stop Run.
Budżety i dokładne zachowanie Spring/nieznanego Stop: [przewodnik §3–5](windows-polyglot.md).
Nie zabijaj globalnie node.exe ani kontenerów. Native Windows, rzeczywisty endpoint,
Stop i świeży ZIP nadal wymagają osobnych dowodów na finalnym SHA.

## 6. Kopie odzyskiwania → Przywróć → jawne Tak/Nie

Lista jest w ustawieniach w **Kopie odzyskiwania (Snapshots)**. Kopia końcowa powstaje
przy zakończeniu próby; początkowo lista może być pusta. Aby uzyskać pierwszą
kopię zwykłą ścieżką GUI, zakończ próbną sesję według §7. Ręczna edycja po
zakończeniu pozostaje możliwa, raport nadal opisuje zamrożony stan. Przed przywróceniem wybranego
stanu aplikacja tworzy trwałą kopię objętej bieżącej pracy. Brak bezpiecznej
kopii lub zmiana podstawy blokują operację, nie są zgodą na nadpisanie.

1. Poczekaj na autosave/ACK. Wybierz **Poproś o przywrócenie** przy konkretnej kopii.
   To tylko żądanie propozycji, jeszcze bez zmiany plików.
2. Sprawdź pytanie i zakres. **Nie, pracuję dalej** zamyka decyzję bez restore.
   **Tak, wykonaj** świadomie zatwierdza wskazaną propozycję. Nie klikaj ponownie.
3. Poczekaj na terminalny wynik i aktualizację plików/listy; sprawdź treść na
   dysku i dostępność kopii sprzed restore. Timer nie jest resetowany.
   STALE_PROPOSAL wymaga nowej propozycji po odczycie stanu, nie powtarzania starej.

Przy operacji trwającej ponad **5 s** klient pokazuje **wynik nieznany (UNKNOWN)**.
To nie FAIL i nie dowód braku wykonania. Nie powtarzaj zgody, nie zamykaj serwera
ani nie edytuj plików w celu „odblokowania”. Aplikacja rozlicza późny ACK/stan;
po reconnect odczytuje wynik tej samej decyzji zamiast nowej mutacji. Brak wyniku
lub RECOVERY_REQUIRED: zachowaj drafty i dane, zgłoś identyfikator/komunikat K.
Nie wydłużaj limitów ani nie usuwaj dziennika. Samo istnienie wpisu kopii
nie dowodzi udanego odzyskania — liczą się bajty i terminalny stan.

## 7. Zakończ/Porzuć → raport; timeout nie oznacza powtórzenia

Po potwierdzonym zapisie wybierz **Zakończ** lub **Porzuć**, powód, następnie
**Potwierdź i Wygeneruj Raport**. Zielone testy nie kończą sesji samoczynnie.
Backend zatrzymuje własny Run i utrwala końcowy snapshot/fakty; raport jest
asynchroniczny: **PENDING → READY lub FAILED**, w zakładce **Raport**.
Po 5 s może pojawić się „Wynik zakończenia jest nieznany” wraz z requestId.
**Nie klikaj finish ponownie.** Klient sprawdza stan bez kolejnego POST;
późny terminalny wynik ma rozliczyć ten sam finish i usunąć jego komunikat.
Przy SESSION_REPLACED zachowaj ID poprzedniej sesji; nie uznawaj nowej za jej wynik.

READY dotyczy zamrożonego materiału i faktycznie wykonanych uruchomień,
nie przyszłych edycji. Przy FAILED zachowane są pliki/fakty; wybierz jawnie
**Ponów generowanie raportu** (ponawiasz raport, nie finish i nie snapshot).
Przy `PAIRCOACH_COACH_PROVIDER=codex` **zarówno trener, jak i raport używają Codexa**:
`gpt-6.1-sol` / `medium`, lokalne `codex exec --ephemeral`, własne logowanie
ChatGPT, bez dodatkowego klucza lub URL API; ComputerUse wyłączone.
Zgoda AI jest utrwalona w faktach; bez niej lub bez generatora powstaje jawne lokalne
podsumowanie faktów, nie odpowiedź AI. Błąd wybranego dostawcy daje FAILED,
nie ciche przełączenie na Gemini ani lokalny sukces. Gemini pozostaje osobną opcją.
Nie dodawaj sekretów do GUI.
Nie opisuj lokalnego raportu jako potwierdzonej odpowiedzi zewnętrznego modelu.
Raport wcześniejszej sesji wybierz w zakładce **Raport**, sekcja **Poprzednie raporty**: wybierz **Odśwież listę**, potem sesję;
odczyt historii nie zastępuje raportu bieżącej sesji ani nie wykonuje finish.
Po restarcie przerwane PENDING ma FAILED/REPORT_INTERRUPTED; wymaga jawnego Ponów.
Dostępność modelu zależy od konta; samo logowanie nie jest odpowiedzią AI.

## 8. Po przerwaniu/awarii — zachowaj oba magazyny i restartuj tę samą instalację

Zabezpiecz niezapisane drafty. Nie uruchamiaj dwóch serwerów na tych samych danych.
Po potwierdzeniu, że poprzedni proces się zakończył, zachowaj kopię **całego**
prywatnego projektu z `.paircoach` oraz wygenerowanego prepare/config i stanu
`.paircoach-runtime` do nowych nazw. Użyj tej samej ścieżki projektu, instalacji,
konta i konfiguracji z §2/4; nie twórz ponownie plików ani ustawień.
Dane kopii są w magazynie tej instalacji, związanym z pełną ścieżką projektu.
Przeniesienie/zmiana nazwy workspace nie jest równoważne wznowieniu tego samego stanu.

Startup odczytuje dziennik przerwanego restore i próbuje bezpiecznego recovery
przed udostępnieniem zapisu. Po gotowości sprawdź rzeczywiste bajty, kopie i brak
powtórnej mutacji. Nie zakładaj automatycznego odtworzenia timera, logowania,
starej sesji lub stanu Run po każdym rodzaju awarii. Nie ma obietnicy pełnej
transakcyjności po utracie zasilania ani naprawiania obcych zmian kosztem ich utraty.

Jeśli startup odmawia/RECOVERY_REQUIRED utrzymuje się, zachowaj publiczne pliki,
cały prywatny projekt z `.paircoach`, stan runtime i draft. Nie usuwaj journal,
HMAC/sekretu magazynu ani prywatnych slotów i nie kopiuj snapshotów w miejsce bieżącej pracy. Zgłoś komunikat oraz
SHA z manifestu do K; ręczne rozstrzygnięcie wymaga odczytu obu materiałów i kopii
do **nowych nazw**, nie nadpisania. Nie powtarzaj awarii na jedynym egzemplarzu zadania.

Rollback wersji: po zatrzymaniu własnego procesu zachowaj nowe dane/pracę,
wróć do poprzedniej instalacji z **jej osobną zgodną kopią danych**.
Nie kieruj starszego MVP1 na dane MVP2 i nie nadpisuj nowszej pracy starszą kopią.
