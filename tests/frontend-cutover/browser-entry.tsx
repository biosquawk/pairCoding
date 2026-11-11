import React from 'react';
import {createRoot} from 'react-dom/client';
import * as monaco from 'monaco-editor';
import {client} from '../../src/services/PairCoachClient';
(window as any).cutoverInspect=()=>({state:client.getState(),models:monaco.editor.getModels().map(m=>({uri:m.uri.toString(),version:m.getVersionId(),value:m.getValue()})),editors:monaco.editor.getEditors().map(e=>({readOnly:e.getOption(monaco.editor.EditorOption.readOnly),model:e.getModel()?.uri.toString(),focus:e.hasTextFocus()})),wire:(window as any).cutoverWire});
import App from '../../src/App';
import '../../src/index.css';
createRoot(document.getElementById('root')!).render(<App/>);
