# PairCoach

> Bieżąca linia rozwojowa zawiera kompaktowy GUI, motywy Solarized, otwieranie folderów, natywnego trenera Codex z kartami/skilami oraz wykonanie zadań w Dockerze. [Aktualny zakres i wyniki kontroli](docs/development-20261113.md) rozdzielają sprawdzone funkcje od niezaliczonej pełnej bramki i odbioru całego Zadania 9.

Lokalny trener programowania: edytor Monaco, czat z AI, uruchamianie programu i testów, snapshoty oraz raport końcowy. Interfejs i backend znajdują się w tym repozytorium.

## Charakter nauczyciela: AGENTS.md i skille

Edytuj [characters/default/AGENTS.md](characters/default/AGENTS.md) oraz [characters/default/skills](characters/default/skills/). To globalny profil nauczyciela, wspólny dla Javy, Pythona i innych zadań. W [paircoach.config.json](paircoach.config.json) ustaw `"character": "default"` albo `"character": "halloween-theme"`; w tym samym pliku wybierasz model i poziom rozumowania. Przy starcie trenera wybrany pakiet jest kopiowany do prywatnej instancji Codexa jako `AGENTS.md` i `.agents/skills`. Edytuj przed uruchomieniem; po zmianie zrestartuj aplikację, bez przebudowy.

[Instrukcja edycji, struktura i dodawanie własnych charakterów](characters/README.md). Repozytoryjny [AGENTS.md](AGENTS.md) jest instrukcją dla programistów aplikacji, nie dla nauczyciela.

## Uruchomienie

Wymagany Node.js **22.22.0 lub nowszy** i npm. Z katalogu sklonowanego repozytorium:

```sh
npm ci
npm run build
npm start
```

Otwórz **http://127.0.0.1:8080/**. `npm start` uruchamia backend REST/WebSocket z obsługą zbudowanego interfejsu. `npm run preview` uruchamia wyłącznie podgląd frontendu. Pozostaw terminal serwera otwarty.

Backend nasłuchuje lokalnie. Standardowy start developerski korzysta z lokalnego bootstrapu tokenu; nie ustawiaj `NODE_ENV=production` bez skonfigurowania sposobu przekazania tokenu klientowi.

## Trener AI i folder zadania

Dostęp do AI wymaga konfiguracji dostawcy oraz zaznaczenia zgody w ustawieniach projektu w interfejsie.

Przed rozpoczęciem pracy skonfigurowany trener ma status „Gotowy”. Pierwsza potwierdzona edycja kodu albo pytanie na czacie uruchamia sesję i obserwowanie przez trenera — nie wymaga wcześniejszego kliknięcia Start. Ręczna pauza, wyciszenie i brak zgody AI nadal obowiązują.

Przycisk **Otwórz folder…** nad drzewem plików pozwala wyklikać inne ćwiczenie bez restartu. Wybór zaczyna się w katalogu nadrzędnym obecnego zadania; dostępne są podfoldery, **Poziom wyżej**, **Otwórz ten folder** i **Anuluj**. Są to rzeczywiste katalogi backendu (przy backendzie w WSL — ścieżki WSL), bez importowania ani kopiowania plików. Zapis musi uzyskać ACK; aktywny program należy zatrzymać, a pisanie trenera przerwać przed przełączeniem. Profil języka/JDK pozostaje ten sam; jego zmiana nadal wymaga konfiguracji i restartu.

- **Codex:** ustaw `PAIRCOACH_COACH_PROVIDER=codex` i `PAIRCOACH_CODEX_EXE` na pełną ścieżkę do lokalnego, zalogowanego programu Codex. W Windows wymagany jest natywny `codex.exe`, nie plik `.cmd`. Raport końcowy korzysta z tego samego dostawcy. Nie dodawaj plików logowania do repozytorium.
- **Gemini:** ustaw `GEMINI_API_KEY` w środowisku serwera. Bez skonfigurowanego dostawcy aplikacja działa z wyłączonym trenerem.
- `PAIRCOACH_WORKSPACE_DIR` wskazuje folder ćwiczenia, a `PAIRCOACH_DATA_DIR` osobny folder danych sesji. Bez wskazanego workspace serwer tworzy tymczasowy przykład.
- Run Main i Run Tests wymagają skonfigurowanych profili uruchamiania w ustawieniach projektu.

Szczegółowe polecenia PowerShell, konfiguracja Codexa i przebieg pierwszego zadania: [instrukcja Windows](docs/windows-start.md).

Gotowe wzorce nowych ćwiczeń Java, Spring Boot, JavaScript, TypeScript i Python: [szablony zadań](docs/templates/README.md).

Dziesięć zagadek z rozdziału Expressive Puzzlers: [java-puzzlers](java-puzzlers/README.md).

## Konfiguracja modelu Codex

Plik [paircoach.config.json](paircoach.config.json) w katalogu aplikacji:

```json
{
  "codex": {
    "model": "gpt-6.1-sol",
    "reasoning_effort": "medium"
  },
  "character": "default"
}
```

Trener i raport końcowy uruchamiają lokalną instancję `codex exec --ephemeral --model gpt-6.1-sol` z `model_reasoning_effort="medium"`. Używają własnego logowania ChatGPT w Codex CLI. Aplikacja jawnie wyłącza ComputerUse (`features.computer_use=false`); model nie wykonuje narzędzi ani interakcji z komputerem. Konfiguracja nie wymaga klucza API ani URL API.

