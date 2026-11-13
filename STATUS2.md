# STATUS2 — FUCK-UP REPORT: PairCoach / Thalamus, noc 12–13.11.2026

> **Wynik: NIE DOWIEZIONO odebranego produktu. Wydanie NO-GO. Wszystkie 14 ról projektu zatrzymane i administracyjnie PAUSED.**
> To raport po zatrzymaniu, a nie plan automatycznego wznowienia. Kod i dowody zachowano. Nie uruchomiono nowych agentów ani nowej kampanii testowej w celu napisania raportu.

## 1. Co się nie udało i za co odpowiada operator

Właściciel oczekiwał zakończenia wielojęzycznego PairCoach Lightweight: jeden edytor, działający Trener AI, wykonanie w Dockerze, JS/TS/Python, Java 11/17/21/27 i Spring Boot 21/27. Po kolejnej nocy intensywnej pracy nadal brak odbioru zintegrowanej wersji. Ostatni przebieg Java 21 zatrzymał się po czerwonym teście i poprawce: GUI nie dopuściło następnego uruchomienia testów. Końcowe logi `npm test` zawierają **244 FAIL**. Nie wykonano końcowego odbioru świeżej paczki na Windows.

Były rzeczywiste poprawki i udane wycinki. Nie usprawiedliwiają one skali kosztu ani niespełnionej obietnicy terminu. **Operator ROOT nie utrzymał odpowiedniej relacji kosztu do działającego efektu użytkownika.** Zbyt wiele pracy przechodziło przez raporty, ponowne wiązanie wyników, weryfikację wersji i koordynację. Brakowało bieżącego, wiarygodnego rachunku kosztu konkretnego zadania i skutecznego ograniczenia wydatków przez operatora. Prognoza zakończenia w kilka godzin nie została dotrzymana; nie ma danych uzasadniających kolejną podobną obietnicę.

Nie ma podstaw, aby całość tłumaczyć awarią WSL, brakiem agentów albo jednym błędem SQLite. Hotfix Watchdoga był wcześniejszą, punktową naprawą. Nocne blokery obejmowały również rzeczywiste usterki aplikacji, rozbieżne fixtures i sposób prowadzenia pracy.

## 2. Okno pomiaru, źródła i granice rachunku

Główne okno to dokładnie **8 godzin przed STOP**:

- lokalnie: **13.11.2026 00:51:06,800 → 08:51:06,800 Europe/Warsaw**;
- UTC: **12.11.2026 23:51:06,800 → 13.11.2026 07:51:06,800**;
- odczyt metryk: lokalna baza projektu tylko do odczytu; `calls`, powiązania tur i zadań, zdarzenia oraz metadane liczników sesji ROOT;
- stan kodu produktu: **`257e90b838abec4e9b332385c71f1be8201fc013`**, tree **`72549aa8b933467426d448cf64df153f3b5297c0`**;
- okno obejmuje aktywność, nie wyłącznie pisanie kodu. Raportowanie, testowanie, sleep/recovery i koordynacja również zużywają tokeny.

**Potwierdzona wielkość to zużycie zaobserwowane w odpowiedziach dostawcy. Nie jest to faktura ani przelicznik tygodniowego limitu ChatGPT.** Informacja o wyczerpaniu całego tygodniowego limitu pochodzi od właściciela. Nie mam rejestru rozliczenia konta, aby niezależnie wyliczyć procent limitu, kwotę lub moment jego wyczerpania.

`cached input` jest częścią `input`; `reasoning` jest częścią `output`. Nie dodajemy ich drugi raz. Kod `ProviderEvents` odczytuje usage poszczególnych odpowiedzi SSE, a `CallLedger` rozlicza rezerwację raz. Nie stwierdzono, że te 479 mln wejścia Thalamusa są omyłkowym sumowaniem narastającego licznika całego wątku. ROOT ma osobny licznik; tam usunięto duplikaty i uzgodniono przyrost skumulowany z sumą unikalnych ostatnich usage.

Źródła do ponownego odczytu przez reviewerów:

- [Surowe agregaty, metoda i 16 podsumowań TAP](docs/audit/20261113-night/audit-summary.json).
- [Koszt per rola — CSV](docs/audit/20261113-night/token-usage-by-agent.csv).
- [81 powiązań rola–zadanie — CSV](docs/audit/20261113-night/token-usage-by-agent-task.csv).
- [76 rozłącznych grup rola + zestaw zadań — CSV](docs/audit/20261113-night/token-usage-work-groups.csv).
- [Lista czerwonych wpisów TAP — CSV](docs/audit/20261113-night/suite-failures.csv).
- [Inwentaryzacja bundle-before — JSON](docs/audit/20261113-night/bundle-backup-inventory.json).

Eksport nie zawiera bazy projektu, poświadczeń, tokenu kontrolnego, promptów ani pełnych transkrypcji modelu. Audyt sam nie wywoływał modelu produktu; bieżąca sesja operatora użyta do opracowania tego raportu jest aktywnością PO cutoff i nie jest doliczona do analizowanych ośmiu godzin.

## 3. Drzewo ról — rzeczywisty skład, odpowiedzialność i stan po STOP

```text
Właściciel — cel, zmiany zakresu i decyzja STOP
└── ROOT — operator hosta: zlecenia, nadzór i niezależny odbiór
    └── Thalamus / software_dev_2
        ├── K — kierownik i integrator                          [PAUSED]
        │   ├── P1 — backend / API / dane                       [PAUSED]
        │   ├── P1_2 — backend, instancja 2                      [PAUSED]
        │   ├── P1_3 — backend, instancja 3                      [PAUSED]
        │   ├── P1_4 — backend, instancja 4                      [PAUSED]
        │   ├── P2 — frontend / UX                              [PAUSED]
        │   ├── P2_2 — frontend, instancja 2                     [PAUSED]
        │   ├── P2_3 — frontend, instancja 3                     [PAUSED]
        │   ├── P2_4 — frontend, instancja 4                     [PAUSED; 0 prób w oknie]
        │   ├── P3 — QA / E2E                                   [PAUSED]
        │   ├── P4 — build / pakowanie / wdrożenia               [PAUSED]
        │   ├── P5 — bezpieczeństwo / code review                [PAUSED]
        │   └── P6 — architektura / wydajność                    [PAUSED]
        └── JUDGE — niezależny nadzór incydentów                 [PAUSED; 0 prób w oknie]
```

To **14 tożsamości ról**, w tym K i JUDGE; nie 14 programistów ani dowód 14 równoczesnych wywołań. Instancje `P1_2` i `P2_2` są odrębnymi rolami tego samego zespołu, a nie nową warstwą kierowników. Drzewo pokazuje odpowiedzialność i transport, nie pełny graf wszystkich wiadomości lub natywnych subprocessów.

Profile podstawowego zespołu miały `gpt-6.1-sol / high`; repliki dziedziczyły konfigurację. Model Trenera AI w testowanym PairCoach był osobny: `gpt-6.1-sol / medium`. Nie należy mylić ustawienia produktu z kosztem zespołu wytwórczego. W tym raporcie nie potwierdzam dodatkowej liczby natywnych podagentów, dla których brak osobnego rejestru kosztu.

