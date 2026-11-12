'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWallLink, postbackHash, safeEqual, parseAmount, formatAmount } = require('../src/moonetix');
const { vectors } = require('./helpers');

test('postback hash matches a postback signed by Moonetix', () => {
  const u = new URL(vectors.postbacks.credit_150);
  const p = u.searchParams;
  assert.equal(postbackHash(vectors.postback_key, p.get('tx'), p.get('user'), p.get('reward'), p.get('status')), p.get('hash'));
});

test('safeEqual compares strings of any length without throwing', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', 'a'), false);
});

test('amounts are parsed into exact integers', () => {
  assert.equal(parseAmount('150'), 150000000);
  assert.equal(parseAmount('0.75'), 750000);
  assert.equal(parseAmount('1.23456'), 1234560);
  for (const bad of ['', '-1', '1e3', '1.1234567', 'abc', '1.']) assert.equal(parseAmount(bad), null, bad);
  assert.equal(formatAmount(151984560), '151.98456');
  assert.equal(formatAmount(-750000), '-0.75');
  assert.equal(formatAmount(0), '0');
});

test('signed link matches the link Moonetix builds for the same keys', () => {
  for (const userId of ['1', '2', '42']) {
    assert.equal(buildWallLink({ appId: vectors.app_id, linkSalt: vectors.link_salt, userId }), vectors.walls[userId]);
  }
});

test('sub IDs are added only when valid, and never change the hash', () => {
  const url = buildWallLink({
    appId: vectors.app_id,
    linkSalt: vectors.link_salt,
    userId: '42',
    subs: { sub1: 'desktop', sub2: 'bad value!', sub9: 'x' },
  });
  assert.equal(url, vectors.walls['42'] + '&sub1=desktop');
});

test('user IDs outside the documented characters are refused', () => {
  for (const userId of ['', 'a b', 'x'.repeat(101), 'name<script>']) {
    assert.throws(() => buildWallLink({ appId: vectors.app_id, linkSalt: vectors.link_salt, userId }));
  }
});
