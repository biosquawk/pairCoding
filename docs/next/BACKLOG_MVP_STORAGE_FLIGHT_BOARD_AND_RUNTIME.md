# MVP NEXT-THALAMUS-01 — Storage, Flight Board i środowisko wykonawcze

Status trzech historii: **NOT_STARTED**. Odbiór: **NOT_RUN**.
Pełny tekst właściciela poniżej zachowano 1:1, wraz z bilansem checkpointu i wszystkimi kryteriami. Jest to backlog przyszłego MVP Thalamusa, nie zlecenie implementacji w bieżącym celu PairCoach Lightweight.

<!-- BEGIN OWNER VERBATIM 2026-11-12 -->
INSTRUKCJA DOPISANIA DO TRWAŁEGO BACKLOGU ARCHITEKTONICZNEGO (`docs/next/`, NIE `STATUS.md`!) — UWZGLĘDNIJ WSZYSTKIE DETALE BEZ POMINIĘĆ, WYKONAJ SZYBKO I WRÓĆ DO PILNOWANIA GŁÓWNEGO `/goal`:

Na podstawie pełnego audytu checkpointu z **12 listopada 2026 r.** (kampania 17 h 19 min na projekcie `software_dev_2`) oraz testów `./thalamus attach` właściciel wymaga trwałego zapisania kompletnego backlogu architektonicznego w katalogu `docs/next/` (w tym samym MVP co refaktoryzacja SQLite, **NIGDY w tymczasowym `STATUS.md`**!).

Dokumentacja w `docs/next/` musi **ściśle oddzielać wykonane naprawy punktowe od otwartych zadań architektonicznych (`NOT_STARTED` / `NOT_RUN`), decyzji procesowych oraz problemów należących do samej aplikacji PairCoach** — zabrania się zamykania tych tematów wspólnym hasłem „Thalamus naprawiony”!

Wykonaj natychmiast poniższe 3 kroki i po krótkim raporcie wróć do pilnowania swojego głównego zadania (`/goal`):

---

### KROK 1: Znajdź lub utwórz trwałe miejsce w `docs/next/` (NIE `STATUS.md`!)
Sprawdź strukturę `/home/darulec/dev/codex_prjects/codex_synapse_new/docs/next/` (odpowiadającą `https://github.com/biosquawk/pairCoding/tree/main/docs`). Możesz zaczerpnąć informacje ze `STATUS.md` oraz z `~/dev/codex_prjects/codex_synapse_legacy/260503_codex_synapse_swarm/docs/next/TODO_thalamus_hub_flight_control_layout.md`, ale zapisz całość w trwałym pliku backlogu MVP w `docs/next/` (np. w istniejącym pliku backlogu MVP w `docs/next/` lub utwórz `docs/next/BACKLOG_MVP_STORAGE_FLIGHT_BOARD_AND_RUNTIME.md` i podlinkuj go w `docs/README.md`).

---

### KROK 2: Zapisz pełny kontekst inżynieryjny oraz User Stories (Bez pomijania żadnego detalu!)

W pliku w `docs/next/` umieść najpierw **Sekcję Kontekstową (Bilans Prawdy z Checkpointu 12.11.2026)**, a następnie **szczegółowe User Stories**:

#### A. BILANS PRAWDY Z CHECKPOINTU 12.11.2026 (Rozróżnienie: co naprawiono, co jest częściowe, co `NOT_STARTED`/`NOT_RUN`, a co nie jest błędem Thalamusa)

1. **Co faktycznie naprawiono w silniku Thalamusa (Hotfix Watchdoga — WDROŻONE, ale to NIE jest przebudowa współbieżności ani Ports & Adapters):**
   - *Problem:* Zapytanie w `WatchdogAndVenetianJudge.scopedCommands()` używało skorelowanego `EXISTS (SELECT 1 FROM events e WHERE ...)` nad tabelą `events` dla kolejnych rekordów `commands` (złożoność `O(C * E)`), długo trzymając blokadę (monitor) `ProjectStore` i pośrednio blokując dostęp przez `SessionRuntime`. Powodowało to **121,523 s opóźnienia przyjęcia wiadomości** oraz **timeouty HTTP po 45 s**.
   - *Wdrożony hotfix (`b235eea413a1df84e4be4cea813a25ac8a5de984`):* W zwykłej ścieżce zastąpiono korelację `EXISTS` jednorazową materializacją `IN (SELECT json_extract(e.payload, '$.operation_id') ...)` z zachowaniem zakresu wyników, kolejności, limitu oraz fallbacku na starą ścieżkę `EXISTS` dla nieprawidłowego/legacy JSON-a.
   - *Twarde dowody:* 5 przechodzących testów natywnych JUnit/SQLite; w próbie syntetycznej spadek czasu zapytania z **261,794 ms do 3,603 ms** (~72x szybciej); zachowanie działającego HTTP oraz **14 ról i 851 tożsamości sesji** w `software_dev_2`; pojedyncza późniejsza obserwacja przyjęcia wejścia wyniosła **79,4 ms**.
   - *Granica naprawy:* **Nie zmieniono silnika SQLite, trybu WAL, schematu ani indeksów.** Pojedynczy pomiar `79,4 ms` nie jest pomiarem `p95` ani dowodem usunięcia wszystkich źródeł przestojów i blokad w platformie.

