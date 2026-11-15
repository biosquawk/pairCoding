# 2/5 · Poczekaj na zespół · 6 min

BEGINNER. `CountDownLatch(2)` oznacza: czekamy na dwie zakończone prace. Dwa prawdziwe
wątki dodają liczby do bezpiecznego `AtomicInteger`, ale nie zgłaszają zakończenia.

**Twoja zmiana (1 linia):** po dodaniu wyniku wywołaj `done.countDown()`.
`await` już czeka w Main i testach. Starter kompiluje, lecz testy po granicy
liveness 10 s zgłaszają FAIL — to nie pomiar szybkości. Nie dodawaj sleep ani pętli.
Po poprawce: `Gotowe: true, suma: 42` i PASS. **Łatwiejsze** wraca do pierwszego
zadania bez kasowania Twojego kodu. **Dalej** otworzy następne.
