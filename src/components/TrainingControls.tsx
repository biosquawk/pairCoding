import {useEffect,useState} from 'react';
import type {PairCoachClient} from '../services/PairCoachClient';
import type {ClientState} from '../services/liveTypes';

/** Presentation of existing timer and coach policy; never grants consent or unmutes. */
export function TrainingControls({client,state,onSettings}:{client:PairCoachClient;state:ClientState;onSettings:()=>void}) {
  const text=(pl:string,en:string)=>state.locale==='en'?en:pl;
  const [pending,setPending]=useState(false),[notice,setNotice]=useState('');
  useEffect(()=>{setPending(false);setNotice('');},[state.sessionStatus,state.durableProject?.exercisePath,state.isOffline,state.connectionError]);
  useEffect(()=>{
    if(!pending)return;
    const timer=setTimeout(()=>{setPending(false);setNotice(text('Nie potwierdzono wznowienia. Sprawdź połączenie; nie wznowiono automatycznie.','Resume was not confirmed. Check the connection; no automatic resume.'));},10000);
    return ()=>clearTimeout(timer);
  },[pending,state.locale]);
  const paused=state.sessionStatus==='PAUSED',stopped=state.sessionStatus==='STOPPED';
  const status=state.isOffline?text('Brak połączenia z sesją.','Session disconnected.'):
    !state.projectSettings.aiConsent?text('Trener: brak zgody AI w tym folderze.','Coach: no AI consent in this folder.'):
    paused?text('Trening wstrzymany. Trener nie analizuje ani nie odpowiada podczas pauzy.','Training paused. The coach does not analyze or answer while paused.'):
    state.coachMode==='MUTED_MANUAL'?text('Trener wyciszony ręcznie. Wznowienie zegara nie wyłącza wyciszenia.','Coach manually muted. Resuming the timer does not unmute the coach.'):
    state.aiStatus==='FAILED'?text('Trener: awaria dostawcy AI. Sprawdź diagnostykę.','Coach: AI provider failed. Check diagnostics.'):
    state.aiStatus==='OFF'?text('Trener AI wyłączony lub niedostępny.','AI coach disabled or unavailable.'):
    state.coachMode==='COOLDOWN_AFTER_VETO'?text('Trener wstrzymany po wecie. Ręczna edycja pozostaje dostępna.','Coach paused after veto. Manual editing remains available.'):
    state.windowPresence!=='FOCUSED'?text('Trener czeka na aktywne okno treningu.','Coach is waiting for the focused training window.'):
    state.aiStatus==='THINKING'?text('Trener analizuje… (THINKING)','Coach is analyzing… (THINKING)'):
    state.coachMode==='ACTIVE_WATCHING'||state.coachMode==='INTERVENING'?text('Trener aktywny — reaguje zgodnie z polityką; nie analizuje każdego znaku.','Coach active — reacts according to policy, not on every keystroke.'):
    text('Trener oczekuje na rozpoczęcie treningu.','Coach is waiting for training to start.');
  const provider=state.aiStatus==='READY'?text('Dostawca AI: gotowy (READY), nie oznacza trwającej analizy.','AI provider: ready (READY), not an ongoing analysis.'):
    state.aiStatus==='THINKING'?text('Dostawca AI: THINKING','AI provider: THINKING'):
    state.aiStatus==='FAILED'?text('Dostawca AI: FAILED','AI provider: FAILED'):text('Dostawca AI: OFF','AI provider: OFF');
  return <section aria-label={text('Trening i trener','Training and coach')} className="p-2 border-b border-zinc-700 text-xs space-y-2 shrink-0">
    <p role="status">{status}</p><p className="text-zinc-400">{provider}</p>
    {(paused||stopped)&&<button type="button" className="pc-training-action pc-training-primary" disabled={pending||state.isOffline||state.writeOwner!=='STUDENT'} aria-busy={pending}
      onClick={()=>{if(pending)return;setPending(true);setNotice('');if(paused)client.resumeTimer();else client.startTimer();}}>
      {pending?text('Oczekiwanie na potwierdzenie…','Waiting for confirmation…'):paused?text('Wznów trening','Resume training'):text('Rozpocznij trening','Start training')}</button>}
    {!state.projectSettings.aiConsent&&<button type="button" className="pc-training-action" onClick={onSettings}>{text('Ustawienia zgody AI','AI consent settings')}</button>}
    {state.runtime?.pending==='RUN'&&<p role="status">{text('Run/Test: przygotowanie potwierdzonego wejścia i oczekiwanie na przyjęcie. Nie ponawiaj uruchomienia.','Run/Test: preparing acknowledged input and awaiting admission. Do not start another run.')}</p>}
    {notice&&<p role="alert">{notice}</p>}
  </section>;
}
