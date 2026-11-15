# Zmapuj wejście na DTO odpowiedzi

POST /greetings przyjmuje firstName i lastName. Zwróć 200, application/json i wyłącznie displayName w kolejności imię + spacja + nazwisko. Brak/puste imię lub nazwisko i wadliwy JSON dają 400. Starter zamienia kolejność; test używa dwóch różnych osób.

Profil: java-maven-21; wspólny POM, zależności i testy pozostają niezmienione. Napraw zachowanie HTTP w src/main/java/demo/ApiApplication.java.

Materiał: dto-input. Autorskie opracowanie PairCoach, nie książka użytkownika.
