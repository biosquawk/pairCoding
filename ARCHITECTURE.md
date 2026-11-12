# PairCoach — Manifest Executable & Living Architecture

> Chronimy prostotę produktu przez sprawdzalne granice,
> a nie przez rozbudowę procedur i infrastruktury nadzorczej.

## Cel manifestu

PairCoach pomaga człowiekowi ćwiczyć programowanie w jednym edytorze,
z Trenerem AI, prawem weta oraz rzeczywistym uruchamianiem kodu i testów.

Architektura ma wspierać ten cel. Nie jest osobnym produktem.

„Executable” oznacza, że istotne reguły mają działające sprawdzenia
w kodzie, testach lub procesie przyjmowania zmian.

„Living” oznacza, że decyzje, kontrakty i dotyczące ich testy zmieniają się
razem z implementacją — w tej samej zmianie, a nie po zakończeniu projektu.

Manifest opisuje kierunek PairCoach Lightweight.
Nie zleca przebudowy Thalamusa ani tworzenia platformy do zarządzania architekturą.

---

## 1. Działający przepływ użytkownika przed rozbudową mechanizmów

Jednostką postępu jest działający scenariusz, nie liczba klas,
agentów, dokumentów, testów jednostkowych ani zaakceptowanych dostaw.

Dla wykonywania zadania podstawowym scenariuszem jest:

    Edycja → potwierdzony zapis → Run/Test → rzeczywisty wynik → Stop

Nowy mechanizm musi pomagać zrealizować taki scenariusz,
chronić istniejącą gwarancję albo usuwać wykazany problem.

Nie dodajemy warstwy „na przyszłość”, jeżeli nie ma obecnego użytkownika
tej warstwy ani konkretnego problemu, który rozwiązuje.

Najpierw integrujemy najmniejszy użyteczny przebieg.
Następnie rozszerzamy go o kolejne przypadki.

Test izolowanej klasy może potwierdzić poprawność klasy.
Nie potwierdza, że aplikacja rzeczywiście jej używa.

---

## 2. Rozdzielamy intencję, implementację i dowód

Nie istnieje jeden plik, który zastępuje wszystkie źródła prawdy.

**Intencja — co ma obowiązywać:**
aktualne, zaakceptowane decyzje właściciela, wymagania i ten manifest.

**Implementacja — co obecnie zbudowano:**
kod, konfiguracja i kontrakty w rozpatrywanej rewizji repozytorium.

**Dowód — co rzeczywiście sprawdzono:**
wynik konkretnego testu lub przebiegu, wraz z rewizją i środowiskiem.

Kod nie staje się poprawnym wymaganiem tylko dlatego, że już istnieje.
Dokument nie dowodzi działania tylko dlatego, że ma status „Ready”.
Wygenerowana mapa zależności pokazuje stan kodu, ale go nie zatwierdza.

W przypadku konfliktu ujawniamy konkretną rozbieżność.
Nie dopasowujemy po cichu zasad do implementacji.

Historyczne specyfikacje i raporty pozostają historią.
Nie przywracają wymagań uchylonych późniejszą decyzją właściciela.

Agent pracuje na kontekście właściwym dla aktualnej gałęzi i zadania.
Nie dostaje automatycznie całego archiwum projektu.

---

## 3. Granice mają chronić odpowiedzialności, nie nazwy katalogów

Zachowujemy istniejącą aplikację i jej podział na porty i adaptery.
Nie reorganizujemy całego repozytorium tylko po to, aby wyglądało
jak podręcznikowy diagram.

| Obszar | Odpowiedzialność | Niedozwolone pomieszanie |
|---|---|---|
| GUI i integracja Monaco | Edycja, prezentacja stanu, interakcje użytkownika | Polecenia Maven/pip/Docker i wybieranie sposobu wykonania według języka |
| Wspólna logika sesji i uruchomień | Kontrola zapisu, weto, lifecycle, wyniki | Szczegóły konkretnego toolchainu |
| TaskRuntimeAdapter | Plan wykonania właściwy rodzinie zadania i interpretacja wyniku | Sterowanie komponentami GUI lub omijanie WriteGate |
| DockerExecutor | Wykonanie planu, wyjście, zatrzymanie i zasoby kontenera | Reguły ćwiczenia i zachowanie edytora |
| Miejsce składania aplikacji | Wybór i połączenie implementacji | Rozprowadzanie wyboru technologii po całym kodzie |