**Operacyjnie zatrzymano:** 14 flag pauzy ustawionych na true, 0 tur `RUNNING`, 12 projektowych procesów Codex app-server zakończonych przez scoped SIGTERM oraz 44 pozostawione projektowe helpery sandbox/MCP. Końcowa kontrola nie znalazła procesów z cwd w `Desks` tego projektu. Własne backendy testowe zatrzymano; porty 18110/18120/18080 nie miały listenerów. Daemon Thalamusa na 8768 pozostał do odczytu stanu. Nie zatrzymywano innych projektów i chronionych usług.

0 wywołań przypisanych do JUDGE nie znaczy 0 incydentów: zarejestrowano 8 `JudgeIncidentOpened` i 8 `JudgeAnalysisFailed`. Nie ma potwierdzenia skutecznych osądów modelu JUDGE w tym oknie.

## 4. Ile tokenów zużyto

| Kanał | Próby / obserwacje | Input | w tym cached | Output | Znane input + output |
| --- | ---: | ---: | ---: | ---: | ---: |
| Role Thalamusa | 6 256 prób; 5 959 SETTLED; 297 UNKNOWN | 478 980 528 | 116 716 032 | 2 514 141 | 481 494 669 |
| ROOT, osobna sesja operatora | 750 unikalnych przyrostów usage | 207 995 769 | 204 855 552 | 543 010 | 208 538 779 |
| **Suma znana obu kanałów** | nie utożsamiać obserwacji ROOT z próbami proxy | **686 976 297** | **321 571 584** | **3 057 151** | **690 033 448** |

Znane niebuforowane wejście łącznie: **365 404 713**. Reasoning: Thalamus **524 578**, ROOT **275 359**, już zawarte w output. 297 prób UNKNOWN nie ma wiarygodnego usage; nie przypisuję im zera ani wymyślonej opłaty.

**Trzeci kanał kosztu: prawdziwy Coach w testach E2E.** Jego subprocessy Codex są poza rejestrem Thalamusa i osobną sesją ROOT. Audyty wrappera zachowują wywołanie, kontekst, odpowiedź i exit, lecz nie zachowują pełnego usage. W dwóch końcowych zestawach Java znaleziono 6 i 5 wywołań: łącznie 7 z exit 0 i 4 bez końcowego exit w tych śladach. To **nie jest pełna liczba wywołań produktu z całej nocy** ani dowód, że cztery procesy nadal działały przy STOP. Dokładny koszt tego kanału pozostaje UNKNOWN. Dlatego 690 mln to suma dwóch zmierzonych kanałów, nie zamknięty rachunek całego konta.

Dla porównania, inne okno — od północy do STOP — daje dla samego Thalamusa 7 630 prób, 579 309 194 input i 2 957 588 output. Nie mieszamy tej większej próbki z głównym oknem ośmiu godzin.

### 4.1. Per rola, bez podwójnego liczenia

| Rola | Próby | UNKNOWN | Input | Cached (część input) | Output | Znane razem |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| P2 | 1 160 | 32 | 108 336 287 | 27 336 576 | 440 742 | 108 777 029 |
| K | 1 114 | 37 | 95 684 087 | 24 111 616 | 666 080 | 96 350 167 |
| P3 | 830 | 34 | 63 974 388 | 16 798 464 | 329 714 | 64 304 102 |
| P4 | 750 | 32 | 43 279 206 | 8 432 000 | 295 340 | 43 574 546 |
| P1 | 513 | 33 | 41 323 335 | 12 821 248 | 226 083 | 41 549 418 |
| P5 | 527 | 32 | 34 978 779 | 6 958 976 | 134 190 | 35 112 969 |
| P1_2 | 508 | 32 | 33 560 406 | 8 215 808 | 142 968 | 33 703 374 |
| P1_4 | 269 | 33 | 19 328 460 | 3 289 472 | 76 379 | 19 404 839 |
| P6 | 262 | 32 | 17 325 122 | 3 598 592 | 91 333 | 17 416 455 |
| P2_2 | 139 | 0 | 8 931 438 | 2 251 008 | 44 427 | 8 975 865 |
| P2_3 | 94 | 0 | 6 657 582 | 1 758 848 | 23 133 | 6 680 715 |
| P1_3 | 90 | 0 | 5 601 438 | 1 143 424 | 43 752 | 5 645 190 |
| JUDGE | 0 | 0 | 0 | 0 | 0 | 0 |
| P2_4 | 0 | 0 | 0 | 0 | 0 | 0 |
| ROOT | 750 przyrostów | brak równoważnego rejestru prób | 207 995 769 | 204 855 552 | 543 010 | 208 538 779 |

**Najwięcej znanego zużycia spośród ról: P2 108,78 mln, K 96,35 mln, P3 64,30 mln.** Razem około 56% znanego usage Thalamusa. ROOT dodaje 208,54 mln poza zespołem, w większości jako cached input. Liczba tokenów nie jest liczbą napisanych zmian; wejście obejmuje ponowne podawanie kontekstu.

### 4.2. Dlaczego poszczególne role zużywały kontekst — zakres potwierdzony zadaniami

Poniższe wyjaśnienia wynikają z przypisań zadań i artefaktów. Nie są precyzyjną wyceną każdej czynności wewnątrz tury.

| Rola | Co robiła / co generowało kolejne tury | Efekt i ograniczenie |
| --- | --- | --- |
| ROOT | Zlecenia, niezależny odczyt wyników, procesy hostowe, powiązanie SHA/ZIP/GUI/Docker, rozliczanie restore, liczne aktualizacje kierunku | 208,54 mln znanych tokenów bez per-task cost center. Duży koszt nadzoru; nie dowiódł wydajniejszego dowiezienia produktu. |
| K | Rozdzielanie, review, integracja, wiązanie execution/work, przekazywanie zmian źródła właściciela | 96,35 mln, w większości bez pojedynczego work_id. 52 zdarzenia przyjęcia pracy nie przełożyły się na końcowy PASS. |
| P1 | Fixture storage/startup, kontekst Coach, HTTP abort, diagnostyka admission, stare zadania snapshot/recovery nadal powiązane z turami | Konkretne poprawki zintegrowano; po pełnym suite nadal powstał osobny nieprzetestowany commit fixture. |
| P1_2 | Timeout intent, separatory ścieżek, oracle AC103, startup/readiness; stare Spring27 i pomiary nadal w turn_work | Poprawki częściowo przyjęte; końcowe 3 pliki fixture na osobnej gałęzi, testy NOT_RUN. |
| P1_3 | Naprawa natywnej blokady JournalLease, dawne zadania backend/JDT nadal powiązane | Wykryto i poprawiono realny crash Windows; nie jest to odbiór aktualnej paczki. |
| P1_4 | Diagnostyka GUI Run, poprawka pending MAIN, potem niezamknięta diagnostyka pending TESTS; cleanup w starym powiązaniu | MAIN poprawione, ale końcowy Java21 GUI nadal FAIL. Sam tag cleanup nie dowodzi, że 7,78 mln pojedynczo przypisanych tokenów było użytecznym sprzątaniem. |
| P2 | Najwięcej GUI/Monaco, Python/JS/TS, worker init, selection/reconnect, completion, AI i neutralne aktualizacje stanu | 108,78 mln; część scenariuszy PASS, JS-first i końcowy popup/control nadal nieodebrane. Dużo starych nakładających się zadań. |
| P2_2 | Rzeczywisty AI Java i ponowne związanie launchera/hosta | Tu istnieją pojedyncze przypisania kosztu: 3,72 mln + 2,94 mln + 2,19 mln, plus mała część bez przypisania. |
| P2_3 | Selection przy reconnect oraz starsze pakowanie/cleanup | Selection poprawione; koszt współdzielony ze starymi zadaniami, bez wyłącznej wyceny. |
| P2_4 | Brak prób modelu w oknie | Nie przypisujemy kosztu. Otrzymywała jednak systemowe powiadomienia. |
| P3 | GUI i fizyczne Run/Stop, AC102/restart, kolejne launchery i końcowa Java21 | 64,30 mln, końcowy scenariusz nadal FAIL; nie można liczyć przygotowanego harnessu jako wykonanego testu. |
| P4 | Windows public start, diagnostyka crash, ZIP/manifest, verifier, instrukcje, opt-in kontekstu | Cenne wykrycie crash i gotowa paczka, ale aktualny Windows LIVE NOT_RUN. Również stare stopfix/temp-growth przypięte do tur. |
| P5 | Review security, testów/oracle, WriteGate, granic fixture i neutralnego stanu | Review złapało konkretne ryzyka; koszt 35,11 mln nie daje automatycznie odbioru zachowania. |
| P6 | AC103, koszt I/O, przegląd oracle oraz końcowe przygotowanie metryk | 17,42 mln, brak końcowego pomiaru pełnego wydania. Historyczne living-architecture/cleanup nie zostały odpięte od tur. |
| JUDGE | Brak rozliczonych prób w oknie | 8 błędów analizy incydentów nie daje dowodu działania niezależnego bezpiecznika. |

