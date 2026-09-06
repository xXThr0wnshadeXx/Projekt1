import test from 'node:test';
import assert from 'node:assert/strict';
import {createTursoClient} from '../server/turso.js';

test('Turso accepts the dashboard libsql URL without rewriting its pipeline path', () => {
  const client=createTursoClient({url:'libsql://example.turso.io',authToken:'test-token-value'});
  assert.equal(client.protocol,'http');
  client.close();
});

test('Turso rejects copied setup placeholders before making a request', () => {
  assert.throws(
    ()=>createTursoClient({url:'libsql://example.turso.io',authToken:'PASTE_THE_REAL_TOKEN_HERE'}),
    /still a placeholder/
  );
});
