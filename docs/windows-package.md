# PairCoach preview — reprodukowalne archiwum źródeł

Narzędzie `scripts/package-windows.mjs` jest potrzebne, bo zwykłe ZIP całego
folderu dołącza zależności, `.git`, `.env` i dane QA, a `npm pack --dry-run`
nie określa zatwierdzonej rewizji/zakresu. To **nie jest runner, launcher,
instalator, pełny odbiór v3 ani publikacja**. Nie zmienia package.json/lock.
Używa Node i Git, bez nowej biblioteki archiwum, nie wykonuje npm scripts.

## Producent (K/P4, exact SHA pierwszego preview)

HUMAN bcd56587 autoryzuje pierwsze wydanie do kodowania i feedbacku bez czekania
na crash/recovery,19/100 i pełny audyt27AC. K integruje stabilny frontend/backend,
Codex provider i dokumentację w osobnej gałęzi; zachowuje G3 poza tym wydaniem.
Po scoped review exact kandydata, nie dopiero po pełnym G3:

```powershell
# Ustaw cwd na repo kandydata, NIE katalog nadrzędnego projektu Thalamusa.
$ErrorActionPreference = 'Stop'
$sha = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Brak repo' }
# Porównaj $sha z pełnym SHA wskazanym do odbioru. Nie pakuj ruchomego HEAD bez odbioru.
git status --short
node --version
npm.cmd --version
git --version
node scripts/package-windows.mjs --help
if ($LASTEXITCODE -ne 0) { throw 'Help FAIL' }
node scripts/package-windows.mjs --commit $sha --list
if ($LASTEXITCODE -ne 0) { throw 'Lista FAIL' }
node scripts/package-windows.mjs --commit $sha --dry-run
if ($LASTEXITCODE -ne 0) { throw 'Plan FAIL' }
# Dopiero po review listy, źródeł i sekretów; rodzic C:\PairCoach musi istnieć.
$out = Join-Path 'C:\PairCoach' ('package-preview-' + $sha)
node scripts/package-windows.mjs --commit $sha --output $out
if ($LASTEXITCODE -ne 0) { throw 'Pakowanie FAIL — zachowaj niepełny katalog, odczytaj stan przed ponowieniem' }
```

Help/list/dry-run nie uruchamiają serwera, testów, Windowskampanii ani AI,
nie tworzą katalogu wyniku. Pełne40SHA jest obowiązkowe. Skrypt pakujący musi
być zgodny ze wskazanym commitem; self-check dopuszcza wyłącznie różnicę
końców linii LF/CRLF (także czysty checkout `core.autocrlf=true`). Inna zmiana
helpera, w tym polityki pakowania lub pojedynczy CR, jest odrzucana. Nie trzeba
zmieniać globalnego ustawienia Git. Pakowane są **bloby Git**, nie pliki
robocze, build czy niezacommitowane poprawki. Brudne drzewo nie zmienia archiwum,
ale przed odbiorem dostawca ma je wyjaśnić i przygotować czystą rewizję.

Allowlist: package.json, package-lock.json, tsconfig.json, vite.config.ts,
index.html, metadata.json, playwright.config.ts, `src/**`, `docs/windows*.md`, `scripts/package*.mjs` oraz dokładnie `scripts/clean.mjs`.
Dodatkowa denylist blokuje `.env*` (także `.env.example`), klucze PEM/KEY/PFX/P12,
katalogi sekretów/credentials, node_modules, .git, .paircoach, runtime/.runtime, tmp, dist, logi,
artifacts, test-results, playwright-report, coverage. Śledzone źródła `tests/**` (także `tests/qa`) i potrzebne helper/config/fixture
są dozwolone: TS/TSX/JS/JSX/MJS/CJS/JSON/XML/TXT/MD/PY/JAVA/PS1 oraz
`tests/qa/.gitignore`. Raw output (runtime, logi, trace, screenshots, reports,
artifacts) jest wykluczony. To decyzja K z bieżącego TASK, nie rozszerzenie QA.
Nie uruchamiamy kampanii podczas pakowania. Nowy typ pliku wymagany przez
przyszłą integrację musi przejść review polityki przed dodaniem. Symlink/submodule
w wybranym zakresie są odrzucane. Helper nie odczytuje zmiennych API/tokenów,
nie skanuje jednak treści zwykłych źródeł w poszukiwaniu każdego sekretu.
Review źródeł przed dystrybucją nadal jest wymagane.

Wynik w nowym katalogu poza repo:
- `paircoach-v3-preview-<pełny40SHA>.zip`, jeden katalog główny o tym samym ID;
- `manifest.json`: status PLAYABLE_PREVIEW_SOURCE_NOT_FULL_ACCEPTANCE, exactSHA, ZIP SHA256,
  rozmiar, ścieżki/rozmiary/hash każdego źródła, wersje Git/Node/OS;
- `SHA256SUMS`: hash ZIP-u i manifestu (manifest nie hashuje sam siebie).

