#!/usr/bin/env bash
# Start PairCoding on this WSL workstation; no positional arguments required.
set -euo pipefail

if (( $# != 0 )); then
  printf 'Uruchom bez argumentów: ./start.sh\n' >&2
  exit 2
fi

app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd -- "$app_dir"

# Use the existing Node installation. Never install tools globally at startup.
node_supported() {
  command -v node >/dev/null 2>&1 && node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major > 22 || (major === 22 && minor >= 22) ? 0 : 1);
  '
}
if ! node_supported; then
  if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
    source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    nvm use --silent 22
  fi
fi
if ! node_supported; then
  printf 'Wymagany Node.js >=22.22.0. Wybierz istniejącą instalację i ponów ./start.sh.\n' >&2
  exit 1
fi
if [[ ! -f node_modules/tsx/package.json || ! -f dist/index.html ]]; then
  printf 'Przygotuj aplikację w tym katalogu: npm ci && npm run build\n' >&2
  exit 1
fi

# Existing workstation configuration/cache; editable without changing server code.
# Relative overrides are resolved from the application directory, not the caller's cwd.
runtime_config="${PAIRCOACH_RUNTIME_CONFIG:-../paircoach-live-20261113/zadania-java.runtime.json}"
prepared_runtime="${PAIRCOACH_PREPARED_RUNTIME:-../paircoach-stabilization-evidence-20261113/java21-prepared/jobs/java-maven-21}"
runtime_config="$(realpath -m -- "$runtime_config")"
prepared_runtime="$(realpath -m -- "$prepared_runtime")"
if [[ ! -f "$runtime_config" || ! -f "$prepared_runtime/receipt.json" ]]; then
  printf 'Brakuje konfiguracji lub przygotowanego runtime. Sprawdź ścieżki:\n%s\n%s\n' \
    "$runtime_config" "$prepared_runtime" >&2
  printf 'Ustaw PAIRCOACH_RUNTIME_CONFIG i PAIRCOACH_PREPARED_RUNTIME według README.\n' >&2
  exit 1
fi

export PAIRCOACH_HTTP_PORT="${PAIRCOACH_HTTP_PORT:-18120}"
export PAIRCOACH_COACH_PROVIDER="${PAIRCOACH_COACH_PROVIDER:-codex}"
if [[ "$PAIRCOACH_COACH_PROVIDER" == codex && -z "${PAIRCOACH_CODEX_EXE:-}" ]]; then
  if ! PAIRCOACH_CODEX_EXE="$(command -v codex)"; then
    printf 'Nie znaleziono Codexa w PATH. Ustaw PAIRCOACH_CODEX_EXE na istniejący program.\n' >&2
    exit 1
  fi
  export PAIRCOACH_CODEX_EXE
fi

printf 'Uruchamiam PairCoding: http://127.0.0.1:%s/\n' "$PAIRCOACH_HTTP_PORT"
printf 'Zatrzymanie: Ctrl+C w tym terminalu. Otwórz zapisany projekt w GUI.\n'
exec node --import tsx src/server/index.ts \
  --runtime-config "$runtime_config" --prepared-runtime "$prepared_runtime"
