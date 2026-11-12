# PairCoach — profile i przykłady kontenerowe (Windows / WSL)

**ETAP9: implementacja częściowa, PENDING_FINAL_QA — nie wydanie.**
Ten dokument uzupełnia [start](windows-start.md) i [pakowanie](windows-package.md).
Sprawdź rewizję wskazaną przez K oraz zaufany, przekazany niezależnie SHA256 manifestu.
Sam ZIP, plan prepare, lokalny tag ani pusty `runtimes/images.lock.json` nie oznacza gotowości.
Publiczne CLI i runtime assets są osobną, źródłowo odebraną dostawą P1_4.
To nie odbiór ich integracji z backendem: przed użyciem K musi wskazać spójną rewizję
aplikacji zawierającą producenta, konsumenta i pakowanie. Niepełna kopia źródeł ma
jawnie odmówić zamiast pominąć wymagane pliki.
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

## 1a. Pełne ustawienia projektu — PRZED prepare

CLI czyta **`<kanoniczny-projekt>/.paircoach/settings.json`**, nie `task.v2.json`.
Najpierw zapisz jawnie pełne ustawienia V2; prepare nigdy ich nie tworzy ani migruje.
Dla **nowego** `examples/javascript-counter`, przy zamkniętej aplikacji, utwórz
katalog `.paircoach` i zapisz w nim `settings.json` jako UTF-8 bez BOM:

```json
{
  "schemaVersion": 2,
  "taskFilePath": null,
  "taskMode": "IMPLEMENTATION",
  "reviewNotesPath": "review.md",
  "aiConsent": false,
  "contextPatterns": [],
  "runProfiles": [
    {
      "kind": "RUN_MAIN",
      "timeoutMs": 120000,
      "task": {
        "workingDirectory": ".",
        "entry": { "kind": "SCRIPT", "path": "main.js" },
        "tests": { "paths": [], "names": [] }
      }
    },
    {
      "kind": "RUN_TESTS",
      "timeoutMs": 120000,
      "task": {
        "workingDirectory": ".",
        "entry": { "kind": "TESTS" },
        "tests": { "paths": ["counter.test.js"], "names": [] }
      }
    }
  ]
}
```

To kompletny przykład **tylko dla świeżego projektu JS**, nie polecenie nadpisania
istniejących ustawień. Jeśli plik już istnieje, zachowaj jego bajty i użyj jawnego
zapisu/migracji V2 w ustawieniach aplikacji; zachowaj task, zgodę, kontekst, drafty
oraz pozostałe dane. Nie zastępuj pliku samym `runProfiles` ani całym `task.v2.json`.
Dla innych przykładów jawnie ustaw Main/Tests według tabeli i szablonu `task.v2.json`,
pozostawiając pełną otoczkę SettingsV2. Zgodę AI włączaj osobno i świadomie w GUI.
Brak/legacy/mixed settings powoduje odmowę z instrukcją jawnego zapisu, bez zgadywania.
Niestandardowy backend `dataDir` poza tą lokalizacją nie jest obsługiwany przez CLI;
nie przenoś plików ani nie wybieraj innego katalogu na próbę.
Dwa różne `task.workingDirectory` Main/Tests są w tym CLI jawnie odrzucane;
jedno wspólne niekropkowe `workingDirectory` ma być zachowane, nie zastąpione `.`.

## 2. Jawne prepare (bez domyślnego wykonania)

Poniżej schemat docelowy, nie dowód gotowości bieżących źródeł. Przed `--execute`
sprawdź aktualną dopuszczoną rewizję i ograniczenia opisane pod przykładem.
Z katalogu aplikacji, po instalacji zależności zgodnie z windows-start:

```powershell
$project = (Resolve-Path '.\examples\javascript-counter').Path
$profile = 'javascript-node'
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
Domyślny wynik JSON `PLAN_ONLY` **nie przygotowuje** obrazów/cache i nie tworzy
nawet katalogu `$planOut`: brak zapisu, sieci i wywołań Docker. Po odczycie planu
wykonanie wymaga osobnego `--execute` i INNEGO nowego prywatnego outputu. Brak zatwierdzonych pinów/assets,
obrazu, daemona lub zależności ma dać błąd/NOTREADY, bez host/mock fallbacku.
Prepare ma używać wyłącznie package-relative pinów i skryptów; żadnych operator-only request paths.
Nie montuje home, prywatnego `.m2`, docker.sock ani sekretów i nie przyjmuje flag Docker z zadania.
Po `pom.xml`, `requirements.txt`, `package.json` lub lock/config zmienionym względem
przygotowanego projektu wykonaj nowe jawne prepare; zwykła edycja źródła nie zmienia zależności.
Run/Test używają później wyłącznie przypiętych lokalnych obrazów `--pull=never` i zarządzanych cache.

**Przekazanie wyniku do aplikacji: odebrany źródłowo producent P1_4, JESZCZE NIE ZINTEGROWANY.**
K dopuścił dokładne źródła CLI `337dbb3aa1d439a4c9cf706037c80a595419f773`
i pełne assets `b60254a40aa8c47455b829ffa1844e11b99f6311`; poniższe nazwy/statusy
odpowiadają temu producentowi. To identyfikatory źródeł, nie finalna rewizja aplikacji.
W pełnym źródle generator, catalog, production pins i language prepare mają spójne
metadane Java/Javac `27.0.1.0.2`; nie zmieniaj ich na `27.0.1.0` ani nie ignoruj
ścisłej kontroli narzędzi. Wcześniejsze prepare z błędnymi metadanymi zakończyło się FAIL,
nie gotowością Java27. Odbiór źródła nie upoważnia do ponawiania tego wykonania.
Historyczny dowód operatora wykazał dodatkowy problem źródeł b602: nawet samo
`buildx inspect` zapisywało metadane i blokowało następną komendę przez guard pustego config.
K odebrał źródłową poprawkę **`5a0f7fe5deee33350e0e5fe2b90de2b3c35a0f91`**
(tree `0510efc57d6da372683d31cf563857384fccb5d8`, na b602): osobne owned
`BUILDX_CONFIG`/HOME oraz NOWY pusty credential config dla każdej komendy zewnętrznej
i zagnieżdżonej, wspólna capability producenta. Znane seed/lock są wyłącznie
sprawdzane stat i zachowane, nigdy czytane, używane ponownie ani kasowane;
obce pliki/config.json, link lub zmiana tożsamości powodują odmowę po trwałym receipt,
przed następnym procesem. Nie obchodź jej przez dowolny niepusty config, usuwanie
metadanych, globalne env ani ręczny retry. Poprawka nie zmienia pinów/narzędzi/OCI/cache.
Rzeczywista kontrola tego helpera info→buildx inspect→info potwierdziła 3 puste config
oraz osobny stan Buildx, ale **nie** actual build/tokenSeeds ani Windows.
Następny rzeczywisty przebieg operatora na tych źródłach zakończył się **FAIL exit1**
po 7,495 s: `FAILED_RETAIN_AND_RECONCILE`, `Reused image identity/manifest changed`.
Wykonał tylko 4 odczyty Docker, bez nowych jobs/build/pull/kontenerów. Zachowany counter
na rzeczywistym receipt wskazuje błąd porównania kolejności kluczy JSON: Id, Descriptor
oraz RepoDigests są semantycznie identyczne, lecz guard odrzuca inną kolejność pól.
To błąd produktu w operator-only remainder, nie brak uprawnień ani dowód zmiany obrazu;
nie dowodzi też poprawności publicznego `--execute`. Poprawka P1_4 wymaga osobnego
odbioru źródła i nowego planu/guardów operatora, z zachowaniem wszystkich kontroli
obrazu/manifestu. Nie przestawiaj ręcznie pól receipt, nie osłabiaj guardu i nie
ponawiaj/resume/overwrite tego wyniku. Nie powstał zasób wymagający cleanup.
Źródłowy odbiór 5a0f nie jest zakończonym prepare. Dwa stare testy zgodności prywatnego env/transport seam pozostają
FAIL, bez zmiany ich asercji; pełny zestaw nie jest zielony. Producent i backend nadal
wymagają spójnej integracji. Nie uruchamiaj starego planu ani operator-only remainder.
Historyczny celowany smoke rzeczywistego CLI `6417183` na izolowanej źródłowej kopii bez Git w WSL potwierdził
`PLAN_ONLY` bez zapisu i procesów potomnych (7 profili oraz Spring21/27), a także odmowę
fragmentu settings, obcej flagi i istniejącego outputu. Używał istniejących zależności,
nie świeżej instalacji. Nie wykonywał `--execute`, npm/PowerShell ani backendu i nie jest
nowym testem poprawionych źródeł. Poprawiona tożsamość obrazu zachowuje zatwierdzony
selektor nazwa:tag, osobno rzeczywisty digest i imageId — nie zamieniaj selektora
na RepoDigest, aby ręcznie obejść odmowę konsumenta.
Faktyczny konsument i zintegrowany pakiet nadal wymagają osobnego potwierdzenia;
nie jest to gotowe wydanie.
Execute zwraca `PREPARED_CONFIG_GENERATED_NOT_ACCEPTANCE` albo `NOTREADY`, nigdy
status końcowy `READY`. Sam exit0, receipt lub wygenerowany config nie dowodzi gotowości.
Przy `NOTREADY` zachowaj output/diagnostykę; nie dopisuj locka i nie ponawiaj na ślepo.
Dopiero przy potwierdzonym wygenerowaniu konfiguracji pod NOWYM `$executeOut` będą:

- `runtime-config.json` — istniejący format RuntimeConfigV1 z rzeczywistym projektem;
- `catalog.json` — dokładnie jeden zatwierdzony wybrany profil;
- `images.lock.json` — rzeczywiste pomiary obrazów/narzędzi;
- `jobs/<profile>/receipt.json` i związany cache — wybierany jest **rodzic tego receipt**,
  nie zewnętrzny `$executeOut`.

Docelowy start z katalogu aplikacji (PowerShell, obie ścieżki absolutne):

```powershell
$runtimeConfig = (Resolve-Path (Join-Path $executeOut 'runtime-config.json')).Path
$preparedRoot = (Resolve-Path (Join-Path (Join-Path $executeOut 'jobs') $profile)).Path
npm.cmd start -- --runtime-config $runtimeConfig --prepared-runtime $preparedRoot
# Dodatkowe --prepared-runtime <ABSOLUTNY-rodzic-receipt> tylko dla rzeczywistych innych przygotowan (max16).
```

Dla samego serwera: `npm.cmd run server -- --runtime-config $runtimeConfig --prepared-runtime $preparedRoot`.
W WSL użyj `npm start -- --runtime-config <ABS-WSL-runtime-config.json>
--prepared-runtime <ABS-WSL-jobs/profile>`; oba selektory muszą pochodzić z tego samego
środowiska przygotowania, nie mieszanego Windows/WSL. Jawny `--runtime-config` wybiera
wygenerowany config zamiast domyślnego `paircoach.runtime.json`; CLI nie przepisuje
zainstalowanego rootconfig/catalog/lock. Nie dopisuj nowego pola RuntimeConfigV1 ani env.

Konsument ma niezależnie potwierdzić bieżący projekt/zależności/task,
rzeczywisty engine/obraz/narzędzia i kompletność cache
`cache/<family>/<toolchainHash>/<dependencySha256>`. `imageLock` wymaga zmierzonego
imageId **oraz prawdziwego** OCI manifest/INDEX Descriptor lub RepoDigest; samo imageId
nie jest dowodem digestu. W Docker Desktop obie wartości mogą być równe, jeśli istnieje
rzeczywisty Descriptor/RepoDigest — nie wymagaj sztucznej nierówności. Pusty lock blokuje Run.
CLI czyta rzeczywiste pełne SettingsV2 i wspólne task.workingDirectory, a backend ponownie
sprawdza aktualny stan; staging/receipt CLI nie zastępuje WriteGate ani aktualnego źródła.

Ta zmiana dokumentacji/pakietera nie importuje osobnego źródła CLI ani konsumenta.
Celowany plan-only/Gitless smoke producenta to PASS wyłącznie dla izolowanej kopii
łączącej zamrożone źródła — nie dowód zintegrowanego backendu ani świeżej paczki.
Wcześniejsza odmowa pakietera na brakującym CLI pozostaje historycznym FAIL; nie została
przepisana na PASS. Konsument nadal nie jest potwierdzony; kandydat **nie spełnia całego AC112**.
Nie obchodź odmowy przez ręczne docker run, receipt-presence ani fikcyjny lock.
Offline proof pozostaje osobno wymagany po prepare; samo pobranie obrazów i zależności
lub tiny tool probe go nie zastępuje.

## 2a. Zarządzany stan i transport — kontrakt integracji, nie dowód wykonania

Po integracji konsument ma wyznaczać `config-dir` z rodzica **rzeczywiście wybranego
pliku runtime config**, nie z settings/dataDir/cwd/TMPDIR ani wyszukiwania env.
Stan ma trafić do `<config-dir>/.paircoach-runtime/projects/<sha256(UTF8 canonicalProjectRoot)>/`
z `installation.json`, `runs`, `journal`: prywatny, kanoniczny, bez linków i rozłączny
w obie strony z oryginalnym workspace oraz zatwierdzonymi read-only prepared/cache roots.
To nie nowe pole JSON ani flaga. Nie wybieraj writable state przez `--prepared-runtime`.
Stabilny installationId i dziennik mają przetrwać restart; konflikt/częściowy stan wymaga
recovery, nie resetu tożsamości. UNBOUND nie tworzy katalogu ani fikcyjnego projektu.
Gdy położenie config powoduje overlap lub brak zapisu, Run ma pokazać `CONFIG_ERROR`;
HTTP, ręczny edytor i recovery działają dalej. Użyj rzeczywistego runtime config poza
konfliktującym projektem/read-only root, nie ukrytego fallbacku. Settings/dataDir/tmp
nie stanowią zgody na RW oryginalnego kodu.

Zatwierdzony klient to `/usr/bin/docker` w WSL/Linux albo
`C:\Program Files\Docker\Docker\resources\bin\docker.exe` na Windows;
endpoint odpowiednio `unix:///var/run/docker.sock` lub `npipe:////./pipe/docker_engine`.
Brak klienta/daemona wyłącza wykonanie, nie edytor; bez instalacji automatycznej,
PATH discovery, executable z zadania/profilu ani fallbacku hostowego.
Transport używa tylko własnego prywatnego pustego config pod managed root i zatwierdzonego
env, nie odziedziczonych poświadczeń/DOCKER_HOST/DOCKER_CONFIG ani globalnej zmiany env.
Run nie wykonuje prepare/build/plugin; prepare pozostaje osobnym jawnym krokiem.