2. **Co ma status `NOT_STARTED` / `NOT_RUN` (Musi zostać zrealizowane w tym MVP):**
   - **Wydzielenie SQLite przez Porty i Adaptery (`THALAMUS-SQLITE-PORT-01` — sekcja §5.5 raportu):** Status **`NOT_STARTED`**, odbiór **`NOT_RUN`**. Oddzielenie operacji domenowych od SQL/JDBC, uporządkowanie granic transakcji/blokad oraz dodanie alternatywnego adaptera Płaskich Plików (`Flat Files`) przełączanego z konfiguracji nie zostało jeszcze wykonane (a w późniejszym celu *Lightweight* prace nad silnikiem Thalamusa zostały czasowo wyłączone z zakresu domykania PairCoach).
   - **Błąd ucinania snapshotu w CLI (`./thalamus attach`):** Wywołanie `/home/darulec/dev/codex_prjects/thalamus_2.0_runtime/thalamus attach --project software_dev_2 --role K --observe` kończy się błędem `Thalamus: Unterminated string starting at: line 1 column 2093290 (char 2093289)` (>2,09 MB ucięty JSON z monolitycznego zrzutu `/api/snapshot`).
   - **Brak tablicy `Flight Board / Flight Control`:** W `Thalamus 2.0 Rebirth` wycięto klasyczną tablicę `Flight Control` znaną z `./synapse attach` w `~/dev/codex_prjects/codex_synapse_legacy/260503_codex_synapse_swarm`.
   - **Dostęp do Dockera z sandboxów ról i hostowy harness pomiarowy:** Operator hosta miał działający Docker Engine, ale sandboxy niektórych ról (`DeskSandbox` / `bwrap`) nie widziały `/usr/bin/docker` ani socketu daemona (błąd `ENOENT`), a także miały problem z zapisem do `/home/darulec/.npm` (kod `254`) i brakiem `TMPDIR`. Przygotowany w nocnej kampanii hostowy harness pomiarowy pozostał w stanie **`WIP / NOT_RUN`** (brak dowodu skutecznego przeprowadzenia zablokowanej próby `runtime:prepare --execute` i `TEST-101..107`).

3. **Co zostało uporządkowane tylko częściowo / organizacyjnie (i nadal wymaga domknięcia):**
   - **Zator integracyjny `K` i `ROOT` przy skalowaniu wykonawców (`P1`/`P2` x4):** Przy pojedynczym właścicielu obszaru `Store/Factory` rozproszenie pracy doprowadziło do powstania **159 kopii roboczych (`worktrees`) i 123 różnych HEAD-ów** (nie oznaczało to 159 równocześnie pracujących agentów, lecz skalę rozproszenia). Główna gałąź `K` stała na `88d40b2`, podczas gdy pełniejsza integracja BE+FE była w innym checkoucie. Wybrano wspólną kompozycję na bazie `a8b4b167` (z pakowaniem `48c8aea5`, strażnikiem obrazów `902da3cc` i gałęziami `checkpoint/20261112/*`), **zabezpieczając pracę i publikację, ale bez potwierdzenia działania końcowego wydania**. Decyzja o jednej linii integracyjnej (`K + 1x P1 + 1x P2`, *Vertical First*, krótsze raporty, limit 2 nieudanych prób bez nowego dowodu) to korekta organizacji pracy, której skuteczność wymaga jeszcze potwierdzenia w boju.
   - **Niedopasowanie `Quality Guard MCP` do TypeScript:** `Quality Guard MCP` obsługiwał Javę/Pythona, a na aplikacji PairCoach (Node/TypeScript) zwracał `NO_SOURCE_FILES`. Zmieniono jedynie instrukcję dla operatora (zakaz powtarzania takiego audytu i nakaz używania testów właściwych dla TS/Node) — było to obejście organizacyjne, a nie rozbudowa samego narzędzia `Quality Guard` o obsługę TypeScript.