### 4.3. Per zadanie: czego nie da się uczciwie wyliczyć

| Sposób przypisania tury | Próby | Znane input + output | Znaczenie |
| --- | ---: | ---: | --- |
| Dokładnie jeden work_id | 244 | 16 878 291 | Techniczne pojedyncze przypisanie, około 3,5% znanych tokenów Thalamusa |
| Wiele work_id | 4 897 | 368 147 615 | Wspólny koszt, nie wiadomo ile przypada na każde zadanie |
| Bez work_id | 1 115 | 96 468 763 | Głównie koordynacja K; brak taskowego rachunku |

**Brak rachunku per zadanie jest sam w sobie ustaleniem awarii procesu/platformy.** Nie wolno go zasłaniać tabelą z fałszywą precyzją. Na przykład trzy stare zadania P2 mają każde współpowiązanie z tymi samymi 108 777 029 tokenami. Zsumowanie ich dawałoby potrójne obciążenie tego samego kosztu.

W aneksie poniżej są wszystkie **81 powiązań**: `jedno` oznacza koszt tur przypiętych tylko do tego work_id; `wspólne` oznacza pulę tur przypiętych także do innych zadań. Kolumna wspólna i jej suma z jedno są wyłącznie górnym zakresem powiązania, nie samodzielnym kosztem danego zadania. Nie sumować tych wierszy. Do uzgodnienia całego rejestru służy CSV 76 rozłącznych grup.

## 5. Gdzie poszedł narzut i dlaczego wielu agentów nie przyspieszyło końca

| Cel tury w rejestrze | Próby | Znane input | Znane output | UNKNOWN |
| --- | ---: | ---: | ---: | ---: |
| WORK | 5 501 | 428 590 773 | 2 189 375 | 16 |
| SLEEP / konsolidacja | 277 | 29 078 013 | 230 961 | 1 |
| RECOVERY | 478 | 21 311 742 | 93 805 | 280 |

Sleep i recovery zużyły około **50,39 mln input**, 10,5% znanego wejścia Thalamusa. Nie wszystko jest zbędne: konsolidacja chroni ciągłość. Jednak to mierzalny narzut, który nie implementuje funkcji produktu. Pole WORK też nie oznacza wyłącznie pisania kodu — obejmuje administracyjne odczyty i odpowiedzi.

Zdarzenia potwierdzające nadmiar ruchu:

- **66 wejść HUMAN → K** (w tej kategorii są również instrukcje ROOT, nie tylko wiadomości właściciela).
- **1 283 systemowe powiadomienia „Owner source updated…”**, około 19,4 na wejście HUMAN. Powiadomienie nie jest równoznaczne z osobnym wywołaniem, ale rozszerza inbox i kontekst.
- 946 `TurnStarted`, 647 `TurnCompleted`, 304 `TurnInterrupted`. To zdarzenia w oknie; nie należy mechanicznie uzgadniać ich jako identycznego zbioru tur.
- 277 rozpoczęć konsolidacji, 276 zakończeń i odświeżeń kontekstu.
- 297 `RecoveryStarted`, 290 `ProviderCapacityWait` z powodem `MODEL_AT_CAPACITY`.
- 19 `ToolRejected` z `STALE_EXECUTION`: formalne ponowne wiązanie wyników zamiast nowego zachowania produktu.
- Wiadomości obejmują 1 471 QUESTION, 181 NOTE, 101 TASK, 68 RESULT_READY i 57 REVIEW_DECISION. Sam ruch na magistrali nie jest postępem użytkowym.

Po 06:00 lokalnie narastały próby UNKNOWN: w godzinie 06 — 99, 07 — 108 na 108 prób, 08 do STOP — 82. Nie oznacza to, że wszystkie były płatnymi odpowiedziami; oznacza brak skutecznego rozliczenia i nieproduktywną ścieżkę capacity/recovery. Należało wcześniej ujawnić brak postępu i koszt, zamiast utrzymywać pozór normalnej pracy.

**Błędy operatora i organizacji:**

1. Integracja i odbiór K/ROOT stały się wąskim gardłem. Równoległe wykonawstwo nie usuwa kosztu serialnego składania i niezależnego sprawdzania.
2. Za długo traktowano dostawy, hashe i scoped PASS jako sygnał bliskości końca. Zwykły użytkowy przebieg pozostawał czerwony.
3. Dopiero duży finał ujawnił masowe rozbieżności aktywnych fixture z kontraktem storage/startup/readiness. To nie był wyłącznie problem czasu wykonania testów.
4. Te same tury nosiły stare taski i nowe zadania. Powstawał koszt ponownego czytania kontekstu i niemożność precyzyjnego przypisania wydatku.
5. Komunikacja administracyjna, odczyty i ponowne wiązanie dowodów dostały zbyt dużą część aktywności wysoko ustawionych modeli.
6. Nie wykazano kontrolowanym porównaniem skrócenia czasu dzięki replikom. Liczba ról i dostaw nie jest dowodem wzrostu wydajności.
7. Nadzór nad długim procesem testowym zgubił stan terminalny. Status nadal sugerował pracujący suite, mimo że log skończył się wcześniej. To błąd nadzoru ROOT.
8. Nie było skutecznego kosztowego punktu decyzyjnego operatora. Pasywny CallLedger sam nie stanowi kontroli tempa wydatków. Nie należy teraz bez zgody dopisywać nowego globalnego blokera do platformy; najpierw trzeba uczciwie opisać lukę.

## 6. Chronologia techniczna i realny wynik nocy

Nie przepisuję historii jako „nic nie zrobiono”. Zmiany źródłowe istnieją:

