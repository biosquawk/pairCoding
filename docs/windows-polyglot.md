# PairCoach — profile i przykłady kontenerowe (Windows / WSL)

**ETAP9: implementacja częściowa, PENDING_FINAL_QA — nie wydanie.**
Ten dokument uzupełnia [start](windows-start.md) i [pakowanie](windows-package.md).
Sprawdź rewizję wskazaną przez K oraz zaufany, przekazany niezależnie SHA256 manifestu.
Sam ZIP, plan prepare, lokalny tag ani pusty `runtimes/images.lock.json` nie oznacza gotowości.
Na bazie tej zmiany CLI i runtime assets są osobną dostawą P1_4; zanim zostaną
zintegrowane, `runtime:prepare` / lista pakietera mają jawnie odmówić z powodu braków.
Nie korzystaj zamiast nich z prywatnych operator-request/ROOT paths.

## 1. Platforma i wybór profilu

Użyj **jednej** ustalonej instalacji: Node >=22.22.0, npm, przeglądarka oraz Docker
Desktop z Linux containers. Windows i WSL to różne środowiska klienta — nie mieszaj
ich `node_modules` ani ścieżek bind mount. Zalogowany Codex trener/raport i logowanie
ChatGPT są opisane w windows-start; prepare nie wymaga ani nie przekazuje kluczy AI.
Nie instaluj hostowego JDK, Mavena ani Pythona i nie zmieniaj JAVA_HOME/PATH.

Otwórz `paircoach.runtime.json` **w głównym katalogu aplikacji**. Domyślnie wskazuje
`java-maven-21` i `./examples/java-pattern`. Ustaw `activeProfile` oraz `workspaceRoot`
według tabeli poniżej. Wszystkie względne ścieżki konfiguracji (`workspaceRoot`,
`runtimeCatalog`, `imageLock`) liczone są od **pliku konfiguracji**, nie terminala.
Katalog i lock to odpowiednio `./runtimes/catalog.json` i `./runtimes/images.lock.json`.
Nie wpisuj domyślnego/fikcyjnego imageId ani digestu. `backend: docker`, `pullPolicy: never`.

Priorytet profilu: `PAIRCOACH_RUNTIME_PROFILE` > `activeProfile`.
Priorytet workspace: jawne otwarcie projektu w GUI > `PAIRCOACH_WORKSPACE_DIR` > `workspaceRoot`.
Usuń niezamierzone nadpisania env w swojej sesji; zmiana profilu wymaga restartu aplikacji.
Po restarcie sprawdź profil i stan runtime w nagłówku, zanim klikniesz Run.
Nie przenoś ustawień/kontekstu Run/AI/LSP z poprzedniego projektu.

| Przykład (`examples/…`) | `activeProfile` | Main — jawny TaskRunConfig | Tests — jawne selektory |
|---|---|---|---|
| `javascript-counter` | `javascript-node` | SCRIPT `main.js` | paths: `counter.test.js`; names: puste |
| `typescript-counter` | `typescript-node` | SCRIPT `main.ts` | paths: `counter.test.ts`; names: puste |
| `python-calculator` | `python-3.13` | SCRIPT `calculator.py` | paths: `test_calculator.py`; names: puste |
| `java-pattern` | `java-maven-11`, `java-maven-17`, `java-maven-21`, `java-maven-27` | JAVA_MAIN `demo.StrategyDemo` | paths: puste; names: `demo.StrategyDemoTest` |
| `spring-counter` | `java-maven-21`, `java-maven-27` | SPRING_BOOT containerPort `8080`, healthPath `/sum` | paths: puste; names: `demo.CounterApplicationTest` |

**Profil środowiska ≠ konfiguracja zadania.** Każdy przykład zawiera `task.v2.json`
z dwoma oddzielnymi RunProfileV2 (`RUN_MAIN`, `RUN_TESTS`), `workingDirectory: "."`,
`timeoutMs: 120000` i strukturą `task.entry` / `task.tests`. To szablon danych do
jawnego zapisania w ustawieniach projektu V2, **nie** automatyczny import ani shell command.
Przejrzyj pola Main i Tests w ustawieniach i zapisz je jawnie; samo otwarcie katalogu
nie upoważnia aplikacji do zgadywania klasy/skryptu. Nie zastępuj całych istniejących
settings plikiem zawierającym tylko `runProfiles`; zachowaj pozostałe ustawienia.
Inny własny projekt z innymi klasami/skryptami wymaga swoich selektorów, nie zmiany aplikacji.

