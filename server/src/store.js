'use strict';

const { DatabaseSync } = require('node:sqlite');

function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      age_confirmed_at TEXT NOT NULL,
      balance_micro INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      token_hash TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS moonetix_transactions (
      transaction_id TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      reward_micro INTEGER NOT NULL,
      status INTEGER NOT NULL CHECK (status IN (1, 2)),
      offer_name TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS moonetix_transactions_account ON moonetix_transactions (account_id, created_at);
  `);

  const q = {
    insertAccount: db.prepare(`INSERT INTO accounts (email, password_hash, age_confirmed_at)
      VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT (email) DO NOTHING`),
    byEmail: db.prepare('SELECT * FROM accounts WHERE email = ?'),
    byId: db.prepare('SELECT * FROM accounts WHERE id = ?'),
    addBalance: db.prepare('UPDATE accounts SET balance_micro = balance_micro + ? WHERE id = ?'),
    insertToken: db.prepare('INSERT INTO auth_tokens (token_hash, account_id, expires_at) VALUES (?, ?, ?)'),
    accountForToken: db.prepare(`SELECT a.* FROM auth_tokens t JOIN accounts a ON a.id = t.account_id
      WHERE t.token_hash = ? AND t.expires_at > ?`),
    deleteToken: db.prepare('DELETE FROM auth_tokens WHERE token_hash = ?'),
    deleteExpired: db.prepare('DELETE FROM auth_tokens WHERE expires_at <= ?'),
    getTx: db.prepare('SELECT * FROM moonetix_transactions WHERE transaction_id = ?'),
    insertTx: db.prepare(`INSERT INTO moonetix_transactions (transaction_id, account_id, reward_micro, status, offer_name)
      VALUES (?, ?, ?, 1, ?) ON CONFLICT (transaction_id) DO NOTHING`),
    reverseTx: db.prepare("UPDATE moonetix_transactions SET status = 2, updated_at = CURRENT_TIMESTAMP WHERE transaction_id = ? AND status = 1"),
    history: db.prepare(`SELECT offer_name, reward_micro, status, created_at, updated_at FROM moonetix_transactions
      WHERE account_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`),
  };

  function inTransaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const now = () => Math.floor(Date.now() / 1000);

  return {
    // Returns the new account, or null when the email is taken.
    createAccount(email, passwordHash) {
      const res = q.insertAccount.run(email, passwordHash);
      return res.changes === 1 ? q.byId.get(Number(res.lastInsertRowid)) : null;
    },

    findByEmail(email) {
      return q.byEmail.get(email) || null;
    },

    getAccount(id) {
      return q.byId.get(id) || null;
    },

    saveToken(accountId, hash, ttlSeconds) {
      q.deleteExpired.run(now());
      q.insertToken.run(hash, accountId, now() + ttlSeconds);
    },

    accountForToken(hash) {
      return q.accountForToken.get(hash, now()) || null;
    },

    deleteToken(hash) {
      q.deleteToken.run(hash);
    },

    history(accountId, limit = 20) {
      return q.history.all(accountId, limit);
    },

    // Applies one verified postback. Returns what happened, as a short word.
    applyPostback({ transactionId, accountId, rewardMicro, status, offerName }) {
      return inTransaction(() => {
        const account = q.byId.get(accountId);
        if (status === 1) {
          if (q.getTx.get(transactionId)) return 'duplicate';
          if (!account) return 'unknown_user';
          const res = q.insertTx.run(transactionId, accountId, rewardMicro, offerName || null);
          if (res.changes !== 1) return 'duplicate';
          q.addBalance.run(rewardMicro, accountId);
          return 'credited';
        }
        const tx = q.getTx.get(transactionId);
        if (!tx) return 'not_credited';
        if (tx.status === 2) return 'duplicate';
        if (tx.account_id !== accountId) return 'user_mismatch';
        q.reverseTx.run(transactionId);
        // Take back exactly what was credited, never more.
        q.addBalance.run(-tx.reward_micro, tx.account_id);
        return 'reversed';
      });
    },

    close() {
      db.close();
    },
  };
}

module.exports = { openStore };
