import {EvidenceBackedGoalResolver,BoundedRouteSearch} from '../graph/src/index.js';
import {createApplication,openPostgresStorage} from './application.js';

try {
 const app=await createApplication({openStorage:openPostgresStorage,search:{goals:new EvidenceBackedGoalResolver(),engine:new BoundedRouteSearch()}});
 app.server.on('error',()=>{console.error('Application could not listen.');void app.close().finally(()=>process.exit(1));});
 app.server.listen(app.config.port,app.config.host,()=>{
  console.log(`Application listening on port ${app.config.port}; auth=${app.configured.auth?'configured':'unavailable'}, storage=${app.configured.storage?'configured':'unavailable'}, search=${app.configured.search?'configured':'unavailable'}.`);
 });
 let stopping=false;
 for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{
  if(stopping)return;stopping=true;void app.close().finally(()=>process.exit(0));
 });
}catch{
 // Never serialize errors from providers, configuration URLs, migrations, or database drivers.
 console.error('Application startup unavailable; verify private configuration and database migration.');
 process.exitCode=1;
}
