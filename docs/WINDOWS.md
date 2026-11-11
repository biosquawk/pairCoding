# PairCoach v3 — Windows, uruchomienie i dowody

> **ETAP8: IMPLEMENTED / PENDING_FINAL_QA** (kolejka 4→9). To opis bieżącego
> kandydata, nie odbiór kampanii ani wydanie. Native Windows/PowerShell, świeża
> paczka wydania, realny model i pełne QA pozostają do wykonania po implementacji9.
> ETAP9 Docker/polyglot nie jest jeszcze zaimplementowany.

## Zakres i bezpieczeństwo

Docelowo Windows + Node >=22.22 (operator potwierdził Windows Node25.6.1 x64).
Bieżąca implementacja nie wymaga kontenerów ani zewnętrznej bazy; ETAP9 ma osobny przyszły kontrakt. Node/Python/Java w otwieranym zadaniu
są opcjonalne: brak narzędzia nie blokuje edytora. Wybór `PAIRCOACH_COACH_PROVIDER=codex` obsługuje trenera i raport przez lokalne
`codex exec --ephemeral`, model `gpt-6.1-sol`, effort `medium`, własne logowanie
ChatGPT, bez dodatkowego klucza lub URL API. ComputerUse jawnie wyłączone;
nie wykonujemy narzędzi modelu/interakcji z komputerem. Dostępność modelu zależy
od konta. Gemini pozostaje opcją wymagającą klucza **tylko po stronie backendu**.
Bez generatora/zgody raport używa jawnego lokalnego podsumowania faktów, nie udaje AI.
Błąd wybranego dostawcy to FAILED, nie cichy fallback. Pełny start: [windows-start.md](windows-start.md).

Nie wystawiaj serwera publicznie. Do pilota użyj **kopii** ćwiczenia, nie jedynej
kopii ważnego repo. Uruchomione profile są zaufanym kodem z prawami użytkownika,
nie sandboxem dla złośliwych programów. Nie uruchamiaj Thalamusa ani dodatkowych
usług. Nie używaj portów 8765–8768. Historyczne bramki 001→002→003 nie zastępują bieżącej kolejki4→9 i końcowego QA.
Same moduły Runner/ReportService nie włączają autonomii ani nie dowodzą odbioru.

## Instalacja kompletnego kandydata

Poniższe kroki dotyczą **zintegrowanej** paczki K, zawierającej src/server/index.ts,
package-lock.json, moduły P1/P2/P6 oraz frontend. Dostawa samych modułów P4 nie jest
samodzielnym produktem. ZIP rozpakuj do nowego katalogu, np. `C:\PairCoach\v3`.
W PowerShell (zwykłe konto, bez uruchamiania jako Administrator):

```powershell
Set-Location 'C:\PairCoach\v3'
node --version
npm.cmd ci --no-audit --no-fund
npm.cmd run typecheck
npm.cmd run build
npm.cmd run server
```

Backend ma działać na `127.0.0.1:8080` i serwować produkcyjny frontend po buildzie.
Otwórz `http://127.0.0.1:8080`. Start nie może zastępować LIVE symulatorem.
W dev `npm.cmd run dev:full` uruchamia backend i frontend loopback:3000; MOCK tylko
jawnie przez `?mock=1`. Nie umieszczaj tokenu ani klucza w komendzie, query string,
logu lub zgłoszeniu. Bootstrap/token i Host/Origin obsługuje integracja K.
Nie używaj `.env` w paczce; aplikacja czyta klucz Gemini ze środowiska backendu.
Nie kopiuj prawdziwego klucza do źródeł, testów ani raportu.

Dla własnego folderu ćwiczenia wybierz jego **kopię** w ustawieniach aplikacji
lub ustaw `PAIRCOACH_WORKSPACE_DIR` w terminalu backendu przed startem. Nie podawaj
systemowego katalogu ani innego projektu Thalamusa. Zmiana konfiguracji nie daje
trenerowi dostępu do systemu: mutacje nadal przechodzą WriteGate.

## Profile Run i wyniki testów

Użytkownik zatwierdza maksymalnie dwa profile w Settings: `RUN_MAIN`, `RUN_TESTS`.
`executable` i `args` są osobne; Runner wywołuje `spawn(...,{shell:false})`.
Na Windows pliki `.cmd`/`.bat` nie są bezpośrednim executable dla tego trybu.
Wybierz rzeczywisty `node.exe`, `python.exe`, `java.exe` itd. i skrypt w `args`.
Nie dodajemy automatycznie `cmd.exe /c`, poleceń AI ani instalacji zależności.
`cwd` musi należeć do otwartego projektu (bez dowiązań/junctions).
Timeout: 1000–300000 ms. Jedno aktywne uruchomienie, brak automatycznego finish.

