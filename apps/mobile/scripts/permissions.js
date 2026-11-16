'use strict';
// Adds camera + microphone permissions (needed for LIVE and Duets) to the native projects.
const fs = require('fs');
const path = require('path');

const manifest = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
if (fs.existsSync(manifest)) {
  let xml = fs.readFileSync(manifest, 'utf8');
  for (const perm of ['CAMERA', 'RECORD_AUDIO', 'MODIFY_AUDIO_SETTINGS']) {
    const line = `<uses-permission android:name="android.permission.${perm}" />`;
    if (!xml.includes(`android.permission.${perm}"`)) xml = xml.replace('</manifest>', `    ${line}\n</manifest>`);
  }
  fs.writeFileSync(manifest, xml);
  console.log('Android: camera/microphone permissions added');
}

const plist = path.join(__dirname, '..', 'ios', 'App', 'App', 'Info.plist');
if (fs.existsSync(plist)) {
  let xml = fs.readFileSync(plist, 'utf8');
  const add = (key, text) => { if (!xml.includes(`<key>${key}</key>`)) xml = xml.replace(/<dict>/, `<dict>\n\t<key>${key}</key>\n\t<string>${text}</string>`); };
  add('NSCameraUsageDescription', 'Clipzy uses the camera for LIVE, Duets and recording videos.');
  add('NSMicrophoneUsageDescription', 'Clipzy uses the microphone for LIVE, Duets and recording videos.');
  add('NSPhotoLibraryUsageDescription', 'Clipzy lets you pick videos and photos to upload.');
  fs.writeFileSync(plist, xml);
  console.log('iOS: camera/microphone/photo descriptions added');
}
