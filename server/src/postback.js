'use strict';

const { postbackHash, safeEqual, parseAmount } = require('./moonetix');

// Handles GET /moonetix/postback?user={user_id}&tx={transaction_id}&status={status}&reward={reward}&hash={hash}
// Returns { code, body }. Only a stored change, or an event we deliberately skip, gets a 2xx.
function handlePostback(params, { postbackKey, store, log = () => {} }) {
  const tx = params.get('tx') ?? '';
  const user = params.get('user') ?? '';
  const reward = params.get('reward') ?? '';
  const status = params.get('status') ?? '';
  const hash = params.get('hash') ?? '';

  // 1. The hash comes first. Values are used exactly as received.
  const expected = postbackHash(postbackKey, tx, user, reward, status);
  if (!safeEqual(hash, expected)) {
    return { code: 403, body: 'invalid hash' };
  }

  // 2. Shape checks on signed values.
  const rewardMicro = parseAmount(reward);
  if (tx === '' || tx.length > 191 || (status !== '1' && status !== '2') || rewardMicro === null) {
    return { code: 400, body: 'bad request' };
  }

  // 3. Our user IDs are account IDs. Anything else (for example test_user) is not ours.
  if (!/^[1-9]\d{0,14}$/.test(user)) {
    log('postback ignored, unknown user', { tx, user });
    return { code: 200, body: 'ignored: unknown user' };
  }

  let result;
  try {
    result = store.applyPostback({
      transactionId: tx,
      accountId: Number(user),
      rewardMicro,
      status: Number(status),
      offerName: (params.get('offer') || '').slice(0, 200),
    });
  } catch (err) {
    log('postback store error', { tx, error: err.message });
    return { code: 500, body: 'try again' };
  }

  log('postback', { tx, user, status, reward, result });
  return { code: 200, body: result };
}

module.exports = { handlePostback };
