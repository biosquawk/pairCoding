import React from 'react';
import {createRoot} from 'react-dom/client';
import * as monaco from 'monaco-editor';
import {client} from '../../src/services/PairCoachClient';
(window as any).cutoverInspect=()=>({state:client.getState(),models:monaco.editor.getModels().map(m=>({uri:m.uri.toString(),version:m.getVersionId(),value:m.getValue()})),editors:monaco.editor.getEditors().map(e=>({readOnly:e.getOption(monaco.editor.EditorOption.readOnly),model:e.getModel()?.uri.toString(),focus:e.hasTextFocus()})),markers:monaco.editor.getModelMarkers({}).map(m=>({message:m.message,uri:m.resource.toString()})),wire:(window as any).cutoverWire});
(window as any).cutoverInactiveValues=()=>monaco.editor.getModels().map(m=>({uri:m.uri.toString(),value:m.getValue()}));
import App from '../../src/App';
import '../../src/index.css';
createRoot(document.getElementById('root')!).render(<App/>);
