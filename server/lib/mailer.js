'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * Sends an email. With no provider configured (development), the message is printed to the
 * console and written to data/outbox so you can click password-reset links locally.
 * Set MAIL_PROVIDER=resend + RESEND_API_KEY + MAIL_FROM to deliver real email.
 */
async function sendMail({ to, subject, text }) {
  if (config.mail.provider === 'resend') {
    if (!config.mail.resendKey) throw new Error('RESEND_API_KEY is not set');
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.mail.resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.mail.from, to: [to], subject, text }),
    });
    if (!r.ok) throw new Error(`Email provider error ${r.status}: ${await r.text()}`);
    return { delivered: true };
  }
  fs.mkdirSync(config.outboxDir, { recursive: true });
  const file = path.join(config.outboxDir, `${Date.now()}-${to.replace(/[^a-z0-9@._-]/gi, '_')}.txt`);
  fs.writeFileSync(file, `To: ${to}\nSubject: ${subject}\n\n${text}\n`);
  console.log(`\n[mail:dev] To: ${to}\n[mail:dev] Subject: ${subject}\n${text}\n[mail:dev] (saved to ${file})\n`);
  return { delivered: false };
}

module.exports = { sendMail };