Rdzeń korzysta z portów. Konkretne implementacje łączymy przy składaniu aplikacji.

Kolejna wersja JDK jest przede wszystkim konfiguracją.
Nowa rodzina języka może wymagać adaptera.
Żadna z tych zmian nie uzasadnia dopisywania osobnego mechanizmu sesji,
autosave, weta czy zakładek.

Spring Boot pozostaje wariantem zadania Java/Maven.
Nie wymaga osobnej architektury GUI.

Dozwolona jest wiedza o języku tam, gdzie jest potrzebna:
w adapterze wykonania, katalogu profili i lokalnej konfiguracji edytora.
Nie zakazujemy słowa „java” w całym repozytorium.
Zakazujemy przenoszenia odpowiedzialności w niewłaściwe miejsce.

Kontrakty współdzielone przez frontend i backend utrzymujemy wspólnie.
Nie tworzymy obok nich drugiego, ręcznie przepisywanego modelu API
wyłącznie dla dokumentacji.

---

## 4. Edytor pozostaje niezależny od ciężkiego wykonania

Pisanie, zaznaczanie, Undo/Redo i weto nie czekają na przygotowanie
obrazu, instalację zależności ani kompilację projektu.

W wariancie Lightweight pomoc językowa działa lokalnie w przeglądarce.
Nie przywracamy kontenerowego LSP, shadow workspace ani indeksowania
zależności przy edycji pod inną nazwą.

Dla Java/Python lokalne podpowiedzi słów lub statyczne sugestie
nie są przedstawiane jako pełne semantyczne rozumienie projektu.
Interfejs pokazuje rzeczywiste możliwości, nie aspiracje implementacji.

Ta zasada nie wyłącza autosave, transportu stanu widoku ani istniejącej
polityki Trenera AI. Wyłącza dodatkową ciężką ścieżkę usług językowych.

Akceptacja każdej podpowiedzi nadal podlega prawu zapisu ucznia.
Po rozpoczęciu przejmowania kontroli przez trenera stara podpowiedź
nie może zmienić modelu.

Niedostępny Docker blokuje wykonanie zadania, nie ręczną edycję
ani odzyskanie pracy użytkownika.

Kontenery zadań uruchamiamy w ramach jawnego prepare lub Run/Test,
nie wskutek zwykłego wpisania znaku.

---

## 5. Chronimy zachowania, nie tylko kierunek importów

### Zapis

Zapis ucznia przechodzi przez istniejący mechanizm WriteGate i ACK.
Nie dokładamy konkurencyjnego autosave.

Trener, completion i operacje plikowe nie otrzymują bocznej ścieżki,
która omija kontrolę własności, wersji lub projektu.

### Uruchomienie

Run/Test korzysta z izolowanego wejścia odpowiadającego potwierdzonemu
stanowi projektu. Kontener nie dostaje prawa modyfikowania oryginalnych
źródeł ucznia.

Dalsza edycja nie zmienia wejścia już trwającego uruchomienia.
Wynik pozostaje przypisany do właściwego runId i wersji wejścia.

Nie uruchamiamy narzędzi zadania na hoście jako ukrytego fallbacku.

Profil runtime określa środowisko wykonania.
Konfiguracja zadania określa, co uruchomić.
Parametry projektu, takie jak docelowy release, nie są po cichu
przepisywane dla uzyskania zielonego wyniku.

### Zatrzymanie

Stop dotyczy konkretnego uruchomienia i rzeczywistego kontenera.
Samo zamknięcie klienta Docker nie jest potwierdzeniem zatrzymania.

Brak potwierdzenia pozostaje stanem niepotwierdzonym.
Ponowienie nie tworzy nowej tożsamości operacji.

