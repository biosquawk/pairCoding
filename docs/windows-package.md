# PairCoach MVP2 — archiwum exact Git, nie deklaracja odbioru

> **ETAP8: IMPLEMENTED / PENDING_FINAL_QA** (kolejka 4→9). To opis bieżącego
> kandydata, nie odbiór kampanii ani wydanie. Native Windows/PowerShell, świeża
> paczka wydania, realny model i pełne QA pozostają do wykonania po implementacji9.
> ETAP9 Docker/polyglot nie jest jeszcze zaimplementowany.

Bieżący zakres ETAP8: aktualne docs, weryfikator Windows i skończona selekcja pakietera. Package/lock/core
nie są zmieniane przez pakowanie. Instrukcja dotyczy MVP2 po wznowieniu przez
HUMAN dae99189; stare odroczenie G3/19/100 dotyczyło **tylko MVP1**, nie MVP2.
Przygotowanie jest **NOT_FINAL**, dopóki K nie rozliczy pełnego właściwego zakresu.
Nie zmieniamy opublikowanego MVP1, live8080 ani alarmu.

## 1. Producent — dopiero exact finalacceptedSHA od K

Node >=22.22.0 i Git; użyj czystego repo kandydata, nie repo nadrzędnego Thalamusa.
K wskazuje pełny SHA po integracji/review. Nie pakuj ruchomego HEAD jako gotowego
wydania. Przed tym etapem można sprawdzić help/list/dry-run bez produkcji ZIP.

```powershell
$ErrorActionPreference = 'Stop'
$sha = Read-Host 'Wklej pelny 40-znakowy finalacceptedSHA od K'
if ($sha -notmatch '^[a-f0-9]{40}$') { throw 'Niepoprawny SHA' }
$headSha = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $headSha -ne $sha) { throw 'Niezgodna rewizja' }
$dirty = git status --porcelain
if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Wymagany czysty checkout' }
node --version
npm.cmd --version
git --version
node scripts/package-windows.mjs --help
if ($LASTEXITCODE -ne 0) { throw 'Help FAIL' }
node scripts/package-windows.mjs --commit $sha --list
if ($LASTEXITCODE -ne 0) { throw 'Lista FAIL' }
node scripts/package-windows.mjs --commit $sha --dry-run
if ($LASTEXITCODE -ne 0) { throw 'Plan FAIL' }
# Review listy/źródeł/sekretów. Rodzic C:\PairCoach musi już istnieć.
$out = Join-Path 'C:\PairCoach' ('package-mvp2-' + $sha)
node scripts/package-windows.mjs --commit $sha --output $out
if ($LASTEXITCODE -ne 0) { throw 'Pakowanie FAIL — zachowaj wynik; odczytaj stan przed ponowieniem' }
```

Helper tworzy wyłącznie nowy katalog **poza repo** (realpath rodzica), odmawia
nadpisania istniejącego wyniku. Częściowego wyniku nie kasuj automatycznie.
Przy nieznanym wyniku najpierw odczytaj stan; nie ponawiaj publikacji.
Nie uruchamia npm, AI, serwera, Windowskampanii ani wdrożenia. Self-check wymaga
helpera zgodnego z wybranym commitem (wyjątek: tylko LF/CRLF). Wejściem są bloby
Git, nie build, runtime, niezacommitowany plik ani zewnętrzny node_modules.

## 2. Zawartość / źródłowe command closure

