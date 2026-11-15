# Domknięcie zaakceptowanych zmian — 13.11.2026

Zakres: osiem poleceń właściciela po ręcznym odbiorze GUI, Codexa i charakteru Halloween. Publikacja na `stabilize/single-operator-20261113`; bez automatycznego scalania do main. Role Thalamusa pozostają PAUSED.

## 1. Zaakceptowana wersja

Commit `9e02881`: kompaktowy pasek, Solarized Light/Dark, stabilne drzewo plików, natywne karty AGENTS i skille, start obserwowania po zapisie, obowiązkowe wskazanie zakresu ostrzeżenia. Push przez istniejący OpenSSH Windows; bez kopiowania klucza prywatnego do Ubuntu.

## 2. Zaległe kontrole zmienionych ścieżek

- Początkowy wynik: 234/239 PASS. Trzy fixture miały nieprywatny katalog `.paircoach`; dwie asercje nadal wymagały stałego wyboru default lub osobowości zaszytej w prompt.ts. Poprawiono przygotowanie fixture i kontrakty testów zgodnie z zaakceptowaną zmianą; progi i zabezpieczenia produkcyjne pozostały bez zmian.
- Po poprawkach i dodaniu regresji: 243/243 PASS — `tests/coach/*.test.ts`, `tests/client/*.test.ts`, `tests/integration/coach-http.test.ts`, kontrole finish-admission z `tests/coach/finish-admission-p1.test.ts`. Czas 61,2 s. Obejmuje zgodę AI, ręczną pauzę, start po pierwszym zapisie, brak podwójnego wywołania, ostrzeżenie z showPointer=false oraz odwołanie starego wskaźnika po edycji.
- Pakowanie i weryfikator źródeł: 70/70 PASS. Typecheck i build: exit 0.
- WSL Chromium + rzeczywisty HTTP/WS/Monaco + kontrolowany provider: czerwony i zielony dymek zmieniają tekst/tło po zmianie motywu; czerwony z showPointer=false wskazuje linię na żółto w obu motywach. To test protokołu/GUI, nie dowód odpowiedzi fizycznego modelu. Dowód: `paircoach-live-20261113/closure-gui/proof.json` obok repozytorium.
- Realny Codex i natywne AGENTS/skille mają wcześniejsze oddzielne dowody LIVE w `paircoach-live-20261113/ai-tree-live/character-*-proof.json`.

Nie uruchamiano ponownie 27-minutowego pełnego suite. Historyczny FAIL pełnego suite pozostaje FAIL; powyższe wyniki nie są pełnym odbiorem całego Zadania 9 ani natywnego Windowsa. Produkcja odpowiada bazie 9e02881; kolejne zmiany tego kroku dotyczą testów i tego zapisu.

## 3. Powrót do default

Ustawiono globalne `character: default` w `paircoach.config.json`. Pakiet Halloween pozostaje do późniejszego wyboru; model gpt-6.1-sol i reasoning medium pozostają bez zmian. Charakter obowiązuje po restarcie backendu.

## 4. Quality Guard MCP

Wersja 1.3.0rc2, build 34; `audit_project(refresh_coverage=true, mode=sonar)`, inspekcje `character.ts` i `CoachAdapter.ts`, następnie `claim_quality_gate(mode=sonar)`. Audyt: BLOCKED; bramka: REJECTED, bez nowego baseline. Analiza obejmowała 190 plików i 4863 funkcje, w tym historyczny JDT, skrypty i celowo czerwone ćwiczenia. Coverage Node nie ma skonfigurowanego pomiaru LCOV; próba Python nie wykonała testów, a szablony Java/Spring zgodnie ze swoim celem nie rozwiązują zadań. To nie jest wiarygodny wynik jakości całego wydania ani lista potwierdzonych błędów funkcjonalnych. Nie zmieniono asercji ani błędnych rozwiązań ćwiczeń dla uzyskania PASS. Szczegóły i lokalizacja pełnego raportu: [quality-guard-20261113.json](quality-guard-20261113.json).

