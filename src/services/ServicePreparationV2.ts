/** Private client lifecycle for the EXISTING maintenance route, not a wire/schema authority.
 * A retained POST explicitly completes its immutable original. Prior admission is read-first;
 * if it never arrived, the SAME original may receive its first guarded admission (HUMAN664).
 */
export interface ServicePrepareRequest {
  requestId:string; clientId:string; sessionId:string; expectedWorkspaceVersion:number;
  configurationGeneration:string; controlEpoch:number;
}
interface PreparedReceipt {schemaVersion:1;status:'PREPARED';installationId:string;projectId:string;engineId:string;name:string;networkId:string}
export interface ServicePreparationState {
  pending:boolean; blocked:boolean; uncertain:boolean; canPrepare:boolean; canReconcile:boolean; message:string|null;
}
interface Authority {
  projectId:string;clientId:string;sessionId:string;workspaceVersion:number;configurationGeneration:string;controlEpoch:number;
  /** Whole current binding/source/permissions vector. Never persisted or sent as authority. */
  stamp:string;allowed:boolean;
}
interface Entry {projectId:string;request:ServicePrepareRequest;receipt:PreparedReceipt|null;phase:'UNKNOWN'|'ABSENT'}
interface Store {version:1;clientId:string;entries:Entry[]}
type StoragePort=Pick<Storage,'getItem'|'setItem'>;
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const equal=(a:unknown,b:unknown):boolean=>a===b||!!a&&!!b&&typeof a==='object'&&typeof b==='object'&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&equal((a as Record<string,unknown>)[k],(b as Record<string,unknown>)[k]));
function request(v:unknown):v is ServicePrepareRequest {
  return exact(v,['requestId','clientId','sessionId','expectedWorkspaceVersion','configurationGeneration','controlEpoch'])&&
    ['requestId','clientId','sessionId','configurationGeneration'].every(k=>id(v[k]))&&
    ['expectedWorkspaceVersion','controlEpoch'].every(k=>Number.isSafeInteger(v[k])&&Number(v[k])>=0);
}
function receipt(v:unknown,projectId:string):v is PreparedReceipt {
  return exact(v,['schemaVersion','status','installationId','projectId','engineId','name','networkId'])&&v.schemaVersion===1&&v.status==='PREPARED'&&
    id(v.installationId)&&v.projectId===projectId&&typeof v.engineId==='string'&&v.engineId.length>0&&v.engineId.length<=256&&!/[\s\x00-\x1f\x7f]/.test(v.engineId)&&
    v.name===`paircoach-${v.installationId}-service`&&String(v.name).length<=80&&typeof v.networkId==='string'&&/^[a-f0-9]{64}$/.test(v.networkId);
}
function decode(raw:string|null):Store|null {
  if(raw===null)return null;
  if(raw.length>256*1024)throw Error('Zapis przygotowania przekracza limit; zachowaj magazyn.');
  const s:unknown=JSON.parse(raw);
  if(!exact(s,['version','clientId','entries'])||s.version!==1||!id(s.clientId)||!Array.isArray(s.entries)||s.entries.length>64||s.entries.some((e:unknown)=>
    !exact(e,['projectId','request','receipt','phase'])||!id(e.projectId)||!request(e.request)||e.request.clientId!==s.clientId||
    !['UNKNOWN','ABSENT'].includes(String(e.phase))||(e.receipt!==null&&!receipt(e.receipt,e.projectId))))throw Error('Niepoprawny zapis przygotowania; zachowaj magazyn, nie twórz nowego żądania.');
  if(new Set(s.entries.map(e=>e.projectId)).size!==s.entries.length)throw Error('Niejednoznaczny zapis przygotowania.');
  return s as unknown as Store;
}
export class ServicePreparationV2 {
  private store:Store={version:1,clientId:'',entries:[]};
  private raw:string|null=null;
  private storage?:StoragePort;
  private key='';
  private fault:string|null=null;
  private busy=false;
  private notice:{scope:string;message:string}|null=null;
  constructor(private readonly deps:{
    current():Authority|null;requestId():string;publish():void;
    post(body:ServicePrepareRequest):Promise<unknown>;
    /** NEW real authenticated GET /api/project, validated/current before synchronous install. */
    refresh(authority:Readonly<Authority>):Promise<boolean>;
    isAbsence(error:unknown):boolean;
  }) {}
  initialize(storage:StoragePort|undefined,key:string,clientId:string,priorError?:unknown) {
    this.storage=storage;this.key=key;this.store={version:1,clientId,entries:[]};
    try {
      if(priorError)throw priorError;
      if(!storage)throw Error('Brak trwałego magazynu przeglądarki. Przygotowanie zablokowane; ręczna edycja dostępna.');
      this.raw=storage.getItem(key);const saved=decode(this.raw);
      if(saved&&saved.clientId!==clientId)throw Error('Zapis przygotowania należy do innego klienta. Nie nadpisano oryginału.');
      if(saved)this.store=structuredClone(saved);
    } catch(error) {this.fault=String(error instanceof Error?error.message:error);}
  }
  private entry(a:Authority|null) {return a&&a.clientId===this.store.clientId?this.store.entries.find(e=>e.projectId===a.projectId):undefined;}
  snapshot():ServicePreparationState {
    const a=this.deps.current(),e=this.entry(a),uncertain=e?.phase==='UNKNOWN';
    return {pending:this.busy,blocked:this.busy||!!this.fault&&!!this.storage||uncertain,uncertain,
      canPrepare:!!a?.allowed&&!this.busy&&!this.fault&&!uncertain,
      canReconcile:!!a?.allowed&&!this.busy&&!this.fault&&uncertain,
      message:this.fault??(this.notice&&this.notice.scope===a?.projectId?this.notice.message:null)??(uncertain?'Wynik przygotowania nieznany. „Dokończ przygotowanie” wyśle dokładnie oryginalne żądanie. Jeśli serwer go nie otrzymał, może wykonać pierwsze przygotowanie; wcześniej przyjęte żądanie zostanie uzgodnione bez ponownego tworzenia.':e?.phase==='ABSENT'?'Potwierdzono brak wykonania lub środowiska. Nowe przygotowanie wymaga osobnego kliknięcia.':null)};
  }
  private persist(next:Store) {
    if(!this.storage||this.fault)throw Error(this.fault??'Brak trwałego magazynu.');
    try {
      // Also fences another tab/instance: never overwrite a newly retained original.
      if(this.storage.getItem(this.key)!==this.raw)throw Error('Zapis przygotowania zmienił się w innej karcie. Zachowaj oryginał; odśwież połączenie bez nowego przygotowania.');
      const raw=JSON.stringify(next);this.storage.setItem(this.key,raw);
      if(this.storage.getItem(this.key)!==raw)throw Error('Nie potwierdzono utrwalenia oryginalnego żądania.');
      this.raw=raw;this.store=next;
    } catch(error) {this.fault=error instanceof Error?error.message:String(error);throw error;}
  }
  private replace(e:Entry|null,projectId:string) {
    const next=structuredClone(this.store);next.entries=next.entries.filter(old=>old.projectId!==projectId);
    if(e)next.entries.push(structuredClone(e));
    if(next.entries.length>64)throw Error('Limit zachowanych przygotowań. Nie usunięto nierozstrzygniętych żądań.');
    this.persist(next);
  }
  private current(a:Authority):boolean {return equal(this.deps.current(),a)&&a.allowed;}
  async perform(reconcile=false):Promise<boolean> {
    const view=this.snapshot(),a=this.deps.current();
    if(!a||!(reconcile?view.canReconcile:view.canPrepare))return false;
    this.busy=true;this.notice=null;this.deps.publish();
    let original=this.entry(a);
    try {
      if(!reconcile) {
        const body:ServicePrepareRequest={requestId:this.deps.requestId(),clientId:a.clientId,sessionId:a.sessionId,
          expectedWorkspaceVersion:a.workspaceVersion,configurationGeneration:a.configurationGeneration,controlEpoch:a.controlEpoch};
        if(!id(a.projectId)||!request(body))throw Error('Brak poprawnego bieżącego powiązania sesji.');
        original={projectId:a.projectId,request:body,receipt:null,phase:'UNKNOWN'};
        // Original FULL body is durably retained and read back BEFORE the only dispatch.
        this.replace(original,a.projectId);
      }
      if(!original||!this.current(a))throw Error('Zakres zmienił się; zachowano oryginalne żądanie.');
      const value=await this.deps.post(structuredClone(original.request));
      if(!receipt(value,a.projectId)||!this.current(a)||original.receipt&&!equal(original.receipt,value))
        throw Error('Niepoprawna lub nieaktualna odpowiedź przygotowania. Zachowano oryginalne żądanie.');
      this.replace({...original,receipt:structuredClone(value)},a.projectId);
      // PREPARED is not READY, not even when this receipt was already known.
      if(!await this.deps.refresh(a)||!this.current(a))throw Error('Przygotowanie potwierdzone, lecz nie odświeżono bieżącej gotowości. Wybierz „Dokończ przygotowanie” dla tego samego żądania, bez nowego identyfikatora.');
      this.replace(null,a.projectId);
      this.notice={scope:a.projectId,message:'Przygotowanie potwierdzone. Odczytano bieżącą gotowość; sprawdź osobno program i testy poniżej.'};
      return true;
    } catch(error) {
      if(original&&this.current(a)&&this.deps.isAbsence(error)) {
        try {this.replace({...original,phase:'ABSENT'},a.projectId);
          this.notice={scope:a.projectId,message:'Potwierdzono brak wykonania lub środowiska. Nie ponowiono przygotowania. Nowa próba wymaga osobnego kliknięcia „Przygotuj środowisko”.'};
        } catch { /* Persistence fault remains a closed fence. */ }
      } else this.notice={scope:a.projectId,message:(error instanceof Error?error.message:String(error))+' Ręczna edycja pozostaje dostępna.'};
      return false;
    } finally {this.busy=false;this.deps.publish();}
  }
}
