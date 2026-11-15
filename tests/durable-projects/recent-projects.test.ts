import assert from 'node:assert/strict';
import {test} from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseRecentProjects, rememberProject, RECENT_PROJECTS_LIMIT} from '../../src/services/recentProjects';
import {RecentProjects} from '../../src/components/RecentProjects';
import {setUiLocale} from '../../src/i18n';

const a={name:'Ćwiczenie A',projectFile:'/workspace/zadania A/ćwiczenie.paircoding.json'};
const b={name:'Ćwiczenie B',projectFile:'/workspace/B/learning.paircoding.json'};

test('recent project persistence keeps most recent unique paths, updated names, and ten entries',()=>{
  let entries=rememberProject([],a);
  entries=rememberProject(entries,b);
  entries=rememberProject(entries,{...a,name:'Nowa nazwa A'});
  assert.deepEqual(entries,[{...a,name:'Nowa nazwa A'},b]);
  assert.deepEqual(parseRecentProjects(JSON.stringify(entries)),entries);
  const completeProject={...a,workspace:{unrelated:'x'.repeat(100000)}};
  assert.deepEqual(rememberProject([],completeProject),[a],'workspace size/content is never serialized into recent metadata');
  for(let i=0;i<20;i++)entries=rememberProject(entries,{name:`P${i}`,projectFile:`/P${i}.paircoding.json`});
  assert.equal(entries.length,RECENT_PROJECTS_LIMIT);
  assert.equal(entries[0].name,'P19');assert.equal(entries.at(-1)!.name,'P10');
});

test('corrupt or unrelated browser storage cannot inject invalid entries or unknown fields',()=>{
  for(const text of [null,'{','null','{}','x'.repeat(65537)])assert.deepEqual(parseRecentProjects(text),[]);
  const entries=parseRecentProjects(JSON.stringify([
    null,{name:'',projectFile:a.projectFile},{name:'other',projectFile:'/not-a-project.txt'},
    {name:'control\n',projectFile:b.projectFile},{name:'bad path',projectFile:'/a\n.paircoding.json'},
    {...a,token:'must never persist'},a,b,
  ]));
  assert.deepEqual(entries,[a,b]);
  assert.deepEqual(parseRecentProjects(JSON.stringify([{name:'Windows',projectFile:'C:\\Tasks\\Training.paircoding.json'}])),
    [{name:'Windows',projectFile:'C:\\Tasks\\Training.paircoding.json'}]);
});

test('recent project UI shows actual names/paths and accessible open/remove buttons in both locales',()=>{
  try {
    for(const locale of ['pl','en'] as const) {
      setUiLocale(locale);
      const html=renderToStaticMarkup(React.createElement(RecentProjects,{projects:[a,b],disabled:false,
        storageUnavailable:false,onOpen:()=>{},onRemove:()=>{}}));
      assert.ok(html.includes(a.projectFile));assert.match(html,/Ćwiczenie A/);
      assert.match(html,locale==='pl'?/Otwórz ostatni projekt: Ćwiczenie A/:/Open recent project: Ćwiczenie A/);
      assert.match(html,locale==='pl'?/Usuń z ostatnich: Ćwiczenie A/:/Remove from recent projects: Ćwiczenie A/);
      assert.doesNotMatch(html,/disabled=""/);
    }
  }finally{setUiLocale('pl');}
});

test('busy/offline controls cannot submit a recent open; unavailable browser storage remains explicit',()=>{
  const html=renderToStaticMarkup(React.createElement(RecentProjects,{projects:[a],disabled:true,storageUnavailable:true,
    onOpen:()=>{},onRemove:()=>{}}));
  assert.equal((html.match(/disabled=""/g)??[]).length,2);
  assert.match(html,/role="status"/);assert.match(html,/Nie można zapamiętać/);
  const empty=renderToStaticMarkup(React.createElement(RecentProjects,{projects:[],disabled:false,storageUnavailable:false,
    onOpen:()=>{},onRemove:()=>{}}));
  assert.match(empty,/Otwórz projekt raz/);assert.doesNotMatch(empty,/<button/);
});
