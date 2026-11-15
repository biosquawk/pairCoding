# Usuń zasób tylko z aktualnym ETag

BUGFIX: GET /items/1 daje 200/reprezentację/ETag "1". DELETE /items/1 wymaga If-Match: brak=428, stary=412; oba zachowują zasób. Świeży warunek daje 204 z pustym body. Porównanie i usunięcie muszą być atomowe: dwa jednoczesne poprawne DELETE kończą się dokładnie jednym 204 i jednym 404. Późniejszy GET/DELETE daje 404. Nie jest to powtórka PUT: sprawdzamy usunięcie i konkurujących klientów. Starter ignoruje warunek.

Profil: java-maven-21; wspólny POM, zależności i testy pozostają niezmienione. Napraw zachowanie HTTP w src/main/java/demo/ApiApplication.java.

Materiał: conditional-delete. Autorskie opracowanie PairCoach, nie książka użytkownika.
