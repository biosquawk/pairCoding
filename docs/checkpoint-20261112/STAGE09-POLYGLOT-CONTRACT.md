# Zadanie 9/9 — GOAL-PC-POLYGLOT-01 + ANNEX-PC-POLYGLOT-01A

Źródło: polecenie właściciela w bieżącej rozmowie, 2026-11-11. To zapis wiążących wymagań do późniejszego przekazania Thalamusowi, nie zlecenie rozpoczęcia implementacji. Zadania 1–8 pozostają w dotychczasowej kolejności. Zadanie 9 delegujemy dopiero po odbiorze zadania 8. Operator może wcześniej wykonać niezależny rekonesans tylko do odczytu. Alarm OK i ukończenie całego celu dopiero po odbiorze wszystkich dziewięciu zadań.

Pierwszeństwo: ANNEX-PC-POLYGLOT-01A przed sprzecznymi sformułowaniami dokumentu głównego. Niniejszy zapis zachowuje wymagania obu dokumentów; nie uprawnia do ich zawężenia. Nie przepisujemy istniejącego PairCoach od nowa.

## Wynik biznesowy

Ten sam Solarized GUI, Monaco, współpraca z rzeczywistym Trenerem AI, WriteGate, SessionController, zegar, snapshoty, ReportService, Run Main, Run Tests, Stop i weto 2× Esc. Profile: Vanilla JavaScript, TypeScript, Python 3.13, Pure Java/Maven JDK 11/17/21/27 oraz Spring Boot/Maven JDK 21/27. Kompilatory, zależności zadań, wykonanie/testy i LSP Java/Python w kontrolowanych kontenerach Docker. Bez instalacji/podmiany hostowego JDK/JAVA_HOME/Mavena/Pythona. Node serwera, przeglądarka i Docker daemon są jawnymi wymaganiami platformy; bez globalnej instalacji/rekonfiguracji bez zgody właściciela.

Sukces: człowiek wybiera profil w pliku, uruchamia PairCoach, otwiera zadanie, pisze z kolorowaniem, rzeczywistym kontekstowym completion po kropce i na żądanie oraz diagnostyką; GUI uruchamia świeżo zmieniony kod/testy w kontenerze i pokazuje rzeczywisty wynik; Stop zatrzymuje właściwy kontener. Sam build, dotychczasowe TS ani ręczny docker run nie stanowią odbioru.

## REQ-101 — rekonesans operatora przed projektem i delegacją Dockera

Read-only przeszukanie lokalnych repozytoriów/katalogów Ubuntu, zwłaszcza mvp/poc/kata/java/spring/docker: Dockerfile*, compose.yaml/yml, docker-compose*.yml, skrypty i konfiguracje Javy/Mavena/Pythona w kontenerach. Ustalić obrazy, cache, mapowanie plików Windows/WSL/Ubuntu, porty i zatrzymywanie. Zapis konkretnych ścieżek, hashy/rewizji, wzorców do adaptacji i elementów wykluczonych (nadmierne uprawnienia, montowanie home, sekrety). Bez modyfikowania obcych projektów, uruchamiania ich usług, odczytu .env lub poświadczeń. Dla ról bez dostępu przekazać oczyszczony wyciąg. Brak referencji jawnie odnotować; sam brak nie blokuje celu.

## REQ-102 — Ports & Adapters, granice

Wspólny Runner: przyjęcie Run/Test, izolowane wejście, stan/runId, strumień, Stop; bez mvn/javac/pytest/flag Spring/nazw obrazów. Port rdzenia nazywa się **ExecutionPort**, implementacja **DockerExecutor** (aneks zastępuje nazwę DockerExecutorPort). **TaskRuntimeAdapter** buduje plan języka/narzędzia i interpretuje JUnit XML/błędy kompilacji, bez GUI/WriteGate/weta. **LanguageFeaturesPort** dostarcza completion/diagnostics, bez zapisu do oryginalnego workspace. **monacoLspBridge** i EditorPanel są neutralne: bez Docker/Maven/pip, wyboru obrazów i if(language===java).

