# PairCoach Lightweight — profile i przykłady (Windows / WSL)

**Kandydat, nie potwierdzone wydanie.** Aktualny SHA oraz wyniki są w raporcie K.
Publiczne wykonanie prepare, Java21/Spring21 GUI, native Windows i świeży ZIP
pozostają **NOT_RUN**, dopóki raport nie zawiera rzeczywistego wyniku.
Wymagane jest wydanie zawierające obsługę `--prepare-timeout-ms`, logu postępu
i anulowania prepare. Nie używaj tych opcji na wcześniejszej rewizji aplikacji.
Ten przewodnik opisuje obsługę; nie zastępuje [instalacji](windows-start.md)
ani [weryfikacji paczki](windows-package.md).

## 1. Platforma i profil

Potrzebujesz Node.js >=22.22.0 z npm, przeglądarki i Docker Desktop z kontenerami
Linux. Narzędzia zadania (JDK, Maven, Python, pytest, TypeScript) działają w
kontenerze: nie instaluj ich na hoście. Prepare nie wymaga poświadczeń AI.
Windows i WSL to osobne środowiska klienta: nie mieszaj ich `node_modules`,
ścieżek projektów ani bind mountów. W WSL używaj ścieżek `/…`, w PowerShell `C:\…`.

| Przykład w `examples/` | Profil | Main | Tests |
|---|---|---|---|
| `java-pattern` | `java-maven-11`, `java-maven-17`, `java-maven-21`, `java-maven-27` | JAVA_MAIN `demo.StrategyDemo` | names: `demo.StrategyDemoTest`; paths: puste |
| `spring-counter` | `java-maven-21`, `java-maven-27` | SPRING_BOOT containerPort `8080`, healthPath `/sum` | names: `demo.CounterApplicationTest`; paths: puste |
| `javascript-counter` | `javascript-node` | SCRIPT `main.js` | paths: `counter.test.js`; names: puste |
| `typescript-counter` | `typescript-node` | SCRIPT `main.ts` | paths: `counter.test.ts`; names: puste |
| `python-calculator` | `python-3.13` | SCRIPT `calculator.py` | paths: `test_calculator.py`; names: puste |

Profil Java wybiera **rzeczywisty JDK kontenera**, a POM projektu określa
**target release**. Nie muszą być równe: `java-pattern` z release11 pozostaje
release11 również na JDK21/27. Nie przepisuj POM przy zmianie profilu.
Pozostała walidacja i rzeczywiste błędy kompilatora pozostają. Spring to wariant
projektu Java, nie osobny język; przykład wymaga JDK21 lub27.

Wybór profilu i projektu zapisuje `paircoach.runtime.json` w katalogu aplikacji
albo jawny plik `--runtime-config ABS`. Względne `workspaceRoot`, `runtimeCatalog`
i `imageLock` liczą się od **tego pliku**, nie od terminala. Format:

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

Sam config nie przygotowuje obrazu. Poniższa publiczna komenda generuje config
wskazujący rzeczywiście przygotowany **jeden wybrany profil** i projekt.
Nie trzeba przygotowywać pozostałych sześciu profili, aby użyć Java21.
`PAIRCOACH_RUNTIME_PROFILE` nadpisuje `activeProfile`; jawne otwarcie projektu
w GUI ma pierwszeństwo przed `PAIRCOACH_WORKSPACE_DIR` i `workspaceRoot`.
Usuń niezamierzone nadpisania w swojej sesji. Zmiana profilu wymaga restartu.

## 2. Nowa prywatna kopia przykładu i pełne ustawienia

Najpierw zbuduj aplikację według windows-start. W PowerShell pozostań w jej
katalogu. Poniższy przykład tworzy **nową** kopię Java; nie nadpisuje źródeł
ani istniejących danych. Dla Spring zmień tylko `$example` na `spring-counter`.

