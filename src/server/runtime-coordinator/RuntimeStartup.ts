/** Awaited V2 construction seam. No listening socket, host task, Docker mutation or implicit prepare.
 * index/http must compose this BEFORE publishing a core; this module is not itself the entrypoint.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DockerTransport } from '../execution/DockerTransport';
import { loadRuntimeConfiguration, type RuntimeConfiguration, type RuntimeEnvironment } from '../runtime-config';
import { createPreparedRuntimeResolver, type PreparedRuntimeResolver } from './PreparedRuntimeResolver';
import { createRuntimeWorkspace, type RuntimeWorkspace } from './RuntimeWorkspace';
import { AppError } from '../errors';

// The application config is package/module-relative, NEVER discovered in the caller's cwd.
export const DEFAULT_RUNTIME_CONFIG_PATH = fileURLToPath(new URL('../../../paircoach.runtime.json', import.meta.url));
export interface RuntimeStartupArguments {
  readonly runtimeConfigPath: string;
  readonly preparedRuntimeRoots: readonly string[];
  /** Trusted operator selection only. Absence never means implicit discovery/readiness. */
  readonly languageReceiptPath?: string;
}
export class RuntimeStartupArgumentError extends Error {
  readonly code = 'INVALID_STARTUP_ARGUMENTS';
  readonly status = 400;
  constructor() { super('Use --runtime-config <absolute-file> at most once and --prepared-runtime <absolute-outputRoot> at most 16 times, optionally --language-receipt <absolute-file> at most once. Select distinct canonical, non-overlapping output directories.'); }
}
const invalid = (): never => { throw new RuntimeStartupArgumentError(); };
const validPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value);
/** Pure argument validation. No path existence/realpath lookup or new environment/config surface. */
export function parseRuntimeStartupArguments(argv: readonly string[]): RuntimeStartupArguments {
  if (!Array.isArray(argv) || argv.length > 36) invalid();
  let runtimeConfigPath = DEFAULT_RUNTIME_CONFIG_PATH, selectedConfig = false;
  const preparedRuntimeRoots: string[] = [];
  let languageReceiptPath: string | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!validPath(value) || !path.isAbsolute(value)) invalid();
    if (flag === '--runtime-config' && !selectedConfig) {
      runtimeConfigPath = path.normalize(value); selectedConfig = true;
    } else if (flag === '--language-receipt' && languageReceiptPath === undefined) {
      languageReceiptPath = path.normalize(value);
    } else if (flag === '--prepared-runtime' && preparedRuntimeRoots.length < 16) {
      // Match the resolver's public selector syntax; it still owns the actual trust checks.
      if (path.normalize(value) !== value || path.resolve(value) !== value || value.includes(',')) invalid();
      preparedRuntimeRoots.push(value);
    } else invalid();
  }
  const key = (root: string) => process.platform === 'win32' ? root.toLowerCase() : root;
  if (new Set(preparedRuntimeRoots.map(key)).size !== preparedRuntimeRoots.length) invalid();
  for (const a of preparedRuntimeRoots) for (const b of preparedRuntimeRoots)
    if (a !== b && key(b).startsWith(key(a).replace(/[\\/]$/, '') + path.sep)) invalid();
  return Object.freeze({ runtimeConfigPath, preparedRuntimeRoots: Object.freeze(preparedRuntimeRoots),
    ...(languageReceiptPath === undefined ? {} : { languageReceiptPath }) });
}
export interface RuntimeStartup {
  readonly arguments: RuntimeStartupArguments;
  readonly configuration: RuntimeConfiguration;
  readonly prepared: PreparedRuntimeResolver;
  readonly core: RuntimeWorkspace | null;
  readonly rootSource: 'EXPLICIT' | 'ENVIRONMENT' | 'CONFIGURATION' | 'UNBOUND';
  /** Never deletes workspace drafts, snapshots or durable history. */
  close(): void;
}
/** Existing transport error envelope; no nullable SessionBundle or fictitious bootstrap. */
export function requireRuntimeWorkspace(startup: RuntimeStartup): RuntimeWorkspace {
  if (startup.core === null) throw new AppError(409, 'PROJECT_OPEN_REQUIRED', 'No project is open. Explicitly select an existing project with /api/project/open; repair runtime configuration separately. No workspace has been inferred or created.');
  return startup.core;
}
/**
 * Actual accepted loader + prepared consumer + canonical Workspace/WriteGate/settings authority.
 * Caller supplies the approved credential-free transport. Construction does not call it, create
 * containers, infer readiness or invent V2 settings. A failed runtime does not prevent editing.
 */
export async function createRuntimeStartup(options: {
  argv: readonly string[];
  transport: Pick<DockerTransport, 'run'>;
  environment?: RuntimeEnvironment;
  explicitWorkspaceRoot?: string;
  /** Product cold start exposes an empty shell even if config/env mentions an exercise. */
  empty?: boolean;
  /** Only exact canonical project .paircoach is accepted; never another authority. */
  dataDir?: string;
}): Promise<RuntimeStartup> {
  const args = parseRuntimeStartupArguments(options.argv);
  // Snapshot only the two config inputs; secrets/process environment are never forwarded to Docker.
  const source = options.environment ?? process.env;
  const environment: RuntimeEnvironment = Object.freeze({
    PAIRCOACH_RUNTIME_PROFILE: source.PAIRCOACH_RUNTIME_PROFILE,
    PAIRCOACH_WORKSPACE_DIR: source.PAIRCOACH_WORKSPACE_DIR,
  });
  const explicitWorkspaceRoot = options.explicitWorkspaceRoot;
  if (explicitWorkspaceRoot !== undefined && (!validPath(explicitWorkspaceRoot) || !path.isAbsolute(explicitWorkspaceRoot))) invalid();
  const configuration = loadRuntimeConfiguration({ configPath: args.runtimeConfigPath, environment, explicitWorkspaceRoot });
  const prepared = createPreparedRuntimeResolver({ outputRoots: args.preparedRuntimeRoots }, options.transport);
  const rootSource = explicitWorkspaceRoot !== undefined ? 'EXPLICIT' :
    validPath(environment.PAIRCOACH_WORKSPACE_DIR) ? 'ENVIRONMENT' : configuration.resolved || configuration.local ? 'CONFIGURATION' : 'UNBOUND';
  let rootPath: string | null;
  if (configuration.resolved) rootPath = configuration.resolved.workspaceRoot;
  else if (configuration.local) rootPath = configuration.local.workspaceRoot;
  else if (explicitWorkspaceRoot !== undefined) rootPath = explicitWorkspaceRoot;
  else if (validPath(environment.PAIRCOACH_WORKSPACE_DIR))
    rootPath = path.resolve(path.dirname(args.runtimeConfigPath), environment.PAIRCOACH_WORKSPACE_DIR);
  // No trusted project path. HTTP may remain available for explicit project/open, but MUST NOT
  // publish a fake session/bootstrap or select/create another project (including a temp one).
  else rootPath = null;
  // Unsafe explicit/env/config project paths refuse, never silently substitute another project.
  const core = options.empty || rootPath === null ? null : await createRuntimeWorkspace({ rootPath, dataDir:options.dataDir });
  return Object.freeze({ arguments: args, configuration, prepared, core, rootSource, close: () => core?.close() });
}
