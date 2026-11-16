import {useEffect,useState,useRef} from 'react';
import type {PairCoachClient} from '../services/PairCoachClient';
import type {ClientState} from '../services/liveTypes';
import {currentAttempt,type SprintView,type SprintAction} from '../shared/sprint';
/** Presentation cache only; the leased durable backend owns attempts and transitions. */
export function SprintPanel({client,state}:{client:PairCoachClient;state:ClientState}) {
  const en=state.locale==='en',text=(pl:string,english:string)=>en?english:pl;
  const [view,setView]=useState<SprintView|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [level,setLevel]=useState(1),[minutes,setMinutes]=useState(45),[selectedTopics,setTopics]=useState<string[]|null>(null);
  const [more,setMore]=useState(false),[example,setExample]=useState(false),[startNew,setStartNew]=useState(false);
  const topics=selectedTopics??view?.pack.topics.slice(0,1).map(topic=>topic.id)??[];
  const pending=useRef(false);
  useEffect(()=>{
    let current=true;
    void client.readSprint().then(v=>{if(current)setView(v);}).catch(e=>{if(current)setError(String(e));});
    return ()=>{current=false;};
  },[client,state.durableProject?.exercisePath,state.durableProject?.sprint,state.activeRun?.runId]);
  const s=view?.sprint,a=s?currentAttempt(s):undefined,task=view?.pack.tasks.find(t=>t.id===a?.taskId);
  const action=async(kind:SprintAction,extra:object={})=>{
    if(pending.current)return;
    pending.current=true;setBusy(true);setError('');
    try {setView(await client.sprintAction(kind,extra));if(kind==='example')setExample(true);setStartNew(false);}
    catch(e){setError(e instanceof Error?e.message:String(e));try{setView(await client.readSprint());}catch{}}
    finally{pending.current=false;setBusy(false);}
  };
  const elapsed=s?.status==='ACTIVE'?Math.max(s.elapsedMs,state.elapsedMs):s?.elapsedMs??0;
  const passed=a?.runs.some(r=>r.outcome==='PASSED'&&r.inputVersion===state.workspaceVersion);
  const why:Record<string,string>={NO_EASIER_HINT_AVAILABLE:text('Brak prostszego wariantu — skorzystaj z przykładu.','No easier task — try an example.'),
    BUDGET_SUMMARY_OR_CONTINUE:text('Budżet wyczerpany: podsumuj lub świadomie wydłuż sprint.','Budget exhausted: summarize or explicitly extend.'),
    NO_AVAILABLE_TASK:text('Brak kolejnego dostępnego zadania.','No next available task.'),EASIER:text('Prostszy wariant','Easier variant'),
    HARDER:text('Trudniejszy wariant','Harder variant'),PASSED_NEXT:text('Świeże PASSED — następne zadanie','Fresh PASSED — next task'),
    AVAILABLE_IN_SELECTED_TOPICS:text('Dobór z wybranych tematów','Selected topics'),START:text('Poziom startowy','Starting level')};
  return <section aria-label={text('Sprint nauki','Learning sprint')} className="pc-sprint p-2 text-xs border-b border-zinc-700 space-y-2 shrink-0" aria-busy={busy}>
    {!view?<p>{text('Wczytywanie sprintu…','Loading sprint…')}</p>:!s||startNew?<>
      <strong>{view.pack.title}</strong>
      <label className="block">{text('Poziom','Level')} <select aria-label={text('Poziom startowy','Starting level')} value={level} onChange={e=>setLevel(Number(e.target.value))} className="bg-zinc-800">
        <option value={1}>{text('Początkujący','Beginner')}</option><option value={3}>{text('Średni','Intermediate')}</option><option value={5}>{text('Zaawansowany','Advanced')}</option></select></label>
      <label className="block">{text('Minuty','Minutes')} <input type="number" min={1} max={1440} value={minutes} onChange={e=>setMinutes(Number(e.target.value))} className="w-14 bg-zinc-800"/></label>
      <fieldset><legend>{text('Tematy','Topics')}</legend>{view?.pack.topics.map(topic=><label key={topic.id} className="block">
        <input type="checkbox" checked={topics.includes(topic.id)} onChange={e=>setTopics(e.target.checked?[...topics,topic.id]:topics.filter(t=>t!==topic.id))}/>{topic.title}</label>)}</fieldset>
      <button disabled={busy||!topics.length} onClick={()=>void action(s?'new':'start',{level,budgetMinutes:minutes,topics})}>{text('Rozpocznij sprint','Start sprint')}</button>
      {s&&<button onClick={()=>setStartNew(false)}>{text('Anuluj','Cancel')}</button>}
      <p>{text('Sprawdzone zadania:','Verified tasks:')} {view?.pack.tasks.filter(t=>t.ready).length}/{view?.pack.tasks.length}.</p>
    </>:<>
      <strong>{task?.title}</strong>
      <p>{view.pack.topics.find(t=>t.id===task?.topicId)?.title} · {text('trudność','difficulty')} {task?.difficulty}/5 · {Math.max(0,Math.ceil(s.budgetMinutes-elapsed/60000))} min</p>
      <p>{why[s.recommendation.reason]??s.recommendation.reason}</p>
      <p>{text('Rozwiązane','Test-confirmed')}: {s.attempts.filter(x=>x.outcome==='TESTED').length} · {text('z pomocą','with help')}: {s.attempts.filter(x=>x.outcome==='ASSISTED').length} · {text('pominięte','skipped')}: {s.attempts.filter(x=>x.outcome==='DECLARED_SKIP').length} · {text('do powtórki','review')}: {s.attempts.filter(x=>x.outcome==='REVIEW').length}</p>
      {s.budgetMinutes*60000<=elapsed&&s.status==='ACTIVE'&&<p>{text('Podsumowanie: użyj Zakończ, lub','Summary: use Finish, or')} <button disabled={busy||s.budgetMinutes>=1440} onClick={()=>void action('extend',{budgetMinutes:Math.min(1440,s.budgetMinutes+15)})}>{text('Kontynuuj +15 min','Continue +15 min')}</button></p>}
      {s.status==='SUSPENDED'?<button disabled={busy} onClick={()=>void action('resume')}>{text('Wznów sprint','Resume sprint')}</button>:s.status==='FINISHED'?<button onClick={()=>setStartNew(true)}>{text('Nowy sprint','New sprint')}</button>:<>
        <div className="flex flex-wrap gap-2" aria-label={text('Akcje zadania','Task actions')}>
          <button disabled={busy||state.isOffline} onClick={()=>void action('easier')}>{text('Łatwiejsze','Easier')}</button>
          <button disabled={busy||state.isOffline} onClick={()=>void action('example')}>{text('Przykład','Example')}</button>
          <button className="pc-training-primary" disabled={busy||state.isOffline} onClick={()=>void action('next')}>{text('Dalej','Next')}</button>
          <button disabled={busy} aria-expanded={more} onClick={()=>setMore(!more)}>{text('Więcej','More')}</button>
        </div>
        {more&&<div className="flex flex-wrap gap-2">{([['harder','Trudniejsze / Umiem to','Harder / I know this'],['deeper','Głębiej','Deeper'],['bugfix','Odpytaj','Find the bug']] as const).map(([kind,pl,eng])=>
          <button key={kind} disabled={busy} onClick={()=>void action(kind)}>{text(pl,eng)}</button>)}
          <select aria-label={text('Inny temat','Another topic')} value="" disabled={busy} onChange={e=>void action('topic',{topicId:e.target.value})}><option value="">{text('Inny temat','Another topic')}</option>
            {view.pack.topics.filter(t=>s.topics.includes(t.id)).map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select>
        </div>}
        {passed&&<label>{text('Pewność (opcjonalnie)','Confidence (optional)')} <select value={a?.selfAssessment??''} disabled={busy} onChange={e=>void action('selfAssess',{selfAssessment:Number(e.target.value)})}>
          <option value="">—</option>{[1,2,3,4,5].map(n=><option key={n} value={n}>{n}</option>)}</select></label>}
      </>}
      {example&&view.pack.sources.filter(source=>task?.sourceIds.includes(source.id)).map(source=><p key={source.id}>{source.section}: {source.text}</p>)}
      {!state.projectSettings.aiConsent&&<p>{text('AI: brak zgody w tym folderze. Ręczny trening i dobór działają.','AI: no consent in this folder. Manual practice and selection remain available.')}</p>}
    </>}
    {busy&&<p role="status">{text('Oczekiwanie na zapis i otwarcie…','Waiting for save and open…')}</p>}
    {error&&<p role="alert" className="text-amber-300">{error}</p>}
  </section>;
}
