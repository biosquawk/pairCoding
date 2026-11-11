import { createHash } from 'node:crypto';
import type { AnalysisSource, DocumentStamp, OpenOrChange } from '../../shared/language-v2';
import { validateDiagnosticsResult, validateDocumentStamp, validateOpenOrChange } from '../../shared/validation-v2';
import type { VerifiedLanguageAck } from './ports';

export interface LanguageAckCodec {
  normalizeContent(content: string): string;
  contentSha256(content: string): string;
}
/** Backend-only. peerId is the authenticated server transport identity, NOT clientId from a payload. */
export interface LanguageSaveInput {
  peerId: string; transactionMessageId: string; languageDocumentMessageId: string;
  path: string; baseVersion: number; controlEpoch: number; content: string;
}
export interface LanguageAckCurrent {
  documentMessageId: string; stamp: Readonly<DocumentStamp>; content: string;
  /** Monotonic identity for the FULL project source/overlay/dependency/control vector, never a bytes hash. */
  projectRevision: string; dependencyManifestSha256: string;
}
/** Actual immutable WriteGate/idempotency result plus authentic ACK envelope, recorded BEFORE publication. */
export interface LanguageSaveCommit {
  request: Readonly<LanguageSaveInput>; saveReceiptId: string; replyTo: string; status: 'OK' | 'DUPLICATE';
  documentVersion: number; workspaceVersion: number; committedContent: string;
  /** Same serialized transaction's before/after full-vector identities. No intervening/unaccounted mutation. */
  beforeProjectRevision: string; afterProjectRevision: string;
}
export interface LanguageAckAuthority {
  readCurrent(peerId: string, path: string): LanguageAckCurrent | null;
  /** EXACT sent-version/fixed-launch source ledger. Never derive provenance from current stamp at receipt time. */
  readAnalysisSource(peerId: string, documentMessageId: string): Readonly<AnalysisSource> | null;
  /** No structural wire value is a commit proof. Caller supplies its private actual-commit ledger reader. */
  readCommittedSave(request: Readonly<LanguageSaveInput>, saveReceiptId: string): LanguageSaveCommit | null;
}
declare const pendingLanguageSave: unique symbol;
export interface PendingLanguageSave { readonly [pendingLanguageSave]: true }
type Capture = { request: Readonly<LanguageSaveInput>; document: Readonly<OpenOrChange>;
  current: Readonly<LanguageAckCurrent>; source: Readonly<AnalysisSource>; issued: Map<string,VerifiedLanguageAck> };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const same = (a: unknown,b: unknown): boolean => {
  if(a===b) return true;
  if(!a || !b || typeof a!=='object' || typeof b!=='object') return false;
  const ak=Object.keys(a),bk=Object.keys(b);
  return ak.length===bk.length && ak.every(k=>Object.hasOwn(b,k) && same((a as Record<string,unknown>)[k],(b as Record<string,unknown>)[k]));
};
const id = (s: unknown): s is string => typeof s==='string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s);
const revision = (s: unknown): s is string => typeof s==='string' && s.length>0 && s.length<=256 && !/[\x00-\x1f\x7f]/.test(s);
const hash = (s: unknown): s is string => typeof s==='string' && /^[a-f0-9]{64}$/.test(s);
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number)>=1;
const key = (peerId: string, messageId: string): string => JSON.stringify([peerId,messageId]);
const sourceValid = (s: AnalysisSource): boolean => validateDiagnosticsResult({ ...s,
  presentationStamp:s.sourceStamp,association:null,items:[],truncated:false });

/**
 * Synchronous under the coordinator's SAME serialized overlay/WriteGate authority. Does not save or publish.
 * Missing/unsafe correlation returns null; ordinary save must remain available. No didChange/restart on ACK.
 * This is a private issuance ledger, not a validator for client-provided branded-looking JSON.
 */
export class LanguageAckLedger {
  private documents = new Map<string, Readonly<OpenOrChange>>();
  private seenDocuments = new Map<string,string>();
  private documentBytes = 0;
  private captureBytes = 0;
  private transactions = new Map<string, { handle: PendingLanguageSave; capture: Capture }>();
  private pending = new WeakMap<object,Capture>();
  private proofs = new WeakMap<object,Capture>();
  private receiptOwners = new Map<string,Capture>();
  constructor(private readonly authority: LanguageAckAuthority, private readonly codec: LanguageAckCodec) {}