Java przykład ma początkowo `maven.compiler.release=11`; człowiek jawnie zmienia
`pom.xml` na 17/21/27 przed wyborem odpowiedniego profilu. Spring ma początkowo21:
dla27 zmień **oba** `java.version` i `maven.compiler.release` na27. Wymagana zgodność
release / poziomu analizy / preview; adapter nie zmienia POM i nie obniża wersji po cichu.
Spring nie jest oddzielnym profilem ani językiem i nie jest wspierany przez profile11/17.

## 2. Jawne prepare (bez domyślnego wykonania)

Z katalogu aplikacji, po instalacji zależności zgodnie z windows-start:

```powershell
$project = (Resolve-Path '.\examples\java-pattern').Path
$profile = 'java-maven-21'
# Istniejący prywatny rodzic, NOWE różne katalogi wyniku; nie repo/workspace/home/cache innej aplikacji.
$planOut = Read-Host 'Pelna sciezka NOWEGO prywatnego katalogu dla planu'
npm.cmd run runtime:prepare -- --project $project --profile $profile --output $planOut
if ($LASTEXITCODE -ne 0) { throw 'Plan FAIL: zachowaj wynik i odczytaj blad, nie ponawiaj w ciemno' }
# Dopiero po odczycie planu/pinow. To operacja sieciowa/Docker, nie codzienny Run.
$executeOut = Read-Host 'Pelna sciezka INNEGO NOWEGO prywatnego katalogu wykonania'
npm.cmd run runtime:prepare -- --project $project --profile $profile --output $executeOut --execute
if ($LASTEXITCODE -ne 0) { throw 'Prepare FAIL/nieznany: zachowaj receipts i uzgodnij stan zasobow przed ponowieniem' }
```

W WSL odpowiednikiem jest `npm run runtime:prepare -- --project <absolutna-sciezka-WSL>
--profile <ID-z-tabeli> --output <NOWY-prywatny-katalog-WSL> [--execute]`.
Nie przekazuj ścieżki `C:\…` do klienta Node uruchomionego w WSL ani odwrotnie.
Domyślny plan **nie przygotowuje** obrazów/cache. Brak zatwierdzonych pinów/assets,
obrazu, daemona lub zależności ma dać błąd/NOTREADY, bez host/mock fallbacku.
Prepare ma używać wyłącznie package-relative pinów i skryptów; żadnych operator-only request paths.
Nie montuje home, prywatnego `.m2`, docker.sock ani sekretów i nie przyjmuje flag Docker z zadania.
Po `pom.xml`, `requirements.txt`, `package.json` lub lock/config zmienionym względem
przygotowanego projektu wykonaj nowe jawne prepare; zwykła edycja źródła nie zmienia zależności.
Run/Test używają później wyłącznie przypiętych lokalnych obrazów `--pull=never` i zarządzanych cache.

**Przekazanie wyniku do aplikacji: wybrany kontrakt, JESZCZE NIE ZINTEGROWANY.**
Po wdrożeniu faktycznego CLI i konsumenta backendu start wybiera wyniki jawnie:

```powershell
npm.cmd start -- --prepared-runtime $executeOut
# Można powtórzyć --prepared-runtime <ABSOLUTNY-outputRoot> dla innych przygotowań (max16).
```

`npm.cmd run server -- --prepared-runtime $executeOut` przekazuje ten sam parametr.
To nie pole `paircoach.runtime.json`, nowa zmienna env ani automatyczne wyszukiwanie cache.
Źródłem jest `receipt.json` we wskazanym outputRoot i związany cache
`cache/<family>/<toolchainHash>/<dependencySha256>`; ich istnienie/status NIE wystarcza
za dowód gotowości. Konsument ma ponownie potwierdzić bieżący projekt/zależności/task,
rzeczywisty engine/obraz/narzędzia i kompletność cache. `imageLock` w istniejącym pliku
konfiguracji musi wskazywać rzeczywisty zmierzony imageId **oraz prawdziwy** OCI manifest
/Descriptor/RepoDigest; imageId nie może udawać digestu. Pusty lock nadal blokuje wykonanie.
CLI ma czytać pełne ustawienia V2 projektu i rzeczywiste task.workingDirectory; dla różnych
katalogów Main/Tests potrzebne są osobne związane outputy albo jawna odmowa, nigdy zgadnięte `.`.

W tej rewizji CLI nadal nie istnieje i konsument nie jest zintegrowany: nie uruchamiaj
powyższego jako instrukcji gotowego wydania. Zachowaj output; dostawa K z frozen faktycznym
CLI/consumer musi potwierdzić cały przebieg i dokładne źródło prawdziwego image lock.
Do tego czasu kandydat **nie spełnia całego AC112**. Nie obchodź odmowy przez ręczne
docker run, receipt-presence ani fikcyjny lock. Pozostaje osobno wymagany offline proof
po prepare; samo pobranie obrazów i zależności/tiny tool probe go nie zastępuje.

