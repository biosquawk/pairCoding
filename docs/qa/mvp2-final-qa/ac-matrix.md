> **HISTORYCZNY dokument / dowody dokładnie ówczesnych rewizji.** Ten plik nie
> opisuje bieżącego providera ani statusu wydania. Aktualne: [README](../../../README.md),
> [Windows start (w tym raport §7)](../../../docs/windows-start.md). ETAP8 IMPLEMENTED /
> PENDING_FINAL_QA; pełna kampania po implementacji9. Poniższe oryginalne wyniki,
> w tym FAIL/NOT_RUN, pozostają bez zmian i nie są nowym PASS.

# Macierz końcowa AC/TEST001..027 — stan przygotowania, nie certyfikat

Kryterium: oryginalny pasted-text-1.txt §5..7 oraz HUMAN67ce0485 (AC027/file2§9),
a3b804e0 (rzeczywiste GUI001..003), dae99189 (MVP2, UI UNKNOWN po5s/recovery),
f36d5244 (requestId/WORKSPACE_BUSY oracle, bez wydłużania produkcyjnego5s).
QUALITY_AND_SCOPE i SKILL_MOSCOW przeczytane. P3 nie zmienia produktu.

Bieżący odczytany produkt55baa0556cc7cc683c794365a7980aff4b04377f.
FinalnyQAsha z P6testpatch i P2browser jeszcze NIE PRZYDZIELONY.
Wynik P3 na55baa:6harnessPASS/discovery19PASS/capabilityPASS/tsc/buildPASS,
NIE19GUI ani27ACPASS. Kolumna „native do wykonania” nie przenosi starych wyników na55baa.
K nie zlecił powtarzania odebranych, niezmienionych G1/G2/29 ani native60821+3.

## Dowody istniejące, odczytane osobno

Lokatory względem SharedDesk (nie kopiować raw evidence do paczki klienta):
- **G1** worktrees/_operator/paircoach-windows/browser-7af2ad6/operator-summary.json:
  exact7af2ad694ebba5bbfb584f3a85c99520376a3390, native Node25/Edge,5/5PASS,0flaky/skip.
- **G2a** worktrees/_operator/paircoach-windows/g2-5decc90/operator-summary.json:
  exact5decc9032a1162fc0e406280e1f436055b42f112,4PASS1FAIL (whitespace fixture).
- **G2b** worktrees/_operator/paircoach-windows/g2-867cbfb-012/operator-summary.json:
  exact867cbfb2da642d5d82989dd61d2d860038f319c8, tylkoTEST0121PASS;4inne cases byte-identical do5de.
  To4+1 z dwóch wykonań, NIE jednolite nowe5/5.
- **C11** worktrees/_operator/paircoach-windows/controls-ea77401/operator-summary.json:
  exactea77401978718831bf236a511c2b365300bac066,2/2nativeAC011controlsPASS; wcześniejszy3fe1PASS1FAIL zachowany.
- **REC** deliveries/operator_evidence/paircoach-g3-async-608e37c/README.md,
  native-crash-receipt.json i native-oracle-30s.log: exact608e37c1c76a2a47061fce2aeca1961ce24cccc8,
  21/21native hardkill/restart (27kills/43restartreceipts) i3/3scoped REST/WS;
  testowe30sACK/40s guard w2restore, requestId oracle; produkcyjne5s bez zmian.
- **RECON** deliveries/operator_evidence/paircoach-mvp2-c3ed01e/README.md i transport-native.log:
  exactc3ed01e717c3204d14f60ff9e20ed449e9dc7f3b + jawny4-filetestpatch,
  14/14native transport/client, cztery osobne procesy6.5s; NIE kliknięcia React/Monaco.
- **PREVIEW** deliveries/operator_evidence/paircoach-preview-216ec60/:
  HUMANca9766f2: realny native backend/GUI→Codex reply na216ec607ae108742a7e145207475f0422f4c33d6.
  Dowód realnego dostawcy MVP1, nie pełne MVP2/Gemini ani100metryk.

## 27 pozycji — stabilne oracles i dokładny brak

Pliki testowe poniżej są względne do repo. Każdy przypadek P3 ma realserver/REST/WS/GUI/files;
AI-only injection jest jawny. Ściślejszy wynik musi pochodzić z odebranego finalSHA, nie z liczb discovery.

