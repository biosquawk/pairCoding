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

## 13. Odpowiedzi na pytania pokontrolne właściciela

Uzupełnienie 13.11.2026 na podstawie **istniejących** danych: pełnego TAP, 244 wierszy CSV, bazy otwartej `mode=ro`, źródła produktu `257e90b8`, diffów checkpointów oraz źródła Thalamusa `4f2fea7c`. **Nie uruchamiano agentów, testów, modelu produktu, przygotowania środowiska, builda ani serwera.** Produkcyjnego kodu i fixture nie zmieniono.

To uzupełnienie koryguje uproszczenia §6.1: nie każdy błąd jest skutkiem umask, a dwa ReferenceError nie dowodzą uruchamiania wycofanego LSP. Tam, gdzie wyjątek został utracony lub ślad nie rejestruje wymaganej zmiennej, podaję **UNKNOWN**, zamiast dopisywać prawdopodobną przyczynę jako fakt.

### 13.1. Wszystkie 244 FAIL — rozłączne grupy i odpowiedź a–d

Pełny TAP rozwija wielowierszowe `error: |-`, które pierwotny CSV skracał do samego `|-`. Przypisałem każdy z 244 wpisów dokładnie do jednej grupy obserwowanego błędu. **To kategoryzacja symptomów i wykazanych przyczyn, nie 244 niezależne bugi.** Wiersz po wierszu: [followup-failure-classification.csv](docs/audit/20261113-night/followup-failure-classification.csv). ID to kolejny czerwony wpis w pełnym logu, niezależnie od numeracji poszczególnych grup TAP.

| Grupa | FAIL | Dokładny komunikat / ustalenie |
| --- | ---: | --- |
| PERMISSIONS | 12 | `RECOVERY_REQUIRED: Workspace identity authority is not privately owned.` — 10 bezpośrednio, 2 przez child/ERR_ASSERTION |
| DATA_DIR | 75 | `INVALID_V2_DATA_DIR: V2 workspace storage must be the canonical project .paircoach directory...` — 70 bezpośrednio, 5 jako `Product child exited 1/null` |
| INITIALIZING | 29 | `PROJECT_INITIALIZING: Canonical project recovery has not completed. Await listen before accessing the core.` — 22 bezpośrednio + 7 w child/harnessie |
| UNMEASURED_READINESS | 1 | `ERR_ASSERTION`: oczekiwane canRun=true, odpowiedź ma `RUNTIME_READINESS_PENDING`; `http-run-report.test.ts` |
| MASKED_RECOVERY | 70 | `RUN_RECOVERY_REQUIRED: Runtime ownership could not be recovered; finish/project replacement cannot forget retained Runs...` w transition/close; wcześniejszy błąd może zostać zamaskowany |
| BASELINE_MISSING | 33 | `Pinned e982 baseline source required` / `Pinned e982 source required`: 31 razy fixture-child + 2 legacy-empty-child; brak `PAIRCOACH_IDENTITY_BASELINE` |
| VM_CONTEXT | 2 | `disableNativeCompletionProviders is not defined` oraz `retiredModelsRef is not defined` w **wyekstrahowanym callbacku uruchamianym przez node:vm** |
| CSS_IMPORT | 1 | `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".css"` przy imporcie Monaco w Node; `lightweight-editor/words.test.ts` |
| GENERATOR_BYTES | 3 | `ERR_ASSERTION` porównania generatora: LF kontra CRLF zamrożonych plików; config, descriptors i java27-exact |
| FACADE_BYTES | 2 | Marker z `\n` nie znajduje CRLF oraz inny hash parseJUnit; `runner-facade/boundary.test.ts` |
| JDT_ASSERTION | 1 | `ERR_ASSERTION: null !== '27.0.1.0.2'`: stary wymóg `language.serverJvm` w `runtime-adapters/java27-exact.test.ts` |
| FAKE_DOCKER_JSON | 1 | `SyntaxError: Unexpected end of JSON input` w observeEngine; kontrolowany fake Docker w `prepare-phase.test.ts` nie zwrócił JSON dla bieżącej ścieżki |
| FAKE_EXPORT | 1 | `SyntaxError: ...runtime-prepare.mjs does not provide an export named 'beginDockerCommand'`: podstawiony moduł w prepare-orchestration-counter |
| LEGACY_CHECKPOINT_SIGKILL | 4 | `ERR_ASSERTION: 'SIGKILL' !== null` w historycznych przypadkach REQUIRED private pipe; zadziałał własny 20-sekundowy kill harnessu |
| RETENTION_BYTES | 2 | `ERR_ASSERTION`: hash pliku retention z CRLF kontra zatwierdzony hash LF |
| REMAINDER_REGEX | 1 | Top-level `ERR_ASSERTION: exact image guard located`; wrapper raportuje `ERR_TEST_FAILURE: test failed`. Regex szuka starego `check(values.length...)`, obecny kod ma `check(Array.isArray(values) && values.length...)` |
| TIMEOUT | 3 | Po jednym `Child timeout:`, `Timeout: server ready`, `observation timeout`; sama końcowa obserwacja nie dowodzi jednej przyczyny |
| CLI_EARLY_EXIT | 1 | `ERR_TEST_FAILURE: child exited before marker`; `runtime-prepare-cli/control.test.mjs` |
| ADMISSION_FENCE | 1 | `ERR_ASSERTION: true !== false` dla `reconciliationRequired` po pierwotnym Run; `lightweight-live-run-admission/http-budget.test.ts:39` |
| ANCESTRY | 1 | `RECOVERY_REQUIRED: Private snapshot/recovery ancestry changed; preserve its material.` w negatywie cooperative-topology |
| **SUMA** | **244** | Każdy przypadek policzony raz |