Allowlist: README.md, paircoach.config.json, package.json, package-lock.json, tsconfig.json, vite.config.ts,
index.html, metadata.json, playwright.config.ts, `src/**`, `docs/windows*.md`, `docs/WINDOWS.md`,
`scripts/package*.mjs`, **scripts/clean.mjs, scripts/windows-verify.ps1, scripts/verify-source-revision.mjs** i śledzone źródła/support
`tests/**` (TS/TSX/JS/JSX/MJS/CJS/JSON/XML/TXT/MD/PY/JAVA/PS1, tests/qa/.gitignore).
Wymagane wejścia Windows recovery to `tests/snapshots/snapshot-crash.test.ts`,
`tests/snapshots/snapshot-child.ts` i `tests/snapshots/helpers.ts`; są w manifest
sourceVerification.requiredFiles i zweryfikowanej kopii. sourceVerification.recoveryTests
wskazuje pierwszy plik jako zestaw do wykonania; brak supportu także blokuje preflight.
Sam manifest/ZIP nie jest dowodem uruchomienia native recovery (po9).
Denylist nadal wyklucza .git, node_modules, .env*, klucze PEM/KEY/PFX/P12,
credentials/secrets, .paircoach, runtime/.runtime, tmp/.tmp, dist, artifacts,
logs, traces, screenshots, reports, test-results, playwright-report, coverage.
Symlink/submodule i niebezpieczna nazwa w dozwolonym zakresie są odrzucane.
Nie wkładamy raw QA ani danych/poświadczeń właściciela. Nie ma automatycznej
pełnej detekcji sekretów w treści źródeł — wymagany review przed dystrybucją.

Każdy script ze wskazanego bloba package.json musi odpowiadać literalnemu
kontraktowi helpera. Nieznany/zmieniony/lifecycle script, brak wymaganego pliku
lub deklaracji dependency blokuje list/dry-run/output **przed zapisem**.
To statyczna kontrola wejść, nie dowód wykonania ani pełny parser importów.

