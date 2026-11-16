// Admin dashboard: stats, reports queue, user/video/comment moderation, LIVE control, audit log.
// Every action here is enforced server-side by requireAdmin; the UI only mirrors it.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { fmtCount, timeAgo, fullDate } from '../lib/format.js';
import { BRAND } from '../brand.js';
import { toast, toastError, confirmDialog, promptDialog, tabs, loadingBlock, errorState, emptyState, avatar, actionSheet } from '../components/ui.js';
import { store } from '../lib/store.js';
import { coinIcon, money } from '../components/coins.js';

export function riskMeter(score) {
  const tone = score >= 85 ? 'high' : score >= 55 ? 'med' : score >= 30 ? 'low' : 'ok';
  return h(`span.risk-meter.${tone}`, { title: `Risk score ${score}/100` }, h('span.risk-fill', { style: { width: `${score}%` } }), h('b', String(score)));
}

const STATUS_PILL = (s) => h(`span.pill.pill-${s}`, s);

export default function adminPage(ctx) {
  const body = h('div.admin-body');
  let tab = ctx.query.get('tab') || 'overview';

  async function run(fn, ok) {
    try { await fn(); if (ok) toast(ok, { type: 'success' }); show(tab); } catch (e) { toastError(e); }
  }

  const table = (headers, rows) => h('div.table-wrap', h('table.admin-table', h('thead', h('tr', headers.map((x) => h('th', x)))), h('tbody', rows)));
  const searchBar = (placeholder, value, onSearch, extra) => {
    const input = h('input.input', { type: 'search', placeholder, value: value || '' });
    return h('form.admin-search', { onsubmit: (e) => { e.preventDefault(); onSearch(input.value); } }, input, extra || null, h('button.btn.btn-secondary', { type: 'submit' }, 'Search'));
  };

  let reportStatus = 'open';
  async function reports() {
    const status = reportStatus;
    const { reports: list } = await api.get(`/admin/reports?status=${status}`);
    const filter = h('div.seg', ['open', 'resolved', 'dismissed'].map((s) => h(`button.seg-btn${s === status ? '.active' : ''}`, { onclick: () => { reportStatus = s; show('reports'); } }, s)));
    if (!list.length) return h('div.stack', filter, emptyState({ iconName: 'flag', title: status === 'open' ? 'No open reports' : 'Nothing here' }));
    return h('div.stack', filter, ...list.map((r) => h('div.report-card',
      h('div.report-head', h('span.pill', r.targetType), h('b', r.reason.replace(/_/g, ' ')), h('span.muted.small', ` reported by @${r.reporter || 'deleted'} · ${timeAgo(r.createdAt)}`)),
      r.details ? h('p.report-details', r.details) : null,
      r.target ? h('div.report-target', r.target.thumbUrl ? h('img.report-thumb', { src: r.target.thumbUrl, alt: '', onerror: (e) => { e.target.src = BRAND.placeholderThumb; } }) : null,
        h('div', h('a.link', { href: r.target.link, target: '_blank' }, r.target.label.slice(0, 140) || '(no text)'), h('div.muted.small', `${r.target.owner ? '@' + r.target.owner + ' · ' : ''}status: ${r.target.status}`)))
        : h('p.muted', 'Target no longer exists'),
      r.status === 'open'
        ? h('div.row.gap.wrap',
          r.targetType !== 'user' ? h('button.btn.btn-danger.btn-sm', { onclick: () => resolve(r, 'remove_content') }, 'Remove content') : null,
          h('button.btn.btn-secondary.btn-sm', { onclick: () => resolve(r, 'suspend_user') }, 'Suspend owner 7d'),
          h('button.btn.btn-secondary.btn-sm', { onclick: () => resolve(r, 'ban_user') }, 'Ban owner'),
          h('button.btn.btn-ghost.btn-sm', { onclick: () => resolve(r, 'dismiss') }, 'Dismiss'))
        : h('p.muted.small', `${r.status} by @${r.resolver || '?'} · ${r.resolution || ''} · ${r.resolvedAt ? timeAgo(r.resolvedAt) : ''}`))));
  }
  async function resolve(r, action) {
    const note = action === 'dismiss' ? '' : await promptDialog({ title: 'Moderation note', label: 'Reason shown to the user / kept in the audit log', confirmText: 'Apply', danger: action !== 'dismiss' });
    if (note === null) return;
    run(() => api.post(`/admin/reports/${r.id}/resolve`, { action, note }), 'Report resolved');
  }

  let userQuery = '';
  let userStatus = '';
  async function users() {
    const { users: list } = await api.get(`/admin/users?q=${encodeURIComponent(userQuery)}&status=${userStatus}`);
    const statusSel = h('select.input.input-sm', ['', 'active', 'suspended', 'banned'].map((x) => h('option', { value: x, selected: x === userStatus }, x || 'All statuses')));
    statusSel.addEventListener('change', () => { userStatus = statusSel.value; show('users'); });
    return h('div.stack', searchBar('Search username, name or email', userQuery, (qq) => { userQuery = qq; show('users'); }, statusSel),
      h('p.muted.small', 'Open an account to see its full moderation profile: content, behaviour, risk score, history and every action (warn, suspend, ban, verify…).'),
      list.length ? h('div.user-cards', list.map((u) => h('a.user-card', { href: `/admin/user/${u.id}` },
        avatar(u, 44, { link: false }),
        h('div.user-card-main', h('b', u.displayName || u.username, u.verified ? icon('checkCircle', { size: 13, cls: 'verified' }) : null, u.isOwner ? h('span.owner-badge', 'Owner') : u.role === 'admin' ? h('span.role-badge.admin', 'Admin') : null),
          h('span.muted.small', `@${u.username} · ${u.email}`)),
        h('div.user-card-meta', STATUS_PILL(u.status), u.reports ? h('span.pill.pill-danger', `${u.reports} reports`) : null,
          h('span.muted.small', `${fmtCount(u.videos)} videos · ${fmtCount(u.followers)} followers · joined ${timeAgo(u.createdAt)}`)),
        icon('chevronRight', { size: 18 })))) : emptyState({ iconName: 'users', title: 'No users found' }));
  }

  // ---------- Guardian (AI moderation) ----------
  async function overview() {
    const [{ totals: t, daily }, g] = await Promise.all([api.get('/admin/stats'), api.get('/admin/guardian')]);
    const stat = (label, value, ic, tone = '') => h(`div.stat-card${tone ? '.' + tone : ''}`, icon(ic, { size: 22 }), h('b', fmtCount(value)), h('span.muted', label));
    const max = Math.max(1, ...daily.map((d) => Math.max(d.users, d.videos)));
    const chart = h('div.bar-chart', daily.map((d) => h('div.bar-col', { title: `${new Date(d.day).toLocaleDateString()}: ${d.users} users, ${d.videos} videos` },
      h('div.bars', h('div.bar.bar-users', { style: { height: `${(d.users / max) * 100}%` } }), h('div.bar.bar-videos', { style: { height: `${(d.videos / max) * 100}%` } })),
      h('span.bar-label', new Date(d.day).toLocaleDateString(undefined, { day: 'numeric' })))));
    const sweepBtn = h('button.btn.btn-secondary.btn-sm', { onclick: async () => {
      sweepBtn.disabled = true;
      try { const r = await api.post('/admin/guardian/sweep'); toast(`Guardian reviewed ${r.reviewed} active accounts`, { type: 'success' }); show('overview'); } catch (e) { toastError(e); sweepBtn.disabled = false; }
    } }, icon('refresh', { size: 14 }), ' Run sweep now');
    return h('div.stack',
      h('section.guardian-card',
        h('div.guardian-head', h('div.guardian-badge', icon('shield', { size: 26 })),
          h('div', h('h2', 'Guardian', h('span.pill', g.config.enabled ? 'Active' : 'Paused')),
            h('p.muted.small', `Automatic moderation agent · engine: ${g.aiProvider === 'openai' ? 'rules + AI classifier' : 'behaviour rules (add an AI key for text classification)'} · warns at ${g.config.warnAt}, escalates at ${g.config.reviewAt}, suspends at ${g.config.suspendAt}`)),
          sweepBtn),
        h('div.stat-grid',
          stat('Cases need a human', g.stats.openCases, 'flag', g.stats.openCases ? 'danger' : ''),
          stat('Auto-suspensions (24h)', g.stats.autoSuspensions24h, 'block', 'warn'),
          stat('Auto-warnings (24h)', g.stats.autoWarnings24h, 'alert'),
          stat('Accounts at risk', g.stats.riskyUsers, 'users')),
        g.riskiest.length ? h('div', h('h4.share-sub', 'Highest risk right now'), h('div.risk-list', g.riskiest.map((u) => h('a.risk-row', { href: `/admin/user/${u.id}` },
          avatar(u, 30, { link: false }), h('span', `@${u.username}`), STATUS_PILL(u.status), riskMeter(u.riskScore))))) : h('p.muted.small', 'No risky accounts — all quiet.')),
      h('div.stat-grid',
        stat('Total users', t.users, 'users'), stat('Active users', t.activeUsers, 'check'), stat('Suspended', t.suspended, 'alert', 'warn'), stat('Banned', t.banned, 'block', 'danger'),
        stat('Videos', t.videos, 'film'), stat('Removed videos', t.removedVideos, 'trash', 'warn'), stat('Comments', t.comments, 'comment'), stat('Likes', t.likes, 'heart'),
        stat('Video views', t.views, 'eye'), stat('Messages', t.messages, 'message'), stat('Open reports', t.openReports, 'flag', t.openReports ? 'danger' : ''), stat('LIVE now', t.liveNow, 'live')),
      h('section.settings-card', h('h2', 'Last 14 days'), h('div.legend', h('span.lg.lg-users', 'New users'), h('span.lg.lg-videos', 'New videos'), h('span.muted.small', ` · ${t.newUsers7d} users / ${t.newVideos7d} videos in the last 7 days`)), chart));
  }

  let caseStatus = 'open';
  async function cases() {
    const { cases: list } = await api.get(`/admin/cases?status=${caseStatus}`);
    const filter = h('div.seg', ['open', 'resolved'].map((x) => h(`button.seg-btn${x === caseStatus ? '.active' : ''}`, { onclick: () => { caseStatus = x; show('cases'); } }, x === 'open' ? 'Needs review' : 'Resolved')));
    if (!list.length) return h('div.stack', filter, emptyState({ iconName: 'shield', title: caseStatus === 'open' ? 'No cases need a human right now' : 'No resolved cases yet', text: 'Guardian opens a case whenever an account needs a human decision.' }));
    return h('div.stack', filter, ...list.map((c) => h(`div.case-card.sev-${c.severity}`,
      h('div.case-head', avatar({ username: c.username, avatarUrl: c.avatarUrl }, 40, { link: false }),
        h('div', h('a.link', { href: `/admin/user/${c.userId}` }, `@${c.username}`), h('div.muted.small', `${c.source === 'auto' ? 'Opened by Guardian' : 'Opened by staff'} · ${timeAgo(c.createdAt)}`)),
        h(`span.sev-pill.${c.severity}`, c.severity), STATUS_PILL(c.userStatus)),
      h('p.case-summary', c.summary),
      c.autoAction ? h('p.small', h('b', 'Automatic action: '), c.autoAction) : null,
      c.signals.length ? h('div.signal-chips', c.signals.map((x) => h('span.signal-chip', `${x.label}: ${x.value}`, x.points ? h('b', ` +${x.points}`) : null))) : null,
      c.status === 'open' ? h('div.row.gap.wrap',
        h('a.btn.btn-secondary.btn-sm', { href: `/admin/user/${c.userId}` }, 'Open profile'),
        c.userStatus === 'suspended' ? h('button.btn.btn-sm.btn-primary', { onclick: () => resolveCase(c, 'uphold') }, 'Keep suspension') : null,
        c.userStatus === 'suspended' ? h('button.btn.btn-sm.btn-secondary', { onclick: () => resolveCase(c, 'lift') }, 'Lift suspension') : null,
        h('button.btn.btn-sm.btn-secondary', { onclick: () => resolveCase(c, 'warn') }, 'Warn'),
        h('button.btn.btn-sm.btn-secondary', { onclick: () => resolveCase(c, 'suspend') }, 'Suspend 7d'),
        h('button.btn.btn-sm.btn-danger', { onclick: () => resolveCase(c, 'ban') }, 'Ban'),
        h('button.btn.btn-sm.btn-ghost', { onclick: () => resolveCase(c, 'dismiss') }, 'False positive'))
        : h('p.muted.small', `Resolved by @${c.resolver || '?'} · ${c.resolution || ''}`))));
  }
  async function resolveCase(c, action) {
    const note = ['dismiss', 'uphold', 'lift'].includes(action) ? '' : await promptDialog({ title: 'Note', label: 'Reason (shown to the user for warnings/suspensions/bans)', confirmText: 'Apply', danger: action === 'ban' });
    if (note === null) return;
    run(() => api.post(`/admin/cases/${c.id}/resolve`, { action, note }), 'Case resolved');
  }

  // ---------- Economy (owner) ----------
  async function economyView() {
    const e = await api.get('/admin/economy');
    const owner = store.me.isOwner;
    const save = async (patch, msg = 'Saved') => { try { await api.patch('/admin/economy', patch); toast(msg, { type: 'success' }); show('economy'); } catch (err) { toastError(err); } };
    const disc = h('input.input.input-sm', { type: 'number', min: 0, max: 90, value: e.config.discountPercent, disabled: !owner, style: { width: '90px' } });
    const discLabel = h('input.input', { value: e.config.discountLabel || '', maxlength: 60, placeholder: 'Sale name, e.g. Summer sale', disabled: !owner });
    const rate = h('input.input.input-sm', { type: 'number', min: 0, max: 1, step: 0.05, value: e.config.diamondRate, disabled: !owner, style: { width: '90px' } });
    return h('div.stack',
      !owner ? h('p.owner-lock', icon('lock', { size: 14 }), 'Only the platform owner can change the economy.') : null,
      h('div.stat-grid',
        h('div.stat-card', icon('sparkles', { size: 20 }), h('b', fmtCount(e.stats.coinsSold)), h('span.muted', 'Coins sold')),
        h('div.stat-card', icon('chart', { size: 20 }), h('b', money(e.stats.revenueCents, e.config.currency)), h('span.muted', 'Revenue (Stripe)')),
        h('div.stat-card', icon('heart', { size: 20 }), h('b', fmtCount(e.stats.giftsSent7d)), h('span.muted', 'Gifts sent (7d)')),
        h('div.stat-card', icon('live', { size: 20 }), h('b', fmtCount(e.stats.coinsGifted7d)), h('span.muted', 'Coins gifted (7d)'))),
      h('section.settings-card', h('h2', 'Payments'),
        h('p', e.paymentMode === 'stripe' ? 'Stripe is connected — purchases charge real money.' : e.paymentMode === 'demo' ? ' Demo mode — coins are free test credits. Add STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET to sell real coins.' : ' Purchases disabled (production without Stripe).')),
      h('section.settings-card', h('h2', 'Coin discount'),
        h('div.setting-row', h('div', h('div.setting-title', 'Discount on every coin pack (%)'), h('div.muted.small', 'Shown in the Recharge sheet. 0 = no sale.')), disc),
        discLabel,
        h('div', h('button.btn.btn-primary', { disabled: !owner, onclick: () => save({ discountPercent: Number(disc.value), discountLabel: discLabel.value }, 'Discount updated') }, 'Save discount'))),
      h('section.settings-card', h('h2', 'Packs'),
        h('div.pkg-admin', e.packages.map((p) => h('div.pkg-admin-row', h('b', coinIcon(14), ` ${fmtCount(p.coins)}`), h('span', money(p.basePriceCents, e.config.currency)),
          p.priceCents !== p.basePriceCents ? h('span.muted.small', `→ ${money(p.priceCents, e.config.currency)} with discount`) : null)))),
      h('section.settings-card', h('h2', 'Gifts'),
        h('div.setting-row', h('div', h('div.setting-title', 'Gifts enabled'), h('div.muted.small', 'Turn all gifting on or off.')),
          h('label.switch', h('input', { type: 'checkbox', checked: e.config.giftsEnabled, disabled: !owner, onchange: (ev) => save({ giftsEnabled: ev.target.checked }) }), h('span.slider'))),
        h('div.setting-row', h('div', h('div.setting-title', 'Creator share (diamonds per coin)'), h('div.muted.small', '0.5 = creators earn 50% of gifted coins as diamonds.')),
          h('div.row.gap', rate, h('button.btn.btn-secondary.btn-sm', { disabled: !owner, onclick: () => save({ diamondRate: Number(rate.value) }) }, 'Save'))),
        h('div.gift-admin', e.gifts.map((g) => h(`label.gift-admin-item${g.enabled ? '' : '.off'}`,
          h('input', { type: 'checkbox', checked: !e.config.disabledGifts.includes(g.id), disabled: !owner, onchange: (ev) => {
            const off = new Set(e.config.disabledGifts);
            if (ev.target.checked) off.delete(g.id); else off.add(g.id);
            save({ disabledGifts: [...off] }, 'Gift updated');
          } }),
          h('span.gift-art', g.art), h('b', g.name), h('span.muted.small', coinIcon(12), ` ${fmtCount(g.coins)}`))))));
  }

  let videoQuery = '';
  let videoStatus = '';
  async function videos() {
    const { videos: list } = await api.get(`/admin/videos?q=${encodeURIComponent(videoQuery)}&status=${videoStatus}`);
    const statusSel = h('select.input.input-sm', ['', 'active', 'removed'].map((s) => h('option', { value: s, selected: s === videoStatus }, s || 'All')));
    statusSel.addEventListener('change', () => { videoStatus = statusSel.value; show('videos'); });
    return h('div.stack', searchBar('Search caption or username', videoQuery, (q) => { videoQuery = q; show('videos'); }, statusSel),
      list.length ? table(['Video', 'Owner', 'Visibility', 'Status', 'Views', 'Likes', 'Reports', 'Posted', 'Actions'], list.map((v) => h('tr',
        h('td', h('a.admin-video', { href: `/video/${v.id}`, target: '_blank' }, h('img', { src: v.thumbUrl || BRAND.placeholderThumb, alt: '' }), h('span.small', (v.caption || '(no caption)').slice(0, 60)))),
        h('td', `@${v.author.username}`), h('td', v.visibility), h('td', STATUS_PILL(v.status), v.removedReason ? h('div.muted.small', v.removedReason) : null),
        h('td', fmtCount(v.views)), h('td', fmtCount(v.likes)), h('td', v.reports ? h('span.pill.pill-danger', v.reports) : '0'), h('td.small', timeAgo(v.createdAt)),
        h('td.actions',
          v.status === 'active'
            ? h('button.btn.btn-sm.btn-danger', { onclick: async () => {
              const reason = await promptDialog({ title: 'Remove video', label: 'Reason (sent to the creator)', confirmText: 'Remove', danger: true });
              if (reason === null) return;
              run(() => api.post(`/admin/videos/${v.id}/remove`, { reason }), 'Video removed');
            } }, 'Remove')
            : h('button.btn.btn-sm.btn-secondary', { onclick: () => run(() => api.post(`/admin/videos/${v.id}/restore`), 'Video restored') }, 'Restore'),
          h('button.btn.btn-sm.btn-ghost', { onclick: async () => {
            if (!(await confirmDialog({ title: 'Delete permanently?', message: 'The file and all its data are erased. This cannot be undone.', confirmText: 'Delete', danger: true }))) return;
            run(() => api.del(`/admin/videos/${v.id}`), 'Video deleted');
          } }, 'Delete'))))) : emptyState({ iconName: 'film', title: 'No videos found' }));
  }

  let commentQuery = '';
  async function comments() {
    const { comments: list } = await api.get(`/admin/comments?q=${encodeURIComponent(commentQuery)}`);
    return h('div.stack', searchBar('Search comment text or username', commentQuery, (q) => { commentQuery = q; show('comments'); }),
      list.length ? table(['Comment', 'Author', 'Video', 'Status', 'Reports', 'Posted', ''], list.map((c) => h('tr',
        h('td', c.body.slice(0, 160)), h('td', `@${c.username}`), h('td', h('a.link', { href: `/video/${c.videoId}`, target: '_blank' }, (c.videoCaption || `#${c.videoId}`).slice(0, 40))),
        h('td', STATUS_PILL(c.status)), h('td', c.reports ? h('span.pill.pill-danger', c.reports) : '0'), h('td.small', timeAgo(c.createdAt)),
        h('td.actions', c.status === 'active'
          ? h('button.btn.btn-sm.btn-danger', { onclick: () => run(() => api.post(`/admin/comments/${c.id}/remove`), 'Comment removed') }, 'Remove')
          : h('button.btn.btn-sm.btn-secondary', { onclick: () => run(() => api.post(`/admin/comments/${c.id}/restore`), 'Comment restored') }, 'Restore'))))) : emptyState({ iconName: 'comment', title: 'No comments found' }));
  }

  async function live() {
    const { streams } = await api.get('/admin/live');
    return streams.length ? table(['Stream', 'Host', 'Status', 'Viewers', 'Peak', 'Likes', 'Started', ''], streams.map((s) => h('tr',
      h('td', h('a.link', { href: `/live/${s.id}`, target: '_blank' }, s.title)), h('td', `@${s.host.username}`), h('td', STATUS_PILL(s.status)),
      h('td', s.viewers), h('td', s.peakViewers), h('td', fmtCount(s.likes)), h('td.small', timeAgo(s.startedAt)),
      h('td.actions', s.status === 'live' ? h('button.btn.btn-sm.btn-danger', { onclick: async () => {
        if (!(await confirmDialog({ title: `End @${s.host.username}'s LIVE?`, confirmText: 'End LIVE', danger: true }))) return;
        run(() => api.post(`/admin/live/${s.id}/end`), 'LIVE ended');
      } }, 'End') : null)))) : emptyState({ iconName: 'live', title: 'No LIVE streams yet' });
  }

  async function audit() {
    const { entries } = await api.get('/admin/audit');
    return entries.length ? table(['When', 'Admin', 'Action', 'Target', 'Note'], entries.map((e) => h('tr',
      h('td.small', fullDate(e.createdAt)), h('td', `@${e.admin || '?'}`), h('td', h('code', e.action)), h('td', e.targetType ? `${e.targetType} #${e.targetId}` : ''), h('td.small', e.note || '')))) : emptyState({ iconName: 'shield', title: 'No admin actions yet' });
  }



  // ---------- Auto-moderation ----------
  async function automodView() {
    const [{ config: c, last7d }, { entries }] = await Promise.all([api.get('/admin/automod'), api.get('/admin/automod/log')]);
    let words = [...c.blockedWords];
    const save = async (patch, msg = 'Auto-mod updated') => { try { const r = await api.patch('/admin/automod', patch); Object.assign(c, r.config); toast(msg, { type: 'success' }); } catch (e) { toastError(e); } };
    const chips = h('div.word-chips');
    const paint = () => chips.replaceChildren(...words.map((w) => h('span.word-chip', w, h('button', { 'aria-label': `Remove ${w}`, onclick: () => { words = words.filter((x) => x !== w); paint(); save({ blockedWords: words }); } }, icon('close', { size: 12 })))));
    paint();
    const wordIn = h('input.input', { placeholder: 'Add a blocked word or phrase (word* matches prefixes)' });
    const numIn = (key, label, hint, max = 100) => {
      const inp = h('input.input.input-sm', { type: 'number', min: 0, max, value: c[key], style: { width: '90px' } });
      inp.addEventListener('change', () => save({ [key]: Number(inp.value) }));
      return h('div.setting-row', h('div', h('div.setting-title', label), h('div.muted.small', hint)), inp);
    };
    const sw = (key, label, hint) => h('div.setting-row', h('div', h('div.setting-title', label), h('div.muted.small', hint)),
      h('label.switch', h('input', { type: 'checkbox', checked: c[key], onchange: (e) => save({ [key]: e.target.checked }) }), h('span.slider')));
    const actionSeg = h('div.seg', [['hold', 'Hide for review'], ['block', 'Reject']].map(([k, l]) => h(`button.seg-btn${c.action === k ? '.active' : ''}`, { onclick: (e) => { e.currentTarget.parentNode.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active')); e.currentTarget.classList.add('active'); save({ action: k }); } }, l)));
    const tester = h('input.input', { placeholder: 'Test a message against the word list…' });
    const testOut = h('div.small.muted');
    tester.addEventListener('input', async () => {
      if (!tester.value.trim()) { testOut.textContent = ''; return; }
      try { const r = await api.post('/admin/automod/test', { text: tester.value }); testOut.textContent = r.matched ? ` Matches “${r.matched}” (normalized: ${r.normalized})` : ` Allowed (normalized: ${r.normalized})`; } catch { /* ignore */ }
    });
    const counts = Object.fromEntries(last7d.map((x) => [x.rule, x.n]));
    return h('div.stack',
      h('div.stat-grid', ...[['blocked_word', 'Blocked words'], ['spam_repeat', 'Spam repeats'], ['caps', 'Shouting'], ['link', 'Links'], ['creator_keyword', 'Creator filters'], ['report_threshold', 'Auto-hidden']]
        .map(([k, l]) => h('div.stat-card', icon('shield', { size: 20 }), h('b', fmtCount(counts[k] || 0)), h('span.muted', `${l} · 7d`)))),
      h('section.settings-card', h('h2', 'Engine'),
        sw('enabled', 'Auto-moderation', 'Automatically screen comments, LIVE chat, DMs, captions and profiles. Admins are never filtered.'),
        h('div.setting-row', h('div', h('div.setting-title', 'When a comment or chat message breaks a rule'), h('div.muted.small', 'Hidden content stays visible to its author only. DMs, captions and profiles are always rejected.')), actionSeg)),
      h('section.settings-card', h('h2', 'Blocked words'), h('p.muted.small', 'Matching ignores case, leetspeak (fr33 → free) and stretched letters (sooo → soo).'),
        h('form.row.gap', { onsubmit: (e) => { e.preventDefault(); const w = wordIn.value.trim().toLowerCase(); if (w && !words.includes(w)) { words.push(w); paint(); save({ blockedWords: words }); } wordIn.value = ''; } }, wordIn, h('button.btn.btn-primary', { type: 'submit' }, 'Add')),
        chips, tester, testOut),
      h('section.settings-card', h('h2', 'Spam & safety rules'),
        sw('blockLinks', 'Block links from new accounts', 'Links in comments/LIVE chat are filtered for accounts younger than the age below.'),
        numIn('linkMinAgeHours', 'Account age for links (hours)', 'Accounts older than this may post links.', 8760),
        sw('capsFilter', 'Shouting filter', 'Filter messages that are mostly capital letters.'),
        numIn('maxMentions', 'Max @mentions per message', '0 = unlimited', 50),
        numIn('repeatLimit', 'Repeat spam limit', 'Identical messages allowed within 2 minutes (0 = off).', 20),
        numIn('newAccountMinutes', 'New account cooldown (minutes)', 'Brand-new accounts must wait before commenting or chatting.', 10080),
        numIn('autoHideReports', 'Auto-hide after reports', 'Hide a video/comment once this many different people report it (0 = off). It stays in the report queue.', 100)),
      h('section.settings-card', h('h2', 'Recent auto-mod actions'),
        entries.length ? table(['When', 'User', 'Where', 'Rule', 'Action', 'Content'], entries.slice(0, 60).map((e) => h('tr',
          h('td.small', timeAgo(e.createdAt)), h('td', e.username ? h('a.link', { href: `/@${e.username}`, target: '_blank' }, `@${e.username}`) : '—'),
          h('td.small', e.context.replace('_', ' ') + (e.owner ? ` · @${e.owner}` : '')), h('td', h('code', e.rule)), h('td', STATUS_PILL(e.action === 'block' ? 'banned' : e.action === 'auto_hide' ? 'removed' : 'suspended')),
          h('td.small', e.content.slice(0, 120))))) : emptyState({ iconName: 'shield', title: 'Nothing caught yet' })));
  }

  // ---------- Platform (owner) ----------
  async function liveRulesCard(owner) {
    const { rules } = await api.get('/admin/live-rules');
    const LABELS = { minFollowers: 'Followers needed to go LIVE', goodStandingDays: 'Good standing: min account age (days)', goodStandingMaxRisk: 'Good standing: max risk score',
      goodStandingMinVideos: 'Good standing: min videos', goodStandingMinFollowers: 'Good standing: min followers', trialEveryDays: 'Trial LIVE every N days', trialMinutes: 'Trial length (minutes)', trialMaxRisk: 'Trial: max risk score' };
    const inputs = {};
    return h('section.settings-card', h('h2', 'Who can go LIVE'),
      h('p.muted.small', 'People go LIVE if they have enough followers, are verified, or are in good standing. Everyone else with a clean record gets a periodic trial.'),
      h('div.rules-grid', Object.entries(LABELS).map(([k, label]) => h('label.field', h('span.small', label), inputs[k] = h('input.input.input-sm', { type: 'number', min: 0, value: rules[k], disabled: !owner })))),
      h('div', h('button.btn.btn-primary', { disabled: !owner, onclick: async () => {
        try { await api.patch('/admin/live-rules', Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, Number(el.value)]))); toast('LIVE rules saved', { type: 'success' }); } catch (e) { toastError(e); }
      } }, 'Save LIVE rules')));
  }
  async function guardianCard(owner) {
    const { config: c } = await api.get('/admin/guardian');
    const inputs = {};
    const field = (k, label) => h('label.field', h('span.small', label), inputs[k] = h('input.input.input-sm', { type: 'number', min: 1, value: c[k], disabled: !owner }));
    const en = h('input', { type: 'checkbox', checked: c.enabled, disabled: !owner });
    return h('section.settings-card', h('h2', 'Guardian thresholds'),
      h('label.check', en, ' Guardian takes automatic actions (warnings & suspensions)'),
      h('div.rules-grid', field('warnAt', 'Warn at risk score'), field('reviewAt', 'Ask a human at'), field('suspendAt', 'Auto-suspend at'), field('suspendHours', 'Auto-suspension length (hours)')),
      h('div', h('button.btn.btn-primary', { disabled: !owner, onclick: async () => {
        try { await api.patch('/admin/guardian', { enabled: en.checked, ...Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, Number(el.value)])) }); toast('Guardian updated', { type: 'success' }); } catch (e) { toastError(e); }
      } }, 'Save thresholds')));
  }

  async function platformView() {
    const { platform: p } = await api.get('/admin/platform');
    const owner = store.me.isOwner;
    const save = async (patch) => { try { const r = await api.patch('/admin/platform', patch); Object.assign(p, r.platform); toast('Platform updated', { type: 'success' }); } catch (e) { toastError(e); } };
    const sw = (key, label, hint) => h('div.setting-row', h('div', h('div.setting-title', label), h('div.muted.small', hint)),
      h('label.switch', h('input', { type: 'checkbox', checked: p[key], disabled: !owner, onchange: (e) => save({ [key]: e.target.checked }) }), h('span.slider')));
    const banner = h('input.input', { value: p.announcement || '', maxlength: 280, placeholder: 'Banner text shown at the top of every page (empty = hidden)', disabled: !owner });
    const announce = h('textarea.input', { rows: 2, maxlength: 280, placeholder: 'Send a notification to every user…' });
    return h('div.stack',
      !owner ? h('p.owner-lock', icon('lock', { size: 14 }), 'Only the platform owner can change these settings.') : null,
      h('section.settings-card', h('h2', 'Platform switches'),
        sw('registrationsOpen', 'Open sign-ups', 'Allow new accounts to register.'),
        sw('uploadsEnabled', 'Video uploads', 'Let users post new videos (admins can always upload).'),
        sw('liveEnabled', 'LIVE streaming', 'Let users go LIVE (admins can always go LIVE).')),
      h('section.settings-card', h('h2', 'Site banner'), banner,
        h('div', h('button.btn.btn-primary', { disabled: !owner, onclick: () => save({ announcement: banner.value }) }, 'Save banner'))),
      await liveRulesCard(owner),
      await guardianCard(owner),
      h('section.settings-card', h('h2', 'Announce to everyone'), h('p.muted.small', 'Delivers an in-app notification to every active user.'), announce,
        h('div', h('button.btn.btn-primary', { onclick: async () => {
          if (!announce.value.trim()) return;
          if (!(await confirmDialog({ title: 'Send to all users?', message: announce.value, confirmText: 'Send' }))) return;
          try { const r = await api.post('/admin/announce', { message: announce.value }); toast(`Sent to ${r.sent} users`, { type: 'success' }); announce.value = ''; } catch (e) { toastError(e); }
        } }, icon('send', { size: 16 }), ' Send announcement'))));
  }

  const views = { overview, cases, reports: () => reports(), users, videos, comments, live, automod: automodView, economy: economyView, platform: platformView, audit };
  async function show(k) {
    tab = k;
    history.replaceState({}, '', `/admin?tab=${k}`);
    bar.setActive(k);
    body.replaceChildren(loadingBlock());
    try { body.replaceChildren(await views[k]()); } catch (e) { body.replaceChildren(errorState(e, () => show(k))); }
  }
  const bar = tabs([
    { value: 'overview', label: 'Overview', icon: 'chart' }, { value: 'cases', label: 'Cases', icon: 'shield' }, { value: 'reports', label: 'Reports', icon: 'flag' }, { value: 'users', label: 'Users', icon: 'users' },
    { value: 'videos', label: 'Videos', icon: 'film' }, { value: 'comments', label: 'Comments', icon: 'comment' }, { value: 'live', label: 'LIVE', icon: 'live' },
    { value: 'automod', label: 'Auto-mod', icon: 'alert' }, { value: 'economy', label: 'Coins & gifts', icon: 'sparkles' }, { value: 'platform', label: store.me.isOwner ? 'Owner' : 'Platform', icon: 'settings' },
    { value: 'audit', label: 'Audit log', icon: 'eye' },
  ], tab, show, 'scroll-tabs');
  show(views[tab] ? tab : 'overview');
  return { el: h('div.admin-page', h('h1.page-title', icon('shield', { size: 28 }), ' Moderation centre'), bar, body), title: 'Admin' };
}