**a) Uprawnienia:** dokładnie **12 jawnych odmów prywatności magazynu**, nie „244 od umask”. Guard `SnapshotStorage.privateAuthority()` w `SnapshotStorage.ts:144–151` sprawdza zarówno `(stat.mode & 0o077)`, jak i UID. Log nie wypisuje mode/UID każdej ścieżki, więc dosłownego `0755` nie można dowieść dla wszystkich dwunastu wyłącznie komunikatem. Pominięte `umask 077` i precreate katalogów bez mode są wykazaną przyczyną rodziny problemów; dodatkowe takie błędy mogły zostać przykryte przez grupę 70 cleanup. **Nie wolno dopisać tych 70 do 12 jako potwierdzonych 0755.**

**b) Stare fixture/start/readiness:** jawnie **75 + 29 + 1 = 105**. To trzy rozłączne grupy. W szczególności await listen nie jest kosmetyką: wcześniejszy odczyt `app.workspace` trafia w `currentCore()` i poprawnie zwraca PROJECT_INITIALIZING. Brak baseline e982 daje osobne 33, a nie dodatkowe awarie storage.

**c) Wycofane LSP:** **1 bezpośrednio wykazany przypadek starej asercji JDT `serverJvm`**. Dwa ReferenceError z VM **nie są testami wycofanego LSP**: obie nazwy istnieją w produkcyjnym `EditorPanel.tsx`. Cztery SIGKILL dotyczą starego kontrolera przygotowania/ROOT pipe, nie dowodzą awarii usług językowych. Pozostałe testy z dawnych katalogów mają mieszane kontrakty; nie klasyfikuję ich hurtowo jako usuwalne. Patrz §13.5.

**d) Ile jest rzeczywistych bugów produkcyjnych?** Z tych materiałów **nie da się rzetelnie wyprowadzić jednej liczby**: liczba FAIL, liczba przyczyn i liczba wad produktu to różne wielkości. Nie nazywam wszystkich guard refusals błędami guardów. Dwa konkretne problemy wymagają uwagi w produkcyjnym kodzie:

- **Maskowanie błędu startup przez cleanup** jest wykazane w źródle: `listen().catch(async error => { await close(); throw error; })` (`http.ts:1007`), a `close()` wywołuje `stopRuntimeForTransition(false)` (`1017`). Ten rzuca `RUN_RECOVERY_REQUIRED` (`612–613`), jeśli nie ma runtimeExecution lub binding ma runtimeError. Wtedy pierwotny wyjątek nie zostaje ponownie rzucony. W logu jest **70 końcowych wystąpień tego kodu**, ale bez zachowanego pierwotnego wyjątku nie da się wykazać, że każde z nich było wyłącznie maskowaniem albo osobnym bugiem. Rozkład tych 70 jest poniżej.
- **1 aktywny test zachowania admission** (`http-budget.test.ts:39`) kończy się nieoczekiwanie `reconciliationRequired=true` po oczekiwanym rozliczeniu Run. To konkretny sygnał regresji używanej ścieżki klienta, nie stary wymóg LSP. Kod i ślad GUI ujawniają mechanizm opisany w §13.2. Bez ponowienia na poprawnie przygotowanych fixture nie zamieniam tego w dowód jedynej przyczyny każdego podobnego FAIL.

Timeouty, ancestry i early-exit pozostają przypadkami wymagającymi dalszego rozstrzygnięcia. **Nie ogłaszam „173 fixture + 71 potwierdzonych bugów” ani innej sztucznej sumy pierwotnych przyczyn.** To przekraczałoby zawartość dowodów.