```powershell
$ErrorActionPreference = 'Stop'
$app = (Resolve-Path '.').Path
$example = 'java-pattern'
$profile = 'java-maven-21'
$base = Join-Path $env:LOCALAPPDATA ('PairCoachLightweight\' + [guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $base) { throw 'Katalog istnieje: zachowaj jego dane' }
New-Item -ItemType Directory -Path $base | Out-Null
$base = (Resolve-Path -LiteralPath $base).Path
$project = Join-Path $base $example
Copy-Item -LiteralPath (Join-Path $app ('examples\' + $example)) -Destination $project -Recurse
$settingsDir = Join-Path $project '.paircoach'
$settingsFile = Join-Path $settingsDir 'settings.json'
if (Test-Path -LiteralPath $settingsDir) { throw 'Istniejace dane: nie nadpisuj ustawien' }
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
[IO.File]::WriteAllText($settingsFile, ($settings | ConvertTo-Json -Depth 20), $utf8)
Remove-Item Env:PAIRCOACH_RUNTIME_PROFILE -ErrorAction SilentlyContinue
Remove-Item Env:PAIRCOACH_WORKSPACE_DIR -ErrorAction SilentlyContinue
Remove-Item Env:PAIRCOACH_DATA_DIR -ErrorAction SilentlyContinue
```

