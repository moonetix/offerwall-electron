'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 32;
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, KEY_LENGTH, PARAMS);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const key = await scrypt(String(password), Buffer.from(salt, 'base64'), KEY_LENGTH, PARAMS);
  const expected = Buffer.from(hash, 'base64');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// Unknown emails still cost one scrypt, so response times do not reveal which emails exist.
let dummyHash;
async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword('not-a-real-password');
  await verifyPassword(password, dummyHash);
  return false;
}

// The app keeps the token. The database keeps only its SHA-256.
function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function bearerToken(req) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || '');
  return m ? m[1] : null;
}

function validEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

function validPassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 200;
}

// Small fixed-window limiter for sign-in and sign-up, per client address.
function createRateLimiter({ limit = 20, windowMs = 10 * 60 * 1000 } = {}) {
  const hits = new Map();
  return function allow(key, now = Date.now()) {
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (hits.size > 10000) hits.clear();
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  burnPasswordCheck,
  newSessionToken,
  tokenHash,
  bearerToken,
  validEmail,
  validPassword,
  createRateLimiter,
};
