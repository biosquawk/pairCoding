/** Strict facade-shape proof, not a keyword scan. No TypeScript compiler-API dependency. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const source=readFileSync(new URL('../../src/server/Runner.ts',import.meta.url),'utf8');
const parserMarker='/** Conservative JUnit dialect: well-formed XML, real testcase elements, consistent counters. */\n';
const header=`/** Public neutral lifecycle: the existing coordinator is the sole Runner implementation. */
export { RuntimeRunner as Runner, RuntimeRunner } from './runtime-coordinator/RuntimeRunner';
export type { RuntimeRunAdmission, RuntimeRunnerOptions } from './runtime-coordinator/RuntimeRunner';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const REPORT_LIMIT = 4 * 1024 * 1024;

`;

test('public facade is exactly a pure parser plus coordinator/type re-exports, with no import-time host engine',()=>{
  // Exact whitelist excludes additional statements, imports, constructor, fs scans, taskkill,
  // profile/executable selection and env forwarding; comments/strings cannot disguise extra code.
  const marker=source.indexOf(parserMarker);
  assert.ok(marker>=0);
  assert.equal(source.slice(0,marker),header);
  const parserAndRemainder=source.slice(marker+parserMarker.length);
  assert.equal(createHash('sha256').update(parserAndRemainder).digest('hex'),
    '89823a07ef4240fd2821a4369bb481153011f9143f5a14c6281d9a6dc1653ddc');
});

test('original pure JUnit function bytes and required XML import/limit stay frozen at c9f30b4',()=>{
  const start=source.indexOf('export function parseJUnit');
  const end=source.indexOf('\n}',start)+2;
  assert.ok(start>=0&&end>start);
  assert.equal(createHash('sha256').update(source.slice(start,end)).digest('hex'),
    '29bffb52a44826e0e885ef578c230338f2a19544770e8df9d3cfabac6e3d5450');
  assert.ok(source.split('\n').includes("import { XMLParser, XMLValidator } from 'fast-xml-parser';"));
  assert.ok(source.split('\n').includes('const REPORT_LIMIT = 4 * 1024 * 1024;'));
});
