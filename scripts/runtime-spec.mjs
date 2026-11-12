const keys = (o, names) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join(',') === [...names].sort().join(',');
export const literalPath = s => typeof s === 'string' && s.length > 0 && s.length <= 512 && !s.startsWith('/') && !/[\x00-\x1f\x7f\\:*?![\]{}<>|"$`;&]/u.test(s) && s.split('/').every(p => p && p !== '.' && p !== '..' && !p.startsWith('-'));
const name = s => typeof s === 'string' && s.length <= 256 && /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*(?:#[A-Za-z_$][A-Za-z0-9_$]*)?$/.test(s);
/** Java release field is selected JDK identity, never a POM rewrite. Independent container guard; data only, no executable/env/Docker flag slots. */
export function validateSpec(s) {
  if (!keys(s,['schemaVersion','family','release','preview','runId','manifestSha256','mode','task','cache']) || s.schemaVersion !== 1 || !['node','typescript','python','java-maven'].includes(s.family) || !['RUN_MAIN','RUN_TESTS'].includes(s.mode) || !/^[A-Za-z0-9_-]{1,128}$/.test(s.runId) || !/^[a-f0-9]{64}$/.test(s.manifestSha256) || typeof s.preview !== 'boolean') throw new Error('Invalid runtime spec');
  if (s.cache !== '/cache/0') throw new Error('Invalid managed cache');
  const t = s.task;
  if (!keys(t,['workingDirectory','entry','tests']) || t.workingDirectory !== '.' && !literalPath(t.workingDirectory) || !keys(t.tests,['paths','names']) || !Array.isArray(t.tests.paths) || !Array.isArray(t.tests.names) || t.tests.paths.length > 100 || t.tests.names.length > 100 || t.tests.paths.some(p => !literalPath(p)) || t.tests.names.some(n => !name(n)) || new Set(t.tests.paths).size !== t.tests.paths.length || new Set(t.tests.names).size !== t.tests.names.length) throw new Error('Invalid selectors');
  const e = t.entry;
  if (!e || !['SCRIPT','MODULE','JAVA_MAIN','SPRING_BOOT','TESTS'].includes(e.kind)) throw new Error('Invalid entry');
  const fields = {SCRIPT:['kind','path'],MODULE:['kind','name'],JAVA_MAIN:['kind','className'],SPRING_BOOT:['kind','containerPort','healthPath'],TESTS:['kind']};
  if (!keys(e, fields[e.kind]) || e.kind === 'SCRIPT' && !literalPath(e.path) || ['MODULE','JAVA_MAIN'].includes(e.kind) && (!name(e.name ?? e.className) || (e.name ?? e.className).includes('#')) || e.kind === 'SPRING_BOOT' && (!Number.isInteger(e.containerPort) || e.containerPort < 1 || e.containerPort > 65535 || typeof e.healthPath !== 'string' || !/^\/(?!\/)[^\s?#\\]{0,1023}$/.test(e.healthPath)) || e.kind === 'TESTS' && s.mode !== 'RUN_TESTS') throw new Error('Invalid entry data');
  if (s.family === 'java-maven') {
    if (![11,17,21,27].includes(s.release) || !['JAVA_MAIN','SPRING_BOOT','TESTS'].includes(e.kind) || t.tests.paths.length || e.kind === 'SPRING_BOOT' && ![21,27].includes(s.release)) throw new Error('Java task mismatch');
  } else {
    if (s.release !== null || s.preview || !['SCRIPT','MODULE','TESTS'].includes(e.kind) || e.kind === 'MODULE' && s.family !== 'python' || t.tests.names.length || s.mode === 'RUN_TESTS' && !t.tests.paths.length) throw new Error('Non-Java task mismatch');
    const ext = s.family === 'node' ? /\.(?:js|cjs|mjs)$/ : s.family === 'typescript' ? /\.ts$/ : /\.py$/;
    if (e.kind === 'SCRIPT' && !ext.test(e.path) || t.tests.paths.some(p => !ext.test(p))) throw new Error('Source extension mismatch');
  }
  return s;
}
export function canonicalJSON(value) {
  const order = v => Array.isArray(v) ? v.map(order) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,order(v[k])])) : v;
  return JSON.stringify(order(value));
}
export function encodeSpec(spec) {
  validateSpec(spec);
  const encoded=Buffer.from(canonicalJSON(spec),'utf8').toString('base64url');
  if(encoded.length>4096) throw new Error('TASK_CONFIG_INVALID: selectors exceed4096 argument budget');
  return encoded;
}
export function decodeSpec(encoded) {
  if(typeof encoded!=='string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(encoded)) throw new Error('Invalid encoded spec');
  const bytes=Buffer.from(encoded,'base64url');
  if(bytes.toString('base64url')!==encoded) throw new Error('Noncanonical base64url');
  const json=new TextDecoder('utf-8',{fatal:true}).decode(bytes),spec=JSON.parse(json);
  if(canonicalJSON(spec)!==json) throw new Error('Noncanonical/duplicate-key JSON');
  return validateSpec(spec);
}
