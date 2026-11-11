import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import type { LanguageProviderConfiguration } from './LanguageProviderConfiguration';
import type { LanguageShadow } from './LanguageShadowStore';
import { assertLaunchId, assertPrivateLanguageDirectory, assertRealDirectory, readRegular, sha256 } from './LanguageProcessJournal';
import { NodeLanguageJournalDurability, type LanguageJournalDurability } from './LanguageJournalDurability';

export interface LanguageBootPublication {
  readonly launchId: string; readonly analysisSettingsSha256: string; readonly inputManifestSha256: string;
  readonly manifestPath: string; readonly manifestSha256: string;
  readonly files: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[];
}
const manifestName = 'language-launch.json';
const freeze = <T>(v: T): T => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const stamp = (s: import('node:fs').BigIntStats): string => [s.dev, s.ino, s.size, s.nlink, s.mode, s.mtimeNs, s.ctimeNs].join(':');
/** Pre-process publication ONLY. No overwrite, repair, symlink following or inferred prepared readiness.
 * An interrupted/failed publication poisons that launch in this owner; use a fresh unlaunched sibling.
 * Private parent ACL responsibility and Win32 directory durability limits match the shadow/journal.
 */
export class LanguageBootPublisher {
  private publications = new WeakMap<LanguageShadow, { config: Readonly<LanguageProviderConfiguration>; publication: LanguageBootPublication } | null>();
  private launches = new WeakMap<LanguageBootPublication, { shadow: LanguageShadow; config: Readonly<LanguageProviderConfiguration> }>();
  constructor(private readonly assertShadow: (shadow: LanguageShadow) => void,
    private readonly durability: LanguageJournalDurability = new NodeLanguageJournalDurability(assertRealDirectory)) {}
  get durabilityPolicy(): LanguageJournalDurability['policy'] { return this.durability.policy; }
  private directory(shadow: LanguageShadow, checkShadow = true): void {
    assertLaunchId(shadow.launchId);
    const root = dirname(shadow.workspaceDirectory);
    if (basename(root) !== shadow.launchId || shadow.workspaceDirectory !== join(root, 'workspace') ||
      shadow.bootDirectory !== join(root, 'boot') || shadow.stateDirectory !== join(root, 'state') ||
      shadow.wholeProjectManifestPath !== join(root, 'manifest.json')) throw new Error('Boot publication outside exact owned launch');
    assertPrivateLanguageDirectory(root); assertRealDirectory(shadow.bootDirectory); if (checkShadow) this.assertShadow(shadow);
  }
  private config(config: Readonly<LanguageProviderConfiguration>, shadow: LanguageShadow): Readonly<LanguageProviderConfiguration> {
    const captured = freeze(structuredClone(config));
    const { provider, argv, settings, bootFiles, expectedProjectUri, dependencyCopyDirectory, analysisSettingsSha256 } = captured;
    if (!['jdt', 'pylsp'].includes(provider) || provider !== shadow.manifest.identity.provider || !Array.isArray(argv) ||
      argv.length < 1 || argv.length > 48 || argv.some(a => typeof a !== 'string' || a.includes('\0')) ||
      !settings || typeof settings !== 'object' || Array.isArray(settings) || !bootFiles || typeof bootFiles !== 'object' || Array.isArray(bootFiles) ||
      typeof expectedProjectUri !== 'string' || dependencyCopyDirectory !== '.paircoach-dependencies' ||
      Object.keys(bootFiles).length > 16 || Object.entries(bootFiles).some(([name, content]) =>
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name) || name === manifestName || /[. ]$/.test(name) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || typeof content !== 'string' || Buffer.byteLength(content) > 64 * 1024))
      throw new Error('Invalid boot configuration');
    const bytes = JSON.stringify({ provider, argv, settings, bootFiles, expectedProjectUri, dependencyCopyDirectory });
    if (Buffer.byteLength(bytes) > 256 * 1024 || sha256(bytes) !== analysisSettingsSha256 ||
      analysisSettingsSha256 !== shadow.manifest.identity.analysisSettingsSha256) throw new Error('Boot configuration hash mismatch');
    return captured;
  }
  private exclusive(directory: string, name: string, bytes: Buffer): void {
    assertRealDirectory(directory); const path = join(directory, name);
    // O_EXCL rejects an existing regular file, symlink or hardlink even on Windows without O_NOFOLLOW.
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    let created: import('node:fs').BigIntStats;
    try {
      writeFileSync(fd, bytes); fchmodSync(fd, 0o444); this.durability.file(fd); created = fstatSync(fd, { bigint: true });
      if (!created.isFile() || created.nlink !== 1n || created.size !== BigInt(bytes.length) ||
        stamp(lstatSync(path, { bigint: true })) !== stamp(created)) throw new Error('Boot file changed during publication');
    } finally { closeSync(fd); }
    this.durability.directory(directory);
    if (stamp(lstatSync(path, { bigint: true })) !== stamp(created) || !readRegular(path, bytes.length).equals(bytes))
      throw new Error('Boot file identity/readback mismatch');
  }
  publish(shadow: LanguageShadow, config: Readonly<LanguageProviderConfiguration>): LanguageBootPublication {
    if (this.publications.has(shadow)) throw new Error('Boot launch already published or publication failed');
    this.publications.set(shadow, null); this.directory(shadow);
    const captured = this.config(config, shadow), files = Object.entries(captured.bootFiles).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([path, content]) => ({ path, bytes: Buffer.byteLength(content), sha256: sha256(content) }));
    for (const file of files) this.exclusive(shadow.bootDirectory, file.path, Buffer.from(captured.bootFiles[file.path]));
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, launchId: shadow.launchId, phase: shadow.phase,
      inputManifestSha256: shadow.inputManifestSha256, analysisSettingsSha256: captured.analysisSettingsSha256, config: captured, files }));
    if (manifest.length > 384 * 1024) throw new Error('Boot manifest too large');
    this.exclusive(shadow.bootDirectory, manifestName, manifest); this.directory(shadow);
    const publication = freeze({ launchId: shadow.launchId, analysisSettingsSha256: captured.analysisSettingsSha256,
      inputManifestSha256: shadow.inputManifestSha256, manifestPath: join(shadow.bootDirectory, manifestName), manifestSha256: sha256(manifest), files });
    this.publications.set(shadow, { config: captured, publication }); this.launches.set(publication, { shadow, config: captured });
    this.assertPublished(shadow, captured, publication); return publication;
  }
  /** Original privately retained publication only; a JSON clone or matching-looking file is no authority. */
  assertPublished(shadow: LanguageShadow, config: Readonly<LanguageProviderConfiguration>, publication: LanguageBootPublication): void {
    const issued = this.publications.get(shadow);
    if (!issued || issued.publication !== publication || !same(issued.config, config)) throw new Error('Unknown/foreign boot publication');
    this.directory(shadow);
    this.assertLaunchFiles(config, publication); this.directory(shadow);
  }
  /** Same process boot/configuration after a mutable shadow refresh. Verifies ONLY original launch files;
   * caller MUST separately check the current full-source lease and current shadow integrity. This never
   * changes the original publication/manifest or attributes analysis to a refreshed source.
   */
  assertLaunchFiles(config: Readonly<LanguageProviderConfiguration>, publication: LanguageBootPublication): void {
    const issued = this.launches.get(publication);
    if (!issued || !same(issued.config, config)) throw new Error('Unknown/foreign boot publication');
    const { shadow } = issued; this.directory(shadow, false);
    const manifest = readRegular(publication.manifestPath, 384 * 1024);
    if (sha256(manifest) !== publication.manifestSha256) throw new Error('Boot manifest tampered');
    for (const file of publication.files) {
      const bytes = readRegular(join(shadow.bootDirectory, file.path), file.bytes);
      if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error('Boot file tampered');
    }
    this.directory(shadow, false);
  }
}
