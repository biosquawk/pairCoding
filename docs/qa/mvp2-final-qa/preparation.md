# MVP2 — niezależne przygotowanie QA, nie odbiór

P3, work `paircoach-mvp2-final-qa`, execution `ca7c9b81-7583-45b1-9685-79b5359b8846`.
Baza K: **55baa0556cc7cc683c794365a7980aff4b04377f**, release/mvp2-recovery.
To odrębna kopia źródeł, nie MAIN/MVP1/live8080. HUMAN dae99189 wznowił pełne MVP2;
HUMAN f36d5244 zachowuje produkcyjny limit 5 s i rozdziela dowód transportu od GUI.

## Faktyczne wykonanie na tej bazie

WSL2 Linux 6.6.87.2 x64, uid1000, Node22.22.2, npm10.9.7.
Toolchain: SharedDesk/worktrees/_toolchains/node-v22.22.2/bin.
TMPDIR: własne artifacts/g3/tmp; npm cache: własny katalog dostawy/npm-cache.

| Komenda | Exit | Wynik |
|---|---:|---|
| npm ci --include=dev --no-audit --no-fund (lokalny npm_config_cache) |0|235 pakietów; PASS instalacji WSL, nie Windows|
| node --import tsx --test tests/qa/g3/controls.test.ts |0|6 PASS, 0 FAIL/skip/cancel; tylko harness/fixture|
| node node_modules/playwright/cli.js test --config tests/qa/g3.config.ts --list |0|19 cases / 2 files; discovery, NIE browser PASS|
| node --import tsx tests/qa/g3/capability-probe.ts |0|real HELLO/REST: start200, brak profilu409 RUN_PROFILE_MISSING, finish202 PENDING, snapshot READY; CAPABILITIES_PRESENT_NOT_ACCEPTANCE_PASS|
| npm run typecheck |0|tsc --noEmit PASS|
| npm run build |0|Vite PASS, warning dużych chunków/timing nie ukryty|
| node node_modules/playwright/cli.js test --config tests/qa/metrics.config.ts --list --grep 'AC-027 TEST-027:' |0|dokładnie 1 kampania, bez powtórki AC011 controls|
| import rzeczywistego tests/qa/metrics.config.ts przez node --import tsx |0|1 webServer, absolutne cwd, reference=1, workers1/retries0/180000ms|

Kontrole ujemne obejmują missing/unrelated/stale/failed ACK, zabronione payloady,
rzeczywisty failing child oraz OS odmowę nowego backup-directory bez usuwania starych bajtów;
wejścia GUI rozróżniają inclusive 1MiB/1MiB+1 oraz binarne octety.
Żaden z tych PASS nie dowodzi Windows ACL, browsera, crash/recovery ani 27AC.

**NOT_RUN**: wszystkie19 GUI, pełne100 AC027, P2 trzy nowe przypadki GUI, finalny ZIP.
Flaky: nie stwierdzono w wykonanych sześciu kontrolach; browser flaky NIEOCENIONE.
Nie uruchamiano ponownie odebranych G1/G2/29 ani native608 21+3.

## Odczyt QA kontra produkt

Zachowane 19 testów są scalone z cecdee0. Core nadal ma synchroniczne
createSnapshot/readSnapshot dla seed/readback i osobne createSnapshotAsync;
restore jest Promise i istniejący QA czeka na rzeczywisty terminalny ACK przez Wire.
Nie ma dowodu potrzeby zmiany asercji na tej bazie. Publiczne etykiety GUI profili,
folderu i snapshotu odpowiadają odczytanemu kodowi; to kontrola statyczna, nie GUI PASS.
ReportGenerate to jawny AI-only seam; Runner, ReportService, pliki, WriteGate i REST/WS
pozostają prawdziwe. TEST021 nie dowodzi jakości naturalnojęzykowej recenzji modelu.

AC027 zachowuje wszystkie100, ownerWasCoach, p95/max i ścisłe max<100/50/200/200ms;
AI-generation osobno. Legalny konflikt AC011: porównanie obu wersji, jawny KEEP_LOCAL,
nowy CODE_CHANGED i dokładnie skorelowany ACK po decyzji. Bez resetowania prób/timerów.

## Instrukcja jako odbiorca bez czatu

Stare g3-public-qa instrukcje wskazują historyczny brak zintegrowanego produktu;
nie są już bieżącym requestem. Nowa instrukcja obok rozdziela: przygotowanie na55baa,
warunek finalQAsha od K, jeden archive, jedna sesja, P3→P2→AC027, osobne wyniki.
Nie stosować windows-browser.ps1, ponieważ uruchamia stare smoke.
Metryki dostają osobny port18083, nie live8080. Discovery grep nie może być zakotwiczony
`^AC-027`: Playwright dopasowuje również nazwę pliku, więc taki filtr nie znajduje testu.

Nie ma jeszcze FINALNEGO SHA z P6patch/P2cases. Wysłanie runnable requestu ROOT jest
wstrzymane do dokładnego wejścia K; przygotowanie dokumentów i kontroli nie było zablokowane.
Finalna paczka użytkowa wymaga osobnego odczytu P4/K i native ZIP smoke. Obecne docs/windows*
opisują MVP1 preview i nie mogą świadczyć o kompletnej instrukcji recovery MVP2.

## Zachowane błędy przygotowania, nie awarie produktu

- Próba worktree została odrzucona przez zapis w K .git; zastosowano własny clone --no-hardlinks.
- Pierwsze npm ci exit254: niedostępny /home/darulec/.npm; sukces dopiero z własnym cache.
- Pierwszy metrics discovery exit1: błędny filtr ^AC-027; drugi exit1: brak TMPDIR w nowej powłoce.
  Zachowano logi; poprawna komenda+TMPDIR dała 1 discovery. Nie zmieniono suite/discovery config.
- Hipoteza o podwójnym separatorze konta icacls została WYCOFANA: pomylono JSON escaping
  z surowym kodem. Raw codepoint count=2 w TS, runtime separator=1 jest poprawny.
  Precondition przerwał próbę patcha przed zapisem. Ponowny harness6 pozostał PASS.

Wszystkie131 plików bazy były byte-identical po kontrolach. W tej dostawie zmieniają się
wyłącznie dokumenty QA. P6 helpers.ts i testpatch oraz P2 scenariusze/config pozostają ich własnością.

## Aktualizacja K po kontrolach (bez ponawiania prep)

K491e2313 wycofał warunkową zgodę formatterpatch; źródła QA pozostają bez zmian.
Odrębny rzeczywisty finding P5 finish-network-loss na55baa/bd: po admission socketdestroy
klient pokazał fetchfailed/2POST mimo1snapshot. P2 dostał naprawę w swoim istniejącym zakresie.
P3 nie odtwarza teraz tej kampanii ani nie naprawia produktu. Jest to blocker frozenQAsha,
nie utrata wyników sześciu controls/discovery/capability. Przed native K rozlicza poprawkę
P2 i drugi2-hunk fixturepatch P6. Żaden wynik55baa nie udaje sukcesu po tych zmianach.