Wykonano lokalne regresje adaptera i kart po audycie; 35/35 PASS, 21,9 s. Historyczny wynik pełnej bramki pozostaje REJECTED. Danych `.metrics` i kompilacji `target` nie publikuje się jako kodu produktu.

## 5. Profesjonalny trener

Rozwinięto default o uczenie na małym przykładzie, wyjaśnienie przyczyny i skutku, odróżnienie analizy od wyniku Run, czytelne odpowiedzialności i refaktoryzację do wzorca dopiero przy rzeczywistym problemie. Dodano instrukcyjny skill design-patterns w obu charakterach. Inspiracje i źródła opisuje [characters/README.md](../characters/README.md); trener nie podszywa się pod wskazane osoby. Wspólne zasady przewidują równoległą pracę w IntelliJ; osłony kodowe to osobny krok 8. Halloween zachowuje własną konwencję. Testy kart, kontraktu i providera sprawdzono celowanie po tej zmianie.

## 6. AI_unslop — instrukcje

Przeczytano instrukcję MCP i oceniono wszystkie jednostki sześciu plików: dwie karty AGENTS, dwa skille lesson-feedback i dwa design-patterns. Próg naprawy 3, maksymalna dopuszczalna ocena 2. Poprawiono po dwie niezręczności w kartach i po jednej w skillach wzorców; pozostałe zdania zachowano. `verify_workspace`: completed=true dla 6/6, brak unresolved_cells, zgodne Markdown/JSON/PNG. Oceny języka pochodzą od operatora; MCP nie ma własnego modelu oceniającego. Historie, oryginały i obrazy: [teacher-unslop](qa/teacher-unslop/). Zapisano osobny commit audytu przed poprawkami.

## 7. Java Puzzlers

Dodano 10 niezależnych zadań w [java-puzzlers](../java-puzzlers/README.md), polecenia po polsku, Maven/JUnit, konfigurację Run Main/Tests oraz jawny inicjalizator ustawień. Pierwsze osiem wymaga przewidywania wyniku, dziewiąte deklaracji, a dziesiąte sprawdza kompilowalność wariantu Object/String na współczesnym JDK. Pierwsza próba wykazała, że początkowe założenie nowego testu 10 było błędne: obie formy się kompilują. Zachowano dowód i opisano adaptację; nie wymusza się nieistniejącego błędu.

Rzeczywisty Docker, przypięty JDK21, cache zależności read-only, sieć wyłączona, nieuprzywilejowany użytkownik i izolowane kopie: 10/10 projektów czerwonych na początku i 10/10 zielonych po kontrolowanym uzupełnieniu odpowiedzi (22 testy). Run Main wykonano dla wszystkich zielonych kopii. Rozwiązania nie nadpisały zadań repozytorium. Test pakowania i ustawień: 71/71 PASS. Dowody i hashe: [java-puzzlers-verification-20261113.json](java-puzzlers-verification-20261113.json). To nie jest dowód GUI dla całej dziesiątki.

## 8. IntelliJ i końcowy przebieg produktu

Wyłączono metadane IDE/VCS i artefakty (`.idea`, `.git`, `target`, `.gitignore`, `.iml`, `.ipr`, `.iws`, dodatkowo `.vscode`) w istniejących osłonach WorkspaceService, SnapshotStorage, kontekstu trenera i ImmutableInput. Nie zmieniano obrazów Dockera ani mechanizmu zapisu. Profile już zawierają instrukcję normalnej współpracy z IDE; nie zmieniano ich po audycie AI_unslop.