Dla Spring Boot gotowy endpoint HTTP nie oznacza zakończenia programu.
Działający serwer pozostaje RUNNING do zatrzymania lub wyjścia.

### Weto

Weto odbiera trenerowi prawo dalszych edycji.
Nie czeka na model AI, kompilator ani Docker.
Spóźniona odpowiedź nie przywraca odebranych uprawnień.

Stop programu i weto wobec trenera są odrębnymi operacjami.

### Wynik

PASSED oznacza rzeczywiście wykonane testy bieżącego uruchomienia.
Nie oznacza wyłącznie exitCode=0, obecności starego XML
ani raportu zawierającego same pominięte testy.

---

## 6. Reguły zamieniamy w sprawdzenia tam, gdzie to ma wartość

Wykorzystujemy istniejący test granic architektury, runner testów
i testy integracyjne. Nie budujemy własnej platformy fitness functions.

Poniższe identyfikatory mogą być używane w nazwach testów.
Nie wymagają osobnych dokumentów ani nowego frameworka.

| Reguła | Co sprawdzamy | Właściwy rodzaj dowodu |
|---|---|---|
| AC-ELA-001 — Rozdział odpowiedzialności | GUI i rdzeń nie zależą od szczegółów toolchainów; wybór implementacji nie wycieka do GUI | Istniejący test granic zależności, obejmujący rzeczywisty kod |
| AC-ELA-002 — Lekka edycja | Zwykła edycja nie uruchamia kontenerowego analizatora, przygotowania zależności ani kopii projektu dla LSP | Test zintegrowanej ścieżki edycji, obserwujący wywołania na granicy wykonania |
| AC-ELA-003 — Kontrola zapisu | Weto i przejęcie kontroli blokują także spóźnione edycje oraz akceptację podpowiedzi | Test interakcji Monaco, transportu i kontroli zapisu |
| AC-ELA-004 — Izolowane wykonanie | Run używa zatwierdzonego wejścia i nie zmienia oryginalnych plików | Test integracyjny oraz rzeczywisty przebieg Docker |
| AC-ELA-005 — Uczciwy lifecycle | Stop zatrzymuje właściwy kontener; niepewność nie daje sukcesu; wynik testów jest świeży | Testy negatywne i rzeczywisty przebieg wykonania |
| AC-ELA-006 — Dostępność edytora | Awaria runtime nie odbiera możliwości edycji i zachowania draftu | Test aplikacji z niedostępnym wykonawcą |

To rdzeń ochrony przed dryfem, a nie zamiennik pozostałych
zaakceptowanych testów produktu.

Sprawdzenie granic musi rozpoznawać rzeczywiste zależności,
a nie wyłącznie szukać zakazanych słów.
Zmiana nazwy klasy lub ukrycie importu za re-eksportem
nie może być sposobem obejścia reguły.

Test zachowania przechodzi przez używaną ścieżkę aplikacji.
Test samej niepodłączonej biblioteki nie wystarcza.

Kontrolowane zastępniki zależności są właściwe do szybkich testów.
Nie zastępują dowodu, że rzeczywisty Docker i GUI działają razem.

Reguła bez podłączonego sprawdzenia jest oznaczana jako nieweryfikowana.
Nie nazywamy jej „egzekwowaną przez CI”.

---

## 7. Weryfikacja nie może stać się następnym ciężkim podsystemem

Szybkie kontrole struktury i kontraktów uruchamiamy w zwykłej ścieżce
weryfikacji zmian. Nie uruchamiamy ich przy każdym znaku w edytorze
ani przy każdym starcie programu użytkownika.

W trakcie pracy dobieramy testy do zmiany.
Przed odebraniem wydania sprawdzamy uzgodnione scenariusze produktu
na zintegrowanym kandydacie.

Brak Dockera w sandboxie testującym oznacza brak właściwego środowiska
dla danego testu, nie awarię całego produktu.
Test wykonawczy przenosimy do środowiska z dostępem do daemona.
Nie oznaczamy niewykonanego testu jako PASS.

