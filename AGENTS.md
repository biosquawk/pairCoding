# Instrukcja pracy w PairCoach

Przed zmianą przeczytaj właściwą zasadę i nadrzędną korektę governance
w [ARCHITECTURE.md](ARCHITECTURE.md), dotknięty kontrakt, kod i testy.
Nie powielaj manifestu w kartach.

- Właściciel określa cel. ROOT/operator jest kustoszem kontraktu i prowadzi
  niezależny odbiór; tylko ROOT zmienia normy za wyraźną zgodą Właściciela.
  Szeroka fraza maintainer w §8 nie uprawnia K/P5/P6 do osłabiania norm
  lub aktywnych kontroli dla zielonego wyniku. Eskalacja: ROOT → Właściciel.
- K operacyjnie egzekwuje wizję, ustala ownership, integruje i wydaje scoped
  ACCEPT/REJECT: zakres/SHA, punkt manifestu lub AC-ELA, rzeczywisty dowód
  z rewizją i środowiskiem, konkretny brak/naruszenie i następny krok.
  Oddziel brak dowodu, blokadę środowiska i potwierdzoną wadę.
  NOT_RUN, FAIL i PASS są różne; przyjęcie dostawy nie odbiera całego produktu.
- Oficjalny transport: REVIEW_DECISION ACCEPTED albo CHANGES_REQUESTED
  na właściwym work_id/execution_id, bez nowego enum REJECT.
  Wynik dopisz do istniejącej macierzy odbioru, nie do nowych kampanii.
- P1 backend/API, P2 frontend/UX, P3 QA/E2E, P4 build/wdrożenia:
  rozłączne zakresy, jedna integracja. P5 chroni WriteGate/workspace/limity
  i mechanizm testów, nie żąda przebudowy architektury.
- P6 podczas implementacji pozostaje bez zadania/paused; dopiero gotowy
  kandydat przed wydaniem: RO AC-103, koszt I/O i wydajność.
  Nie zarządza wizją, agentami lub kompozycją i nie jest bramką integracji.
- JUDGE tylko incydenty zasobów/uprawnień lub identyczne nieudane próby
  bez nowego dowodu; nie automatyczny stoplicznik kolejnych napraw.
- Zachowaj aktywne asercje oraz odniesienia do jawnie wycofanego LSP;
  historyczny FAIL nie staje się PASS. Nie deklaruj fikcyjnego CI.
  Nie przebudowuj Thalamusa ani procesu. Dokumentacja nie blokuje Java21 GUI.
