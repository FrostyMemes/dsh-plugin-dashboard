import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPairingStore,
  PAIRING_TTL_MS,
  readCookie,
  requestAuthority,
  SESSION_TTL_SECONDS,
} from '../dist/host/security.js';

const secret = Buffer.alloc(32, 0x5a).toString('base64url');

test('pairing tokens are one-use and bound to their issuing authority', () => {
  const store = createPairingStore({ secret, random: () => Buffer.alloc(32, 1) });
  const token = store.issue('127.0.0.1:4312');

  assert.equal(store.consume(token, '127.0.0.1:4312'), true);
  assert.equal(store.consume(token, '127.0.0.1:4312'), false);

  const second = store.issue('127.0.0.1:4312');
  assert.equal(store.consume(second, '127.0.0.1:4313'), false);
  assert.equal(store.consume(second, '127.0.0.1:4312'), false, 'a mismatched attempt consumes the token');
  assert.equal(store.size, 0);
});

test('pairing tokens expire at the TTL boundary and invalid tokens are rejected', () => {
  let now = 1000;
  const store = createPairingStore({ secret, now: () => now, random: () => Buffer.alloc(32, 2) });
  const token = store.issue('localhost:4312');

  now += PAIRING_TTL_MS - 1;
  assert.equal(store.consume(token, 'localhost:4312'), true);

  const expired = store.issue('localhost:4312');
  now += PAIRING_TTL_MS;
  assert.equal(store.consume(expired, 'localhost:4312'), false);
  assert.equal(store.consume({}, 'localhost:4312'), false);
  assert.equal(store.consume('x'.repeat(129), 'localhost:4312'), false);
});

test('signed session cookies are authority-bound, tamper evident, and expire', () => {
  let now = 50_000;
  const store = createPairingStore({ secret, now: () => now });
  const cookie = store.createCookie('localhost:4312');

  assert.equal(store.verifyCookie(cookie, 'localhost:4312'), true);
  assert.equal(store.verifyCookie(cookie, 'localhost:4313'), false);
  assert.equal(store.verifyCookie(`${cookie.slice(0, -1)}${cookie.endsWith('a') ? 'b' : 'a'}`, 'localhost:4312'), false);
  assert.equal(store.verifyCookie(undefined, 'localhost:4312'), false);

  now += SESSION_TTL_SECONDS * 1000;
  assert.equal(store.verifyCookie(cookie, 'localhost:4312'), false);
});

test('request authority requires the expected Host and rejects cross-origin metadata', () => {
  const expected = '127.0.0.1:4312';
  const request = (headers) => ({ headers });

  assert.equal(requestAuthority(request({ host: expected }), expected), true);
  assert.equal(requestAuthority(request({}), expected), false);
  assert.equal(requestAuthority(request({ host: 'evil.example' }), expected), false);
  assert.equal(requestAuthority(request({ host: expected, origin: `http://${expected}` }), expected), true);
  assert.equal(requestAuthority(request({ host: expected, origin: `https://${expected}` }), expected), false);
  assert.equal(requestAuthority(request({ host: expected, origin: 'http://evil.example' }), expected), false);
  assert.equal(requestAuthority(request({ host: expected, 'sec-fetch-site': 'same-origin' }), expected), true);
  assert.equal(requestAuthority(request({ host: expected, 'sec-fetch-site': 'none' }), expected), true);
  assert.equal(requestAuthority(request({ host: expected, 'sec-fetch-site': 'cross-site' }), expected), false);
});

test('cookie parsing trims pair boundaries and matches the exact cookie name', () => {
  const request = (cookie) => ({ headers: cookie === undefined ? {} : { cookie } });

  assert.equal(readCookie(request('other=x; session = abc%3D; theme=dark'), 'session'), 'abc%3D');
  assert.equal(readCookie(request('session=a=b; session=second'), 'session'), 'a=b');
  assert.equal(readCookie(request('xsession=wrong; session-extra=wrong'), 'session'), undefined);
  assert.equal(readCookie(request(undefined), 'session'), undefined);
  assert.equal(readCookie(request('session'), 'session'), undefined);
});