Nie wprowadzamy globalnych limitów liczby klas, plików, agentów
ani prób naprawy. Nie utożsamiamy przekroczenia arbitralnego czasu
przygotowania z błędem architektury.

Zachowujemy potrzebne ograniczenia zasobów, ochronę przed zawieszeniem,
możliwość anulowania oraz uzgodnione wymagania responsywności.
Timeout przygotowania środowiska nie jest timeoutem reakcji weta.

Nowe skanowanie, kopiowanie, trwały zapis lub blokada w częstej ścieżce
wymagają konkretnego uzasadnienia i sprawdzenia kosztu tej zmiany.
Nie wymagają od razu systemu telemetrycznego.

Powtarzamy próbę po zmianie kodu, warunków lub hipotezy.
Nie powtarzamy bez końca tego samego działania bez nowej informacji.

---

## 8. Chronimy również mechanizm sprawdzania

Agent nie może jednocześnie złamać reguły i samodzielnie zmienić
warunków egzaminu, aby uzyskać zielony wynik.

Osłabienie asercji, wyłączenie aktywnego testu, rozszerzenie wyjątku,
zmiana kryterium sukcesu lub wyłączenie wymaganej kontroli
wymaga jawnej akceptacji właściciela albo uprawnionego maintainera.

Nie dotyczy to dodawania testów ani zwykłego refaktoru,
który zachowuje znaczenie obowiązującego kontraktu.

Wycofane wymaganie można usunąć z aktywnego zestawu kontroli,
ale z odniesieniem do decyzji o zmianie zakresu.
Historyczne FAIL nie zamienia się przez to w historyczne PASS.

Zmiany reguł i sposobu uruchamiania testów są widoczne w diffie
i podlegają niezależnemu zatwierdzeniu przed przyjęciem.
Agent implementujący nie otrzymuje prawa obejścia tej ochrony.

Egzekwowanie kontroli odbywa się poza decyzją samego agenta:
w istniejącym CI lub w obowiązującej ścieżce odbioru operatora.
Lokalny komunikat „wszystko przeszło” nie zastępuje tego kroku.

---

## 9. Dokumentacja żyje z kodem, ale nie rośnie przy każdym commicie

Ten plik jest punktem wejścia do zasad architektury.
Instrukcja dla agenta odsyła do niego zamiast kopiować jego treść
do kilku różnych plików.

Przy zadaniu agent czyta właściwą regułę, dotknięty kontrakt,
aktualną implementację i związane z nią testy.
Nie musi odtwarzać historii całej kampanii.

Jeżeli zmienia się znaczenie architektury, aktualizujemy właściwą
zasadę i test wraz z implementacją. Przy zwykłym bugfixie wystarczy
zmiana kodu, odpowiedni test i krótki opis wyniku.

Do opisu istotnej zmiany wystarczy:

    Cel użytkownika:
    Dotknięta granica lub kontrakt:
    Zmiana:
    Dowód na tej rewizji:
    Ograniczenia lub potrzebna decyzja:

Nie powielamy tego zapisu w osobnym raporcie dla każdej roli.
Logi i ślady wykonania linkujemy, zamiast wklejać do manifestu.

Diagram może pomagać w zrozumieniu systemu.
Nie jest warunkiem rozpoczęcia każdej poprawki.

Jeżeli generujemy mapę zależności, wskazujemy jej rewizję i zakres.
Nie traktujemy niezaobserwowanej ścieżki jako dowodu, że nie istnieje.
Nie zastępujemy konkretnych naruszeń abstrakcyjnym „Drift Score”.

Zmiana strukturalna powinna być opisana wprost:
jaka zależność, proces, magazyn danych lub odpowiedzialność
zostały dodane, usunięte albo przeniesione.
Do tego nie jest wymagany osobny serwer architektury.

---

## 10. Rozwijamy produkt bez utrwalania przypadkowej złożoności

