# PairCoach MVP2 — Windows: instalacja i praca

> **ETAP8: IMPLEMENTED / PENDING_FINAL_QA** (kolejka 4→9). To opis bieżącego
> kandydata, nie odbiór kampanii ani wydanie. Native Windows/PowerShell, świeża
> paczka wydania, realny model i pełne QA pozostają do wykonania po implementacji9.
> ETAP9 Docker/polyglot nie jest jeszcze zaimplementowany.

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
klucza API dla wariantu Codex z logowaniem ChatGPT. Dla obecnej ścieżki Node nie instaluj dodatkowych usług Thalamusa ani toolchainów.
Przyszłe wymagania Docker/polyglot ETAP9 będą miały osobny kontrakt i dowody.

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

## 2. Ustaw Codex i nowe zadanie, uruchom

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

Utwórz raz syntetyczny workspace (nie katalog aplikacji):

```powershell
$workspace = Join-Path $homeDir 'workspaces\pierwsze-zadanie'
$data = Join-Path $homeDir 'data\pierwsze-zadanie'
if ((Test-Path $workspace) -or (Test-Path $data)) { throw 'Zadanie lub dane już istnieją — nie nadpisuj ich; ponowny start opisano niżej' }
New-Item -ItemType Directory -Path $workspace | Out-Null
New-Item -ItemType Directory -Path $data | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $workspace 'challenge.md'), '# Zadanie: napisz funkcję sum(a, b), zwracającą sumę dwóch liczb.', $utf8)
[IO.File]::WriteAllText((Join-Path $workspace 'solution.js'), "function sum(a, b) {`n  // Tu wpisz swoje rozwiązanie.`n}`n", $utf8)
$env:PAIRCOACH_WORKSPACE_DIR = $workspace
$env:PAIRCOACH_DATA_DIR = $data
$env:PAIRCOACH_COACH_PROVIDER = 'codex'
$env:PAIRCOACH_CODEX_EXE = $codex
$env:NODE_ENV = 'development'
npm.cmd start
```

Pozostaw okno otwarte. Otwórz **http://127.0.0.1:8080/** w jednej karcie Edge.
To normalny LIVE, bez `?mock=1`, DevSimulatorBar i bez DevTools. UI pochodzi
z `dist/` tego samego serwera. `npm run preview` nie uruchamia backendu.
Nie zmieniaj NODE_ENV na production: standardowy start używa lokalnego
`/dev/bootstrap` do tokenu. Nie kopiuj odpowiedzi bootstrapu; token nie jest
hasłem użytkownika do wpisania. Serwer ma pozostać wyłącznie na loopback.

## Model Codex

W katalogu aplikacji znajduje się `paircoach.config.json`, z modelem `gpt-6.1-sol` i `reasoning_effort: "medium"`. Trener i raport uruchamiają lokalną instancję `codex exec --ephemeral --model gpt-6.1-sol` z `model_reasoning_effort="medium"`, używając własnego logowania ChatGPT. ComputerUse jest jawnie wyłączone (`features.computer_use=false`); aplikacja nie dopuszcza wykonywania narzędzi modelu ani interakcji z komputerem. `--ephemeral` dotyczy plików sesji CLI, nie usuwa danych raportu aplikacji. Po edycji pliku zrestartuj serwer. Opcjonalne nadpisania to `PAIRCOACH_CODEX_MODEL`, `PAIRCOACH_CODEX_REASONING_EFFORT` oraz `PAIRCOACH_CONFIG` (pełna ścieżka innego JSON). Nie są potrzebne dodatkowy klucz ani URL API.

## 3. Start → zgoda AI → edytuj/czat

1. Zobacz `challenge.md` w zakładce zadania i otwórz `solution.js` w drzewie.
   Poczekaj na LIVE i prawo pisania; szary/offline nie jest gotowością.
2. **Ustawienia Projektu i Trenera AI → Zgoda na asystę Trenera AI → Zapisz
   Ustawienia**. To zgoda na wysłanie do dostawcy dozwolonego kontekstu zadania
   i wiadomości. Nie używaj sekretów ani prywatnego kodu w próbie. Domyślnie
   zgoda jest wyłączona; bez niej trener nie wysyła kontekstu.
3. Naciśnij przycisk z tytułem **Start sesji** (trójkąt przy zegarze).
   Wpisz `return a + b;` w funkcji; poczekaj na zapis/ACK. Sprawdź też plik
   `solution.js` w folderze zadania — sam widok edytora nie dowodzi zapisu.
4. Otwórz **Czat**, napisz: „Jak nazywa się funkcja w aktualnym pliku i co ma
   zwracać według zadania? Odpowiedz krótko, bez zmieniania kodu.” Wyślij.
   Oczekuj rzeczywistej odpowiedzi o **sum**, jej kodzie i zadaniu, nie samego
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
Ustawienia **Profile uruchamiania** zatwierdzają lokalny kod z prawami Twojego
konta, nie sandbox — do pierwszego kodowania/czatu nie są potrzebne.
Snapshot/restore, Run/Test i raport opisano poniżej. Docs/autocomplete
pozostają NOT_INSTALLED. Nie twierdzimy, że opcjonalne narzędzia językowe są zainstalowane.

## 4. Zatrzymaj, wróć do zadania, zabezpiecz pracę

Poczekaj na autosave/ACK; niezapisany draft skopiuj osobno. W oknie serwera
naciśnij Ctrl+C i potwierdź zakończenie, jeśli pyta PowerShell. Nie zabijaj
wszystkich node.exe. Przed aktualizacją zachowaj poprzedni ZIP/instalację oraz
kopię **całego workspace i data** po zatrzymaniu. Nie aktualizuj w miejscu.

Przy ponownym starcie otwórz PowerShell w istniejącym `$app`, ustaw ponownie
PAIRCOACH_WORKSPACE_DIR, PAIRCOACH_DATA_DIR, PAIRCOACH_COACH_PROVIDER=codex,
PAIRCOACH_CODEX_EXE i NODE_ENV tak jak powyżej, potem `npm.cmd start`.
**Nie wykonuj ponownie tworzenia plików zadania**. Po restarcie sprawdź zgodę AI
w ustawieniach; nie zakładaj trwałości sesji/timera lub ustawień.

Jeżeli nowa wersja zawiedzie, zatrzymaj tylko własny proces, zachowaj nowe dane
i drafty, wróć do starej instalacji z jej odpowiednią kopią danych. Nie nadpisuj
nowszej pracy starszą. Nie usuwaj `.paircoach`, plików recovery ani danych
witryny przeglądarki „dla naprawy”. W razie zajętego portu8080 nie zabijaj obcego
procesu; zgłoś konflikt. W feedbacku podaj commit z manifestu, wersje Node/Codex,
krótką czynność i błąd, bez tokenów, kluczy i prywatnych logów.

Dokumentacja OpenAI: [logowanie](https://developers.openai.com/codex/auth),
[tryb exec/--ephemeral](https://learn.chatgpt.com/docs/non-interactive-mode),
[modele](https://learn.chatgpt.com/docs/models).
Procedura odbioru odrębnej instalacji MVP2 z ZIP: `windows-zip-smoke.md`.

## 5. Zatwierdź RunProfile w GUI → Run Main / Run Tests / Stop

W **Ustawienia Projektu i Trenera AI** rozwiń **Konfiguracja Run/Test i kontekstu AI**.
Pole **Profile uruchamiania (JSON, [] = brak)** przyjmuje najwyżej dwa profile,
po jednym RUN_MAIN i RUN_TESTS. Wpisanie nie wystarcza: wybierz **Zapisz Ustawienia**
i poczekaj na potwierdzenie/zamknięcie formularza. Błąd pozostawia formularz otwarty.
Nowy folder nie dziedziczy zatwierdzenia poleceń z poprzedniego zadania.

Przykład dla utworzonego wyżej solution.js (dostosuj ścieżkę EXE do swojego Node):

```json
[{"kind":"RUN_MAIN","executable":"C:/Program Files/nodejs/node.exe","args":["solution.js"],"cwd":".","timeoutMs":10000,"testReportFormat":"NONE","testReportGlob":null}]
```

To zwykłe uruchomienie pliku funkcji, może zakończyć się bez wydruku.
Nie jest dowodem poprawności sum. Dla własnych testów dopisz drugi profil
RUN_TESTS z **rzeczywistym** skryptem testowym. Przykładowo dla Node:
`executable` jak wyżej, `args:["tests.cjs"]`, `cwd:"."`, `timeoutMs:10000`,
`testReportFormat:"JUNIT_XML"`, `testReportGlob:"target/run-{runId}.xml"`.
Plik tests.cjs musi istnieć w folderze zadania, wykonywać asercje i zapisywać
świeży JUnit z dodatnią liczbą testów. `PAIRCOACH_RUN_ID` jest przekazywany do
procesu; `{runId}` rozwija się w args i globie. Nie tworzymy testów automatycznie
po samym dodaniu profilu. Nie zatwierdzaj komendy z nieznanego źródła.

Każdy argument to osobny element tablicy; nie wpisuj `&&`, przekierowań ani
całego polecenia do executable. Bez cmd.exe/PowerShell. Program działa z prawami
Twojego konta, **nie w sandboxie**. Profil uruchamia tylko lokalny kod, który znasz.
Po zapisaniu wybierz **Run Main** albo **Run Tests**, obserwuj **Konsola**.
Brak profilu/narzędzia to jawny brak konfiguracji/EXECUTABLE_NOT_FOUND.
Exit0 bez świeżego JUnit daje UNKNOWN; raport z 0 testów daje NO_TESTS, nie PASSED.
PASSED dotyczy tylko wykazanych testów tego Run. Edycja w trakcie uruchomienia
może oznaczyć wynik jako dotyczący starszego workspace (workspaceChangedDuringRun).
**Stop** kończy własny Run; weto trenera i Ctrl+C serwera to inne operacje.
Nie zabijaj globalnie node.exe. Końcowy odbiór drzewa procesów wymaga native Windows.

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
workspace i `$data` do nowych nazw. Użyj tej samej ścieżki workspace/data,
instalacji, konta i konfiguracji z §2/4; nie twórz ponownie plików zadania.
Dane kopii są w `$data` w podkatalogu zależnym od pełnej ścieżki workspace.
Przeniesienie/zmiana nazwy workspace nie jest równoważne wznowieniu tego samego stanu.

Startup odczytuje dziennik przerwanego restore i próbuje bezpiecznego recovery
przed udostępnieniem zapisu. Po gotowości sprawdź rzeczywiste bajty, kopie i brak
powtórnej mutacji. Nie zakładaj automatycznego odtworzenia timera, logowania,
starej sesji lub stanu Run po każdym rodzaju awarii. Nie ma obietnicy pełnej
transakcyjności po utracie zasilania ani naprawiania obcych zmian kosztem ich utraty.

Jeśli startup odmawia/RECOVERY_REQUIRED utrzymuje się, zachowaj publiczne pliki,
cały `$data` i draft. Nie usuwaj journal, HMAC/sekretu magazynu ani prywatnych
slotów i nie kopiuj snapshotów w miejsce bieżącej pracy. Zgłoś komunikat oraz
SHA z manifestu do K; ręczne rozstrzygnięcie wymaga odczytu obu materiałów i kopii
do **nowych nazw**, nie nadpisania. Nie powtarzaj awarii na jedynym egzemplarzu zadania.

Rollback wersji: po zatrzymaniu własnego procesu zachowaj nowe dane/pracę,
wróć do poprzedniej instalacji z **jej osobną zgodną kopią danych**.
Nie kieruj starszego MVP1 na dane MVP2 i nie nadpisuj nowszej pracy starszą kopią.
