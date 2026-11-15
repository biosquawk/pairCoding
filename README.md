# PairCoach

> Bieżąca linia rozwojowa zawiera kompaktowy GUI, domyślną Darculę i dwa motywy Solarized, przełącznik PL/EN, trwałe projekty treningowe oraz natywnego trenera Codex z kartami/skilami i wykonanie zadań w Dockerze. [Aktualny zakres i wyniki kontroli](docs/development-20261113.md) rozdzielają sprawdzone funkcje od niezaliczonej pełnej bramki i odbioru całego Zadania 9.

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

### Start bez argumentów w Ubuntu/WSL — bieżące stanowisko

Skrypt [start.sh](start.sh) uruchamia backend i zbudowany interfejs z obecnym
przygotowanym środowiskiem **Java 21**, trenerem Codex i portem **18120**:

```bash
cd /home/darulec/dev/codex_prjects/pairCoding-publication-20261112
./start.sh
```

Otwórz **http://127.0.0.1:18120/**. Pozostaw terminal otwarty; **Ctrl+C** zatrzymuje
serwer. Skrypt można też wywołać pełną ścieżką z innego katalogu.
W Windows plik znajduje się pod
`\\wsl.localhost\Ubuntu\home\darulec\dev\codex_prjects\pairCoding-publication-20261112\start.sh`;
uruchamiaj go w terminalu Ubuntu/WSL.

Po restarcie kliknij **oddityHome** na liście **Ostatnio otwierane projekty**.
Jeżeli lista jest jeszcze pusta, kliknij **Otwórz projekt** i wybierz istniejący plik
`\\wsl.localhost\Ubuntu\home\darulec\dev\codex_prjects\pairCoding-publication-20261112\java-puzzlers\01-oddity\oddityHome.paircoding.json`.
Przywróci to zapisany projekt i ćwiczenie. Kolejne zagadki wybierasz przez
**Otwórz folder…** w katalogu `java-puzzlers`. Skrypt nie resetuje rozwiązań,
nie tworzy nowego projektu i nie uruchamia programu ani testów ucznia.

Wymagane są istniejące zależności aplikacji i build (`npm ci`, `npm run build`),
Node >=22.22.0 oraz dostępny i zalogowany Codex CLI. Jeżeli Node w PATH jest zbyt
stary, skrypt próbuje wybrać już zainstalowany Node 22 przez NVM. Narzędzi nie
instaluje. Model i charakter nadal wybierasz w `paircoach.config.json`.
Docker musi działać do Run/Test; jego niedostępność nie odbiera możliwości edycji.

Domyślne ścieżki odnoszą się do **tego przygotowanego stanowiska**, nie do świeżego
klonu repozytorium:

- konfiguracja: `../paircoach-live-20261113/zadania-java.runtime.json`;
- przygotowany runtime: `../paircoach-stabilization-evidence-20261113/java21-prepared/jobs/java-maven-21`.

Są rozwiązywane względem katalogu skryptu. Po przeniesieniu aplikacji można je
nadpisać zmiennymi `PAIRCOACH_RUNTIME_CONFIG` i `PAIRCOACH_PREPARED_RUNTIME`
(dla drugiej podaj katalog zawierający `receipt.json`). Port zmienia
`PAIRCOACH_HTTP_PORT`, a program Codexa — `PAIRCOACH_CODEX_EXE`.
Skrypt korzysta z istniejącego przygotowania i walidacji serwera; nie pobiera
obrazów, nie tworzy potwierdzeń przygotowania i nie przełącza wykonania na hosta.
Na nowym stanowisku najpierw przygotuj runtime publicznym `npm run runtime:prepare`
według [instrukcji](docs/windows-polyglot.md), a następnie wskaż jego konfigurację
i katalog wyniku. Zajęty port powoduje błąd; skrypt nie zabija innej instancji.

## Projekt treningowy, wygląd i język

Po starcie aplikacja jest **pusta**, także przy skonfigurowanym workspace.
Najpierw wybierz **Utwórz projekt** (nazwa i istniejący folder dostępny dla backendu)
albo **Otwórz projekt** i wskaż zapisany `NAZWA.paircoding.json`.
Dopiero w otwartym projekcie użyj **Otwórz folder…**, aby wybrać ćwiczenie.
Jeden projekt treningowy może obejmować kolejne foldery ćwiczeń; nie kopiuje ich źródeł.

