import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CodexConfig {
  readonly model: string;
  readonly reasoning_effort: 'low' | 'medium' | 'high' | 'xhigh';
}

// Resolve against the installed application, never the student's workspace or child cwd.
export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../../../paircoach.config.json', import.meta.url));
export function loadCodexConfig(configPath = process.env.PAIRCOACH_CONFIG || DEFAULT_CONFIG_PATH,
  env: NodeJS.ProcessEnv = process.env): Readonly<CodexConfig> {
  if (!path.isAbsolute(configPath)) throw new Error('CODEX_CONFIG_ABSOLUTE_PATH_REQUIRED');
  let value: unknown;
  try { value = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('CODEX_CONFIG_UNREADABLE'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CODEX_CONFIG_INVALID');
  const codex = (value as Record<string, unknown>).codex;
  if (!codex || typeof codex !== 'object' || Array.isArray(codex)) throw new Error('CODEX_CONFIG_INVALID');
  const fields = codex as Record<string, unknown>;
  if (Object.keys(fields).some(key => !['model', 'reasoning_effort'].includes(key))) throw new Error('CODEX_CONFIG_INVALID');
  const model = env.PAIRCOACH_CODEX_MODEL ?? fields.model;
  const effort = env.PAIRCOACH_CODEX_REASONING_EFFORT ?? fields.reasoning_effort;
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)) throw new Error('CODEX_CONFIG_MODEL_INVALID');
  if (typeof effort !== 'string' || !['low', 'medium', 'high', 'xhigh'].includes(effort)) throw new Error('CODEX_CONFIG_REASONING_INVALID');
  return Object.freeze({ model, reasoning_effort: effort as CodexConfig['reasoning_effort'] });
}
