# Odrzuć konflikt bez zmiany danych

Nazwa tasks należy do drugiego zasobu. PUT /items/1/name z {"name":"tasks"} musi zwrócić 409 i {"code":"DUPLICATE_NAME"} bez zmiany nazwy pierwszego zasobu. Puste/brak/null name daje 400 z kodem INVALID_NAME; inna nazwa daje 200 i zostaje widoczna przez GET /items/1. Starter nadpisuje nazwę mimo konfliktu.

Profil: java-maven-21; wspólny POM, zależności i testy pozostają niezmienione. Napraw zachowanie HTTP w src/main/java/demo/ApiApplication.java.

Materiał: error-contract. Autorskie opracowanie PairCoach, nie książka użytkownika.