Stan projektu zapisuje się automatycznie: ostatnie ćwiczenie, zakładki/widok,
historia czatu i kontekst trenera. Zapis kodu nadal wymaga ACK.
Przed **Zamknij projekt** poczekaj na potwierdzenie zapisu; aplikacja wraca do pustego widoku.
Po zamknięciu strony lub restarcie serwera wybierz ponownie **Otwórz projekt**
i ten sam plik, aby wrócić do zapisanej pracy (timer jest przywracany jako wstrzymany).
W panelu **Pliki projektu** lista **Ostatnio otwierane projekty** pozwala wrócić
jednym kliknięciem do jednego z 10 ostatnich projektów. Pokazuje nazwę i pełną
ścieżkę pliku; zapisuje się lokalnie w tej przeglądarce dla danego adresu aplikacji
i pozostaje po restarcie. Projekt trafia na listę dopiero po poprawnym otwarciu
lub utworzeniu — wcześniejsze projekty trzeba otworzyć jeden raz. **×** usuwa
wyłącznie skrót z listy, bez usuwania projektu ani rozwiązań. Nieudane otwarcie
zachowuje bieżący projekt i pokazuje błąd; przeniesiony plik można wskazać ponownie
przez **Otwórz projekt**. Czyszczenie danych przeglądarki usuwa tę listę.
W oknie wyboru projektu lub ćwiczenia pole **Bieżący folder** można kliknąć,
edytować i wkleić do niego pełną ścieżkę katalogu dostępną dla backendu
(w Ubuntu/WSL — ścieżkę Linux). **Enter** lub **Przejdź** odczytuje folder.
Następnie kliknij plik `.paircoding.json` albo **Otwórz ten folder** dla ćwiczenia.
Samo wpisanie ścieżki nie przełącza projektu; błędna ścieżka i anulowanie
pozostawiają bieżący projekt. Nie skanuje się całego dysku.
Zachowaj cały folder projektu, w tym `.pairCoding/codex/`; po rzeczywistym wywołaniu
Codexa plik `.pairCoding/codex/resume.json` zawiera ID i argumenty wznowienia
z terminala, wymagające tego samego konta/CODEX_HOME. Nie kopiuj danych logowania.

Przycisk motywu przełącza **Darcula** (domyślna dla nowego wyboru),
**Solarized Dark** i **Solarized Light**. Flaga **PL/EN** za **A−/A+** zmienia
język GUI i przyszłych odpowiedzi AI, nie treść ćwiczeń ani stare wiadomości.
Po lewej są cztery zakładki: **Pliki projektu** (domyślna), **Zadanie**, **Czat**,
**Środowisko**; na dole wyłącznie **Konsola** i **Raport**.

[Szczegóły projektów, reguł i natywnego resume](docs/projects-native-locale-20261114.md).
To instrukcja obsługi kandydata, nie deklaracja zakończenia odbioru LIVE.

## Sprint REST / Spring — Banc Mentor (gałąź feature)

1. Użyj gałęzi `feature/adaptive-interview-sprint`. Wymagany jest profil
   **java-maven-21** w Dockerze; prepare i start wykonaj według
   [istniejącej instrukcji](docs/windows-polyglot.md). Przy już przygotowanym
   profilu użyj jego konfiguracji, bez kolejnego prepare. Nie instaluj JDK/Mavena
   na hoście. Operator kandydata używa **http://127.0.0.1:18130/**; ten adres
   nie zastępuje domyślnego portu8080 ani istniejącej instancji18120.
2. Przed startem aplikacji ustaw `"character": "banc-mentor"` w
   `paircoach.config.json`; profil zawiera własny skill `lesson-feedback`.
   Pozostała konfiguracja trenera nie zmienia się. AI wymaga dotychczasowej
   konfiguracji dostawcy i jawnej zgody w ustawieniach ćwiczenia; ręczna nauka
   działa również bez tej zgody.
