// Local rendering fixture: REAL EditorPanel + Monaco; no backend/model integration claim.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorPanel } from '../../../src/components/EditorPanel';
import { client } from '../../../src/services/PairCoachClient';
import '../../../src/index.css';
function Fixture() {
  const [width, setWidth] = useState(900), [height, setHeight] = useState(650);
  const [hint, setHint] = useState(false), [long, setLong] = useState(false), [generation, setGeneration] = useState(0);
  const initial = client.getState();
  const [content, setContent] = useState(Array.from({ length: 100 }, (_, i) => `value_${i} = ${i}  # active code remains visible`).join('\n'));
  const [position, setPosition] = useState('');
  return <main className="bg-zinc-950 text-zinc-100 h-screen p-2 flex flex-col gap-2">
    <h1>Kontrola kontenera wskazówki — actual EditorPanel/Monaco (fixture UI)</h1>
    <div className="flex gap-2 flex-wrap text-xs">
      <label>Szerokość kontenera<input aria-label="Szerokość kontenera" type="range" min="100" max="1200" value={width} onChange={e => setWidth(+e.target.value)} /></label>
      <label>Wysokość kontenera<input aria-label="Wysokość kontenera" type="range" min="90" max="800" value={height} onChange={e => setHeight(+e.target.value)} /></label>
      <button onClick={() => {setHint(true); setGeneration(g => g + 1);}}>Pokaż wskazówkę</button>
      <button onClick={() => setLong(x => !x)}>Długi tekst</button><output aria-label="Pozycja callback">{position}</output>
    </div>
    <section aria-label="Kontener edytora" style={{ width, height, maxWidth: '100%', maxHeight: 'calc(100vh - 120px)', flexShrink: 0 }}>
      <EditorPanel projectId={initial.scenario.id} files={[{ path: 'main.py', kind: 'FILE', content, version: 1, loaded: true }]} openTabs={['main.py']} activePath="main.py" writeOwner="STUDENT" controlEpoch={initial.controlEpoch}
        fileConflict={null} activePointer={null} activeHintBubble={hint ? { id: `hint-${generation}`, documentVersion: 1, createdAt: 0, path: 'main.py', line: 1, severity: 'NEUTRAL', text: long ? ('BardzoDługiTekstBezSpacji'.repeat(50) + '\n').repeat(8) : 'Sprawdź aktywną linię. Przesuń wskazówkę lub ją zamknij.' } : null}
        activeProposal={null} isBottomPanelVisible={false} activeBottomTab="chat" onSelectTab={() => {}} onCloseTab={() => {}} onContentChange={(_path, value) => setContent(value)} onDismissBubble={() => setHint(false)} onBubblePosChange={(x, y) => setPosition(`${x},${y}`)} onProposalResponse={() => {}} onResolveConflict={() => {}} />
    </section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