- 43/43 PASS: obserwacja, kontekst i snapshoty; 12/12 PASS: wejście Run oraz jego uprawnienia. Test z nieczytelnymi katalogami metadanych potwierdza brak ich przeszukiwania, brak wybudzania AI i zmian workspaceVersion od metadanych. Przywrócenie źródła pozostawia je nietknięte. Typecheck: exit 0.
- Końcowy LIVE: normalny npm start, WSL Chromium, rzeczywisty Codex gpt-6.1-sol medium, profesjonalny default i natywny design-patterns. Odpowiedź wyjaśnia brak wymiennych algorytmów i zbędność Strategy, odwołuje się do kodu oraz proponuje najbliższy krok. Brak persony klauna.
- Nowy puzzler w GUI: Main SUCCEEDED; początkowe testy FAILED (2 wykonane); literalna edycja w Monaco i ACK zapisu; Docker testy PASSED (2), exit 0, kontener REMOVED. Zapis źródła wykonany poza GUI trafia do Monaco. Metadane .idea/.git/target/.iml/.gitignore mają niezmienione hashe. To symulacja zapisu IDE w WSL, nie test natywnego IntelliJ na Windows.
- Pierwszy harness po poprawnych AI/Main/czerwonych testach wpisał cały plik jako symulowane naciśnięcia i uruchomił autoindent. Zachowano FAIL tej automatyzacji; kontynuacja użyła pojedynczej literalnej edycji. Nie zmieniano z tego powodu autosave ani edytora. Dowody: `paircoach-live-20261113/closure-product/proof-before-paste-harness-correction.json` i `resume-proof.json`.
- Starszy przygotowany obraz nadal wypisuje ostrzeżenie Jansi o noexec w /tmp; obserwowane Run/Main/Test kończą się zgodnie z wynikiem. W tym zakresie nie przebudowywano obrazów ani nie przedstawiano tego komunikatu jako naprawionego.

Publikacja obejmuje osiem zleconych kroków na gałęzi stabilizacyjnej. Ostatni wynik Quality Guard pozostaje REJECTED (pomiar po kroku 3); późniejsze osłony mają własne testy celowane, nie nową pełną bramkę. Nie oznacza to pełnego PASS historycznego npm test, odbioru wszystkich języków/Windows ani całego Zadania 9. Thalamus i jego role nie zostały wznowione.

## 9. Uzupełnienie: coverage i rzeczywiste MCP Quality Guard

Kod integracji: `96a52adf0bda11fc57975bb09446cc6bc77b626d`, baza `8a1a03e`.
Ten etap dodaje działający pomiar pokrycia i połączenie z narzędziem oceny kodu.
Nie stanowi pełnego odbioru całego produktu lub historycznego Zadania 9.

Dodano c8 12, mapowanie do TS/TSX, LCOV oraz jawną granicę kodu produkcyjnego.
`npm run coverage` wykonuje opisany w README podzbiór, nie pełny `npm test`.
Pomiar zachowuje także niewykonane źródła; nie obniżono progów i nie ukryto trudnych plików.
Konfiguracja Quality Guard używa przenośnego `node`; PATH lokalnego serwera MCP
ustawiono w konfiguracji Thalamusa, poza opublikowanym produktem. Zaktualizowano
zależne kontrole pakowania i integralności nowych skryptów.

Końcowy wynik lokalny na `96a52ad`:

- 164/164 pliki w LCOV, w tym 130 całkowicie niepokrytych; wybrano 15 plików testów,
  pozostałe 246 aktywnych plików testowych pozostają niewykonane w tym pomiarze.
- Dwie grupy testów: 138/138 i 139/139 PASS; pomiar zakończony exit 0 w 62,14 s.
- Pokrycie linii 14,29%, gałęzi 73,09%, funkcji 48,51% według tego pomiaru.
  To nie jest miara pokrycia wszystkich scenariuszy aplikacji.
- Niezależne testy poprawki cleanup: 8/8 PASS; 16/16 prób bez żywego potomka
  w chwili powrotu; negatywny kontrtest poprawnie zwraca błąd z timedOut=true.
- Typecheck i build ROOT: exit 0 na `23c6bf9`. Między nim a `96a52ad` zmieniły się
  wyłącznie skrypt coverage MJS i jego test MJS; wejścia kompilacji TS/Vite są identyczne.
- Środowisko: Ubuntu/WSL2, Node 22.22.2. Pełny suite oraz nowe kampanie Windows,
  GUI i Docker nie były wykonywane dla tej zmiany narzędzi developerskich.

