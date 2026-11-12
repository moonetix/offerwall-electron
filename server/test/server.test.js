'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { vectors, startServer } = require('./helpers');

test('accounts, signed links and postbacks end to end', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  let ana;
  let ben;
  const me = async (token) => (await app.request('GET', '/api/me', { token })).json();

  await t.test('sign-up needs a valid email, a password and the 16+ confirmation', async () => {
    const tries = [
      [{ email: 'nope', password: 'longenough', over16: true }, 'invalid_email'],
      [{ email: 'a@example.com', password: 'short', over16: true }, 'password_8_to_200_characters'],
      [{ email: 'a@example.com', password: 'longenough' }, 'must_be_16_or_older'],
      [{ email: 'a@example.com', password: 'longenough', over16: 'yes' }, 'must_be_16_or_older'],
    ];
    for (const [body, error] of tries) {
      const res = await app.request('POST', '/api/register', { body });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error });
    }
  });

  await t.test('sign-up creates account IDs 1 and 2', async () => {
    ana = await app.register('ana@example.com');
    ben = await app.register('ben@example.com');
    assert.match(ana, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(await me(ana), { userId: '1', email: 'ana@example.com', balance: '0', currency: 'Coins', history: [] });
    assert.equal((await me(ben)).userId, '2');
    const again = await app.request('POST', '/api/register', { body: { email: 'ANA@example.com', password: 'something else', over16: true } });
    assert.equal(again.status, 409);
  });

  await t.test('sign-in works only with the right password', async () => {
    const good = await app.request('POST', '/api/login', { body: { email: 'ana@example.com', password: 'correct horse battery' } });
    assert.equal(good.status, 200);
    const { token } = await good.json();
    assert.equal((await me(token)).userId, '1');
    for (const body of [{ email: 'ana@example.com', password: 'wrong password' }, { email: 'nobody@example.com', password: 'whatever1' }, {}]) {
      const res = await app.request('POST', '/api/login', { body });
      assert.equal(res.status, 401);
    }
    assert.equal((await app.request('POST', '/api/logout', { token })).status, 200);
    assert.equal((await app.request('GET', '/api/me', { token })).status, 401);
  });

  await t.test('only a stored token is accepted, never a user ID from the client', async () => {
    assert.equal((await app.request('GET', '/api/me')).status, 401);
    assert.equal((await app.request('GET', '/api/me', { token: 'x'.repeat(43) })).status, 401);
    assert.equal((await app.request('GET', '/api/offerwall-link?user_id=2')).status, 401);
  });

  await t.test('the link is signed for the signed-in account', async () => {
    let res = await app.request('GET', '/api/offerwall-link?user_id=2&userId=2', { token: ana });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { url: vectors.walls['1'] + '&sub1=desktop' });
    res = await app.request('GET', '/api/offerwall-link', { token: ben });
    assert.deepEqual(await res.json(), { url: vectors.walls['2'] + '&sub1=desktop' });
  });

  await t.test('no secret ever appears in an answer', async () => {
    const bodies = [
      await (await app.request('GET', '/api/offerwall-link', { token: ana })).text(),
      await (await app.request('GET', '/api/me', { token: ana })).text(),
    ];
    for (const body of bodies) {
      assert.doesNotMatch(body, new RegExp(vectors.link_salt));
      assert.doesNotMatch(body, new RegExp(vectors.postback_key));
    }
  });

  await t.test('a real Moonetix postback credits the account once', async () => {
    let res = await app.postback(vectors.postbacks.credit_150);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'credited');
    res = await app.postback(vectors.postbacks.credit_150);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'duplicate');
    const view = await me(ana);
    assert.equal(view.balance, '150');
    assert.deepEqual(view.history.map((h) => [h.offer, h.reward, h.status]), [['Bigo Live & "Friends"', '150', 'credited']]);
  });

  await t.test('decimal rewards add up exactly', async () => {
    assert.equal(await (await app.postback(vectors.postbacks.credit_decimal)).text(), 'credited');
    assert.equal(await (await app.postback(vectors.postbacks.credit_five_decimals)).text(), 'credited');
    assert.equal((await me(ana)).balance, '151.98456');
  });

  await t.test('postbacks for other users stay with them', async () => {
    assert.equal(await (await app.postback(vectors.postbacks.credit_user2)).text(), 'credited');
    assert.equal((await me(ben)).balance, '40');
    assert.equal(await (await app.postback(vectors.postbacks.reverse_other_user)).text(), 'user_mismatch');
    assert.equal((await me(ana)).balance, '151.98456');
  });

  await t.test('a reversal takes back exactly what was credited, once', async () => {
    assert.equal(await (await app.postback(vectors.postbacks.reverse_150)).text(), 'reversed');
    assert.equal(await (await app.postback(vectors.postbacks.reverse_150)).text(), 'duplicate');
    const view = await me(ana);
    assert.equal(view.balance, '1.98456');
    assert.equal(view.history.find((h) => h.reward === '150').status, 'reversed');
    // A credit retried after its reversal must not credit again.
    assert.equal(await (await app.postback(vectors.postbacks.credit_150)).text(), 'duplicate');
    assert.equal((await me(ana)).balance, '1.98456');
  });

  await t.test('reversal of a transaction that was never credited changes nothing', async () => {
    const res = await app.postback(vectors.postbacks.reverse_never_credited);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'not_credited');
    assert.equal((await me(ana)).balance, '1.98456');
  });

  await t.test('unknown users get 200 so Moonetix stops retrying', async () => {
    assert.equal(await (await app.postback(vectors.postbacks.credit_test_user)).text(), 'ignored: unknown user');
    assert.equal(await (await app.postback(vectors.postbacks.credit_missing_account)).text(), 'unknown_user');
  });

  await t.test('tampered or wrongly signed postbacks get 403 and change nothing', async () => {
    const before = (await me(ana)).balance;
    const tamper = (name, field, value) => {
      const u = new URL(vectors.postbacks[name]);
      u.searchParams.set(field, value);
      return u.toString();
    };
    const bad = [
      vectors.postbacks.credit_wrong_key,
      tamper('credit_decimal', 'reward', '75'),
      tamper('credit_decimal', 'reward', '0.750'),
      tamper('credit_decimal', 'user', '2'),
      tamper('credit_decimal', 'tx', 'tx_9002'),
      tamper('reverse_150', 'status', '1'),
      tamper('credit_decimal', 'hash', ''),
      tamper('credit_decimal', 'hash', new URL(vectors.postbacks.credit_decimal).searchParams.get('hash').toUpperCase()),
    ];
    for (const url of bad) {
      const res = await app.postback(url);
      assert.equal(res.status, 403, url);
    }
    assert.equal((await me(ana)).balance, before);
  });

  await t.test('unsigned fields like payout and offer do not affect the hash check', async () => {
    const u = new URL(vectors.postbacks.credit_user2);
    u.searchParams.set('payout', '9999');
    assert.equal((await app.postback(u.toString())).status, 200);
  });

  await t.test('sign-in attempts are rate limited per address', async () => {
    let last;
    for (let i = 0; i < 25; i++) {
      last = await app.request('POST', '/api/login', { body: { email: 'ana@example.com', password: 'wrong password' } });
    }
    assert.equal(last.status, 429);
  });
});
