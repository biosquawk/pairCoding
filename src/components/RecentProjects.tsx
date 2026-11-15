import React from 'react';
import {t} from '../i18n';
import type {RecentProject} from '../services/recentProjects';

interface Props {
  projects: RecentProject[];
  disabled: boolean;
  onOpen: (projectFile: string) => void;
  onRemove: (projectFile: string) => void;
  storageUnavailable: boolean;
}

export function RecentProjects({projects, disabled, onOpen, onRemove, storageUnavailable}: Props) {
  return <section aria-label={t('Ostatnio otwierane projekty')} className="basis-full w-full min-w-0 space-y-1">
    <h3 className="font-semibold">{t('Ostatnio otwierane projekty')}</h3>
    {projects.length ? <ul className="max-h-48 overflow-y-auto space-y-1">
      {projects.map(project => <li key={project.projectFile} className="flex min-w-0 items-start gap-1">
        <button type="button" disabled={disabled} title={project.projectFile}
          aria-label={t('Otwórz ostatni projekt: {0}', {0: project.name})}
          className="min-w-0 flex-1 rounded border border-zinc-700 px-2 py-1 text-left hover:bg-zinc-800 disabled:opacity-50"
          onClick={() => onOpen(project.projectFile)}>
          <span className="block font-medium break-words">{project.name}</span>
          <span className="block text-[10px] text-zinc-400 [overflow-wrap:anywhere]">{project.projectFile}</span>
        </button>
        <button type="button" disabled={disabled} className="shrink-0 px-1 py-1 text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
          title={t('Usuń z ostatnich')} aria-label={t('Usuń z ostatnich: {0}', {0: project.name})}
          onClick={() => onRemove(project.projectFile)}>×</button>
      </li>)}
    </ul> : <p className="text-zinc-400">{t('Otwórz projekt raz, aby pojawił się tutaj.')}</p>}
    {storageUnavailable && <p role="status" className="text-amber-300">{t('Nie można zapamiętać ostatnich projektów w przeglądarce. Lista jest dostępna do zamknięcia strony.')}</p>}
  </section>;
}