Jeden sparametryzowany adapter rodziny Java/Maven, wersje JDK/obrazy jako dane. Spring Boot jest wariantem zadania Java/Maven, nie osobnym językiem. Prosty rejestr/fabryka przy starcie; bez marketplace'u i ciężkiego DI. GUI, WriteGate, SessionController, WorkspaceService i pozostały wspólny rdzeń pozostają niezależne od języka. Automatyczny test granic importów/warunków (AC-103).

## REQ-103 — profile, konfiguracja, obrazy

Predefiniowane profile: javascript-node, typescript-node (rzeczywisty tsc), python-3.13 (pytest/JUnit/LSP), java-maven-11, java-maven-17, java-maven-21, java-maven-27. JDK27 GA, bez ruchomego latest jako jedynej tożsamości. Przypięty Spring Boot zgodny z JDK21 i JDK27; nie wymagamy nowoczesnego Spring Boot na11.

Plik w głównym katalogu aplikacji:

```json
{
  "schemaVersion": 1,
  "activeProfile": "java-maven-21",
  "workspaceRoot": "./examples/java-pattern",
  "runtimeCatalog": "./runtimes/catalog.json",
  "imageLock": "./runtimes/images.lock.json",
  "languageFeatures": { "completion": true, "diagnostics": true },
  "execution": { "backend": "docker", "pullPolicy": "never" }
}
```

Ścieżki względne względem pliku, nie process.cwd(). Profil env PAIRCOACH_RUNTIME_PROFILE > activeProfile. Workspace: jawne GUI POST /api/project/open > PAIRCOACH_WORKSPACE_DIR > workspaceRoot. Profil widoczny w GUI. Restart dopuszczalny; hot-swap nie jest wymagany. Restart/nowy projekt nie przenosi kontekstu AI, cache LSP ani Run poprzedniego projektu.

RuntimeProfile wybiera adapter, przypięty obraz i LSP. Osobny TaskRunConfig w ustawieniach projektu określa main class/moduł/skrypt, testy lub tryb spring-boot i port wewnętrzny. Bez rozpoznawania katalogów po nazwie i zaszytych klas examples; drugi projekt o innych nazwach musi działać bez zmiany aplikacji. Przed C operator zatwierdza wspólny FE/BE kontrakt migracji RunProfile; zatwierdzone wykonania kierują się ExecutionPort→DockerExecutor, nigdy niejawnie do host executable.

Fail-closed konfiguracji/obrazu: nieznany profil, sprzeczne ustawienia, brak obrazu/daemona blokują Run/Test z czytelnym komunikatem i zero fallbacku host/mock. Nie blokują HTTP/WS, otwarcia i ręcznej edycji, odzyskania draftu/snapshotu. Czytelne nazwy obrazów paircoach/runtime-java:21-v1/27-v1, runtime-python:3.13-v1, runtime-node:22-v1; dokładne imageId/digest i wersje narzędzi w runtimes/images.lock.json. Nazwy/label kontenerów pozwalają identyfikować wyłącznie własne zasoby.

## REQ-104 — prepare, cache i ochrona hosta

Jawne npm run runtime:prepare lub skrypt buduje/pobiera zatwierdzone obrazy i rozgrzewa zależności przykładów. Run/Test później --pull=never, lokalne zarządzane cache Maven/pip/npm odseparowane między niezgodnymi wersjami. Inwalidacja gotowości po pom.xml/requirements.txt/package.json; bez starych klas i raportów testowych. Próba bez dostępu do rejestrów po prepare obowiązkowa.

Zakaz montowania prywatnego ~/.m2, całego home, docker.sock oraz przekazywania GEMINI_API_KEY/tokenów sesji/innych kluczy. Żaden Run/prepare/LSP nie przyjmuje dowolnych flag Dockera z zadania lub AI.

