import type { RunProfile } from '../shared/protocol';
const fail = (message: string): never => { throw new Error(message); };
function parse(source: string, label: string): unknown {
  try { return JSON.parse(source); } catch { return fail(`${label}: niepoprawny JSON. Użyj podwójnych cudzysłowów.`); }
}
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max; }
export function parseRunProfiles(source: string): RunProfile[] {
  const values = parse(source, 'Profile');
  if (!Array.isArray(values) || values.length > 2) fail('Profile: podaj listę JSON, najwyżej po jednym RUN_MAIN i RUN_TESTS. [] oznacza brak konfiguracji.');
  const seen = new Set<string>();
  const keys = ['kind', 'executable', 'args', 'cwd', 'timeoutMs', 'testReportFormat', 'testReportGlob'];
  for (const [index, profile] of (values as unknown[]).entries()) {
    const prefix = `Profil ${index + 1}: `;
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) fail(prefix + 'oczekiwano obiektu.');
    const p = profile as Record<string, unknown>;
    if (Object.keys(p).length !== keys.length || Object.keys(p).some(key => !keys.includes(key))) fail(prefix + 'wymagane dokładnie pola kind, executable, args, cwd, timeoutMs, testReportFormat, testReportGlob.');
    if (p.kind !== 'RUN_MAIN' && p.kind !== 'RUN_TESTS') fail(prefix + 'kind to RUN_MAIN lub RUN_TESTS.');
    if (seen.has(p.kind as string)) fail(prefix + 'zduplikowany rodzaj profilu.'); seen.add(p.kind as string);
    if (!text(p.executable, 1024) || !text(p.cwd, 1024)) fail(prefix + 'executable i cwd muszą być niepustymi tekstami do 1024 znaków.');
    if (!Array.isArray(p.args) || p.args.length > 100 || p.args.some(arg => typeof arg !== 'string' || arg.length > 4096)) fail(prefix + 'args musi być listą do 100 tekstowych argumentów (do 4096 znaków każdy).');
    if (!Number.isInteger(p.timeoutMs) || (p.timeoutMs as number) < 1000 || (p.timeoutMs as number) > 300000) fail(prefix + 'timeoutMs: liczba całkowita 1000–300000.');
    if (p.testReportFormat !== 'NONE' && p.testReportFormat !== 'JUNIT_XML') fail(prefix + 'testReportFormat: NONE lub JUNIT_XML.');
    if (p.testReportGlob !== null && !text(p.testReportGlob, 1024)) fail(prefix + 'testReportGlob: null lub niepusty tekst do 1024 znaków.');
    if (p.testReportFormat === 'JUNIT_XML' && p.testReportGlob === null) fail(prefix + 'JUNIT_XML wymaga ścieżki/globu świeżego raportu.');
  }
  return values as RunProfile[];
}
export function parseContextPatterns(source: string): string[] {
  const patterns = parse(source, 'Wzorce kontekstu');
  if (!Array.isArray(patterns) || patterns.length > 100 || patterns.some(p => !text(p, 1024))) fail('Wzorce kontekstu: lista do 100 niepustych tekstów (max 1024 znaki). [] wyłącza kontekst plików.');
  return patterns as string[];
}
