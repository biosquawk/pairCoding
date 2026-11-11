/** Pure executable proposal oracle. NO product/LSP/Docker/Monaco integration. */
const fail = message => { throw new Error(message); };
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export function validatePath(path) {
  if (typeof path !== 'string' || !path || path.length > 1024 || /[\\:\x00-\x1f\x7f]/u.test(path)) fail('unsafe path');
  if (path.split('/').some(s => !s || s === '.' || s === '..' || /[. ]$/u.test(s)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(s))) fail('unsafe segment');
  return path;
}
const encodedPath = path => validatePath(path).split('/').map(encodeURIComponent).join('/');
function authority(projectId) {
  if (!idPattern.test(projectId)) fail('invalid projectId');
  return 'p-' + [...new TextEncoder().encode(projectId)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function modelUri(projectId, path) { return `paircoach://${authority(projectId)}/${encodedPath(path)}`; }
export function containerUri(path) { return `file:///workspace/${encodedPath(path)}`; }
function decodePath(raw) {
  const path = raw.split('/').map(s => {
    const decoded = decodeURIComponent(s);
    if (/[\/\\]/u.test(decoded)) fail('encoded separator');
    return decoded;
  }).join('/');
  validatePath(path);
  if (encodedPath(path) !== raw) fail('noncanonical URI');
  return path;
}
export function fromModelUri(projectId, uri) {
  const prefix = `paircoach://${authority(projectId)}/`;
  if (typeof uri !== 'string' || !uri.startsWith(prefix)) fail('wrong project/scheme');
  return decodePath(uri.slice(prefix.length));
}
export function fromContainerUri(uri) {
  const prefix = 'file:///workspace/';
  if (typeof uri !== 'string' || !uri.startsWith(prefix)) fail('wrong container root/scheme');
  return decodePath(uri.slice(prefix.length));
}
export const normalizeLF = text => text.replace(/\r\n/g, '\n');
function offset(content, position) {
  const lines = content.split('\n');
  const { line, column } = position;
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || line > lines.length
    || column < 1 || column > lines[line - 1].length + 1) fail('position out of bounds');
  const s = lines[line - 1], at = column - 1;
  if (at > 0 && at < s.length && /[\uD800-\uDBFF]/u.test(s[at - 1]) && /[\uDC00-\uDFFF]/u.test(s[at])) fail('split surrogate pair');
  return lines.slice(0, line - 1).reduce((n, s) => n + s.length + 1, 0) + at;
}
export function toLsp(content, p) {
  offset(normalizeLF(content), p);
  return { line: p.line - 1, character: p.column - 1 };
}
export function fromLsp(content, p) {
  const result = { line: p.line + 1, column: p.character + 1 };
  offset(normalizeLF(content), result);
  return result;
}
export function applyAtomicEdits(content, path, edits) {
  content = normalizeLF(content); validatePath(path);
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 100) fail('edit count');
  let size = 0;
  const checked = edits.map(edit => {
    if (edit.path !== path || typeof edit.text !== 'string' || edit.text.length > 4096) fail('edit path/text');
    size += edit.text.length;
    if (size > 65536) fail('edit size');
    const r = edit.range;
    const start = offset(content, { line: r.startLine, column: r.startColumn });
    const end = offset(content, { line: r.endLine, column: r.endColumn });
    if (end < start) fail('reversed edit');
    return { start, end, text: normalizeLF(edit.text) };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < checked.length; i++) {
    const a = checked[i - 1], b = checked[i];
    if (a.end > b.start || (a.end === b.start && (a.start === a.end || b.start === b.end))) fail('overlap/ambiguous insert');
  }
  // Validation completed BEFORE creating new output: no partial application.
  return checked.reverse().reduce((s, e) => s.slice(0, e.start) + e.text + s.slice(e.end), content);
}
export const stampKeys = Object.freeze(['projectId', 'sessionId', 'connectionGeneration', 'path', 'profileId',
  'configurationGeneration', 'providerGeneration', 'shadowGeneration', 'modelLifetime', 'localModelVersion',
  'baseDocumentVersion', 'documentVersion', 'contentSha256', 'controlEpoch', 'requestGeneration']);
export const sameStamp = (a, b) => !!a && !!b && stampKeys.every(key => Object.hasOwn(a, key) && Object.hasOwn(b, key) && a[key] === b[key]);
export const canAccept = state => state.owner === 'STUDENT' && state.synced === true && state.providerOn === true
  && !state.preparing && !state.vetoPending && !state.conflict && !state.readOnly;
export class AcceptanceFence {
  generation = 0; pending = null; visible = false; cancelled = [];
  invalidate() {
    this.generation++;
    if (this.pending) this.cancelled.push(this.pending.requestId);
    this.pending = null; this.visible = false;
  }
  request(requestId, stamp, state, content) {
    this.invalidate();
    if (!canAccept(state)) return null;
    if (typeof content !== 'string') fail('missing actual request buffer');
    this.pending = { requestId, stamp: structuredClone(stamp), fenceGeneration: this.generation, content: normalizeLF(content) };
    return structuredClone(this.pending);
  }
  matches(reply, stamp, state) {
    return canAccept(state) && !!this.pending && reply?.requestId === this.pending.requestId
      && reply.fenceGeneration === this.generation && sameStamp(reply.stamp, this.pending.stamp) && sameStamp(reply.stamp, stamp);
  }
  show(reply, stamp, state) { this.visible = this.matches(reply, stamp, state); return this.visible; }
  accept(reply, stamp, state, content, item) {
    if (!this.visible || !this.matches(reply, stamp, state) || normalizeLF(content) !== this.pending.content) fail('stale or unauthorized acceptance');
    const keys = ['id', 'label', 'detail', 'primary', 'additionalTextEdits'];
    if (!item || Object.keys(item).some(k => !keys.includes(k)) || !Array.isArray(item.additionalTextEdits)) fail('unsupported completion item');
    const edits = [item.primary, ...item.additionalTextEdits];
    if (edits.some(e => !e || Object.keys(e).some(k => !['path', 'range', 'text'].includes(k)))) fail('unsupported completion edit');
    const result = applyAtomicEdits(content, stamp.path, edits);
    this.invalidate();
    return result; // Caller would perform one public Monaco edit + ordinary autosave, not a wire write here.
  }
}
/** Provider context is locally owned launch/request history, NEVER supplied by a diagnostic payload. */
export function acceptDiagnostics(event, current, provider) {
  if (!provider || provider.generation !== current.providerGeneration || !sameStamp(event.stamp, current)) return false;
  if (Number.isSafeInteger(event.version)) return sameStamp(provider.versions?.get(event.version), current);
  if (event.version != null) return false;
  if (event.requestId) return provider.mode === 'PULL' && sameStamp(provider.requests?.get(event.requestId), current);
  return provider.mode === 'IMMUTABLE' && provider.neverMutated === true
    && typeof provider.manifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(provider.manifestSha256)
    && sameStamp(provider.fixedStamp, current);
}
function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || Object.keys(value).some(k => !keys.includes(k))) fail('shape/migration required');
}
export function validateRunProfilesV2(values) {
  if (!Array.isArray(values) || values.length > 2) fail('profile count');
  const kinds = new Set();
  for (const p of values) {
    exactKeys(p, ['kind', 'task', 'timeoutMs']);
    if (!['RUN_MAIN', 'RUN_TESTS'].includes(p.kind) || kinds.has(p.kind)) fail('kind');
    kinds.add(p.kind);
    if (!Number.isInteger(p.timeoutMs) || p.timeoutMs < 1000 || p.timeoutMs > 300000) fail('timeout');
    exactKeys(p.task, ['workingDirectory', 'entry', 'tests']);
    if (p.task.workingDirectory !== '.') validatePath(p.task.workingDirectory);
    const e = p.task.entry;
    const entryKeys = { SCRIPT: ['kind', 'path'], MODULE: ['kind', 'name'], JAVA_MAIN: ['kind', 'className'], SPRING_BOOT: ['kind', 'containerPort', 'healthPath'] };
    if (!e || !Object.hasOwn(entryKeys, e.kind)) fail('entry kind');
    exactKeys(e, entryKeys[e.kind]);
    if (e.kind === 'SCRIPT') validatePath(e.path);
    if (e.kind === 'MODULE' && (typeof e.name !== 'string' || e.name.length > 256 || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(e.name))) fail('module');
    if (e.kind === 'JAVA_MAIN' && (typeof e.className !== 'string' || e.className.length > 256 || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(e.className))) fail('class');
    if (e.kind === 'SPRING_BOOT' && (!Number.isInteger(e.containerPort) || e.containerPort < 1024 || e.containerPort > 65535
      || typeof e.healthPath !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(e.healthPath) || e.healthPath.length > 256)) fail('spring data');
    exactKeys(p.task.tests, ['paths', 'names']);
    if (!Array.isArray(p.task.tests.paths) || p.task.tests.paths.length > 100) fail('test paths');
    p.task.tests.paths.forEach(validatePath);
    if (!Array.isArray(p.task.tests.names) || p.task.tests.names.length > 100 || p.task.tests.names.some(n => typeof n !== 'string'
      || !n || n.length > 128 || !/^[A-Za-z0-9_$.*?#-]+$/.test(n) || n.startsWith('-'))) fail('test names');
  }
  return structuredClone(values); // No mutation of preserved input, and never execution.
}
/** Explicit ACK-only metadata transition. Inputs flight/currentContent are trusted local records, NOT LSP fields. */
export function rebindDiagnosticsOnAck(provider, previous, next, ack, flight, currentContent) {
  const metadata = new Set(['baseDocumentVersion', 'documentVersion', 'requestGeneration']);
  if (!provider || provider.generation !== previous.providerGeneration
    || !stampKeys.every(k => Object.hasOwn(previous, k) && Object.hasOwn(next, k))
    || !stampKeys.filter(k => !metadata.has(k)).every(k => previous[k] === next[k])
    || !['OK', 'DUPLICATE'].includes(ack.status) || ack.replyTo !== flight.messageId
    || !Number.isSafeInteger(ack.documentVersion) || ack.documentVersion <= flight.baseVersion
    || flight.path !== previous.path || flight.modelLifetime !== previous.modelLifetime
    || flight.localModelVersion !== previous.localModelVersion || flight.baseVersion !== previous.baseDocumentVersion
    || flight.contentSha256 !== previous.contentSha256 || typeof flight.content !== 'string'
    || typeof currentContent !== 'string' || normalizeLF(flight.content) !== normalizeLF(currentContent)
    || next.documentVersion !== ack.documentVersion || next.baseDocumentVersion !== ack.documentVersion
    || !Number.isSafeInteger(next.requestGeneration) || next.requestGeneration <= previous.requestGeneration) fail('ACK rebind refused');
  const rebind = value => sameStamp(value, previous) ? structuredClone(next) : structuredClone(value);
  // Persistent-copy transition; cannot mutate previous mappings or make an old generation current.
  return { ...provider,
    versions: provider.versions && new Map([...provider.versions].map(([k, v]) => [k, rebind(v)])),
    requests: provider.requests && new Map([...provider.requests].map(([k, v]) => [k, rebind(v)])),
    fixedStamp: provider.fixedStamp && rebind(provider.fixedStamp) };
}
