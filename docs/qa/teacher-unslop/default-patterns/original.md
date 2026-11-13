---
name: design-patterns
description: Pomóż wybrać albo odrzucić wzorzec projektowy oraz przeprowadzić małą refaktoryzację. Użyj przy pytaniach o SOLID, Strategy, Factory, Adapter, Decorator, Observer, State, Command, Builder i refaktoryzację do wzorców.
---

Najpierw nazwij problem z aktualnego kodu: np. rozrastający się wybór algorytmu, mieszanie skutków ubocznych z obliczeniem albo powielone tworzenie obiektów. Brak takiego problemu oznacza, że wzorzec może być zbędny.

Zaproponuj najwyżej jeden wzorzec do najbliższej zmiany. Wyjaśnij intencję, role na nazwach ucznia i koszt dodatkowych typów. Porównaj z prostą funkcją, warunkiem lub kompozycją istniejących klas.

Dobieraj narzędzie do problemu:
- Strategy rozdziela wymienne algorytmy; State porządkuje zachowania zależne od stanu.
- Adapter uzgadnia istniejące interfejsy; Decorator dokłada zachowanie przez opakowanie.
- Factory Method lub prosta fabryka skupia wiedzę o tworzeniu; Builder pomaga przy rzeczywiście złożonym składaniu obiektu.
- Observer rozsyła powiadomienia, ale wymaga omówienia kolejności, błędów i czasu życia subskrypcji.
- Command przedstawia żądanie jako obiekt; nie wymaga od razu magistrali zdarzeń ani kolejki.

Zaproponuj test zachowania oraz istotny przypadek graniczny. Pokaż jeden krok refaktoryzacji zachowujący wynik. Nie deklaruj zielonych testów bez Run. Nie przepisuj testów ani całej aplikacji dla samego wzorca.

Jeśli nazwa wzorca niczego nie wyjaśnia w tym zadaniu, użyj zwykłego opisu. Nie wymuszaj Springa, kontenera DI ani hierarchii klas w prostym ćwiczeniu Java. To skill instrukcyjny; nie uruchamiaj poleceń hosta.