3. **Utwórz projekt** w nowym, własnym folderze → **Zadanie** → **Sprint nauki**.
   Wybierz poziom startowy, minuty i co najmniej jeden temat, następnie
   **Rozpocznij sprint**. Sprint sam instaluje wybrane ćwiczenie w tym projekcie.
   Edytuj, poczekaj na ACK zapisu i uruchom Test. Zamierzony FAIL startera jest
   początkiem zadania, nie oceną umiejętności.
4. **Dalej / Next** i **Łatwiejsze / Easier** wybierasz ręcznie: wynik testu
   nie przełącza zadania automatycznie. Powrót do wcześniejszego zadania
   zachowuje własny kod i historię; deklaracja „umiem” nie zastępuje PASSED.
5. Zachowaj cały folder projektu: `NAZWA.paircoding.json`, kod w
   `sprint-rest-spring-v1/tasks/<id>/` i stan/postęp w
   `.pairCoding/codex/state.json`. Po ponownym otwarciu tego samego pliku
   projektu wznów wstrzymaną pracę. **Zakończ** utrwala podsumowanie; panel
   **Raport** pokazuje wynik i poprzednie raporty, zapisane lokalnie pod
   `.pairCoding/codex/reports/<sessionId>/`. Dane te mogą zawierać Twój kod/czat;
   nie publikuj ich razem z aplikacją.

Materiały `learning-packs/rest-spring/` są **autorskim opracowaniem PairCoach**:
12 ćwiczeń / 5 tematów, nie import książki użytkownika. GUI dopuszcza wyłącznie
zadania oznaczone jako sprawdzone HTTP; referencje nie trafiają do ćwiczenia/AI.
**Wynik odbioru funkcji (2026-11-15):** przetestowany kod
`d072783a1e59c8ac52e6752e2d78ad538bd6fbfe`, instancja operatora
**http://127.0.0.1:18130/** (Ubuntu/WSL). Typecheck/build PASS;
**MATERIAL12/12**: startery celowo FAIL, referencje PASS na tych samych testach HTTP.
Pełny **TEST202 PASS, 190,675 s**: 15 kontroli GUI, trzy rzeczywiste Run w tym
samym przygotowanym obrazie, edycja/ACK, A→B→A z zachowaniem kodu i historii,
rzeczywisty Codex z bieżącym materiałem, reload i lokalny raport A+B.
ZIP tej rewizji sprawdzono bajtowo względem Git/manifestu (809 plików,
12 kompletów ćwiczeń i skill Banc, bez prywatnego stanu); 10 testów z rozpakowanej
paczki PASS. To odbiór tej funkcji na gałęzi feature, nie pełnego Zadania 9.

**Ograniczenia pozostają jawne:** podczas Finish wystąpił banner
`WORKSPACE_BUSY` / HTTP409 zapisu preferencji; raport A+B powstał poprawnie,
lecz GUI nie jest bezbłędne. Niezależny finish: **13 PASS / 2 FAIL** — istniejące
fixtures przełączenia folderu nie tworzą wymaganego trwałego projektu (test i guard
identyczne względem bazy Task2 `2e0e52f`; wykonanie na bazie NOT_RUN).
Końcowe asercje izolacji opóźnionych odpowiedzi nie zostały osiągnięte;
ta granica nowej ścieżki przełączenia sprintu pozostaje niezweryfikowana.
TEST201: pierwotnie **14 PASS / 1 FAIL środowiska** (brak domyślnego Chromium);
ten jeden przypadek osobno **1 PASS** z istniejącym Chromium i bibliotekami,
bez zmiany testu. Opening/currentness **31 PASS**, AC-103 **66 PASS**.
Pierwotny pełny GUI na starszej rewizji pozostaje INCOMPLETE; późniejszy PASS
go nie nadpisuje. Pełna bramka jakości nadal **audit BLOCKED / claim REJECTED**;
pełnego `npm test` ani natywnego Windows nie zweryfikowano w tym odbiorze.

## Trener AI i folder zadania

Dostęp do AI wymaga konfiguracji dostawcy oraz zaznaczenia zgody w ustawieniach projektu w interfejsie.

