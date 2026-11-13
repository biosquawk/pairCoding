# Puzzle 9: Tweedledum

Znajdź deklaracje zmiennych `x` oraz `i`, dla których:

```java
x += i; // kompiluje się
x = x + i; // błąd kompilacji
```

Wpisz kompletne deklaracje z inicjalizatorami jako string zwracany przez `declarations()`. Same deklaracje muszą być poprawne. Oba przypisania badamy osobno, bez zmiany deklaracji między próbami. Nie odwołuj się do nieistniejących klas i nie używaj procesorów adnotacji.

Run Main pokaże twoją propozycję; Run Tests skompiluje oba warianty przez JavaCompiler wewnątrz wybranego kontenera JDK. Sukces programu Main nie dowodzi spełnienia zagadki. Testy wymagają poprawnych deklaracji, poprawnego pierwszego przypisania i błędu drugiego.

Dodaj komentarz: jaki typ ma wynik `+` i jakie dodatkowe reguły obowiązują przy `+=`? Nie zmieniaj testów.