Szczególnej decyzji wymagają zmiany kierunku:
powrót zdalnych usług językowych, nowy stale działający proces,
nowy magazyn stanu, rozszerzenie uprawnień lub zmiana gwarancji użytkownika.

Zwykły bugfix, lokalny refaktor i nowy test nie wymagają
rady architektonicznej ani angażowania wszystkich ról.

Przed dołożeniem mechanizmu odpowiadamy:
jaki obecny problem rozwiązuje i dlaczego istniejąca ścieżka nie wystarcza?

Nie tworzymy automatycznie serwera MCP, grafu wiedzy, nowego DSL,
dashboardu dryfu, magistrali zdarzeń ani dodatkowej warstwy recovery
tylko po to, aby nazwać architekturę „living”.

Nieużywana infrastruktura nie pozostaje obowiązkowa dlatego,
że pakieter lub stary test nadal oczekuje jej pliku.
Dostosowujemy zależne kontrole do zaakceptowanego zakresu,
zachowując historię w Git.

Nie usuwamy zabezpieczeń tylko dlatego, że są kosztowne.
Najpierw sprawdzamy, czy chronią aktualny kontrakt,
czy jedynie niepotrzebny już mechanizm.

Nie przepisujemy aplikacji od nowa, aby wdrożyć ten manifest.
Podłączamy najważniejsze sprawdzenia do istniejącej weryfikacji
i poprawiamy konkretne miejsca rozjazdu.

## Ostateczne kryterium

Zmiana jest dobra, gdy użytkownik otrzymuje potrzebny efekt,
istniejące gwarancje pozostają zachowane,
a sposób osiągnięcia wyniku jest prosty do zrozumienia i sprawdzenia.

> Nie każda zmiana architektury jest dryfem.
> Dryfem jest nieuzgodniona zmiana odpowiedzialności, kosztu,
> zależności lub gwarancji, której nikt nie zauważył albo nie zweryfikował.

---

## Strażnik wizji — nadrzędna korekta właściciela, 2026-11-12

Oficjalne wejście: `0c4591a1-0e6d-4b0f-84f5-3653c9f3ee67` (`OWNER-PAIRCOACH-VISION-GOVERNANCE-CORRECTION-20261112`). Ma pierwszeństwo nad poprzednim przypisaniem P6 dokumentacji i utrzymania kontekstu wizji podczas implementacji.

- Właściciel → ROOT/operator: ROOT jest kustoszem kontraktu i prowadzi niezależny odbiór. Zmienia zasady wyłącznie za wyraźną zgodą właściciela.
- K: jedyny operacyjny właściciel wizji podczas delegowania, implementacji i integracji; scoped ACCEPT/REJECT na podstawie niezmienników, rewizji i dowodów.
- P1 backend/API; P2 frontend/UX; P3 QA/E2E; P4 build/wdrożenia — zgodnie z istniejącym drzewem.
- P5: twarde bariery bezpieczeństwa i ochrona kontroli; bez żądań nowych warstw architektury.
- P6: podczas implementacji bez zadania. Dopiero na gotowym kandydacie przed wydaniem audyt RO, istniejący AC-103 i kontrola kosztu I/O/wydajności. Nie steruje integracją i nie stanowi drugiego ośrodka decyzyjnego.
- JUDGE: wyłącznie incydenty konfliktu zasobów/uprawnień lub pętla identycznych prób bez nowego dowodu; nie stały recenzent i nie automatyczny licznik zatrzymujący naprawy oparte o nową informację.

ROOT oficjalnie wstrzymał P6. Zachowujemy jego dotychczasowe artefakty. K dokończy ARCHITECTURE.md oraz odsyłacz AGENTS.md w bezpiecznym oknie, bez blokowania Java21 GUI. Szeroka fraza o uprawnionym maintainerze w pierwotnym manifeście nie upoważnia K/P5/P6 do samodzielnej zmiany norm lub osłabiania testów dla zielonego wyniku. Oficjalne enumy transportu pozostają ACCEPTED/CHANGES_REQUESTED.

---

## Mapowanie istniejących kontroli — K, 2026-11-12