Pliki z 70 końcowymi `RUN_RECOVERY_REQUIRED`:

| Plik testu | FAIL |
| --- | ---: |
| `tests/backend-cutover/http-startup.test.ts` | 1 |
| `tests/client/finish-network-unknown.test.ts` | 1 |
| `tests/client/finish-snapshot-cache.test.ts` | 12 |
| `tests/integration/g3-async-public.test.ts` | 3 |
| `tests/integration/g3-corrections.test.ts` | 7 |
| `tests/integration/g3-public.test.ts` | 15 |
| `tests/integration/ledger-public-failure.test.ts` | 5 |
| `tests/integration/report-history-p1.test.ts` | 2 |
| `tests/lightweight-backend/handshake-readiness.test.ts` | 12 |
| `tests/readiness-capture-interleaving/interleaving.test.ts` | 12 |

**Dodatkowy dowód CRLF bez uruchamiania testów:** odczytany retention script ma raw SHA `21f749fa…5ac31`; po samym przeliczeniu bajtów z CRLF→LF daje dokładnie oczekiwany `19e2c8b7…9eaed7`. Wycięte parseJUnit po normalizacji daje dokładnie golden `29bffb52…d5450`. W logu generatorów porównano Buffer(19924) z Buffer(20702), a w config oba warianty timeoutu mają 900000 — różnią się końcami linii. To nie jest zgoda na zmianę goldenów ani osłabienie ochrony źródeł; kodu nie modyfikowano.

#### Czy dwa niescalone commity pomagają konkretnym FAIL?

Tak, **statycznie adresują rozpoznane przyczyny w plikach zawierających łącznie 34 czerwone przypadki**. Nie dowodzi to 34 naprawionych testów: żadnego nie ponowiono, a po usunięciu pierwszej przeszkody mogą ujawnić się następne.

| Checkpoint | Plik / liczba czerwonych przypadków z logu | Co zmienia |
| --- | --- | --- |
| `158881b` | `tests/client/finish-network-unknown.test.ts`: **1**; `tests/client/finish-snapshot-cache.test.ts`: **12**; `tests/client/header-start.test.ts`: **1**; `tests/client/presence.test.ts`: **7**; `tests/client/real.test.ts`: **2**; `tests/coach/codex-provider.test.ts`: **2**; `tests/core/rename-http.test.ts`: **1**; `tests/core/rename-lossless.test.ts`: **2**. Łącznie **28** | Canonical dataDir w 8 plikach; w codex-provider dodatkowo await listen i jawne ustawienia V2/consent przez istniejący transport. |
| `8099dea` | `tests/backend-cutover/http-run-report.test.ts`: **1**; `tests/client/finish-unknown.test.ts`: **1**; `tests/client/proposal-unknown.test.ts`: **4**. Łącznie **6** | 3 pliki: measured GET przed canRun; child await listen przed workspace/hook; canonical dataDir. Obserwacja finish-unknown miała timeout bez stderr, więc to powiązanie źródłowe, nie dowiedziona naprawa konkretnego timeoutu. |

Oba commity są zachowane jako checkpointy, nie są scalone. Asercje i progi zachowano w diffie; **wynik po poprawkach NOT_RUN**, a nie PASS. Nie rozwiązują wszystkich 244 przypadków, np. 33 baseline, CRLF i obu VM-context.

### 13.2. Dlaczego drugi Run Tests został zablokowany

