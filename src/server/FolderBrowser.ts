import fs from 'node:fs/promises';
import path from 'node:path';
import type {FolderListing} from '../shared/folders';
import {TransportError} from './transport';

/** List one explicitly selected directory. Never recurse or create a workspace. */
export async function listFolders(directory: string): Promise<FolderListing> {
  if(!directory || directory.length>4096 || directory.includes('\0') || !path.isAbsolute(directory))
    throw new TransportError(400,'INVALID_FOLDER','Wybierz bezwzględną ścieżkę folderu dostępną dla backendu.');
  const selected=path.resolve(directory);
  try {
    const stat=await fs.lstat(selected);
    if(stat.isSymbolicLink() || !stat.isDirectory())
      throw new TransportError(403,'UNSAFE_ROOT','Wybierz rzeczywisty folder, nie dowiązanie ani plik.');
    const canonical=await fs.realpath(selected);
    const entries=await fs.readdir(canonical,{withFileTypes:true});
    const after=await fs.lstat(selected);
    if(after.isSymbolicLink() || after.dev!==stat.dev || after.ino!==stat.ino || await fs.realpath(selected)!==canonical)
      throw new TransportError(409,'FOLDER_CHANGED','Folder zmienił się podczas odczytu. Wybierz go ponownie.');
    const parent=path.dirname(canonical);
    return {path:canonical,parent:parent===canonical?null:parent,
      directories:entries.filter(entry=>entry.isDirectory()&&!entry.isSymbolicLink())
        .sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)
        .map(entry=>({name:entry.name,path:path.join(canonical,entry.name)}))};
  } catch(error) {
    if(error instanceof TransportError)throw error;
    throw new TransportError(400,'FOLDER_UNAVAILABLE','Nie można odczytać tego folderu na komputerze backendu. Bieżące zadanie pozostaje otwarte.');
  }
}
