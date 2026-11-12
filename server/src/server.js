'use strict';

const http = require('node:http');
const { loadConfig } = require('./config');
const { openStore } = require('./store');
const { buildWallLink, formatAmount } = require('./moonetix');
const { handlePostback } = require('./postback');
const auth = require('./auth');

function createApp({ config, store, log = defaultLog }) {
  const ctx = { config, store, log, allowAuth: auth.createRateLimiter() };
  return http.createServer(async (req, res) => {
    try {
      await route(req, res, ctx);
    } catch (err) {
      if (err && err.statusCode) return send(res, err.statusCode, { error: err.message });
      log('unhandled error', { error: err && err.message });
      send(res, 500, { error: 'server_error' });
    }
  });
}

async function route(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');
  const { config, store, log } = ctx;
  const key = `${req.method} ${url.pathname}`;

  if (key === 'GET /moonetix/postback') {
    const { code, body } = handlePostback(url.searchParams, { postbackKey: config.postbackKey, store, log });
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(body);
  }

  if (key === 'GET /health') return send(res, 200, { ok: true });

  if (key === 'POST /api/register' || key === 'POST /api/login') {
    if (!ctx.allowAuth(req.socket.remoteAddress || '')) return send(res, 429, { error: 'too_many_attempts' });
    const body = await readJson(req);
    return key === 'POST /api/register' ? register(res, body, ctx) : login(res, body, ctx);
  }

  if (key === 'POST /api/logout') {
    const token = auth.bearerToken(req);
    if (token) store.deleteToken(auth.tokenHash(token));
    return send(res, 200, { ok: true });
  }

  if (key === 'GET /api/me') {
    const account = currentAccount(req, store);
    if (!account) return send(res, 401, { error: 'signed_out' });
    return send(res, 200, meView(account, store, config));
  }

  if (key === 'GET /api/offerwall-link') {
    // The link is signed for the signed-in account. Anything the client sends is ignored.
    const account = currentAccount(req, store);
    if (!account) return send(res, 401, { error: 'signed_out' });
    const url = buildWallLink({
      appId: config.appId,
      linkSalt: config.linkSalt,
      userId: String(account.id),
      subs: { sub1: config.sub1 },
    });
    return send(res, 200, { url });
  }

  send(res, 404, { error: 'not_found' });
}

async function register(res, body, { config, store }) {
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!auth.validEmail(email)) return send(res, 400, { error: 'invalid_email' });
  if (!auth.validPassword(body.password)) return send(res, 400, { error: 'password_8_to_200_characters' });
  // Moonetix offerwall users must be 16 or older.
  if (body.over16 !== true) return send(res, 400, { error: 'must_be_16_or_older' });
  const account = store.createAccount(email, await auth.hashPassword(body.password));
  if (!account) return send(res, 409, { error: 'email_taken' });
  return send(res, 201, issueToken(account, store, config));
}

async function login(res, body, { config, store }) {
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const account = auth.validEmail(email) ? store.findByEmail(email) : null;
  const ok = account
    ? await auth.verifyPassword(password, account.password_hash)
    : await auth.burnPasswordCheck(password);
  if (!ok) return send(res, 401, { error: 'wrong_email_or_password' });
  return send(res, 200, issueToken(account, store, config));
}

function issueToken(account, store, config) {
  const token = auth.newSessionToken();
  store.saveToken(account.id, auth.tokenHash(token), config.sessionDays * 86400);
  return { token };
}

function currentAccount(req, store) {
  const token = auth.bearerToken(req);
  return token ? store.accountForToken(auth.tokenHash(token)) : null;
}

function meView(account, store, config) {
  return {
    userId: String(account.id),
    email: account.email,
    balance: formatAmount(account.balance_micro),
    currency: config.currencyName,
    history: store.history(account.id).map((row) => ({
      offer: row.offer_name || 'Offer',
      reward: formatAmount(row.reward_micro),
      status: row.status === 1 ? 'credited' : 'reversed',
      at: row.status === 1 ? row.created_at : row.updated_at,
    })),
  };
}

function send(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

function readJson(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('body_too_large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(data && typeof data === 'object' && !Array.isArray(data) ? data : {});
      } catch {
        reject(Object.assign(new Error('invalid_json'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function defaultLog(message, data) {
  console.log(new Date().toISOString(), message, data ? JSON.stringify(data) : '');
}

if (require.main === module) {
  const config = loadConfig();
  const store = openStore(config.databasePath);
  createApp({ config, store }).listen(config.port, config.host, () => {
    console.log(`Listening on http://${config.host}:${config.port}`);
  });
}

module.exports = { createApp };
