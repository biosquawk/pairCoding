# REST w praktyce

Autorskie opracowanie szkoleniowe PairCoach, nie materiał z książki użytkownika. Brak dostarczonego PDF i additionalContext.txt.

## 1. Metoda i status

GET odczytuje zasób bez zmiany jego stanu. Odpowiedź 200 zawiera reprezentację. POST tworzący zasób zwraca 201 oraz nagłówek Location wskazujący utworzony zasób. Status odpowiedzi i treść JSON są częścią kontraktu HTTP.

## 5. Aktualizacja warunkowa

Klient może wysłać If-Match z otrzymaną wersją ETag. Serwer porównuje wersję i aktualizuje zasób atomowo. Nieaktualny If-Match oznacza 412 i nie zmienia danych. Sukces zwraca nowy ETag. Bez nagłówka wymaganego kontraktem odpowiedz 428.

## 2. DTO i walidacja wejścia

DTO oddziela kształt wejścia od odpowiedzi. Mapuj pola według znaczenia, nie ujawniaj wewnętrznych pól. Niepoprawny JSON daje 400. Sprawdź też brakujące i puste wartości oraz granice liczb; samo parsowanie JSON nie jest walidacją reguł domeny. Odrzucone wejście nie może utworzyć zasobu.

## 3. Błędy i kontrakt odpowiedzi

Rozróżniaj brak zasobu (404), niepoprawne wejście (400) i konflikt poprawnego żądania z aktualnym stanem (409). Zwróć stabilny kod błędu w JSON zamiast HTML lub przypadkowego 500. Odrzucone żądanie nie może zmieniać danych. Poprawne żądanie nadal musi działać.

## 4. Przeglądarka i kolekcje

Przeglądarka sprawdza CORS przez OPTIONS z Origin i Access-Control-Request-Method. Zezwól wyłącznie na zadeklarowane origin i metody; nie zastępuj kontroli wildcardem. Kolekcja ma postać tablicy JSON, także gdy jest pusta. Filtr nie zmienia przechowywanych danych. W paginacji ustal kolejność, zakres parametrów i offset równy page razy size; strona poza zakresem może zwrócić pustą tablicę.

## 5a. Idempotentne utworzenie

Idempotency-Key wiąże żądanie utworzenia z jego wynikiem. Powtórzenie tego samego klucza i danych odtwarza odpowiedź bez nowego skutku, a ten sam klucz z innymi danymi daje 409 bez zmiany stanu. Nowy klucz oznacza nowe żądanie. Sprawdzenie klucza i zapis wyniku muszą być atomowe. Pamięć procesu wystarcza w ćwiczeniu, nie jest gwarancją trwałości po restarcie.

## 5b. Warunkowe usunięcie

DELETE z If-Match sprawdza wersję przed usunięciem. Brak wymaganego warunku daje 428, stary ETag daje 412 i zachowuje zasób. Sukces 204 nie ma treści. Porównanie i usunięcie są atomowe: z dwóch konkurujących żądań dla tej samej wersji tylko jedno może usunąć zasób. Dla już nieistniejącego zasobu kontrakt ćwiczenia zwraca 404.