## REQ-105 — izolowany Run, Stop, artefakty

Rozliczyć zapisy, zamrozić potwierdzony WriteGate workspaceVersion, zapisać wersję/hash i skopiować do osobnego runId. Wykluczyć target, __pycache__, stare JUnit, .env/sekrety. Kompilacja i raporty wyłącznie w tej kopii; nigdy RW bind oryginalnych źródeł. Pisanie dalej nie zmienia wejścia Run; workspaceChangedDuringRun=true.

Każdy Run/Test ma osobny efemeryczny kontener paircoach-<installationId>-<profileId>-<runId>. LSP ma osobny kontener i cykl życia projektu/profilu; Stop Run nie dotyka LSP ani treningu. Obrazy/cache są współdzielone, kontenery wykonania nie.

Kolejność: potwierdzić wyjście/Stop procesu w kontenerze → zebrać logi i świeży JUnit do artefaktów runId → utrwalić stan Run → usunąć kontener. Nigdy nie usuwać przed odczytem raportów. Stop/timeout zatrzymuje i usuwa konkretny kontener, nie sam proces klienta docker. Brak kontaktu z daemonem przy Stop => PROCESS_STOP_UNCONFIRMED/błąd, bez pozornego sukcesu; retry tego samego runId. Orphan cleanup po restarcie wyłącznie własne zasoby; niezależny kontener kontrolny nietknięty.

Każdy Run/prepare/LSP: non-root, brak --privileged/socketu, --security-opt=no-new-privileges, --cap-drop=ALL gdzie pozwala obraz, limity pamięci/CPU/PIDs i log driver np. max-size=10m/max-file=1 niezależnie od outputTail64KiB. Termin: izolacja narzędzi i kontrolowane wykonywanie zadań; bez deklaracji pełnego sandboxa dla dowolnego złośliwego kodu.

Spring: port tylko127.0.0.1:<port>:<containerPort>, rzeczywisty HTTP healthcheck, nie sam stdout Started. Rozróżniać RUNNING, endpoint HTTP gotowy, zakończony. Healthcheck nie kończy Run statusem SUCCEEDED. Po Stop kontener zatrzymany i endpoint nie odpowiada.

## REQ-106 — LSP, trzy stany dokumentu i Monaco

Kolorowanie + rzeczywiste completion i podstawowa diagnostyka. Java: przypięty JDT LS w kontenerze, JDK uruchamiające sam LSP niezależne od target JDK11/17/21/27; jawny spike zgodności z27. Python: pylsp/jedi w kontenerze. JS/TS mogą używać wbudowanego workera językowego; tsc/Run/Test zawsze Docker.

Run używa wyłącznie zamrożonego ACK workspace. LSP używa kontrolowanej kopii projektu i buforów pamięciowych także PRZED ACK, przez didOpen/didChange/didClose, bez zapisu do oryginalnego workspace i bez drugiego autosave. Synchronizować pisanie, COACH_STEP_EDIT, Undo/Redo, EXTERNAL_FILE_SYNC, restore snapshotu oraz CREATE/RENAME/DELETE.

Jeden monacoLspBridge: dwukierunkowo URI paircoach:// ↔ względna ścieżka POSIX ↔ URI w kontenerze. Testy spacji, polskich znaków, CRLF, znaków spoza BMP/UTF-16. Korelacja każdej completion/diagnostics: projectId/path/localModelVersion/activeProfile/requestGeneration, z poprawnym powiązaniem documentVersion. Brak version w LSP publishDiagnostics nie uprawnia do przyklejenia starej odpowiedzi do bieżącego modelu; odrzucać spóźnione odpowiedzi, anulować stare żądania.

LanguageFeatureRegistry staje się rzeczywistą implementacją, autocomplete ON. EditorPanel odblokowuje quickSuggestions/suggestOnTriggerCharacters i integruje mostek; Header pokazuje neutralny profil i stan INDEXING/ON/OFF/FAILED, Docs N/A i AutoComp status. Błąd LSP nie blokuje pisania.

