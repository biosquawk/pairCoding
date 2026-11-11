# Poprawki po pierwszym ćwiczeniu właściciela

> **ETAP8: IMPLEMENTED / PENDING_FINAL_QA** (kolejka 4→9). To opis bieżącego
> kandydata, nie odbiór kampanii ani wydanie. Native Windows/PowerShell, świeża
> paczka wydania, realny model i pełne QA pozostają do wykonania po implementacji9.
> ETAP9 Docker/polyglot nie jest jeszcze zaimplementowany.

Trener rozróżnia bieżące pytanie CHAT od zdarzeń RUN/EDIT i otrzymuje historię swoich odpowiedzi. Stara prośba o powitanie pozostaje historią. Własna odpowiedź i ponowne dostarczenie tego samego wyniku nie stanowią nowego faktu. Jedno zakończenie Run uruchamia koordynator raz; zachowano kolejność ramek WebSocket.

Przy `PAIRCOACH_COACH_PROVIDER=codex` raport końcowy także korzysta z Codexa. Bieżąca konfiguracja dla obu: `gpt-6.1-sol` / `medium`, lokalne `codex exec --ephemeral`, własne logowanie ChatGPT, bez dodatkowego klucza lub URL API. ComputerUse jest jawnie wyłączone (`features.computer_use=false`), bez narzędzi modelu/interakcji z komputerem. Dostępność modelu zależy od konta; `login status` nie dowodzi odpowiedzi AI. Wcześniej generator raportów sprawdzał wyłącznie Gemini, stąd lokalny raport mimo działającej rozmowy Codex. Zgoda jest utrwalana w faktach sesji; bez niej nie ma wywołania AI. Do historii raportu trafiają zarówno wiadomości CHAT_REPLY, jak i rzeczywiste podpowiedzi COACH_HINT_BUBBLE. Niezmienne fakty, filtrowanie kontekstu, ograniczenia procesu, timeout i jawne ponowienie po błędzie pozostają wspólne. Raport używa odrębnego schematu `{markdown}` i instrukcji; trener nadal używa `{decision}`. Nie uruchomiono narzędzi modelu ani dostępu do katalogu zadania.

Oficjalny opis [trybu nieinteraktywnego Codexa](https://developers.openai.com/codex/noninteractive/) opisuje `exec`, zdarzenia JSONL i `--output-schema`. Implementacja zachowuje ten transport i uwierzytelnienie CLI, bez nowego klucza API.

Lokalny raport ma kolejne numery uruchomień i czas w minutach/sekundach. Identyfikatory pozostają w danych dowodowych. Raport AI otrzymuje taką samą instrukcję czytelności i rozróżnia rozmowę AI od edycji kodu.

Wspólna paleta paneli i Monaco: Solarized Dark (#002b36 / #073642), stonowane akcenty i składnia. Panele mają minimalną wysokość 0 w kontenerach flex, dolny panel dopasowuje wysokość do okna, a pasek statusu zawija się w węższym widoku. Status myślenia AI pozostaje widoczny także poniżej szerokości 1280 px.

**Historyczny wynik poprzedniej dostawy, nie test ETAP8 ani finalnej kampanii:** testy celowane WSL: 66/66 PASS, a po uzupełnieniu historii dymków kolejne 33/33 PASS (adapter, transport Codex, zatrzymanie procesu, raport, integracja HTTP i kolejność Run). Typecheck i build: PASS. Historyczne dowody Windows/ćwiczenia dotyczą wyłącznie tamtej rewizji; nie są nowym wynikiem bieżącego kandydata.

Bieżąca instrukcja: [windows-start §7](windows-start.md#7-zakończporzuć--raport-timeout-nie-oznacza-powtórzenia). Błąd AI pozostaje FAILED z jawnym Ponów; lokalny fallback nie jest realAI PASS.
