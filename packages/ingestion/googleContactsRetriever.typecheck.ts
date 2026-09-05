import {createGoogleContactsRetriever} from './googleContactsRetriever.js';
import type {RetrieveAndNormalizeGoogleContacts} from '../server/imports/contracts.js';
// Type-only integration assertion; no runtime dependency on server modules.
const compatible: RetrieveAndNormalizeGoogleContacts = createGoogleContactsRetriever();
void compatible;
