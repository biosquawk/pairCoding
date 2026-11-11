/** Public neutral lifecycle: the existing coordinator is the sole Runner implementation. */
export { RuntimeRunner as Runner, RuntimeRunner } from './runtime-coordinator/RuntimeRunner';
export type { RuntimeRunAdmission, RuntimeRunnerOptions } from './runtime-coordinator/RuntimeRunner';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const REPORT_LIMIT = 4 * 1024 * 1024;

/** Conservative JUnit dialect: well-formed XML, real testcase elements, consistent counters. */
export function parseJUnit(xml: string): { count: number; failures: number; skipped: number } | null {
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
    const visit = (suite: any, aggregateRoot = false): Counts => {
      if (!suite || typeof suite !== 'object' || Array.isArray(suite) || suite.testsuites !== undefined) throw new Error('Invalid suite');
      let totals: Counts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
      const aggregate = aggregateRoot || suite.testsuite !== undefined;
      if (aggregate) {
        if (suite.testcase !== undefined || !Array.isArray(suite.testsuite) || !suite.testsuite.length) throw new Error('Invalid aggregate suite');
        for (const child of suite.testsuite) {
          const counts = visit(child);
          for (const key of Object.keys(totals) as (keyof Counts)[]) {
            totals[key] += counts[key];
            if (!Number.isSafeInteger(totals[key])) throw new Error('Count overflow');
          }
        }
      } else {
        const cases = suite.testcase ?? [];
        totals.tests = cases.length;
        for (const testcase of cases) {
          const failed = testcase.failure !== undefined;
          const error = testcase.error !== undefined;
          const skipped = testcase.skipped !== undefined;
          if (Number(failed) + Number(error) + Number(skipped) > 1) throw new Error('Conflicting testcase outcomes');
          totals.failures += Number(failed); totals.errors += Number(error); totals.skipped += Number(skipped);
        }
      }
      for (const key of Object.keys(totals) as (keyof Counts)[]) {
        const declared = suite['@_' + key];
        // Leaves keep the conservative dialect: tests required, missing outcomes mean zero.
        // Aggregates may omit counters, but every declared counter must match all descendants.
        if (aggregate && declared === undefined) continue;
        const expected = declared === undefined && key !== 'tests' ? 0 : integer(declared);
        if (expected !== totals[key]) throw new Error('Inconsistent ' + key);
      }
      return totals; // Only leaf cases contribute, never add declared aggregate totals.
    };
    const totals = parsed.testsuites !== undefined ? visit(parsed.testsuites, true) :
      visit({ testsuite: parsed.testsuite }, true);
    return { count: totals.tests, failures: totals.failures + totals.errors, skipped: totals.skipped };
  } catch { return null; }
}