Przykład zatwierdzanego profilu Node (ścieżkę narzędzia ustala użytkownik):

```json
{
  "kind": "RUN_TESTS",
  "executable": "C:\\Program Files\\nodejs\\node.exe",
  "args": ["--test", "--test-reporter=junit", "--test-reporter-destination=results-{runId}.xml", "test.js"],
  "cwd": ".",
  "timeoutMs": 30000,
  "testReportFormat": "JUNIT_XML",
  "testReportGlob": "results-{runId}.xml"
}
```

`{runId}` w args i testReportGlob podstawia wyłącznie Runner, a proces dostaje
`PAIRCOACH_RUN_ID`. Wzorzec raportów jest względny POSIX w cwd. Zatwierdzony
profil musi odpowiadać dokładnie obiektowi Settings; K wywołuje
`runner.setApprovedProfiles(settings.runProfiles)` (default deny).

Runner robi pre-run inventory i rozpoznaje tylko świeże zmienione raporty
należące do tego sekwencyjnego uruchomienia; nie usuwa starego raportu, by uzyskać
pozorną świeżość. JUnit musi być poprawnym XML bez DTD/ENTITY, z licznikami zgodnymi
z faktycznymi testcase. Celowo ostrożny parser może zwrócić UNKNOWN dla innego
dialektu — to nie PASSED. Limit raportu 4 MiB, maksymalnie 128 plików i ograniczony
skan. Liczba testów >0 + świeży rozpoznany raport + exit0 są wymagane do PASSED.
Brak raportu/format NONE/niezgodne XML → UNKNOWN; zero testów → NO_TESTS;
failure/error → FAILED. Same logi „passed” i exit0 nie są dowodem testów.
Pełne fakty Run dotyczą wersji przy starcie; `workspaceChangedDuringRun=true`
oznacza, że nie dowodzą sprawdzenia aktualnego kodu. Końcówka stdout/stderr jest
ograniczona do 65536 znaków; RUN_OUTPUT ma rosnący outputSeq.

Stop/timeout używają na Windows wyłącznie systemowego
`taskkill.exe /PID <należący_PID> /T /F`, bez poleceń po nazwie procesu. Brak
potwierdzenia zatrzymania to PROCESS_TREE_STOP_FAILED, nie pozorny sukces.
Na Linux testy używają osobnej grupy procesów, SIGKILL. To **nie jest dowód Windows**.
Programy celowo uciekające z drzewa/zabijające własnego rodzica nie są bezpiecznym
materiałem treningowym; do takiego nieufnego kodu potrzebny jest osobny sandbox.

## Raport i odzyskanie

Integracja finish musi najpierw odebrać kontrolę, zatrzymać Run, utworzyć końcowy
Snapshot i ustawić FINISHED. Dopiero potem ReportService zapisuje niezmienne
fakty z hashem i status PENDING. Materiał przechowywany w `dataDir/reports/`,
poza widocznym drzewem zadania; późniejsze zmiany nie zmieniają oceny.
Provider asynchroniczny ma osobny dokładny REPORT_SYSTEM_PROMPT z pliku1 §6.2,
timeout30s i max800 słów. K przekazuje generator z filtracją sekretów, tylko gdy
utrwalone `facts.aiConsent===true`. Bez generatora/zgody powstaje jawny raport
lokalnych faktów. Błąd providera → FAILED (bez raw error/sekretów), Ponów korzysta
z identycznych faktów. Restart przy PENDING → FAILED/REPORT_INTERRUPTED, wymaga
jawnego Ponów. Nie jest to automatyczna ponowna ocena później zmienionych plików.

Dziennik interwencji przekazuj w `facts.events`: COACH_STEP_EDIT z path i
interventionId oraz jawne zdarzenia VETO_EXECUTED. Liczby raportu lokalnego
opisują wyłącznie utrwalony dziennik; brak wpisów nie dowodzi samodzielności.
Dla pełnej atrybucji zachowaj zakresy kroków w immutable facts.

## Skrypt odbiorowy dla operatora ROOT

**P4 nie wykonał poleceń Windows poza swoim sandboxem.** ROOT uruchamia po
integracji kandydata, bez podwyższania praw, w nowym procesie PowerShell:

```powershell
powershell.exe -NoProfile -File 'C:\PairCoach\v3\scripts\windows-verify.ps1' `
  -Source 'C:\PairCoach\v3' -Revision '<40-znakowy-commit-kandydata-K>'