Mapa dotyczy kodu bazowego `4fa1d7b4c793c283346a8025018ebd634e7b8f66`
(tree `8c40b033168e68c653c80e7d3f88f8df690ac4c5`).
Mapa wykorzystuje zachowany partial P6, bez wznowienia tej roli.
Powyżej zachowano pełny tekst właściciela ze źródła
`f3b754a3-5fb7-41ef-8b61-44dafef18830` bez zmian.
Poniżej wskazano istniejące kontrole, nie nową kampanię ani deklarację zgodności.

Komendy z katalogu głównego repo, Node >=22.22.0 i istniejące zależności:
- **T**: `node --import tsx --test <ścieżki z wiersza>`.
- **S**: `node scripts/runtime-test.mjs --list` — tylko selekcja, nie testy.
  Wskazane niżej pliki `.test.ts` są ACTIVE w istniejącym `npm test`
  (`node scripts/runtime-test.mjs`); nie zmieniamy selektora.
- **G**: `node node_modules/@playwright/test/cli.js test --config tests/lightweight-editor/gui.config.ts`.
  Oddzielny scenariusz `tests/lightweight-editor/gui.spec.ts`, NIE wybierany przez
  `npm test`. Wymaga istniejącej izolowanej aplikacji i zmiennych
  `PAIRCOACH_GUI_URL`, `PAIRCOACH_GUI_TOKEN` (prywatnie),
  `PAIRCOACH_GUI_PATH`, `PAIRCOACH_QA_REVISION`; opcjonalnie
  `PAIRCOACH_GUI_CURRENTNESS=1` i `PAIRCOACH_QA_BROWSER`.
  Nie startuje ani nie zatrzymuje backendu; nie uruchamiać na źródłach właściciela.

| Reguła | Istniejące ścieżki / komenda | Zakres i konkretne ograniczenie dowodu |
| --- | --- | --- |
| AC-ELA-001 | **T** `tests/runtime-architecture/repository.test.ts tests/runtime-architecture/detector.test.ts`; mechanika/zakres: `tests/runtime-architecture/oracle.ts`, `tests/runtime-architecture/README.md` | Test repo skanuje rzeczywisty `src` od chronionych korzeni (GUI, WriteGate, SessionController, WorkspaceService, Runner, bridge/klienci), tranzytywne importy/re-eksporty i selektory AST; detector sprawdza kontrolne fixture, nie zastępuje repo. Model ograniczony: nie dowodzi zachowania refleksji/eval, wnętrz pakietów ani całego runtime. Historyczny realrepo PASS P6 na `99580cb071a72b7e43471a2138d423b06f140cae` nie jest wynikiem tej bazy. |
| AC-ELA-002 | **T** `tests/lightweight-backend/http.test.ts`; uzupełnienie GUI **G** | Rzeczywisty HTTP/WS, WriteGate/ACK, wstrzyknięte niedostępne CLI Docker i pułapki driver/Worker oraz kontrola braku language/shadow/bounded FS; GUI obserwuje brak LANGUAGE i oryginalne zapisy. To nie obserwacja wszystkich procesów/kontenerów rzeczywistego hosta w trakcie pisania. Ta część LIVE pozostaje NIEWERYFIKOWANA; odbiór ROOT: AC-LIGHT-001/002. |
| AC-ELA-003 | **T** `tests/lightweight-editor/currentness.test.ts tests/qa/g1-writegate.test.ts tests/lightweight-backend/http.test.ts`; uzupełnienie **G** | Kontrole CONTROL_PREPARE, Enter/Tab/stary klik, late reply po VETO/scope/disconnect, epoch/owner, oryginalny ACK i idempotencja. Currentness używa kontrolowanego Monaco/providerów; G używa prawdziwego Monaco/HTTP/WS, lecz nie wykonuje scenariusza AI/przejęcia podczas LIVE PREPARE. Ten brak nie jest PASS; ROOT: AC-LIGHT-004, AC-109. |
| AC-ELA-004 | **T** `tests/runtime-executor/input.test.ts tests/backend-cutover/run-stage.test.ts tests/runtime-executor/executor.test.ts` | Rzeczywisty FS: zamrożone ACK bytes, inventory i wyścigi; Run admission/lifecycle na rzeczywistym core z fake Docker; argv mount readonly i brak modyfikacji źródła. Nie dowodzi izolacji na prawdziwym Dockerze. ROOT: AC-104, TEST-103..107, identyfikacja runId/input hash/workspaceVersion oraz kontrola źródeł przed/po. |
| AC-ELA-005 | **T** `tests/runtime-executor/executor.test.ts tests/runtime-adapters/adapters.test.ts tests/backend-cutover/http-run-start-uncertainty.test.ts` | Fake Docker: tożsamość, lost response/readback, STOP_UNCONFIRMED, timeout, obcy kontener; real loopback HTTP z fake Docker: readiness nie kończy serwera. JUnit: brak/zero/allSkipped/stary XML/nonzero/mismatch nie daje PASSED. Rzeczywisty Stop kontenera i Spring HTTP niedostępny po Stop nadal wymagają ROOT AC-105/106 i TEST-106 (21/27). |
| AC-ELA-006 | **T** `tests/lightweight-backend/http.test.ts tests/lightweight-editor/currentness.test.ts`; aplikacja **G** | HTTP/WS: CONFIG_ERROR/pusty lock/niedostępne per-instance CLI nie blokują zwykłego save; kontrolowany FE: worker failure nie odbiera ręcznej edycji. G sprawdza completion/save/Undo/Redo/reload, ale etykieta `PAIRCOACH_GUI_DOCKER` sama nie wprowadza ani nie dowodzi DAEMON_OFF. Pełny aplikacyjny DAEMON_OFF + odzyskanie draftu NIEWERYFIKOWANE; ROOT AC-LIGHT-003, AC-110. |

