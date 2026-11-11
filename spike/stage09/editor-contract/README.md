# P2 stage09 A–B: editor / migration proposal

**Not product implementation, not LSP LIVE and not an approved contract.** Read `contract.md`,
`dto-proposal.d.ts`, `baseline-selection-analysis.md` and `ownership-and-tests.md`; K consolidates BE/FE proposals and ROOT decides
A–B before any dependent C–E code. Base: `38d5130634d0f0ac7ace4c82a77273fe7f4ef3e9`.

Portable synthetic checks (existing Node >=22; no packages, service, build or browser needed):

```sh
node --check spike/stage09/editor-contract/contract-probe.mjs
node --check spike/stage09/editor-contract/contract-probe.test.mjs
node --test spike/stage09/editor-contract/contract-probe.test.mjs
```

These checks exercise a **proposed pure oracle**, NOT existing Monaco acceptance hooks, WriteGate,
LSP, Docker, diagnostics from a real server or the GUI. They cannot satisfy TEST101–107. No product
file or existing assertion/METRIC/golden/guard is changed. No container/image used: imageIDs N/A.

`selection-timing-probe.mjs` is a separate diagnostic importing current LiveBackend with injected
transport. Requires the existing TSX loader via `node --import <existing-tsx-loader>` and a writable
TMPDIR. It is NOT a pure contract test or real HTTP/WS/FS/browser proof; see baseline analysis.