Weryfikacja wykryła dwa rzeczywiste problemy nowego wrappera: powrót przed
potwierdzeniem śmierci potomka po SIGKILL oraz brak odrzucenia Promise, gdy cleanup
nie może się zakończyć. K poprawił je w swojej linii po zatrzymaniu sesji DEV;
VERIFY niezależnie odtworzył błędy na poprzednich rewizjach i potwierdził poprawkę.
Historyczne FAIL nie zostały zastąpione nowymi etykietami PASS. Ograniczenia Windows,
procesów celowo opuszczających grupę i zadań systemowych niepodatnych na sygnały opisano w README.

Rzeczywiste `audit_project(refresh_coverage=True, mode="sonar")`, `inspect_unit`
i `claim_quality_gate` wykonano na `acdb024`. Audyt odczytał pomiar (`MEASURED`),
ale nie potrafił przeanalizować trzech istniejących plików TypeScript:
`RuntimeExecutionLayout.ts`, `PairCoachClient.ts` i `paircoach.ts`. TypeScript rozpoznaje
ich składnię; nie poprawiano prawidłowego kodu wyłącznie pod ograniczenie parsera wtyczki.
Werdykt narzędzia pozostał `REJECTED`, bez pieczęci zaliczenia; nie wykonano przez to
końcowego baseline narzędzia. Raport odnotowuje także niski poziom pokrycia części źródeł.
Nie przeniesiono tego audytu na późniejszy SHA: bramka `96a52ad` jest **nieoceniona**,
a końcowa poprawka ma odrębne testy i aktualny lokalny pomiar. Nie ogłaszamy zielonej bramki.

Pracę wykonał Thalamus: DEV, niezależny VERIFY, integrujący K/LEAD oraz JUDGE/GOVERNOR.
ROOT przeczytał kod, raporty i końcowe oceny. Wszystkie role używały gpt-6.1-sol/high.
Raporty i pełne logi zachowano w projekcie software_dev_2 w deliveries; duże odpowiedzi
narzędzia nie są dołączane do publicznego repozytorium. Thalamus pozostaje uruchomiony.

Osobno naprawiono środowisko Maven IntelliJ/WSL: cache użytkownika należał do root:root,
co blokowało pobieranie JUnit i pluginów. Przywrócono darulec:darulec; ten sam Maven
z IntelliJ wykonał `clean package dependency:build-classpath -DskipTests` z exit 0 na
JDK 27 i release 11. Skompilowano też testy; nie uruchamiano ich ani nie rozwiązano ćwiczenia.
Właściciel potwierdził działanie IDE. Publiczne PairCoding pozostawiono na 01-oddity,
bez restartu sesji i bez modyfikacji rozwiązania użytkownika.

## 10. IntelliJ + Maven w WSL — sprawdzona naprawa, 14.11.2026

Przypadek: IntelliJ IDEA 2025.2.6 uruchomione w Windows, projekt w Ubuntu/WSL:
`\\wsl.localhost\Ubuntu\home\darulec\dev\codex_prjects\pairCoding-publication-20261112\java-puzzlers\01-oddity`.
Projekt używa JDK 27 w WSL, a Maven kompiluje z `release 11`.
Poniższe trzy problemy wystąpiły oddzielnie; nie należy naprawiać ich jedną
operacją Invalidate Caches ani zmieniać z tego powodu POM-u.

### A. Maven nie może pobrać bibliotek: właściciel cache root:root

Objaw: `AccessDeniedException` przy tworzeniu plików w repozytorium Maven
użytkownika, np. dla `maven-clean-plugin`; JUnit i pluginy pozostają nierozwiązane.
W tym przypadku repozytorium należało do `root:root` zamiast `darulec:darulec`.
Naprawiono właściciela cache, a ten sam Maven z IntelliJ skompilował kod i testy
(szczegóły poprzedniej naprawy w §9).

Kontrola i ewentualne powtórzenie naprawy w terminalu WSL, jako darulec:

```bash
id
ls -ld "$HOME/.m2" "$HOME/.m2/repository"
find "$HOME/.m2/repository" -user root -print -quit
# Tylko po potwierdzeniu błędnego właściciela własnego repozytorium:
sudo chown -R darulec:darulec /home/darulec/.m2/repository
```

