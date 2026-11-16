'use strict';
/**
 * Startup checks for production. Problems that would make the live site insecure or broken
 * stop the server with a clear message; softer gaps are printed as warnings.
 */
const config = require('../config');

function checkProductionConfig(env = process.env) {
  const errors = [];
  const warnings = [];
  if (!config.isProd) return { errors, warnings };

  if (!config.baseUrl.startsWith('https://'))
    errors.push('BASE_URL must be your public https:// address (e.g. https://clipzy.app). Secure cookies and email links depend on it.');
  const m = config.mail;
  const mailReady = (m.provider === 'resend' && m.resendKey) || (m.provider === 'smtp' && m.smtp.host && m.smtp.user && m.smtp.pass);
  if (config.requireEmailVerification && !mailReady)
    errors.push('Email verification is on but no email provider is set. Set MAIL_PROVIDER=smtp with SMTP_HOST/SMTP_USER/SMTP_PASS (e.g. a free Gmail app password), or MAIL_PROVIDER=resend with RESEND_API_KEY, or set REQUIRE_EMAIL_VERIFICATION=false (not recommended).');
  if (m.provider === 'smtp' && m.smtp.secure === 'none')
    errors.push('SMTP_SECURE=none sends passwords unencrypted. Use port 465 or 587.');
  if (!mailReady && !config.requireEmailVerification)
    warnings.push('No email provider: password-reset emails cannot be sent.');
  if (config.mail.provider && /example\.com/.test(config.mail.from))
    errors.push('MAIL_FROM still uses example.com. Set MAIL_FROM to your sending address (your Gmail address for Gmail, or one on your Resend domain).');
  if (env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET)
    errors.push('STRIPE_SECRET_KEY is set without STRIPE_WEBHOOK_SECRET, so paid coins would never be credited.');
  if (env.STRIPE_SECRET_KEY && /^sk_test_/.test(env.STRIPE_SECRET_KEY))
    warnings.push('Stripe is in TEST mode (sk_test_). Real cards will not be charged.');
  if (!config.trustProxy)
    warnings.push('TRUST_PROXY is off. Behind Railway/Render/Fly/nginx set TRUST_PROXY=1 so rate limits see real visitor IPs.');
  if (!env.VERIFY_KEY)
    warnings.push('VERIFY_KEY is not set, so the owner cannot give verification badges.');
  if (!config.iceServers.some((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u))))
    warnings.push('No TURN server in ICE_SERVERS. LIVE video will fail for viewers on strict mobile/corporate networks.');
  if (!env.FIREBASE_SERVICE_ACCOUNT)
    warnings.push('FIREBASE_SERVICE_ACCOUNT is not set. Push notifications work in browsers/installed web app, but not in the Android app.');
  if (!config.contactEmail)
    warnings.push('CONTACT_EMAIL is not set. The Terms/Privacy pages have no contact address.');
  return { errors, warnings };
}

module.exports = { checkProductionConfig };
