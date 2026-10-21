import { it } from 'node:test';
import assert from 'node:assert/strict';
import { localPostgresUrl, COMPOSE_TEST_DATABASE_URL } from '../tools/test-helpers/localPostgresUrl.js';
it('integration DB URL guard permits only loopback or explicitly marked exact synthetic Compose fixture',()=>{
 assert.equal(localPostgresUrl('postgresql://test:test@127.0.0.1:5432/test',{}).hostname,'127.0.0.1');
 assert.throws(()=>localPostgresUrl(COMPOSE_TEST_DATABASE_URL,{}),/loopback/);
 assert.equal(localPostgresUrl(COMPOSE_TEST_DATABASE_URL,{TPX_ISOLATED_COMPOSE_TEST:'1'}).hostname,'postgres');
 for(const url of [COMPOSE_TEST_DATABASE_URL.replace('@postgres:', '@remote.example:'),COMPOSE_TEST_DATABASE_URL.replace('synthetic-local-only','different'),COMPOSE_TEST_DATABASE_URL+'?host=remote.example',COMPOSE_TEST_DATABASE_URL+'#override'])assert.throws(()=>localPostgresUrl(url,{TPX_ISOLATED_COMPOSE_TEST:'1'}));
 assert.throws(()=>localPostgresUrl(undefined,{DATABASE_URL:COMPOSE_TEST_DATABASE_URL}),/Invalid URL/);
});