Po zmianie pliku zrestartuj serwer. `PAIRCOACH_CONFIG` może wskazać inny plik JSON pełną ścieżką. Opcjonalne nadpisania: `PAIRCOACH_CODEX_MODEL` i `PAIRCOACH_CODEX_REASONING_EFFORT`. Ustawienia zapisane w konfiguracji użytkownika Codexa nie zmieniają tych wartości — aplikacja przekazuje je jawnie. Błędny plik lub niepoprawna wartość zatrzymuje konfigurację dostawcy zamiast wybierać inny model.

W Windows plik konfiguracji znajduje się w rozpakowanym katalogu aplikacji, obok `package.json`. `PAIRCOACH_COACH_PROVIDER=codex` wybiera dostawcę, a `PAIRCOACH_CODEX_EXE` nadal wskazuje lokalny `codex.exe`.

## Kod i sprawdzenia

- [Backend](src/server/): HTTP/WebSocket, pliki, kontrola zapisu, sesje, uruchamianie testów, raporty oraz dostawcy AI.
- [Interfejs](src/components/) i [klient transportu](src/services/LiveBackend.ts).
- [Kontrakt REST](src/shared/openapi.json) i [schemat WebSocket](src/shared/ws.schema.json).
- [Testy](tests/) oraz [opis ostatnich poprawek](docs/windows-coach-report-solarized.md).

```sh
npm run typecheck
npx tsx --test tests/integration/coach-http.test.ts tests/integration/run-event-order.test.ts
```

Instrukcje i uruchomienia testów Windows znajdują się w [docs/WINDOWS.md](docs/WINDOWS.md). Testy wymagające konkretnego systemu, przeglądarki lub dostawcy AI mają osobne wymagania środowiskowe.

Oficjalna dokumentacja OpenAI: [tryb exec/--ephemeral](https://learn.chatgpt.com/docs/non-interactive-mode),
[logowanie ChatGPT](https://learn.chatgpt.com/docs/auth), [modele](https://learn.chatgpt.com/docs/models).
Dostępność `gpt-6.1-sol` zależy od konta; konfiguracja i `login status` nie dowodzą odpowiedzi modelu.
`--ephemeral` nie zapisuje plików sesji CLI, nie zastępuje logowania ani danych raportu aplikacji.

## Równoległa praca w IntelliJ

Możesz otworzyć ten sam folder zadania w PairCoding i IntelliJ. Źródła zapisane z IDE są normalnymi zmianami zewnętrznymi i trafiają do edytora przez istniejące uzgadnianie wersji; konflikt nie daje AI prawa do nadpisania nowszego kodu. `.idea`, `.git`, `target`, `.gitignore` oraz pliki `.iml`, `.ipr`, `.iws` są pomijane przy obserwowaniu zadania, budowie kontekstu AI, snapshotach i wejściu Run. Nie są usuwane ani przywracane do starszej wersji. Podpowiedzi semantyczne możesz wykorzystywać w IntelliJ; PairCoding pozostaje lekkim edytorem z lokalnymi podpowiedziami.

## Bounded platform coverage / MCP Quality Guard

After `npm ci` with Node >=22.22.0, run **`npm run coverage`** from the repository.
This command measures an explicit bounded subset, **not the full test suite**. It
uses c8/V8 plus tsx source maps, retains unexecuted production TS/TSX at zero,
and checks that every production inventory entry has exactly one LCOV record.
Expected output: `coverage/lcov.info`, `coverage-summary.json`, `coverage-final.json`,
`inventory.json` (individual exclusions and reasons), `selection.json` (selected,
NOT_RUN and SUPERSEDED), and `measurement.json`. A failed test, timeout or missing
source is an error, not a PASS. The test phase is bounded at 180 s, measurement
at 240 s; it starts no application server or Docker campaign. Reports and scratch
fixtures are local ignored artifacts (`coverage/`, `target/`).

Production boundary: all `src/`, all `scripts/`, `vite.config.ts` and the shipped
`java-puzzlers/prepare-tasks.mjs` utility. Dormant language/LSP code under `src/`
is retained. Exercises under `examples/`/`java-puzzlers/` (except that utility),
historical QA/research in `docs/`/`investigations/`, test sources/support and
`.d.ts` declarations are not platform runtime. No source is excluded for low
coverage or high complexity. New unclassified source files fail inventory.
The canonical `npm test` selector/retirement policy is unchanged.

`.quality-policy.json` uses the same production roots. `.quality-runner.json`
runs the exact `coverage`/`test:coverage` script entrypoints using an explicit
Node executable for both JavaScript and TypeScript (MCP does not inherit this
shell's PATH). The recorded path is the supplied SharedDesk Node 22.22.2; update
that executable path when relocating the QG workspace. Ordinary npm commands
remain portable. The latter runs the same bounded test selection
through canonical TS/native-MJS lanes and retirement filters, without c8. This
bounded profile is intentional under the owner's no-long-suite constraint;
any MCP gate applies only to that profile and is **not full-product acceptance**.
Use `get_usage`, `audit_project(refresh_coverage=true, mode="sonar")`, selected
`inspect_unit(mode="sonar")`, then `claim_quality_gate(mode="sonar")`; retain
actual REJECTED/BLOCKED and all NOT_RUN evidence. No thresholds are relaxed.

Coverage caveat: tsx emits compact JavaScript. V8 ranges remap to original TS/TSX,
but a line may count as executed while a branch on that line is not. Read LCOV
BRDA and branch metrics too; this measurement is not statement-level instrumentation.