Źródło: [RuntimeClientV2.ts w 257e90b8](https://github.com/biosquawk/pairCoding/blob/257e90b838abec4e9b332385c71f1be8201fc013/src/services/RuntimeClientV2.ts#L97), funkcje `applyProject`, `matchesPendingRunProject`, `perform`, `requiresReconciliation`.

Istotny, **istniejący** wycinek kodu (`126–137`):

```ts
// Only TESTS canRun/problem are neutral presentation metadata for pending MAIN.
// Pending TESTS retains its original strict equality.
if (pending.request.mode !== 'RUN_MAIN') return equal(value, pending.project);
const tests = pending.project.capabilities.execution.modes.RUN_TESTS;
// ... tworzenie observed z przywróconymi tests.canRun / tests.problem ...
return equal(observed, pending.project);
```

Łańcuch prowadzący do trwałego fence:

1. `run()` (`283–286`) zapisuje oryginalny request, authority i kopię projektu w `pendingRun`; callback dispatch w `perform()` (`244–248`) dodaje ten request do `unresolved` z `inFlight=true`.
2. `applyProject()` (`99–102`) oblicza `own = matchesPendingRunProject(...) && equal(authority,...) && matchingRun`, następnie **`pending.valid &&= own`**. Jedna niezgodna obserwacja trwale zatruwa tę próbę. Kolejny poprawny snapshot nie przywraca valid.
3. Dla pending TESTS pełne `equal(value, pending.project)` traktuje również pochodną gotowość `canRun/problem` jako niezmienną tożsamość żądania. Dopływ queued snapshot z własnym TESTS PREPARE_REQUIRED może więc zatruć oryginalne przyjęcie, choć runId/mode/config/workspace są nadal właściwe.
4. Po oryginalnym HTTP202 `perform()` (`250–252`) wymaga zgodnej revision lub `ownsPendingRunObservation()`. Zatrute `pending.valid=false` obala ten wyjątek. Alternatywnie sam accept w `run()` (`293–294`) odrzuca `!admission.valid`. W obu ścieżkach catch nie usuwa unresolved.
5. Usunięcie wpisu występuje wyłącznie w zaakceptowanej ścieżce (`255–256`) albo autoryzowanym reconcile. `finally` (`265–269`) ustawia `inFlight=false` i czyści pendingRun, ale **nie usuwa unresolved**.
6. `requiresReconciliation()` (`71–73`) widzi zachowany wpis dla projektu/klienta. `App.tsx:228` podmienia oba canRun na false, jeśli `reconciliationRequired`; `RuntimeStatusV2.tsx:16` i przyciski stosują te flagi. Dlatego nowe READY nie wystarcza do kolejnego Run. Zwiększanie timeoutu nic tu nie naprawia.

**Zgodność z istniejącym śladem 257e:**

| UTC | Dowód |
| --- | --- |
| 05:05:28.365 | Rozpoczęcie oryginalnego POST TESTS w trace.network |
| 05:06:02.107 | Snapshot: ten sam session/project, workspace5/controlEpoch0, własny Run `1d34e540...` QUEUED; runtime READY, TESTS canRun=false/PREPARE_REQUIRED |
| 05:06:06.127 | Własny Run przechodzi RUNNING; oryginalna odpowiedź 202 dotarła w tym przedziale, przed edycją |
| 05:06:15.782 | Faktyczne zakończenie FAILED; JUnit 1 test/1 failure |
| 05:06:21.548 / .636 | CODE_CHANGED poprawki i jej oryginalny ACK, workspace6 |
| 05:06:28.958 | Snapshot tego samego FAILED, workspace6, runtime READY i oba canRun=true |
| końcowe 30 s | Playwright: 62 odczyty przycisku nadal disabled, mimo powyższej gotowości |

Mechanizm jest wykazany w kodzie i zgadza się z przejściami śladu. **Ślad nie zrzuca bezpośrednio wartości prywatnej zmiennej pending.valid ani wszystkich pól zamknięcia pendingRun.** Nie nazywam odczytu źródła instrumentowanym dowodem wykonania każdej gałęzi; brakującej diagnostyki nie uzupełniam fikcyjnym logiem. Oryginalne 202 i późniejszy terminal nie mogą samodzielnie omijać kontroli requestId/authority.

**Dlaczego 833ffe tylko MAIN?** To nie domysł o roztargnieniu wykonawcy: TASK **`32c248f3-1ae2-47d9-ab73-70c5aabb3bed`** zlecał wprost „metadata-only TESTS readiness podczas pending MAIN” i zachowanie selected MAIN semantics. Delivery/risks i komentarz kodu jawnie pozostawiają TESTS strict. Commit **`833ffe1801f615f815231aca096fe40023ad1658`** był wąską poprawką wcześniejszego scenariusza MAIN. Brak rozszerzenia odbioru na przejściowe metadane **własnego TESTS** jest luką zakresu/integracji; nie naprawiono jej samym przyjęciem 833ffe.

**Punkt przyszłej zmiany:** powyższy branch `if (pending.request.mode !== 'RUN_MAIN') return equal(...)` i normalizacja `canRun/problem` w `matchesPendingRunProject`, używana przez obie kontrole. Nie należy po prostu usuwać unresolved albo ignorować całego projektu. Ewentualna poprawka musi rozróżnić pochodną gotowość podczas już wysłanego, dokładnie skorelowanego Run od rzeczywistej zmiany settings/root/files/workspace/config/client/connection/controlEpoch i zachować trwałe poison po realnym drift. To wskazanie miejsca i kontraktu naprawy, **bez wdrożenia lub deklaracji przetestowanego patcha**.

### 13.3. Skąd 1 283 powiadomienia i wielokrotne work_id

Źródło Thalamusa: `4f2fea7c5c2551d65f6d271d1b23ac93412ce2a1`. Klasy poniżej są w `next-runtime`.

**a) `core/.../OwnerSources.java`, `notifyWorkers(String input)`, linie 432–478.** Wywołują ją m.in. `nativeInput()` i `humanReply()` (`410–430`). Kluczowe elementy:

```java
for (var task : store.rows(
    "SELECT * FROM tasks WHERE state NOT IN ('ACCEPTED','CANCELLED')")) {
    if (!rootsForWork(work).contains(selected)) continue;
    String id = "source-update:" + Invocation.hash(input + "\0" + role + "\0" + work);
    // INSERT OR IGNORE ... recipient=assignee, kind=QUESTION
    // content="Owner source updated for " + work + ...
}
```

**To nie jedna wiadomość na rolę i nie bezwarunkowy broadcast do całego zespołu.** Powstaje jedna wiadomość na kombinację **input × rola × niezamknięty work**, tylko dla właściwego korzenia źródła. RESULT_READY i RECEIVED nadal przechodzą filtr. Set zwracany z metody deduplikuje role do wybudzenia, lecz nie wiadomości — identyfikator zawiera work. `INSERT OR IGNORE` blokuje powtórkę tej samej trójki, nie kilku starych zadań tej samej roli.

Dodatkowy odczyt bazy daje **67 różnych Updated input**, po **6–28 wiadomości**. W oknie były 66 wejścia HUMAN, ale 6 powiadomień odnosi się do **starego** źródła `c9056c9f-1f24-4b02-93d0-f9197b3d115e` z 12.11 10:22:03.162. Dlatego iloraz 1283/66 w §5 jest wskaźnikiem natężenia, **nie dosłownym rachunkiem 66 identycznych broadcastów**. Liczba open works i późne wiązanie źródeł są potrzebne do wyjaśnienia wyniku.

| Odbiorca | Powiadomienia |
| --- | ---: |
| P1_4 | 81 |
| P3 | 240 |
| P2_4 | 66 |
| P1_3 | 6 |
| P1_2 | 97 |
| P4 | 164 |
| P6 | 152 |
| P5 | 92 |
| P1 | 48 |
| P2 | 258 |
| P2_3 | 70 |
| P2_2 | 9 |

**b) `runtime/.../SessionRuntime.java`, `bindTurnWork(...)`, linie 1032–1066.** `executeTurn()` wywołuje ją po INSERT turns (`787`). Dla zwykłej tury SQL brzmi:

```sql
INSERT INTO turn_work SELECT ?,work_id,execution_id FROM tasks
WHERE assignee=? AND state NOT IN ('ACCEPTED','CANCELLED')
```

Nie ma wyboru tylko nowego inbox/current task. Wszystkie historyczne taski tej roli, które nie osiągnęły ACCEPTED/CANCELLED, trafiają do kolejnej tury, także RESULT_READY. Osobna ścieżka `RECOVERY:` kopiuje ograniczony zestaw z poprzedniej tury po zgodnym execution; reminder-recovery zachowuje zwykłe wiązanie. K jako manager nie dostaje automatycznie worków pracowników — stąd dużo jego tur bez taskowego przypisania.

**Korekta jednostki:** **4 897 to próby dostawcy**, nie 4 897 tur. Są związane z **788 różnymi calls.turn** w grupie MULTI. Pozostałe grupy: 244 próby/26 turn SINGLE i 1 115 prób/136 turn NONE. Liczby nie muszą równać się licznikom TurnStarted w oknie: turn może zacząć się przed oknem, a jedna tura wykonywać wiele odpowiedzi dostawcy.

Powiązanie ma również ścieżkę kontekstową: `SessionRuntime.contextInput()` (`1142–1164`) pobiera worki z turn_work oraz nieprzeczytanego inbox, następnie `TaskTransportService.contextInputs()` (`51…`) dołącza odpowiednie TASK/input. Zapytanie pamięci jest ograniczone do 4096 znaków, więc sam INSERT w turn_work **nie jest dowodem nieograniczonego kopiowania całej historii do pojedynczego promptu**. Wiele tasków, wiadomości i tur wywołuje powtarzane odczyty/konsolidacje; to wykazany mechanizm narzutu. Nie da się jednak z samego SQL przypisać konkretnej liczby zaoszczędzonych tokenów ani dowieść, że odpowiada za całe 108 mln P2. **108 mln to suma wejść przez 8 godzin, nie rozmiar jednego kontekstu.**

### 13.4. Osiem incydentów JUDGE — dokładne wyzwalacze i utracony wyjątek

