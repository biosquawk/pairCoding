/** A training project is independent of any exercise's runtime ProjectV2. */
export type Locale = 'pl' | 'en';
export interface ProjectEditorView {
  selection: {startLineNumber:number;startColumn:number;endLineNumber:number;endColumn:number};
  position: {lineNumber:number;column:number};
  scrollTop:number;
  scrollLeft:number;
}
export interface ProjectWorkspace {
  editorViews?: Record<string,ProjectEditorView>;
  sidebarTab?: 'files'|'task'|'chat'|'environment';
  bottomTab?: 'console'|'report';
  openTabs: string[];
  activePath: string | null;
}
export interface DurableProject {
  id: string;
  name: string;
  directory: string;
  projectFile: string;
  exercisePath: string | null;
  workspace: ProjectWorkspace;
  locale: Locale;
  sprint?: import("./sprint").SprintState;
}
export interface DurableProjectState {
  durableProject: DurableProject | null;
  locale: Locale;
  projectError: string | null;
}
export const isLocale = (value: unknown): value is Locale => value === 'pl' || value === 'en';
export function validProjectWorkspace(value: unknown): value is ProjectWorkspace {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as ProjectWorkspace;
  const safe = (p: unknown): p is string => typeof p === 'string' && p.length > 0 && p.length <= 1024 &&
    !/[\\:\x00-\x1f<>"|?*]/.test(p) && !p.startsWith('/') && p.split('/').every(s => s && s !== '.' && s !== '..' && !/[. ]$/.test(s) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s) && !/^\.pair(?:coding|coach)$/i.test(s) && !s.toLowerCase().endsWith('.paircoding.json'));
  const views=v.editorViews;
  const coords=(o:unknown,keys:string[]):boolean=>!!o && typeof o==='object' && !Array.isArray(o) && Object.keys(o).length===keys.length && keys.every(k=>Object.hasOwn(o,k)&&Number.isSafeInteger((o as Record<string,unknown>)[k])&&Number((o as Record<string,unknown>)[k])>0&&Number((o as Record<string,unknown>)[k])<=1e8);
  const validView=(view:ProjectEditorView):boolean=>!!view && typeof view==='object' && !Array.isArray(view) && Object.keys(view).length===4 &&
    Object.keys(view).every(k=>['selection','position','scrollTop','scrollLeft'].includes(k)) &&
    coords(view.position,['lineNumber','column']) && coords(view.selection,['startLineNumber','startColumn','endLineNumber','endColumn']) &&
    (view.selection.startLineNumber<view.selection.endLineNumber || view.selection.startLineNumber===view.selection.endLineNumber && view.selection.startColumn<=view.selection.endColumn) &&
    Number.isFinite(view.scrollTop) && view.scrollTop>=0 && view.scrollTop<=1e8 && Number.isFinite(view.scrollLeft) && view.scrollLeft>=0 && view.scrollLeft<=1e8;
  if(views!==undefined && (!views || typeof views!=='object' || Array.isArray(views) || Object.keys(views).length>100 || !Array.isArray(v.openTabs) ||
    Object.entries(views).some(([key,view])=>!safe(key)||!v.openTabs.includes(key)||!validView(view))))return false;
  return Object.keys(v).every(k => ['openTabs', 'activePath','sidebarTab','bottomTab','editorViews'].includes(k)) &&
    (v.sidebarTab===undefined || ['files','task','chat','environment'].includes(v.sidebarTab)) &&
    (v.bottomTab===undefined || ['console','report'].includes(v.bottomTab)) && Array.isArray(v.openTabs) && v.openTabs.length <= 100 && v.openTabs.every(safe) &&
    new Set(v.openTabs).size === v.openTabs.length && (v.activePath === null || safe(v.activePath) && v.openTabs.includes(v.activePath));
}
