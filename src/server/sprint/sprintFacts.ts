import type {LearningPack,SprintState,SprintAttempt} from '../../shared/sprint';
import {currentAttempt} from '../../shared/sprint';
export function sprintContext(pack:LearningPack,s:SprintState|undefined,version:number) {
  if(!s||s.status!=='ACTIVE')return undefined;
  const attempt=currentAttempt(s),task=pack.tasks.find(t=>t.id===attempt.taskId);
  if(!task)return undefined;
  return {sprintId:s.sprintId,attemptId:attempt.attemptId,task:{id:task.id,topicId:task.topicId,difficulty:task.difficulty,title:task.title},
    candidates:pack.tasks.filter(t=>t.ready&&s.topics.includes(t.topicId)&&t.id!==task.id).map(t=>({id:t.id,title:t.title,topicId:t.topicId,difficulty:t.difficulty})),
    runs:attempt.runs.map(r=>({...r,current:r.inputVersion===version})),selfAssessment:attempt.selfAssessment,help:attempt.help,
    sources:pack.sources.filter(source=>task.sourceIds.includes(source.id))};
}
export type SprintCoachContext=NonNullable<ReturnType<typeof sprintContext>>;
export interface SprintReportFacts {sprint:SprintState;tasks:LearningPack['tasks'];sources:LearningPack['sources']}
export function sprintReportFacts(pack:LearningPack,s:SprintState):SprintReportFacts {
  const ids=new Set(s.attempts.map(a=>a.taskId));
  const tasks=pack.tasks.filter(t=>ids.has(t.id));
  const sources=pack.sources.filter(source=>tasks.some(t=>t.sourceIds.includes(source.id)));
  const {previous:_,...current}=s;
  return structuredClone({sprint:{...current,requests:[]},tasks,sources});
}
export function localSprintReport(f:SprintReportFacts,locale:'pl'|'en'):string {
  const en=locale==='en';
  const labels:Record<SprintAttempt['outcome'],string>=en?
    {IN_PROGRESS:'unfinished',TESTED:'test-confirmed',ASSISTED:'with help',DECLARED_SKIP:'declared skip',INTERRUPTED:'interrupted',REVIEW:'to review'}:
    {IN_PROGRESS:'nieukończone',TESTED:'potwierdzone testami',ASSISTED:'z pomocą',DECLARED_SKIP:'pominięcie zadeklarowane',INTERRUPTED:'przerwane',REVIEW:'do powtórki'};
  const lines=[en?'## Sprint summary':'## Podsumowanie sprintu',
    en?'Facts from all attempts; no mastery certificate.':'Fakty ze wszystkich prób; nie jest to certyfikat opanowania tematu.',
    ...f.tasks.map(t=>{
      const attempts=f.sprint.attempts.filter(a=>a.taskId===t.id);
      return '- '+t.title+': '+[...new Set(attempts.map(a=>labels[a.outcome]))].join(', ')+
        ' ('+attempts.flatMap(a=>a.runs).filter(r=>r.outcome==='PASSED').length+' PASSED; '+attempts.flatMap(a=>a.runs).filter(r=>r.outcome==='FAILED').length+' FAILED)';
    }),
    en?'### Review':'### Do powtórki',
    ...f.sprint.attempts.filter(a=>['REVIEW','INTERRUPTED'].includes(a.outcome)).slice(0,12).map(a=>'- '+(f.tasks.find(t=>t.id===a.taskId)?.title??a.taskId)),
    en?'### Flashcards':'### Fiszki',
    ...f.sources.slice(0,7).map(s=>'- '+s.section+': '+(s.quote??s.text.slice(0,160))),
    en?'### Glossary':'### Pojęcia',
    ...f.sources.slice(0,10).map(s=>'- '+s.section+' — '+s.sourceTitle),
    en?'### Interview questions':'### Pytania rekrutacyjne',
    ...f.sources.slice(0,4).map(s=>en?'- Explain '+s.section+' using your code.':'- Wyjaśnij '+s.section+' na przykładzie swojego kodu.'),
    en?'### Further practice':'### Dalsze zadania',
    ...f.tasks.slice(0,3).map(t=>en?'- Repeat independently: '+t.title:'- Powtórz samodzielnie: '+t.title)];
  if(!f.sources.length)lines.push(en?'Not in the supplied material.':'Brak w dostarczonym materiale.');
  return lines.join('\n');
}

export function projectSprintContext(c:SprintCoachContext):SprintCoachContext {
  return {sprintId:c.sprintId,attemptId:c.attemptId,task:{id:c.task.id,topicId:c.task.topicId,difficulty:c.task.difficulty,title:c.task.title},
    candidates:c.candidates.map(t=>({id:t.id,title:t.title,topicId:t.topicId,difficulty:t.difficulty})),
    runs:c.runs.map(r=>({runId:r.runId,inputVersion:r.inputVersion,outcome:r.outcome,testCount:r.testCount,current:r.current})),
    selfAssessment:c.selfAssessment,help:c.help,
    sources:c.sources.map(s=>({id:s.id,sourceKind:s.sourceKind,sourceTitle:s.sourceTitle,section:s.section,text:s.text,...(s.quote?{quote:s.quote}:{})}))};
}
