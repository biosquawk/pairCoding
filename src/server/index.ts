import { pathToFileURL } from 'node:url';
import { createPairCoachServer } from './http';
export { createPairCoachServer } from './http';

// WHATWG Fetch bad ports: https://fetch.spec.whatwg.org/#port-blocking.
// A listening socket on these ports does not provide a browser-accessible UI.
const browserBlockedPorts = new Set([
  0,1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,
  101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,
  179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,
  587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,4190,
  5060,5061,6000,6566,6665,6666,6667,6668,6669,6679,6697,10080,
]);
class PublicHttpPortError extends Error {}
export function parsePublicHttpPort(value: string | undefined): number {
  if (value === undefined) return 8080;
  if (!/^[0-9]{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535)
    throw new PublicHttpPortError('PAIRCOACH_HTTP_PORT: użyj całkowitego portu 1–65535.');
  const port = Number(value);
  // Port 80 loses its explicit port in browser Host; 3000 is reserved for Vite.
  if ([80,3000,8765,8766,8767,8768].includes(port))
    throw new PublicHttpPortError('PAIRCOACH_HTTP_PORT: porty 80 (Host), 3000 (Vite) i 8765–8768 są zastrzeżone.');
  if (browserBlockedPorts.has(port))
    throw new PublicHttpPortError('PAIRCOACH_HTTP_PORT: porty blokowane przez przeglądarkę są niedozwolone; wybierz np. wolny 18080.');
  return port;
}

async function main() {
  const app=createPairCoachServer({port:parsePublicHttpPort(process.env.PAIRCOACH_HTTP_PORT),enableCoach:true,enableExecution:true,runtimeArguments:process.argv.slice(2)});
  const port=await app.listen();
  console.log(`PairCoach: http://127.0.0.1:${port} (wyłącznie loopback; token nie jest logowany).`);
  let stopping=false;
  const stop=async()=>{ if(stopping)return;stopping=true;await app.close();process.exitCode=0; };
  process.once('SIGINT',()=>{void stop();});process.once('SIGTERM',()=>{void stop();});
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(error=>{
    if(error instanceof PublicHttpPortError) console.error(error.message);
    else if(error?.code==='EADDRINUSE') console.error('Wybrany port PairCoach jest zajęty (EADDRINUSE). Wybierz wolny PAIRCOACH_HTTP_PORT; nie zatrzymuj obcego procesu.');
    else console.error('Nie udało się uruchomić lokalnego PairCoach. Sprawdź wybrany port (PAIRCOACH_HTTP_PORT, domyślnie 8080), argumenty i uprawnienia folderu.');
    process.exitCode=1;
  });
}
