'use strict';
/**
 * Builds the Clipzy Android app.
 *
 *   npm run build:android -- --url https://your-domain     signed release APK + AAB (Google Play)
 *   npm run build:android -- --url https://... --unsigned   release build without signing (checks only)
 *   npm run build:android:dev                               debug APK for an emulator/phone on this PC
 *                                                           (talks to http://localhost:4000 through `adb reverse`)
 *
 * Outputs go to apps/mobile/dist/. Release builds refuse any localhost / http / placeholder address.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const android = path.join(root, 'android');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const fail = (m) => { console.error(`\n  ${m}\n`); process.exit(1); };

const dev = flag('dev');
let url;
if (dev) {
  url = `http://localhost:${opt('port') || 4000}`;
} else {
  url = (opt('url') || process.env.CLIPZY_URL || '').replace(/\/$/, '');
  if (!url) fail('Give your site address: npm run build:android -- --url https://your-domain');
  let u;
  try { u = new URL(url); } catch { fail(`Not a valid address: ${url}`); }
  if (u.protocol !== 'https:') fail('The app must use your https:// address.');
  if (/^(localhost|127\.|10\.0\.2\.2|0\.0\.0\.0|192\.168\.)|YOUR-DOMAIN/i.test(u.hostname)) fail(`${u.hostname} is not a public address.`);
  if (u.pathname !== '/' || u.search) fail('Use the site root, e.g. https://clipzy.app');
}

// Push needs Firebase's google-services.json; without it the plugin is left out (it would crash on start).
const hasFirebase = fs.existsSync(path.join(android, 'app', 'google-services.json'));
const includePlugins = ['@capacitor/app', ...(hasFirebase ? ['@capacitor/push-notifications'] : [])];
const capConfig = {
  appId: 'com.clipzy.app',
  appName: 'Clipzy',
  webDir: 'www',
  backgroundColor: '#0e0e10',
  server: { url, cleartext: dev, errorPath: 'index.html' },
  android: { includePlugins, allowMixedContent: false, webContentsDebuggingEnabled: dev },
  plugins: { PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] } },
};
fs.writeFileSync(path.join(root, 'capacitor.config.json'), `${JSON.stringify(capConfig, null, 2)}\n`);
console.log(`App will open: ${url}`);
console.log(`Push notifications: ${hasFirebase ? 'included (google-services.json found)' : 'not included (add android/app/google-services.json from Firebase)'}`);

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
// Windows runs .cmd/.bat through cmd.exe; arguments here are fixed by this script, never user text.
const run = (cmd, a, o = {}) => {
  const win = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  const r = win ? spawnSync('cmd.exe', ['/d', '/c', cmd, ...a], { stdio: 'inherit', ...o }) : spawnSync(cmd, a, { stdio: 'inherit', ...o });
  if (r.status !== 0) fail(`${path.basename(cmd)} ${a.join(' ')} failed`);
};
run(npx, ['cap', 'sync', 'android'], { cwd: root });
run(process.execPath, [path.join(__dirname, 'permissions.js')], { cwd: root });

// Gradle 8.14 runs on JDK 17-24. Pick a suitable JDK if the default one is newer.
function javaVersion(home) {
  const r = spawnSync(path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), ['-version'], { encoding: 'utf8' });
  const m = String(r.stderr || r.stdout || '').match(/version "(\d+)/);
  return m ? Number(m[1]) : NaN;
}
function pickJdk() {
  const ok = (h) => { const v = javaVersion(h); return v >= 17 && v <= 24; };
  const candidates = [process.env.ANDROID_JAVA_HOME, process.env.JAVA_HOME].filter(Boolean);
  const scan = ['C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Java', 'C:\\Program Files\\Microsoft', path.join(require('os').homedir(), '.jdks'),
    '/usr/lib/jvm', '/Library/Java/JavaVirtualMachines'];
  for (const dir of scan) {
    if (!fs.existsSync(dir)) continue;
    for (const d of fs.readdirSync(dir).sort().reverse()) {
      const home = fs.existsSync(path.join(dir, d, 'Contents', 'Home')) ? path.join(dir, d, 'Contents', 'Home') : path.join(dir, d);
      if (/(^|[^0-9])(21|17)([^0-9]|$)/.test(d)) candidates.push(home);
    }
  }
  candidates.push('C:\\Program Files\\Android\\Android Studio\\jbr');
  return candidates.find((h) => fs.existsSync(h) && ok(h));
}
const jdk = pickJdk();
if (!jdk) fail('Install JDK 21 (https://adoptium.net) — Android builds need Java 17-24.');
console.log(`Using JDK: ${jdk}`);

const keystore = fs.existsSync(path.join(android, 'keystore.properties'));
const unsigned = flag('unsigned');
if (!dev && !keystore && !unsigned) fail('No signing key yet. Create one with: npm run keystore   (keep the file and password safe — Google Play needs the same key for every update)');

const gradlew = path.join(android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
const props = [`-PclipzyVersionCode=${pkg.versionCode || 1}`, `-PclipzyVersionName=${pkg.version}`];
const tasks = dev ? ['assembleDebug'] : ['assembleRelease', 'bundleRelease'];
const env = { ...process.env, JAVA_HOME: jdk };
run(gradlew, [...tasks, ...props, '--console=plain'], { cwd: android, env });

const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
const out = path.join(android, 'app', 'build', 'outputs');
const copy = (from, name) => { if (fs.existsSync(from)) { fs.copyFileSync(from, path.join(dist, name)); console.log(`  -> dist/${name}`); return true; } return false; };
console.log('\nBuilt:');
if (dev) copy(path.join(out, 'apk', 'debug', 'app-debug.apk'), 'clipzy-dev.apk');
else {
  const v = pkg.version;
  copy(path.join(out, 'apk', 'release', 'app-release.apk'), `clipzy-${v}.apk`) || copy(path.join(out, 'apk', 'release', 'app-release-unsigned.apk'), `clipzy-${v}-unsigned.apk`);
  copy(path.join(out, 'bundle', 'release', 'app-release.aab'), `clipzy-${v}${keystore ? '' : '-unsigned'}.aab`);
}
