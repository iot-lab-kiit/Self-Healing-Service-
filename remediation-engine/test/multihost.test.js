'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRemediator, parseDockerHosts } = require('../src/dockerController');
const { createClock, createFakeDocker, createFakeHttp } = require('./fakes');

test('DOCKER_HOSTS: string and object forms, default ports by TLS', () => {
  assert.deepEqual(
    parseDockerHosts('{"machine-1":{"url":"tcp://10.0.0.11:2376","certDir":"/certs/machine-1"},"machine-2":"tcp://lab-2"}'),
    {
      'machine-1': { host: '10.0.0.11', port: 2376, certDir: '/certs/machine-1' },
      'machine-2': { host: 'lab-2', port: 2375, certDir: null },
    },
  );
  assert.deepEqual(parseDockerHosts('{"machine-3":{"url":"tcp://h3","certDir":"/c"}}')['machine-3'].port, 2376);
  assert.deepEqual(parseDockerHosts(''), {});
  assert.deepEqual(parseDockerHosts(undefined), {});
});

test('DOCKER_HOSTS: bad config fails fast with a clear message', () => {
  assert.throws(() => parseDockerHosts('{nope'), /not valid JSON/);
  assert.throws(() => parseDockerHosts('["tcp://x:2375"]'), /must be a JSON object/);
  assert.throws(() => parseDockerHosts('{"../etc":"tcp://x:2375"}'), /invalid machine id/);
  assert.throws(() => parseDockerHosts('{"machine-1":"http://x:2375"}'), /tcp:\/\/host:port/);
  assert.throws(() => parseDockerHosts('{"machine-1":{}}'), /tcp:\/\/host:port/);
});

test('each machine is restarted on its own host; unlisted machines use the local daemon', async () => {
  const calls = [];
  const clock = createClock();
  const daemons = {};
  const remediator = createRemediator({
    http: createFakeHttp(calls),
    docker: createFakeDocker(calls, { names: ['machine-5'] }), // local socket
    dockerHosts: parseDockerHosts('{"machine-1":"tcp://host-a:2375","machine-2":"tcp://host-b:2375"}'),
    dockerFactory: (spec) => {
      const own = [];
      daemons[spec.host] = own;
      return createFakeDocker(own, { names: spec.host === 'host-a' ? ['machine-1'] : ['machine-2'] });
    },
    sleep: clock.sleep,
    now: clock.now,
    logger: () => {},
  });

  assert.equal((await remediator.remediate('machine-2')).result, 'success');
  assert.equal((await remediator.remediate('machine-1')).result, 'success');
  assert.equal((await remediator.remediate('machine-5')).result, 'success');

  const restarts = (list) => list.filter((c) => c.type === 'docker.restart').map((c) => c.id);
  assert.deepEqual(restarts(daemons['host-a']), ['id-machine-1']);
  assert.deepEqual(restarts(daemons['host-b']), ['id-machine-2']);
  assert.deepEqual(restarts(calls), ['id-machine-5']);
});

test('a machine whose host does not run it is reported, not restarted elsewhere', async () => {
  const calls = [];
  const clock = createClock();
  const remote = [];
  const remediator = createRemediator({
    http: createFakeHttp(calls),
    docker: createFakeDocker(calls), // local daemon DOES have machine-3 - must not be used
    dockerHosts: parseDockerHosts('{"machine-3":"tcp://host-c:2375"}'),
    dockerFactory: () => createFakeDocker(remote, { names: [] }),
    sleep: clock.sleep,
    now: clock.now,
    logger: () => {},
  });
  const out = await remediator.remediate('machine-3');
  assert.equal(out.result, 'container_not_found');
  assert.equal(calls.filter((c) => c.type === 'docker.restart').length, 0);
});
