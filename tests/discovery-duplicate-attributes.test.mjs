import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePublicContent} from '../dist/packages/server/discovery/document-fetch.js';

test('identical repeated HTML attributes preserve the same normalized content',()=>{
  const baseline='<p><a class="reference" title="A &amp; B">Public source text.</a></p>';
  const repeated='<p><a class="reference" CLASS="reference" title="A &amp; B" title="A &#38; B">Public source text.</a></p>';
  assert.deepEqual(normalizePublicContent(repeated,true),normalizePublicContent(baseline,true));
});

test('conflicting duplicate attributes remain unsupported regardless of order',()=>{
  for(const content of [
    '<a class="first" class="second">Source</a>',
    '<input type="text" type="password">',
    '<input type="password" type="text">',
    '<meta name="robots" content="index" content="noai">',
    '<meta name="robots" content="noai" content="index">',
  ]) assert.throws(()=>normalizePublicContent(content,true),{code:'UNSUPPORTED_CONTENT'});
});

test('identical repeated restricted attributes cannot bypass access checks',()=>{
  for(const content of [
    '<input type="password" TYPE="password">',
    '<meta name="robots" name="robots" content="noai" content="noai">',
    '<meta name="robots" content="none" CONTENT="none">',
  ]) assert.throws(()=>normalizePublicContent(content,true),{code:'ACCESS_DENIED'});
});