4. **Czego NIE należy przypisywać awarii silnika Thalamusa (problemy warstwy aplikacji PairCoach i księgowania):**
   - Alokacje buforów `64 MiB` na plik w `LanguageShadowStore` (~115 GiB przy 1852 plikach zależności / kopiowanie 1847 plików), problemy gotowości kontenerowego LSP (JDT / `pylsp` przekraczające 30 s), diagnostyka Java 21 oraz TTL przygotowania obrazów należały do **implementacji samej aplikacji PairCoach**, a nie silnika Thalamus.
   - Rozrost zewnętrznego procesu `codex-computer-use.exe` na hoście do **~40 GB RAM** wynikał z użycia ciężkiego narzędzia zewnętrznego (zastąpionego w wytycznych przez lekki bezgłowy Playwright/Edge oraz `codex exec --ephemeral`).
   - Liczba **10 381 rekordów `SETTLED` i 3 `UNKNOWN`** w tabeli `calls` odzwierciedla wewnętrzne księgowanie aktywności w `CallLedger`, a nie udowodnioną liczbę fizycznych wywołań modelu AI czy koszt faktury.

---

#### B. SZCZEGÓŁOWE USER STORIES DO REALIZACJI W TYM MVP

##### USER STORY 1 (`THALAMUS-SQLITE-PORT-01`): Architektura Storage w oparciu o Ports & Adapters (`FlatFileProjectStore` + `SqliteProjectStore`) z przełączaniem w pliku konfiguracyjnym
- **Status obecny:** `NOT_STARTED` / odbiór `NOT_RUN` (hotfix Watchdoga `b235eea4` naprawił wyłącznie jedno zapytanie `scopedCommands()`, ale nie wydzielił portów, nie zmienił modelu blokad/transakcji ani nie dodał płaskich plików).
- **Kryteria Akceptacji (AC):**
  1. **Wydzielenie czystych Portów Domenowych w module `core`:** Całkowite oddzielenie operacji domenowych (`ProjectEngine`, `TaskTransportService`, `WatchdogAndVenetianJudge`, `Connectome`, `VitalityAndSleepService`, `CallLedger`) od bezpośrednich wywołań SQL/JDBC i klasy `ProjectStore`.
  2. **Uporządkowanie granic transakcji i blokad:** Eliminacja globalnego monitora `ProjectStore` blokującego przyjmowanie wiadomości w `SessionRuntime` podczas zapytań analitycznych/Watchdoga (gwarancja niskiego `p95` czasu przyjęcia wiadomości pod obciążeniem).
  3. **Implementacja Adaptera 1 — `FlatFileProjectStore` (Płaskie Pliki / JSONL / Markdown na dysku, wzorowane na `.synapse/service_data` z Legacy):**
     - Przejrzysta dla człowieka i skryptów CLI struktura płaskich plików na dysku (append-only JSONL dla zdarzeń/wiadomości + czytelne pliki stanu zadań, pamięci i sesji),
     - Brak binarnego lockowania całej bazy projektu.
  4. **Implementacja Adaptera 2 — `SqliteProjectStore`:** Dotychczasowy SQLite schowany za portem jako jedna z opcjonalnych implementacji (z właściwym trybem WAL, indeksami i jawnymi granicami transakcji).
  5. **Przełączanie przez plik konfiguracyjny:** Możliwość wyboru implementacji (`"storage_backend": "flat_files"` lub `"sqlite"`) w pliku konfiguracyjnym (`state/security-config.json` / `ProjectSettings`) oraz narzędzie bezstratnej konwersji/migracji w obie strony (`flat_files <-> sqlite`).
  6. **Naprawa ucinania >2 MB JSON-a (`char 2093289`) w `./thalamus attach` i `/api/snapshot`:** Wprowadzenie stronicowania/kursorów i strumieniowania ostatnich zdarzeń zamiast przesyłania wielomegabajtowego monolitu w jednym stringu HTTP.

