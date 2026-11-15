# Waliduj wejście zamówienia

POST /orders wymaga niepustego name i całkowitego quantity w zakresie 1–100 włącznie. Poprawne dane dają 201, Location /orders/1 i odpowiedź z przyjętymi wartościami. Brak/null/puste name, brak/null/0/ujemne/101 quantity i wadliwy JSON dają 400, nie 500. Nie dodawaj zależności walidacji: użyj jawnych reguł w istniejącym kontrolerze. Starter przyjmuje błędne dane.

Profil: java-maven-21; wspólny POM, zależności i testy pozostają niezmienione. Napraw zachowanie HTTP w src/main/java/demo/ApiApplication.java.

Materiał: dto-input. Autorskie opracowanie PairCoach, nie książka użytkownika.
