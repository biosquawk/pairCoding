# REST w praktyce

Autorskie opracowanie szkoleniowe PairCoach, nie materiał z książki użytkownika. Brak dostarczonego PDF i additionalContext.txt.

## 1. Metoda i status

GET odczytuje zasób bez zmiany jego stanu. Odpowiedź 200 zawiera reprezentację. POST tworzący zasób zwraca 201 oraz nagłówek Location wskazujący utworzony zasób. Status odpowiedzi i treść JSON są częścią kontraktu HTTP.

## 5. Aktualizacja warunkowa

Klient może wysłać If-Match z otrzymaną wersją ETag. Serwer porównuje wersję i aktualizuje zasób atomowo. Nieaktualny If-Match oznacza 412 i nie zmienia danych. Sukces zwraca nowy ETag. Bez nagłówka wymaganego kontraktem odpowiedz 428.