| Rewizje / obszar | Co zmieniono |
| --- | --- |
| `ee73f78f`, `496158de`, `0f924546` | Publiczny start/port, ochrona przy konflikcie i aktualne kontrakty V2/instrukcje |
| `4c613c47`, `b1b203e5`, `0889c691` | Bieżący dokument wobec cache, publikacja selection po HELLO i fixture V2 |
| `9a2aa62e`, `b5d4cc65`, `652332c7` | Profil python-3.13, przenośność manifestu prepare i fixture/native report faults |
| `88cbc261`, `d2dbfc29`, `4c57f256`, `442eff3e` | Rzeczywiste timeout intent, lifecycle i przechwycenie readiness na kolejce źródła |
| `27e940df` | Leniwa inicjalizacja workerów JS/TS Monaco |
| `257e90b8` | Jedna kompozycja 8 przyjętych wycinków, 18 plików; nie końcowy odbiór |

Nie wyznaczam godzin kamieni milowych wyłącznie z dat autora Git — nie są monotoniczne. W `257e90b8` produkcyjne zmiany względem `27e` to `JournalLease.ts` (Win32 HANDLE i tożsamość Linux), `RuntimeClientV2.ts` (pending MAIN), `LiveBackend.ts` (neutralne aktualizacje wobec lokalnego completion), trzy skrypty pakowania/weryfikacji oraz instrukcja Windows. Pozostałe dotknięte pliki to testy i oracle. Łącznie 1 304 dodane i 152 usunięte linie.

Przy integracji K uzyskał **344 PASS / 0 FAIL / 0 skip**, typecheck i jeden build exit 0. ROOT niezależnie uzgodnił 18 źródeł i 95 hashy dist. To były prawdziwe wyniki **w swoim zakresie**, a nie odbiór całego produktu.

### 6.1. Końcowy `npm test`: czerwony, nie „wciąż się wykonuje”

- Start: **13.11.2026 05:50:52 Europe/Warsaw**.
- Ostatni zapis pełnego logu: **06:20:02**, około 29 min 10 s później.
- Znaleziono 16 kompletnych podsumowań TAP: **2 775 tests, 2 529 pass, 244 fail, 2 skipped, 0 cancelled**.
- Pierwsza duża grupa TS: 2 392, z czego 236 FAIL; grupa MJS: 353, z czego 8 FAIL i 2 skip. Pozostałe grupy wyszczególnia JSON. Część jednostkowych grup to wrappery historycznych/superseded przypadków, a nie nowy dowód zachowania produktu.
- Proces nadzorujący zniknął przy kontynuacji sesji celu. Sam npm działał dalej, potem zakończył się przed STOP. **Kod wyjścia zewnętrznego procesu jest UNKNOWN**, bo nie zachowano terminalnego receipt. Nie dopisuję fikcyjnego exit 1 tylko na podstawie czerwonego TAP.

**Korekta wcześniejszego śladu:** pierwsza notatka `owner-stop-request.json` sugerowała przerwanie pełnego suite przez STOP. To było oparte na nieaktualnej obserwacji. Końcowy odczyt logu i procesów wskazuje, że suite skończył się wcześniej. Oryginał zachowano, a tę korektę zapisano jawnie.

Rozpoznane rodziny błędów:

- ROOT nie zastosował planowanego `umask 077`; proces odziedziczył 0022. Część fixture tworzyła `.paircoach` z 0755, więc prawidłowy guard prywatnego magazynu odmawiał startu. **To nie wyjaśnia wszystkich 244 FAIL**.
- Starsze fixture wskazywały sąsiedni dataDir zamiast wymaganego `root/.paircoach`.
- Testy odczytywały workspace/session przed `await listen()`.
- Testy żądały `canRun=true` na migawce bez rzeczywistego pomiaru readiness.
- Cleanup potrafił zamaskować pierwotny błąd startu jako `RUN_RECOVERY_REQUIRED` — odrębny problem diagnostyczny produktu, bez dostarczonej naprawy.
- Inne czerwone przypadki dotyczą m.in. `retiredModelsRef`, `disableNativeCompletionProviders` oraz importu CSS w testach. Nie ma pełnej diagnozy każdego FAIL. CSV jest listą wpisów, nie dowodem jednej przyczyny.

Nie osłabiano asercji ani progów po to, aby uzyskać zielony wynik. Trzy późniejsze prywatne commity nie były po STOP scalane ani wykonywane.

### 6.2. Java 21 przez publiczny start i GUI — nadal FAIL

Na końcowej `257e` działały zwykły `npm start`, HTTP/UI/API i gotowość. Main **`fc94d24d` SUCCEEDED**, exit 0, output -1, rzeczywiste JDK 21, class55/release11. Tests **`1d34e540` FAILED**, exit1, świeży JUnit: 1 test, expected5/actual-1. To jest uczciwy czerwony test, a nie problem braku testów.

Po poprawce w Monaco i oryginalnym ACK drugi Tests pozostawał zablokowany przez 30 000 ms; UI pokazywało UNKNOWN/fence mimo READY/canRuntrue. Chronologia dowodu: readiness false 05:06:02Z, oryginalne 202 05:06:06Z, FAILED 05:06:15Z, poprawka 05:06:21Z. **Poprawka była po oryginalnym admission**, więc nie wolno wyjaśniać tego po prostu „uczeń zmienił kod przed przyjęciem żądania”.

Podejrzenie dotyczy porównania pending TESTS/readiness; diagnoza była tylko do odczytu i nie jest dowodem wyłącznej przyczyny. Nie dostarczono naprawy. Green-after-fix, compiler-control, immutable input oraz Stop **NOT_RUN w tej końcowej próbie**. Źródła i ustawienia odtworzono; fizyczne rozliczenie tych dwóch Run nie było jeszcze niezależnie zakończone przed STOP. Starsze cztery przebiegi Stop nie zastępują tych dwóch Run.

### 6.3. Edytor i prawdziwy AI — część PASS, część FAIL/NOT_RUN

- Końcowe TS: **1 PASS, 1 FAIL**. Cold TS: edycja przed ACK, completion, Enter/ACK, Undo/Redo, TS2322, poprawka i reload ON — PASS.
- JS-first: porażka już przy native paste, przed Ctrl+Space; 0 CODE_CHANGED. Przyczyna UNKNOWN. Nie jest to dowód, że provider completion zawiódł.
- W widoku 390×844 panel runtime zasłaniał źródło. Obserwacja usterki layoutu, bez mobile PASS.
- Aktualna Java: lokalne słowa, Enter/Tab, ACK i Undo — PASS. Prawdziwy Codex sol/medium: CHAT/current selection/EDIT/WriteGate/Undo/Redo i rzeczywiste 2×Esc — PASS, 53,4 s; trzy CHAT z native exit0.
- Wymagany przypadek **otwarta lista completion → CONTROL_PREPARE → Enter/Tab → zero mutacji** pozostaje NOT_RUN na końcowej wersji. Starszych dwóch FAIL z `27e` nie przepisujemy na PASS.
- Przywrócono pliki i ustawienia, consent OFF, kontrolę STUDENT; sesja PAUSED. Historyczne niepełne ślady dwóch automatycznych EDIT nie stanowią potwierdzenia zakończenia modelu.

### 6.4. Docker i Windows — ważne dowody zakresowe, brak odbioru wydania

Cztery fizyczne Docker LIVE na `257e` dały PASS w swoim zakresie: Stop drzewa parent/child/grandchild z niezależnym sentinelem, Timeout takiego drzewa, brak odziedziczonych poświadczeń, ograniczone stdout/stderr i poprawne sekwencje/wersje. ROOT sprawdził 6 REMOVED, 12 odczytów nieobecności po ID/nazwie, 12 hashy wejść, hashe artefaktów i dwa drzewa po 3 PID. To rzeczywisty dowód zatrzymania, **nie pełny PASS aplikacji**.

