// Moderation profile ("dossier") for one account: overview, behaviour & risk, content, reports,
// history of warnings/suspensions/bans, auto-mod hits, LIVE & wallet — plus every staff action.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { fmtCount, timeAgo, fullDate } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { BRAND } from '../brand.js';
import { toast, toastError, confirmDialog, promptDialog, avatar, tabs, loadingBlock, errorState, emptyState, openModal } from '../components/ui.js';
import { riskMeter } from './admin.js';
import { coinIcon } from '../components/coins.js';

const KIND = { warning: ['alert', 'Warning'], suspension: ['pauseCircle', 'Suspension'], ban: ['block', 'Ban'], restore: ['check', 'Restored'], note: ['note', 'Note'], restriction: ['lock', 'Restriction'] };
const pill = (s) => h(`span.pill.pill-${s}`, s);

export default async function adminUserPage(ctx) {
  const uid = Number(ctx.params.id);
  const root = h('div.admin-page.dossier', loadingBlock());
  let tab = ctx.query.get('tab') || 'overview';

  async function act(fn, ok) {
    try { await fn(); if (ok) toast(ok, { type: 'success' }); load(); } catch (e) { toastError(e); }
  }

  async function load() {
    let d;
    try { d = await api.get(`/admin/users/${uid}/dossier`); } catch (e) { root.replaceChildren(errorState(e, load)); return; }
    const u = d.user;
    const isOwner = store.me.isOwner;
    const self = u.id === store.me.id;
    const protectedAcc = u.isOwner || self;

    const actions = h('div.dossier-actions',
      !protectedAcc ? h('button.btn.btn-secondary', { onclick: async () => {
        const reason = await promptDialog({ title: `Warn @${u.username}`, label: 'Reason (sent to the user)', confirmText: 'Send warning' });
        if (reason) act(() => api.post(`/admin/users/${uid}/warn`, { reason }), 'Warning sent');
      } }, icon('alert', { size: 16 }), ' Warn') : null,
      !protectedAcc && u.status === 'active' ? h('button.btn.btn-secondary', { onclick: async () => {
        const days = await promptDialog({ title: `Suspend @${u.username}`, label: 'Days', initial: '7', confirmText: 'Next' });
        if (!days) return;
        const reason = await promptDialog({ title: 'Reason', label: 'Shown when they try to log in', confirmText: 'Suspend', danger: true });
        if (reason !== null) act(() => api.post(`/admin/users/${uid}/suspend`, { days: Number(days), reason }), 'Suspended');
      } }, icon('pauseCircle', { size: 16 }), ' Suspend') : null,
      !protectedAcc && u.status !== 'banned' ? h('button.btn.btn-danger', { onclick: async () => {
        const reason = await promptDialog({ title: `Ban @${u.username}`, label: 'Reason', confirmText: 'Ban', danger: true });
        if (reason !== null) act(() => api.post(`/admin/users/${uid}/ban`, { reason }), 'Banned');
      } }, icon('block', { size: 16 }), ' Ban') : null,
      !protectedAcc && u.status !== 'active' ? h('button.btn.btn-primary', { onclick: async () => {
        const reason = await promptDialog({ title: `Restore @${u.username}`, label: 'Note', confirmText: 'Restore' });
        if (reason !== null) act(() => api.post(`/admin/users/${uid}/restore`, { reason }), 'Restored');
      } }, icon('check', { size: 16 }), ' Restore') : null,
      isOwner && !self ? h(`button.btn${u.verified ? '.btn-secondary' : '.btn-primary'}`, { onclick: () => verifyFlow(u) }, u.verified ? 'Remove verification' : [icon('checkCircle', { size: 16 }), ' Verify']) : null,
      isOwner ? h('button.btn.btn-secondary', { onclick: async () => {
        const amount = await promptDialog({ title: `Give coins to @${u.username}`, label: 'Coins (use a minus number to take away)', initial: '100', confirmText: 'Give' });
        if (amount) act(() => api.post(`/admin/users/${uid}/coins`, { coins: Number(amount), note: 'Gift from the owner' }), 'Coins sent');
      } }, h('span.coin', 'C'), ' Give coins') : null,
      h('button.btn.btn-secondary', { onclick: async () => {
        try { const r = await api.post(`/admin/users/${uid}/assess`); toast(`Guardian: ${r.score}/100 · ${r.action === 'none' ? 'no action' : r.action}`); load(); } catch (e) { toastError(e); }
      } }, icon('shield', { size: 16 }), ' Re-check with Guardian'),
      h('button.btn.btn-ghost', { onclick: () => moreActions(u, isOwner, protectedAcc) }, 'More ▾'));

    const header = h('div.dossier-head',
      avatar(u, 84, { link: false }),
      h('div.dossier-id',
        h('h1', u.displayName || u.username, u.verified ? icon('checkCircle', { size: 18, cls: 'verified' }) : null, u.isOwner ? h('span.owner-badge', 'Owner') : u.role === 'admin' ? h('span.role-badge.admin', 'Admin') : null),
        h('div.muted', `@${u.username} · joined ${fullDate(u.createdAt)}`), h('div.muted.small', 'Account email (staff only): ', h('span', u.email)),
        h('div.row.gap.wrap', pill(u.status), u.suspendedUntil ? h('span.small.muted', `until ${fullDate(u.suspendedUntil)}`) : null,
          u.commentBanned ? h('span.pill.pill-suspended', 'comments restricted') : null, u.liveBanned ? h('span.pill.pill-suspended', 'LIVE restricted') : null,
          u.liveAccess ? h('span.pill.pill-active', 'LIVE granted') : null, u.isPrivate ? h('span.pill', 'private') : null),
        u.statusReason ? h('p.small.muted', `Reason: ${u.statusReason}`) : null),
      h('div.dossier-risk', h('span.muted.small', 'Risk score'), riskMeter(d.risk.score), h('p.small', d.risk.summary),
        d.risk.protectedUser ? h('p.muted.small', 'Protected account — Guardian escalates to humans instead of acting.') : null),
      h('a.btn.btn-ghost.btn-sm', { href: `/@${u.username}`, target: '_blank' }, 'Public profile ↗'));

    const st = d.stats;
    const statBox = (label, value, tone) => h(`div.mini-stat${tone ? '.' + tone : ''}`, h('b', fmtCount(value)), h('span', label));
    const views = {
      overview: () => h('div.stack',
        h('div.mini-stats', statBox('Followers', st.followers), statBox('Following', st.following), statBox('Videos', st.videos), statBox('Removed videos', st.removedVideos, st.removedVideos ? 'warn' : ''),
          statBox('Comments', st.comments), statBox('Removed comments', st.removedComments, st.removedComments ? 'warn' : ''), statBox('Reports against', st.reportsAgainst, st.reportsAgainst ? 'danger' : ''),
          statBox('Reports filed', st.reportsFiled), statBox('Likes received', st.likesReceived), statBox('LIVEs', st.lives), statBox('Gift coins received', st.giftsReceivedCoins), statBox('Gift coins sent', st.giftsSentCoins)),
        h('section.settings-card', h('h2', 'Behaviour (Guardian signals)'),
          d.risk.signals.length ? h('div.signal-list', d.risk.signals.map((x) => h('div.signal-row', h('span', x.label), h('b', String(x.value)), x.points ? h('span.signal-pts', `+${x.points}`) : h('span.muted.small', '')))) : h('p.muted', 'No risk signals — this account looks healthy.')),
        h('section.settings-card', h('h2', 'Recent history'), history(d.strikes.slice(0, 6))),
        d.cases.length ? h('section.settings-card', h('h2', 'Guardian cases'), ...d.cases.map((c) => h('div.case-mini', h(`span.sev-pill.${c.severity}`, c.severity), h('span', c.summary), h('span.muted.small', `${c.status} · ${timeAgo(c.createdAt)}`)))) : null,
        u.bio ? h('section.settings-card', h('h2', 'Bio'), h('p', u.bio)) : null),
      content: () => h('div.stack',
        h('h3.panel-title', 'Videos'),
        d.videos.length ? h('div.dossier-videos', d.videos.map((v) => h('div.dossier-video',
          h('a', { href: `/video/${v.id}`, target: '_blank' }, h('img', { src: v.thumbUrl || BRAND.placeholderThumb, alt: '' })),
          h('div.small', (v.caption || '(no caption)').slice(0, 60)), h('div.row.gap', pill(v.status), h('span.muted.small', `${fmtCount(v.views)} views`)),
          v.status === 'active'
            ? h('button.btn.btn-sm.btn-danger', { onclick: async () => {
              const reason = await promptDialog({ title: 'Remove video', label: 'Reason (sent to the creator)', confirmText: 'Remove', danger: true });
              if (reason !== null) act(() => api.post(`/admin/videos/${v.id}/remove`, { reason }), 'Video removed');
            } }, 'Remove')
            : h('button.btn.btn-sm.btn-secondary', { onclick: () => act(() => api.post(`/admin/videos/${v.id}/restore`), 'Restored') }, 'Restore')))) : h('p.muted', 'No videos.'),
        h('h3.panel-title', 'Recent comments'),
        d.comments.length ? h('div.dossier-comments', d.comments.map((c) => h('div.dossier-comment',
          h('div', h('p', c.body), h('span.muted.small', `on “${(c.videoCaption || 'video').slice(0, 40)}” · ${timeAgo(c.createdAt)}`)),
          c.held ? h('span.pill.pill-suspended', 'held') : pill(c.status),
          c.status === 'active' ? h('button.btn.btn-sm.btn-ghost', { onclick: () => act(() => api.post(`/admin/comments/${c.id}/remove`), 'Comment removed') }, 'Remove') : null))) : h('p.muted', 'No comments.')),
      reports: () => d.reports.length ? h('div.stack', d.reports.map((r) => h('div.report-card',
        h('div.report-head', h('span.pill', r.targetType), h('b', r.reason.replace(/_/g, ' ')), h('span.muted.small', ` by @${r.reporter || 'deleted'} · ${timeAgo(r.createdAt)}`), pill(r.status === 'open' ? 'suspended' : 'active')),
        r.details ? h('p.report-details', r.details) : null))) : emptyState({ iconName: 'flag', title: 'No reports against this account' }),
      history: () => h('section.settings-card', h('h2', 'Warnings, suspensions, bans & notes'),
        h('button.btn.btn-secondary.btn-sm', { onclick: async () => {
          const note = await promptDialog({ title: 'Add staff note', label: 'Visible to staff only', multiline: true, confirmText: 'Save' });
          if (note) act(() => api.post(`/admin/users/${uid}/note`, { note }), 'Note added');
        } }, icon('note', { size: 14 }), ' Add note'), history(d.strikes)),
      automod: () => d.automodHits.length ? h('div.table-wrap', h('table.admin-table', h('thead', h('tr', ['When', 'Where', 'Rule', 'Action', 'Content'].map((x) => h('th', x)))),
        h('tbody', d.automodHits.map((x) => h('tr', h('td.small', timeAgo(x.createdAt)), h('td.small', x.context), h('td', h('code', x.rule)), h('td', x.action), h('td.small', x.content.slice(0, 120)))))))
        : emptyState({ iconName: 'shield', title: 'No auto-mod hits' }),
      live: () => h('div.stack',
        h('section.settings-card', h('h2', 'LIVE eligibility'),
          h('div.elig-list', d.liveEligibility.checks.map((c) => h(`div.elig-row${c.met ? '.ok' : ''}`, h('span.elig-dot', c.met ? icon('check', { size: 12 }) : ''), h('div', h('b', c.label), c.detail ? h('div.muted.small', c.detail) : null)))),
          h('p.small', d.liveEligibility.eligible ? `Can go LIVE (${d.liveEligibility.via})` : `Can’t go LIVE${d.liveEligibility.trial.available ? ' — trial available' : ''}`),
          h('div.row.gap', h('button.btn.btn-secondary.btn-sm', { onclick: () => act(() => api.post(`/admin/users/${uid}/live-access`, { grant: !u.liveAccess }), u.liveAccess ? 'LIVE access removed' : 'LIVE access granted') }, u.liveAccess ? 'Remove LIVE grant' : 'Grant LIVE access'),
            h('button.btn.btn-secondary.btn-sm', { onclick: () => act(() => api.post(`/admin/users/${uid}/flags`, { liveBanned: !u.liveBanned }), 'Updated') }, u.liveBanned ? 'Allow LIVE' : 'Restrict LIVE'))),
        d.lives.length ? h('div.table-wrap', h('table.admin-table', h('thead', h('tr', ['Title', 'Status', 'Peak', 'Likes', 'Diamonds', 'Started'].map((x) => h('th', x)))),
          h('tbody', d.lives.map((s) => h('tr', h('td', s.title, s.isTrial ? h('span.pill', 'trial') : null), h('td', pill(s.status === 'live' ? 'live' : 'ended')), h('td', s.peak), h('td', fmtCount(s.likes)), h('td', fmtCount(s.diamonds)), h('td.small', timeAgo(s.startedAt)))))))
          : h('p.muted', 'Never been LIVE.')),
      wallet: () => h('div.stack',
        h('div.wallet-cards', h('div.wallet-card', h('span.muted', 'Coins'), h('b', coinIcon(22), fmtCount(d.wallet.coins))), h('div.wallet-card', h('span.muted', 'Diamonds'), h('b', icon('diamond', { size: 22 }), fmtCount(d.wallet.diamonds)))),
        isOwner ? h('button.btn.btn-secondary', { onclick: async () => {
          const amount = await promptDialog({ title: 'Adjust coins', label: 'Coins to add (negative to remove)', initial: '100', confirmText: 'Apply' });
          if (amount) act(() => api.post(`/admin/users/${uid}/coins`, { coins: Number(amount), note: 'Owner adjustment' }), 'Wallet updated');
        } }, 'Adjust coins (owner)') : null,
        d.transactions.length ? h('div.tx-list', d.transactions.map((t) => h('div.tx', h('div.tx-text', h('b', t.type.replace('_', ' ')), h('span.muted.small', `${t.ref || ''} ${t.note || ''} · ${fullDate(t.createdAt)}`)),
          h('span.tx-amount', t.coins ? `${t.coins > 0 ? '+' : ''}${t.coins} coins` : `${t.diamonds > 0 ? '+' : ''}${t.diamonds} diamonds`)))) : h('p.muted', 'No transactions.')),
    };
    const body = h('div.dossier-body');
    const bar = tabs([
      { value: 'overview', label: 'Overview' }, { value: 'content', label: 'Content' }, { value: 'reports', label: 'Reports', badge: st.reportsAgainst || null },
      { value: 'history', label: 'History', badge: d.strikes.length || null }, { value: 'automod', label: 'Auto-mod' }, { value: 'live', label: 'LIVE' }, { value: 'wallet', label: 'Wallet' },
    ], tab, (t) => { tab = t; history_(t); body.replaceChildren(views[t]()); }, 'scroll-tabs');
    const history_ = (t) => window.history.replaceState({}, '', `/admin/user/${uid}${t === 'overview' ? '' : `?tab=${t}`}`);
    body.replaceChildren((views[tab] || views.overview)());
    root.replaceChildren(h('button.link-btn', { onclick: () => navigate('/admin?tab=users') }, icon('chevronLeft', { size: 14 }), ' All users'), header, actions, bar, body);
  }

  function history(strikes) {
    if (!strikes.length) return h('p.muted', 'Clean record — no warnings, suspensions or bans.');
    return h('div.timeline', strikes.map((x) => h('div.tl-item', h(`span.tl-icon.k-${x.kind}`, icon((KIND[x.kind] || ['note'])[0], { size: 18 })),
      h('div', h('b', (KIND[x.kind] || [0, x.kind])[1]), x.auto ? h('span.pill', 'auto') : null, h('div.small', x.reason || ''),
        h('div.muted.small', `${x.by} · ${fullDate(x.createdAt)}${x.expiresAt ? ` · until ${fullDate(x.expiresAt)}` : ''}`)))));
  }

  function verifyFlow(u) {
    openModal((close) => {
      const key = h('input.input', { type: 'password', placeholder: 'Verification key', autocomplete: 'off' });
      const btn = h('button.btn.btn-primary.btn-block', { type: 'submit' }, u.verified ? 'Remove verification' : `Verify @${u.username}`);
      return h('form.stack', {
        onsubmit: async (e) => {
          e.preventDefault();
          btn.disabled = true;
          try {
            await api.post(`/admin/users/${u.id}/verify`, { key: key.value, verified: !u.verified });
            toast(u.verified ? 'Verification removed' : `@${u.username} is now verified`, { type: 'success' });
            close();
            load();
          } catch (err) { toastError(err); btn.disabled = false; }
        },
      }, h('p.muted.small', 'Owner only. Enter the special verification key to confirm.'), key, btn);
    }, { title: 'Verification', className: 'modal-sm' });
  }

  function moreActions(u, isOwner, protectedAcc) {
    const items = [
      !protectedAcc ? { label: u.commentBanned ? 'Allow commenting & messaging' : 'Restrict commenting & messaging', icon: 'comment', onClick: () => act(() => api.post(`/admin/users/${uid}/flags`, { commentBanned: !u.commentBanned }), 'Updated') } : null,
      !protectedAcc ? { label: 'Force log out everywhere', icon: 'logout', onClick: () => act(() => api.post(`/admin/users/${uid}/logout`), 'Sessions ended') } : null,
      !protectedAcc ? { label: 'Remove all their comments', icon: 'trash', danger: true, onClick: async () => {
        if (await confirmDialog({ title: `Remove every comment by @${u.username}?`, confirmText: 'Remove all', danger: true })) act(() => api.post(`/admin/users/${uid}/purge-comments`), 'Comments removed');
      } } : null,
      !protectedAcc ? { label: 'Reset profile (name, bio, photo)', icon: 'user', danger: true, onClick: () => act(() => api.post(`/admin/users/${uid}/reset-profile`), 'Profile reset') } : null,
      isOwner && !protectedAcc ? { label: u.role === 'admin' ? 'Remove admin role' : 'Make admin', icon: 'shield', onClick: async () => {
        if (await confirmDialog({ title: u.role === 'admin' ? 'Remove admin rights?' : `Make @${u.username} an administrator?`, confirmText: 'Confirm', danger: u.role !== 'admin' })) act(() => api.post(`/admin/users/${uid}/role`, { role: u.role === 'admin' ? 'user' : 'admin' }), 'Role updated');
      } } : null,
    ].filter(Boolean);
    if (!items.length) { toast('No further actions for this account'); return; }
    import('../components/ui.js').then((m) => m.actionSheet(items, { title: `@${u.username}` }));
  }

  load();
  return { el: root, title: 'Moderation profile' };
}
