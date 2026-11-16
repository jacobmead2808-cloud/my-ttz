'use strict';
/**
 * Creates the release signing key for the Android app (run once): npm run keystore
 * You choose the password. It writes android/clipzy-release.jks and android/keystore.properties
 * (both git-ignored). BACK THEM UP: Google Play only accepts updates signed with the same key.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const android = path.join(__dirname, '..', 'android');
const jks = path.join(android, 'clipzy-release.jks');
const propsFile = path.join(android, 'keystore.properties');
if (fs.existsSync(jks) || fs.existsSync(propsFile)) {
  console.error('A signing key already exists (android/clipzy-release.jks). Keep using it; delete it only if you have never published with it.');
  process.exit(1);
}

function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); else rl.output.write('*'); };
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
  });
}

(async () => {
  const name = (await ask('Your name or organisation (shown in the certificate): ')).trim() || 'Clipzy';
  const pw = await ask('Choose a keystore password (8+ characters): ', true);
  if (pw.length < 8) { console.error('Password too short.'); process.exit(1); }
  if ((await ask('Repeat the password: ', true)) !== pw) { console.error('Passwords do not match.'); process.exit(1); }

  const keytool = [process.env.ANDROID_JAVA_HOME, process.env.JAVA_HOME].filter(Boolean)
    .map((h) => path.join(h, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool')).find((p) => fs.existsSync(p)) || 'keytool';
  const dname = `CN=${name.replace(/[,=+<>#;"\\]/g, ' ')}, O=${name.replace(/[,=+<>#;"\\]/g, ' ')}`;
  const r = spawnSync(keytool, ['-genkeypair', '-v', '-keystore', jks, '-storetype', 'PKCS12', '-alias', 'clipzy', '-keyalg', 'RSA', '-keysize', '4096',
    '-validity', '10000', '-storepass', pw, '-keypass', pw, '-dname', dname], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) { console.error('keytool failed. Install JDK 21 (https://adoptium.net) or set JAVA_HOME.'); process.exit(1); }
  fs.writeFileSync(propsFile, `storeFile=clipzy-release.jks\nstorePassword=${pw}\nkeyAlias=clipzy\nkeyPassword=${pw}\n`);
  console.log('\nSigning key created: apps/mobile/android/clipzy-release.jks');
  console.log('Back up that file AND your password somewhere safe (password manager). Losing them means you cannot update the app on Google Play.');
})();