Przed rozpoczęciem pracy skonfigurowany trener ma status „Gotowy”. Pierwsza potwierdzona edycja kodu albo pytanie na czacie uruchamia sesję i obserwowanie przez trenera — nie wymaga wcześniejszego kliknięcia Start. Ręczna pauza, wyciszenie i brak zgody AI nadal obowiązują.

W otwartym projekcie treningowym przycisk **Otwórz folder…** nad drzewem plików pozwala wyklikać inne ćwiczenie bez restartu. Wybór zaczyna się w katalogu nadrzędnym obecnego zadania; dostępne są podfoldery, **Poziom wyżej**, **Otwórz ten folder** i **Anuluj**. Są to rzeczywiste katalogi backendu (przy backendzie w WSL — ścieżki WSL), bez importowania ani kopiowania plików. Zapis musi uzyskać ACK; aktywny program należy zatrzymać, a pisanie trenera przerwać przed przełączeniem. Profil języka/JDK pozostaje ten sam; jego zmiana nadal wymaga konfiguracji i restartu.

- **Codex:** ustaw `PAIRCOACH_COACH_PROVIDER=codex` i `PAIRCOACH_CODEX_EXE` na pełną ścieżkę do lokalnego, zalogowanego programu Codex. W Windows wymagany jest natywny `codex.exe`, nie plik `.cmd`. Raport końcowy korzysta z tego samego dostawcy. Nie dodawaj plików logowania do repozytorium.
- **Gemini:** ustaw `GEMINI_API_KEY` w środowisku serwera. Bez skonfigurowanego dostawcy aplikacja działa z wyłączonym trenerem.
- `PAIRCOACH_WORKSPACE_DIR` i `PAIRCOACH_DATA_DIR` nie otwierają automatycznie ćwiczenia przy starcie produktu; wybierz projekt i folder w GUI. Konfiguracja środowiska wykonania pozostaje odrębna.
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

Trener i raport końcowy korzystają z lokalnego Codex CLI z modelem `gpt-6.1-sol` i `model_reasoning_effort="medium"`. Trener trwałego projektu zapisuje rzeczywiste ID sesji bez `--ephemeral` i następnie wznawia dokładnie tę sesję; raport pozostaje odrębnym wywołaniem. Używają własnego logowania ChatGPT w Codex CLI. Aplikacja jawnie wyłącza ComputerUse (`features.computer_use=false`); model nie wykonuje narzędzi ani interakcji z komputerem. Konfiguracja nie wymaga klucza API ani URL API.

Po zmianie pliku zrestartuj serwer. `PAIRCOACH_CONFIG` może wskazać inny plik JSON pełną ścieżką. Opcjonalne nadpisania: `PAIRCOACH_CODEX_MODEL` i `PAIRCOACH_CODEX_REASONING_EFFORT`. Ustawienia zapisane w konfiguracji użytkownika Codexa nie zmieniają tych wartości — aplikacja przekazuje je jawnie. Błędny plik lub niepoprawna wartość zatrzymuje konfigurację dostawcy zamiast wybierać inny model.

W Windows plik konfiguracji znajduje się w rozpakowanym katalogu aplikacji, obok `package.json`. `PAIRCOACH_COACH_PROVIDER=codex` wybiera dostawcę, a `PAIRCOACH_CODEX_EXE` nadal wskazuje lokalny `codex.exe`.

## Kod i sprawdzenia

Pełny lokalny eksport do code review: uruchom **`python3 review.py`** z katalogu
aplikacji (lub wskaż pełną ścieżkę skryptu z innego katalogu). Powstaną dokładnie
`ingest/src.md` oraz `ingest/scripts.md`, z rekurencyjną zawartością odpowiednich
katalogów, ścieżkami, rozmiarami i SHA-256 każdego pliku. Skrypt nie skraca treści
ani nie filtruje rozszerzeń; pliki nietekstowe zapisuje w całości jako Base64.
Dowiązania i pliki specjalne zgłasza jako błąd. Kolejne uruchomienie zastępuje
te dwa eksporty; nie zmienia źródeł. Python 3.10+ wystarcza, bez dodatkowych pakietów.
Katalogi `ingest/` i `.ingest/` są wykluczone z Gita; wygenerowane eksporty
nie są publikowane przy commit/push.

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

