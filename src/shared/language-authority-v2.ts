/** Server-owned transport bootstrap. Identity is not write authority or LSP readiness. */
import type { Id } from './protocol';
export interface LanguageBootstrapV2 {
  connectionGeneration: Id;
  /** Opaque local lifetime token; never a shadow filesystem or a write/Run prerequisite. */
  shadowGeneration: Id; provider: 'builtin' | 'remote' | 'off';
  /** Required on active builtin bootstrap; optional only for inert historical consumers. */
  features?: { completion: boolean; diagnostics: boolean };
}
