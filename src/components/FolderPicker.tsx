import React,{useEffect,useRef,useState} from 'react';
import type {FolderListing} from '../shared/folders';

interface Props {
  list: (path?:string,signal?:AbortSignal)=>Promise<FolderListing>;
  open: (path:string)=>Promise<boolean>;
  blocked: string|null;
  onClose: ()=>void;
}

export function FolderPicker({list,open,blocked,onClose}:Props) {
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
  async function choose() {
    if(!folder||loading||openingRef.current||blocked)return;
    openingRef.current=true;setOpening(true);setError('');
    try {
      if(await open(folder.path)){if(alive.current)onClose();}
      else if(alive.current)setError('Nie otwarto folderu. Bieżące zadanie i draft zachowano; sprawdź komunikat połączenia.');
    } catch(e) {if(alive.current)setError(e instanceof Error?e.message:String(e));}
    finally {openingRef.current=false;if(alive.current)setOpening(false);}
  }
  return <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="folder-picker-title" aria-busy={opening} tabIndex={-1}
      className="bg-zinc-900 border border-zinc-600 rounded-lg p-4 w-full max-w-2xl max-h-[85dvh] flex flex-col gap-3 text-zinc-100"
      onKeyDown={event=>{
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}
        if(event.key==='Tab') {
          const controls=Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]);
          const first=controls[0],last=controls.at(-1);
          if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
          else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
        }
      }}>
      <h2 id="folder-picker-title" className="font-semibold">Otwórz folder zadania</h2>
      <p className="text-xs text-zinc-400">Wybierz istniejący folder dostępny dla backendu PairCoach. Zmiana folderu nie zmienia profilu języka ani JDK.</p>
      <p className="break-all text-sm" aria-label="Bieżący folder">{folder?.path??'Odczytywanie folderów…'}</p>
      <button type="button" className="border rounded px-3 py-1 self-start disabled:opacity-50" disabled={loading||opening||!folder?.parent}
        onClick={()=>void browse(folder!.parent!)}>Poziom wyżej</button>
      <div className="overflow-y-auto min-h-24 border border-zinc-700 rounded" aria-label="Podfoldery" aria-busy={loading}>
        {loading?<p className="p-2">Odczytywanie…</p>:folder?.directories.length?folder.directories.map(child=>
          <button type="button" key={child.path} disabled={opening} className="block w-full text-left px-3 py-2 hover:bg-zinc-800 break-all"
            aria-label={'Przejdź do folderu '+child.name} onClick={()=>void browse(child.path)}>📁 {child.name}</button>):<p className="p-2 text-zinc-400">Brak podfolderów.</p>}
      </div>
      {(error||blocked)&&<p role="alert" className="text-amber-300 text-sm">{error||blocked}</p>}
      <div className="flex justify-end gap-3">
        <button type="button" onClick={close} disabled={opening} className="border rounded px-3 py-2">Anuluj</button>
        <button type="button" onClick={()=>void choose()} disabled={!folder||loading||opening||!!blocked} className="bg-blue-700 rounded px-3 py-2 disabled:opacity-50">
          {opening?'Otwieranie…':'Otwórz ten folder'}</button>
      </div>
    </div>
  </div>;
}
