'use strict';
/**
 * Minimal SMTP client (no dependencies) for sending account emails through any mail server, e.g.
 * Gmail with an app password: smtp.gmail.com, port 465 (TLS) or 587 (STARTTLS).
 * TLS is always required in production. Only plain-text emails are sent.
 */
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const os = require('os');

const clean = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
const addr = (s) => { const m = String(s).match(/<([^>]+)>/); return clean(m ? m[1] : s); };

function connection(socket) {
  let buf = '';
  let waiter = null;
  const lines = [];
  const pump = () => {
    // A reply ends with a line "250 text" (code + space); "250-text" lines continue it.
    const idx = lines.findIndex((l) => /^\d{3} /.test(l) || /^\d{3}$/.test(l));
    if (idx >= 0 && waiter) {
      const reply = lines.splice(0, idx + 1);
      const w = waiter; waiter = null;
      w.resolve({ code: Number(reply[reply.length - 1].slice(0, 3)), text: reply.join('\n') });
    }
  };
  const onData = (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\r\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 2); } pump(); };
  const onError = (e) => { if (waiter) { const w = waiter; waiter = null; w.reject(e); } };
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', () => onError(new Error('SMTP connection closed')));
  const read = () => new Promise((resolve, reject) => { waiter = { resolve, reject }; pump(); });
  return {
    async cmd(line, expect) {
      if (line !== null) socket.write(`${line}\r\n`);
      const r = await read();
      if (expect && !expect.includes(r.code)) throw new Error(`SMTP ${r.code} after ${line ? line.split(' ')[0] : 'connect'}: ${r.text.slice(0, 200)}`);
      return r;
    },
    detach() { socket.off('data', onData); socket.off('error', onError); },
  };
}

/**
 * @param {object} o { host, port, user, pass, secure ('tls' | 'starttls' | 'none'), from, to, subject, text }
 */
async function sendSmtp(o) {
  const timeout = 20000;
  const name = os.hostname().replace(/[^a-z0-9.-]/gi, '') || 'localhost';
  let socket = o.secure === 'tls'
    ? tls.connect({ host: o.host, port: o.port, servername: o.host, timeout })
    : net.connect({ host: o.host, port: o.port, timeout });
  socket.setTimeout(timeout, () => socket.destroy(new Error('SMTP timeout')));
  let c = connection(socket);
  try {
    await c.cmd(null, [220]);
    let ehlo = await c.cmd(`EHLO ${name}`, [250]);
    if (o.secure === 'starttls') {
      if (!/STARTTLS/i.test(ehlo.text)) throw new Error('SMTP server does not offer STARTTLS');
      await c.cmd('STARTTLS', [220]);
      c.detach();
      socket = tls.connect({ socket, servername: o.host });
      await new Promise((res, rej) => { socket.once('secureConnect', res); socket.once('error', rej); });
      c = connection(socket);
      ehlo = await c.cmd(`EHLO ${name}`, [250]);
    }
    if (o.user) {
      if (/AUTH[^\n]*PLAIN/i.test(ehlo.text)) await c.cmd(`AUTH PLAIN ${Buffer.from(`\0${o.user}\0${o.pass}`).toString('base64')}`, [235]);
      else {
        await c.cmd('AUTH LOGIN', [334]);
        await c.cmd(Buffer.from(o.user).toString('base64'), [334]);
        await c.cmd(Buffer.from(o.pass).toString('base64'), [235]);
      }
    }
    await c.cmd(`MAIL FROM:<${addr(o.from)}>`, [250]);
    await c.cmd(`RCPT TO:<${addr(o.to)}>`, [250, 251]);
    await c.cmd('DATA', [354]);
    const domain = addr(o.from).split('@')[1] || name;
    const body = Buffer.from(String(o.text).replace(/\r?\n/g, '\r\n')).toString('base64').replace(/.{76}/g, '$&\r\n');
    const msg = [
      `From: ${clean(o.from)}`,
      `To: ${addr(o.to)}`,
      `Subject: ${encodeHeader(clean(o.subject))}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@${domain}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      body,
    ].join('\r\n');
    await c.cmd(`${msg}\r\n.`, [250]);
    await c.cmd('QUIT', [221]).catch(() => {});
  } finally {
    socket.destroy();
  }
}

module.exports = { sendSmtp };