Akceptacja Tab/Enter to zwykła edycja STUDENT przez CODE_CHANGED/autosave/WriteGate/Undo. W chwili AKCEPTACJI sprawdzić prawo STUDENT i wersję, nie tylko w chwili otwarcia widgetu. AdditionalTextEdits tylko w tym samym dokumencie, razem z podpowiedzią i po kontroli zakresów/wersji/prawa. Odrzucać CompletionItem.command, wieloplikowe edycje i unsolicited workspace/applyEdit.

Obowiązkowy kontrprzypadek: widget otwarty → CONTROL_PREPARE → Enter. Już CONTROL_PREPARE zamyka widget, anuluje LSP i blokuje mutację przed niebieską ramką. Podczas COACH brak sugestii/mutacji; po wecie stare żądania nie otwierają listy ponownie.

## JDK, dialekt, kompilacja

Dla każdego Java profilu rejestrować JDK narzędzi, efektywny maven.compiler.release/--release i poziom analizy LSP. Bez cichego obniżania pom.xml lub ukrytych flag. Kontrola składni/API różniącej starszy i nowszy JDK ma dowodzić rzeczywistego poziomu kompilacji i diagnostyki. JDT LS/JDK27 zgodność obowiązkowa w B, z oddzieleniem JDK samego LSP.

## Pakowanie

