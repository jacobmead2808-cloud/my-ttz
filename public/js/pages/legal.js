// Terms of Service, Privacy Policy, Community Guidelines and Safety centre.
// These are starting templates written for this app's actual features. Have them reviewed by a
// lawyer for your country before relying on them.
import { h } from '../lib/dom.js';
import { store } from '../lib/store.js';
import { BRAND } from '../brand.js';

const UPDATED = '16 November 2026';

function contact() {
  const email = store.config && store.config.contactEmail;
  return email ? h('a.link', { href: `mailto:${email}` }, email) : 'the Report tools in the app';
}

const P = (...t) => h('p', ...t);
const UL = (...items) => h('ul', items.map((i) => h('li', i)));
const H = (t) => h('h2', t);

const PAGES = {
  terms: {
    title: 'Terms of Service',
    body: () => [
      P(`These terms are an agreement between you and the operator of ${BRAND.name} ("we", "us"). By creating an account or using ${BRAND.name} you agree to them.`),
      H('1. Who can use the service'),
      UL(`You must be at least 13 years old. If you are under the age of digital consent where you live, you need permission from a parent or guardian.`,
        'You must be 18 or older to go LIVE, buy coins or send gifts.',
        'You must give accurate sign-up information, including your date of birth, and keep your password secure.',
        'You may not impersonate any person or organisation, or create accounts to evade a suspension or ban.'),
      H('2. Your content'),
      P('You keep ownership of the videos, comments, messages and other content you post. You give us a worldwide, non-exclusive, royalty-free licence to host, store, copy, display, distribute and adapt (for example, resize or caption) that content in order to run and promote the service. This licence ends when you delete the content or your account, except for copies kept for legal reasons or already shared by others (for example, duets and stitches).'),
      P('You are responsible for what you post and confirm you have the rights to it, including any music.'),
      H('3. Rules'),
      P('You must follow the ', h('a.link', { href: '/guidelines' }, 'Community Guidelines'), '. We may remove content, limit features (such as commenting or LIVE) or suspend or ban accounts that break them. Automated tools help us review content; serious decisions can be escalated to a person.'),
      H('4. Coins, gifts and diamonds'),
      UL('Coins are a limited, revocable licence to use virtual items in the service. They have no cash value, are not property, cannot be transferred outside the service and are not refundable except where the law requires.',
        'Gifts sent to creators are converted into diamonds. Any cash-out of diamonds is subject to separate creator terms, identity checks and the law where you live. We may change prices and rates.',
        'Purchases are processed by our payment provider (Stripe). We do not store your card details.'),
      H('5. Ending your account'),
      P('You can delete your account at any time in Settings. We may suspend or end accounts that break these terms or the law.'),
      H('6. Disclaimers and liability'),
      P(`${BRAND.name} is provided "as is". To the extent the law allows, we are not liable for indirect or consequential losses, or for content posted by users. Nothing in these terms limits rights you have under consumer law that cannot be excluded.`),
      H('7. Changes and contact'),
      P('We may update these terms and will tell you about important changes in the app. Questions: ', contact(), '.'),
    ],
  },
  privacy: {
    title: 'Privacy Policy',
    body: () => [
      P(`This policy explains what ${BRAND.name} collects, why, and the choices you have.`),
      H('What we collect'),
      UL('Account data: email address, username, display name, password (stored only as a secure hash), date of birth (never shown publicly).',
        'Content: videos, captions, comments, stories, LIVE chat, direct messages and reports you make.',
        'Activity: follows, likes, views, watch time used for recommendations and creator analytics.',
        'Technical data: IP address and browser/device information, used for security, rate limiting and session management.',
        'Payments: coin purchases are handled by Stripe, which receives your payment details; we only receive the result.'),
      H('How we use it'),
      UL('To run the service: show your feed, deliver messages and notifications, host LIVE streams.',
        'To keep people safe: detect spam, abuse and policy violations (automated checks and human review), and to enforce age limits.',
        'To send account emails such as email confirmation and password resets. We do not send marketing email without your consent.'),
      H('Who can see your information'),
      UL('Public profile details and public videos can be seen by anyone. Private accounts are visible only to approved followers.',
        'Direct messages are visible to the people in the conversation. Moderators may review them when they are reported.',
        'Service providers that host the site, send email (Resend), process payments (Stripe) and, if enabled, scan text for harmful content.',
        'Authorities, when the law requires it or to prevent serious harm.'),
      P('We do not sell your personal information.'),
      H('Your choices'),
      UL('Make your account private, limit who can message or comment, hide your liked videos, and block or restrict people — all in Settings.',
        'Change your email or password, see where you are signed in and log out of other devices.',
        'Delete your account in Settings → Account. This permanently removes your profile, videos, comments, likes, messages and uploaded files. Backups are overwritten within 7 days.'),
      H('Children'),
      P(`${BRAND.name} is not for children under 13. Accounts for people under 18 start private, can only be messaged by friends and cannot go LIVE, buy coins or send gifts. If you believe a child under 13 has an account, report it to `, contact(), ' and we will remove it.'),
      H('Retention and security'),
      P('We keep data while your account exists. Logs are kept for a short period for security. Passwords are hashed with scrypt, sessions use secure cookies, and the site is served over HTTPS.'),
      H('Contact'),
      P('Privacy questions or requests (access, correction, deletion): ', contact(), '.'),
    ],
  },
  guidelines: {
    title: 'Community Guidelines',
    body: () => [
      P(`${BRAND.name} is for creativity and real connection. These rules apply to videos, LIVE, comments, messages, profiles and usernames.`),
      H('Not allowed'),
      UL('Sexual content involving minors, or any sexualisation of minors. We report this to the authorities.',
        'Nudity and sexually explicit content.',
        'Threats, harassment, bullying, doxxing (sharing someone\'s private information) and encouraging others to target someone.',
        'Hate speech or attacks based on race, ethnicity, religion, nationality, disability, sex, gender identity or sexual orientation.',
        'Violent extremism, graphic violence, and promoting self-harm, suicide or eating disorders.',
        'Dangerous challenges and content that encourages illegal or dangerous activity, including the sale of drugs or weapons.',
        'Scams, spam, fake engagement, and impersonating people, brands or staff.',
        'Content you do not have the rights to post.'),
      H('LIVE and gifts'),
      UL('You must be 18+ to go LIVE, buy coins or send gifts.', 'Do not ask viewers, especially younger viewers, for gifts in exchange for personal attention or anything off-platform.', 'Hosts can appoint moderators, mute, slow down or remove people from their chat.'),
      H('How we enforce'),
      P('Automated checks and our moderators review content and reports. Depending on how serious it is, we may remove content, issue a warning, restrict features such as commenting or LIVE, or suspend or permanently ban an account. Repeated violations lead to stronger action.'),
      H('Reporting'),
      P('Use Report on any video, comment, LIVE, message or profile. Reports are confidential: the person you report is not told who reported them. See the ', h('a.link', { href: '/safety' }, 'Safety centre'), ' for more tools.'),
    ],
  },
  safety: {
    title: 'Safety centre',
    body: () => [
      P('Tools that help you control your experience:'),
      UL('Report: on any video, comment, LIVE, message or profile, open the menu and choose Report.',
        'Block: blocked people cannot find your profile, see your videos, message you or join your LIVE.',
        'Private account: only followers you approve can see your videos and stories.',
        'Messages and comments: choose who can message you or comment on your videos, and filter keywords or links in Settings.',
        'Sessions: see every device signed in to your account and log them out in Settings → Security.'),
      H('For teens and parents'),
      UL('Accounts for people aged 13-17 start private, can only be messaged by friends, and cannot go LIVE, buy coins or send gifts.',
        'Date of birth is set when you sign up and cannot be changed later, which prevents people switching off these protections.',
        'Talk to someone you trust if anything on the app makes you uncomfortable. Never share passwords, your address, or move a conversation off the app with someone you have not met.'),
      H('If someone is in danger'),
      P('If you or someone else is in immediate danger, contact your local emergency services first. To report a serious safety issue to us: ', contact(), '.'),
    ],
  },
};

export default function legalPage(ctx) {
  const pg = PAGES[ctx.mode] || PAGES.terms;
  const nav = h('nav.legal-nav', Object.entries(PAGES).map(([k, p]) => h('a', { href: `/${k}`, class: k === ctx.mode ? 'active' : '' }, p.title)));
  return {
    title: pg.title,
    el: h('article.legal-page',
      h('h1', pg.title),
      h('p.muted.small', `Last updated ${UPDATED}`),
      nav,
      ...pg.body(),
      h('p.legal-note.muted', 'These documents are templates written for how this app actually works. The site operator should have them reviewed by a lawyer in their country.')),
  };
}