**Odbiór, nie fikcyjne CI.** Istniejący zewnętrzny zapis to
`Desks/SharedDesk/deliveries/_drafts/K/polyglot-lightweight/ACCEPTANCE.md`
(w projekcie Thalamusa, nie plik dostarczany przez tę zmianę).
K zapisuje w nim zakres/SHA, ACCEPT albo REJECT, AC-ELA/punkt, dowód,
pozostały brak/naruszenie i następny krok. ROOT odbiera całość niezależnie.
Mapowane kontrole nie były uruchamiane ponownie dla tej zmiany dokumentacji;
wynik dla tej rewizji: **NOT_RUN**, poza sprawdzeniem tekstu, ścieżek i selekcji.
Nie stwierdzono tutaj podłączenia do CI. Java21/Spring GUI i trwający host C
nie są blokowane przez tę dostawę.

**Aktualne ograniczenia mapy.** C na bazie 4fa zakończył się FAIL przed
Run: serwer zamknął poprawny HELLO code1008 „HELLO required” po3016.868ms.
Potwierdzona wada §4/AC-ELA-006: heavy runtimeReadiness blokuje
getBundle przed authenticated. Szybki test z niedostępnym CLI powyżej
nie pokrywa opóźnionego, rzeczywistego probe. K odrzucił tę ścieżkę;
P1 naprawia http.ts/RuntimeProject.ts i dodaje kontrtest opóźnionego probe,
bez zwiększania deadline ani osłabiania auth/FIFO/currentness/Run guards.
AFTER i ponowny C wymagają gotowej naprawy, nie są tu deklarowane.

Przy integracji tych dokumentów K skomponował odebrane 18cf0ee3:
dwa rootmd są opcjonalnie dopuszczone przez istniejące predykaty
package-windows/verify-source-revision, bez dodawania do mandatory
sourceRequired ani kontroli kompilatora. Sama allowlista nie dowodzi ZIP.
Zmiana dokumentów nie wykonuje mapowanych testów i nie zamyka żadnego AC.
K aktualizuje mapę wraz z dotyczącą jej zmianą; P6 pozostaje paused
do audytu RO gotowego kandydata zgodnie z nadrzędną korektą governance.
