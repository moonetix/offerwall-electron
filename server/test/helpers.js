'use strict';

const { createApp } = require('../src/server');
const { openStore } = require('../src/store');
const vectors = require('./fixtures/moonetix-vectors.json');

const config = {
  port: 0,
  host: '127.0.0.1',
  databasePath: ':memory:',
  currencyName: 'Coins',
  sessionDays: 30,
  appId: vectors.app_id,
  linkSalt: vectors.link_salt,
  sub1: 'desktop',
  postbackKey: vectors.postback_key,
};

async function startServer() {
  const store = openStore(':memory:');
  const logs = [];
  const server = createApp({ config, store, log: (m, d) => logs.push([m, d]) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    store,
    logs,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      store.close();
    },
    request(method, path, { body, token } = {}) {
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (token) headers.Authorization = `Bearer ${token}`;
      return fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    },
    async register(email, password = 'correct horse battery') {
      const res = await this.request('POST', '/api/register', { body: { email, password, over16: true } });
      return (await res.json()).token;
    },
    // Sends a postback URL from the fixtures to this server.
    postback(url) {
      const u = new URL(url);
      return fetch(base + u.pathname + u.search);
    },
  };
}

module.exports = { config, vectors, startServer };