Problemy z uprawnieniami cache Maven w WSL, czerwonymi importami JUnit lub uruchomieniem main w IDEA 2025.2.6: [sprawdzona instrukcja naprawy](docs/development-20261113.md#10-intellij--maven-w-wsl--sprawdzona-naprawa-14112026).

Możesz otworzyć ten sam folder zadania w PairCoding i IntelliJ. Źródła zapisane z IDE są normalnymi zmianami zewnętrznymi i trafiają do edytora przez istniejące uzgadnianie wersji; konflikt nie daje AI prawa do nadpisania nowszego kodu. `.idea`, `.git`, `target`, `.gitignore` oraz pliki `.iml`, `.ipr`, `.iws` są pomijane przy obserwowaniu zadania, budowie kontekstu AI, snapshotach i wejściu Run. Nie są usuwane ani przywracane do starszej wersji. Podpowiedzi semantyczne możesz wykorzystywać w IntelliJ; PairCoding pozostaje lekkim edytorem z lokalnymi podpowiedziami.

**PENDING_FINAL_QA** — pełny odbiór produktu pozostaje nieukończony; celowany pomiar poniżej nie zastępuje końcowej kontroli QA.

## Bounded platform coverage / MCP Quality Guard

After `npm ci` with Node >=22.22.0, run **`npm run coverage`** from the repository.
This command measures an explicit bounded subset, **not the full test suite**. It
uses c8/V8 plus tsx source maps, retains unexecuted production TS/TSX at zero,
and checks that every production inventory entry has exactly one LCOV record.
Expected output: `coverage/lcov.info`, `coverage-summary.json`, `coverage-final.json`,
`inventory.json` (individual exclusions and reasons), `selection.json` (selected,
NOT_RUN and SUPERSEDED), and `measurement.json`. A failed test, timeout or missing
source is an error, not a PASS. The asynchronous runner sets a 180 s test-phase
deadline and a 240 s c8 deadline. On timeout it kills the owned process group
on POSIX (including SIGTERM-resistant descendants). Before returning, POSIX cleanup
confirms termination within an additional 2 s budget or fails; Linux zombies count
as terminated, while other POSIX systems conservatively require PID/group absence.
Nested lanes confirm only their direct runner; the outer owner confirms the group.
Windows uses taskkill /T /F
with a 2 s cleanup budget (best effort, not independently validated here). Detached processes that deliberately escape the group
and OS-level uninterruptible tasks are outside this guarantee. No further test
lane starts after a timeout. This starts no application server or Docker campaign. Reports and scratch
fixtures are local ignored artifacts (`coverage/`, `target/`).

Production boundary: all `src/`, all `scripts/`, `vite.config.ts` and the shipped
`java-puzzlers/prepare-tasks.mjs` utility. Dormant language/LSP code under `src/`
is retained. Exercises under `examples/`/`java-puzzlers/` (except that utility),
historical QA/research in `docs/`/`investigations/`, test sources/support and
`.d.ts` declarations are not platform runtime. No source is excluded for low
coverage or high complexity. New unclassified source files fail inventory.
The canonical `npm test` selector/retirement policy is unchanged.

`.quality-policy.json` uses the same production roots. `.quality-runner.json`
runs the exact `coverage`/`test:coverage` script entrypoints using `node` from
the runner process PATH for both JavaScript and TypeScript. Configure the MCP
server process PATH to include your local Node installation if it differs from
your terminal; no operator-specific executable path belongs in the published
configuration and no global Node installation is required. `test:coverage` runs
the same bounded test selection
through canonical TS/native-MJS lanes and retirement filters, without c8. This
bounded profile is intentional under the owner's no-long-suite constraint;
any MCP gate applies only to that profile and is **not full-product acceptance**.
Use `get_usage`, `audit_project(refresh_coverage=true, mode="sonar")`, selected
`inspect_unit(mode="sonar")`, then `claim_quality_gate(mode="sonar")`; retain
actual REJECTED/BLOCKED and all NOT_RUN evidence. No thresholds are relaxed.

Coverage caveat: tsx emits compact JavaScript. V8 ranges remap to original TS/TSX,
but a line may count as executed while a branch on that line is not. Read LCOV
BRDA and branch metrics too; this measurement is not statement-level instrumentation.
