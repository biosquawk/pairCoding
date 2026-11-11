import { lstatSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
/** Export standard Surefire XML only AFTER Maven exit, before dispatcher/container terminal exit.
 * Fresh build starts without target; never search the original or old/cache reports. */
export function exportMavenReports(taskDirectory,artifactsDirectory) {
  const source=path.join(taskDirectory,'target','surefire-reports');
  let dir;
  try {dir=lstatSync(source);} catch(error) {if(error.code==='ENOENT')return 0;throw error;}
  if(!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('Unsafe Surefire report directory');
  const names=readdirSync(source).filter(n=>/^TEST-[^/\\]+\.xml$/.test(n)).sort();
  if(names.length>64) throw new Error('Too many Surefire reports');
  let total=0;
  const reports=names.map(name=>{
    const file=path.join(source,name),st=lstatSync(file);
    if(!st.isFile() || st.isSymbolicLink() || st.size>4*1024*1024 || (total+=st.size)>16*1024*1024) throw new Error('Unsafe/oversized Surefire report');
    const bytes=readFileSync(file);
    if(bytes.length!==st.size)throw new Error('Report changed after exit');
    return {name,bytes};
  });
  if(reports.length) {
    const out=path.join(artifactsDirectory,'junit');mkdirSync(out,{recursive:true});
    for(const r of reports)writeFileSync(path.join(out,r.name),r.bytes,{flag:'wx'});
  }
  return reports.length;
}
