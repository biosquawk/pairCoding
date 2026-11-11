# Poprawki po pierwszym ćwiczeniu właściciela

Trener rozróżnia bieżące pytanie CHAT od zdarzeń RUN/EDIT i otrzymuje historię swoich odpowiedzi. Stara prośba o powitanie pozostaje historią. Własna odpowiedź i ponowne dostarczenie tego samego wyniku nie stanowią nowego faktu. Jedno zakończenie Run uruchamia koordynator raz; zachowano kolejność ramek WebSocket.

Przy `PAIRCOACH_COACH_PROVIDER=codex` raport końcowy także korzysta z Codexa. Wcześniej generator raportów sprawdzał wyłącznie Gemini, stąd lokalny raport mimo działającej rozmowy Codex. Zgoda jest utrwalana w faktach sesji; bez niej nie ma wywołania AI. Niezmienne fakty, filtrowanie kontekstu, ograniczenia procesu, timeout i jawne ponowienie po błędzie pozostają wspólne. Raport używa odrębnego schematu `{markdown}` i instrukcji; trener nadal używa `{decision}`. Nie uruchomiono narzędzi modelu ani dostępu do katalogu zadania.

Oficjalny opis [trybu nieinteraktywnego Codexa](https://developers.openai.com/codex/noninteractive/) opisuje `exec`, zdarzenia JSONL i `--output-schema`. Implementacja zachowuje ten transport i uwierzytelnienie CLI, bez nowego klucza API.

Lokalny raport ma kolejne numery uruchomień i czas w minutach/sekundach. Identyfikatory pozostają w danych dowodowych. Raport AI otrzymuje taką samą instrukcję czytelności i rozróżnia rozmowę AI od edycji kodu.

Wspólna paleta paneli i Monaco: Solarized Dark (#002b36 / #073642), stonowane akcenty i składnia. Nie zmieniono układu ani sterowania edytorem.

Testy celowane WSL: 66/66 PASS (adapter, transport Codex, zatrzymanie procesu, raport, integracja HTTP i kolejność Run). Typecheck i build: PASS. Osobny odbiór Windows i nowe ćwiczenie są zapisane w dowodach wydania.
