# PairCoach

> **ETAP8: IMPLEMENTED / PENDING_FINAL_QA** (kolejka 4→9). To opis bieżącego
> kandydata, nie odbiór kampanii ani wydanie. Native Windows/PowerShell, świeża
> paczka wydania, realny model i pełne QA pozostają do wykonania po implementacji9.
> ETAP9 Docker/polyglot nie jest jeszcze zaimplementowany.

Lokalny trener programowania: edytor Monaco, czat z AI, uruchamianie programu i testów, snapshoty oraz raport końcowy. Interfejs i backend znajdują się w tym repozytorium.

## Charakter nauczyciela: AGENTS.md i skille

Edytuj [characters/default/AGENTS.md](characters/default/AGENTS.md) oraz [characters/default/skills](characters/default/skills/). To globalny profil nauczyciela, wspólny dla Javy, Pythona i innych zadań. W [paircoach.config.json](paircoach.config.json) ustaw `"character": "default"` albo `"character": "halloween-theme"`; w tym samym pliku wybierasz model i poziom rozumowania. Przy starcie trenera wybrany pakiet jest kopiowany do prywatnej instancji Codexa jako `AGENTS.md` i `.agents/skills`. Edytuj przed uruchomieniem; po zmianie zrestartuj aplikację, bez przebudowy.

[Instrukcja edycji, struktura i dodawanie własnych charakterów](characters/README.md). Repozytoryjny [AGENTS.md](AGENTS.md) jest instrukcją dla programistów aplikacji, nie dla nauczyciela.

## Uruchomienie

Wymagany Node.js **22.22.0 lub nowszy** i npm. Z katalogu sklonowanego repozytorium:

```sh
npm ci
npm run build
npm start
```

Otwórz **http://127.0.0.1:8080/**. `npm start` uruchamia backend REST/WebSocket z obsługą zbudowanego interfejsu. `npm run preview` uruchamia wyłącznie podgląd frontendu. Pozostaw terminal serwera otwarty.

Backend nasłuchuje lokalnie. Standardowy start developerski korzysta z lokalnego bootstrapu tokenu; nie ustawiaj `NODE_ENV=production` bez skonfigurowania sposobu przekazania tokenu klientowi.

## Trener AI i folder zadania

Dostęp do AI wymaga konfiguracji dostawcy oraz zaznaczenia zgody w ustawieniach projektu w interfejsie.

Przed rozpoczęciem pracy skonfigurowany trener ma status „Gotowy”. Pierwsza potwierdzona edycja kodu albo pytanie na czacie uruchamia sesję i obserwowanie przez trenera — nie wymaga wcześniejszego kliknięcia Start. Ręczna pauza, wyciszenie i brak zgody AI nadal obowiązują.

Przycisk **Otwórz folder…** nad drzewem plików pozwala wyklikać inne ćwiczenie bez restartu. Wybór zaczyna się w katalogu nadrzędnym obecnego zadania; dostępne są podfoldery, **Poziom wyżej**, **Otwórz ten folder** i **Anuluj**. Są to rzeczywiste katalogi backendu (przy backendzie w WSL — ścieżki WSL), bez importowania ani kopiowania plików. Zapis musi uzyskać ACK; aktywny program należy zatrzymać, a pisanie trenera przerwać przed przełączeniem. Profil języka/JDK pozostaje ten sam; jego zmiana nadal wymaga konfiguracji i restartu.

- **Codex:** ustaw `PAIRCOACH_COACH_PROVIDER=codex` i `PAIRCOACH_CODEX_EXE` na pełną ścieżkę do lokalnego, zalogowanego programu Codex. W Windows wymagany jest natywny `codex.exe`, nie plik `.cmd`. Raport końcowy korzysta z tego samego dostawcy. Nie dodawaj plików logowania do repozytorium.
- **Gemini:** ustaw `GEMINI_API_KEY` w środowisku serwera. Bez skonfigurowanego dostawcy aplikacja działa z wyłączonym trenerem.
- `PAIRCOACH_WORKSPACE_DIR` wskazuje folder ćwiczenia, a `PAIRCOACH_DATA_DIR` osobny folder danych sesji. Bez wskazanego workspace serwer tworzy tymczasowy przykład.
- Run Main i Run Tests wymagają skonfigurowanych profili uruchamiania w ustawieniach projektu.

