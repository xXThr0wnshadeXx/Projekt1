import {createServer,type Server} from 'node:http';
import {Pool} from 'pg';
import {resolve} from 'node:path';
import {PgStore} from './storage/postgres.js';
import {migratePrivateStorage} from './storage/migrate.js';
import type {AuthStore} from './auth/ports.js';
import {GoogleAuth,readGoogleAuthConfig} from './auth/google.js';
import {createApiHandler,type HttpAuthPort} from './http.js';
import {BackendService,ServiceError,type ReadPort,type ImportPort,type GoalPort} from './service.js';
import type {SearchEngine} from '../../contracts/index.js';
import {createProductionHandler,readRuntimeConfig,type RuntimeConfig} from './deployment/runtime.js';

export interface ApplicationStorage {
 store:AuthStore & ReadPort & ImportPort;
 migrate():Promise<void>;
 probe(signal:AbortSignal):Promise<boolean>;
 close():Promise<void>;
}
export interface ApplicationOptions {
 env?:NodeJS.ProcessEnv;
 config?:RuntimeConfig;
 openStorage?:(databaseUrl:string)=>Promise<ApplicationStorage>;
 search?:{goals:GoalPort;engine:SearchEngine};
}
const unavailableAuth:HttpAuthPort={resolveSession:async()=>null,displaySession:async()=>{throw new ServiceError('UNAUTHENTICATED',401);},revokeSession:async()=>{}};
/** Config and migrations complete before the caller can listen. No substitute persistence/session exists. */
export async function createApplication(options:ApplicationOptions={}) {
 const env=options.env??process.env,config=options.config??readRuntimeConfig(env);
 const hasGoogle=Boolean(env.GOOGLE_CLIENT_ID||env.GOOGLE_CLIENT_SECRET);
 const googleConfig=hasGoogle?readGoogleAuthConfig({...env,APP_ORIGIN:config.browserOrigin,GOOGLE_REDIRECT_URI:config.googleRedirectUri}):null;
 let storage:ApplicationStorage|undefined;
 try {
  if(env.DATABASE_URL){
   if(!options.openStorage)throw new ServiceError('SOURCE_UNAVAILABLE',502);
   storage=await options.openStorage(env.DATABASE_URL);
   await storage.migrate();
  }
  const oauth=storage && googleConfig?new GoogleAuth(storage.store,googleConfig):undefined;
  const auth=oauth??unavailableAuth;
  const service=new BackendService({auth,reads:storage?.store??{authorizePrivateScope:async()=>null,readSnapshot:async()=>null},...(storage?{imports:storage.store}:{}),...(options.search??{})});
  const ready=async(signal:AbortSignal)=>Boolean(storage&&oauth&&options.search)&&!signal.aborted&&await storage!.probe(signal);
  const api=createApiHandler({auth,service,browserOrigin:config.browserOrigin,...(oauth?{oauth}:{})});
  const handler=config.production?await createProductionHandler({apiHandler:api,webRoot:config.webRoot,readiness:ready}):api;
  const server=createServer(handler);server.requestTimeout=25000;server.headersTimeout=10000;
  return {server,config,readiness:ready,close:()=>closeApplication(server,storage),configured:{storage:Boolean(storage),auth:Boolean(oauth),search:Boolean(options.search)}};
 }catch(error){await storage?.close();throw error;}
}
/** Stop acceptance immediately, then bound active request and database shutdown time. */
async function closeApplication(server:Server,storage:ApplicationStorage|undefined):Promise<void> {
 let timer:ReturnType<typeof setTimeout>|undefined;
 const work=async()=>{await new Promise<void>(resolve=>{if(!server.listening){resolve();return;}server.close(()=>resolve());server.closeIdleConnections();});await storage?.close();};
 try {await Promise.race([work(),new Promise<void>(resolve=>{timer=setTimeout(()=>{server.closeAllConnections();resolve();},5000);})]);}
 finally{if(timer)clearTimeout(timer);}
}

/** Real PostgreSQL only; no in-memory fallback. URLs and database errors are never logged. */
export async function openPostgresStorage(databaseUrl:string):Promise<ApplicationStorage> {
 const pool=new Pool({connectionString:databaseUrl,max:10,connectionTimeoutMillis:1000,statement_timeout:10000,query_timeout:12000});
 pool.on('error',()=>{console.error('Database connection unavailable.');});
 const store=new PgStore(pool);
 return {
  store,
  migrate:async()=>{await migratePrivateStorage(pool,resolve('migrations/001_private_storage.sql'));await store.pruneExpiredAuth(Date.now());},
  close:()=>pool.end(),
  probe:async(signal)=>{
   if(signal.aborted)return false;
   let client;
   try{client=await pool.connect();}catch{return false;}
   let released=false;
   const release=(destroy=false)=>{if(!released){released=true;client.release(destroy);}};
   const abort=()=>release(true);
   signal.addEventListener('abort',abort,{once:true});
   try {
    if(signal.aborted){release(true);return false;}
    await client.query('SELECT 1');return !signal.aborted;
   }catch{return false;}
   finally{signal.removeEventListener('abort',abort);release();}
  },
 };
}
