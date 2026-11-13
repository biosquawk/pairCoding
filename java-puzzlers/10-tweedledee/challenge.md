# Puzzle 10: Tweedledee — sprawdź współczesny kompilator

Oryginalna zagadka prosi o deklaracje, dla których `x = x + i` jest legalne, a `x += i` nie. W tej adaptacji badamy konkretny wariant kojarzony z zagadką:

```java
Object x = "a";
String i = "b";
```

Przewidź niezależnie kompilowalność `x = x + i;` i `x += i;`. Wpisz `COMPILES` lub `FAILS` w `simplePrediction()` i `compoundPrediction()`. Nie zmieniaj deklaracji ani testów. Run Main pokazuje twoje prognozy, a Run Tests konfrontuje je z JavaCompiler w kontenerze.

**Ważne:** na użytym tutaj JDK 21 ten wariant nie rozdziela obu przypisań — oba się kompilują. Ćwiczenie uczy weryfikowania historycznej zagadki w rzeczywistym środowisku, zamiast wymuszania błędu kompilatora. Nie twierdzimy, że wyczerpuje wszystkie możliwe deklaracje z pierwotnego polecenia.

Wyjaśnij w komentarzu, dlaczego wynik konkatenacji można przypisać do Object i jakie znaczenie ma niejawne rzutowanie w przypisaniu złożonym. Porównaj z zadaniem 9. Podstawa: [JLS §15.26.2](https://docs.oracle.com/javase/specs/jls/se21/html/jls-15.html#jls-15.26.2). Nie zakładaj wyniku dla innej wersji bez jej sprawdzenia.
