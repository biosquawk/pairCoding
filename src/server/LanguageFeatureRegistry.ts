import type { Capabilities, RunProfile } from '../shared/protocol';

/** MVP extension boundary. No pretend provider, endpoint or automatic installation. */
export class LanguageFeatureRegistry {
  getCapabilities(profiles: RunProfile[] = []): Capabilities {
    return {
      canRunMain: profiles.some(p => p.kind === 'RUN_MAIN'),
      canRunTests: profiles.some(p => p.kind === 'RUN_TESTS'),
      docs: 'NOT_INSTALLED',
      autocomplete: 'NOT_INSTALLED',
    };
  }
}
