'use strict';

const $ = (id) => document.getElementById(id);
const NOTE = $('note').textContent;
let creating = false;

const MESSAGES = {
  wrong_email_or_password: 'Wrong email or password.',
  email_taken: 'An account with this email already exists.',
  invalid_email: 'Enter a valid email address.',
  password_8_to_200_characters: 'Use a password of at least 8 characters.',
  must_be_16_or_older: 'You must be 16 or older to earn rewards.',
  too_many_attempts: 'Too many attempts. Try again in a few minutes.',
  server_unreachable: 'The server is not reachable right now.',
};

async function render() {
  const { signedIn } = await window.earn.status();
  $('signin-section').hidden = signedIn;
  $('earn-section').hidden = !signedIn;
  if (signedIn) await refreshBalance();
}

// The balance always comes from your server, which credits it from postbacks.
async function refreshBalance() {
  const res = await window.earn.getBalance();
  if (res.ok) {
    $('balance').textContent = res.balance + ' ' + res.currency;
  } else if (res.error === 'signed_out') {
    render();
  } else {
    $('balance').textContent = 'Balance not available right now.';
  }
}

$('switch').addEventListener('click', () => {
  creating = !creating;
  $('age-row').hidden = !creating;
  $('form-title').textContent = creating ? 'Create account' : 'Sign in';
  $('submit').textContent = creating ? 'Create account' : 'Sign in';
  $('switch').textContent = creating ? 'I already have an account' : 'Create an account';
});

$('signin').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const email = String(form.get('email'));
  const password = String(form.get('password'));
  const res = creating
    ? await window.earn.register(email, password, form.get('over16') === 'on')
    : await window.earn.login(email, password);
  $('note').textContent = res.ok ? NOTE : MESSAGES[res.error] || 'Something went wrong. Try again.';
  if (res.ok) render();
});

$('earn').addEventListener('click', async () => {
  const button = $('earn');
  button.disabled = true;
  const res = await window.earn.openOfferwall();
  if (res.ok) {
    $('note').textContent = res.where === 'browser'
      ? 'The offerwall opened in your browser. New points show here when they arrive.'
      : 'New points show here when they arrive.';
  } else if (res.error === 'signed_out') {
    render();
  } else {
    $('note').textContent = 'Offers are not available right now.';
  }
  button.disabled = false;
});

$('signout').addEventListener('click', async () => {
  await window.earn.logout();
  render();
});

// The user comes back from the browser: reload the balance.
window.addEventListener('focus', () => {
  if (!$('earn-section').hidden) refreshBalance();
});

render();