  /** Call ONLY after authenticated current-peer scope checks and successful immutable OPEN/CHANGE admission. */
  observeDocument(peerId: string, messageId: string, document: OpenOrChange): void {
    if(!id(peerId) || !id(messageId) || !validateOpenOrChange(document) ||
      this.codec.contentSha256(document.content)!==document.stamp.contentSha256) throw new Error('Invalid admitted language document');
    const k=key(peerId,messageId), digest=createHash('sha256').update(JSON.stringify(document)).digest('hex'), seen=this.seenDocuments.get(k);
    if(seen) { if(seen!==digest) throw new Error('Language message identity collision'); return; }
    if(this.seenDocuments.size>=8192) throw new Error('Language document ledger capacity; retire scope');
    for(const [oldKey,old] of this.documents) if(JSON.parse(oldKey)[0]===peerId && old.stamp.path===document.stamp.path) {
      this.documents.delete(oldKey);this.documentBytes-=Buffer.byteLength(old.content);
    }
    const bytes=Buffer.byteLength(document.content);
    if(this.documentBytes+bytes>32*1024*1024) throw new Error('Language document byte capacity; retire scope');
    this.seenDocuments.set(k,digest);this.documentBytes+=bytes;this.documents.set(k,freeze(clone(document)));
  }
  private current(request: Readonly<LanguageSaveInput>): LanguageAckCurrent | null {
    const c=this.authority.readCurrent(request.peerId,request.path);
    if(!c || !validateDocumentStamp(c.stamp) || !revision(c.projectRevision) || !hash(c.dependencyManifestSha256) ||
      c.documentMessageId!==request.languageDocumentMessageId || c.stamp.path!==request.path ||
      c.stamp.controlEpoch!==request.controlEpoch || this.codec.normalizeContent(c.content)!==this.codec.normalizeContent(request.content) ||
      this.codec.contentSha256(c.content)!==c.stamp.contentSha256) return null;
    return c;
  }
  beginSave(input: LanguageSaveInput): PendingLanguageSave | null {
    try {
      if(!id(input.peerId) || !id(input.transactionMessageId) || !id(input.languageDocumentMessageId) ||
        !integer(input.baseVersion) || !Number.isSafeInteger(input.controlEpoch) || input.controlEpoch<0 || typeof input.content!=='string') return null;
      const request=freeze(clone(input)), k=key(request.peerId,request.transactionMessageId), prior=this.transactions.get(k);
      // Duplicate admission can ONLY retrieve its original capture; never capture today's equal-byte model.
      if(prior) return same(prior.capture.request,request) ? prior.handle : null;
      if(this.transactions.size>=2048 || this.captureBytes+Buffer.byteLength(input.content)>32*1024*1024) return null;
      const document=this.documents.get(key(request.peerId,request.languageDocumentMessageId)), current=this.current(request);
      if(!document || !current || !same(current.stamp,document.stamp) || current.stamp.baseDocumentVersion!==request.baseVersion ||
        this.codec.normalizeContent(document.content)!==this.codec.normalizeContent(request.content)) return null;
      const source=this.authority.readAnalysisSource(request.peerId,request.languageDocumentMessageId);
      if(!source || !sourceValid(source) || !same(source.sourceStamp,document.stamp)) return null;
      const capture: Capture={request,document,current:freeze(clone(current)),source:freeze(clone(source)),issued:new Map()};
      const handle=Object.freeze({}) as PendingLanguageSave;
      this.captureBytes+=Buffer.byteLength(input.content);this.pending.set(handle,capture); this.transactions.set(k,{handle,capture}); return handle;
    } catch { return null; }
  }
  private verified(c: Capture, saveReceiptId: string): { current: LanguageAckCurrent; commit: LanguageSaveCommit } | null {
    const { request,document,current:before,source }=c;
    // Retiring the authenticated peer also retires its captures/proofs, even if callbacks accidentally linger.
    if(this.documents.get(key(request.peerId,request.languageDocumentMessageId))!==document) return null;
    const current=this.current(request), commit=this.authority.readCommittedSave(request,saveReceiptId);
    if(!current || !commit || !same(commit.request,request) || !id(commit.saveReceiptId) || commit.saveReceiptId!==saveReceiptId || commit.replyTo!==request.transactionMessageId ||
      !['OK','DUPLICATE'].includes(commit.status) || !integer(commit.workspaceVersion) || !integer(commit.documentVersion) ||
      commit.documentVersion<=request.baseVersion || commit.beforeProjectRevision!==before.projectRevision ||
      !revision(commit.afterProjectRevision) || commit.afterProjectRevision===before.projectRevision ||
      current.projectRevision!==commit.afterProjectRevision || current.dependencyManifestSha256!==before.dependencyManifestSha256 ||
      this.codec.normalizeContent(commit.committedContent)!==this.codec.normalizeContent(request.content) ||
      current.stamp.baseDocumentVersion!==commit.documentVersion || current.stamp.documentVersion!==commit.documentVersion ||
      current.stamp.requestGeneration!==document.stamp.requestGeneration) return null;
    const ackOnly=new Set(['baseDocumentVersion','documentVersion']);
    if(Object.keys(document.stamp).some(k=>!ackOnly.has(k) && document.stamp[k as keyof DocumentStamp]!==current.stamp[k as keyof DocumentStamp]) ||
      !same(this.authority.readAnalysisSource(request.peerId,request.languageDocumentMessageId),source)) return null;
    return {current,commit};
  }
  commitSave(handle: PendingLanguageSave, saveReceiptId: string): VerifiedLanguageAck | null {
    try {
      const c=this.pending.get(handle); if(!c || !id(saveReceiptId)) return null;
      const verified=this.verified(c,saveReceiptId); if(!verified) return null;
      const existing=c.issued.get(saveReceiptId);
      if(existing) return this.isVerified(existing) ? existing : null;
      if(c.issued.size>=128 || this.receiptOwners.size>=8192 || this.receiptOwners.has(saveReceiptId)) return null;
      const {current,commit}=verified;
      // The ONLY cast to this existing private brand. isVerified also requires this exact object's issuance.
      const proof=freeze({ saveReceiptId:commit.saveReceiptId,transactionMessageId:c.request.transactionMessageId,
        replyTo:commit.replyTo,status:commit.status,source:clone(c.source),previous:clone(c.document.stamp),
        presentation:clone(current.stamp),normalizedContentSha256:current.stamp.contentSha256,
        dependencyManifestSha256:current.dependencyManifestSha256 }) as VerifiedLanguageAck;
      c.issued.set(saveReceiptId,proof);this.receiptOwners.set(saveReceiptId,c);this.proofs.set(proof,c);return proof;
    } catch { return null; }
  }
  isVerified(proof: VerifiedLanguageAck): boolean {
    try {
      const c=this.proofs.get(proof);if(!c || c.issued.get(proof.saveReceiptId)!==proof) return false;
      const checked=this.verified(c,proof.saveReceiptId);
      return !!checked && checked.commit.saveReceiptId===proof.saveReceiptId && checked.commit.status===proof.status &&
        same(checked.current.stamp,proof.presentation) && same(c.source,proof.source);
    } catch { return false; }
  }
  /** Call synchronously on disconnect/reconnect/config/project/provider/shadow/control invalidation. */
  retirePeer(peerId: string): void {
    for(const [k,d] of this.documents) if(JSON.parse(k)[0]===peerId) { this.documentBytes-=Buffer.byteLength(d.content);this.documents.delete(k); }
    for(const k of this.seenDocuments.keys()) if(JSON.parse(k)[0]===peerId) this.seenDocuments.delete(k);
    for(const [k,{handle,capture}] of this.transactions) if(JSON.parse(k)[0]===peerId) { this.captureBytes-=Buffer.byteLength(capture.request.content);for(const id of capture.issued.keys()) this.receiptOwners.delete(id);this.pending.delete(handle); this.transactions.delete(k); }
  }
}
