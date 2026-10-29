import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import test from 'node:test';
import { registerDashboardRoutes } from '../dist/host/http.js';
import { createPairingStore } from '../dist/host/security.js';

const basePath = '/dsh-agent-control-center';
const authoritySecret = Buffer.alloc(32, 0x71).toString('base64url');
const snapshot = {
  bootId: 'integration-boot',
  revision: 0,
  generatedAt: '2026-10-14T00:00:00.000Z',
  completeness: 'partial',
  agents: [],
};

function send({ port, path, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('dashboard routes serve, pair, authorize snapshots, guard authorities, and clean up SSE', async () => {
  let route;
  let activeSubscriptions = 0;
  let unsubscribeCalls = 0;
  const collector = {
    refresh: async () => {},
    snapshot: () => snapshot,
    subscribe(listener) {
      activeSubscriptions += 1;
      return () => {
        activeSubscriptions -= 1;
        unsubscribeCalls += 1;
      };
    },
  };
  const pairing = createPairingStore({ secret: authoritySecret });
  const webServer = {
    register(value) {
      route = value;
      return () => { route = undefined; };
    },
  };
  let authority = '';
  const unregister = registerDashboardRoutes({ webServer, collector, pairing, getAuthority: () => authority });
  const server = createServer((req, res) => {
    if (route && req.url?.startsWith(route.path)) route.handler(req, res);
    else { res.writeHead(404); res.end(); }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  authority = `127.0.0.1:${port}`;

  let sseRequest;
  try {
    const page = await send({ port, path: basePath });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.body, /<html|<!doctype html/i);

    const unauthenticated = await send({ port, path: `${basePath}/api/snapshot` });
    assert.equal(unauthenticated.status, 401);
    assert.deepEqual(JSON.parse(unauthenticated.body), { error: 'unauthorized' });

    const token = pairing.issue(authority);
    const badHost = await send({
      port,
      path: `${basePath}/api/pair`,
      method: 'POST',
      headers: {
        host: 'attacker.invalid',
        origin: `http://${authority}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token }),
    });
    assert.equal(badHost.status, 403);

    const badOrigin = await send({
      port,
      path: `${basePath}/api/pair`,
      method: 'POST',
      headers: {
        origin: 'http://attacker.invalid',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token }),
    });
    assert.equal(badOrigin.status, 403);

    const paired = await send({
      port,
      path: `${basePath}/api/pair`,
      method: 'POST',
      headers: {
        origin: `http://${authority}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token }),
    });
    assert.equal(paired.status, 200);
    assert.deepEqual(JSON.parse(paired.body), { paired: true });
    const setCookie = paired.headers['set-cookie'];
    assert.ok(Array.isArray(setCookie));
    const cookie = setCookie[0].split(';', 1)[0];
    assert.match(cookie, /^dsh_agent_control_center=.+$/);

    const replay = await send({
      port,
      path: `${basePath}/api/pair`,
      method: 'POST',
      headers: {
        origin: `http://${authority}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token }),
    });
    assert.equal(replay.status, 401);

    const hostDenied = await send({
      port,
      path: `${basePath}/api/snapshot`,
      headers: { host: 'attacker.invalid', cookie },
    });
    assert.equal(hostDenied.status, 403);
    const originDenied = await send({
      port,
      path: `${basePath}/api/snapshot`,
      headers: { origin: 'http://attacker.invalid', cookie },
    });
    assert.equal(originDenied.status, 403);

    const authorized = await send({ port, path: `${basePath}/api/snapshot`, headers: { cookie } });
    assert.equal(authorized.status, 200);
    assert.deepEqual(JSON.parse(authorized.body), snapshot);

    const initialEvent = new Promise((resolve, reject) => {
      sseRequest = httpRequest({
        host: '127.0.0.1',
        port,
        path: `${basePath}/api/events`,
        headers: { cookie },
      }, response => {
        assert.equal(response.statusCode, 200);
        response.on('data', chunk => {
          const text = chunk.toString('utf8');
          if (text.includes('event: snapshot')) resolve(text);
        });
        response.on('error', reject);
      });
      sseRequest.on('error', error => {
        if (!sseRequest.destroyed) reject(error);
      });
      sseRequest.end();
    });
    const event = await initialEvent;
    assert.match(event, /event: snapshot\ndata: /);
    assert.match(event, /"bootId":"integration-boot"/);
    assert.equal(activeSubscriptions, 1, 'SSE should remain subscribed while the client is connected');

    unregister();
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('SSE subscription was not removed after route teardown')), 1000);
      const check = () => {
        if (unsubscribeCalls > 0) {
          clearTimeout(deadline);
          resolve();
        } else setTimeout(check, 5);
      };
      check();
    });
    assert.equal(activeSubscriptions, 0);
  } finally {
    sseRequest?.destroy();
    unregister();
    await new Promise(resolve => server.close(resolve));
  }
});

test('SSE disconnect during catalog refresh releases the listener before refresh completes', async () => {
  let route;
  let authority = '';
  let resolveRefresh;
  let resolveSubscribed;
  const subscribed = new Promise(resolve => { resolveSubscribed = resolve; });
  let activeSubscriptions = 0;
  const collector = {
    refresh: () => new Promise(resolve => { resolveRefresh = resolve; }),
    snapshot: () => snapshot,
    subscribe() {
      activeSubscriptions += 1;
      resolveSubscribed();
      return () => { activeSubscriptions -= 1; };
    },
  };
  const pairing = createPairingStore({ secret: authoritySecret });
  const webServer = { register(value) { route = value; return () => { route = undefined; }; } };
  const unregister = registerDashboardRoutes({ webServer, collector, pairing, getAuthority: () => authority });
  const server = createServer((req, res) => {
    if (route && req.url?.startsWith(route.path)) route.handler(req, res);
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  authority = `127.0.0.1:${address.port}`;
  const request = httpRequest({
    host: '127.0.0.1',
    port: address.port,
    path: `${basePath}/api/events`,
    headers: { cookie: `dsh_agent_control_center=${pairing.createCookie(authority)}` },
  });
  request.on('error', () => {});
  request.end();
  try {
    await subscribed;
    request.destroy();
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('SSE listener was not released after client disconnect')), 1000);
      const check = () => {
        if (activeSubscriptions === 0) { clearTimeout(deadline); resolve(); }
        else setTimeout(check, 5);
      };
      check();
    });
    resolveRefresh();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(activeSubscriptions, 0);
  } finally {
    resolveRefresh?.();
    unregister();
    await new Promise(resolve => server.close(resolve));
  }
});
