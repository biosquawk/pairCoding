# Filtruj kolekcję bez mutowania danych

GET /items zwraca tablicę [{"id":1,"name":"notes"},{"id":2,"name":"tasks"}] w tej kolejności. Parametr q wybiera nazwy zawierające podciąg bez rozróżniania wielkości liter. Brak lub puste q oznacza wszystkie elementy; brak trafień daje 200 i [], nie 404. Filtr nie może zmieniać kolekcji. Starter ignoruje q.

Profil: java-maven-21; wspólny POM, zależności i testy pozostają niezmienione. Napraw zachowanie HTTP w src/main/java/demo/ApiApplication.java.

Materiał: browser-collections. Autorskie opracowanie PairCoach, nie książka użytkownika.
