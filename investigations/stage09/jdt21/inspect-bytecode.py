"""Read-only JVM class-file inspection, not Java execution or a compiler test.
Only standard-library ZIP/tar/binary parsing. Fails on unknown constant tags.
"""
import io, json, struct, tarfile, zipfile, hashlib, pathlib
ROOT = pathlib.Path(__file__).parent
PIN = json.loads((ROOT/'artifacts.json').read_text())
class Reader:
    def __init__(self, data): self.data, self.pos = data, 0
    def take(self,n):
        b=self.data[self.pos:self.pos+n]
        if len(b)!=n: raise ValueError('truncated class')
        self.pos+=n
        return b
    def u(self,n): return int.from_bytes(self.take(n),'big')

def parse_class(data):
    r=Reader(data)
    assert r.u(4)==0xcafebabe
    minor,major=r.u(2),r.u(2)
    count=r.u(2); cp=[None]*count; i=1
    while i<count:
        t=r.u(1)
        if t==1: cp[i]=('Utf8',r.take(r.u(2)).decode('utf8',errors='replace'))
        elif t in (3,4): cp[i]=('Integer' if t==3 else 'Float',r.u(4))
        elif t in (5,6): cp[i]=('Long' if t==5 else 'Double',r.u(8));i+=1
        elif t in (7,8,16,19,20): cp[i]=('Index',r.u(2))
        elif t in (9,10,11,12,17,18): cp[i]=('Pair',r.u(2),r.u(2))
        elif t==15: cp[i]=('Handle',r.u(1),r.u(2))
        else: raise ValueError(f'unknown constant tag {t}')
        i+=1
    def sym(i):
        x=cp[i]
        if x[0]=='Utf8': return x[1]
        if x[0] in ('Integer','Long','Float','Double'): return x[1]
        if x[0]=='Index': return sym(x[1])
        if x[0]=='Pair': return [sym(x[1]),sym(x[2])]
        return list(x)
    r.take(6); r.take(2*r.u(2))
    def attrs():
        out={}
        for _ in range(r.u(2)):
            name=sym(r.u(2));out[name]=r.take(r.u(4))
        return out
    for _ in range(r.u(2)): r.take(6); attrs()
    methods={}
    for _ in range(r.u(2)):
        r.u(2); name=sym(r.u(2)); desc=sym(r.u(2));a=attrs()
        if 'Code' in a:
            c=Reader(a['Code']); c.take(4);code=c.take(c.u(4)); methods[(name,desc)]=code
    return sym,methods,major,minor

# Operand widths for all nonvariable JVM instructions.
WIDTH={**{x:1 for x in [0x10,0x12,0xa9,0xbc]}, **{x:1 for x in range(0x15,0x1a)},
       **{x:1 for x in range(0x36,0x3b)}, **{x:2 for x in [0x11,0x13,0x14,0x84,0xbb,0xbd,0xc0,0xc1]},
       **{x:2 for x in range(0x99,0xa9)}, **{x:2 for x in range(0xb2,0xb9)},
       0xb9:4,0xba:4,0xc5:3,0xc6:2,0xc7:2,0xc8:4,0xc9:4}
NAMES={0x12:'ldc',0x13:'ldc_w',0x14:'ldc2_w',0x94:'lcmp',0x9c:'ifge',0x99:'ifeq',0x9a:'ifne',
       0xa7:'goto',0xb2:'getstatic',0xb4:'getfield',0xb6:'invokevirtual',0xb8:'invokestatic',
       0x02:'iconst_m1',0x03:'iconst_0',0x04:'iconst_1',0x05:'iconst_2',0xac:'ireturn',0xad:'lreturn'}
CP_OPS={0x12,0x13,0x14,0xb2,0xb3,0xb4,0xb5,0xb6,0xb7,0xb8,0xb9,0xba,0xbb,0xbd,0xc0,0xc1,0xc5}
def instructions(code,sym):
    p=0;out=[]
    while p<len(code):
        at=p;op=code[p];p+=1;n=WIDTH.get(op,0)
        if op in (0xaa,0xab):
            p+=(4-p%4)%4;p+=4
            if op==0xaa:
                low,high=struct.unpack('>ii',code[p:p+8]);p+=8+4*(high-low+1)
            else:
                pairs=int.from_bytes(code[p:p+4],'big');p+=4+8*pairs
            n=p-at-1;p=at+1
        elif op==0xc4: n=5 if code[p]==0x84 else 3
        raw=code[p:p+n];p+=n
        if p>len(code):raise ValueError('truncated opcode')
        item={'offset':at,'op':NAMES.get(op,f'0x{op:02x}'),'bytes':bytes([op]).hex()+raw.hex()}
        if op in CP_OPS: item['constant']=sym(int.from_bytes(raw[:1 if op==0x12 else 2],'big'))
        if op in range(0x99,0xa9) or op in (0xc6,0xc7):item['target']=at+int.from_bytes(raw,'big',signed=True)
        out.append(item)
    return out

def inspect(archive):
    with open(archive,'rb') as f: archive_hash=hashlib.file_digest(f,'sha256').hexdigest()
    if archive_hash!=PIN['archiveSha256']:raise ValueError('archive hash mismatch')
    a=next(a for a in PIN['artifacts'] if 'compiler.batch_' in a['path'])
    with tarfile.open(archive) as t:b=t.extractfile(a['path']).read()
    assert hashlib.sha256(b).hexdigest()==a['sha256']
    z=zipfile.ZipFile(io.BytesIO(b));result={'artifact':a['path'],'sha256':a['sha256'],'methods':[]}
    for file,method in [('org/eclipse/jdt/internal/compiler/problem/ProblemReporter.class','previewAPIUsed'),
                        ('org/eclipse/jdt/internal/compiler/classfmt/ClassFileConstants.class','getLatestJDKLevel')]:
        cb=z.read(file);sym,methods,major,minor=parse_class(cb)
        for (name,desc),code in methods.items():
            if name==method:result['methods'].append(dict(classFile=file,classSha256=hashlib.sha256(cb).hexdigest(),major=major,minor=minor,name=name,descriptor=desc,codeSha256=hashlib.sha256(code).hexdigest(),instructions=instructions(code,sym)))
    assert len(result['methods'])==2
    return result
if __name__=='__main__':
    import sys
    if len(sys.argv)!=2:raise SystemExit('usage: inspect-bytecode.py READ_ONLY_PINNED_ARCHIVE')
    print(json.dumps(inspect(sys.argv[1]),indent=2))
