import {PublicHttpClient} from './discovery/providers/http.js';
import {TavilySearchProvider} from './discovery/providers/search.js';
import {PublicDocumentFetcher} from './discovery/document-fetch.js';
import {createGoogleContactsRetriever} from '../ingestion/googleContactsRetriever.js';
import {EvidenceBackedGoalResolver,BoundedRouteSearch} from '../graph/src/index.js';
import {createApplication,openPostgresStorage} from './application.js';

try {
 const publicHttp=new PublicHttpClient('WarmPath/0.1 (+https://github.com/xXThr0wnshadeXx/Projekt1)');
 const app=await createApplication({discovery:{provider:new TavilySearchProvider(publicHttp,process.env.TAVILY_API_KEY),documents:new PublicDocumentFetcher(publicHttp)},openStorage:openPostgresStorage,retrieveAndNormalize:createGoogleContactsRetriever(),search:{goals:new EvidenceBackedGoalResolver(),engine:new BoundedRouteSearch()}});
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
