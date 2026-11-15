# 1/5 · ExecutorService, Callable i Future · 6 min

BEGINNER. Java 5 to epoka tego API; wszystkie zadania uruchamiamy na Java 21.

`Callable<Integer>` oblicza liczbę w osobnym wątku puli. `submit` zwraca
`Future<Integer>` — uchwyt do wyniku. Starter kompiluje się, ale zwraca 0.

**Twoja zmiana (1 linia):** w `calculate` odbierz wynik przez `Future.get()`.
Nie zmieniaj testów. Run Main powinien wypisać `Wynik: 42`, a Run Tests dać PASS.
Pula jest zamykana przez try-with-resources także w razie wyjątku.

Po PASS kliknij **Dalej**. Chcesz wskazówkę? **Przykład** nie wstawia rozwiązania.
