import {sqliteTable,text,integer,primaryKey,index} from 'drizzle-orm/sqlite-core';
export const people=sqliteTable('people',{
  owner:text('owner').notNull(),id:text('id').notNull(),name:text('name').notNull(),searchName:text('search_name').notNull(),headline:text('headline').notNull(),location:text('location').notNull(),about:text('about').notNull().default(''),experience:text('experience').notNull().default(''),education:text('education').notNull().default(''),skills:text('skills').notNull().default(''),keywords:text('keywords').notNull().default(''),firstSeen:text('first_seen').notNull(),lastSeen:text('last_seen').notNull()
},t=>[primaryKey({columns:[t.owner,t.id]}),index('people_name').on(t.owner,t.searchName,t.id)]);
export const connections=sqliteTable('connections',{
  owner:text('owner').notNull(),a:text('a').notNull(),b:text('b').notNull(),firstSeen:text('first_seen').notNull(),lastSeen:text('last_seen').notNull()
},t=>[primaryKey({columns:[t.owner,t.a,t.b]}),index('connections_reverse').on(t.owner,t.b,t.a)]);
export const evidence=sqliteTable('evidence',{
  owner:text('owner').notNull(),a:text('a').notNull(),b:text('b').notNull(),source:text('source').notNull(),observedAt:text('observed_at').notNull(),detailsJson:text('details_json').notNull().default('{}')
},t=>[primaryKey({columns:[t.owner,t.a,t.b,t.source]})]);
export const peopleContributors=sqliteTable('people_contributors',{
  owner:text('owner').notNull(),personId:text('person_id').notNull(),contributorId:text('contributor_id').notNull(),firstSeen:text('first_seen').notNull(),lastSeen:text('last_seen').notNull()
},t=>[primaryKey({columns:[t.owner,t.personId,t.contributorId]}),index('people_contributors_account').on(t.contributorId,t.personId)]);
export const connectionContributors=sqliteTable('connection_contributors',{
  owner:text('owner').notNull(),a:text('a').notNull(),b:text('b').notNull(),contributorId:text('contributor_id').notNull(),firstSeen:text('first_seen').notNull(),lastSeen:text('last_seen').notNull()
},t=>[primaryKey({columns:[t.owner,t.a,t.b,t.contributorId]}),index('connection_contributors_account').on(t.contributorId,t.a,t.b)]);
export const evidenceContributors=sqliteTable('evidence_contributors',{
  owner:text('owner').notNull(),a:text('a').notNull(),b:text('b').notNull(),source:text('source').notNull(),contributorId:text('contributor_id').notNull(),firstSeen:text('first_seen').notNull(),lastSeen:text('last_seen').notNull()
},t=>[primaryKey({columns:[t.owner,t.a,t.b,t.source,t.contributorId]}),index('evidence_contributors_account').on(t.contributorId,t.a,t.b)]);
export const collectionCoverage=sqliteTable('collection_coverage',{
  owner:text('owner').notNull(),personId:text('person_id').notNull(),kind:text('kind').notNull(),contributorId:text('contributor_id').notNull(),status:text('status').notNull(),scope:text('scope').notNull().default(''),checkedAt:text('checked_at').notNull(),reusable:integer('reusable').notNull().default(0),detailsJson:text('details_json').notNull().default('{}')
},t=>[primaryKey({columns:[t.owner,t.personId,t.kind,t.contributorId]}),index('collection_coverage_lookup').on(t.owner,t.personId,t.kind,t.reusable,t.checkedAt),index('collection_coverage_contributor').on(t.contributorId,t.personId,t.kind)]);
export const apiRateLimits=sqliteTable('api_rate_limits',{
  key:text('key').primaryKey(),count:integer('count').notNull(),resetAt:integer('reset_at').notNull()
});
export const imports=sqliteTable('imports',{
  owner:text('owner').notNull(),id:text('id').notNull(),fileName:text('file_name').notNull(),format:text('format').notNull(),schemaVersion:text('schema_version').notNull(),exportedAt:text('exported_at').notNull(),metadataJson:text('metadata_json').notNull(),firstSeen:text('first_seen').notNull(),lastSeen:text('last_seen').notNull()
},t=>[primaryKey({columns:[t.owner,t.id]})]);
export const importRecords=sqliteTable('import_records',{
  owner:text('owner').notNull(),importId:text('import_id').notNull(),section:text('section').notNull(),recordIndex:integer('record_index').notNull(),dataJson:text('data_json').notNull()
},t=>[primaryKey({columns:[t.owner,t.importId,t.section,t.recordIndex]}),index('import_records_section').on(t.owner,t.section)]);
export const users=sqliteTable('users',{
  id:text('id').primaryKey(),email:text('email'),displayName:text('display_name'),linkedinProfileUrl:text('linkedin_profile_url'),createdAt:integer('created_at').notNull(),updatedAt:integer('updated_at').notNull()
});
export const identities=sqliteTable('identities',{
  provider:text('provider').notNull(),subject:text('subject').notNull(),userId:text('user_id').notNull(),email:text('email'),displayName:text('display_name'),createdAt:integer('created_at').notNull(),lastSeen:integer('last_seen').notNull()
},t=>[primaryKey({columns:[t.provider,t.subject]}),index('identities_user').on(t.userId)]);
export const sessions=sqliteTable('sessions',{
  tokenHash:text('token_hash').primaryKey(),userId:text('user_id').notNull(),expiresAt:integer('expires_at').notNull(),createdAt:integer('created_at').notNull()
},t=>[index('sessions_user').on(t.userId),index('sessions_expiry').on(t.expiresAt)]);
