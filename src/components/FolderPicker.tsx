import { t, problemText } from '../i18n';
import React,{useEffect,useRef,useState} from 'react';
import type {FolderListing} from '../shared/folders';

interface Props {
  mode?: 'exercise'|'create'|'project';
  create?: (directory:string,name:string)=>Promise<boolean>;
  list: (path?:string,signal?:AbortSignal)=>Promise<FolderListing>;
  open: (path:string)=>Promise<boolean>;
  blocked: string|null;
  actionError?:string;
  onClose: ()=>void;
}

export function FolderPicker({list,open,blocked,onClose,mode='exercise',create,actionError}:Props) {
  const [name,setName]=useState(t('Mój projekt'));
  const [folder,setFolder]=useState<FolderListing|null>(null);
  const [loading,setLoading]=useState(true),[opening,setOpening]=useState(false),[error,setError]=useState('');
  const dialog=useRef<HTMLDivElement>(null),request=useRef<AbortController|null>(null),alive=useRef(true);
  const openingRef=useRef(false);
  async function browse(path?:string) {
    request.current?.abort();const controller=new AbortController();request.current=controller;
    setLoading(true);setError('');
    try {const next=await list(path,controller.signal);if(alive.current&&!controller.signal.aborted)setFolder(next);}
    catch(e) {if(alive.current&&!controller.signal.aborted)setError(e instanceof Error?e.message:String(e));}
    finally {if(alive.current&&!controller.signal.aborted)setLoading(false);}
  }
  useEffect(()=>{
    alive.current=true;void browse();const previous=document.activeElement as HTMLElement|null;
    dialog.current?.focus();
    return ()=>{alive.current=false;request.current?.abort();previous?.focus();};
  },[]);
  function close() {if(!openingRef.current)onClose();}
  async function choose(projectFile?:string) {
    if(!folder||loading||openingRef.current||blocked)return;
    openingRef.current=true;setOpening(true);setError('');
    try {
      if(await (mode==='create'&&create?create(folder.path,name):open(projectFile??folder.path))){if(alive.current)onClose();}
      else if(alive.current)setError(t('Nie zmieniono bieżącego projektu. Sprawdź komunikat błędu.'));
    } catch(e) {if(alive.current)setError(e instanceof Error?e.message:String(e));}
    finally {openingRef.current=false;if(alive.current)setOpening(false);}
  }
  return <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="folder-picker-title" aria-busy={opening} tabIndex={-1}
      className="bg-zinc-900 border border-zinc-600 rounded-lg p-4 w-full max-w-2xl max-h-[85dvh] flex flex-col gap-3 text-zinc-100"
      onKeyDown={event=>{
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}
        if(event.key==='Tab') {
          const controls=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')??[]);
          const first=controls[0],last=controls.at(-1);
          if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
          else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
        }
      }}>
      <h2 id="folder-picker-title" className="font-semibold">{t(mode==='create'?'Wybierz katalog projektu':mode==='project'?'Wybierz plik projektu':'Otwórz folder zadania')}</h2>
      <p className="text-xs text-zinc-400">{t(mode==='create'?'Utwórz projekt w wybranym folderze. Ćwiczenie wybierzesz osobno.':mode==='project'?'Wybierz istniejący plik .paircoding.json dostępny dla backendu.':'Wybierz istniejący folder dostępny dla backendu PairCoach. Zmiana folderu nie zmienia profilu języka ani JDK.')}</p>
      <p className="break-all text-sm" aria-label={t("Bieżący folder")}>{folder?.path??t("Odczytywanie folderów…")}</p>
      <button type="button" className="border rounded px-3 py-1 self-start disabled:opacity-50" disabled={loading||opening||!folder?.parent}
        onClick={()=>void browse(folder!.parent!)}>{t("Poziom wyżej")}</button>
      <div className="overflow-y-auto min-h-24 border border-zinc-700 rounded" aria-label={t("Podfoldery")} aria-busy={loading}>
        {loading?<p className="p-2">{t("Odczytywanie…")}</p>:folder?.directories.length?folder.directories.map(child=>
          <button type="button" key={child.path} disabled={opening} className="block w-full text-left px-3 py-2 hover:bg-zinc-800 break-all"
            aria-label={t("Przejdź do folderu ")+child.name} onClick={()=>void browse(child.path)}>📁 {child.name}</button>):<p className="p-2 text-zinc-400">{t("Brak podfolderów.")}</p>}
      </div>
      {mode==='create' && <label className="text-sm">{t('Nazwa projektu')}<input className="block w-full bg-zinc-950 border border-zinc-700 rounded p-2" value={name} disabled={opening} maxLength={100} onChange={event=>setName(event.target.value)}/></label>}
      {mode==='project' && <div className="overflow-y-auto min-h-16 border border-zinc-700 rounded" aria-label={t('Plik projektu')}>
        {(folder as (FolderListing&{projectFiles?:{name:string;path:string}[]})|null)?.projectFiles?.length
          ? (folder as FolderListing&{projectFiles:{name:string;path:string}[]}).projectFiles.map(file=><button type="button" key={file.path} disabled={loading||opening||!!blocked}
            className="block w-full text-left px-3 py-2 hover:bg-zinc-800 break-all" onClick={()=>void choose(file.path)}>📄 {file.name}</button>)
          : <p className="p-2 text-zinc-400 text-xs">{t('Brak plików projektu w tym folderze.')}</p>}
      </div>}
      {(actionError||error||blocked)&&<p role="alert" className="text-amber-300 text-sm">{problemText(actionError||error||blocked)}</p>}
      <div className="flex justify-end gap-3">
        <button type="button" onClick={close} disabled={opening} className="border rounded px-3 py-2">{t("Anuluj")}</button>
        {mode!=='project' && <button type="button" onClick={()=>void choose()} disabled={!folder||loading||opening||!!blocked||(mode==='create'&&!name.trim())} className="bg-blue-700 rounded px-3 py-2 disabled:opacity-50">
          {opening?t('Otwieranie…'):mode==='create'?t('Utwórz projekt'):t('Otwórz ten folder')}</button>}
      </div>
    </div>
  </div>;
}