Odczytano wszystkie **16 payloadów events** i odpowiadające im `incidents.evidence.detail_code`. Każda para ma `schema=thalamus.log/1`, `run_id=operation_id=ID incydentu`, `source=Watchdog`, `target=JUDGE`, `layer=Supervision`. Otwarcie ma `phase=start` i reason jak niżej; failure ma zawsze `phase=fail`, **`reason=INCIDENT_ANALYSIS_UNRESOLVED`**. Wszystkie 8 rekordów incydentów ma status ESCALATED.

| Incydent / sekwencje open→fail | Europe/Warsaw open→fail | Rola / work_id | Trigger / detail_code |
| --- | --- | --- | --- |
| `63919bfa-fff7-4c36-9d07-566f7263e0fe` / 88116→88118 | 00:51:30.503 → 00:51:30.556 | P1 / `paircoach-lightweight-real-selection-v2-fixture-alignment` | `DECLARED_FILE_UNAVAILABLE` / `MISSING_FILE` |
| `bc5d994d-170b-400c-b96d-bda2baee5542` / 90280→90281 | 01:27:13.250 → 01:27:13.269 | P2 / `paircoach-ac027-veto-browser-ack-path-diagnosis` | `TURN_REQUIRES_RECONCILIATION` / `TRANSPORT_LIMIT` |
| `264a3d6b-8df0-42b9-ae0c-1957f86125b2` / 90521→90522 | 01:30:03.613 → 01:30:03.631 | P2 / `paircoach-ac027-veto-browser-ack-path-diagnosis` | `AUTOMATIC_RECOVERY_UNRESOLVED` / `RECOVERY_ATTEMPTS_EXHAUSTED` |
| `77ed3a36-b4ea-4fd2-8de4-a81d72ad1f6a` / 91389→91390 | 01:40:37.676 → 01:40:37.688 | K / `(brak work)` | `TURN_REQUIRES_RECONCILIATION` / `TURN_UNSETTLED` |
| `4eb2898f-d468-411a-916b-317168e2a0fa` / 92771→92772 | 02:13:30.188 → 02:13:30.206 | K / `(brak work)` | `TURN_REQUIRES_RECONCILIATION` / `TURN_UNSETTLED` |
| `65f127fa-64ef-41c8-9f19-95e5eaf59b6a` / 96320→96321 | 03:54:17.837 → 03:54:17.882 | K / `(brak work)` | `TURN_REQUIRES_RECONCILIATION` / `TURN_UNSETTLED` |
| `7215d865-479d-4769-8cb1-256de6cb1067` / 99314→99316 | 04:43:29.243 → 04:43:29.371 | P1_4 / `paircoach-lightweight-27e-java-run-reconciliation-ro-diagnosis` | `TURN_REQUIRES_RECONCILIATION` / `TURN_UNSETTLED` |
| `9527243e-7e49-4c2f-bf92-1f7c43aad874` / 101014→101015 | 05:14:49.657 → 05:14:49.672 | K / `(brak work)` | `TURN_REQUIRES_RECONCILIATION` / `TURN_UNSETTLED` |

Wyzwalacze: 1 deklaracja niedostępnego pliku, 6 nierozliczonych tur (P2, 4×K, P1_4), 1 wyczerpanie prób automatycznego recovery P2. Detail_code są z evidence, nie dorobioną interpretacją.

**Konkretny wyjątek analizy nie został utrwalony.** `WatchdogAndVenetianJudge.analyze()` (`427…`, catch `474–498`) robi:

```java
} catch (Exception ex) {
    if (ex instanceof Failure f && f.code().equals("ROLE_BUSY")) {
        // requeue, nie JudgeAnalysisFailed
        return;
    }
    // UPDATE incidents SET status='ESCALATED'
    journal.record("JudgeAnalysisFailed", /* ... */ "fail",
                   "INCIDENT_ANALYSIS_UNRESOLVED");
}
```

Catch odrzuca class/message/stack/cause wyjątku. `incidents` też nie ma pola przechowującego exception. W sąsiednich zdarzeniach nie zapisano szczegółowego błędu JUDGE. W badanym oknie nie ma ani prób calls JUDGE, ani utrwalonych turns JUDGE: błąd występuje przed zapisem nowej tury, a nie jako udowodniona semantyczna odpowiedź modelu. Z tego **nie wynika**, czy przerwanie było spowodowane startem sandboxa, poświadczeniami, profilem lub innym wyjątkiem przed wywołaniem dostawcy. Kod ROLE_BUSY ma osobną ścieżkę i nie wyjaśnia tych ośmiu failure events. `EMPTY_JUDGE_CORRECTION` istnieje w kodzie po uzyskaniu wyniku tury, ale przy braku zapisanej tury nie jest wyjaśnieniem potwierdzonym dla tych ośmiu zdarzeń.