##### USER STORY 2 (`THALAMUS-FLIGHT-BOARD-02`): Przywrócenie pełnej tablicy `Flight Board / Flight Control` w CLI (`./thalamus attach`) oraz w Web GUI
- **Status obecny:** Wycięte podczas migracji `Rebirth`; `./thalamus attach` wyrzuca błąd parsera JSON i nie posiada interfejsu `ThalamusHub v2`.
- **Kryteria Akceptacji (AC):**
  1. **W terminalu (`./thalamus attach` / TUI):** Pełne odwzorowanie dashboardu `ThalamusHub v2` znanego z `~/dev/codex_prjects/codex_synapse_legacy/260503_codex_synapse_swarm` (`./synapse attach`):
     - Nagłówek z `[ HUB TRANSPORT VITALITY ]` (procent żywotności transportu, wyraźnie odróżniony od zdrowia pamięci) oraz zakładkami `Tabs: [FLIGHT] JOBS OPERATIONS` (przełączanymi też przez CLI).
     - Lewy/główny panel **Flight Control**: żywa tabela z kolumnami `Time | MsgID | From | To | Ch | Type | Topic | Content` pokazująca wszystkie komunikaty (`TASK`, `SIGNAL` z postępem WIP, `DONE`, `BLOCK`, `CHANGES_REQUESTED`, `QUESTION`, `RESPONSE` oraz potwierdzenia `hub -> ROLA ACK delivered-fast`).
     - Prawy panel **Operations**:
       - sekcja `Agents` (status każdej roli np. `IDLE/prompt_idle` vs `ACTIVE/pane_working`, czas trwania i ID aktywnego zadania),
       - sekcja `Runtime` (`data_path`, `flight_board tasks`, `external inbox pending`, `external processed`, `audit traces`, `memory context: shadow packages / bytes / oldest / pruned`, `watchdog conversations / open`, `ALERT: watchdog has N open conversation(s)`, `objectives / open`, `watchdog states`, `watchdog wakes/10m` z rozbiciem `hot / recovery / unack` per rola, `last wake` oraz `last wake text`).
     - Dolny panel **System Logs** pokazujący na żywo logi `Thalamus`, `Thalamus.Watchdog`, `Thalamus.Evolution` oraz dolny pasek okien `tmux` (`[0:hub* 1:slack-listener 2:supervisor 3:KIEROWNIK 4:PRACOWNIK 5:JOBS...]`).
  2. **W Web GUI (`http://127.0.0.1:8768/`):** Dodanie dedykowanej zakładki **Flight Control**, prezentującej tę samą tabelę przepływu komunikatów na żywo (`Time | MsgID | From | To | Ch | Type | Topic | Content`), panel `Operations` oraz `System Logs`.

##### USER STORY 3 (`THALAMUS-SANDBOX-AND-FLOW-03`): Dostęp ról do środowiska hosta (Docker / `.npm` / `TMPDIR`), kontrola rozrostu Worktrees i higiena narzędzi (`Quality Guard`, `Computer Use`)
- **Status obecny:** Rozpoznane w kampanii 12.11.2026, rozwiązane częściowo/obejściami instrukcyjnymi (hostowy harness Dockera pozostał `WIP / NOT_RUN`).
- **Kryteria Akceptacji (AC):**
  1. **Środowisko i Docker w `DeskSandbox`:**
     - Automatyczne ustawianie wewnątrz sandboxa każdej roli zapisywalnego, izolowanego `npm_config_cache` oraz `TMPDIR` (eliminacja błędów `npm ci` z kodem `254`),
     - Konfigurowalne przekazywanie dostępu do Docker Engine hosta (`/usr/bin/docker` + socket `/var/run/docker.sock`) dla uprawnionych ról za pomocą flagi `docker_access_enabled` w konfiguracji (eliminacja ślepych błędów `ENOENT`) oraz automatyczna walidacja przed zleceniem zadania wymagającego Dockera (błąd routingu zamiast pozornej awarii produktu).
  2. **Kontrola integracji i Worktrees:**
     - Zabezpieczenie przed niekontrolowanym rozrostem repozytorium (jak 159 `worktrees` i 123 `HEAD`-y) poprzez czytelny wskaźnik niescalonych gałęzi w `Flight Board / Operations` oraz konfigurowalny limit otwartych równoległych worktrees oczekujących na integrację u `K`.
  3. **Higiena narzędzi weryfikacji:**
     - Detekcja stosu technologicznego przed uruchomieniem `Quality Guard MCP` (aby dla projektów TypeScript/Node nie zwracać fałszywego wyniku `NO_SOURCE_FILES`, lecz od razu kierować do właściwego runnera TS/Node lub natywnego adaptera TS),
     - Domyślna blokada podnoszenia ciężkiego `codex-computer-use.exe` (~40 GB RAM) w profilach ról na rzecz lekkiego Playwrighta/Edge.

---

