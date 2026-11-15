# Napraw aktualizację warunkową

BUGFIX: GET /items/1 zwraca reprezentację i ETag. PUT /items/1 wymaga If-Match: brak daje 428, stary ETag daje 412 BEZ zmiany danych. Poprawna wersja daje 200 i nowy ETag. Porównanie wersji i zapis muszą być atomowe (współbieżne żądania nie mogą oba wygrać na tej samej wersji). Starter pomija kontrolę wersji.

Profil: java-maven-21. POM i testy są częścią kontraktu; nie zmieniaj zależności.

Materiał: conditional-update. Autorskie opracowanie, nie książka użytkownika.
