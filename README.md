# PairCoach

Lokalny trener programowania: edytor Monaco, czat z AI, uruchamianie programu i testów, snapshoty oraz raport końcowy. Interfejs i backend znajdują się w tym repozytorium.

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

- **Codex:** ustaw `PAIRCOACH_COACH_PROVIDER=codex` i `PAIRCOACH_CODEX_EXE` na pełną ścieżkę do lokalnego, zalogowanego programu Codex. W Windows wymagany jest natywny `codex.exe`, nie plik `.cmd`. Raport końcowy korzysta z tego samego dostawcy. Nie dodawaj plików logowania do repozytorium.
- **Gemini:** ustaw `GEMINI_API_KEY` w środowisku serwera. Bez skonfigurowanego dostawcy aplikacja działa z wyłączonym trenerem.
- `PAIRCOACH_WORKSPACE_DIR` wskazuje folder ćwiczenia, a `PAIRCOACH_DATA_DIR` osobny folder danych sesji. Bez wskazanego workspace serwer tworzy tymczasowy przykład.
- Run Main i Run Tests wymagają skonfigurowanych profili uruchamiania w ustawieniach projektu.

Szczegółowe polecenia PowerShell, konfiguracja Codexa i przebieg pierwszego zadania: [instrukcja Windows](docs/windows-start.md).

## Konfiguracja modelu Codex

Plik [paircoach.config.json](paircoach.config.json) w katalogu aplikacji:

```json
{
  "codex": {
    "model": "gpt-6.1-sol",
    "reasoning_effort": "medium"
  }
}
```

Trener i raport końcowy uruchamiają lokalną instancję `codex exec --model gpt-6.1-sol` z `model_reasoning_effort="medium"`. Używają istniejącego logowania Codexa. Konfiguracja nie wymaga klucza API ani URL API.

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
