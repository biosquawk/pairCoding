# Napraw granice i offset strony

GET /items?page=0&size=2 stronicuje stałą kolekcję ID1notes,2tasks,3book,4pen,5map w tej kolejności. page liczymy od 0, size 1–3; domyślne page=0,size=2. Offset=page*size. Niepełna ostatnia strona jest poprawna, strona poza zakresem daje 200/[], także przy bardzo dużym page. Ujemne page, size0 lub >3 i niecałkowite parametry dają 400. Starter myli numer strony z offsetem.

Profil: java-maven-21; wspólny POM, zależności i testy pozostają niezmienione. Napraw zachowanie HTTP w src/main/java/demo/ApiApplication.java.

Materiał: browser-collections. Autorskie opracowanie PairCoach, nie książka użytkownika.
