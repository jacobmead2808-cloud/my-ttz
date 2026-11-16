'use strict';
// SMTP email: protocol, authentication, encoding and header-injection safety (local mock server).
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { sendSmtp } = require('../server/lib/smtp');

function mockServer() {
  const sessions = [];
  const server = net.createServer((sock) => {
    const s = { commands: [], data: '' };
    sessions.push(s);
    let inData = false;
    let buf = '';
    sock.write('220 mock ESMTP\r\n');
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; sock.write('250 queued\r\n'); } else s.data += `${line}\n`;
          continue;
        }
        s.commands.push(line);
        if (/^EHLO/.test(line)) sock.write('250-mock\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n');
        else if (/^AUTH PLAIN/.test(line)) sock.write(line.endsWith(Buffer.from('\0me@gmail.com\0apppassword').toString('base64')) ? '235 ok\r\n' : '535 bad\r\n');
        else if (/^MAIL FROM|^RCPT TO/.test(line)) sock.write('250 ok\r\n');
        else if (line === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('502 ?\r\n');
      }
    });
  });
  return { server, sessions };
}

test('sends a plain-text email with auth, UTF-8 subject and no header injection', async () => {
  const { server, sessions } = mockServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await sendSmtp({ host: '127.0.0.1', port, secure: 'none', user: 'me@gmail.com', pass: 'apppassword', from: 'Clipzy <me@gmail.com>',
    to: 'friend@example.com', subject: 'Confirm your Clipzy email ✓\r\nBcc: victim@example.com', text: 'Hi\nclick https://x.test/verify?token=abc\n.\nbye' });
  const s = sessions[0];
  assert.ok(s.commands.includes('MAIL FROM:<me@gmail.com>'));
  assert.ok(s.commands.includes('RCPT TO:<friend@example.com>'));
  assert.equal(s.commands.filter((c) => c.startsWith('RCPT')).length, 1, 'injected Bcc is not a recipient');
  const [head, body] = s.data.split('\n\n');
  assert.match(head, /^Subject: =\?UTF-8\?B\?/m);
  assert.doesNotMatch(head, /^Bcc:/m, 'no injected header line');
  assert.equal(Buffer.from(body.replace(/\n/g, ''), 'base64').toString(), 'Hi\r\nclick https://x.test/verify?token=abc\r\n.\r\nbye');
  server.close();
});

test('wrong password is reported as an error', async () => {
  const { server } = mockServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await assert.rejects(sendSmtp({ host: '127.0.0.1', port: server.address().port, secure: 'none', user: 'me@gmail.com', pass: 'nope', from: 'me@gmail.com', to: 'a@b.co', subject: 's', text: 't' }), /SMTP 535/);
  server.close();
});

test('refuses servers without STARTTLS when STARTTLS is required', async () => {
  const { server } = mockServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await assert.rejects(sendSmtp({ host: '127.0.0.1', port: server.address().port, secure: 'starttls', user: 'me@gmail.com', pass: 'apppassword', from: 'me@gmail.com', to: 'a@b.co', subject: 's', text: 't' }), /STARTTLS/);
  server.close();
});
