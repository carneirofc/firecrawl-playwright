import { test } from 'node:test';
import assert from 'node:assert/strict';
import net, { AddressInfo } from 'node:net';
import {
  EgressPool,
  parseEgressConfig,
  probeTcp,
  startHealthChecks,
} from './egress';

test('no proxy settings means direct egress', () => {
  assert.deepEqual(parseEgressConfig({}), []);
});

test('PROXY_SERVERS parses names, scheme default, timezone and locale', () => {
  const exits = parseEgressConfig({
    PROXY_SERVERS: JSON.stringify([
      { name: 'br', url: 'vpn-br:8888', timezone: 'America/Sao_Paulo', locale: 'pt-BR' },
      { url: 'http://vpn-nl:8888' },
    ]),
  });
  assert.deepEqual(exits, [
    { name: 'br', url: 'http://vpn-br:8888', timezone: 'America/Sao_Paulo', locale: 'pt-BR' },
    { name: 'egress-1', url: 'http://vpn-nl:8888' },
  ]);
});

test('PROXY_SERVERS wins over PROXY_SERVER', () => {
  const exits = parseEgressConfig({
    PROXY_SERVERS: '[{"url":"a:1"}]',
    PROXY_SERVER: 'b:2',
  });
  assert.equal(exits.length, 1);
  assert.equal(exits[0].url, 'http://a:1');
});

test('malformed PROXY_SERVERS throws instead of going direct', () => {
  assert.throws(() => parseEgressConfig({ PROXY_SERVERS: 'not json' }));
  assert.throws(() => parseEgressConfig({ PROXY_SERVERS: '[]' }));
  assert.throws(() => parseEgressConfig({ PROXY_SERVERS: '[{"name":"x"}]' }));
  assert.throws(() =>
    parseEgressConfig({ PROXY_SERVERS: '[{"name":"x","url":"a:1"},{"name":"x","url":"b:1"}]' }),
  );
});

test('single PROXY_SERVER keeps upstream credentials', () => {
  const [exit] = parseEgressConfig({
    PROXY_SERVER: 'proxy.example:7777',
    PROXY_USERNAME: 'u',
    PROXY_PASSWORD: 'p',
  });
  assert.equal(exit.url, 'http://u:p@proxy.example:7777/');
});

test('pool rotates round-robin over healthy exits and skips unhealthy ones', () => {
  const pool = new EgressPool([
    { name: 'a', url: 'http://a:1' },
    { name: 'b', url: 'http://b:1' },
    { name: 'c', url: 'http://c:1' },
  ]);
  assert.deepEqual([1, 2, 3, 4].map(() => pool.pick()!.name), ['a', 'b', 'c', 'a']);
  pool.exits[1].healthy = false;
  assert.deepEqual([1, 2, 3, 4].map(() => pool.pick()!.name), ['c', 'a', 'c', 'a']);
});

test('pool returns null when every exit is down (kill switch)', () => {
  const pool = new EgressPool([{ name: 'a', url: 'http://a:1' }]);
  pool.exits[0].healthy = false;
  assert.equal(pool.pick(), null);
});

test('probeTcp sees an open and a closed port', async () => {
  const server = net.createServer((s) => s.end());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  assert.equal(await probeTcp(`http://127.0.0.1:${port}`), true);
  server.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await probeTcp(`http://127.0.0.1:${port}`, 500), false);
});

test('health checks flip exits in and out of rotation', async () => {
  const pool = new EgressPool([
    { name: 'up', url: 'http://up:1' },
    { name: 'down', url: 'http://down:1' },
  ]);
  const stop = startHealthChecks(pool, 60_000, async (url) => url.includes('up'));
  await new Promise((r) => setTimeout(r, 20));
  stop();
  assert.deepEqual(pool.status().map((e) => [e.name, e.healthy]), [
    ['up', true],
    ['down', false],
  ]);
});
