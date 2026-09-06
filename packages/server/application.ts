import {PublicFactsService} from './public-facts/service.js';
import {PgPublicFactsStore} from './public-facts/postgres.js';
import {migratePublicFactsStorage} from './public-facts/migrate.js';
import type {PublicFactsStore} from './public-facts/contracts.js';
import {PublicSourceProvisioner} from './storage/public-source-provision.js';
import {DiscoveryApplication} from './discovery/composition.js';
import {PgDiscoveryReceipts,type DiscoveryReceipts} from './discovery/receipts.js';
import {migrateDiscoveryStorage} from './discovery/migrate.js';
import type {DiscoverySourcesOptions} from './discovery/providers/service.js';
import {FactReviewService} from './facts/service.js';
import {PgFactStore} from './facts/postgres.js';
import {migrateFactsStorage} from './facts/migrate.js';
import {withFactWarnings} from './facts/search.js';
import type {FactStore} from './facts/contracts.js';
import {withGoogleRetrievalErrors} from './imports/retrieval.js';
import {createServer,type Server} from 'node:http';
import {Pool} from 'pg';
import {resolve} from 'node:path';
import {GoogleImportBridge} from './imports/bridge.js';
import type {RetrieveAndNormalizeGoogleContacts} from './imports/contracts.js';
import {PgStore} from './storage/postgres.js';
import {migratePrivateStorage,migrateContactsStorage} from './storage/migrate.js';
import type {AuthStore} from './auth/ports.js';
import {GoogleContacts,readGoogleContactsConfig} from './auth/contacts.js';
import type {ContactsStore} from './auth/contacts-ports.js';
import {GoogleAuth,readGoogleAuthConfig} from './auth/google.js';
import {createApiHandler,type HttpAuthPort} from './http.js';
import {BackendService,ServiceError,type ReadPort,type ImportPort,type GoalPort} from './service.js';
import type {SearchEngine} from '../../contracts/index.js';
import {createProductionHandler,readRuntimeConfig,type RuntimeConfig} from './deployment/runtime.js';

export interface ApplicationStorage {
 store:AuthStore & ReadPort & ImportPort & ContactsStore;
 importStore?:PgStore;
 facts?:FactStore;
 discoveryReceipts?:DiscoveryReceipts;
 publicFacts?:PublicFactsStore;
 publicSources?:PublicSourceProvisioner;
 migrate():Promise<void>;
 probe(signal:AbortSignal):Promise<boolean>;
 close():Promise<void>;
}
export interface ApplicationOptions {
 env?:NodeJS.ProcessEnv;
 config?:RuntimeConfig;
 openStorage?:(databaseUrl:string)=>Promise<ApplicationStorage>;
 search?:{goals:GoalPort;engine:SearchEngine};
 retrieveAndNormalize?:RetrieveAndNormalizeGoogleContacts;
 discovery?:Pick<DiscoverySourcesOptions,'provider'|'documents'>;
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
  // Contacts is independently optional: incomplete/invalid consent settings must not disable login.
  let contactsConfig:ReturnType<typeof readGoogleContactsConfig>=null;
  try{contactsConfig=readGoogleContactsConfig(googleConfig,env);}catch{contactsConfig=null;}
  const contacts=storage&&oauth&&contactsConfig?new GoogleContacts(auth,storage.store,storage.store,contactsConfig):undefined;
  // In-process retrieval only. This secret-returning method is never installed as an HTTP route.
  const contactsAccess:Pick<GoogleContacts,'getFreshAccessToken'>={getFreshAccessToken:(credential,sourceId)=>{
   if(!contacts)throw new ServiceError('SOURCE_UNAVAILABLE',502);
   return contacts.getFreshAccessToken(credential,sourceId);
  }};
  const service=new BackendService({auth,reads:storage?.store??{authorizePrivateScope:async()=>null,readSnapshot:async()=>null},...(storage?{imports:storage.store}:{}),...(options.search?{goals:options.search.goals,engine:withFactWarnings(options.search.engine)}:{})});
  const bridge=oauth&&storage?.importStore?new GoogleImportBridge({auth,store:storage.importStore,contacts:contactsAccess,retrieveAndNormalize:options.retrieveAndNormalize?withGoogleRetrievalErrors(options.retrieveAndNormalize):(async()=>{throw new ServiceError('SOURCE_UNAVAILABLE',502);})}):undefined;
  const imports=bridge?{
   start:async(credential:unknown,input:unknown)=>{
    if(!options.retrieveAndNormalize||!contacts){if(!await auth.resolveSession(credential))throw new ServiceError('UNAUTHENTICATED',401);throw new ServiceError('SOURCE_UNAVAILABLE',502);}
    return bridge.start(credential,input);
   },
   review:(credential:unknown,input:unknown)=>bridge.review(credential,input),
   approve:(credential:unknown,input:unknown)=>bridge.approve(credential,input),
  }:undefined;
  const ready=async(signal:AbortSignal)=>Boolean(storage&&oauth&&options.search)&&!signal.aborted&&await storage!.probe(signal);
  const facts=storage?.facts?new FactReviewService({auth,facts:storage.facts}):undefined;
  const publicFacts=storage?.publicFacts?new PublicFactsService({auth,publicFacts:storage.publicFacts}):undefined;
  const discovery=storage?.discoveryReceipts&&options.discovery?new DiscoveryApplication({auth,receipts:storage.discoveryReceipts,...options.discovery}):undefined;
  const api=createApiHandler({auth,service,browserOrigin:config.browserOrigin,...(oauth?{oauth}:{}),...(contacts?{contacts}:{}),...(imports?{imports}:{}),...(facts?{facts}:{}),...(discovery?{discovery}:{}),...(publicFacts?{publicFacts}:{})});
  const handler=config.production?await createProductionHandler({apiHandler:api,webRoot:config.webRoot,readiness:ready}):api;
  const server=createServer(handler);server.requestTimeout=25000;server.headersTimeout=10000;
  return {server,config,contactsAccess,publicFacts,publicSources:storage?.publicSources,readiness:ready,close:()=>closeApplication(server,storage),configured:{storage:Boolean(storage),auth:Boolean(oauth),contacts:Boolean(contacts),retrieval:Boolean(imports&&contacts&&options.retrieveAndNormalize),search:Boolean(options.search)}};
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
  importStore:store,
  facts:new PgFactStore(pool),
  discoveryReceipts:new PgDiscoveryReceipts(pool),
  publicFacts:new PgPublicFactsStore(pool),
  publicSources:new PublicSourceProvisioner(pool),
  migrate:async()=>{await migratePrivateStorage(pool,resolve('migrations/001_private_storage.sql'));await migrateContactsStorage(pool,resolve('migrations/002_contacts_grants.sql'));await migrateFactsStorage(pool,resolve('migrations/003_fact_reviews.sql'));await migratePublicFactsStorage(pool,resolve('migrations/004_public_fact_staging.sql'));await migrateDiscoveryStorage(pool,resolve('migrations/005_discovery_receipts.sql'));await store.pruneExpiredAuth(Date.now());await store.pruneExpiredContactsTransactions(Date.now());},
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
