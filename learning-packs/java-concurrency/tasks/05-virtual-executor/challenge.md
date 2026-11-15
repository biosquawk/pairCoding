# 5/5 · Wirtualny wątek na zadanie · 6 min

BEGINNER. Znasz już `submit` i `Future`. Nie trzeba zmieniać sposobu odbierania wyniku,
żeby executor używał wirtualnych wątków. Obecnie zwracamy zwykłą pulę dwóch wątków.

**Twoja zmiana (1 wywołanie):** zwróć `Executors.newVirtualThreadPerTaskExecutor()`.
Każda praca dostanie nowy wątek wirtualny. Run Main: `Executor wirtualny: true`.
JUnit sprawdza `isVirtual()` we workerach, różne tożsamości i zamknięcie executora.
To nadal BEGINNER, Java 21 bez preview. Po 30 minutach możesz zakończyć sesję.

Co dalej? `StructuredTaskScope` w dokumentacji Java 27 jest preview; to osobny
kolejny temat, **nie** część tej lekcji. Nie dodawaj flag ani nie zmieniaj JDK.