Jeżeli sam katalog `.m2` również należy do root, poprawić jego właściciela
osobno: `sudo chown darulec:darulec /home/darulec/.m2`.
Nie stosować `chmod 777`, nie zmieniać właściciela całego katalogu domowego
i nie uruchamiać zwykłego Mavena przez sudo. To instrukcja odtworzenia wcześniejszej
naprawy, nie zapis ponownego wykonania tych komend 14 listopada.

### B. Kod się kompiluje, ale IntelliJ nie widzi źródeł/JUnit

Po ręcznym oznaczaniu katalogów i czyszczeniu cache model Maven w IDE nadal miał
poziom `JDK_1_5`, nierozwinięte ścieżki `${project.build.directory}` i brak bibliotek
JUnit. Samo `mvn clean install` nie naprawiało modelu projektu w IDE.

W **Settings → Build, Execution, Deployment → Build Tools → Maven → Importing**
ustawienie **JDK for importer → Use Project JDK** było już prawidłowe
(`openjdk-27 (WSL)`). Dopiero **Reload All Maven Projects** w oknie Maven naprawiło
import. Po przeładowaniu zapisany model miał `JDK_11`, prawidłowe katalogi źródeł
i osiem bibliotek JUnit oraz jego zależności. Właściciel potwierdził zniknięcie
czerwonych importów. Nie trzeba było zmieniać wersji JUnit, JDK ani release.

### C. Play przy main: błąd EEL/JPS, potem niechciane install

Objaw przy uruchamianiu `demo.Puzzler`:

```text
Failure of obtaining prefix: could not convert LocalEelDescriptor to EelPath.
The path does not belong to the default NIO FileSystem
```