Zaktualizować allowlistę/commandClosure i integralność scripts/package-windows.mjs: paircoach.runtime.json, runtimes/**, docker/**, examples/**, nowe skrypty npm/runtime:prepare. SHA256 całości. Co najmniej jeden pełny LIVE ze świeżo rozpakowanej takiej paczki na docelowej topologii użytkownika.

## Kolejność A–F, bramka operatora przed C

A: rzeczywista bazowa rewizja po8, topologia Windows/WSL/Docker, referencje REQ101, otwarte ustalenia review i zamrożone ochronne testy edytora/WriteGate.
B: izolowany spike: daemon Docker, kompilacja/Run JDK21/JDK27/Python3.13, twardy Stop, jedna prawdziwa completion Java i Python, jawna kompatybilność przypiętego JDT LS z27/dialekt.
**Operator niezależnie odbiera A–B oraz wspólne porty i RunProfile przed rozpoczęciem równoległej implementacji C.** Każdy wykonawca: rozłączny zakres plików, AC i format dowodu.
C: porty/rejestry, konfiguracja i migracja RunProfile, test architektury/importów, obecne JS/TS przez Docker bez regresji GUI.
D: jeden adapter Java/Maven 11/17/21/27, Spring21/27, Python, obrazy/izolowane wejścia/JUnit/loopback/Stop i pięć małych przykładów.
E: completion/diagnostics z Monaco i brak kolizji z Undo/Redo/WriteGate/wetem.
F: pełna macierz LIVE na jednym zamrożonym SHA i tożsamościach obrazów, instrukcja i odbiór rozpakowanej paczki.

## TEST-101..107 — rzeczywisty GUI LIVE

Każdy pełny LIVE: Monaco→edycja→ACK na dysku→klik Run/Test→kontener→rzeczywisty wynik nowego kodu w Konsoli; próba negatywna i pozytywna. Krótkie, wykonalne przykłady, nie ręczne operator docker run.

| ID | Przykład / profil | Wymagany przebieg |
|---|---|---|
|101|Vanilla JS/javascript-node|Funkcja algorytmiczna, completion, Main, Tests FAILED→edycja→PASSED, świeży JUnit XML.|
|102|TypeScript/typescript-node|Moduł z typami i testami; rzeczywisty błąd typów oraz Main/Tests.|
|103|Pure Java/Maven/java-maven-11|Wzorzec Strategy/Builder w1klasie i JUnit; java/javac wewnątrz11, kompilacja, negatywny i pozytywny test.|
|104|Ten sam Pure Java/java-maven-17|Kompilacja/Main/Tests oraz wersja17 z kontenera.|
|105|Pure Java/java-maven-21 i27 osobno|Pełny LIVE21→zmiana pliku/restart→pełny LIVE27; completion po kropce, rename metody aktualizuje completion; rzeczywisty trener i weto2×Esc.|
|106|Minimalny Spring Boot/Maven21 i27 osobno|Tests FAILED dla błędnej logiki endpointu→edycja→PASSED; Main→prawdziwy HTTP loopback→Stop→potwierdzony stop kontenera i brak endpointu.|
|107|Python3.13/pytest|LRU/kalkulator, completion po kropce i rename aktualizuje listę, Main, pytest/JUnit FAILED→edycja→PASSED, rzeczywisty trener.|

Dla Java/Python/TS dodatkowo GUI diagnostyka: błąd w znanym miejscu→marker→poprawka→marker znika. Deterministyczny provider służy maszynie stanów; odbiór wymaga po jednym udokumentowanym rzeczywistym skonfigurowanym modelu AI dla Java i Python.

## AC-101..112

101: cała macierz bez host Java/Maven/Python na PATH lub z innymi wersjami; zero zmian globalnego środowiska.
102: restart sequence21→27→Python3.13→21: właściwe obrazy/narzędzia, brak mieszania AI/Run/LSP/cache.
103: test statyczny brak Docker/Maven/Spring/Python imports/conditions w components/**, App, WriteGate, SessionController, WorkspaceService; GUI neutralne.
104: Run/Test nie zmienia źródeł/testów/konfiguracji oryginalnego zadania, tylko izolowane wejście.
105: PASSED wyłącznie świeży, bieżący runId/input JUnit: testCount>0, failures=0, errors=0, testCount-skipped>0 i prawidłowy exit. Sam exit0 bez raportu => UNKNOWN;0testów=>NO_TESTS; same skipped nie PASSED. Negatywne: stary raport, same skipped, niezerowy exit mimo zielonego XML.
106: nieskończona pętla/Spring zatrzymane przezStop i timeout; niezależny kontener kontrolny nietknięty, orphan cleanup własnych zasobów po restarcie.
107: prepare wystarcza do kolejnych uruchomień --pull=never z lokalnymi cache, również przy odcięciu rejestrów.
108: rzeczywiste metody projektu Java/Python i rename-metody zmienia completion; stan LSP w GUI.
109: brak regresji Monaco/models/tabs/cursor/selection podczas pokazu/UndoRedo/single-flight autosave/METRIC-001..004/weto2×Esc.
110: daemonOFF/imageMissing/configError/LSPfailed: czytelne naprawcze UI, zachowany draft, bez host/simulator/mock fallbacku; edytor dostępny.
111: jawne rozdzielenie dowodów Ubuntu/WSL od natywnego Windowsa, bez podszywania środowiska.
112: instrukcja człowieka: wybór profilu, prepare, każdy przykład i pakowanie; co najmniej jeden pełny scenariusz ze świeżo rozpakowanej paczki na ustalonej topologii.

## Zasady dowodowe i ochronne aneksu

Istniejących asercji, METRIC-001..004, golden fixtures i skryptów weryfikacyjnych nie wolno osłabiać bez jawnej zgody właściciela. Każdy test wyłącznie PASS/FAIL/BLOCKED/NOT_RUN, dokładny SHA, konfiguracja runtime, digesty images.lock, rzeczywiste środowisko i artefakty. Dwie kolejne nieudane próby bez nowego dowodu zatrzymują daną ścieżkę: zmiana hipotezy lub eskalacja, nie ślepe ponawianie. Ostateczne ukończenie deklaruje Operator po niezależnym odczycie dowodów; nie wykonawca. Alarm OK dopiero po wszystkich9 zadaniach, w tym pełnym zadaniu9 A–F.
