'use strict';

// Starts the real app against the real server (in memory) and clicks through it.
//   npm run test:smoke                     wall in the browser (shell.openExternal)
//   npm run test:smoke -- --wall-window    wall in the in-app window, with a local stand-in for the wall
// shell.openExternal is recorded instead of opening a browser.
const assert = require('node:assert/strict');
const electron = require('electron');
const { app, BrowserWindow, session } = electron;
const { createApp } = require('../server/src/server');
const { openStore } = require('../server/src/store');
const vectors = require('../server/test/fixtures/moonetix-vectors.json');

const WALL_WINDOW = process.argv.includes('--wall-window');
if (WALL_WINDOW) process.env.OPEN_WALL_IN = 'window';

const external = [];
electron.shell.openExternal = async (url) => {
  external.push(url);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(100);
  }
  throw new Error('timed out waiting for ' + label);
}

let passed = 0;
async function step(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

async function main() {
  const store = openStore(':memory:');
  const server = createApp({
    config: { currencyName: 'Points', sessionDays: 1, appId: vectors.app_id, linkSalt: vectors.link_salt, sub1: 'desktop', postbackKey: vectors.postback_key },
    store,
    log: () => {},
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.EARN_API_URL = base;
  const expectedLink = vectors.walls['1'] + '&sub1=desktop';

  require('../app/main.js');
  await app.whenReady();

  if (WALL_WINDOW) {
    // Stand-in for wall.moonetix.com inside the wall window's own session.
    session.fromPartition('offerwall').protocol.handle('https', (request) => {
      const url = new URL(request.url);
      if (url.origin !== 'https://wall.moonetix.com') return new Response('elsewhere', { status: 200 });
      if (url.pathname === '/redirect') return new Response(null, { status: 302, headers: { Location: 'https://tracker.example.net/click' } });
      const html = `<!doctype html><title>Wall</title>
        <a id="newtab" href="https://offers.example.com/offer/1" target="_blank">offer</a>
        <a id="offsite" href="https://elsewhere.example.com/">offsite</a>
        <a id="redir" href="https://wall.moonetix.com/redirect">redirect</a>
        <a id="file" href="file:///etc/hostname" target="_blank">file</a>
        <a id="inside" href="https://wall.moonetix.com/${vectors.app_id}/offer/7">inside</a>
        <script>
          window.probe = { earn: typeof window.earn, require: typeof require, process: typeof process };
          Notification.requestPermission().then((p) => { window.probe.notification = p; });
        </script>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    });
  }

  const win = await until(() => BrowserWindow.getAllWindows()[0], 'main window');
  const contents = win.webContents;
  if (contents.isLoading()) await new Promise((r) => contents.once('did-finish-load', r));
  const run = (js) => contents.executeJavaScript(js);

  await step('the page has no Node.js and only the earn bridge', async () => {
    assert.equal(await run('typeof require'), 'undefined');
    assert.equal(await run('typeof process'), 'undefined');
    assert.deepEqual(await run('Object.keys(window.earn).sort()'),
      ['getBalance', 'login', 'logout', 'openOfferwall', 'register', 'status']);
  });

  await step('signed out, the Earn button is not shown', async () => {
    await until(() => run('!document.getElementById("signin-section").hidden'), 'sign-in form');
    assert.equal(await run('document.getElementById("earn").offsetHeight'), 0);
    assert.equal((await run('window.earn.openOfferwall()')).error, 'signed_out');
  });

  await step('creating an account needs the 16+ box', async () => {
    await run(`(() => {
      document.getElementById('switch').click();
      const f = document.getElementById('signin');
      f.email.value = 'ana@example.com';
      f.password.value = 'correct horse battery';
      f.requestSubmit();
    })()`);
    await until(() => run('document.getElementById("note").textContent.includes("16 or older")'), 'age message');
    await run(`(() => {
      const f = document.getElementById('signin');
      f.over16.checked = true;
      f.requestSubmit();
    })()`);
    await until(() => run('document.getElementById("balance").textContent === "0 Points"'), 'balance 0');
  });

  if (!WALL_WINDOW) {
    await step('Earn passes the exact signed link to shell.openExternal', async () => {
      await run('document.getElementById("earn").click()');
      await until(() => external.length === 1, 'openExternal');
      assert.deepEqual(external, [expectedLink]);
    });
  } else {
    let wall;
    await step('Earn opens the signed link in the wall window', async () => {
      await run('document.getElementById("earn").click()');
      wall = await until(() => BrowserWindow.getAllWindows().find((w) => w !== win), 'wall window');
      await until(() => wall.webContents.getURL() === expectedLink && !wall.webContents.isLoading(), 'wall loaded');
      assert.deepEqual(external, []);
    });
    const wallRun = (js) => wall.webContents.executeJavaScript(js);

    await step('the wall window has no Node.js, no preload, and no permissions', async () => {
      await until(() => wallRun('window.probe && window.probe.notification'), 'probe');
      assert.deepEqual(await wallRun('window.probe'), { earn: 'undefined', require: 'undefined', process: 'undefined', notification: 'denied' });
    });

    await step('offers in a new tab go to the browser', async () => {
      await wallRun('document.getElementById("newtab").click()');
      await until(() => external.includes('https://offers.example.com/offer/1'), 'new tab offer');
      assert.equal(BrowserWindow.getAllWindows().length, 2);
    });

    await step('off-wall links go to the browser, the window stays on the wall', async () => {
      await wallRun('document.getElementById("offsite").click()');
      await until(() => external.includes('https://elsewhere.example.com/'), 'offsite');
      await sleep(300);
      assert.equal(wall.webContents.getURL(), expectedLink);
    });

    await step('a redirect off the wall goes to the browser', async () => {
      await wallRun('document.getElementById("redir").click()');
      await until(() => external.includes('https://tracker.example.net/click'), 'redirect');
      await sleep(300);
      assert.ok(wall.webContents.getURL().startsWith('https://wall.moonetix.com/'));
    });

    await step('file: links are dropped', async () => {
      const before = external.length;
      await wallRun('document.getElementById("file").click()');
      await sleep(500);
      assert.equal(external.length, before);
      assert.equal(BrowserWindow.getAllWindows().length, 2);
    });

    await step('links inside the wall stay in the window', async () => {
      const before = external.length;
      await wallRun('document.getElementById("inside").click()');
      await until(() => wall.webContents.getURL().endsWith('/offer/7'), 'inside navigation');
      assert.equal(external.length, before);
    });
  }

  await step('a verified postback shows when the window gets focus', async () => {
    const u = new URL(vectors.postbacks.credit_150);
    const res = await fetch(base + u.pathname + u.search);
    assert.equal(await res.text(), 'credited');
    await run('window.dispatchEvent(new Event("focus"))');
    await until(() => run('document.getElementById("balance").textContent === "150 Points"'), 'balance 150');
  });

  await step('the sign-in token never reaches the page', async () => {
    const html = await run('document.documentElement.outerHTML + JSON.stringify(localStorage) + document.cookie');
    assert.doesNotMatch(html, /Bearer|token/i);
  });

  console.log(`# pass ${passed}`);
  server.close();
  store.close();
}

main().then(
  () => app.exit(0),
  (err) => {
    console.error('not ok - ' + (err && err.stack ? err.stack : err));
    app.exit(1);
  },
);
