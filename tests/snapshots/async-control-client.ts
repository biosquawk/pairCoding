// A separate OS process initiates real HTTP requests while the parent runs real gate I/O.
process.on('message', async (message: any) => {
  if (message.kind !== 'GO') return;
  try {
    const started = performance.now();
    const request = async (route: string) => {
      const start = performance.now();
      const response = await fetch(message.url + route, {method: route === '/document' ? 'GET' : 'POST'});
      return {route, status: response.status, body: await response.json(), roundTripMs: performance.now() - start};
    };
    const busy = await Promise.all(['/document', '/settings', '/write', '/capture', '/restore'].map(request));
    const veto = await request('/veto');
    process.send?.({kind: 'RESULT', busy, veto, elapsedMs: performance.now() - started});
  } catch (error) { process.send?.({kind: 'ERROR', message: String(error)}); }
});
process.send?.({kind: 'READY'});
