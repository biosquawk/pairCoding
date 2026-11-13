import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  AcknowledgedRunInput, InputFile
} from './ports';
import {
  canonicalDirectory, durableWrite, inside, readRegular, requireThat, safeId, safeProfileId, safeRelative, sha256, fsyncDirectory, canonicalJson
} from './files';
export interface SettledAcknowledgement {
  projectId: string;
  sessionId: string;
  workspaceVersion: number;
  /** Complete included inventory from the serialized WriteGate ACK ledger, not client metadata. */
  files: readonly InputFile[];
  /** Caller retains WriteGate serialization until this utility returns; check at both fences. */
  assertCurrent(): Promise<void>;
}
export interface CopyInputOptions {
  workspaceDirectory: string;
  runDirectory: string;
  runId: string;
  profileId: string;
  configurationGeneration: string;
  acknowledgement: SettledAcknowledgement;
  /** Deterministic testing/observability hook, never an authority. */
  afterFileCopied?: (relativePath: string) => Promise<void>;
}
export const INPUT_LIMITS = Object.freeze({
  files:4096, directories:4096, depth:32, fileBytes:4*1024*1024, totalBytes:32*1024*1024
});
const excluded = (s: string) => /^(?:TEST-.+\.xml|junit(?:[-_.].*)?\.xml)$/i.test(s) || /^(\.git|\.paircoach|\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.ssh|\.aws|\.azure|\.docker|\.config|\.kube|\.gnupg|\.credentials|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519|node_modules|target|build|dist|coverage|reports?|test-results|surefire-reports|__pycache__|\.pytest_cache|\.mypy_cache|\.venv|venv|\.m2|\.cache|\.gradle|\.idea|\.vscode)$/i.test(s) || /\.(pem|key|p12|pfx|keystore|token|password|class|pyc|junit\.xml)$/i.test(s);
interface Entry {
  path:string;
  sha256:string;
  bytes:number
}
async function inventory(root: string): Promise<Entry[]> {
  const files:Entry[]=[];
  let total=0,dirs=0;
  const casePaths=new Set<string>();
  async function visit(relative:string,depth:number) {
    requireThat(depth<=INPUT_LIMITS.depth && ++dirs<=INPUT_LIMITS.directories,'Input inventory limit');
    const dir=path.join(root,relative);
    await canonicalDirectory(dir);
    const before=await fs.lstat(dir, { bigint:true });
    requireThat(before.isDirectory()&&!before.isSymbolicLink(),'Input directory changed');
    const entries=await fs.readdir(dir);
    requireThat(entries.length<=INPUT_LIMITS.files+INPUT_LIMITS.directories,'Input directory limit');
    for(const name of entries.sort()) {
      const rel=relative?relative+'/'+name:name;
      requireThat(safeRelative(rel),'Unsafe input path');
      if(excluded(name)) continue;
      const folded=rel.toLowerCase();
      requireThat(!casePaths.has(folded),'Case-colliding input');
      casePaths.add(folded);
      const st=await fs.lstat(path.join(root,rel), { bigint:true });
      requireThat(!st.isSymbolicLink(),'Input symlink');
      if(st.isDirectory()) await visit(rel,depth+1);
      else {
        requireThat(st.isFile() && files.length<INPUT_LIMITS.files,'Input file limit/type');
        const b=await readRegular(path.join(root,rel),INPUT_LIMITS.fileBytes);
        total+=b.length;
        requireThat(total<=INPUT_LIMITS.totalBytes,'Input byte limit');
        files.push({
          path:rel,sha256:sha256(b),bytes:b.length
        });
      }
    }
    const after=await fs.lstat(dir, { bigint:true });
    requireThat(after.isDirectory() && !after.isSymbolicLink() && before.ino===after.ino && before.dev===after.dev && before.mtimeNs===after.mtimeNs && before.ctimeNs===after.ctimeNs,'Input directory changed');
    await canonicalDirectory(dir);
  }
  await visit('',0);
  return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
/** Raw disk inventory only, NOT WriteGate/ACK authority. Caller keeps the same
 * serialization through inventory + copy and joins authoritative document versions.
 * This projects the ONE existing inventory implementation; never normalize BOM/LF.
 */
export async function readRunSourceInventory(root: string): Promise<readonly Readonly<{path:string; sha256:string; bytes:number}>[]> {
  return Object.freeze((await inventory(root)).map(entry=>Object.freeze({ ...entry })));
}
export function inputManifestHash(input: Pick<AcknowledgedRunInput,'projectId'|'sessionId'|'identity'|'files'>) {
  return sha256(canonicalJson({
    projectId:input.projectId,sessionId:input.sessionId,runId:input.identity.runId,profileId:input.identity.profileId,configurationGeneration:input.identity.configurationGeneration,workspaceVersion:input.identity.workspaceVersion,files:input.files
  }));
}
/** Throws RUN_INPUT_CHANGED on any incomplete ACK, concurrent writer, link, bound or inventory discrepancy. Never publishes a partial manifest. */
export async function copyAcknowledgedInput(options: CopyInputOptions): Promise<AcknowledgedRunInput> {
  const {
    workspaceDirectory:source,runDirectory:run,acknowledgement:ack
  }
  =options;
  requireThat(safeProfileId(options.profileId) && [options.runId,options.configurationGeneration,ack.projectId,ack.sessionId].every(safeId),'Unsafe input identity');
  await canonicalDirectory(source);
  await canonicalDirectory(path.dirname(run));
  requireThat(!inside(source,run) && !inside(run,source) && source!==run,'Input/output overlap');
  const input=path.join(run,'input'),build=path.join(run,'build'),artifacts=path.join(run,'artifacts');
  await fs.mkdir(run,{
    mode:0o700
  });
  try {
    await canonicalDirectory(run);
    await ack.assertCurrent();
    requireThat(Number.isSafeInteger(ack.workspaceVersion)&&ack.workspaceVersion>=0,'Invalid ACK version');
    const expected=ack.files.map(f=>({
      ...f
    })).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    requireThat(expected.length<=INPUT_LIMITS.files && new Set(expected.map(f=>f.path)).size===expected.length && expected.every(f=>safeRelative(f.path)&&Number.isSafeInteger(f.documentVersion)&&f.documentVersion>=0&&/^[a-f0-9]{64}$/.test(f.sha256)&&Number.isSafeInteger(f.bytes)&&f.bytes>=0),'Invalid ACK manifest');
    const before=await inventory(source);
    const expectedInventory=expected.map(({
      path,sha256,bytes
    })=>({
      path,sha256,bytes
    }));
    requireThat(canonicalJson(before)===canonicalJson(expectedInventory),'Incomplete/mismatched ACK inventory');
    await fs.mkdir(input,{
      mode:0o700
    });
    await fs.mkdir(build,{
      mode:0o700
    });
    await fs.mkdir(artifacts,{
      mode:0o700
    });
    for(const f of before) {
      const bytes=await readRegular(path.join(source,f.path),INPUT_LIMITS.fileBytes);
      requireThat(sha256(bytes)===f.sha256,'Input changed during copy');
      const dest=path.join(input,f.path);
      // Create each private component only through an already checked parent.
      let parent = input;
      for (const part of f.path.split('/').slice(0, -1)) {
        await canonicalDirectory(parent);
        parent = path.join(parent, part);
        try { await fs.mkdir(parent, { mode:0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      await canonicalDirectory(parent);
      const fd=await fs.open(dest,'wx',0o444);
      try{
        await fd.writeFile(bytes);
        // open's mode is filtered by umask (077 would leave 0400). Restore the
        // intended nonowner-readable, never-writable mode on this exclusive new
        // copy's descriptor only; never chmod the source or a retained run path.
        if (process.platform !== 'win32') await fd.chmod(0o444);
        await fd.sync();
      }finally{
        await fd.close();
      }
      await options.afterFileCopied?.(f.path);
    }
    requireThat(canonicalJson(await inventory(source))===canonicalJson(before),'Input changed after copy');
    await ack.assertCurrent();
    const result:AcknowledgedRunInput={
      projectId:ack.projectId,sessionId:ack.sessionId,identity:{
        runId:options.runId,profileId:options.profileId,configurationGeneration:options.configurationGeneration,workspaceVersion:ack.workspaceVersion,manifestSha256:''
      },files:expected,immutableDirectory:input,buildDirectory:build,artifactsDirectory:artifacts
    };
    result.identity={
      ...result.identity,manifestSha256:inputManifestHash(result)
    };
    async function seal(dir:string){
      await canonicalDirectory(dir);
      for (const name of await fs.readdir(dir)) {
        const child = path.join(dir, name), st = await fs.lstat(child, { bigint:true });
        requireThat(!st.isSymbolicLink(), 'Input symlink');
        if (st.isDirectory()) await seal(child);
        else requireThat(st.isFile() && st.nlink === 1n, 'Unsafe input seal');
      }
      // Windows directory mode bits are not an immutable/ACL boundary. The independent private
      // copy, complete hash inventory and Docker RO mount are the boundary (not same-user-host).
      if (process.platform !== 'win32') await fs.chmod(dir,0o555);
      await fsyncDirectory(dir);
    }
    await seal(input);
    requireThat(canonicalJson(await inventory(input))===canonicalJson(before), 'Copied input changed');
    await durableWrite(path.join(run,'input-manifest.json'),canonicalJson(result));
    return Object.freeze({
      ...result,identity:Object.freeze(result.identity),files:Object.freeze(expected.map(f=>Object.freeze(f)))
    });
  } catch(error) {
    // Retain partial private copy for diagnosis, never return it as a valid input.
    throw new Error('RUN_INPUT_CHANGED: '+(error instanceof Error?error.message:String(error)),{
      cause:error
    });
  }
}
/** Executor rechecks the sealed bytes before admitting a plan (no caller-forged ACK copy). */
export async function verifyAcknowledgedInput(input:AcknowledgedRunInput) {
  await canonicalDirectory(input.immutableDirectory);
  requireThat(input.identity.manifestSha256===inputManifestHash(input),'Input identity mismatch');
  const published=await readRegular(path.join(path.dirname(input.immutableDirectory),'input-manifest.json'),2*1024*1024);
  requireThat(published.toString()===canonicalJson(input),'Published input manifest mismatch');
  // Win32: canonical private run ancestry + independent hash-checked copy + required RO mount.
  if (process.platform !== 'win32') requireThat(((await fs.lstat(input.immutableDirectory, { bigint:true })).mode & 0o222n) === 0n, 'Input directory not sealed');
  const actual=await inventory(input.immutableDirectory);
  requireThat(canonicalJson(actual)===canonicalJson(input.files.map(({
    path,sha256,bytes
  })=>({
    path,sha256,bytes
  }))), 'Immutable input changed');
  return actual;
}
