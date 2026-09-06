import {sqliteTable,text,primaryKey,index} from 'drizzle-orm/sqlite-core';
export const people=sqliteTable('people',{
  owner:text('owner').notNull(),id:text('id').notNull(),name:text('name').notNull(),searchName:text('search_name').notNull(),headline:text('headline').notNull(),location:text('location').notNull(),firstSeen:text('first_seen').notNull(),lastSeen:text('last_seen').notNull()
},t=>[primaryKey({columns:[t.owner,t.id]}),index('people_name').on(t.owner,t.searchName,t.id)]);
export const connections=sqliteTable('connections',{
  owner:text('owner').notNull(),a:text('a').notNull(),b:text('b').notNull(),firstSeen:text('first_seen').notNull(),lastSeen:text('last_seen').notNull()
},t=>[primaryKey({columns:[t.owner,t.a,t.b]}),index('connections_reverse').on(t.owner,t.b,t.a)]);
export const evidence=sqliteTable('evidence',{
  owner:text('owner').notNull(),a:text('a').notNull(),b:text('b').notNull(),source:text('source').notNull(),observedAt:text('observed_at').notNull()
},t=>[primaryKey({columns:[t.owner,t.a,t.b,t.source]})]);