## 3. Jeden scenariusz po integracji prepare i backendu

1. Wybierz zgodny profil i przykład, przygotuj go, uruchom aplikację według windows-start,
   otwórz katalog przykładu w GUI, jawnie zapisz jego dwa ustawienia V2. Oczekuj
   właściwego profilu i osobnej gotowości Main/Tests; `INDEXING` nie jest `ON` LSP.
2. Run Tests: przykłady celowo odejmują zamiast dodawać, oczekiwany **FAILED**.
   Zmień samą logikę odejmowania na dodawanie w `main.js`, `main.ts`, `calculator.py`,
   `StrategyDemo.java` lub `CounterApplication.java`, nie test. Zaczekaj na prawdziwy
   ACK zapisu i uruchom Tests ponownie: oczekuj świeżego JUnit bieżącego runId,
   testCount>0, nie tylko exit0. Brak raportu=UNKNOWN; zero testów=NO_TESTS;
   same skipped nie oznaczają PASSED. Konsola ma pokazać nowy wynik kodu.
3. Run Main: JS/TS/Java/Python pokazuje aktualny wynik. Dla Spring poczekaj na prawdziwy
   HTTP `/sum` pod pokazanym `http://127.0.0.1:<przydzielony-port>/sum`, nie sam tekst
   Started. HTTP-ready nie kończy Run statusem SUCCEEDED. Kliknij Stop: oczekuj
   potwierdzonego zatrzymania właściwego kontenera i braku odpowiedzi endpointu.
4. Java/Python: completion po kropce i na żądanie ma znać metody projektu; zmiana nazwy
   ma zmienić listę. Wstaw błąd typu/referencji, sprawdź rzeczywisty marker i jego
   zniknięcie po poprawce. TS: zwróć string zamiast liczby w `add`, sprawdź realny
   błąd tsc i popraw typ. Nie myl samego kolorowania z działającym LSP/kompilatorem.
5. Podpowiedź akceptowana Tab/Enter jest zwykłą edycją STUDENT; CONTROL_PREPARE/COACH
   zamyka widget i blokuje mutację, stare odpowiedzi po wecie nie otwierają go ponownie.
   W Java i Python wykonaj osobno prawdziwą rozmowę trenera oraz weto2×Esc.

Błąd config/daemona/obrazu/prepare/LSP: odczytaj komunikat i recovery w UI. Run/Test
mogą być niedostępne, ale HTTP/WS, ręczna edycja, draft i snapshot recovery mają działać.
Nie kasuj draftu, nie przenoś cache między JDK/projektami i nie traktuj Stop niepotwierdzonego
jako sukcesu. Po nieznanym wyniku najpierw odczytaj stan tego samego runId/operacji.

## 4. Pakowanie i granice dowodu

Producent stosuje `node scripts/package-windows.mjs --commit <pełny40SHA> --list`
i `--dry-run`, sprawdza manifest/closure i dopiero po osobnej zgodzie procedurę
`--output <nowyKatalogPozaRepo>` z windows-package. Każdy dołączony plik ma bytes i SHA256:
rootconfig, source runtime scripts, `runtimes/`, `docker/`, pięć `examples/` i stary
kontrakt snapshot recovery. Wykluczone są m.in. `.env*`, sekrety/klucze, node_modules,
obrazy/tar, download binaries, cache/target/__pycache__, raw receipts/logi i artifacts.
Symlink, submodule w wybranym zakresie i alias nazwy Windows są odrzucane.
`manifest.commands` obejmuje także literalny `runtime:prepare`; pakieter niczego nie wykonuje.
Zaufanie pochodzi z niezależnie przekazanego SHA256 manifestu od K/operatora,
nie z leżącego obok SHA256SUMS. Nie osłabia to istniejącego weryfikatora/recovery.

Aktualne testy developera weryfikują źródłową selekcję i syntetyczne archiwum, nie
Docker LIVE. Wymagane po integracji: wszystkie7profili, Spring21/27, offline po prepare,
rzeczywiste GUI/ACK/Run/Tests/Stop/LSP/AI, Windows i WSL opisane oddzielnie oraz co najmniej
jeden pełny LIVE ze **świeżo rozpakowanej paczki**. Dopiero finalF/niezależny odbiór,
nie ten dokument ani plan, rozstrzyga TEST101–107 i AC101–112.
