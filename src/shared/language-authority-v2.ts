/** Server-owned transport bootstrap. Identity is not write authority or LSP readiness. */
import type { Id } from './protocol';
export interface LanguageBootstrapV2 {
  connectionGeneration: Id; shadowGeneration: Id; provider: 'builtin' | 'remote' | 'off';
}
