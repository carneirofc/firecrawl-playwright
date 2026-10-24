import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostPacer } from './pacer';

const fakeClock = () => {
  let t = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
    advance: (ms: number) => {
      t += ms;
    },
    slept,
  };
};

test('disabled pacer never waits', async () => {
  const pacer = new HostPacer({ minIntervalMs: 0, jitterMs: 0, maxWaitMs: 10_000 });
  assert.equal(pacer.enabled, false);
  assert.equal(await pacer.wait('example.com'), 0);
});

test('same host is spaced by the interval, other hosts are not', async () => {
  const c = fakeClock();
  const pacer = new HostPacer({
    minIntervalMs: 2000,
    jitterMs: 0,
    maxWaitMs: 10_000,
    now: c.now,
    sleep: c.sleep,
    random: () => 0,
  });
  assert.equal(await pacer.wait('example.com'), 0);
  assert.equal(await pacer.wait('www.example.com'), 2000);
  assert.equal(await pacer.wait('EXAMPLE.com.'), 4000);
  assert.equal(await pacer.wait('other.org'), 0);
  c.advance(10_000);
  assert.equal(await pacer.wait('example.com'), 0);
});

test('jitter widens the gap', async () => {
  const c = fakeClock();
  const pacer = new HostPacer({
    minIntervalMs: 1000,
    jitterMs: 500,
    maxWaitMs: 10_000,
    now: c.now,
    sleep: c.sleep,
    random: () => 0.999999,
  });
  await pacer.wait('a.test');
  assert.equal(await pacer.wait('a.test'), 1500);
});

test('waits are capped at maxWaitMs', async () => {
  const c = fakeClock();
  const pacer = new HostPacer({
    minIntervalMs: 3000,
    jitterMs: 0,
    maxWaitMs: 5000,
    now: c.now,
    sleep: c.sleep,
    random: () => 0,
  });
  const waits = [];
  for (let i = 0; i < 5; i++) waits.push(await pacer.wait('busy.test'));
  assert.deepEqual(waits, [0, 3000, 5000, 5000, 5000]);
});
