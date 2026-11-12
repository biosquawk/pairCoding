import { assertRelativePath } from '../../language/uriCodec';
import type { ShadowManifest } from './LanguageShadowStore';

export interface LanguageShadowDeltaPlan {
  readonly retainFiles: readonly string[];
  readonly writeFiles: readonly string[];
  readonly removeFiles: readonly string[];
  readonly createDirectories: readonly string[];
  readonly removeDirectories: readonly string[];
}
const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const depth = (path: string): number => path.split('/').length;
const fold = (path: string): string => path.normalize('NFC').toLowerCase();

/** Pure target-filesystem policy, not another URI codec or a filesystem proof. */
function targetPath(path: string): void {
  if (typeof path !== 'string') throw new Error('Invalid shadow path');
  assertRelativePath(path);
  if (path.length > 1024 || path.split('/').some(part => part.length > 240 ||
    /[<>:"|?*\\\x00-\x1f\x7f]/.test(part) ||
    /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)))
    throw new Error('Unsafe shadow target path');
}
function inventory(manifest: Readonly<ShadowManifest>) {
  if (!manifest || !Array.isArray(manifest.files) || !Array.isArray(manifest.directories) ||
    manifest.files.length + manifest.directories.length > 16000) throw new Error('Invalid shadow inventory count');
  const files = new Map<string, { bytes: number; sha256: string }>();
  const directories = new Set<string>();
  const names = new Map<string, string>();
  const admit = (path: string): void => {
    targetPath(path);
    const key = fold(path);
    if (names.has(key)) throw new Error('Duplicate/colliding shadow path');
    names.set(key, path);
  };
  for (const file of manifest.files) {
    if (!file || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid shadow file hash/size');
    admit(file.path); files.set(file.path, { bytes: file.bytes, sha256: file.sha256 });
  }
  for (const path of manifest.directories) { admit(path); directories.add(path); }
  // Full manifests include every parent, including empty directories. Never invent a missing parent.
  for (const path of names.values()) {
    const at = path.lastIndexOf('/');
    if (at >= 0 && !directories.has(path.slice(0, at))) throw new Error('Missing shadow parent directory');
  }
  return { files, directories, names };
}

/**
 * Physical delta ONLY, for two already fully validated trusted manifests. No scope, phase,
 * overlay/lease or disk-currentness authority is minted here. Equal hash+size does NOT prove
 * a retained file exists. Store must retain its full inventories/FD/path/freshness/ALL-overlay
 * fences, poison before mutation, stable root, changed-file/directory durability and NEW
 * manifest publication even when all physical bytes are retained. No filesystem access.
 *
 * Defensive checks cover bounded inventories, canonical target paths, complete parents and
 * hash/size shape. Store remains authority for all other manifest fields. Cross-generation
 * case/NFC spelling aliases are refused too: they cannot safely be treated as independent
 * physical paths on the target filesystem. Same-spelling file/directory transitions are explicit.
 * The five lists are not a single operation schedule; Store orders transition removals safely.
 */
export function planLanguageShadowDelta(previous: Readonly<ShadowManifest>, next: Readonly<ShadowManifest>): LanguageShadowDeltaPlan {
  const old = inventory(previous), current = inventory(next);
  for (const [key, path] of current.names) {
    const before = old.names.get(key);
    if (before !== undefined && before !== path) throw new Error('Cross-generation shadow path alias');
  }
  const retainFiles: string[] = [], writeFiles: string[] = [];
  for (const [path, file] of current.files) {
    const before = old.files.get(path);
    (before && before.bytes === file.bytes && before.sha256 === file.sha256 ? retainFiles : writeFiles).push(path);
  }
  return Object.freeze({
    retainFiles: Object.freeze(retainFiles.sort(lexical)),
    writeFiles: Object.freeze(writeFiles.sort(lexical)),
    removeFiles: Object.freeze([...old.files.keys()].filter(path => !current.files.has(path)).sort(lexical)),
    createDirectories: Object.freeze([...current.directories].filter(path => !old.directories.has(path))
      .sort((a, b) => depth(a) - depth(b) || lexical(a, b))),
    removeDirectories: Object.freeze([...old.directories].filter(path => !current.directories.has(path))
      .sort((a, b) => depth(b) - depth(a) || lexical(a, b))),
  });
}
