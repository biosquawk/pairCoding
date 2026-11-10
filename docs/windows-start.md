# PairCoach — pierwsza wersja do kodowania i feedbacku (Windows)

To **preview**, nie pełny odbiór v3. Zgodnie z decyzją właściciela z 10.11.2026
odłożono crash/recovery, pełną kampanię Windows i końcowe 27 AC. Nie polegaj na
kopii odzyskiwania ani raporcie końcowym w tej wersji. Pracuj na osobnym zadaniu
lub kopii kodu; regularnie zachowuj własne kopie. Stan krótkiego smoke i dokładny
commit są w raporcie dostawy K, a tożsamość źródeł w `manifest.json`.

## 1. Rozpakuj i zbuduj — jedno okno PowerShell

Wymagane: Windows, PowerShell, Node.js **>=22.22.0** z npm, Edge/Chrome,
internet do instalacji i AI oraz natywny `codex.exe` zalogowany na **Twoim**
koncie. Nie kopiuj node_modules z WSL ani auth.json. Nie potrzebujesz dodatkowego
klucza API dla wariantu Codex z logowaniem ChatGPT. Nie instaluj dodatkowych
usług Thalamusa, Dockera, Mavena ani Pythona.

Z katalogu dostawy K skopiuj **razem** ZIP, `manifest.json` i `SHA256SUMS` do
nowego folderu w Eksploratorze. Otwórz w nim PowerShell. Porównaj zaufany hash
ZIP z raportem K; sam manifest nie potwierdza zaufania do nadawcy. Wykonaj:

```powershell
$ErrorActionPreference = 'Stop'
$manifest = Get-Content .\manifest.json -Raw | ConvertFrom-Json
$zip = Join-Path (Get-Location) $manifest.archive.name
if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower() -ne $manifest.archive.sha256) { throw 'Hash ZIP niezgodny' }
$mh = (Get-FileHash .\manifest.json -Algorithm SHA256).Hash.ToLower()
if (-not ((Get-Content .\SHA256SUMS) -contains "$mh  manifest.json")) { throw 'Hash manifestu niezgodny' }
$homeDir = Join-Path $env:LOCALAPPDATA 'PairCoachPreview'
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
node --version
npm.cmd --version
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci FAIL — zachowaj błąd, nie używaj --force' }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build FAIL — zachowaj błąd' }
```

`build` tworzy UI w `dist/`, nie samodzielny EXE. `npm start` używa TS/tsx;
nie stosuj `--omit=dev`. Instalacja, build i start to osobne wyniki.

## 2. Ustaw Codex i nowe zadanie, uruchom

W **tym samym oknie** odszukaj natywny EXE, nie `codex.cmd` ani WSL:

```powershell
$codex = (Get-Command codex.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
& $codex --version
& $codex login status
if ($LASTEXITCODE -ne 0) { throw 'Zaloguj własny Codex przed startem aplikacji' }
```

Jeżeli EXE nie jest w PATH, zamiast pierwszego wiersza ustaw `$codex` na pełną
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
Snapshot/restore, crash recovery i pełny Run/Report nie są warunkiem ani obietnicą
tego pierwszego wydania. Docs/autocomplete pozostają NOT_INSTALLED.

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
[CLI i login status](https://developers.openai.com/codex/cli/reference).
Procedura krótkiego odbioru z ZIP: `windows-zip-smoke.md`.
