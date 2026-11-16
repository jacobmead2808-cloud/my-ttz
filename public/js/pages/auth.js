// Login, sign-up, forgot password and reset password screens.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';
import { BRAND } from '../brand.js';
import { toast } from '../components/ui.js';
import { afterLogin } from '../app.js';

let heroThumbs = null;
function hero() {
  const phones = h('div.auth-phones', h('div.auth-phone'), h('div.auth-phone'), h('div.auth-phone'));
  if (!heroThumbs) heroThumbs = api.get('/discover').then((d) => d.trending.filter((v) => v.thumbUrl).slice(0, 3)).catch(() => []);
  heroThumbs.then((vs) => vs.forEach((v, i) => phones.children[i] && phones.children[i].appendChild(h('img', { src: v.thumbUrl, alt: '' }))));
  return h('section.auth-hero',
    h('div.hero-blob', { style: { background: '#ff2d6f', top: '-40px', left: '-40px' } }),
    h('div.hero-blob', { style: { background: '#1f6feb', bottom: '-60px', right: '-20px', animationDelay: '-5s' } }),
    h('h2', 'Make every ', h('span.grad-text', 'second'), ' count.'),
    h('p', `Short videos, real-time LIVE and your people — all on ${BRAND.name}.`),
    phones);
}

function shell(title, sub, form, foot) {
  return h('div.auth-split', hero(), h('div.auth-page',
    h('a.auth-close.icon-btn', { href: '/', 'aria-label': 'Close' }, icon('close')),
    h('div.auth-card',
      h('img.auth-logo', { src: BRAND.logo, alt: '', width: 56, height: 56 }),
      h('h1.auth-title', title),
      sub ? h('p.muted.auth-sub', sub) : null,
      form,
      foot ? h('div.auth-foot', foot) : null)));
}

function input(name, type, placeholder, attrs = {}) {
  return h('input.input', { name, type, placeholder, 'aria-label': placeholder, required: true, ...attrs });
}

function errorBox() { return h('div.form-error.hidden', { role: 'alert' }); }
const showErr = (box, msg) => { box.textContent = msg; box.classList.toggle('hidden', !msg); };

function pwInput(name, placeholder, autocomplete) {
  const inp = input(name, 'password', placeholder, { autocomplete, minlength: 8 });
  const eye = h('button.pw-eye', { type: 'button', 'aria-label': 'Show password', onclick: () => { inp.type = inp.type === 'password' ? 'text' : 'password'; } }, icon('eye', { size: 18 }));
  const wrap = h('div.pw-wrap', inp, eye);
  wrap.input = inp;
  return wrap;
}