Run/Test mają `network=none` i read-only zatwierdzony cache. Spring RUN_MAIN wymaga
**wcześniej przygotowanej sieci `paircoach-<installationId>-service`**; read-only inspect
musi potwierdzić dokładną tożsamość, `Internal===true` i `Driver==='bridge'`.
Wbudowana zewnętrzna sieć Docker `bridge` **nie spełnia** tego warunku. Nie twórz sieci
z zadania, nie wybieraj host/arbitrary network. Brak tej sieci daje czytelny not-ready
wyłącznie trybu service, nie trwałe wyłączenie Spring. Osobne jawne przygotowanie sieci
i jego dowód pozostają **pending integration** — obecne CLI/prepare 5a0f nie
przygotowuje tej sieci. Potrzebna jest jawna publiczna ścieżka prepare powiązana
z TĄ SAMĄ stabilną tożsamością instalacji backendu, bez drugiego installationId.
Brak tu zamrożonej publicznej komendy; nie zastępuj jej ręcznym `docker network create`.
Port wyłącznie 127.0.0.1, health, twardy Stop i orphan recovery pozostają obowiązkowe.
To zatwierdzone defaults v2, nie potwierdzenie aktualnego HTTP/index/Runner ani service PASS.

## 3. Jeden scenariusz po integracji prepare i backendu

