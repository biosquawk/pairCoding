# Java — współbieżność BEGINNER · 30 minut

Materiał autorski PairCoach. Pięć minićwiczeń po około 6 minut; jedno rzeczywiste
API na krok. Epoka Java 5/8/21 oznacza pochodzenie API, nie poziom ucznia.
Wszystko wykonujemy na istniejącym java-maven-21; bez preview, Springa, HTTP i bazy.
POM jest czysty Java21/JUnit5; wspólny dla wszystkich zadań i jawnego prepare.

1. ExecutorService / Callable / Future — odbierz wynik (1 linia).
2. CountDownLatch — zgłoś zakończenie pracy (1 linia).
3. CompletableFuture / thenCombine — połącz wyniki (1 wyrażenie).
4. Thread.ofVirtual — wybierz wirtualny wątek (1 wywołanie).
5. newVirtualThreadPerTaskExecutor — zmień fabrykę executora (1 wywołanie).

## Jak ćwiczyć

Otwórz gotowy projekt na własnej instancji, wznów zegar ▶. Uruchom program i testy,
popraw małe TODO, zaczekaj na potwierdzony zapis, uruchom testy ponownie.
Po PASS: **Dalej**. Po drugim zadaniu **Łatwiejsze** wraca do pierwszego z Twoim kodem.
**Przykład** pokazuje wiedzę, nie prywatny plik rozwiązania. Referencje nie są
instalowane w folderze ćwiczenia ani przekazywane AI. Zgoda AI jest osobna dla folderu.
BancMentor nie odbiera prawa edycji/weta. Granice liveness10s nie są benchmarkiem.

## Wskazówki autorskie

### 1. Callable i Future (Java 5)

Callable zwraca wartość lub zgłasza wyjątek. ExecutorService.submit zleca pracę puli i zwraca Future. get() czeka na jej wynik i propaguje niepowodzenie przez ExecutionException. Przykład innego obliczenia: Future<Integer> f = pool.submit(() -> 3 + 4); int suma = f.get(); Zamknij pulę, gdy skończysz.

### 2/5 · Poczekaj na zespół

Latch odlicza ukończone prace. Każde countDown() zmniejsza licznik o jeden; await() czeka do zera. Przykład innego zastosowania: CountDownLatch ready = new CountDownLatch(1); zapisanoPlik(); ready.countDown(); Po await widać zapisy wykonane przed countDown. Latch jest jednorazowy; nie używaj sleep do synchronizacji.

### 3/5 · Połącz dwa wyniki

CompletableFuture reprezentuje wynik, który może pojawić się później. supplyAsync uruchamia obliczenie w przekazanym executorze. thenCombine łączy dwa niezależne wyniki bez ręcznego odpytywania. Inny przykład: opis.thenCombine(cena, (nazwa, kwota) -> nazwa + ": " + kwota). get odbiera końcowy wynik; nie myl łączenia wyników z uruchomieniem dodatkowego wątku dla każdej lambdy.

### 4/5 · Uruchom wątek wirtualny

Wątki wirtualne są stabilne od Java 21 (Loom). Thread.ofVirtual() tworzy builder wirtualnego wątku; start(runnable) uruchamia pracę. Przykład innego efektu: Thread.ofVirtual().start(() -> System.out.println("Gotowe")); isVirtual() rozpoznaje rzeczywisty rodzaj wątku, niezależnie od nazwy. join czeka na zakończenie. To ułatwienie współbieżności, nie obietnica przyspieszenia obliczeń CPU.

### 5/5 · Wirtualny wątek na zadanie

Executors.newVirtualThreadPerTaskExecutor() tworzy executor uruchamiający osobny wirtualny wątek dla każdego zadania. Nadal przyjmuje Callable i zwraca Future. Przykład niezależnej pracy: try (var e = Executors.newVirtualThreadPerTaskExecutor()) { var f = e.submit(() -> "gotowe"); System.out.println(f.get()); } Zamknięcie czeka na koniec prac. Nie stosuj tego jako limitu równoległych połączeń do zewnętrznej usługi.

## Oficjalne źródła / co dalej

- ExecutorService (API od Java 5): https://docs.oracle.com/javase/8/docs/api/java/util/concurrent/ExecutorService.html
- CountDownLatch: https://docs.oracle.com/javase/8/docs/api/java/util/concurrent/CountDownLatch.html
- CompletableFuture / thenCombine: https://docs.oracle.com/javase/8/docs/api/java/util/concurrent/CompletableFuture.html
- Thread / ofVirtual / isVirtual (stabilne Java21): https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Thread.html
- Executors / newVirtualThreadPerTaskExecutor (Java21): https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/Executors.html
- StructuredTaskScope Java27 jest **preview**: https://docs.oracle.com/en/java/javase/27/docs/api/java.base/java/util/concurrent/StructuredTaskScope.html

Nie uruchamiamy StructuredTaskScope w tej lekcji. Nie potrzebujesz Java5/8 ani nowego JDK.
