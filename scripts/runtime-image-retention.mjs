/** Producer-only local image lifetime proof. References are NOT image-lock authority.
 * No enumeration, registry operations, retries or cleanup. All I/O goes through the caller's
 * bounded same-engine, per-command empty-config transport and durable receipt writer. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
const check = (ok, why) => { if (!ok) throw new Error('NOTREADY: ' + why); };
const sha = /^sha256:[a-f0-9]{64}$/;
const exact = (o, keys) => o && !Array.isArray(o) && Object.keys(o).sort().join(',') === [...keys].sort().join(',');
const clone = value => JSON.parse(JSON.stringify(value));
const media = ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.v2+json', 'application/vnd.docker.distribution.manifest.list.v2+json'];
function engineIdentity(e) {
  check(exact(e, ['ID', 'ServerVersion', 'OSType', 'Architecture']) && Object.values(e).every(v => typeof v === 'string' && v.length > 0 && v.length <= 256) && e.OSType === 'linux' && ['amd64', 'x86_64'].includes(e.Architecture), 'retention engine identity required');
  return e;
}
function observed(image) {
  check(image && sha.test(image.Id) && Array.isArray(image.RepoDigests) && image.RepoDigests.length <= 64 && image.RepoDigests.every(s => typeof s === 'string' && /^[a-z0-9][a-z0-9._/:+-]*@sha256:[a-f0-9]{64}$/.test(s)), 'retention actual immutable image/RepoDigest required');
  const descriptor = image.Descriptor ?? null;
  if (descriptor !== null) check(descriptor && !Array.isArray(descriptor) && sha.test(descriptor.digest) && Number.isSafeInteger(descriptor.size) && descriptor.size > 0 && media.includes(descriptor.mediaType), 'retention genuine Descriptor malformed');
  const digest = descriptor?.digest ?? image.RepoDigests[0]?.split('@')[1];
  check(digest && (!image.RepoDigests.length || image.RepoDigests.some(s => s.endsWith('@' + digest))), 'retention genuine manifest/index evidence required; Id is not a digest inference');
  check(image.Config && !Array.isArray(image.Config) && image.Config.User === '10001:10001' && (image.Config.Entrypoint === null || image.Config.Entrypoint === undefined || Array.isArray(image.Config.Entrypoint) && image.Config.Entrypoint.length === 0), 'retention nonroot/config identity required');
  const projection = { Id: image.Id, Descriptor: descriptor, RepoDigests: image.RepoDigests, Config: image.Config };
  check(Buffer.byteLength(JSON.stringify(projection)) <= 65536, 'retention image proof byte bound');
  return { projection, digest };
}
export function imagePin(engine, image, source) {
  engineIdentity(engine);
  check(typeof source === 'string' && source.length > 0 && source.length <= 512 && !/[\x00-\x1f\x7f]/.test(source), 'retention bounded explicit provenance required');
  return clone({ engine, observedImage: observed(image).projection, source });
}
function validatePin(pin, engine) {
  check(exact(pin, ['engine', 'observedImage', 'source']) && exact(pin.observedImage, ['Id', 'Descriptor', 'RepoDigests', 'Config']), 'retention exact pin fields required');
  const p = imagePin(pin.engine, pin.observedImage, pin.source);
  check(isDeepStrictEqual(p.engine, engine), 'retention prior pin belongs to another engine');
  return p;
}
export function retentionReference(pin) {
  const p = validatePin(pin, engineIdentity(pin.engine)), digest = observed(p.observedImage).digest;
  // Explicit field order, not JSON source key order; full length in every identity component.
  const namespace = createHash('sha256').update(JSON.stringify(['ID','ServerVersion','OSType','Architecture'].map(k => p.engine[k]))).digest('hex');
  return `paircoach/retained-${namespace}/${p.observedImage.Id.slice(7)}:${digest.slice(7)}`;
}
/** Only a precise absent LOCAL inspect result may be treated as absence. Unknown is never absent. */
export function imageCommandOutput(args, raw, allowMissing = false) {
  check(raw && !raw.error && !raw.signal, 'unknown image operation; retain/reconcile before any write');
  if (raw.status === 0) { check(typeof raw.stdout === 'string', 'image command stdout missing'); return raw.stdout; }
  const ref = args.length === 3 && args[0] === 'image' && args[1] === 'inspect' ? args[2] : null;
  const stderr = typeof raw.stderr === 'string' ? raw.stderr.trim() : '';
  check(allowMissing && ref && raw.status === 1 && ['', '[]'].includes((raw.stdout ?? '').trim()) && [
    `Error response from daemon: No such image: ${ref}`, `Error: No such image: ${ref}`, `Error: No such object: ${ref}`,
  ].includes(stderr), 'image operation failed/unknown (not exact missing image); retain/reconcile');
  return null;
}
export function createImageRetention({ engine, requiredPins = [], run, receipt, save }) {
  engine = clone(engineIdentity(engine));
  check(Array.isArray(requiredPins) && requiredPins.length <= 64 && typeof run === 'function' && typeof save === 'function', 'bounded explicit retention context required');
  const pins = [], state = { schemaVersion: 1, engine, pins, operations: [] };
  const initial = requiredPins.map(p => validatePin(p, engine)); // validate ALL before commands/writes
  check(!Object.hasOwn(receipt, 'imageRetention'), 'retention state already exists; do not adopt/retry');
  receipt.imageRetention = state; save();
  let stopped = false;
  const guarded = fn => (...args) => { check(!stopped, 'retention stopped; exact reconciliation required'); try { return fn(...args); } catch (e) { stopped = true; throw e; } };
  const inspect = (reference, allowMissing = false) => {
    const args = ['image', 'inspect', reference], text = imageCommandOutput(args, run(args, allowMissing), allowMissing);
    if (text === null) return null;
    const values = JSON.parse(text);
    check(Array.isArray(values) && values.length === 1, 'retention inspect must contain exactly one image');
    return observed(values[0]).projection;
  };
  const same = (actual, expected) => check(isDeepStrictEqual(actual, expected), 'retention exact manifest/config identity changed');
  const add = pin => {
    const p = validatePin(pin, engine), prior = pins.find(v => v.pin.observedImage.Id === p.observedImage.Id);
    if (prior) { same(p.observedImage, prior.pin.observedImage); return prior; }
    check(pins.length < 64, 'retention pin count exceeded');
    const entry = { pin: p, reference: retentionReference(p), retained: false };
    pins.push(entry); save(); return entry;
  };
  const retain = entry => {
    const { pin, reference } = entry;
    same(inspect(pin.observedImage.Id), pin.observedImage); // missing known ID is fatal, not a rebuild request
    const current = inspect(reference, true);
    if (current !== null) same(current, pin.observedImage); // never overwrite conflicting/foreign reference
    else {
      const operation = { imageId: pin.observedImage.Id, reference, status: 'TAG_INTENT' };
      check(state.operations.length < 64, 'retention operation bound exceeded'); state.operations.push(operation); save();
      imageCommandOutput(['tag', pin.observedImage.Id, reference], run(['tag', pin.observedImage.Id, reference]));
      operation.status = 'TAG_RETURNED_REQUIRES_EXACT_READBACK'; save();
      same(inspect(reference), pin.observedImage); same(inspect(pin.observedImage.Id), pin.observedImage);
      operation.status = 'RETAINED_EXACT_READBACK'; save();
    }
    entry.retained = true; save();
  };
  const verifyAll = () => {
    for (const entry of pins) {
      check(entry.retained, 'required pin not durably retained');
      same(inspect(entry.pin.observedImage.Id), entry.pin.observedImage);
      same(inspect(entry.reference), entry.pin.observedImage);
    }
    state.status = 'ALL_REQUIRED_IDS_AND_REFERENCES_EXACT_CHECKED'; save();
  };
  for (const p of initial) add(p);
  return Object.freeze({
    retainRequired: guarded(() => { for (const entry of pins) retain(entry); verifyAll(); }),
    beforeBuild: guarded(tag => {
      check(typeof tag === 'string' && /^paircoach\/(?:runtime-|language-)[a-z0-9.-]+:[a-z0-9.-]+$/.test(tag), 'explicit approved mutable producer tag required');
      verifyAll();
      const prior = inspect(tag, true);
      if (prior) retain(add(imagePin(engine, prior, 'current mutable tag ' + tag)));
      verifyAll(); state.nextBuildTag = tag; state.status = 'RETAINED_BEFORE_MUTABLE_RETARGET'; save();
    }),
    afterBuild: guarded(tag => {
      check(tag === state.nextBuildTag && state.status === 'RETAINED_BEFORE_MUTABLE_RETARGET', 'retention build correlation missing');
      const image = inspect(tag), entry = add(imagePin(engine, image, 'measured mutable tag ' + tag));
      retain(entry); verifyAll(); delete state.nextBuildTag; save(); return clone(entry.pin);
    }),
    add: guarded(pin => { const entry = add(pin); retain(entry); return clone(entry.pin); }),
    verifyAll: guarded(verifyAll),
    pins: () => pins.map(entry => clone(entry.pin)),
  });
}
