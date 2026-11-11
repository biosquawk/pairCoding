import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
// All editor code/workers are served locally. Never bootstrap a CDN behind the user's consent UI.
self.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if(label==='json') return new JsonWorker();
    if(label==='typescript'||label==='javascript') return new TsWorker();
    return new EditorWorker();
  },
};
loader.config({monaco});
