// Pure source-template generation; no toolchain or Docker operations.
import { writeFileSync } from 'node:fs';
const list=[['javascript-node','node',null],['typescript-node','typescript',null],['python-3.13','python',null],...[11,17,21,27].map(r=>[`java-maven-${r}`,'java-maven',r])];
const field=(key,label,input,help,{choices=[],required=true,min=null,max=null}={})=>
  ({key,label,input,help,required,choices,min,max});
const choices=values=>values.map(value=>({value,label:value}));
// Entry-specific fields remain required: the neutral settings client only validates them
// for the selected discriminant. Test selectors cannot be globally required: Java paths
// and non-Java names MUST be empty, and RUN_MAIN may have no test-source selectors.
// RUN_TESTS non-Java source requirements remain enforced by the unchanged adapter.
const taskFields=(family,release)=>[
  field('workingDirectory','Task directory','PATH','Relative to immutable project input.'),
  field('entry.kind','Entry','CHOICE','Select task mode.',{choices:choices(release
    ? ['JAVA_MAIN',...([21,27].includes(release)?['SPRING_BOOT']:[]),'TESTS']
    : family==='python'?['SCRIPT','MODULE','TESTS']:['SCRIPT','TESTS'])}),
  ...(release
    ? [field('entry.className','Main class','TEXT','Required for JAVA_MAIN: fully qualified Java class.'),
       ...([21,27].includes(release)?[
         field('entry.containerPort','Service port','INTEGER','Required for SPRING_BOOT: container-local port.',{min:1,max:65535}),
         field('entry.healthPath','Health path','TEXT','Required for SPRING_BOOT: container-local HTTP readiness path.'),
       ]:[])]
    : [field('entry.path','Script','PATH','Required for SCRIPT: literal relative source path.'),
       ...(family==='python'?[field('entry.name','Module','TEXT','Required for MODULE: Python module name.')]:[])]),
  field('tests.paths','Test sources','PATH',release?'Must be empty for Maven.':'Literal relative test paths; required for RUN_TESTS.',{required:false}),
  field('tests.names','Test names','TEXT',release?'Optional exact Maven class or class#method names; empty selects all tests.':'Must be empty; select literal test sources instead.',{required:false}),
];
const profiles=list.map(([id,adapterFamily,release])=>({id,label:id,adapterFamily,imageLockKey:id,expectedTools:[{name:'node',version:'22.22.0'},...(adapterFamily==='typescript'?[{name:'typescript',version:'5.9.3'}]:adapterFamily==='python'?[{name:'python',version:'3.13.9'},{name:'pytest',version:'8.4.2'}]:release?[{name:'java',version:({11:'11.0.33',17:'17.0.21',21:'21.0.13',27:'27.0.1.0.2'})[release]},{name:'javac',version:({11:'11.0.33',17:'17.0.21',21:'21.0.13',27:'27.0.1.0.2'})[release]},{name:'maven',version:'3.9.12'}]:[])],compilerRelease:release,analysis:{languageLevel:release?String(release):adapterFamily==='python'?'3.13':'ES2022',preview:false},language:release?{provider:'jdt',imageLockKey:'jdt-runtime-27',serverJvm:'27.0.1.0.2'}:adapterFamily==='python'?{provider:'pylsp',imageLockKey:'pylsp-runtime-3.13',serverJvm:null}:{provider:'builtin',imageLockKey:null,serverJvm:null},taskFields:taskFields(adapterFamily,release)}));
writeFileSync('runtimes/catalog.json',JSON.stringify({schemaVersion:1,profiles},null,2)+'\n');
for(const [dir,entry,paths,names] of [
 ['javascript-counter',{kind:'SCRIPT',path:'main.js'},['counter.test.js'],[]],
 ['typescript-counter',{kind:'SCRIPT',path:'main.ts'},['counter.test.ts'],[]],
 ['python-calculator',{kind:'SCRIPT',path:'calculator.py'},['test_calculator.py'],[]],
 ['java-pattern',{kind:'JAVA_MAIN',className:'demo.StrategyDemo'},[],['demo.StrategyDemoTest']],
 ['spring-counter',{kind:'SPRING_BOOT',containerPort:8080,healthPath:'/sum'},[],['demo.CounterApplicationTest']]
]) writeFileSync(`examples/${dir}/task.v2.json`,JSON.stringify({runProfiles:['RUN_MAIN','RUN_TESTS'].map(kind=>({kind,timeoutMs:120000,task:{workingDirectory:'.',entry,tests:{paths,names}}}))},null,2)+'\n');
