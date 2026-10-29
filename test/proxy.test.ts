import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProxy } from '../src/proxy';

test('an unusable proxy setting is reported instead of thrown', () => {
  assert.deepEqual(resolveProxy(''), { proxy: '' });
  assert.deepEqual(resolveProxy('   '), { proxy: '' });
  assert.deepEqual(resolveProxy(undefined), { proxy: '' });
  assert.deepEqual(resolveProxy('127.0.0.1:7890'), { proxy: '', problem: 'invalid' });
  assert.deepEqual(resolveProxy('not a url'), { proxy: '', problem: 'invalid' });
  assert.deepEqual(resolveProxy('ftp://proxy.test:21'), { proxy: '', problem: 'unsupported' });
  assert.deepEqual(resolveProxy('file:///tmp/socket'), { proxy: '', problem: 'unsupported' });
});
test('stored proxy credentials are applied without corrupting the URL', () => {
  assert.deepEqual(resolveProxy('http://proxy.test:8080', '{"username":"u","password":"p"}'), {
    proxy: 'http://u:p@proxy.test:8080',
  });
  assert.deepEqual(resolveProxy('http://proxy.test/', { username: 'u', password: 'p' }), {
    proxy: 'http://u:p@proxy.test/',
  });
  assert.deepEqual(resolveProxy('http://proxy.test/path', { username: 'u' }), {
    proxy: 'http://u@proxy.test/path',
  });
  assert.deepEqual(resolveProxy('http://proxy.test', { username: 'u' }), {
    proxy: 'http://u@proxy.test',
  });
  assert.deepEqual(
    resolveProxy('socks5h://proxy.test:1080', { username: 'a@b', password: 'p:w' }),
    { proxy: 'socks5h://a%40b:p%3Aw@proxy.test:1080' },
  );
  assert.deepEqual(resolveProxy('socks5://proxy.test:1080', { username: 'u' }), {
    proxy: 'socks5://u@proxy.test:1080',
  });
});
test('missing or corrupt credentials leave a valid proxy untouched', () => {
  assert.deepEqual(resolveProxy('http://proxy.test:8080'), { proxy: 'http://proxy.test:8080' });
  assert.deepEqual(resolveProxy('http://proxy.test:8080', 'not json'), {
    proxy: 'http://proxy.test:8080',
  });
  assert.deepEqual(resolveProxy('http://proxy.test:8080', '{}'), {
    proxy: 'http://proxy.test:8080',
  });
  assert.deepEqual(resolveProxy('http://proxy.test:8080', { username: 42 }), {
    proxy: 'http://proxy.test:8080',
  });
  assert.deepEqual(resolveProxy('http://proxy.test:8080', null), {
    proxy: 'http://proxy.test:8080',
  });
});
