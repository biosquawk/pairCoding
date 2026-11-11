/** Credential-free application-owned Docker CLI composition. No PATH lookup or task executable. */
import fs from 'node:fs';
import path from 'node:path';
import { DockerCliTransport, type DockerTransport } from '../execution/DockerTransport';
import { AppError } from '../errors';
import { canonicalDirectory, privateDirectory } from './storage';
export function createRuntimeDockerTransport(options: {
  stateDirectory: string;
  /** Trusted dependency override only, never wire/task/environment configuration. */
  executable?: string;
}): DockerTransport {
  const executable = options.executable ?? (process.platform === 'win32' ?
    'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe' : '/usr/bin/docker');
  if (!path.isAbsolute(executable) || /[\x00-\x1f\x7f]/.test(executable))
    throw new AppError(400, 'INVALID_DOCKER_EXECUTABLE', 'Use the fixed platform Docker executable or a trusted absolute programmatic dependency.');
  canonicalDirectory(options.stateDirectory);
  const config = path.join(options.stateDirectory, 'docker-config'); privateDirectory(config);
  if (fs.readdirSync(config).length !== 0) throw new AppError(503, 'DOCKER_CLIENT_CONFIG_DIRTY', 'Owned Docker client configuration must remain credential-free and empty; preserve unexpected files for scoped recovery.');
  // No credentials are loaded; an unexpected file is a refusal, never deleted or ignored.
  const environment: Record<string, string> = { DOCKER_HOST: process.platform === 'win32' ?
    'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock', DOCKER_CONFIG: config };
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !path.isAbsolute(systemRoot)) throw new AppError(503, 'DOCKER_CLI_UNAVAILABLE', 'Trusted Windows SystemRoot is unavailable.');
    environment.SystemRoot = systemRoot;
  }
  return {
    async run(args, bounds) {
      try {
        // Known platform installer symlink may resolve to the actual executable. Never use a
        // workspace alias, env override, cwd search, shell or a host language/toolchain fallback.
        const resolved = fs.realpathSync.native(executable);
        canonicalDirectory(path.dirname(resolved));
        const stat = fs.lstatSync(resolved, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o111n) === 0n)) throw Error('Not an executable');
        return await new DockerCliTransport(resolved, Object.freeze({ ...environment })).run(args, bounds);
      } catch {
        // Do not expose token-bearing paths/CLI stderr; never infer a failed mutation had no effect.
        throw new AppError(503, 'DOCKER_CLI_UNAVAILABLE', 'Configured local Docker CLI/daemon or owned empty client configuration is unavailable. Preserve retained Run ownership and retry the same Run only.');
      }
    },
  };
}
