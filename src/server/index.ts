import { pathToFileURL } from 'node:url';
import { createPairCoachServer } from './http';
export { createPairCoachServer } from './http';

async function main() {
  const app=createPairCoachServer({enableCoach:true,enableExecution:true,runtimeArguments:process.argv.slice(2)});
  const port=await app.listen();
  console.log(`PairCoach: http://127.0.0.1:${port} (wyłącznie loopback; token nie jest logowany).`);
  let stopping=false;
  const stop=async()=>{ if(stopping)return;stopping=true;await app.close();process.exitCode=0; };
  process.once('SIGINT',()=>{void stop();});process.once('SIGTERM',()=>{void stop();});
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(()=>{console.error('Nie udało się uruchomić lokalnego PairCoach. Sprawdź port 8080 i uprawnienia folderu.');process.exitCode=1;});
}
