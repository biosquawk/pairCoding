# ROOT — krótki smoke pierwszego preview z ZIP (Windows)

Decyzja HUMAN `bcd56587-ef66-4913-a202-d942a09de105` zastępuje wcześniejszy
warunek pełnego G3 przed pierwszym wydaniem. **Jedna krótka rzeczywista próba**,
nie 19/100, G1/G2, 29 testów modułu ani audyt 27 AC. PENDING/NOT_RUN nie jest
PASS; procedura nie twierdzi, że została wykonana. K podaje exactSHA, ZIP,
manifest i zaufany hash. Nie testuj historycznego fixture helpera jako produktu.

1. **Nowa instalacja** z przekazanego ZIP, bez src/node_modules z repo lub WSL.
   Wykonaj `windows-start.md` §1: hashe i wszystkie pliki manifestu → `npm.cmd ci`
   → `npm.cmd run build`. Zapisz exit codes, Node/npm/Codex/OS, commit,
   packageId, ZIP SHA256 i hash package.json/lock przed/po ci. Bez --force.
2. **Start**: §2, istniejący natywny codex.exe i login własnego konta, nowy
   syntetyczny workspace/data, `PAIRCOACH_COACH_PROVIDER=codex`, jawna ścieżka
   EXE. `npm.cmd start` z rozpakowanej instalacji. Zapisz PID własnego serwera
   i skoreluj go z listenerem127.0.0.1:8080; obcy listener = przerwij próbę,
   nie zabijaj go. GET `/` ma zwrócić200; GET `/api/session` bez tokenu401.
3. **Rzeczywisty GUI na tym samym serwerze**: otwórz http://127.0.0.1:8080/
   w Edge bez mock. Włącz i zatwierdź zgodę AI, Start sesji, edytuj solution.js
   według §3. Potwierdź autosave/ACK i dokładne bajty pliku na dysku. W czacie
   zapytaj o nazwę funkcji i oczekiwany wynik z bieżącego kodu/zadania.
   Wymagane jest rzeczywiste wywołanie Codex przez **normalny backend/GUI**
   i odpowiedź odnosząca się do tego materiału. `login status`, mocked REPLY,
   sam READY lub osobny CLI probe nie zaliczają tego kroku. Odnotuj status,
   krótki niesekretny tekst odpowiedzi i dowód wybranego providera, nie tokeny
   czy pełne środowisko. Kod pozostaje zapisywalny podczas oczekiwania AI.
4. **Zamknięcie/hand-off**: poczekaj na zapis, zakończ własny serwer Ctrl+C,
   sprawdź zniknięcie jego listenera. Zachowaj fixture/dane i dowody poza
   instalacją. ROOT/K może następnie uruchomić tę samą instalację dla właściciela;
   przekazuje mu aktualny działający URL i ścieżkę zadania. Ten końcowy start
   i dostępność to osobny status, nie wynik wcześniejszego zatrzymania.

Raport: osobno ZIP/ci/build/start/LIVE+zapis/Codex realresponse/stop/dostępność
właściciela: PASS/FAIL/NOT_RUN, komenda lub akcja, cwd, środowisko, czas,
exit/status i obserwacja. Nie przypisuj starych WindowsPASS nowemu SHA.
Crash/recovery, G3 pełny,19cases,100metrics,27AC i realny Gemini — **DEFERRED**
przez właściciela, nie PASS. Bez alarmu przed działającym Codexem i dostępnością
wersji. Rollback: zachować nową pracę, wrócić do poprzedniej instalacji z jej
kopią danych; nigdy nie nadpisywać nowszego workspace starszym.