| Komenda | Warunek i rola |
|---|---|
| `npm.cmd ci` | Wbudowana komenda npm, package+lock, sieć; pełne devDependencies. Własne Windows native dependencies, **bez kopiowania WSL**. |
| `npm.cmd run clean` | Istniejący scripts/clean.mjs usuwa tylko dist; nie dowody/dane sesji. |
| `npm.cmd run build` | Vite: index/config/src → dist; nie samodzielny EXE. |
| `npm.cmd run lint`, `npm.cmd run typecheck` | TypeScript + tsconfig/src. |
| `npm.cmd start`, `npm.cmd run server` | tsx src/server/index.ts; backend, po build serwuje UI. |
| `npm.cmd run dev` | Vite3000, nie samodzielna integracja backendu. |
| `npm.cmd run dev:full` | concurrently + server/dev; development. |
| `npm.cmd run preview` | Najpierw build; frontend preview bez API, nie odbiór produktu. |
| `npm.cmd run runtime:prepare -- …` | `node scripts/runtime-prepare-cli.mjs`; jawny projekt/profil i NOWY prywatny output według [przewodnika](windows-polyglot.md#2-jawne-prepare-bez-domyślnego-wykonania). Domyślnie `PLAN_ONLY`, nie gotowość; osobne `--execute` wymaga przyjętej spójnej rewizji i pinów/Docker. Nie uruchamia go pakieter. |
| `npm.cmd test` | Źródła obu rodzin są w ZIP; `node scripts/runtime-test.mjs`. Teraz tylko izolowany dowód selekcji; pełne wykonanie na spójnej rewizji po implementacji9, nie podczas smoke. |

Paczka zachowuje wszystkie wybrane testy i ich zależności. Obok15skryptów runtime
publicznego przepływu skończona allowlista dopuszcza pojedynczy prywatny test-support
`scripts/runtime-operator-remainder.mjs`: wymagany przy wybranych regresjach remainder
lub retention (również dynamiczny import fixture). To źródło, nie dodatkowa komenda
npm/HTTP ani publiczna instrukcja acquisition; pakowanie go nie wykonuje. Brak modułu
odrzuca plan/weryfikację zamiast pomijać asercje. ROOT recovery controller i prywatne
proof fixtures pozostają poza paczką. Szczegóły: [przewodnik](windows-polyglot.md).

Manifest.sourceVerification opisuje dodatkowe skończone komendy operatora (PowerShell/portable Node),
wymagane docs/config/helper i zaufanie do zewnętrznego manifestu; te wejścia są obowiązkowe
w list/dry-run/output. Helper nie poszerza selekcji do wszystkich scripts ani raw QA.
Manifest.commands zawiera wszystkie 11 npm scripts, requiredFiles/dependencies,
prerequisite i NOT_RUN_BY_PACKAGER. Źródła lokalnych importów/helperów trzeba
sprawdzić względem finalnego drzewa, a operacyjne ci/build/start/API/GUI —
z rzeczywiście rozpakowanej paczki. Koffi 3.3.7 pochodzi z istniejącego lockfile;
Windows npm ci musi faktycznie załadować natywną bibliotekę przy scenariuszu
restore. Brak dependency/syscall to fail-closed, nie fallback overwrite.

## 3. Identyfikacja i niezależna kontrola

Nowy katalog wyniku zawiera:
- `paircoach-v3-mvp2-<pełny40SHA>.zip` z jednym korzeniem o tym samym ID;
- `manifest.json`: status **MVP2_SOURCE_RUNTIME_ACCEPTANCE_SEPARATE**, sourceCommit,
  packageId, ZIP bytes/SHA256, ścieżki/bytes/SHA256 źródeł, wersje Node/Git/OS;
- `SHA256SUMS`: hash ZIP i manifestu. Manifest nie hashuje sam siebie. K przekazuje jego SHA256 niezależnym zaufanym kanałem;
  sąsiedni SHA256SUMS sam nie ustanawia zaufania. Zewnętrzny manifest + zaufany digest
  umożliwia Git-less weryfikację rozpakowanych źródeł przed npm (docs/WINDOWS.md).

Status oznacza wyłącznie archiwum źródeł; nie PASS Windows ani zgoda na publikację.
Brak kontenera/digestu obrazu: N/A. ZIP powstaje przez Git archive STORE (-0),
czas commitu i stały prefiks. Reprodukcja przy tej samej wersji Git do **drugiego
nowego katalogu** ma dać ten sam hash ZIP; manifest narzędzi może różnić się
pomiędzy OS/Node. Nie zmieniamy globalnego core.autocrlf.

Wewnętrzna kontrola ZIP sprawdza listę/bajty każdego pliku względem Git.
K wykonuje niezależny odczyt np. Python zipfile: lista ZIP=manifest=allowlist,
każdy plik ZIP=Git blob SHA256, brak dodatkowych plików/sekretów/raw QA.
export-ignore/export-subst nie mogą cicho zmienić źródeł. Negatywne kontrole:
ponowny output do tego samego katalogu odrzucony bez zmiany hashy, błędne SHA,
nieznany script/brak clean odrzucone przed utworzeniem wyniku.

## 4. Osobne wyniki i dystrybucja

Po finalacceptedSHA: **windows-zip-smoke.md** → odrębny Windows katalog i port
18082 (nie live8080), świeży ZIP→ci→clean→build→proces/HTTP→GUI/ACK→Run/Test→
finish/report→restore/restart. P3/ROOT rozliczają swoje nowe G3/19 i AC027/100;
nie uruchamiamy ich ponownie ani nie uznajemy za zaliczone przez helpera.
Nie powtarzamy odebranych G1/G2/29 lub native60821/21+3/3 na niezmienionym kodzie.

Raport K wiąże exact finalSHA/ID/hash, wersje, komendy/exity oraz odrębne statusy
ZIP, ci, build, start, health, API/GUI, recovery, pełny odbiór i dostępność.
Wyniki historyczne mają własny SHA/środowisko; nie są nowym jednolitym runem.
Dopiero K po odczycie dowodów/kontrteście wydaje decyzję i publikuje w zakresie
zgody. Sam helper, RESULT_READY ani instrukcja nie oznaczają ACCEPTED.
Rollback przed zmianą środowiska: osobna stara instalacja + jej zgodne dane;
nowe dane/drafty zachować, niczego nie nadpisywać. Nie aktualizować MVP1 w miejscu.
