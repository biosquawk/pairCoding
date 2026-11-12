import { XMLParser, XMLValidator } from 'fast-xml-parser';
export const REPORT_LIMIT = 4 * 1024 * 1024;
export interface JUnitCounts { count: number; failures: number; errors: number; skipped: number }
/** Strict default preserves the legacy conservative dialect. Node's reporter also
 * emits direct root cases and omits counters; count real elements, never comments.
 * Only the trusted outcome adapter selects that dialect. Errors remain separate.
 */
export function parseJUnit(xml: string, dialect: 'strict' | 'node' = 'strict'): JUnitCounts | null {
  if (Buffer.byteLength(xml) > REPORT_LIMIT || /<!\s*(DOCTYPE|ENTITY)/i.test(xml) || XMLValidator.validate(xml) !== true) return null;
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_',
    parseAttributeValue: false, processEntities: false, isArray: name => name === 'testsuite' || name === 'testcase' });
  try {
    const parsed = parser.parse(xml);
    if ((parsed.testsuite !== undefined) === (parsed.testsuites !== undefined)) return null;
    const integer = (value: unknown): number => {
      if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid count');
      return Number(value);
    };
    type Counts = { tests: number; failures: number; errors: number; skipped: number };
    const visit = (suite: any, aggregateRoot = false, depth = 0): Counts => {
      if (dialect === 'node' && suite === '') suite = {}; // empty Node report/suite
      if (depth > 64 || !suite || typeof suite !== 'object' || Array.isArray(suite) || suite.testsuites !== undefined) throw new Error('Invalid suite');
      const totals: Counts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
      const aggregate = aggregateRoot || suite.testsuite !== undefined;
      if (aggregate) {
        if (dialect === 'strict' && suite.testcase !== undefined ||
            suite.testsuite !== undefined && (!Array.isArray(suite.testsuite) || !suite.testsuite.length) ||
            dialect === 'strict' && suite.testsuite === undefined) throw new Error('Invalid aggregate');
        for (const child of suite.testsuite ?? []) {
          const counts = visit(child, false, depth + 1);
          for (const key of Object.keys(totals) as (keyof Counts)[]) {
            totals[key] += counts[key];
            if (!Number.isSafeInteger(totals[key])) throw new Error('Count overflow');
          }
        }
      }
      if (!aggregate || dialect === 'node' && suite.testcase !== undefined) {
        const cases = suite.testcase ?? [];
        totals.tests += cases.length;
        if (!Number.isSafeInteger(totals.tests)) throw new Error('Count overflow');
        for (const testcase of cases) {
          // XML empty testcase is '', a valid real element; null/non-object cannot have outcomes.
          const failed = testcase?.failure !== undefined, error = testcase?.error !== undefined, skipped = testcase?.skipped !== undefined;
          if (Number(failed) + Number(error) + Number(skipped) > 1) throw new Error('Conflicting outcomes');
          totals.failures += Number(failed); totals.errors += Number(error); totals.skipped += Number(skipped);
        }
      }
      for (const key of Object.keys(totals) as (keyof Counts)[]) {
        const declared = suite['@_' + key];
        if ((aggregate || dialect === 'node') && declared === undefined) continue;
        const expected = declared === undefined && key !== 'tests' ? 0 : integer(declared);
        if (expected !== totals[key]) throw new Error('Inconsistent ' + key);
      }
      return totals;
    };
    const totals = parsed.testsuites !== undefined ? visit(parsed.testsuites, true) : visit({ testsuite: parsed.testsuite }, true);
    return { count: totals.tests, failures: totals.failures, errors: totals.errors, skipped: totals.skipped };
  } catch { return null; }
}
