// ------------------------------------------------------------------
// Branding: change the name, tagline and logo files here.
// Colours live in /css/identity.css (:root --brand).
// Logo + favicon files: /assets/brand/logo.svg and /assets/brand/favicon.svg
// Default avatar: /assets/default-avatar.svg
// ------------------------------------------------------------------
export const BRAND = {
  name: 'Clipzy',
  tagline: 'Make every second count.',
  logo: '/assets/brand/logo.svg',
  defaultAvatar: '/assets/default-avatar.svg',
  placeholderThumb: '/assets/placeholder-thumb.svg',
  // Download links shown on the "Get the app" page (/download). Leave '' to show "coming soon".
  // After building the apps (see APPS.md), upload the files (e.g. GitHub Releases) and paste the links here.
  downloads: {
    windows: '', // e.g. https://github.com/you/clipzy/releases/latest/download/Clipzy-Setup.exe
    mac: '', // .dmg
    linux: '', // .AppImage
    android: '/downloads/clipzy.apk', // Google Play link or .apk (the APK is uploaded with the site, not kept in Git)
    ios: '', // App Store link
  },
};
