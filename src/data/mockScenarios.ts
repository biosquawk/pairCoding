/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { TrainingScenario } from '../types/paircoach';

export const MOCK_SCENARIOS: TrainingScenario[] = [
  {
    id: 'two-sum-opt',
    title: 'LeetCode #1: Two Sum — Optymalizacja O(N)',
    category: 'LeetCode',
    taskMode: 'IMPLEMENTATION',
    description: 'Zoptymalizuj implementację Two Sum z naiwnego O(N²) do liniowego czasu O(N) za pomocą tablicy asocjacyjnej / Map.',
    defaultTimeLimitMs: 15 * 60 * 1000, // 15 min
    taskFilePath: 'challenge.md',
    reviewNotesPath: 'review.md',
    capabilities: {
      canRunMain: true,
      canRunTests: true,
      docsPlugin: 'NOT_INSTALLED',
      autocompletePlugin: 'NOT_INSTALLED',
    },
    files: [
      {
        path: 'challenge.md',
        kind: 'FILE',
        version: 1,
        content: `# LeetCode #1: Two Sum (Suma Dwóch Liczb)

## Treść Zadania
Mając daną tablicę liczb całkowitych \`nums\` oraz liczbę docelową \`target\`, zwróć **indeksy dwóch liczb**, których suma wynosi dokładnie \`target\`.

Możesz założyć, że każde wejście posiada **dokładnie jedno rozwiązanie**, i nie możesz użyć tego samego elementu dwukrotnie.

Odpowiedź możesz zwrócić w dowolnej kolejności.

---

### Przykłady:
**Przykład 1:**
- **Wejście:** \`nums = [2, 7, 11, 15], target = 9\`
- **Wyjście:** \`[0, 1]\`
- **Wyjaśnienie:** \`nums[0] + nums[1] == 2 + 7 == 9\`, zwracamy \`[0, 1]\`.

**Przykład 2:**
- **Wejście:** \`nums = [3, 2, 4], target = 6\`
- **Wyjście:** \`[1, 2]\`

**Przykład 3:**
- **Wejście:** \`nums = [3, 3], target = 6\`
- **Wyjście:** \`[0, 1]\`

---

### Wymagania wydajnościowe:
- Aktualne rozwiązanie w \`src/solution.ts\` używa podwójnej pętli ze złożonością czasową **O(N²)**.
- Twoim celem jest optymalizacja do złożoności **O(N)** z wykorzystaniem \`Map<number, number>\` (złożoność pamięciowa O(N)).
- Wskazówka Trenera AI: w trakcie pracy trener może zasugerować uzupełnienie mapy dopełnieniem (\`target - num\`).
`,
      },
      {
        path: 'src/solution.ts',
        kind: 'FILE',
        version: 1,
        content: `/**
 * Rozwiązanie problemu Two Sum.
 * Zwraca indeksy [i, j], dla których nums[i] + nums[j] === target.
 */
export function twoSum(nums: number[], target: number): number[] {
  // UWAGA: Aktualna implementacja ma złożoność O(N^2)
  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) {
      if (nums[i] + nums[j] === target) {
        return [i, j];
      }
    }
  }

  throw new Error("Brak pary spełniającej warunek");
}
`,
      },
      {
        path: 'src/solution.test.ts',
        kind: 'FILE',
        version: 1,
        content: `import { twoSum } from './solution';

export function runTests(): { name: string; passed: boolean; message?: string }[] {
  const results = [];

  // Test 1: Standardowy przypadek
  try {
    const res1 = twoSum([2, 7, 11, 15], 9);
    const passed1 = (res1[0] === 0 && res1[1] === 1) || (res1[0] === 1 && res1[1] === 0);
    results.push({ name: 'Test 1: [2, 7, 11, 15] target 9', passed: passed1 });
  } catch (e: any) {
    results.push({ name: 'Test 1: [2, 7, 11, 15] target 9', passed: false, message: e.message });
  }

  // Test 2: Niesortowane liczby
  try {
    const res2 = twoSum([3, 2, 4], 6);
    const passed2 = (res2[0] === 1 && res2[1] === 2) || (res2[0] === 2 && res2[1] === 1);
    results.push({ name: 'Test 2: [3, 2, 4] target 6', passed: passed2 });
  } catch (e: any) {
    results.push({ name: 'Test 2: [3, 2, 4] target 6', passed: false, message: e.message });
  }

  // Test 3: Duplikaty wartości
  try {
    const res3 = twoSum([3, 3], 6);
    const passed3 = (res3[0] === 0 && res3[1] === 1) || (res3[0] === 1 && res3[1] === 0);
    results.push({ name: 'Test 3: [3, 3] target 6', passed: passed3 });
  } catch (e: any) {
    results.push({ name: 'Test 3: [3, 3] target 6', passed: false, message: e.message });
  }

  // Test 4: Wydajnościowy test dużej tablicy (10000 elementów)
  try {
    const bigArray = Array.from({ length: 10000 }, (_, i) => i * 2);
    const start = performance.now();
    const res4 = twoSum(bigArray, 19998); // ostatnie elementy
    const elapsed = performance.now() - start;
    const passed4 = res4.length === 2 && elapsed < 50; // O(N) powinno przejść w < 5ms
    results.push({
      name: 'Test 4 (Wydajność 10k elementów < 50ms)',
      passed: passed4,
      message: passed4 ? \`Wykonano w \${elapsed.toFixed(2)}ms\` : \`Zbyt wolno: \${elapsed.toFixed(2)}ms (wymagana optymalizacja O(N))\`
    });
  } catch (e: any) {
    results.push({ name: 'Test 4 (Wydajność)', passed: false, message: e.message });
  }

  return results;
}
`,
      },
      {
        path: 'tsconfig.json',
        kind: 'FILE',
        version: 1,
        content: `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "strict": true
  }
}
`,
      },
    ],
  },
  {
    id: 'payment-code-review',
    title: 'Code Review: Serwis Płatności Online',
    category: 'Code Review',
    taskMode: 'CODE_REVIEW',
    description: 'Przeanalizuj kod mikrousługi obsługującej karty i przelewy. Znajdź luki bezpieczeństwa (wyciek danych kart, brak idempotencji, błędy zmiennoprzecinkowe) i opisz je w review.md.',
    defaultTimeLimitMs: 20 * 60 * 1000, // 20 min
    taskFilePath: 'challenge.md',
    reviewNotesPath: 'review.md',
    capabilities: {
      canRunMain: true,
      canRunTests: false, // W zadaniu Code Review brak automatycznych testów (prezentowane neutralnie)
      runTestsReason: 'Zadanie Code Review nie posiada zestawu testów jednostkowych — ocena następuje na podstawie review.md',
      docsPlugin: 'NOT_INSTALLED',
      autocompletePlugin: 'NOT_INSTALLED',
    },
    files: [
      {
        path: 'challenge.md',
        kind: 'FILE',
        version: 1,
        content: `# Code Review: Serwis Płatności i Autoryzacji Kart

## Cel Zadania
Jesteś Senior Developerem przeprowadzającym rewizję kodu nowego modułu płatności (\`services/PaymentProcessor.ts\` oraz \`services/TransactionLogger.ts\`).

Wpisz swoje uwagi, wykryte podatności oraz propozycje naprawy do pliku **\`review.md\`**.

---

### Kluczowe Obszary do Weryfikacji:
1. **Bezpieczeństwo danych wrażliwych (PCI-DSS):**
   - Czy dane kart płatniczych (PAN, CVV/CVC, data ważności) są gdziekolwiek logowane jawnym tekstem?
2. **Idempotencja transakcji:**
   - Co się stanie, gdy użytkownik kliknie przycisk „Zapłać” dwa razy z rzędu w odstępie 200ms?
3. **Precyzja walutowa i arytmetyka:**
   - Czy kwoty pieniężne są przetwarzane w typie zmiennoprzecinkowym (\`number\` z błędem zaokrągleń IEEE 754), czy w groszach/centach jako liczby całkowite?
4. **Odporność na błędy (Transakcyjność & Rollback):**
   - Czy w przypadku błędu bramki stan w bazie jest wycofywany?
`,
      },
      {
        path: 'review.md',
        kind: 'FILE',
        version: 1,
        content: `# Notatki z Przeglądu Kodu (Code Review)

Wpisz swoje uwagi w poniższych sekcjach:

## 1. Wykryte luki bezpieczeństwa (Krytyczne / High)
- [ ] ...

## 2. Błędy biznesowe i spójności danych (Medium)
- [ ] ...

## 3. Sugestie usprawnień architektury i czystości kodu (Low / Refactor)
- [ ] ...
`,
      },
      {
        path: 'services/PaymentProcessor.ts',
        kind: 'FILE',
        version: 1,
        content: `import { logTransaction } from './TransactionLogger';

export interface CardDetails {
  cardNumber: string;
  cvv: string;
  expMonth: number;
  expYear: number;
}

export class PaymentProcessor {
  // LUKA 1: Brak sprawdzania klucza idempotencji
  async chargeCreditCard(userId: string, amount: number, card: CardDetails): Promise<boolean> {
    // LUKA 2: Kwota jako float - zaokrąglenia np. 0.1 + 0.2 !== 0.3
    const fee = amount * 0.029 + 0.30;
    const total = amount + fee;

    // LUKA 3: Logowanie CVV i pełnego numeru karty do pliku tekstowego (krytyczne naruszenie PCI-DSS)
    logTransaction(\`Przetwarzanie obciążenia dla użytkownika \${userId}, Karta: \${card.cardNumber}, CVV: \${card.cvv}, Kwota: \${total}\`);

    // Symulacja wywołania bramki płatniczej
    const success = await fakeGatewayApiCall(card, total);
    return success;
  }
}

async function fakeGatewayApiCall(card: CardDetails, amount: number): Promise<boolean> {
  return true;
}
`,
      },
      {
        path: 'services/TransactionLogger.ts',
        kind: 'FILE',
        version: 1,
        content: `export function logTransaction(message: string): void {
  // W środowisku produkcyjnym zapisuje do bazy logs lub zewnętrznego ELK
  console.log(\`[AUDIT LOG \${new Date().toISOString()}] \${message}\`);
}
`,
      },
    ],
  },
  {
    id: 'lru-cache-py',
    title: 'Algorytm: LRU Cache w Pythonie',
    category: 'Algorytmy',
    taskMode: 'IMPLEMENTATION',
    description: 'Zaimplementuj strukturę danych Least Recently Used (LRU) Cache ze złożonościami get() oraz put() na poziomie O(1).',
    defaultTimeLimitMs: 20 * 60 * 1000,
    taskFilePath: 'challenge.md',
    reviewNotesPath: 'review.md',
    capabilities: {
      canRunMain: true,
      canRunTests: true,
      docsPlugin: 'NOT_INSTALLED',
      autocompletePlugin: 'NOT_INSTALLED',
    },
    files: [
      {
        path: 'challenge.md',
        kind: 'FILE',
        version: 1,
        content: `# LRU Cache (Least Recently Used)

## Opis zadania
Zaprojektuj strukturę danych spełniającą wymagania pamięci podręcznej **Least Recently Used (LRU)**.

Zaimplementuj klasę \`LRUCache\`:
- \`__init__(capacity: int)\` — Inicjalizuje cache o zadanej maksymalnej pojemności.
- \`get(key: int) -> int\` — Zwraca wartość klucza jeśli istnieje, w przeciwnym razie \`-1\`. Oznacza element jako ostatnio używany.
- \`put(key: int, value: int) -> None\` — Aktualizuje wartość klucza lub wstawia nowy. Jeśli przekroczono \`capacity\`, usuwa najdawniej używany element.

Obie metody muszą działać w czasie **O(1)**.
`,
      },
      {
        path: 'src/LRUCache.py',
        kind: 'FILE',
        version: 1,
        content: `class LRUCache:
    def __init__(self, capacity: int):
        self.capacity = capacity
        # Wskazówka: Użyj OrderedDict lub dwukierunkowej listy powiązanej + dict
        self.cache = {}

    def get(self, key: int) -> int:
        if key in self.cache:
            # TODO: przenieś na koniec jako ostatnio używany
            return self.cache[key]
        return -1

    def put(self, key: int, value: int) -> None:
        # TODO: zaimplementuj usuwanie najstarszego elementu przy przekroczeniu capacity
        self.cache[key] = value
`,
      },
      {
        path: 'src/test_cache.py',
        kind: 'FILE',
        version: 1,
        content: `# Zestaw testów jednostkowych LRU Cache
def test_lru_basic():
    pass
`,
      },
    ],
  },
];
