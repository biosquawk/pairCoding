/** Pure run identity data only: shared by neutral coordination and execution adapters. */
import { createHash } from 'node:crypto';

export const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
/** Stable identities are independent of object insertion order; only bounded plain JSON data is admitted. */
export function canonicalJson(value:unknown):string {
  let nodes=0;
  function normalize(v:unknown,depth:number):unknown {
    requireThat(++nodes<=100000&&depth<=64,'JSON structure limit');
    if(v===null||typeof v==='string'||typeof v==='boolean')return v;
    if(typeof v==='number'){
      requireThat(Number.isFinite(v),'Nonfinite JSON number');
      return v;
    }
    requireThat(typeof v==='object'&&v!==null,'Non-JSON value');
    if(Array.isArray(v))return v.map(x=>normalize(x,depth+1));
    requireThat(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null,'Nonplain JSON data');
    return Object.fromEntries(Object.keys(v).sort().map(k=>[k,normalize((v as Record<string,unknown>)[k],depth+1)]));
  }
  return JSON.stringify(normalize(value,0));
}