Na wcześniejszym `27e` natywny Windows ujawnił crash **0xC0000409** na ścieżce CRT `_get_osfhandle`. Pierwszy fix `72f8` odrzucono ze względu na wyścig tożsamości blokady Linux. Poprawione `34926bc` przeszło 10 testów native, 2 Linux-only skip; publiczny start UI/API200 działał na prywatnej poprawce. Nie zamienia to końcowego `257e` ZIP-a w odebrany produkt Windows.

Paczka `257e` ma **633 pliki / 6 043 205 B**, SHA256 ZIP **`157c35bedfa2ee5768a357dbeab590bf6ccaccb7e964bd0927541d5670f5fccd`**, manifest **`9e91d8e4b8522ecb609f5ba8c581df97fac1fa6cabad49aa06a148193d6bee22`**. Zgodność Git/manifest/ZIP odczytano. Końcowe 7 natywnych kontroli, publiczne prepare/start i Edge/Spring ze świeżej paczki **NOT_RUN**. 12 syntetycznych testów observera nie zastępuje tej próby.

## 7. Stan pełnego zakresu 1–9 w chwili STOP

Nie nadaję na nowo numerów historycznym poprawkom bez dowodu. Dla 1–8 stosuję utrwalone identyfikatory regresji, odróżniając implementację od końcowego odbioru.

| Zakres | Stan implementacji / wcześniejszych dowodów | Stan końcowego wydania |
| --- | --- | --- |
| REGRESSION-01: strumienie HTTP i błędy zasobów | Poprawki istnieją | Końcowe regresje NIEZALICZONE |
| REGRESSION-02: pamięć rejestru komend / idempotencja | Wcześniejszy wycinek przyjęty | Końcowe regresje NIEZALICZONE |
| REGRESSION-03: finish, wyciszenie nowych analiz | Poprawki istnieją | Końcowe regresje NIEZALICZONE |
| REGRESSION-04: odczyt raportów zakończonych sesji | Poprawki istnieją | Końcowe regresje NIEZALICZONE |
| REGRESSION-05: kursor/selection i kontekst | Aktualne scoped PASS, poprawki V2 | Brak pełnego odbioru całego wydania |
| REGRESSION-06: dymek / Markdown / UX | Poprawki istnieją | Niepełne GUI i czerwone wpisy suite |
| REGRESSION-07: capabilities, MUTE, evidence | Poprawki istnieją | Końcowe regresje NIEZALICZONE |
| REGRESSION-08: Codex config i tożsamość paczki | Coach sol/medium działał; hashe paczki zgodne | Świeża paczka native NOT_RUN |
| 9.1: Lightweight bez kontenerowego LSP | Wyłączono ciężką ścieżkę, lokalny edytor częściowo PASS | JS-first FAIL; popup/control NOT_RUN |
| 9.2: publiczne prepare profili | Siedem profili i pomiary narzędzi w scoped dowodach | Nie jest to pełna macierz GUI |
| 9.3: timeouty | Zintegrowane oddzielne budżety | Nie dowodzą responsywności całej aplikacji |
| 9.4: Java21 GUI | Main i czerwony JUnit potwierdzone | **FAIL: ponowny Tests po poprawce zablokowany** |
| 9.5: Spring21/27 | Starszy Spring21 pełny i Spring27 focused PASS | Aktualna paczka/native NIEODEBRANE |
| 9.6: pozostałe profile, restart, real AI | Starsze JS/TS/Python/Java11/17/27 i AI mają scoped dowody | Jedna końcowa macierz NIEZAKOŃCZONA |
| 9.7: regresje, ZIP, odbiór, publikacja wydania | ZIP zbudowany, źródła zabezpieczone | **NO-GO: 244 FAIL + wymagane NOT_RUN** |

Nie ma wiarygodnej jednej liczby „zadań ukończonych” liczonej z rekordów ACCEPTED. Na poziomie pracy nad produktem wszystko jest obecnie **STOP/PAUSED**, bez zadań aktywnie wykonywanych. Nieukończone pozostają pionowy Java21, końcowa macierz, wybrane przypadki edytora i odbiór Windows/paczki. W tej fazie nie podaję nowej ETA.

## 8. Dysk, śmieci testowe i katalogi bundle-before*

### 8.1. Co wygenerowały testy PairCoach

W bieżącym suite sześć własnych katalogów recovery-unit zajmowało po około 208–260 MiB, łącznie około **1,35 GiB**. `tests/runtime-image-recovery/fixture.mjs` kopiował stare stage/projects/requests oraz zachowane language-contexts z wcześniejszej wersji. Dwa testowe procesy controller/measured-reuse zużyły ponad 400 s CPU każdy. To wykazany ciężar historycznych fixture, a nie konieczny koszt małego przykładu ucznia.

Nie oznacza to zgody na skasowanie całego recovery: część przypadków chroni nadal aktywne kontrakty. Wymagałyby rozdzielenia, nie globalnego wyłączenia testów. Test signed-boundary z 1 000 długich ścieżek trwał około 139,8 s; ten czas ma znaną przyczynę, nie jest sam w sobie zawieszeniem Dockera.

Wcześniejsze 12,61 GB Windows Temp, 1,85 GB swap WSL i około 40 GB `codex-computer-use.exe` to inne, historyczne obserwacje właściciela. Nie przypisuję ich bez nowego pomiaru do tej samej nocy ani nie twierdzę, że obecnie odtworzono wyciek 40 GB. W bieżącym audycie ROOT nie używał Computer Use.

### 8.2. Co jest w thalamus_2.0_runtime/bundle-before*

Sprawdzony katalog:
`\\wsl.localhost\Ubuntu\home\darulec\dev\codex_prjects\thalamus_2.0_runtime`

**To siedem zachowanych pełnych kopii poprzednich paczek Thalamusa do rollbacku po wdrożeniach, a nie dane projektu ani logi.** Każda zawiera `jre`, `lib`, CLI, `libexec`, dokumentację, przykłady i manifest. Nazwy wskazują poprawki Slack, dostępu agentów, permissive, AI-unslop, setup i Watchdog. Same nazwy nie dowodzą godziny wykonania backupu — mtime może pochodzić z kopiowanego katalogu. Dokładny autor/komenda utworzenia każdej kopii nie wynika z manifestu.

| Katalog | Pliki | Rozmiar logiczny B | Zajęte bloki B | Build ID |
| --- | ---: | ---: | ---: | --- |
| `bundle-before-agent-access-20261109` | 196 | 84 506 530 | 84 938 752 | `0b99ca30bd344faf98161cb9e9218810` |
| `bundle-before-kontrakt-it-setup-20261109` | 197 | 84 531 854 | 84 967 424 | `d478d522ec28431584eee500efb65d9e` |
| `bundle-before-permissive-20261109` | 197 | 84 513 812 | 84 946 944 | `1c6752d7bb93411fa2d70ca0b296c073` |
| `bundle-before-permissive-final-20261109` | 197 | 84 532 091 | 84 967 424 | `e2a01da128d04405b95edf932a870064` |
| `bundle-before-slack-20261107` | 195 | 84 465 714 | 84 893 696 | `4d2d11dbe5254d708222004ea622575e` |
| `bundle-before-unslop3-publication-20261109` | 197 | 84 531 534 | 84 967 424 | `b8edd89d221b4ea2bc7bbcedc3978d05` |
| `bundle-before-watchdog-4c276998946545f890d7b149dc5b9460` | 197 | 84 532 591 | 84 967 424 | `4c276998946545f890d7b149dc5b9460` |