Nie powstaje obraz kontenera ani digest obrazu — N/A. Dane sesji użytkownika
pozostają poza paczką; build/install/start/zdrowe wdrożenie to osobne wyniki.

ZIP używa `git archive --format=zip -0` (STORE, bez zależności od kompresora),
stałych bajtów commitu, czasu commitu i prefiksu z pełnym SHA. Wymagaj tej samej
wersji Git dla identycznego bajtowo powtórzenia; manifest zapisuje platformę
narzędzi, więc nie obiecujemy identycznego manifestu na innym OS/Node.
`core.autocrlf` nie przerabia blobów. Skrypt kontroluje listę i hash zawartości
ZIP-u względem manifestu; export-ignore/export-subst nie mogą cicho usunąć lub
zmienić wymaganych plików. Odtwórz do **drugiego nowego katalogu** i porównaj
SHA256 ZIP-ów. Nie ponawiaj zapisu do tego samego katalogu: najpierw odczytaj
istniejący wynik, by nie utracić dowodów poprzedniej próby.

## Command closure: każda deklarowana komenda

Helper odczytuje scripts/dependencies ze wskazanego **bloba package.json**.
Zna wyłącznie aktualny, jawnie zreviewowany kontrakt komend (nie uruchamia
powłoki ani scripts). Zmieniona/nowa komenda, lifecycle script lub brak pliku
w ZIP/deklaracji narzędzia blokują **list/dry-run/output** przed zapisem.
Jeśli stabilna baza nie ma `scripts/clean.mjs`, K bierze byte-identical helper
z odebranego runtime `03fcf6ddaae55b5b82e28f4cf49465f55e8b09e1`. Nie trzeba
scalać nieukończonego G3. Brak pliku nadal blokuje pakowanie; nie odtwarzamy go.

| npm command | Zakres w archiwum źródłowym |
|---|---|
| `ci` | Standardowe npm, package+lock, sieć; bez `--omit=dev`. Native dependencies instalują się na platformie odbiorcy, nie z WSL. |
| `clean` | `node scripts/clean.mjs`; plik obowiązkowy. Przed build, w odrębnej instalacji. |
| `build` | Vite, index.html/config/src; tworzy dist, nie EXE backendu. |
| `lint`, `typecheck` | TypeScript, tsconfig/src; kompilator z devDependencies. |
| `start`, `server` | tsx + src/server/index.ts; backend8080, po build serwuje UI. |
| `dev` | Vite3000, nie samodzielny backend. |
| `dev:full` | concurrently + server + dev; lokalny development. |
| `preview` | Najpierw build; sam frontend bez backendu, nie ścieżka odbioru produktu. |
| `test` | Źródła testów/helper/config/fixture w ZIP; `tsx --test tests/**/*.test.ts`. To nie osobna kampania przeglądarkowa Playwright. Testy uruchamiaj jawnie we właściwym środowisku, nie automatycznie podczas smoke. |

Manifest zawiera `commands`: literalne polecenie, requiredFiles/dependencies,
prerequisite, scope i NOT_RUN_BY_PACKAGER dla **każdego** scriptu. To kontrola
statycznej kompletności, nie dowód wykonania npm ani poprawności importów.
`ci` jest wbudowaną komendą npm, nie script package.json. Dodatkowe runtime
zasoby/importy muszą być sprawdzone z rzeczywistego ZIP przez ROOT.
Nie zmieniamy package.json, nie ukrywamy ani nie usuwamy komendy test. Brak źródeł *.test.ts lub zależnych scripts dev/server także blokuje pakowanie.

## Kontrola pierwszego wydania

1. Zweryfikuj ZIP/manifest/SHA256SUMS i każdy plik względem exactSHA.
   Sprawdź brak sekretów, runtime QA, .git, node_modules i danych sesji.
2. ROOT wykona **jeden krótki smoke świeżego ZIP** według windows-zip-smoke.md:
   ci → build → start → LIVE/realny zapis → zgoda/start → rzeczywista odpowiedź
   Codex na aktualny kod/zadanie/czat. Nie powtarza historycznych kampanii.
3. K zapisuje exactSHA, ID/hash, wersje, komendy/exity i oddzielne wyniki;
   po swoim odbiorze publikuje autoryzowany preview z krótką instrukcją i URL.
   Sam helper niczego nie publikuje ani nie potwierdza zdrowia produktu.
4. Crash/recovery, pełneG3,19/100 i final27AC pozostają DEFERRED dla kolejnego
   wydania; zachować commity i dowody. Brak tej kampanii nie blokuje preview,
   nie wolno jednak relabelować jej jako PASS. Realny Gemini jest alternatywą,
   nie substytutem wymaganego teraz działającego Codex.

Własny wynik helpera: kompletność bajtów i wejść komend, **nie** runtime/AI PASS.
Nazwa i status preview nie sugerują pełnego odbioru. Nie odczytujemy auth.json,
nie utrwalamy kluczy, tokenów ani prywatnych logów. Nie kasujemy starych dowodów.
