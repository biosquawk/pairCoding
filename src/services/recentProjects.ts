import type {DurableProject} from '../shared/durable-project';

export const RECENT_PROJECTS_KEY = 'paircoach:recent-projects:v1';
export const RECENT_PROJECTS_LIMIT = 10;
export type RecentProject = Pick<DurableProject, 'name' | 'projectFile'>;

/** Discovery hints only. The server still validates and authorizes every open. */
export function parseRecentProjects(serialized: string | null): RecentProject[] {
  try {
    if (!serialized || serialized.length > 65536) return [];
    const value: unknown = JSON.parse(serialized);
    if (!Array.isArray(value)) return [];
    const result: RecentProject[] = [];
    const paths = new Set<string>();
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' ||
        !entry.name.trim() || entry.name.length > 200 || /[\x00-\x1f]/.test(entry.name) ||
        typeof entry.projectFile !== 'string' || entry.projectFile.length > 4096 ||
        !entry.projectFile.endsWith('.paircoding.json') || /[\x00-\x1f]/.test(entry.projectFile) ||
        paths.has(entry.projectFile)) continue;
      paths.add(entry.projectFile);
      result.push({name: entry.name, projectFile: entry.projectFile});
      if (result.length === RECENT_PROJECTS_LIMIT) break;
    }
    return result;
  } catch {return [];}
}

export function rememberProject(entries: RecentProject[], project: RecentProject): RecentProject[] {
  const entry={name:project.name,projectFile:project.projectFile};
  return parseRecentProjects(JSON.stringify([entry, ...entries.filter(p => p.projectFile !== project.projectFile)]));
}
