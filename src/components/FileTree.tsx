import { t, problemText, stateText } from '../i18n';
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { ProjectFile, TaskMode } from '../types/paircoach';
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Code,
  Edit2,
  FileCode,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreVertical,
  Settings,
  Trash2,
  X,
} from 'lucide-react';

interface FileTreeProps {
  footer?: React.ReactNode;
  details?: React.ReactNode;
  files: ProjectFile[];
  activePath: string;
  taskFilePath: string;
  reviewNotesPath: string;
  taskMode: TaskMode;
  onSelectFile: (path: string) => void;
  onCreateFile: (path: string) => void;
  onRenameFile: (oldPath: string, newPath: string) => void;
  onDeleteFile: (path: string) => void;
  onOpenSettings: () => void;
}

interface TreeNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  file?: ProjectFile;
  children: TreeNode[];
}

export const FileTree: React.FC<FileTreeProps> = ({
  footer,
  details,
  files,
  activePath,
  taskFilePath,
  reviewNotesPath,
  taskMode,
  onSelectFile,
  onCreateFile,
  onRenameFile,
  onDeleteFile,
  onOpenSettings,
}) => {
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const [isCreatingFile, setIsCreatingFile] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editingNewName, setEditingNewName] = useState('');
  const [deletingPath, setDeletingPath] = useState<string | null>(null);

  // Build tree from file paths
  const buildTree = (): TreeNode => {
    const root: TreeNode = { name: 'root', fullPath: '', isDir: true, children: [] };

    for (const f of files) {
      const parts = f.path.split('/');
      let current = root;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isLast = i === parts.length - 1;
        const currentPath = parts.slice(0, i + 1).join('/');

        let found = current.children.find((c) => c.name === part);
        if (!found) {
          found = {
            name: part,
            fullPath: currentPath,
            isDir: !isLast || f.kind === 'DIRECTORY',
            file: isLast ? f : undefined,
            children: [],
          };
          current.children.push(found);
        }
        current = found;
      }
    }

    // Sort: directories first, then alphabetical
    const sortNodes = (node: TreeNode) => {
      node.children.sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return a.name.localeCompare(b.name);
      });
      node.children.forEach(sortNodes);
    };
    sortNodes(root);

    return root;
  };

  const toggleDir = (dirPath: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFilePath.trim()) return;
    try {
      onCreateFile(newFilePath.trim());
      setNewFilePath('');
      setIsCreatingFile(false);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleRenameSubmit = (oldPath: string) => {
    if (!editingNewName.trim() || editingNewName === oldPath) {
      setEditingPath(null);
      return;
    }
    onRenameFile(oldPath, editingNewName.trim());
    setEditingPath(null);
  };

  const handleDeleteConfirm = () => {
    if (deletingPath) {
      onDeleteFile(deletingPath);
      setDeletingPath(null);
    }
  };

  const getFileIcon = (path: string) => {
    if (path === taskFilePath) return <BookOpen className="w-3.5 h-3.5 text-blue-400" />;
    if (path === reviewNotesPath) return <FileText className="w-3.5 h-3.5 text-amber-400" />;
    if (path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.js'))
      return <FileCode className="w-3.5 h-3.5 text-cyan-400" />;
    if (path.endsWith('.py')) return <Code className="w-3.5 h-3.5 text-yellow-400" />;
    if (path.endsWith('.json')) return <FileText className="w-3.5 h-3.5 text-emerald-400" />;
    if (path.endsWith('.md')) return <BookOpen className="w-3.5 h-3.5 text-purple-400" />;
    return <FileText className="w-3.5 h-3.5 text-zinc-400" />;
  };

  const treeRoot = buildTree();

  const renderNode = (node: TreeNode, depth: number) => {
    if (node.isDir) {
      const isCollapsed = collapsedDirs.has(node.fullPath);
      return (
        <div key={node.fullPath}>
          <div
            role="button" tabIndex={0} aria-expanded={!isCollapsed} aria-label={t("Folder {0}",{0:node.fullPath})}
            onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggleDir(node.fullPath); } }}
            onClick={() => toggleDir(node.fullPath)}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
            className="h-7 flex items-center gap-1.5 py-1 px-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 cursor-pointer select-none rounded"
          >
            {isCollapsed ? <ChevronRight className="w-3 h-3 text-zinc-500" /> : <ChevronDown className="w-3 h-3 text-zinc-500" />}
            {isCollapsed ? <Folder className="w-3.5 h-3.5 text-amber-400/80" /> : <FolderOpen className="w-3.5 h-3.5 text-amber-400" />}
            <span className="truncate">{node.name}</span>
          </div>
          {!isCollapsed && (
            <div>{node.children.map((child) => renderNode(child, depth + 1))}</div>
          )}
        </div>
      );
    }

    const isActive = node.fullPath === activePath;
    const isEditing = editingPath === node.fullPath;
    const isSpecialTask = node.fullPath === taskFilePath;
    const isSpecialNotes = node.fullPath === reviewNotesPath;

    return (
      <div
        key={node.fullPath}
        role="button" tabIndex={0} aria-label={t("Otwórz plik {0}",{0: node.fullPath})} aria-pressed={isActive}
        onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); if (!isEditing) onSelectFile(node.fullPath); } }}
        style={{ paddingLeft: `${depth * 12 + 10}px` }}
        className={`group h-7 flex items-center justify-between py-1 px-2 text-xs cursor-pointer select-none rounded transition-colors ${
          isActive
            ? 'bg-zinc-800 text-zinc-100 font-semibold border-l-2 border-blue-500'
            : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/70'
        }`}
        onClick={() => !isEditing && onSelectFile(node.fullPath)}
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {getFileIcon(node.fullPath)}
          {isEditing ? (
            <input
              type="text"
              value={editingNewName}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setEditingNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameSubmit(node.fullPath);
                if (e.key === 'Escape') setEditingPath(null);
              }}
              onBlur={() => handleRenameSubmit(node.fullPath)}
              className="bg-zinc-950 border border-blue-500 text-xs px-1 py-0.5 rounded text-zinc-100 w-full"
            />
          ) : (
            <span className="truncate">{node.name}</span>
          )}
        </div>

        {/* Special File Badges */}
        <div className="flex items-center gap-1 ml-1 opacity-80 group-hover:opacity-100">
          {isSpecialTask && (
            <span className="text-[9px] px-1 py-0.2 rounded bg-blue-950 text-blue-300 border border-blue-800">
              {t("Zadanie")}{' '}</span>
          )}
          {isSpecialNotes && (
            <span className="text-[9px] px-1 py-0.2 rounded bg-amber-950 text-amber-300 border border-amber-800">
              {t("Notatki")}{' '}</span>
          )}

          {/* Quick Actions (Rename / Delete) */}
          {!isSpecialTask && !isSpecialNotes && !isEditing && (
            <div className="flex shrink-0 invisible group-hover:visible group-focus-within:visible items-center gap-0.5">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingPath(node.fullPath);
                  setEditingNewName(node.fullPath);
                }}
                title={t("Zmień nazwę pliku")}
                className="p-1 hover:text-zinc-200 text-zinc-500 hover:bg-zinc-800 rounded"
              >
                <Edit2 className="w-2.5 h-2.5" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setDeletingPath(node.fullPath);
                }}
                title={t("Usuń plik")}
                className="p-1 hover:text-red-400 text-zinc-500 hover:bg-zinc-800 rounded"
              >
                <Trash2 className="w-2.5 h-2.5" />
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div aria-label={t("Pliki projektu i stan")} className="h-full min-h-0 min-w-0 flex flex-col bg-zinc-950 border-r border-zinc-800 text-zinc-300 select-none">
      {/* File Tree Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 bg-zinc-950">
        <span className="text-xs font-bold uppercase tracking-wider text-zinc-400">{t("Pliki Projektu")}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setIsCreatingFile(!isCreatingFile)}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
            title={t("Utwórz nowy plik (np. src/helper.ts)")}
          >
            <FilePlus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onOpenSettings}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
            title={t("Ustawienia projektu (AI Consent, Task Mode, Profile)")}
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* New File Inline Form */}
      {isCreatingFile && (
        <form onSubmit={handleCreateSubmit} className="p-2 border-b border-zinc-800 bg-zinc-900/60">
          <div className="text-[11px] text-zinc-400 mb-1">{t("Nowy plik (np.")}{' '}<code>src/utils.ts</code>):</div>
          <div className="flex items-center gap-1">
            <input
              type="text"
              autoFocus
              value={newFilePath}
              onChange={(e) => setNewFilePath(e.target.value)}
              placeholder={t("ścieżka/nazwa_pliku.ext")}
              className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 flex-1 focus:border-blue-500 focus:outline-none"
            />
            <button
              type="submit"
              className="p-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs"
              title={t("Utwórz")}
            >
              <Check className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setIsCreatingFile(false)}
              className="p-1 hover:bg-zinc-800 text-zinc-400 rounded text-xs"
              title={t("Anuluj")}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </form>
      )}

      {/* Tree Content */}
      <div className={`min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] py-1 px-1 ${details ? 'hidden' : ''}`}>
        {treeRoot.children.map((child) => renderNode(child, 0))}
      </div>
      {details && <div role="region" aria-label={t("Szczegóły środowiska")} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2 [overflow-wrap:anywhere]">{details}</div>}

      {/* Delete Confirmation Modal */}
      {deletingPath && (
        <div className="p-3 bg-red-950/60 border-t border-red-900/80 text-xs text-red-200">
          <p className="font-semibold mb-1">{t("Czy na pewno usunąć plik?")}</p>
          <p className="text-[11px] text-zinc-400 mb-2 truncate">{deletingPath}</p>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDeleteConfirm}
              className="px-2 py-1 rounded bg-red-600 hover:bg-red-500 text-white font-medium text-xs"
            >
              {t("Usuń trwale")}{' '}</button>
            <button
              onClick={() => setDeletingPath(null)}
              className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs"
            >
              {t("Anuluj")}{' '}</button>
          </div>
        </div>
      )}

      {footer && <div className="shrink-0 min-w-0 max-h-[45%] overflow-y-auto overflow-x-hidden border-t border-zinc-800 bg-zinc-900/60 p-2 [overflow-wrap:anywhere]">{footer}</div>}
      {/* Footer Info */}
      <div className="p-2 border-t border-zinc-900 bg-zinc-950/80 text-[10px] text-zinc-500 flex justify-between items-center">
        <span>{files.length} {' '}{t("plików")}</span>
        <span className="font-mono">{taskMode}</span>
      </div>
    </div>
  );
};
