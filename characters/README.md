# Charaktery nauczyciela

To jedno miejsce z charakterem i skillami trenera, wspólne dla wszystkich zadań i języków. Nie umieszczaj karty nauczyciela w ćwiczeniu.

```text
characters/
├── default/
│   ├── AGENTS.md
│   └── skills/lesson-feedback/SKILL.md
└── halloween-theme/
    ├── AGENTS.md
    └── skills/lesson-feedback/SKILL.md
```

## Wybór przed startem

W głównym [paircoach.config.json](../paircoach.config.json), obok konfiguracji modelu, ustaw `character` na nazwę katalogu:

```json
{
  "codex": {
    "model": "gpt-6.1-sol",
    "reasoning_effort": "medium"
  },
  "character": "default"
}
```

Dla klauna zmień tylko `"character": "halloween-theme"`. Model i poziom rozumowania pozostają osobnymi ustawieniami; `high` możesz wybrać w `reasoning_effort`. Edytuj pliki przed uruchomieniem i zrestartuj PairCoding po zmianie charakteru. Zmiana nie wymaga builda ani modyfikowania kodu platformy.

- [default/AGENTS.md](default/AGENTS.md): treść dotychczasowych `COACH_SYSTEM_PROMPT` i reguł rozmowy/kontraktu z wcześniejszego `prompt.ts`, przeniesiona bez przeredagowywania.
- [halloween-theme/AGENTS.md](halloween-theme/AGENTS.md): te same zasady oraz teatralny, demonicznie rozbawiony klaun. Często mówi „HA HA HA”, żartuje o krwi błędów i duszy ucznia, po czym daje konkretną wskazówkę. Nadal nie psuje testów i respektuje weto oraz potwierdzanie operacji.

Repozytoryjny [AGENTS.md](../AGENTS.md) służy agentom **rozwijającym aplikację**. Nie jest kartą nauczyciela w działającym PairCoding.

## Jak Codex dostaje profil

Każda fizyczna analiza uruchamia świeże `codex exec --ephemeral`. Adapter kopiuje wybrany pakiet do prywatnego katalogu roboczego tej instancji:

```text
prywatny-katalog-Codexa/
├── AGENTS.md
└── .agents/skills/lesson-feedback/SKILL.md
```

Codex otrzymuje standardowe projektowe `AGENTS.md` i standardowy katalog skillów `.agents/skills`; mechanizm sprawdzono na CLI `0.168.0`. Katalog zadania ucznia nie jest katalogiem roboczym procesu modelu. Źródła, zaznaczenie, historia i wyniki Run docierają kontrolowaną projekcją na stdin, a odpowiedź wraca w schemacie JSON.

Wewnętrzny [prompt.ts](../src/server/coach/prompt.ts) zawiera obecnie reguły protokołu aplikacji: format decyzji, ich uprawnienia i korelację z bieżącym pytaniem. Osobowość nauczyciela pochodzi z wybranego `AGENTS.md`. [CodexProvider.ts](../src/server/coach/CodexProvider.ts) składa wywołanie CLI; [character.ts](../src/server/coach/character.ts) wybiera i kopiuje pakiet. Mechanizm nie wymaga klucza API — używa dotychczasowego logowania Codexa.

Pliki nie są dopisywane do źródeł ucznia. Prywatna kopia jest usuwana po wywołaniu modelu. Karta i skille nie znoszą WriteGate, weta, zgody AI ani potwierdzania przywrócenia kopii.

## Edycja i własny charakter

Skopiuj `default` do nowego folderu, np. `characters/spokojny-mentor`, edytuj jego `AGENTS.md` i skille, a następnie ustaw `"character": "spokojny-mentor"`. Nazwa wybiera katalog wewnątrz `characters`; nie jest dowolną ścieżką na dysku.

Nie dodawaj poświadczeń ani tokenów. Adapter przyjmuje zwykłe pliki, odrzuca dowiązania i ogranicza pakiet do 1 MiB / 256 plików; sam `AGENTS.md` ma limit 32 KiB, zgodny z ustawionym limitem instrukcji CLI.

## Skille

Każdy skill umieszczaj w `skills/<nazwa>/SKILL.md`. Zachowaj standardowy YAML frontmatter z `name` i `description`, a poniżej napisz instrukcję. Przykład:

```markdown
---
name: moj-feedback
description: Pomóż uczniowi zinterpretować błąd testu i dobrać następną próbę.
---
Zadaj jedno naprowadzające pytanie. Oddziel obserwację z testu od przypuszczenia.
```

Gotowy [lesson-feedback](default/skills/lesson-feedback/SKILL.md) porządkuje odpowiedź jako „Obserwacja”, „Pytanie”, „Następny krok”. Możesz go jawnie wywołać w czacie: `$lesson-feedback Sprawdź mój kod i ostatni wynik testów`. Skille tej integracji są instrukcyjne: nie odblokowują powłoki, sieci, instalacji pakietów ani bezpośredniego zapisu do zadania. Programy i testy uruchamiasz przyciskami Run/Test.

Standardowy katalog i format: [AGENTS.md w Codex](https://developers.openai.com/codex/guides/agents-md), [skille Codexa](https://developers.openai.com/codex/skills/), [konfiguracja](https://developers.openai.com/codex/config-reference/). Nie używamy uploadu Skills API ani API key do przekazywania tych plików; to lokalne pliki standardowego CLI.
