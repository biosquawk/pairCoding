# NEXT — backlog przyszłego MVP platformy Thalamus

**Aktualizacja właściciela:** 2026-11-12.  
**Wspólny MVP:** `NEXT-THALAMUS-01` — wymienny magazyn danych i operatorski Flight Board.  
**Status obu historii:** `BACKLOG / NOT_STARTED`; odbiór: `NOT_RUN`.

Ten plik jest trwałym miejscem obu historii, a nie chwilowym raportem wykonania.
Zapis w repozytorium PairCoding jest świadomą decyzją właściciela: historie dotyczą
platformy wykonawczej **Thalamus**, nie magazynu danych ani edytora PairCoach.
Ich realizacja nie jest częścią bieżącego `GOAL-PC-POLYGLOT-01-LIGHTWEIGHT`.
Samo dopisanie backlogu nie uruchamia implementacji ani nie wznawia innych projektów.

Repozytorium implementacji Thalamusa:
`\\wsl.localhost\Ubuntu\home\darulec\dev\codex_prjects\codex_synapse_new`.

| Historia | Wynik dla użytkownika | MVP |
|---|---|---|
| [THALAMUS-SQLITE-PORT-01](#thalamus-sqlite-port-01) | Wybór SQLite lub płaskich plików w konfiguracji, bez zmiany logiki platformy | `NEXT-THALAMUS-01` |
| [THALAMUS-FLIGHT-TABLE-01](#thalamus-flight-table-01) | Operatorska tablica komunikacji, ról, Jobs i logów, jak dawny ThalamusHub | `NEXT-THALAMUS-01` |

## THALAMUS-SQLITE-PORT-01

### Historia użytkownika

Jako właściciel lub wdrażający Thalamusa chcę wybrać w pliku konfiguracyjnym
**SQLite albo płaskie pliki jako implementację tych samych portów persystencji**,
żeby dopasować instalację do wymagań klienta bez przepisywania transportu,
Watchdoga, Jobs, sesji i logiki zespołu.

### Zakres

- Porty opisują operacje aplikacyjne i domenowe; nie ujawniają SQL, JDBC,
  `Connection`, `ResultSet`, uchwytów SQLite ani ścieżek backendu.
- Adapter SQLite implementuje te porty i pozostaje domyślnym backendem.
  Zachowuje istniejące dane, tożsamości i działanie SQLite WAL.
- Drugi adapter, `flat_files`, realizuje **ten sam kontrakt**, korzystając
  z udokumentowanego formatu zwykłych plików, np. JSON/JSONL. Nie jest atrapą
  używaną tylko w testach ani eksportem bazy, który nadal wymaga SQLite.
- Wybór adaptera następuje w istniejącym miejscu składania aplikacji na podstawie
  konfiguracji. Zmiana może wymagać restartu; przełączanie podczas aktywnej pracy
  nie jest wymagane. Nie budujemy nowego frameworka repozytoriów ani DI.
- Objęte portami mają być wszystkie trwałe dane niezbędne do działania projektu:
  wiadomości i idempotencja, zdarzenia, prace i odbiory, Jobs, źródła/cel i ich
  powiązania, metadane sesji oraz pamięć i rozliczenia. Istniejące dokumenty na
  SharedDesk pozostają plikami projektu. Etapowanie prac nie oznacza odbioru
  backendu `flat_files`, dopóki platforma nadal wymaga SQLite do części tych operacji.

**Proponowany kontrakt konfiguracji — do wdrożenia, obecnie nieistniejąca flaga:**

```json
{
  "persistence": {
    "adapter": "sqlite",
    "path": "state/project.db"
  }
}
```

Alternatywa:

```json
{
  "persistence": {
    "adapter": "flat_files",
    "path": "state/project-store"
  }
}
```

Wdrożenie ma wskazać dokładny plik konfiguracyjny i regułę rozwiązywania ścieżek.
Nieznany adapter, błędny format lub niedostępny magazyn powodują czytelny błąd,
bez cichego przełączenia na inny backend i bez utworzenia pozornie pustego projektu.

### Kryteria akceptacji

1. Oba adaptery są podłączone do rzeczywistego composition root. Ten sam scenariusz
   projektu działa po wyborze jednego lub drugiego adaptera w konfiguracji,
   bez modyfikacji kodu przypadków użycia i bez hostowego SQLite w trybie `flat_files`.
2. Wydzielona logika aplikacyjna i domenowa nie zawiera SQL/JDBC ani warunków
   wybierających backend. Istniejący test granic sprawdza rzeczywiste zależności;
   pozostała zależność od konkretnego magazynu oznacza nieukończony zakres.
3. Jeden zestaw testów kontraktowych uruchamia się na obu rzeczywistych adapterach.
   Chroni trwałość, kolejność zdarzeń, zakres zapytań, limity, idempotencję,
   spójność wiadomości ze stanem prac i projekcją tablicy oraz istniejącą politykę
   współbieżności. ACK nie może poprzedzać wymaganego trwałego zapisu.
4. Próby przerwania procesu i ponowienia operacji nie powodują podwójnych skutków,
   utraty potwierdzonych danych ani rozjazdu tablicy z transportem. Reguły zapisu,
   blokowania i odtwarzania adaptera plikowego są jawne i sprawdzone.
5. Restart zachowuje identyfikatory projektu, ról, sesji, wiadomości, prac i Jobs.
   Przeniesienie istniejących danych między backendami jest jawne i zweryfikowane
   pod względem liczby rekordów, identyfikatorów i relacji; nie wykonuje się
   automatycznie tylko dlatego, że zmieniono wartość w JSON.
6. Odbiór obejmuje działający przepływ człowiek → K → pracownik → wynik → odbiór K
   i odczyt stanu po restarcie na każdym backendzie. Wywołania modelu nie są
   potrzebne do samej konfiguracji, odczytu ani migracji danych.
7. Zachowane są istniejące asercje testów poprawki Watchdoga: zakres, porządek,
   limit i przypadki nieprawidłowego JSON. Pomiar kosztu wykonuje się na
   porównywalnym zbiorze; nie utożsamia się wyniku jednego zapytania z wydajnością
   całej platformy.

### Znany kontekst i granica dotychczasowej naprawy

Nocny hotfix `WatchdogAndVenetianJudge.scopedCommands()` zastąpił skorelowane
`EXISTS` przez materializowane `IN (SELECT ...)`, z fallbackiem dla nieprawidłowego
JSON. Commit Thalamusa: `b235eea413a1df84e4be4cea813a25ac8a5de984`.
Pięć natywnych testów SQLite i wdrożenie tego hotfixu **nie oznaczają wykonania
portów ani adaptera plikowego**.

Dowody historyczne, niezależne od chwilowego raportu:
[patch i identyfikacja integracji](../checkpoint-20261112/evidence/native-watchdog-focused-check/integration.json),
[wdrożenie z zachowaniem tożsamości](../checkpoint-20261112/evidence/native-watchdog-focused-check/post-deployment-identity.json).

Wcześniejszy opis ograniczał zadanie do wydzielenia adaptera SQLite i wykluczał
zastąpienie go plikami. **Aktualna decyzja właściciela rozszerza przyszły MVP o
rzeczywiście wymienny adapter `flat_files`.** Ochrona bieżącej instalacji SQLite
pozostaje obowiązująca do czasu osobnego wykonania i odbioru tej historii.

## THALAMUS-FLIGHT-TABLE-01

### Historia użytkownika

Jako operator Thalamusa chcę otworzyć jedną odświeżaną tablicę terminalową
z komunikacją agent → agent, stanem ról, Jobs i logami, żebym widział rzeczywisty
przebieg pracy bez otwierania czatu każdej roli i bez pytania modelu o status.

Wzorzec zachowania i układu: dawny **ThalamusHub v2**, uruchamiany przez
`./synapse attach`, z kartami **FLIGHT / JOBS / OPERATIONS**. To odrębny widok
operatorski; Web GUI rozmowy z człowiekiem ani `thalamus attach --role K`
nie realizują tej historii.

Referencja Legacy:
`\\wsl.localhost\Ubuntu\home\darulec\dev\codex_prjects\codex_synapse_legacy\260503_codex_synapse_swarm`.

### Zakres

- **FLIGHT:** czas, MsgID, From, To, kanał/typ, temat, identyfikator pracy
  i wykonania oraz skrót treści; rzeczywiste potwierdzenia transportu i odbiory.
- **Role / Operations:** rzeczywisty stan K, P1..Pn i JUDGE, aktywna praca/tura,
  kolejki, pauza, wymagane logowanie, cooldown, incydenty i dostępne dowody
  ostatniego postępu. Brak danych jest jawnie `UNKNOWN`, nie domyślnym `IDLE`.
- **JOBS:** definicje, harmonogram, pauzy, najbliższe wykonanie, ostatni wynik
  i jego dowód, o ile platforma rzeczywiście te dane udostępnia.
- **Logi:** ograniczony, aktualizowany podgląd zdarzeń i błędów, powiązanych
  z projektem, rolą i wykonaniem. Bez eksportowania poświadczeń.
- Jeden udokumentowany punkt wejścia CLI i wybór projektu. Propozycja do wdrożenia:
  `./thalamus monitor --project software_dev_2`. Ta komenda **obecnie nie istnieje**;
  nie zmieniamy po cichu znaczenia natywnego `attach` pojedynczej roli.

### Kryteria akceptacji

1. Operator uruchamia monitor jednym poleceniem, przełącza FLIGHT/JOBS/OPERATIONS
   i widzi nowe zdarzenia bez ręcznego odświeżania oraz bez otwierania end-user chat.
2. Rzeczywista wymiana K → P → K i decyzja `ACCEPTED` lub `CHANGES_REQUESTED`
   pojawiają się z tymi samymi identyfikatorami co w źródle transportu. Rozróżnia
   się zapis/dostarczenie/zużycie wiadomości, `RESULT_READY` i odbiór wyniku.
   Nie wytwarza się brakujących ACK ani sukcesu na podstawie ciszy lub gotowego pliku.
3. Widok jest projekcją istniejących danych przez port odczytu, korzystającą
   z tego samego kontraktu przy SQLite i `flat_files`. Nie tworzy drugiej prawdy
   ani ręcznego `update_board`. Implementację można zacząć od obecnego adaptera
   SQLite, ale odbiór wspólnego MVP obejmuje oba backendy.
4. Otwarcie, odświeżanie, przełączanie kart i wyjście nie uruchamiają modelu,
   nie budzą ani nie pauzują ról, nie przejmują sesji, nie zmieniają Jobs i nie
   zatrzymują daemona. Ten MVP nie dodaje przycisków sterowania wykonaniem.
5. Aktualizacja używa ograniczonych projekcji, stronicowania i kursora zdarzeń,
   a nie ponownego przesyłania całej historii wszystkich projektów. Historia
   większa niż 2 MiB nie powoduje ucięcia JSON ani utraty bieżącego podglądu.
   Ograniczenie odczytu jest jawne; monitor zachowuje scroll i pozostaje responsywny.
6. Rzeczywisty przebieg obejmuje aktywną/bezczynną rolę, pauzę, błąd i Jobs.
   Pokazane stany porównuje się z rzeczywistymi rekordami i zdarzeniami.
   Odłączenie monitora nie przerywa pracy zespołu; brak źródła daje czytelny stan
   niedostępności, bez fikcyjnego zielonego statusu.

### Znany kontekst

W Rebirth są dane wiadomości i projekcja prac, a Web GUI ma osobno Pokój zespołu,
role, Prace i dostawy oraz Jobs. Sprawdzony interfejs CLI udostępnia `attach`
jednej roli, lecz nie dawny terminalowy Hub z trzema kartami.
Zewnętrzny moduł `observability` eksportuje metadane; sam nie zastępuje tablicy
z treścią i kierunkiem komunikacji.

Podczas rozpoznania 2026-11-12 potwierdzono też, że obecny CLI czyta najwyżej
`2 * 1024 * 1024` bajtów odpowiedzi, podczas gdy rzeczywisty `/api/snapshot`
miał około 43 MB. To wyjaśnia `Unterminated string` przy `attach`; naprawa samego
limitu nie jest implementacją Flight Boardu. Nowy monitor ma korzystać z
ograniczonego odczytu bieżących danych, zamiast zależeć od tak dużej migawki.

## Wspólne warunki odbioru przyszłego MVP

Obie historie wymagają osobnego zlecenia, działającej integracji i niezależnego
odbioru operatora na wskazanej rewizji. Dotychczasowe wyniki hotfixu, obecny Web GUI
ani niniejszy backlog nie są dowodem ich ukończenia. Nie przenosimy ich do aktywnej
implementacji PairCoach Lightweight i nie zmieniamy działającej platformy w ramach
samej aktualizacji dokumentacji.
