import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimeSettingsV2 } from '../../src/components/RuntimeSettingsV2';
import { RuntimeStatusV2 } from '../../src/components/RuntimeStatusV2';
import type { ProjectV2, RunV2 } from '../../src/shared/runtime-v2';
import '../../src/index.css';
declare global { interface Window { runtimeFixture: { project: ProjectV2; run: RunV2 } } }
function Fixture() {
  const p = window.runtimeFixture.project;
  const [open,setOpen]=useState(false),[version,setVersion]=useState(1),[connected,setConnected]=useState(true),[canSave,setCanSave]=useState(true),[legacy,setLegacy]=useState(false),[scenario,setScenario]=useState('ready'),[success,setSuccess]=useState(false),[generation,setGeneration]=useState('cfg1');
  const execution={...p.capabilities.execution,runtime:{...p.capabilities.execution.runtime,configurationGeneration:generation}};
  const [activeRun,setRun]=useState<RunV2|null>(null),[saves,setSaves]=useState(0),[saved,setSaved]=useState('');
  return <main className="max-w-3xl mx-auto p-3 space-y-3">
    <h1>Test komponentów Runtime V2 — transport kontrolowany</h1>
    <div className="flex flex-wrap gap-2">
      <button onClick={()=>setConnected(v=>!v)}>Przełącz offline</button><button onClick={()=>setCanSave(v=>!v)}>Przełącz uprawnienie</button><button onClick={()=>setVersion(v=>v+1)}>Zmień wersję</button>
      <button onClick={()=>{setLegacy(true);setOpen(true);}}>Legacy</button><button onClick={()=>setScenario('loading')}>Ładowanie</button><button onClick={()=>setScenario('ready')}>Gotowy</button>
      <button onClick={()=>setSuccess(true)}>Potwierdź następny zapis</button><button onClick={()=>setGeneration(v=>v+'x')}>Zmień generację</button>
      <button onClick={()=>setRun({...window.runtimeFixture.run,status:'PROCESS_STOP_UNCONFIRMED',processProblem:{code:'PROCESS_STOP_UNCONFIRMED',message:'Brak kontaktu.',recovery:'Przywróć połączenie i ponów Stop.',retryable:true}})}>Niepotwierdzony Stop</button>
    </div>
    <RuntimeStatusV2 execution={scenario==='loading'?null:execution} language={p.capabilities.language} run={activeRun} connected={connected} canExecute={true}
      onRun={()=>setRun(window.runtimeFixture.run)} onStop={id=>{setSaved(`Stop ${id}`);setRun({...window.runtimeFixture.run,status:'CANCELLED',finishedAt:'2026-11-11T22:00:00Z'});}} onSettings={()=>setOpen(true)} />
    <label>Ręczna edycja<input className="block border" aria-label="Ręczna edycja" /></label>
    <output aria-label="Zapisy">{saves}</output><output className="block [overflow-wrap:anywhere]" aria-label="Wynik testu">{saved}</output>
    <RuntimeSettingsV2 open={open} settings={legacy?{legacy:true}:p.settings} migrationDraft={p.settings} execution={execution} expectedWorkspaceVersion={version} connected={connected} canSave={canSave} onClose={()=>{setOpen(false);setLegacy(false);}}
      onSave={async next=>{setSaves(n=>n+1);await new Promise(r=>setTimeout(r,100));setSaved(JSON.stringify(next));return success?{ok:true,project:{...p,settings:next,workspaceVersion:version+1}}:{ok:false,message:'409 VERSION_CONFLICT — zachowaj formularz'};}} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