1. Wybierz zgodny profil i przykład, przygotuj go, uruchom aplikację według windows-start,
   otwórz ten sam katalog przykładu w GUI. Pełne ustawienia V2 muszą być zapisane
   **przed prepare** (sekcja1a), nie dopiero po starcie. Oczekuj
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
Obie polityki źródłowe (pakieter i weryfikator) wymagają dokładnie15skryptów runtime
publicznego przepływu, w tym CLI i jego helpera `runtime-image-retention.mjs`.
Osobno dopuszczają **jedno prywatne źródło test-support**:
`scripts/runtime-operator-remainder.mjs`. Nie jest ono importem publicznego CLI ani
nową komendą npm/HTTP/acquisition API. Jest wymagane, jeżeli paczka wybiera którykolwiek
z testów `runtime-prepare-cli/remainder.test.mjs`,
`runtime-remainder-image-equality/image-equality.test.mjs` lub
`runtime-image-retention/seams.test.mjs` pod `tests/` (także dynamiczny import fixture).
Brak tego modułu powoduje odmowę planu/weryfikacji przed zapisem, nie pominięcie testu.
Wszystkie oryginalne asercje pozostają; pakieter i weryfikator nie wykonują modułu.
Samo dołączenie źródła nie upoważnia do uruchomienia operator-only remainder i nie
dowodzi dostępności obrazów ani zakończenia naprawy. Kontrolery historycznej naprawy,
ROOT recovery i prywatne proof fixtures pozostają izolowane i poza paczką.
Nie rozszerzaj polityki do wildcarda `scripts/**` ani nie twórz kopii implementacji.
Zaufanie pochodzi z niezależnie przekazanego SHA256 manifestu od K/operatora,
nie z leżącego obok SHA256SUMS. Nie osłabia to istniejącego weryfikatora/recovery.

Aktualne testy developera weryfikują źródłową selekcję i syntetyczne archiwum, nie
Docker LIVE. Wymagane po integracji: wszystkie7profili, Spring21/27, offline po prepare,
rzeczywiste GUI/ACK/Run/Tests/Stop/LSP/AI, Windows i WSL opisane oddzielnie oraz co najmniej
jeden pełny LIVE ze **świeżo rozpakowanej paczki**. Dopiero finalF/niezależny odbiór,
nie ten dokument ani plan, rozstrzyga TEST101–107 i AC101–112.
