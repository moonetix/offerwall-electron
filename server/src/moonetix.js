'use strict';

const crypto = require('node:crypto');

const WALL_BASE = 'https://wall.moonetix.com/';
const USER_ID_RE = /^[A-Za-z0-9._@:+-]{1,100}$/;
const SUB_ID_RE = /^[A-Za-z0-9._~:@+-]{1,100}$/;
const AMOUNT_RE = /^(\d{1,9})(?:\.(\d{1,6}))?$/;

// Units of 1/1,000,000 coin. Integers keep balances exact.
const MICRO = 1000000;

// Builds the signed offerwall link for one of YOUR account IDs. Server side only:
// the link hash salt must never ship in the app.
function buildWallLink({ appId, linkSalt, userId, subs = {} }) {
  const uid = String(userId);
  if (!USER_ID_RE.test(uid)) throw new Error('user_id must be 1 to 100 characters from A-Z a-z 0-9 . _ @ : + -');
  const hash = crypto.createHmac('sha256', linkSalt).update(uid).digest('hex');
  let url = `${WALL_BASE}${encodeURIComponent(appId)}?user_id=${encodeURIComponent(uid)}&hash=${hash}`;
  for (const [key, value] of Object.entries(subs)) {
    if (/^sub[1-5]$/.test(key) && SUB_ID_RE.test(String(value))) {
      url += `&${key}=${encodeURIComponent(String(value))}`;
    }
  }
  return url;
}

function postbackHash(postbackKey, tx, userId, reward, status) {
  return crypto.createHmac('sha256', postbackKey).update(`${tx}:${userId}:${reward}:${status}`).digest('hex');
}

function safeEqual(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// "150" -> 150000000, "0.75" -> 750000. Returns null for anything else.
function parseAmount(value) {
  const m = AMOUNT_RE.exec(String(value));
  if (!m) return null;
  return Number(m[1]) * MICRO + Number((m[2] || '').padEnd(6, '0'));
}

function formatAmount(micro) {
  const sign = micro < 0 ? '-' : '';
  const abs = Math.abs(micro);
  const whole = Math.floor(abs / MICRO);
  const frac = String(abs % MICRO).padStart(6, '0').replace(/0+$/, '');
  return sign + whole + (frac ? '.' + frac : '');
}

module.exports = { WALL_BASE, buildWallLink, postbackHash, safeEqual, parseAmount, formatAmount };
