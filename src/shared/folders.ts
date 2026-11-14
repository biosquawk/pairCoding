/** Native paths of the backend host; no browser upload or workspace copy. */
export interface FolderListing {
  path: string;
  parent: string | null;
  projectFiles?: {name:string;path:string}[];
  directories: {name: string; path: string}[];
}
