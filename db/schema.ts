import {sqliteTable,text,integer,primaryKey,index} from 'drizzle-orm/sqlite-core';
export const people=sqliteTable('people',{
  owner:text('owner').notNull(),id:text('id').notNull(),name:text('name').notNull(),searchName:text('search_name').notNull(),headline:text('headline').notNull(),location:text('location').notNull(),firstSeen:text('first_seen').notNull(),lastSeen:text('last_seen').notNull()
},t=>[primaryKey({columns:[t.owner,t.id]}),index('people_name').on(t.owner,t.searchName,t.id)]);
export const connections=sqliteTable('connections',{
  owner:text('owner').notNull(),a:text('a').notNull(),b:text('b').notNull(),firstSeen:text('first_seen').notNull(),lastSeen:text('last_seen').notNull()
},t=>[primaryKey({columns:[t.owner,t.a,t.b]}),index('connections_reverse').on(t.owner,t.b,t.a)]);
export const evidence=sqliteTable('evidence',{
  owner:text('owner').notNull(),a:text('a').notNull(),b:text('b').notNull(),source:text('source').notNull(),observedAt:text('observed_at').notNull()
},t=>[primaryKey({columns:[t.owner,t.a,t.b,t.source]})]);
export const apiRateLimits=sqliteTable('api_rate_limits',{
  key:text('key').primaryKey(),count:integer('count').notNull(),resetAt:integer('reset_at').notNull()
});
export const imports=sqliteTable('imports',{
  owner:text('owner').notNull(),id:text('id').notNull(),fileName:text('file_name').notNull(),format:text('format').notNull(),schemaVersion:text('schema_version').notNull(),exportedAt:text('exported_at').notNull(),metadataJson:text('metadata_json').notNull(),firstSeen:text('first_seen').notNull(),lastSeen:text('last_seen').notNull()
},t=>[primaryKey({columns:[t.owner,t.id]})]);
export const importRecords=sqliteTable('import_records',{
  owner:text('owner').notNull(),importId:text('import_id').notNull(),section:text('section').notNull(),recordIndex:integer('record_index').notNull(),dataJson:text('data_json').notNull()
},t=>[primaryKey({columns:[t.owner,t.importId,t.section,t.recordIndex]}),index('import_records_section').on(t.owner,t.section)]);