Log IntelliJ wskazał `EelBuildCommandLineBuilder` i `BuildManager.launchBuildProcess`:
błąd występował przy przygotowaniu kompilacji JPS przed startem main.
W tym momencie model Maven nadal miał Java 11 i osiem bibliotek; nie stwierdzono
ponownego uszkodzenia importu. Maven z IntelliJ potrafił skompilować kod i testy.
Opis podobnego błędu producenta: [IJPL-211854](https://youtrack.jetbrains.com/issue/IJPL-211854).

Pierwsze obejście — zaznaczenie **Delegate IDE build/run actions to Maven** —
było zbyt szerokie. Istniejące zadanie **Build/Make** przed uruchomieniem zostało
wykonane jako Maven `install`, więc Play uruchamiało również testy.
Właściciel słusznie zgłosił ten niepożądany efekt.

**Działająca konfiguracja, potwierdzona przez właściciela 14.11.2026:**

1. **Settings → Build, Execution, Deployment → Build Tools → Maven → Runner**:
   odznaczyć **Delegate IDE build/run actions to Maven**.
2. **Run → Edit Configurations → Application → Puzzler**:
   klasa główna `demo.Puzzler`, moduł `strategy-kata`, JDK projektu z WSL.
3. W **Before launch** usunąć **Build/Make** i ewentualne zadanie Maven `install`.
4. Dodać **+ → Run Maven Goal**, wskazać `pom.xml` tego ćwiczenia,
   w polu polecenia wpisać wyłącznie **`compile`**.
5. Zatwierdzić i uruchomić Play przy main.

Wynik: **Maven compile → uruchomienie main**, bez `install` i bez testów.
Kompilacja przed startem pozostaje włączona, więc main nie korzysta celowo ze
starych klas. Testy uruchamia się oddzielnie przez `test` lub konfigurację testową.
Nie dodano globalnego `skipTests` i nie zmieniono zadania ani jego asercji.
Instrukcję konfiguracji zadań przed startem opisuje również
[dokumentacja IntelliJ](https://www.jetbrains.com/help/idea/work-with-maven-goals.html).

### Granice ustalenia

PairCoding wykonuje Maven w kontenerze na izolowanej kopii wejścia, z oddzielnym
cache; IntelliJ używa własnego repozytorium Maven w WSL. W porównaniu zapisów
przed i po kontrolowanej sekwencji nie zmieniły się POM ani źródła, a poprawiony
model IDE zachował biblioteki. Późniejsze `clean/install` użytkownika zmieniało
lokalny `target`; nie przypisujemy tych zmian kontenerowi PairCoding.

Nie naprawiano tym krokiem wewnętrznego błędu IntelliJ — zastosowano sprawdzone
obejście konfiguracji uruchamiania. Ostrzeżenie Jansi o `noexec` w kontenerze
jest odrębnym problemem. Czerwony test z `prediction = "I don't know"` oznacza
niedokończone ćwiczenie, a nie brak JUnit ani błąd kompilacji.

Porównania modelu IDE i logi diagnostyczne zachowano poza repozytorium:
`\\wsl.localhost\Ubuntu\home\darulec\dev\codex_prjects\paircoach-live-20261114\intellij-coexistence`.
Końcowe działanie Play potwierdził właściciel; nie wykonywano ponownie pełnego
suite produktu ani automatyzacji GUI IntelliJ dla tego zapisu.

## 11. Ostatnio otwierane projekty

Dodano listę 10 ostatnich projektów w panelu plików: nazwa, pełna ścieżka,
otwarcie jednym kliknięciem i usunięcie samego skrótu. Zapamiętywanie korzysta
z localStorage tej przeglądarki dla adresu aplikacji. Nie dodano magazynu backendu,
skanowania dysku ani automatycznego otwierania projektu przy starcie.
Lista zapisuje wyłącznie potwierdzone projekty, usuwa duplikaty i ogranicza rozmiar.
Otwieranie przechodzi przez dotychczasowe projectAction/openDurableProject,
autosave/ACK, kontrolę bieżącego wykonania i trenera. Brak magazynu przeglądarki
ma jawny komunikat i nie odbiera zwykłego wyboru projektu.

Testy celowane: 17/17 PASS, typecheck i build exit 0. Nowy test jest wybierany
przez istniejący runtime-test.mjs. WSL Chromium z produkcyjnym buildem i prawdziwym
HTTP/WS/Monaco: otwarcie A/B, MRU, anulowanie, restart backendu i strony,
otwarcie z listy, zapis oczekującej edycji A przed przejściem do B, nieudane
otwarcie brakującego pliku bez porzucania B, usunięcie skrótu bez usuwania danych,
ponowne dodanie bieżącego projektu po jego otwarciu i odmowa localStorage — PASS.
To odbiór tej funkcji, bez ponownej kampanii Docker/AI i pełnego npm test.
Dowód lokalny:
`\\wsl.localhost\Ubuntu\home\darulec\dev\codex_prjects\paircoach-live-20261114\recent-projects-smoke\proof.json`.

Po zgłoszeniu właściciela odtworzono konflikt starej pustej karty: inne okno
otworzyło już projekt, a stara karta nadal wysyłała `projectId: null`.
Klient uzgadnia teraz wyłącznie jawne odrzucenie HTTP 409 `PROJECT_STATE_CHANGED`,
jeżeli autoryzowany GET potwierdzi dokładnie żądany plik projektu i karta nie ma
lokalnego projektu, sesji ani oczekujących zapisów. Nie ponawia POST i nie omija
normalnego HELLO/dzierżawy. Inny projekt, nieznany wynik transportu i niedostępny
odczyt nie są uznawane za sukces. Ponowne połączenie usuwa również stary lokalny
komunikat formularza; nowe błędy backendu pozostają widoczne.

Pole Bieżący folder w FolderPicker jest edytowalne, obsługuje wklejenie ścieżki,
Enter oraz Przejdź. Nieodczytana/błędna ścieżka blokuje wybór poprzednio wyświetlonego
folderu. Testy celowane po poprawce: 23/23 PASS; typecheck i build exit 0.
GUI na prawdziwym HTTP/WS: dwie odrębne karty i pojedynczy odrzucony POST z poprawnym
odczytem oraz HELLO; wklejanie ścieżki Linux ze spacjami/diakrytyką, Enter/Przejdź,
nieistniejący katalog, anulowanie i przejście A→B bez zmiany źródła A — PASS.
Dowód: `recent-projects-smoke/path-and-conflict-proof.json` obok powyższego dowodu.
