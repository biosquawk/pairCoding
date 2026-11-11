/** Child-only fixture. Simulates process death while actual temp-file transaction intent is durable. */
import { SettingsV2Store, type SettingsTransactionAuthority, type SaveSettingsInput } from '../../src/server/settings-v2';
const [settingsPath, phase, inputJSON] = process.argv.slice(2);
const authority: SettingsTransactionAuthority = {
  async transact(_identity, effect) { effect({ assertCurrent() {} }); throw Error('Crash hook did not terminate'); },
  async reconcile() { throw Error('Child must never reconcile'); },
};
const store = new SettingsV2Store({ settingsPath, authority, checkpoint: actual => { if (actual === phase) process.exit(73); } });
await store.save(JSON.parse(inputJSON) as SaveSettingsInput);