Nie przypisuję więc zmyślonego `ROLE_PAUSED`, `MODEL_AT_CAPACITY` ani błędu narzędzia jako „konkretnego wyjątku”. **Konkretny utrwalony błąd to tylko INCIDENT_ANALYSIS_UNRESOLVED; pierwotny wyjątek UNKNOWN z powodu utraty diagnostyki.** To wykazana luka obserwowalności, nie brak odczytu tych 16 payloadów. Ich oczyszczone dokładne wartości są w [followup-technical-evidence.json](docs/audit/20261113-night/followup-technical-evidence.json).

### 13.5. JS-first native paste i dwa ReferenceError

Źródło: P2 `paircoach-lightweight-27e-final-editor-ai-gui/artifacts/ts-editor-final257e-01/runner.log` oraz proof `editor-integrated-js-first-a0237-nal-ACK-Undo---cold-refresh/proof.json`. To próba **257e**, nie wcześniejsza diagnoza TS.

Dokładna różnica z Playwrighta w `harness/editor.spec.mjs:37:69`:

```text
Error: expect(received).toMatchObject(expected)
Object {
  "available": true, "collapsed": true, "end": true, "focused": true,
- "value": "void workerProofAl",
+ "value": "",
}
Call Log: Timeout 5000ms exceeded while waiting on the predicate
```

Poprzedni krok zapisał clipboard, ustawił focus, nacisnął Ctrl+A i **potwierdził rzeczywistą selekcję całych 194 znaków źródła**. Następnie wysłano Ctrl+V i Ctrl+End. Nie uzyskano oczekiwanej końcowej zawartości natywnej textarea. Skrypt przerwał się **przed Ctrl+Space**, a w śladzie było **0 wysłanych CODE_CHANGED**. To porażka dostarczenia/zaobserwowania edycji na tej ścieżce, nie wynik zapytania completion.

Co da się rozstrzygnąć:

- **Brak focusu:** nie potwierdza go log; focus był true przed i podczas końcowej asercji. Nie wolno podać „nie miał fokusu” jako przyczyny.
- **Bootstrap:** przed paste harness zapisał „JS worker actual ON then first TS model ON”; proof pokazuje właściwy URI `main.ts`, zasoby workerów i 0 pageerrors. Nie ma dowodu prostego „czekał jeszcze na bootstrap”.
- **readOnly Monaco:** ślad nie rejestruje `editor.getOption(readOnly)` w chwili paste. STUDENT w komunikacie kontrolnym nie jest pomiarem tej opcji. Nie da się uczciwie rozstrzygnąć readOnly, obsługi clipboard, opóźnionej zmiany modelu lub innej przyczyny na podstawie pustej textarea i braku CODE_CHANGED. Sam tekst textarea również nie jest pełnym zrzutem modelu Monaco.

**Przyczyna głębsza pozostaje UNKNOWN.** Znany jest dokładny krok, asercja, stan focusu i brak wysłanej edycji. Nie przeprowadzano ponownego testu ani nowej instrumentacji w tym uzupełnieniu.

**`retiredModelsRef` nie jest wycofanym serwerem LSP.** W produkcyjnym `EditorPanel.tsx:83` nadal istnieje `useRef(new Set<ITextModel>())` do wycofywanych modeli. `disableNativeCompletionProviders` jest importowane z lokalnego bridge (`10`) i używane przy mount (`112`). Test `tests/triage/browser-client-fix.test.ts` wycina tekst callbacku z komponentu i wykonuje go przez `vm.runInNewContext` (`19`, `130`) w ręcznie zbudowanym kontekście, w którym obu nazw brakuje. Stąd dokładnie **2 ReferenceError w testowym VM**, bez dowodu ReferenceError w działającym bundle. Nie usuwać ich automatycznie jako „starego LSP”; test nadal dotyczy aktywnych gwarancji lifetime/switch/Undo, ale jego kontekst nie nadążył za kodem.

### 13.6. Na jakiej podstawie uruchomiono więcej ról + HOURLY

W bazie są następujące konkretne wpisy HUMAN→K. Są to **wejścia operatora przekazujące decyzje właściciela**, a nie dowód, że właściciel sam wpisał je bezpośrednio w UI Thalamusa.

