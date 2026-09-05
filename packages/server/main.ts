import { BackendService, ServiceError } from './service.js';
import { createApiServer, type HttpAuthPort } from './http.js';

// Explicitly unavailable ports: no fabricated account, session, graph, or search engine.
const auth:HttpAuthPort={
  resolveSession:async()=>null,
  displaySession:async()=>{throw new ServiceError('UNAUTHENTICATED',401);},
  revokeSession:async()=>{}, // No session store exists in this unconfigured composition.
};
const service=new BackendService({auth,reads:{authorizePrivateScope:async()=>null,readSnapshot:async()=>null}});
const server=createApiServer({service,auth,browserOrigin:'http://127.0.0.1:5173'});
server.requestTimeout=10000;server.headersTimeout=10000;
server.listen(3001,'127.0.0.1',()=>console.log('API: http://127.0.0.1:3001 (auth/storage/search unconfigured)'));
server.on('error',()=>{console.error('API could not bind its local port.');process.exitCode=1;});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>server.close(()=>process.exit(0)));
