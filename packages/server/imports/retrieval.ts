import {GoogleContactsRetrievalError} from '../../ingestion/googleContactsRetriever.js';
import {ServiceError} from '../service.js';
import type {RetrieveAndNormalizeGoogleContacts} from './contracts.js';

/** Provider authorization failures do not invalidate the application's login session. */
export function withGoogleRetrievalErrors(retrieve:RetrieveAndNormalizeGoogleContacts):RetrieveAndNormalizeGoogleContacts {
 return async input=>{
  try{return await retrieve(input);}catch(error){
   if(error instanceof GoogleContactsRetrievalError){
    if(error.reason==='RATE_LIMITED')throw new ServiceError('RATE_LIMITED',429);
    if(error.reason==='INVALID_CONTEXT')throw new ServiceError('INTERNAL',500);
    throw new ServiceError('SOURCE_UNAVAILABLE',502);
   }
   // Never trust an unknown adapter exception as a client-visible error or status.
   throw new ServiceError('INTERNAL',500);
  }
 };
}