Łącznie **591 614 126 B** logicznie (około **591,6 MB / 564,2 MiB**) i **594 649 088 B** bloków (około **567,1 MiB**). Brak hardlinków: są to rzeczywiste kopie. Każda zawiera identycznej wielkości JRE **64 908 344 B**, łącznie około 454,4 MB samego powielonego JRE. To niewielka część wcześniejszych kilkunastu GB Temp, ale niepotrzebna retencja siedmiu pełnych paczek też zajmuje miejsce.

Aktywny launcher i CLI wskazują **`bundle/`**, nie `bundle-before*`. Aktywny manifest ma build ID **`b263fcc24c964b4095ba0754b547d9ed`**, inny od siedmiu backupów. Odczyt dostępnych `/proc` argv/cwd/exe/fd nie znalazł użycia ścieżek backupów. Ograniczenie: nie dowodzi to braku przyszłego użycia do rollbacku ani niewidocznych procesów. Nie sprawdzano teraz pełnej kwalifikacji każdej starej paczki.

**Ocena:** historyczne backupy wdrożeniowe z brakiem uporządkowanej retencji, kandydaci do odzyskania około 567 MiB po świadomej decyzji o rezygnacji z rollbacku. Nie są aktywnym workspace ani wymaganym elementem startu. **W ramach tej prośby niczego nie usunięto i nie przeniesiono.** Nie deklaruję odzyskanego miejsca.

## 9. Co zabezpieczono i co pozostaje nieprzyjęte

Canonical K nadal wskazuje `257e90b8`. Tracked pliki były czyste, ale cały `git status` nie jest pusty: zachowano cztery nieśledzone katalogi testów `.paircoach-test-rename-http-IgfBEm/`, `tests/client/.ac011-qKdU7b/`, `.ac011-rkCvoH/`, `.ac011-rmrk5g/`. Nie skasowano ich dla kosmetycznego „clean”.

Osobne, **niescalone i nieodebrane** commity checkpointów:

| Commit | Treść | Odbiór zachowania |
| --- | --- | --- |
| `158881b06265a2fa4dc976b6f30e017b2843564a` | P1: 8 plików fixture, canonical storage / await listen / ustawienia V2, 19+/14− | NOT_RUN; bez scalenia do main |
| `8099dea62659655535be35345b4132f0571371d1` | P1_2: 3 pliki fixture, async startup / canonical store / rzeczywisty GET readiness, 7+/5− | NOT_RUN; asercje i progi zachowane statycznie |
| `ef98df3b1620cb6f551052c9c97b47f045a01bf0` | P4: 6 linii instrukcji jawnego opt-in kontekstu kodu; puste `[]` pozostają domyślne | 11 kontroli statycznych PASS, brak końcowego review/integracji |

Publikujemy je jako nazwane gałęzie `checkpoint/20261113-paused-*`, nie jako gotową implementację. Samo zachowanie pracy nie wznawia projektu.

## 10. Thalamus: źródło, wdrożenie i granica ustaleń

Źródło Thalamusa do osobnej publikacji: **`4f2fea7c5c2551d65f6d271d1b23ac93412ce2a1`**, lokalna `rebirth/stage1`. Migawkę utworzono oficjalnym `prepare_publication.py` jako świeżą historię bez prywatnych starych commitów, danych projektu i poświadczeń.

Obecnie wdrożony runtime 8768 deklaruje w `state/deployment.json`:

- base `1cde4a1dc6ddf6656a807ad6448b9e452a54e956`;
- hotfix runtime **`b235eea413a1df84e4be4cea813a25ac8a5de984`**;
- bundle ID **`b263fcc24c964b4095ba0754b547d9ed`**;
- wcześniejszą kwalifikację celowaną, bez pełnego test suite.

**Publikacja źródła 4f2 nie jest wdrożeniem tego kodu.** Nie restartowano daemona ani nie zmieniano silnika SQLite w celu raportowania.

Hotfix `scopedCommands()` z `b235` usunął konkretną korelację SQL. Nie wydzielił portów storage, nie zmienił całej współbieżności i nie dodał Flat Files. Storage Ports & Adapters, Flight Board i usprawnienia sandbox/flow są w [trwałym backlogu](docs/next/BACKLOG_MVP_STORAGE_FLIGHT_BOARD_AND_RUNTIME.md), nie jako rzekomo ukończone Zadanie 9.

## 11. Gdzie szukać dowodów lokalnych

Publikowany raport i agregaty:
`\\wsl.localhost\Ubuntu\home\darulec\dev\codex_prjects\pairCoding-publication-20261112\STATUS2.md`