Szczegółowe polecenia PowerShell, konfiguracja Codexa i przebieg pierwszego zadania: [instrukcja Windows](docs/windows-start.md).

Gotowe wzorce nowych ćwiczeń Java, Spring Boot, JavaScript, TypeScript i Python: [szablony zadań](docs/templates/README.md).

Dziesięć zagadek z rozdziału Expressive Puzzlers: [java-puzzlers](java-puzzlers/README.md).

## Konfiguracja modelu Codex

Plik [paircoach.config.json](paircoach.config.json) w katalogu aplikacji:

```json
{
  "codex": {
    "model": "gpt-6.1-sol",
    "reasoning_effort": "medium"
  },
  "character": "default"
}
```

Trener i raport końcowy uruchamiają lokalną instancję `codex exec --ephemeral --model gpt-6.1-sol` z `model_reasoning_effort="medium"`. Używają własnego logowania ChatGPT w Codex CLI. Aplikacja jawnie wyłącza ComputerUse (`features.computer_use=false`); model nie wykonuje narzędzi ani interakcji z komputerem. Konfiguracja nie wymaga klucza API ani URL API.

Po zmianie pliku zrestartuj serwer. `PAIRCOACH_CONFIG` może wskazać inny plik JSON pełną ścieżką. Opcjonalne nadpisania: `PAIRCOACH_CODEX_MODEL` i `PAIRCOACH_CODEX_REASONING_EFFORT`. Ustawienia zapisane w konfiguracji użytkownika Codexa nie zmieniają tych wartości — aplikacja przekazuje je jawnie. Błędny plik lub niepoprawna wartość zatrzymuje konfigurację dostawcy zamiast wybierać inny model.

W Windows plik konfiguracji znajduje się w rozpakowanym katalogu aplikacji, obok `package.json`. `PAIRCOACH_COACH_PROVIDER=codex` wybiera dostawcę, a `PAIRCOACH_CODEX_EXE` nadal wskazuje lokalny `codex.exe`.

## Kod i sprawdzenia

- [Backend](src/server/): HTTP/WebSocket, pliki, kontrola zapisu, sesje, uruchamianie testów, raporty oraz dostawcy AI.
- [Interfejs](src/components/) i [klient transportu](src/services/LiveBackend.ts).
- [Kontrakt REST](src/shared/openapi.json) i [schemat WebSocket](src/shared/ws.schema.json).
- [Testy](tests/) oraz [opis ostatnich poprawek](docs/windows-coach-report-solarized.md).

```sh
npm run typecheck
npx tsx --test tests/integration/coach-http.test.ts tests/integration/run-event-order.test.ts
```

Instrukcje i uruchomienia testów Windows znajdują się w [docs/WINDOWS.md](docs/WINDOWS.md). Testy wymagające konkretnego systemu, przeglądarki lub dostawcy AI mają osobne wymagania środowiskowe.

Oficjalna dokumentacja OpenAI: [tryb exec/--ephemeral](https://learn.chatgpt.com/docs/non-interactive-mode),
[logowanie ChatGPT](https://learn.chatgpt.com/docs/auth), [modele](https://learn.chatgpt.com/docs/models).
Dostępność `gpt-6.1-sol` zależy od konta; konfiguracja i `login status` nie dowodzą odpowiedzi modelu.
`--ephemeral` nie zapisuje plików sesji CLI, nie zastępuje logowania ani danych raportu aplikacji.
