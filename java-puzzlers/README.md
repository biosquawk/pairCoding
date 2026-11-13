# Java Puzzlers — Expressive Puzzlers, zadania 1–10

Dziesięć niezależnych folderów Maven do otwierania przyciskiem **Otwórz folder…** w PairCoding albo równolegle w IntelliJ. Profil `java-maven-21` wystarcza; POM celuje w release 11. Nie ma kontenerowego LSP ani dodatkowego mechanizmu zapisu.

## Uruchomienie

1. Z katalogu aplikacji wykonaj `node java-puzzlers/prepare-tasks.mjs`. Tworzy wyłącznie prywatne ustawienia tych ćwiczeń; nie uruchamia kontenerów, nie rozwiązuje zadań i zachowuje istniejące ustawienia. Jeśli chcesz od razu włączyć zgodę na analizę przez trenera, użyj `node java-puzzlers/prepare-tasks.mjs --ai-consent` przy pierwszym przygotowaniu. Późniejszą zgodę zmieniasz w ustawieniach projektu.
2. Uruchom PairCoding z profilem `java-maven-21`, otwórz wybrany podfolder i wykonaj zwykłe publiczne `runtime:prepare` według [instrukcji](../docs/windows-polyglot.md), jeśli środowisko nie jest przygotowane. Same źródła nie wymagają JDK/Mavena na hoście.
3. Przeczytaj `challenge.md`. Zadania 1–8 są zagadkami przewidywania wyniku: uzupełniasz `prediction()`, zachowujesz demonstrator i wyjaśniasz wynik komentarzem. Zadanie 9 wymaga znalezienia deklaracji, a zadanie 10 sprawdza współczesny wariant historycznej zagadki; kompilator w kontenerze bada oba przypisania.
4. Używaj Run Main oraz Run Tests. Początkowo test przewidywania/deklaracji jest czerwony. Zielony wynik nie ocenia jakości wyjaśnienia — omów je z trenerem. Nie zmieniaj testów.

| Nr | Folder | Zagadnienie |
|---|---|---|
| 1 | [01-oddity](01-oddity/challenge.md) | znak reszty dla liczby ujemnej |
| 2 | [02-time-for-a-change](02-time-for-a-change/challenge.md) | binarna reprezentacja kwot |
| 3 | [03-long-division](03-long-division/challenge.md) | przepełnienie przed przypisaniem do long |
| 4 | [04-its-elementary](04-its-elementary/challenge.md) | litera l i czytelność literału |
| 5 | [05-the-joy-of-hex](05-the-joy-of-hex/challenge.md) | znak int i rozszerzenie do long |
| 6 | [06-multicast](06-multicast/challenge.md) | byte → char → int |
| 7 | [07-swap-meat](07-swap-meat/challenge.md) | kolejność ewaluacji i XOR |
| 8 | [08-dos-equis](08-dos-equis/challenge.md) | typ operatora warunkowego |
| 9 | [09-tweedledum](09-tweedledum/challenge.md) | += legalne, zwykłe przypisanie nielegalne |
| 10 | [10-tweedledee](10-tweedledee/challenge.md) | sprawdzenie obu przypisań w rzeczywistym JDK |

## Pochodzenie

Materiałem odniesienia było [archiwum autorów Java Puzzlers](http://www.javapuzzlers.com/java-puzzlers.zip), Joshua Bloch i Neal Gafter, rozdział [Expressive Puzzlers](http://www.javapuzzlers.com/contents.html). Polecenia po polsku, szkielet projektu i testy napisano na potrzeby PairCoding. Użyte krótkie wyrażenia ilustrują zagadnienia z archiwum; nie zamieszczamy całej paczki ani tekstu książki i nie przypisujemy sobie ich autorstwa. [SOURCE.json](SOURCE.json) zawiera adres, hash pobranych 61 564 bajtów oraz ścieżki i hashe dziesięciu oryginalnych plików. Hash identyfikuje pobrane bajty; nie jest podpisem autorów.