Prywatny katalog źródłowych dowodów ROOT:
`\\wsl.localhost\Ubuntu\home\darulec\dev\codex_prjects\projects\software_dev_2\Desks\SharedDesk\deliveries\_drafts\ROOT\wsl-recovery-20261112-2004\`

W nim:

- `257e90-hosts/owner-stop-request.json`, `owner-stop-helper-processes.json` — STOP i cleanup procesów; pierwszą notatkę o suite koryguje §6.1.
- `257e90-active/npm-test.stdout.log` — pełny log TAP; SHA256 **`43f0c544dfcb1bdb166dbc5d0610baae4ef05b5a88a65626ca224d05cb73fcb5`**.
- `257e90-active/runner-live-physical-root-readback.json` — cztery fizyczne LIVE; SHA256 **`9ff55703cb342a8d2af9e1bc5a125c30daabc330d0ce1dfc38a9672b323eae39`**.
- `257e90-hosts/editor-ts-restore-root-readback.json` — źródła/ustawienia/host po TS.

Baza projektu pozostała prywatna:
`\\wsl.localhost\Ubuntu\home\darulec\dev\codex_prjects\projects\software_dev_2\.thalamus\project.db`

Jej kopia nie jest załącznikiem do publicznego repo. Surowe ślady AI również pozostają prywatne. W publicznym audycie są agregaty i identyfikatory, bez treści komunikacji klienta.

## 12. Co musiałoby się zmienić przy ewentualnym wznowieniu

**To rekomendacje do decyzji właściciela, nie automatycznie uruchomiony kolejny cel.**

1. Zacząć od jednej wykazanej czerwonej ścieżki Java21 i naprawy jej rzeczywistej przyczyny, bez przygotowywania nowej całej kampanii przed jednym green-after-fix.
2. Wcześniej sprawdzić zgodność aktywnych fixture z rzeczywistym kontraktem start/storage/readiness; nie naprawiać tego dopiero po kolejnej nocy modeli.
3. Pokazywać koszt per fizyczna odpowiedź i prawdziwe bieżące zadanie; zamykać nieaktualne powiązania prac. Bez arbitralnego dzielenia wspólnej tury na fakturę per task.
4. Ograniczyć powielanie zmian źródła i formalne rozmowy administracyjne. Review ma prowadzić do nowego dowodu zachowania, nie kolejnej rundy tych samych hashy.
5. Utrzymać trwałą obserwację końca procesów operatora, tak aby kontynuacja sesji nie gubiła exit ani nie zostawiała fałszywego RUNNING.
6. Przywrócić koszt jako jawny sygnał decyzji operatora i uczciwie aktualizować ETA. Nie udawać, że więcej agentów automatycznie daje proporcjonalne skrócenie terminu.
7. Zachować rzeczywiste zabezpieczenia WriteGate, Undo, Veto, Stop i uczciwe JUnit. Nie usuwać wartościowych negatywów tylko dlatego, że raport jest czerwony.
8. Nie wracać pod pretekstem naprawy do LSP, przebudowy Thalamusa, SQLite/Flat Files ani kolejnej warstwy recovery. Obecny produkt nie potrzebuje nowego celu architektonicznego, aby rozstrzygnąć obecną usterkę GUI.

**Bieżąca decyzja: STOP zachowany, wydanie NO-GO, nowa ETA nieustalona.** Publikacja kodu i tego audytu jest zabezpieczeniem stanu, nie deklaracją gotowości do użycia.

## Aneks A — wszystkie 81 powiązań rola–zadanie

Statusy poniżej są zapisami transportu w cutoff, nie werdyktem wydania. Wszystkie role są obecnie PAUSED także wtedy, gdy task ma historyczne RECEIVED lub ACCEPTED. Wiersze „wspólne” NIE SĄ ADDYTYWNE. Utrzymuję pełne work_id, aby reviewer mógł wrócić do dowodu i nie musiał odgadywać znaczenia skrótu.

### K

Brak powiązań kosztu z work_id w tym oknie. Zużycie jest w tabeli roli; nie ma rzetelnego taskowego podziału.

### P1

| work_id | Stan taska w cutoff | Jedno: znane tokeny | Wspólne: znane tokeny, nie sumować |
| --- | --- | ---: | ---: |
| `paircoach-g3-snapshots-recovery` | RESULT_READY | 246 002 | 41 303 416 |
| `paircoach-lightweight-0889-python-original-admission-readonly-diagnosis` | ACCEPTED | 0 | 10 104 106 |
| `paircoach-lightweight-27e-coach-context-fixture-alignment` | ACCEPTED | 0 | 9 237 878 |
| `paircoach-lightweight-6523-readiness-capture-interleaving` | ACCEPTED | 0 | 8 661 249 |
| `paircoach-lightweight-27e-active-http-fixture-diagnosis` | ACCEPTED | 0 | 5 410 781 |
| `paircoach-lightweight-9a2a-native-test-fixture-diagnosis` | ACCEPTED | 0 | 3 795 991 |
| `paircoach-lightweight-257e-active-storage-authority-ro` | ACCEPTED | 0 | 3 724 993 |
| `paircoach-lightweight-27e-http-abort-fixture-alignment` | ACCEPTED | 0 | 2 548 806 |
| `paircoach-lightweight-27e-http-abort-calllineage-diagnosis` | ACCEPTED | 0 | 1 501 266 |
| `paircoach-lightweight-257e-private-canonical-fixture-fix` | RECEIVED | 0 | 1 493 948 |
| `paircoach-lightweight-27e-http-active-hang-diagnosis` | CANCELLED | 0 | 1 092 158 |
| `paircoach-lightweight-real-selection-v2-fixture-alignment` | ACCEPTED | 0 | 368 418 |

### P1_2

| work_id | Stan taska w cutoff | Jedno: znane tokeny | Wspólne: znane tokeny, nie sumować |
| --- | --- | ---: | ---: |
| `paircoach-lightweight-cb17-spring27-parallel-live` | CHANGES_REQUESTED | 0 | 33 703 374 |
| `paircoach-seq09-bounded-a8-fullpath-measurement` | RECEIVED | 0 | 33 703 374 |
| `paircoach-lightweight-27e-ac103-local-worker-oracle` | ACCEPTED | 0 | 6 666 156 |
| `paircoach-lightweight-257e-active-startup-readiness-ro` | ACCEPTED | 0 | 2 982 219 |
| `paircoach-lightweight-257e-private-async-readiness-fixture-fix` | RESULT_READY | 0 | 2 871 899 |
| `paircoach-lightweight-6523-native-timeout-reason-absence` | ACCEPTED | 0 | 2 322 460 |
| `paircoach-lightweight-9a2a-native-ownedparents-separator-fix` | ACCEPTED | 0 | 1 964 856 |

### P1_3

| work_id | Stan taska w cutoff | Jedno: znane tokeny | Wspólne: znane tokeny, nie sumować |
| --- | --- | ---: | ---: |
| `paircoach-lightweight-27e-native-journallease-direct-handle-fix` | ACCEPTED | 0 | 5 645 190 |
| `paircoach-seq09-ce-backend-orchestration` | RESULT_READY | 0 | 5 645 190 |
| `paircoach-seq09-jdt-preview-policy` | RECEIVED | 0 | 5 645 190 |

### P1_4

| work_id | Stan taska w cutoff | Jedno: znane tokeny | Wspólne: znane tokeny, nie sumować |
| --- | --- | ---: | ---: |
| `paircoach-wsl-recovery-own-cleanup-p1_4-20261112` | RESULT_READY | 7 775 020 | 11 629 819 |
| `paircoach-lightweight-27e-java-run-reconciliation-ro-diagnosis` | ACCEPTED | 0 | 4 145 982 |
| `paircoach-lightweight-27e-pending-main-neutral-readiness-fix` | ACCEPTED | 0 | 4 043 647 |
| `paircoach-lightweight-257e-active-child-context-ro` | ACCEPTED | 0 | 2 652 958 |
| `paircoach-lightweight-257e-pending-tests-gui-fence-ro` | RECEIVED | 0 | 787 232 |

### P2

| work_id | Stan taska w cutoff | Jedno: znane tokeny | Wspólne: znane tokeny, nie sumować |
| --- | --- | ---: | ---: |
| `paircoach-ac027-veto-browser-ack-path-diagnosis` | RESULT_READY | 0 | 108 777 029 |
| `paircoach-lightweight-ba980-current-buffer-live` | RESULT_READY | 0 | 108 777 029 |
| `paircoach-lightweight-cb17-js-ts-python-parallel-live` | RESULT_READY | 0 | 108 777 029 |
| `paircoach-lightweight-0889-python-current-buffer-live` | RESULT_READY | 0 | 96 222 107 |
| `paircoach-lightweight-27e-final-editor-ai-gui` | CHANGES_REQUESTED | 0 | 38 754 486 |
| `paircoach-lightweight-6523-builtin-worker-init-sticky-busy-fix` | ACCEPTED | 0 | 10 500 102 |
| `paircoach-lightweight-9a2a-python-root-supervised-live` | ACCEPTED | 0 | 9 108 338 |
| `paircoach-lightweight-9a2a-python-render-readonly-correlation` | ACCEPTED | 0 | 6 996 846 |
| `paircoach-lightweight-0889-node22-junit-observer-correction` | ACCEPTED | 0 | 6 739 023 |
| `paircoach-lightweight-0889-js-ts-python-minimal-rebind` | ACCEPTED | 0 | 6 454 128 |
| `paircoach-lightweight-9a2a-ts-postreload-readonly-diagnosis` | ACCEPTED | 0 | 5 063 603 |
| `paircoach-lightweight-9a2a-python-gui-minimal-rebind` | ACCEPTED | 0 | 3 057 282 |
| `paircoach-lightweight-27e-livebackend-neutral-local-request-fix` | ACCEPTED | 0 | 2 408 130 |
| `paircoach-lightweight-4c613-js-ts-python-launcher-repin-continuation` | ACCEPTED | 0 | 1 467 876 |
| `paircoach-lightweight-0889-js-ts-supervised-live` | ACCEPTED | 0 | 366 767 |

### P2_2

| work_id | Stan taska w cutoff | Jedno: znane tokeny | Wspólne: znane tokeny, nie sumować |
| --- | --- | ---: | ---: |
| `paircoach-lightweight-0889-java-real-ai-live` | ACCEPTED | 3 723 177 | 0 |
| `paircoach-lightweight-4c613-java-ai-launcher-repin-continuation` | ACCEPTED | 2 941 496 | 0 |
| `paircoach-lightweight-0889-java-ai-minimal-rebind` | ACCEPTED | 2 192 596 | 0 |

### P2_3

| work_id | Stan taska w cutoff | Jedno: znane tokeny | Wspólne: znane tokeny, nie sumować |
| --- | --- | ---: | ---: |
| `paircoach-seq09-package-polyglot` | RECEIVED | 0 | 6 680 715 |
| `paircoach-wsl-recovery-own-cleanup-p2_3-20261112` | RECEIVED | 0 | 6 680 715 |
| `paircoach-lightweight-real-selection-reconnect-view-publication-fix` | ACCEPTED | 0 | 4 427 597 |

### P2_4

Brak powiązań kosztu z work_id w tym oknie. Brak prób modelu.

### P3

| work_id | Stan taska w cutoff | Jedno: znane tokeny | Wspólne: znane tokeny, nie sumować |
| --- | --- | ---: | ---: |
| `paircoach-ac027-measurement-plan` | RESULT_READY | 0 | 64 304 102 |
| `paircoach-lightweight-cb17-ac102-same-root-live` | CHANGES_REQUESTED | 0 | 64 304 102 |
| `paircoach-lightweight-remaining-java-spring-live-harness-preparation` | RESULT_READY | 0 | 64 304 102 |
| `paircoach-lightweight-0889-ac102-current-session-live` | RECEIVED | 0 | 59 778 531 |
| `paircoach-lightweight-27e-final-runtime-qa` | RECEIVED | 0 | 28 475 891 |
| `paircoach-lightweight-9a2a-ac102-root-supervised-live` | ACCEPTED | 0 | 7 734 333 |
| `paircoach-lightweight-4c613-ac102-launcher-repin-continuation` | ACCEPTED | 0 | 1 837 625 |
| `paircoach-lightweight-9a2a-ac102-attempt02-minimal-rebind` | ACCEPTED | 0 | 1 165 730 |
| `paircoach-lightweight-0889-ac102-attempt02-lifecycle-preparation` | ACCEPTED | 0 | 956 123 |

### P4

| work_id | Stan taska w cutoff | Jedno: znane tokeny | Wspólne: znane tokeny, nie sumować |
| --- | --- | ---: | ---: |
| `paircoach-lightweight-stopfix-e982-spring21-current-host-launch` | RECEIVED | 0 | 43 574 546 |
| `paircoach-lightweight-temp-growth-bounded-diagnosis` | RECEIVED | 0 | 43 574 546 |
| `paircoach-lightweight-27e-native-public-start-crash-diagnosis` | ACCEPTED | 0 | 6 330 514 |
| `paircoach-lightweight-34926-required-nativelease-verifier-hook` | ACCEPTED | 0 | 2 448 379 |
| `paircoach-lightweight-257e-final-package-native` | ACCEPTED | 0 | 1 933 853 |
| `paircoach-lightweight-9a2a-one-zip-native-ac112-binding` | ACCEPTED | 0 | 1 921 710 |
| `paircoach-lightweight-257e-private-ai-context-doc-fix` | RESULT_READY | 0 | 1 340 505 |
| `paircoach-lightweight-27e-final-package-native` | ACCEPTED | 0 | 1 188 307 |
| `paircoach-lightweight-9a2a-native-same-install-live-config` | ACCEPTED | 0 | 1 018 792 |
| `paircoach-lightweight-6523-corrected-native-package-config` | ACCEPTED | 0 | 798 742 |
| `paircoach-lightweight-final-windows-start-doc-alignment` | ACCEPTED | 0 | 577 911 |

### P5

| work_id | Stan taska w cutoff | Jedno: znane tokeny | Wspólne: znane tokeny, nie sumować |
| --- | --- | ---: | ---: |
| `paircoach-lightweight-correction-after-review` | RESULT_READY | 0 | 35 112 969 |
| `paircoach-mvp2-finish-snapshot-cache-review` | RESULT_READY | 0 | 35 112 969 |
| `paircoach-lightweight-27e-coach-fixture-frozen-review` | ACCEPTED | 0 | 10 542 476 |
| `paircoach-lightweight-27e-final-security-regression` | ACCEPTED | 0 | 6 226 097 |
| `paircoach-lightweight-20216b5-livebackend-frozen-review` | ACCEPTED | 0 | 1 983 203 |
| `paircoach-lightweight-85cc6-http-abort-frozen-review` | ACCEPTED | 0 | 1 784 213 |
| `paircoach-lightweight-833ffe-pending-main-frozen-review` | ACCEPTED | 0 | 1 372 733 |
| `paircoach-lightweight-257e-final-boundary-review` | ACCEPTED | 0 | 589 221 |

### P6

| work_id | Stan taska w cutoff | Jedno: znane tokeny | Wspólne: znane tokeny, nie sumować |
| --- | --- | ---: | ---: |
| `paircoach-lightweight-living-architecture-contract` | RECEIVED | 0 | 17 416 455 |
| `paircoach-wsl-recovery-own-cleanup-p6-20261112` | RECEIVED | 0 | 17 416 455 |
| `paircoach-lightweight-27e-final-ac103-cost` | ACCEPTED | 0 | 5 857 669 |
| `paircoach-lightweight-27e-ac103-oracle-frozen-review` | ACCEPTED | 0 | 5 194 463 |
| `paircoach-lightweight-257e-final-ac103-metrics-preparation` | ACCEPTED | 0 | 904 859 |

### JUDGE

Brak powiązań kosztu z work_id w tym oknie. Brak prób modelu.

ROOT nie ma per-task cost center w metadanych sesji; jego 208 538 779 tokenów nie zostało sztucznie rozdzielone pomiędzy powyższe prace. Znaczenie i pola `direct_attempts`, `shared_attempts`, cache, reasoning oraz górny zakres dostępne są w CSV.

## Aneks B — identyfikacja publikacji

- Publiczny [PairCoding](https://github.com/biosquawk/pairCoding): checkpoint kodu `257e90b8` + ten raport i agregaty. Commit raportu to commit zawierający ten plik; nie jest finalacceptedSHA.
- Prywatny [Thalamus](https://github.com/biosquawk/thalamus): świeża migawka źródła upstream `4f2fea7c...`; `PUBLICATION.json` wiąże źródło. Bez prywatnej historii i danych runtime.
- Trzy `checkpoint/20261113-paused-*` zachowują niescalone prace. Ich obecność nie zmienia NO-GO.
- Nie tworzono tagu nowego odebranego wydania ani nie wdrażano aplikacji w ramach tego audytu.
