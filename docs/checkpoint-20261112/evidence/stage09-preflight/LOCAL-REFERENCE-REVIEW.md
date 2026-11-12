# REQ-101 — wzorce lokalne do adaptacji, bez uruchamiania usług

Stan: częściowy rekonesans Etapu A zadania9. Nie jest zatwierdzeniem A–B ani zleceniem implementacji. Pliki źródłowe wyłącznie odczytano; nie zmieniano obcych projektów, nie odczytano .env/poświadczeń i nie uruchomiono ich usług.

## Pochodzenie przeczytanych źródeł

- `\\wsl.localhost\Ubuntu\home\darulec\dev\codex_prjects\codex_synapse_legacy\projects\20260925_0629_legacy_ALC_liquidityParts\SharedDesk\projectSpace\sorbnet-telemetry-poc\Dockerfile`
  SHA256 `c86fc497d30c9ad327493ccfb5b74eda96d64516d7c843be7776e76c623d79ca`; Git `393d8a2b722b4ef6f2e6dc9d6b94c8b7c664f6d2`.
- `\\wsl.localhost\Ubuntu\home\darulec\dev\codex_prjects\codex_synapse_legacy\projects\20260925_0629_legacy_ALC_liquidityParts\SharedDesk\projectSpace\sorbnet-telemetry-poc\compose.yaml`
  SHA256 `33b4b6b68e68da40bab752181b21018986783adf5b38f36e76cb164db93cb48e`; Git `393d8a2b722b4ef6f2e6dc9d6b94c8b7c664f6d2`.
- `\\wsl.localhost\Ubuntu\home\darulec\dev\codex_prjects\codex_synapse_legacy\projects\260809_1337_visualNoteTaker\SharedDesk\projectSpace\meeting_visual_notes_v2_codex\.docker\Dockerfile`
  SHA256 `03f75763d849cc937bb043caf836b5f4554e6beac12c9c9f63c8eeee464d016a`; Git `c9fb65aa83efac7e7adbd8a4ea28af93f290489f`.
- `\\wsl.localhost\Ubuntu\home\darulec\dev\codex_prjects\codex_synapse_legacy\projects\260809_1337_visualNoteTaker\SharedDesk\projectSpace\meeting_visual_notes_v2_codex\.docker\compose.yaml`
  SHA256 `c0cf31a46c85fbe4fb17c4958006e5e5a2ea6805840b53dd1c211ee5e38acfc4`; Git `c9fb65aa83efac7e7adbd8a4ea28af93f290489f`.

## Warto zaadaptować

- Java/Maven: osobne skopiowanie pom.xml i dependency:go-offline przed źródłami pokazuje istniejący u właściciela wzorzec przygotowania zależności. effective-pom i dependency-tree są dowodami rzeczywistej konfiguracji, przydatnymi do kontroli --release. Nie dowodzi to jeszcze kompletnego offline cache ani zgodności27.
- Java Compose: publikacja 127.0.0.1:19180:8080 potwierdza stosowany wzorzec hostowego loopbacku. W PairCoach port musi być powiązany z konkretnym Run i sprawdzony HTTP, nie skopiowany jako stała19180.
- Python/Codex referencja: image digesty, etykiety source revision/tree i nieuprzywilejowany UID10001 tworzą czytelny wzorzec pochodzenia i właściciela. W Compose istnieją pull_policy:never, read_only:true, cap_drop:ALL, no-new-privileges, limity CPU/RAM/PIDs, tmpfs oraz rotacja logów niezależna od aplikacji.
- Referencja rozdziela input:RO, output:RW i private runtime:RW; bind.create_host_path:false chroni przed cichym tworzeniem błędnych katalogów. To punkt odniesienia dla oddzielenia wejścia Run od źródeł ucznia, nie dowód gotowej implementacji PairCoach.
- Osobny input/output i stop_grace_period pokazują potrzebę jawnego cyklu życia. Sama konfiguracja grace period nie jest dowodem potwierdzonego Stop/cleanup; PairCoach wymaga odczytu artefaktów przed usunięciem i osobnego LSP.

## Czego nie kopiować

- Referencja Visual Notes montuje katalog /auth i instaluje Codex wewnątrz obrazu. Kontenery treningowe/LSP PairCoach nie dostają loginu, tokenów, kluczy, całego home ani docker.sock. Natywny Trener Codex sol/medium pozostaje osobną, istniejącą integracją.
- Obrazy Java używają tam tagów3.9.11/21 i końcowego JRE. Dla nowego celu potrzebne są rzeczywiste JDK11/17/21/27 oraz przypięte imageId/digest; końcowy JRE nie zastąpi javac/Mavena. Nie kopiować stałej nazwy klasy/JAR ani rozpoznawania projektu po nazwie katalogu.
- Wzorzec COPYsrc+build aplikacji do obrazu nie może wymuszać przebudowy obrazu przy każdej edycji w PairCoach. Przygotowanie obrazu/cache i wykonanie zamrożonego wejścia Run pozostają odrębne.
- Python3.12 z referencji nie spełnia profilu Python3.13. Przypięte bazowe digesty pokazują metodę, nie wersje do bezwarunkowego użycia.
- Watcher restart:on-failure:3 i zależności Prometheus/Grafana należą do tamtych usług; nie dodajemy automatycznego restartowania jednorazowego zadania ani całego stosu monitoringu. Referencyjny log max-file:3 nie zastępuje obowiązku przyjęcia małego jawnego limitu z aneksu.
- Nie kopiować host-gateway ani dodatkowych mountów bez uzasadnienia. Ustawienia anonimowego Admina Grafany nie mają zastosowania do PairCoach. Nie kopiować restartu/cyklu życia LSP do Stop pojedynczego Run.

## Ustalone i pozostające do sprawdzenia

- Istniejące referencje: Maven3.9.11/Temurin21, Python3.12 i obrazy Node22 przypinane digestem; szczegóły pełnej inwentaryzacji są osobno. Nie znaleziono na podstawie tych czterech źródeł gotowego dowodu JDT LS/JDK27 ani pylsp/Python3.13.
- WSL komunikuje się z istniejącym Docker Desktop Linux Engine29.7.2. To nie jest jeszcze dowód natywnego procesu Windows, konwersji mountów Windows↔WSL ani całej topologii produkcyjnej.
- Współdzielenie/odseparowanie cache, offline Run, mapowanie ścieżek z polskimi znakami i spacje, zatrzymanie i raporty, właściwe wersje narzędzi oraz LSP/27 wymagają rzeczywistego spikeB. Nie uruchamiano obcych compose, nie pobierano obrazów i nie rekonfigurowano hosta.
- Użytkownik wyznaczył twardą bramkę operatora po A–B przed C. Obecna dokumentacja jest materiałem wejściowym do tej bramki, nie jej zaliczeniem.