```

`-Source` musi być rzeczywistym korzeniem czystego checkoutu Git, a `-Revision`
pełnym SHA równym **rzeczywistemu HEAD**. Podrepo/paczka w obcym repo nie dziedziczy
jego tożsamości. Brak Git/zaufania, wrongSHA lub dirty source kończy się przed npm.
Helper z zaufanego katalogu operatora porównuje źródłowe bajty z blobami Git;
dopuszcza wyłącznie różnicę LF/CRLF w poprawnym UTF-8 bez NUL, nie lone CR ani
zmianę treści. Kopia zachowuje i weryfikuje **dokładne** bajty checkoutu.

Dla rozpakowanego ZIP bez Git obowiązkowe są dwa dodatkowe parametry:

```powershell
# Skrypt/helper z wcześniej zweryfikowanego katalogu operatora, nie niezaufanej paczki.
powershell.exe -NoProfile -File 'C:\PairCoach\trusted-tools\windows-verify.ps1' `
  -Source 'C:\PairCoach\unpacked\paircoach-v3-mvp2-<40SHA>' -Revision '<40SHA-od-K>' `
  -TrustedManifest 'C:\PairCoach\trusted-inputs\manifest.json' `
  -ManifestSha256 '<64-male-hex-z-niezaleznego-zaufanego-kanalu-K>'
```

Manifest musi leżeć **poza Source**. Hash uzyskaj z zaufanego kanału K/operatora,
nie z samego sąsiedniego `SHA256SUMS`. Pole sourceCommit ani nazwa ZIP nie są
zaufaniem. W tym trybie wymagane są dokładne długości/hashe, kompletny zestaw
wymaganych źródeł i bezpieczne ścieżki bez symlink/reparse/duplikatów. Helper nie
instaluje niczego, nie chroni przed administratorem kontrolującym host/verifier.
Git-less actualRevision oznacza sourceCommit poświadczony przez zaufany manifest, nie
niezależny odczyt Git ani weryfikację podpisu commitu. Git tryb odrzuca cały dirty
checkout (również poza kopiowanym allowlist); ignorowane dodatkowe pliki z
allowlist też są odrzucane. Nie zmieniaj globalnego Git config ani limitów.

Skrypt tworzy unikalny `%TEMP%\paircoach-verify-<id>`, weryfikuje źródła i
rzeczywiste bajty skopiowanego `repo` **przed npm**. Kopiuje tylko skończony
allowlist pakietera, w tym config/docs/helper, bez .env/kluczy/.git/node_modules.
Mismatch = nonzero, npm NOT_RUN, nigdy Windows PASS. `source-verification.json`
przechowuje requestedRevision, actualRevision, trustMode, manifestDigest,
byteVerification i tożsamość każdego pliku. Przy błędzie sprawdź ten plik oraz
source-verification.log; brak pomiaru nie oznacza PASS. Nie zmieniaj źródła podczas próby.
Następnie kopia wykonuje npm ci (własny cache), tsc, build i tests/execution;
testy uruchamiają własne procesy i badają własne drzewa, bez globalnych kill.

Jeśli `tests/core/recovery.test.ts` istnieje, skrypt wykona również prawdziwy
zestaw snapshot/recovery P1; brak testu to **NOT_RUN**, exit2. Windows walidacja
nie zastępuje REST/WS ani przeglądarkowego E2E/AC027 przygotowywanego przez P3.
Skrypt zachowuje logi, results.json, environment.json i input-sha256.json w
wydrukowanym katalogu evidence. Exit0 = wszystkie obecne wymagane kontrole PASS;
exit1 = FAIL; exit2 = niepełny kandydat/NOT_RUN. Prześlij K ścieżki dowodów oraz
exit code, nie samo „działa”. W razie FAIL zachowaj kopię, logi i dokładny błąd,
nie uruchamiaj kilkukrotnie tych samych zapisów bez uzgodnienia stanu.

## Zatrzymanie i rollback

Przed aktualizacją zachowaj poprzedni ZIP/commit i hash, a po zatrzymaniu procesu
kopię lokalnego dataDir. Nie nadpisuj plików zadania. Najpierw Stop aktywnych
Run w UI, potem Ctrl+C w terminalu backendu. Uruchamiaj nową paczkę w oddzielnym
katalogu na kopii zadania; przy regresji zatrzymaj wyłącznie jej procesy i wróć
do poprzedniej paczki/kopii dataDir. Nie czyść snapshotów, raportów ani dziennika
recovery. `npm.cmd run clean` usuwa wyłącznie wygenerowany dist, nie dane/evidence.
P4 nie publikuje ani nie pushuje tej dostawy; końcowy odbiór i ZIP należą do K.
