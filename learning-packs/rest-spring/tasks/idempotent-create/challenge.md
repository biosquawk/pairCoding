# Powtórz POST bez podwójnego skutku

POST /items wymaga Idempotency-Key i niepustego name. Pierwszy zwraca 201, Location i nowy Item. Powtórka tego samego klucza/name (także równoległa) odtwarza dokładnie status/Location/Item bez nowego elementu. Ten sam klucz z innym name daje 409 {"code":"KEY_REUSED"} bez zmiany listy. Inny klucz tworzy kolejny ID nawet dla tej samej nazwy. Brak klucza/błędne dane dają 400. GET /items pokazuje skutki. Wystarczy magazyn w pamięci procesu; synchronizuj sprawdzenie i zapis. Starter zapisuje kolejną kopię.

Profil: java-maven-21; wspólny POM, zależności i testy pozostają niezmienione. Napraw zachowanie HTTP w src/main/java/demo/ApiApplication.java.

Materiał: idempotent-create. Autorskie opracowanie PairCoach, nie książka użytkownika.