| Europe/Warsaw | message_id | Decyzja |
| --- | --- | --- |
| 12.11 10:22:03.162 | `c9056c9f-1f24-4b02-93d0-f9197b3d115e` | Początkowy Lightweight: K + dokładnie P1 BE + P2 FE; repliki zabronione, P3–P6 do finału |
| **12.11 10:49:51.870** | **`6238031a-7dbb-4179-b90a-6031511f2deb`** | **Nadrzędna korekta**, cytująca „pracujecie wszystkimi agentami, bez subsetP1/P2?” i „wylacz ograniczenia ról…”; jawnie znosi K+1BE+1FE i limit 4 instancji; dopuszcza rozłączne repliki i P3–P6 |
| 12.11 13:21:14.776 | `393ee9a0-4060-427e-8762-7ba7b2b569ae` | Potwierdza lepszą dystrybucję i repliki, ale ciężkie P5/P6 dopiero na kandydacie; jedna integracja i Lightweight nadal obowiązują |
| 12.11 21:07:51.115 | `44b050f2-8a9a-4531-bf30-f7788a664f63` | Po WSL: każda używana rola odzyskuje swój stan, sprząta własne zasoby i wraca do PairCoach |
| 13.11 02:58:59.688 | `2b288f8f-b6f8-4941-8f7e-c3fd47d5661a` | Finał na 27e: P4 paczka, P3 runtime GUI, P2 edytor/AI, P5/P6 celowane końcowe przeglądy; odblokowanie po TASK |

Zatem rozszerzenie składu **miało jawną podstawę**, nie było samo w sobie nieposłuszeństwem wobec nadal obowiązującego K+1BE+1FE. To **nie zwalnia ROOT/K z odpowiedzialności za sposób użycia równoległości**, starych tasków, kosztów i brak końca. Późniejsze ograniczenie P6 do bramki końcowej także pozostawało wiążące; nazwa roli i jej użycie do własnego cleanup nie dowodzą, że pełniła rolę drugiego kierownika.

#### HOURLY 00:00–08:00 — zapis bezpośrednio w raporcie

Strefa Europe/Warsaw. Wiersz 08 obejmuje tylko **08:00–08:51:06.800 STOP**. Ponieważ pytanie żąda godzin od 00:00, tabela obejmuje **00:00 → STOP**, tj. 8 h 51 min, a nie dokładne osiem godzin §2. Osobno pokazano input/output i cached obu obserwowanych kanałów; koszt produktu Coach E2E nadal poza rachunkiem. Cached nie dodawać drugi raz.

| Godzina | Próby Thalamus / UNKNOWN | Thalamus input | w tym cached | Thalamus output | ROOT input | w tym cached | ROOT output | Znane razem I+O |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 00:00–00:59 | 1 624 / 0 | 119 716 363 | 28 001 920 | 538 561 | 39 747 443 | 39 345 664 | 96 564 | 160 098 931 |
| 01:00–01:59 | 1 249 / 2 | 95 698 333 | 24 855 296 | 418 993 | 49 335 263 | 48 498 944 | 106 432 | 145 559 021 |
| 02:00–02:59 | 837 / 1 | 65 475 124 | 15 111 040 | 375 262 | 32 129 814 | 31 731 456 | 95 121 | 98 075 321 |
| 03:00–03:59 | 733 / 2 | 64 792 150 | 20 246 528 | 337 858 | 33 062 025 | 32 756 352 | 85 681 | 98 277 714 |
| 04:00–04:59 | 1 514 / 2 | 127 189 864 | 27 948 160 | 699 509 | 36 677 999 | 35 532 288 | 113 831 | 164 681 203 |
| 05:00–05:59 | 1 015 / 1 | 80 129 625 | 17 787 904 | 435 236 | 35 219 101 | 34 979 584 | 100 978 | 115 884 940 |
| 06:00–06:59 | 450 / 99 | 25 069 181 | 5 742 976 | 146 466 | 11 204 514 | 11 041 024 | 25 143 | 36 445 304 |
| 07:00–07:59 | 108 / 108 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 08:00–08:51 (STOP) | 100 / 82 | 1 238 554 | 178 176 | 5 703 | 3 419 705 | 3 404 928 | 2 137 | 4 666 099 |
| **SUMA** | 7 630 / 297 | 579 309 194 | 139 872 000 | 2 957 588 | 240 795 864 | 237 290 240 | 625 887 | **823 688 533** |

07:00 ma 108 prób UNKNOWN z usage NULL. Zapis „0 znanych tokenów” **nie oznacza potwierdzonego zera kosztu ani braku prób**. Tabela ROOT powstała wyłącznie z istniejących token_count: powtórzone cumulative pominięto, a przyrost uzgodniono z last_token_usage; nie eksportowano treści sesji.

**Stan po uzupełnieniu pozostaje STOP / 14 PAUSED / wydanie NO-GO.** To dokładniejsze rozpoznanie i publikacja raportu; nie wznowienie implementacji ani obietnica naprawienia znalezionych problemów.

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