|AC/TEST|Niezależny wynik i kontrola|Dowód już istniejący|Native do wykonania / status|
|---|---|---|---|
|001|Markdown-only→GUI folder→task→CREATE i freshACK/disk, bez buildtool|backend historyczny; brak pełnegoGUI|g3/g3-basics.ts TEST001; NOT_RUN|
|002|4 języki kolorowane, tab/cursor/scroll/Undo; plaintext negatywny|sam languageId nie wystarcza|g3-basics TEST002; NOT_RUN|
|003|missing404/binary400/>1MiB413 konkretne GUI, bajty bez zmian;1MiB200 pełne|historyczne HTTP granice|g3-basics TEST003; NOT_RUN|
|004|single-flight/opóźnionyACK/refresh bez double apply|G1 nativePASS|Nie powtarzać bez zmiany; finalną zgodność delty rozstrzyga K|
|005|IDE+pending draft→obie wersje i konflikt|G1 nativePASS|Nie powtarzać bez zmiany; P2 nowe restore-conflict jest odrębne|
|006|Undo/Redo cały pokaz, własna historia osobno|G1 nativePASS|Nie powtarzać bez zmiany|
|007|slowAI nie blokuje typing/save; staleEDITdeny/freshworks|G2a nativePASS|Nie powtarzać niezmienionegoG2|
|008|COACH readOnly lecz zaznacz/copy/scroll; zakres nie z kursora|G2a nativePASS|Nie powtarzać niezmienionegoG2|
|009|HINT bez owner/focussteal; stale anchor wygasa|G2a nativePASS|Nie powtarzać niezmienionegoG2|
|010|cutoff starej epoki, idempotentne weto|G1 i scopedcore;100czasów brak|AC027 wymagany full100, nie pojedynczy pomiar|
|011|draft przedACK nie ginie; legalny konflikt dopiero po decyzji|G1+C11 nativePASS; historiaFAILzachowana|Nie rerun2controls. Full100 zachowuje jawnyKEEP_LOCAL+matchingACK|
|012|scroll/wait/whitespace nie wybudza; świeży kod+2s/CHAT/Run wybudza|G2a4PASS1FAIL + G2b tylko012PASS|Nie relabel staregoFAIL ani nie rerun G2|
|013|Nie zamyka oba widoki, pliki/list/timer bez skutku|brak browser|g3/g3.spec.ts TEST013; NOT_RUN|
|014|ten samproposal/innymsg→raz; używalny backup; timer bez resetu|REC scopedRESTWS nieGUI|g3.spec TEST014; NOT_RUN|
|015|expiry/stale/realOSbackupdeny→STALE_PROPOSAL bez mutacji|6harness nie jest productreceipt|g3.spec3cases, realTTL60s/OSdeny; NOT_RUN|
|016|realhidden pause=true; veto/manualpause pamiętane, zeroAIwrites|modułowe dowody nieGUI|g3.spec TEST016; NOT_RUN|
|017|pause=false clock rośnie, delayedAI aborted/no hiddenedit; freshworks|brak GUI|g3.spec TEST017; NOT_RUN|
|018|1s→jednaOVERTIME notice, nadal pisanie+ACK/disk|brak GUI|g3.spec TEST018; NOT_RUN|
|019|missingprofile/NO_TESTS/UNKNOWN odróżnione, nigdy fakePASSED|Runner29 historycznie odebrane; capability missing409|g3.spec TEST019 z realnymi child; NOT_RUN|
|020|GUIStop/timeout całeownedtree; UItyping; niezależnysentinel żywy|Runner native29 historycznie odebrane, nie finalGUI|g3.spec2cases z realnymi procesami; NOT_RUN|
|021|CODE_REVIEW tylko notes, human finding zachowane, no falseallbugs|provider/module nie dowodzi jakości recenzji|g3.spec TEST021 z jawnieAI-onlyseam; NOT_RUN|
|022|świeżyJUnit1PASSED+exit0 nie kończy; można pisać|Runner29 scoped nieGUI|g3.spec TEST022; NOT_RUN|
|023|finish202PENDING; prawdziweRun/coach/veto i frozen snapshot/facts; późniejsze bytes nie zmieniają|REC+RECON scoped nieGUI|g3.spec2cases COMPLETED/ABANDONED; NOT_RUN; P2slowfinish osobno|
|024|AIerrorFAILED z powodem, files/facts trwają; świadomyGUIretry z tym samym materiałem|Report29 module nieGUI|g3.spec TEST024; NOT_RUN|
|025|consentOFF brakcontext; sekret/token nigdy doAI, structuredRun retained bezstdout|G2a scopedPASS; późniejszy stricterrunFactsfix HUMAN5ba6e478|Nie rerun G2; K/P6 targetedprojectionreceipt, nie zaliczać całego modelu przez atrapy|
|026|loopback/Host/Origin/token/path/devices/ADS/lease/session/epoch denial bez efektów|G2a scopedPASS i nativecore historyczne|Nie rerun odebranych; Windows symlink/junction zakres raportować uczciwie|
|027|Windows100files active≤100KiB,100veto+hint, każda<100/50/200/200ms,p95/max/load|dawny37db przerwany przed100; C11 dowodziworkflow nieprogów|metrics/reference.spec.ts grep AC-027 TEST-027:, pełne100 NOT_RUN|

## Niezależne osie końcowego odbioru

- REC21/3 nie staje się integratedPASS przez merge. K rozlicza niezmienioną deltę core;
  P2 nowy GUIhardkill/restart/noreplay to brakujący użytkowy dowód, nie powtórka21.
- RECON14 transport nie staje się19/3GUI. Po5s UI musi pozostać UNKNOWN z właściwą tożsamością,
  a late terminal musi rozliczyć tylko tę samą operację raz. P2 jest właścicielem3cases/config.
- Pełne100 nie uruchomiono nawet częściowo w tym zakresie. Progi/oracles nie zmienione.
- Realny Gemini/20zdarzeńAI pilot oraz jakość naturalnojęzykowej oceny nie mają tuPASS.
  Codex preview proof pozostaje osobny; K jawnie rozlicza zakres dostawców względem amendments.
- Finalny ZIP i polska instrukcja MVP2: NOT_RUN; P4/K dostarczają finalną paczkę po swoim odczycie.
  Instrukcja MVP1 nie jest dowodem recovery/Run/Report MVP2.
- Wszystkie nowe19/P2/100 browser flaky: NIEOCENIONE, bo nie uruchomiono. Zero retry nie dowodzi stabilności.
- PASS testów nie jest ACCEPTED. Końcowy osąd i powiązany REVIEW_DECISION wykonuje K.

Aktualizacja K491e2313: finding P5 finish admission→socketdestroy ujawnił fetchfailed/2POST
przy1snapshot na55baa/bd. To **FAIL ścieżki rozliczenia finish/network-loss** (nie dowód
double mutation). P2 owns fix; frozenSHA oraz ocena wpływu na023/UNKNOWN wstrzymane do korekty
i dowodu. Nie relabelować RECON14 jako pokrycia tego odrębnego kontrprzypadku.
