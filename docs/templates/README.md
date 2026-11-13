# Szablony zadań PairCoding

Każdy folder zawiera kompletne źródła małego ćwiczenia, celowy błąd, testy, `challenge.md` i pełne ustawienia `settings.v2.json`. Skopiuj szablon do własnego folderu zadania; pracuj na kopii. Nie kopiuj metadanych, identyfikatorów sesji, historii ani snapshotów innego zadania.

| Folder | Profil runtime | Edytowany plik | Weryfikacja |
|---|---|---|---|
| [java](java/challenge.md) | `java-maven-11`, `java-maven-17`, `java-maven-21` lub `java-maven-27` | `src/main/java/demo/HelloWorld.java` | JUnit, trzy testy |
| [spring-boot](spring-boot/challenge.md) | `java-maven-21` lub `java-maven-27` | `src/main/java/demo/CounterApplication.java` | JUnit, HTTP `/sum`, Stop |
| [javascript](javascript/challenge.md) | `javascript-node` | `main.js` | Node test runner → JUnit XML |
| [typescript](typescript/challenge.md) | `typescript-node` | `main.ts` | `tsc`, Node test runner → JUnit XML |
| [python](python/challenge.md) | `python-3.13` | `calculator.py` | pytest → JUnit XML |

Java ma target Maven `11`, a Spring Boot target `21`. Wybranie nowszego JDK nie wymaga podnoszenia tego targetu. Profile runtime i rzeczywiste wersje narzędzi są określone przez istniejący katalog oraz przygotowane obrazy aplikacji — szablon ich nie zastępuje. Spring używa przypiętej wersji obsługiwanej obecnie przez adapter, `4.1.2`.

## Pierwsze użycie

1. Skopiuj cały wybrany folder do własnego katalogu, np. `cwiczenia/01-dodawanie`. Nie umieszczaj tam `node_modules`, `target`, `.venv` ani cudzej `.paircoach`.
2. Otwórz terminal **w katalogu nowego zadania**, obok `settings.v2.json`. Jednorazowo utwórz prywatny katalog ustawień poniższą komendą. W Bash/WSL użyj poniższej komendy; wymaga wyłącznie Node.js używanego przez platformę:

   ```sh
   node -e 'const fs=require("node:fs");fs.mkdirSync(".paircoach",{recursive:true,mode:448});fs.chmodSync(".paircoach",448);fs.copyFileSync("settings.v2.json",".paircoach/settings.json",fs.constants.COPYFILE_EXCL);fs.chmodSync(".paircoach/settings.json",384)'
   ```

   W natywnym PowerShellu ten sam kod można przekazać na stdin, unikając różnic w cytowaniu argumentów:

   ```powershell
   @'
   const fs = require("node:fs");
   fs.mkdirSync(".paircoach", {recursive:true, mode:448});
   fs.chmodSync(".paircoach", 448);
   fs.copyFileSync("settings.v2.json", ".paircoach/settings.json", fs.constants.COPYFILE_EXCL);
   fs.chmodSync(".paircoach/settings.json", 384);
   '@ | node
   ```

   Tryby `448` i `384` to odpowiednio `0700` i `0600` w zapisie dziesiętnym. Komenda celowo odmawia nadpisania istniejących ustawień. Uruchamiaj ją wyłącznie w nowej kopii szablonu. Na Windows uprawnienia dostępu wynikają również z ACL konta użytkownika.

3. Jeśli profil języka/JDK jest już aktywny, otwórz nowy folder przez **Otwórz folder…** w aplikacji. Wybór startuje w katalogu nadrzędnym aktualnego zadania. W backendzie WSL wybierasz rzeczywiste katalogi WSL; nie importujesz plików przez przeglądarkę.
4. Nowy zestaw zależności wymaga zwykłego przygotowania. W katalogu aplikacji użyj istniejącego publicznego polecenia, podstawiając rzeczywiste ścieżki backendu i wybrany profil:

   ```sh
   npm run runtime:prepare -- --project /pelna/sciezka/do/zadania --profile java-maven-21 --output /pelna/sciezka/do/nowego-katalogu-przygotowania --prepare-timeout-ms 3600000 --execute
   ```

   Podane ścieżki są przykładami do zastąpienia, nie konfiguracją gotową do uruchomienia. Katalog wyjściowy musi być nowy i znajdować się poza zadaniem. Szczegóły uruchomienia z `--prepared-runtime`, przygotowania Windows i katalogu runtime: [instrukcja Windows](../windows-start.md). Nie uruchamiaj narzędzi zadania na hoście jako obejścia braku przygotowanego środowiska.
5. Zmiana rodziny języka albo wersji JDK nadal wymaga zmiany `activeProfile` i `workspaceRoot` w głównym `paircoach.runtime.json`, przygotowania właściwego obrazu oraz restartu aplikacji. Ścieżki względne w tej konfiguracji liczone są od jej pliku. `Otwórz folder…` zmienia zadanie w obrębie aktywnego profilu, nie przełącza języka.
6. Wykonaj cykl opisany w `challenge.md`: test czerwony → własna poprawka → zapis/ACK → test zielony. Nie zmieniaj testów, by dopasować je do błędnego rozwiązania. Zgoda AI w szablonach jest domyślnie wyłączona; włącz ją w ustawieniach i uruchom sesję, jeśli chcesz używać trenera.

## Tworzenie kolejnych ćwiczeń

Zmieniaj opis w `challenge.md`, kod startowy i testy. Przy zmianie nazwy pliku lub klasy zaktualizuj odpowiednio `entry.path` / `entry.className` oraz selektory `tests.paths` / `tests.names` w ustawieniach. Dla Java/Maven `tests.paths` pozostaje puste; nazwy testów określa `tests.names`. Dopasuj `contextPatterns`, jeżeli dodajesz inne katalogi źródeł.

Nie wpisuj do szablonów kluczy API, tokenów, ścieżek prywatnych użytkownika ani identyfikatorów projektu. Każda kopia zadania otrzymuje własne metadane podczas otwierania. Nie kopiuj do następnego ćwiczenia katalogu `.paircoach` z już uruchomionej sesji.

To materiały startowe, nie deklaracja zaliczenia całej macierzy języków ani wydania Zadania 9. Źródła i zależności wzorców bazują na obecnych przykładach repozytorium; osobny runtime każdego języka wymaga własnego przygotowania.
