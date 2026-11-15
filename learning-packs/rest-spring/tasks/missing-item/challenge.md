# Oddaj 404 i stabilny błąd JSON

GET /items/1 zwraca 200 oraz {"id":1,"name":"notes"}. Dla dowolnego innego liczbowego ID zwróć 404, application/json i {"code":"ITEM_NOT_FOUND","id":żądaneID}. Powtórzony odczyt brakującego zasobu nie tworzy danych. Starter zwraca 200 mimo braku zasobu.

Profil: java-maven-21; wspólny POM, zależności i testy pozostają niezmienione. Napraw zachowanie HTTP w src/main/java/demo/ApiApplication.java.

Materiał: error-contract. Autorskie opracowanie PairCoach, nie książka użytkownika.
