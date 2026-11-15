# 4/5 · Uruchom wątek wirtualny · 6 min

BEGINNER. `Thread.ofPlatform()` tworzy zwykły wątek platformowy. W Java 21 mamy też
stabilny builder `Thread.ofVirtual()`. Nazwa wątku nie czyni go wirtualnym.

**Twoja zmiana (1 wywołanie):** zamień builder na `Thread.ofVirtual()`.
Run Main ma wypisać `Wirtualny: true`. JUnit sprawdza `isVirtual()` rzeczywistego
workera oraz wykonanie przekazanego Runnable dokładnie raz. Bez flag preview.
Wirtualny wątek nie przyspiesza automatycznie obliczeń CPU. **Dalej** pokaże executor.
