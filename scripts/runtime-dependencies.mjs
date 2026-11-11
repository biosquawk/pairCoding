import { createHash } from 'node:crypto';
/** Complete project dependency/config identity, NOT source bytes. Ordinary edits must reuse prepared dependencies.
 * Source inventory is separately immutable per run. Hash sorted POSIX path+content SHA256 pairs.
 */
export function dependencyHash(files) {
  if(!Array.isArray(files) || files.length>20000 || files.some(f=>typeof f.path!=='string' || !/^[a-f0-9]{64}$/.test(f.sha256))) throw new Error('Invalid dependency inventory');
  const relevant=files.filter(f=>/(?:^|\/)(?:pom\.xml|package\.json|package-lock\.json|npm-shrinkwrap\.json|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|tsconfig[^/]*\.json)$/.test(f.path) || /(?:^|\/)\.mvn\//.test(f.path)).map(({path,sha256})=>({path,sha256})).sort((a,b)=>a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return createHash('sha256').update(JSON.stringify(relevant)).digest('hex');
}