### KROK 3: Zwróć krótki raport i natychmiast wróć do pilnowania głównego `/goal`
Po zapisaniu powyższego dokumentu w `docs/next/` wypisz krótki raport:
1. **Gdzie dokładnie** (pełna ścieżka w `docs/next/`) zapisałeś powyższy bilans i 3 User Stories.
2. **Co już wiedziałeś** z dotychczasowego kontekstu (`STATUS.md`, commit `b235eea413a1df84e4be4cea813a25ac8a5de984`, raport kampanii), a **co musiałeś przeanalizować na nowo** na dysku.
3. Bezpośrednio po wypisaniu raportu **wróć do nadzorowania swojego głównego zadania (`/goal`)**.

<!-- END OWNER VERBATIM 2026-11-12 -->

## Rozdzielenie czasu, repozytoriów i bieżącego celu

- Bilans powyżej opisuje checkpoint kampanii 17 h 19 min. Nie jest nowym audytem bieżącego procesu ani dowodem ukończenia trzech historii. Wdrożony hotfix jednego zapytania nie zamyka refaktoryzacji magazynu, współbieżności, monitora ani środowiska.
- W późniejszej pracy Lightweight publiczne przygotowanie Java 21 na rewizji `4fa1d7b4c793c283346a8025018ebd634e7b8f66` zakończyło się exit 0; zmierzono java/javac 21.0.13 i Maven 3.9.12 przy niezmienionym POM release 11. To późniejszy dowód jednego przygotowania, nie retroaktywne zaliczenie nocnego harnessu, całej macierzy TEST-101..107 ani tej historii środowiskowej. Pierwszy późniejszy GUI C zakończył się FAIL przed Run z powodu deadline HELLO; trwa odrębna naprawa aplikacji PairCoach.
- Historyczna decyzja o limicie wykonawców została później uchylona przez właściciela. Bieżący cel nie ma sztywnego subsetu P1/P2 ani automatycznego stopu po liczbie prób; ponowienie wymaga naprawionej przyczyny lub nowej informacji. Konfigurowalny limit worktrees z US3 pozostaje wymaganiem przyszłego MVP, nie wdrożonym obecnie ograniczeniem.
- Wzmianka o NO_SOURCE_FILES opisuje wynik narzędzia podczas checkpointu; nie jest deklaracją obecnych możliwości wszystkich wersji Quality Guard. Rekordów CallLedger nie utożsamiamy z liczbą fizycznych wywołań modelu. Zgłoszenie rozrostu procesu computer-use nie jest samo w sobie diagnozą konkretnego mechanizmu wycieku.
- Obecnie nie wdrażamy `storage_backend`, `docker_access_enabled`, nowego dostępu do socketu ani tablicy. W Lightweight operacje Docker nadal wykonuje host z dostępem do daemona; kontenery programów ucznia nie otrzymują socketu Dockera.
- Repozytoria Thalamusa (`codex_synapse_new`) i PairCoding są odrębne. Na żądanie właściciela ten sam dokument i indeks są zapisane w obu. Publikacja w PairCoding nie oznacza zmiany kodu platformy Thalamus.
- Ten dokument zastępuje w aktywnym backlogu wcześniejszy węższy opis dwóch historii. `THALAMUS-FLIGHT-TABLE-01` jest historyczną nazwą historii rozwiniętej teraz jako `THALAMUS-FLIGHT-BOARD-02`; nie tworzymy drugiego równoległego zadania. Dawna wersja pozostaje w historii Git (`5415cea`).

## Źródła do implementacji i weryfikacji

- Hotfix Thalamusa: `b235eea413a1df84e4be4cea813a25ac8a5de984`; zakres i dowody nie oznaczają odbioru portów.
- Dane publikowane w PairCoding: `docs/checkpoint-20261112/evidence/native-watchdog-focused-check/` (patch, integration.json, post-deployment-identity.json). W repozytorium samego Thalamusa mogą znajdować się w zewnętrznym checkoutcie PairCoding; nie są automatycznie częścią obu drzew.
- Ponownie odczytany Legacy TODO: `TODO_thalamus_hub_flight_control_layout.md`, 2026-05-13, status historyczny IMPLEMENTED w Legacy, nie w Rebirth. Zawiera reguły czytelności kolumn Time/MsgID/From/To/Ch/Type, zwężania Operations i odróżnienia BLOCKED_CONFIRMED od otwartego alarmu.
- Aktualny odczyt CLI Rebirth potwierdził limit response.read(2 * 1024 * 1024); rzeczywisty /api/snapshot miał około 43 MB i poprawny pełny JSON. Jest to potwierdzenie przyczyny ucięcia odczytu CLI, nie zaliczenie naprawy.
- Tymczasowy STATUS.md był źródłem historycznego kontekstu; trwały zakres i trzy historie są tutaj. STATUS.md nie jest aktualizowany tą zmianą.
