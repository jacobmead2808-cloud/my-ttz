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
  if (config.requireEmailVerification && !(config.mail.provider === 'resend' && config.mail.resendKey))
    errors.push('Email verification is on but no email provider is set. Set MAIL_PROVIDER=resend, RESEND_API_KEY and MAIL_FROM, or set REQUIRE_EMAIL_VERIFICATION=false (not recommended).');
  if (config.mail.provider === 'resend' && /example\.com/.test(config.mail.from))
    errors.push('MAIL_FROM still uses example.com. Use an address on the domain you verified in Resend.');
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
  if (!config.contactEmail)
    warnings.push('CONTACT_EMAIL is not set. The Terms/Privacy pages have no contact address.');
  return { errors, warnings };
}

module.exports = { checkProductionConfig };