Dla nowej kopii Java powyższy zapis tworzy następujące pełne ustawienia (nie sam fragment task):

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
        "entry": {
          "kind": "JAVA_MAIN",
          "className": "demo.StrategyDemo"
        },
        "tests": {
          "paths": [],
          "names": [
            "demo.StrategyDemoTest"
          ]
        }
      }
    },
    {
      "kind": "RUN_TESTS",
      "timeoutMs": 120000,
      "task": {
        "workingDirectory": ".",
        "entry": {
          "kind": "JAVA_MAIN",
          "className": "demo.StrategyDemo"
        },
        "tests": {
          "paths": [],
          "names": [
            "demo.StrategyDemoTest"
          ]
        }
      }
    }
  ]
}
```

Prepare czyta **`<projekt>/.paircoach/settings.json`**, nie samo `task.v2.json`.
Powyższe pełne SettingsV2 są tylko dla nowej kopii. W istniejącym projekcie użyj
jawnego zapisu/migracji w ustawieniach GUI: zachowaj pozostałe dane, zgodę,
kontekst i drafty. Nie zastępuj settings samym `runProfiles` ani całym task.
Przykłady mają osobne RUN_MAIN/RUN_TESTS, wspólne `workingDirectory: "."`
i timeout programu120000ms. Inny projekt wymaga własnej klasy/skryptu i testów.
CLI odrzuca fragmenty/legacy settings, niestandardowy dataDir oraz różne
workingDirectory Main/Tests, zamiast zgadywać lub przenosić dane.

## 3. Publiczne przygotowanie wybranego środowiska

Z katalogu aplikacji, z ustawionymi wyżej `$project`, `$profile`, `$base`:

```powershell
# Opcjonalny odczyt planu: nie przygotowuje ani nie zapisuje katalogu planu.
$planOut = Join-Path $base 'plan'
npm.cmd run runtime:prepare -- --project $project --profile $profile --output $planOut
if ($LASTEXITCODE -ne 0) { throw 'Plan FAIL: odczytaj blad; nie zmieniaj POM dla nowszego JDK' }
# Zwykle jawne prepare uzytkownika: pobieranie/budowanie moze wymagac internetu.
$executeOut = Join-Path $base 'prepared'
$prepareLog = Join-Path $base 'prepare.log'
npm.cmd run runtime:prepare -- --project $project --profile $profile --output $executeOut --prepare-timeout-ms 3600000 --execute 2> $prepareLog
if ($LASTEXITCODE -ne 0) { throw 'Prepare nieukonczone: zachowaj output i odczytaj log' }
```

W WSL odpowiednikiem jest:

```bash
prepareLog="$base/prepare.log"
npm run runtime:prepare -- --project "$project" --profile "$profile" --output "$executeOut" --prepare-timeout-ms 3600000 --execute 2> "$prepareLog"
```

Zmienne WSL mają być absolutnymi ścieżkami WSL; istniejący prywatny rodzic outputu
musi mieć uprawnienia0700 (`umask 077` przed tworzeniem własnego katalogu).
Output ma być NOWY i poza aplikacją/projektem. Plan i execute to osobne działania;
wynik `PLAN_ONLY` nie stanowi zgody ROOT ani receipt do ręcznego wypełnienia.

**Timeout przygotowania:** opcjonalny `--prepare-timeout-ms` przyjmuje jedną
liczbę całkowitą1000..86400000ms; domyślnie2700000ms (45min). Powyżej jawnie
wybrano3600000ms (1h) dla prepare. To nie zmienia wybranego `runProfiles[].timeoutMs` programu ucznia,
autosave ani weta. Limit pojedynczej komendy Docker pozostaje480000ms (8min);
wybrana godzina jest budżetem całego prepare, nie pojedynczej komendy.
Bez `--execute` pozostaje `PLAN_ONLY`: bez procesów potomnych,
pobierania i zapisów, również z podanym timeoutem.

**Log:** postęp prepare i wyjście aktywnej komendy Docker trafiają na stderr na
bieżąco; pokazane `2>` zapisuje je w `$prepareLog`. W drugim terminalu odczytuj
`Get-Content -LiteralPath $prepareLog -Wait` (PowerShell) lub `tail -f "$prepareLog"`
(WSL, z ustawioną tą samą ścieżką). Aby widzieć postęp w pierwszym terminalu,
pomiń przekierowanie. JSON wyniku CLI pozostaje na stdout; wrapper npm może tam
również wypisać własny nagłówek, więc nie parsuj całego wyjścia npm jako JSON.
Nie nadpisuj logu wcześniejszej próby; zachowaj go wraz z outputem.

**Przerwanie:** Ctrl+C (SIGINT), a w WSL także SIGTERM własnego procesu prepare,
zleca anulowanie pobierania i aktywnego Docker CLI. Poczekaj na zakończenie i
odczytaj log/receipts; samo zabicie CLI nie dowodzi wycofania operacji daemona.
Zatrzymanie kontenera cache jest dopuszczane tylko po odczycie jego dokładnego
owned ID, engine, obrazu, labels i mountów; zasoby pozostają zachowane, bez `rm`.
Jeśli wynik lub tożsamość są nieznane, nie zatrzymuj kontenera po samej nazwie.
Po dokładnym komunikacie `Cancellation window closed; publishing measured runtime config`
okno anulowania jest już zamknięte. Samo `phase=publish` nie zamyka tego okna. Poczekaj na wynik
publikacji konfiguracji, zamiast ponawiać prepare. Status
`CANCELLED_RETAIN_AND_RECONCILE` wymaga odczytu istniejącego wyniku i zasobów.
Przerwanie nie daje automatycznej ponownej próby ani READY. Natywne Windows
Ctrl+C oraz rzeczywisty Docker wymagają osobnego dowodu; odczyt kodu i test
transportu go nie zastępują.

Oczekiwany wynik wykonania to `PREPARED_CONFIG_GENERATED_NOT_ACCEPTANCE`,
nie końcowe READY. `NOTREADY`, błąd albo przerwanie nie dowodzą braku skutków:
zachowaj katalog i log, odczytaj wynik tej operacji przed kolejnym zapisem.
Nie usuwaj receiptów, nie dopisuj imageId/digestów i nie uruchamiaj ponownie
w tym samym output. Nowa próba ma wynikać z usunięcia przyczyny/nowych danych,
nie z resetu historii. Nie potrzeba ręcznych receiptów ROOT, okresowego odnawiania
zgody, recovery902 ani operator-only remainder.

Udane prepare tworzy pod `$executeOut`:
- `runtime-config.json` — config rzeczywistego projektu;
- `catalog.json` — wybrany profil;
- `images.lock.json` — rzeczywiste tożsamości obrazów i narzędzi;
- `jobs/<profile>/receipt.json` oraz cache — zachowaj cały wynik.

Wersje narzędzi pochodzą z uruchomionych binarek przez `runtime-tools.mjs`
wewnątrz obrazu, nie z tagu/metadanych. Dla Java rozróżniaj wynik java/javac
od targetRelease z Maven/effective-POM. Nie uruchamiaj sondy na hostowym JDK.
Przy zmianie POM, requirements, package/lock lub konfiguracji zależności wykonaj
nowe prepare; zwykła edycja kodu nie wymaga ponownego pobierania zależności.
Run/Test używa lokalnego przypiętego obrazu (`pull=never`) i cache, bez hostowego
fallbacku, pobierania w Run ani montowania home, prywatnego `.m2` czy docker.sock.
Prepare nie przygotowuje JDT/pylsp, obrazów LSP ani receipt LANGUAGE.

### Budżety gotowości, kompilacji/testów i startu Spring

To trzy różne działania, nie jeden limit120s:

- **Gotowość runtime:** w pliku przekazywanym do `--runtime-config` (po prepare:
  `$executeOut/runtime-config.json`) opcjonalne `execution.readinessTimeoutMs`
  określa budżet pomiaru execution i każdego z dwóch pomiarów zależności trybu.
  Bez pola:30000ms; dopuszczalne całkowite1000..120000ms. Etapy są sekwencyjne,
  więc cały pomiar obu trybów może trwać do trzech takich budżetów. To nie limit
  działania programu. Zachowaj pozostałe pola; przed restartem własnego serwera
  można ustawić np. taki fragment istniejącego config:

  ```json
  "execution": { "backend": "docker", "pullPolicy": "never", "readinessTimeoutMs": 45000 }
  ```

  Nie edytuj receiptów/cache/pinów i nie ponawiaj prepare dla samej zmiany tego
  budżetu. Podczas pomiaru edytor, zapis/ACK i weto pozostają niezależne; brak
  wyniku nie uprawnia do Run. `RUNTIME_READINESS_TIMEOUT` oznacza przekroczony
  budżet, `RUNTIME_READINESS_UNAVAILABLE` błąd pomiaru, a
  `RUNTIME_READINESS_INVALID` nieaktualny/błędny dowód — żaden z nich nie dowodzi
  wyłączenia demona. `DAEMON_UNAVAILABLE` pochodzi z jawnego nieudanego sprawdzenia
  engine, nie z timeoutu całego łańcucha. Napraw przyczynę lub skoryguj budżet,
  a potem zmierz bieżącą gotowość; nigdy nie wymuszaj Run z błędem.
- **Kompilacja/testy/program:** `timeoutMs` w osobnym profilu RUN_MAIN/RUN_TESTS
  ustawień GUI jest już konfigurowalne1000..3600000ms.120000 w przykładach to
  wybór dla przykładu, nie sztywny limit produktu. Dla wolniejszej kompilacji
  ustaw np.900000 (15min), maksymalnie3600000 (1h), jawnie zapisz ustawienia i zaczekaj na ich
  potwierdzenie przed Run. Ten sam budżet przechodzi przez adapter i plan do
  wykonawcy; po wyczerpaniu zlecany jest prawdziwy Stop, nie pozorny sukces.
- **Spring Main:** oczekiwanie na HTTP ma teraz budżet tego samego jawnie
  wybranego `RUN_MAIN.timeoutMs`, bez wcześniejszego sztywnego30s. Nie wydłuża
  globalnego czasu Run. Nowy przykład Spring ma900000ms (15min), a maksymalny
  jawny budżet wynosi3600000ms (1h). Istniejące120000ms w prywatnym projekcie
  pozostaje bez automigracji; zmień je jawnie w ustawieniach, jeżeli potrzebujesz
  dłuższego uruchomienia. Gotowy endpoint nie kończy Main; serwer pozostaje
  RUNNING do Stop/wyjścia. Ręczny Stop i niepotwierdzony Stop zachowują znaczenie.

Prepare ma nadal swój osobny `--prepare-timeout-ms`. Limity pojedynczych operacji
Docker, zasobów i sond HTTP nie stają się budżetem kompilacji; nie zmieniaj weta,
autosave, prawa zapisu ani ACK, aby przedłużyć wykonanie.

## 4. Start i zmiana profilu

Po potwierdzonym wygenerowaniu konfiguracji, w tym samym PowerShell:

```powershell
$runtimeConfig = (Resolve-Path -LiteralPath (Join-Path $executeOut 'runtime-config.json')).Path
$preparedRoot = (Resolve-Path -LiteralPath (Join-Path (Join-Path $executeOut 'jobs') $profile)).Path
npm.cmd start -- --runtime-config $runtimeConfig --prepared-runtime $preparedRoot
```

W WSL:

```bash
npm start -- --runtime-config "$executeOut/runtime-config.json" --prepared-runtime "$executeOut/jobs/$profile"
```

Pozostaw serwer uruchomiony i otwórz wypisany adres loopback (standardowo8080).
Nie zatrzymuj innej usługi zajmującej port; nie ma publicznej flagi `--port`.
Nie używaj mock/preview zamiast LIVE. Publiczny start używa danych
`<projekt>/.paircoach`; nie ustawiaj alternatywnego dataDir. Token obsługuje
istniejący klient aplikacji — nie kopiuj go do logów lub poleceń.

`--prepared-runtime` wskazuje **rodzica receipt**, czyli `jobs/<profile>`, nie
cały output. Flagi i wartości są oddzielne; ścieżki absolutne, kanoniczne,
bez przecinków. Dla rzeczywiście innych rozłącznych przygotowań dopuszczalne
jest powtórzenie `--prepared-runtime` (maks16). Nie ma flag installationId,
engine ani network. Błędny config daje CONFIG_ERROR, nie automatyczny prepare.

Aby przejść Java21→Java27, zatrzymaj własny serwer po zakończeniu/Stop Run,
wykonaj prepare z `--profile java-maven-27` do NOWEGO outputu i wystartuj z jego
nowym config oraz `jobs/java-maven-27`. Nie zmieniaj POM ani samego activeProfile
w wygenerowanym jednoprofilowym katalogu: brakującego profilu tam nie ma.

Pierwszy binding sam utrwala installationId/layout w danych projektu i stan
wykonania poza źródłami (`.paircoach-runtime` obok runtime config). Zachowaj
`runtime-execution-layout.json`, installation i journal przy restarcie;
nie wybieraj UUID, nie przenoś cache/danych między projektami i nie kasuj stanu,
aby ominąć konflikt. Konflikt własności wymaga odczytu/recovery, nie resetu.

## 5. GUI: Java21, potem Spring21

1. W **LIVE — lokalny backend** otwórz ten sam przygotowany projekt.
   Sprawdź profil i osobno dostępność **Uruchom program** oraz **Uruchom testy**
   w panelu **Środowisko**. Sam config, receipt, exit0 lub runtime READY nie
   zastępuje gotowości danego trybu. Brak Docker/obrazu/prepare nie blokuje
   ręcznej edycji, zapisu ani odzyskiwania draftu.
2. **Run Tests**: przykłady celowo odejmują zamiast dodawać, więc oczekiwany jest
   FAILED. Zmień logikę w kodzie, nie test. Zaczekaj na ACK i ponów Tests:
   oczekuj PASSED z rzeczywistym raportem bieżącego runId i testCount>0.
   Brak raportu to UNKNOWN, zero testów to NO_TESTS, same skipped nie dają PASS.
3. **Run Main** ma pokazać wynik zmienionego kodu. W Spring przed Main rozwiń
   **Środowisko → Środowisko wykonania → Przygotuj środowisko**. To jawne
   przygotowanie internal bridge tej instalacji, nie build obrazu. Nie wykonuj
   ręcznego `docker network create` ani POST. Po potwierdzeniu sprawdź świeżą
   gotowość Main i Tests; PREPARED nie oznacza automatycznie gotowości obu.
4. Spring: czekaj na rzeczywisty HTTP `/sum` pod pokazanym loopback portem.
   Odpowiedź nie kończy działającego Main. Kliknij **Stop**: oczekuj potwierdzenia
   zatrzymania właściwego kontenera i niedostępnego endpointu, nie tylko zmiany UI.
5. Przy niepotwierdzonym przygotowaniu sieci zachowaj tę kartę i jej storage.
   **Dokończ przygotowanie** kontynuuje dokładny oryginał; nie zmieniaj requestId,
   clientId ani tożsamości instalacji i nie czyść magazynu. Nieznany Run/zapis
   odczytuj przez **Sprawdź wynik operacji**; to inna operacja niż przygotowanie
   sieci. Nie traktuj nieznanego Stop jako zakończonego.

Każdy profil ma `language.provider: "builtin"`, `imageLockKey: null`,
`serverJvm: null`. `builtin` nie oznacza automatycznie ON ani gotowości Docker:
status lokalnych funkcji ma odpowiadać faktycznemu providerowi/workerowi.
- Java/Python: Ctrl+Space podpowiada słowa z **bieżącego bufora** po prefiksie,
  bez czekania na ACK, bez metod po kropce i bez semantycznej analizy projektu.
  Diagnostyka podczas pisania jest N/A również przy `diagnostics: true`;
  błędy kompilacji/testów są w Konsoli po Run/Test.
- JS/TS: lokalny worker; rzeczywisty TypeScript kompiluje się dopiero przy Run/Test.
- `languageFeatures.completion: false` wyłącza podpowiedzi;
  `diagnostics: false` wyłącza lokalną diagnostykę JS/TS. Błąd workera nie może
  blokować ręcznego pisania. Zapis/ACK/Run/trener nie wymagają wiadomości LANGUAGE.
- Akceptacja podpowiedzi to zwykła edycja przez WriteGate, ACK i Undo/Redo.
  CONTROL_PREPARE zamyka listę; Enter/Tab nie może wtedy zmienić bufora.
  Weto2×Esc i ochrona plików ucznia pozostają aktywne.

## 6. Paczka, dowody i powrót do poprzedniej instalacji

K wiąże paczkę z dokładnym40SHA, packageId i SHA256 archiwum/manifestu.
Weryfikację i świeżą instalację wykonuj według windows-package/windows-start,
z niezależnie przekazanym zaufanym hashem manifestu. Nie wystarczy hash leżący
obok nieznanego ZIP. Źródłowy ZIP nie zawiera sekretów, node_modules, obrazów,
cache, raw receipts ani danych `.paircoach`. Świeża instalacja ma własne zależności
natywne i własne publiczne prepare; nie kopiuj dowodów gotowości ze starej.

Build, prepare, start, zdrowy proces i działający scenariusz GUI to osobne wyniki.
Pełny odbiór wymaga siedmiu profili, Spring21/27, działających funkcji chronionych,
regresji oraz pełnego scenariusza ze świeżego ZIP. Test komponentowy lub plan
tego nie zastępuje. WSL z GUI Windows nie dowodzi native Windows/PowerShell;
raport rozróżnia te środowiska i podaje rzeczywiste ograniczenia.

Nową wersję sprawdzaj na osobnej instalacji i kopii zadania. W razie problemu
zatrzymaj tylko własny serwer i potwierdź Stop jego Run; zachowaj nowe logi/dane.
Poprzednia instalacja zostaje nietknięta. Nie kieruj starego programu na nowe dane,
nie nadpisuj źródeł właściciela i nie stosuj globalnego prune/resetu historii.