export default function authPage(ctx) {
  const next = ctx.query.get('next') || '/';
  const q = next !== '/' ? `?next=${encodeURIComponent(next)}` : '';

  if (ctx.mode === 'login') {
    const err = errorBox();
    const login = input('login', 'text', 'Email or username', { autocomplete: 'username', maxlength: 254 });
    const pw = pwInput('password', 'Password', 'current-password');
    const btn = h('button.btn.btn-primary.btn-block.btn-lg', { type: 'submit' }, 'Log in');
    const form = h('form.stack', {
      onsubmit: async (e) => {
        e.preventDefault();
        showErr(err, '');
        btn.disabled = true;
        try {
          const r = await api.post('/auth/login', { login: login.value, password: pw.input.value });
          toast(`Welcome back, ${r.user.displayName}!`, { type: 'success' });
          afterLogin(r.user, next);
        } catch (ex) { showErr(err, ex.message); btn.disabled = false; }
      },
    }, err, login, pw, h('a.link.small', { href: '/forgot' }, 'Forgot password?'), btn);
    return { title: 'Log in', el: shell(`Log in to ${BRAND.name}`, 'Manage your account, check notifications, comment on videos, and more.', form, ["Don't have an account? ", h('a.link', { href: `/signup${q}` }, 'Sign up')]) };
  }

  if (ctx.mode === 'signup') {
    const err = errorBox();
    const email = input('email', 'email', 'Email address', { autocomplete: 'email', maxlength: 254 });
    const username = input('username', 'text', 'Username (public, not your email)', { autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', minlength: 2, maxlength: 24, pattern: '[A-Za-z0-9_][A-Za-z0-9_.]*' });
    const display = input('displayName', 'text', 'Display name (optional)', { required: false, maxlength: 40 });
    const pw = pwInput('password', 'Password', 'new-password');
    const today = new Date().toISOString().slice(0, 10);
    const dob = h('input.input', { name: 'birthDate', type: 'date', required: true, max: today, min: '1900-01-01', 'aria-label': 'Date of birth', autocomplete: 'bday' });
    const dobField = h('label.field-inline', h('span.small.muted', 'Date of birth (not shown publicly)'), dob);
    const terms = h('input', { type: 'checkbox', name: 'acceptTerms', required: true, 'aria-label': 'I agree to the Terms of Service and Community Guidelines' });
    const termsRow = h('label.check-row', terms, h('span.small', 'I agree to the ',
      h('a.link', { href: '/terms', target: '_blank' }, 'Terms of Service'), ' and ',
      h('a.link', { href: '/guidelines', target: '_blank' }, 'Community Guidelines'), ', and I have read the ',
      h('a.link', { href: '/privacy', target: '_blank' }, 'Privacy Policy'), '.'));
    const pwHint = h('ul.pw-rules',
      h('li', { dataset: { rule: 'len' } }, '8+ characters'), h('li', { dataset: { rule: 'letter' } }, 'A letter'), h('li', { dataset: { rule: 'num' } }, 'A number'));
    pw.input.addEventListener('input', () => {
      const v = pw.input.value;
      pwHint.querySelector('[data-rule=len]').classList.toggle('ok', v.length >= 8);
      pwHint.querySelector('[data-rule=letter]').classList.toggle('ok', /[a-zA-Z]/.test(v));
      pwHint.querySelector('[data-rule=num]').classList.toggle('ok', /[0-9]/.test(v));
    });
    username.addEventListener('input', () => { username.value = username.value.toLowerCase().replace(/[^a-z0-9_.]/g, ''); });
    const btn = h('button.btn.btn-primary.btn-block.btn-lg', { type: 'submit' }, 'Sign up');
    const form = h('form.stack', {
      onsubmit: async (e) => {
        e.preventDefault();
        showErr(err, '');
        btn.disabled = true;
        try {
          const r = await api.post('/auth/register', { email: email.value, username: username.value, displayName: display.value, password: pw.input.value, birthDate: dob.value, acceptTerms: terms.checked });
          toast(r.user.emailVerified ? `Welcome to ${BRAND.name}, @${r.user.username}!` : `Welcome, @${r.user.username}! Check your email to confirm your address.`, { type: 'success' });
          afterLogin(r.user, next);
        } catch (ex) { showErr(err, ex.message); btn.disabled = false; }
      },
    }, err, email, username, display, pw, pwHint, dobField, termsRow, btn,
    h('p.muted.small', `You must be 13 or older to use ${BRAND.name}. Accounts under 18 start private and can't go LIVE or buy coins.`));
    return { title: 'Sign up', el: shell(`Sign up for ${BRAND.name}`, 'Create a profile, follow other accounts, make your own videos, and more.', form, ['Already have an account? ', h('a.link', { href: `/login${q}` }, 'Log in')]) };
  }

  if (ctx.mode === 'forgot') {
    const err = errorBox();
    const email = input('email', 'email', 'Email address', { autocomplete: 'email' });
    const btn = h('button.btn.btn-primary.btn-block.btn-lg', { type: 'submit' }, 'Send reset link');
    const done = h('div.form-success.hidden');
    const form = h('form.stack', {
      onsubmit: async (e) => {
        e.preventDefault();
        showErr(err, '');
        btn.disabled = true;
        try {
          const r = await api.post('/auth/forgot', { email: email.value });
          done.replaceChildren(...[h('p', r.message), r.devNote ? h('p.muted.small', r.devNote) : null].filter(Boolean));
          done.classList.remove('hidden');
        } catch (ex) { showErr(err, ex.message); } finally { btn.disabled = false; }
      },
    }, err, done, email, btn);
    return { title: 'Reset password', el: shell('Reset password', "Enter your account's email and we'll send you a link to reset your password.", form, [h('a.link', { href: '/login' }, 'Back to log in')]) };
  }

  if (ctx.mode === 'verify') {
    const token = ctx.query.get('token') || '';
    const status = h('div.stack', h('p.muted', 'Confirming your email...'));
    (async () => {
      try {
        if (!token) throw new Error('This link is missing its token. Request a new one from the banner at the top of the app.');
        await api.post('/auth/verify-email', { token });
        try { const r = await api.get('/auth/me'); if (r.user) { const { setMe } = await import('../lib/store.js'); setMe(r.user); } } catch { /* signed out */ }
        status.replaceChildren(h('div.form-success', h('p', 'Your email is confirmed. You can now post, comment and message.')),
          h('a.btn.btn-primary.btn-block.btn-lg', { href: '/' }, `Go to ${BRAND.name}`));
      } catch (ex) {
        status.replaceChildren(h('div.form-error', { role: 'alert' }, ex.message), h('a.btn.btn-secondary.btn-block', { href: '/' }, 'Back to home'));
      }
    })();
    return { title: 'Confirm email', el: shell('Confirm your email', null, status, null) };
  }

  // reset
  const token = ctx.query.get('token') || '';
  const err = errorBox();
  const pw = pwInput('password', 'New password', 'new-password');
  const pw2 = pwInput('password2', 'Confirm new password', 'new-password');
  const btn = h('button.btn.btn-primary.btn-block.btn-lg', { type: 'submit' }, 'Set new password');
  const form = h('form.stack', {
    onsubmit: async (e) => {
      e.preventDefault();
      showErr(err, '');
      if (pw.input.value !== pw2.input.value) return showErr(err, 'Passwords do not match');
      btn.disabled = true;
      try {
        await api.post('/auth/reset', { token, password: pw.input.value });
        toast('Password updated. Please log in.', { type: 'success' });
        navigate('/login', { replace: true });
      } catch (ex) { showErr(err, ex.message); btn.disabled = false; }
    },
  }, err, pw, pw2, btn);
  if (!token) showErr(err, 'This reset link is missing its token. Request a new one.');
  return { title: 'Choose a new password', el: shell('Choose a new password', 'You will be logged out of all devices.', form, [h('a.link', { href: '/forgot' }, 'Request a new link')]) };
}
