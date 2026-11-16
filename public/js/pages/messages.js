// Direct messages: conversation list + real-time thread with read receipts and typing indicator.
import { h, richText } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { ws } from '../lib/ws.js';
import { store, setUnread } from '../lib/store.js';
import { timeAgo, clockTime, fullDate } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { BRAND } from '../brand.js';
import { storyTray } from '../components/stories.js';
import { avatar, emptyState, errorState, loadingBlock, toastError, openModal, spinner } from '../components/ui.js';

export default function messagesPage(ctx) {
  const activeId = ctx.params.id ? Number(ctx.params.id) : null;
  const subs = [];
  const listEl = h('div.conv-list', loadingBlock());
  const threadEl = h('div.thread');
  const page = h(`div.messages-page${activeId ? '.has-thread' : ''}`,
    h('aside.conv-pane', h('div.conv-head', h('h1', 'Messages'), h('button.icon-btn', { 'aria-label': 'New message', onclick: newMessage }, icon('edit', { size: 20 }))), storyTray({ title: 'Stories' }), listEl),
    h('section.thread-pane', threadEl));

  async function loadList() {
    try {
      const { conversations, unreadTotal } = await api.get('/conversations');
      setUnread({ messages: unreadTotal });
      listEl.replaceChildren();
      if (!conversations.length) {
        listEl.appendChild(emptyState({ iconName: 'message', title: 'No messages yet', text: 'Start a conversation from someone’s profile, or tap the pencil icon.' }));
        return;
      }
      conversations.forEach((c) => listEl.appendChild(h(`a.conv${c.id === activeId ? '.active' : ''}${c.unread ? '.unread' : ''}`, { href: `/messages/${c.id}` },
        h('span.conv-avatar', avatar(c.user, 52, { link: false }), c.user.online ? h('span.online-dot') : null),
        h('div.conv-text', h('div.conv-name', c.user.displayName), h('div.conv-last.muted', `${c.lastMessage.fromMe ? 'You: ' : ''}${c.lastMessage.body || ''}`)),
        h('div.conv-meta', h('span.muted.small', timeAgo(c.lastMessageAt)), c.unread ? h('span.unread-dot', String(c.unread)) : null))));
    } catch (e) { listEl.replaceChildren(errorState(e, loadList)); }
  }

  function newMessage() {
    openModal((close) => {
      const input = h('input.input', { placeholder: 'Search username', autocomplete: 'off' });
      const results = h('div.user-list');
      let t;
      input.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(async () => {
          const q = input.value.trim();
          if (!q) { results.replaceChildren(); return; }
          try {
            const { users } = await api.get(`/search?q=${encodeURIComponent(q)}&type=users`);
            results.replaceChildren(...users.filter((u) => u.id !== store.me.id).map((u) => h('button.user-row.btn-reset', {
              onclick: async () => {
                try { const r = await api.post('/conversations', { username: u.username }); close(); navigate(`/messages/${r.id}`); } catch (e) { toastError(e); }
              },
            }, avatar(u, 40, { link: false }), h('div.user-row-text', h('div.user-row-name', u.displayName), h('div.user-row-sub.muted', '@' + u.username)))));
            if (!users.length) results.appendChild(h('p.muted.small', 'No users found'));
          } catch (e) { toastError(e); }
        }, 250);
      });
      return h('div.stack', input, results);
    }, { title: 'New message', className: 'modal-md' });
  }

  async function openThread(id) {
    threadEl.replaceChildren(loadingBlock());
    let conv;
    try { conv = await api.get(`/conversations/${id}`); } catch (e) { threadEl.replaceChildren(errorState(e)); return; }
    const other = conv.user;
    const msgs = h('div.msgs', { role: 'log', 'aria-live': 'polite' });
    const typing = h('div.typing.hidden', h('span'), h('span'), h('span'));
    const input = h('textarea.msg-input', { rows: 1, placeholder: 'Send a message...', maxlength: 2000, 'aria-label': 'Message' });
    const send = h('button.icon-btn.msg-send', { type: 'submit', disabled: true, 'aria-label': 'Send' }, icon('send', { size: 22 }));
    const composer = conv.canSend
      ? h('form.composer', { onsubmit: (e) => { e.preventDefault(); sendMsg(); } }, input, send)
      : h('div.composer.disabled.muted', conv.reason || 'You cannot message this user.');
    let oldest = null;
    let hasMore = false;
    let lastDay = null;
    let lastTypingSent = 0;
    const seenEl = h('div.seen.muted.small.hidden', 'Seen');

    function bubble(m) {
      const mine = m.senderId === store.me.id;
      const video = m.video
        ? (m.video.unavailable ? h('div.msg-video.unavailable', icon('lock', { size: 16 }), ' Video unavailable')
          : h('a.msg-video', { href: `/video/${m.video.id}` }, h('img', { src: m.video.thumbUrl || BRAND.placeholderThumb, alt: '' }),
            h('div.msg-video-cap', h('b', '@' + m.video.author), h('span', m.video.caption || ''))))
        : null;
      return h(`div.msg${mine ? '.mine' : ''}`, { dataset: { id: m.id }, title: fullDate(m.createdAt) },
        !mine ? avatar(other, 28, { link: false }) : null,
        h('div.msg-col', video, m.body ? h('div.bubble', richText(m.body)) : null, h('span.msg-time.muted', clockTime(m.createdAt))));
    }
    function dayDivider(ts) {
      const d = new Date(ts).toDateString();
      if (d === lastDay) return null;
      lastDay = d;
      return h('div.day-divider.muted.small', new Date(ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }));
    }
    function addMessage(m) {
      if (msgs.querySelector(`.msg[data-id="${m.id}"]`)) return;
      msgs.querySelector('.thread-empty')?.remove();
      const atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 120;
      const div = dayDivider(m.createdAt);
      if (div) msgs.insertBefore(div, typing);
      msgs.insertBefore(bubble(m), typing);
      seenEl.classList.add('hidden');
      if (atBottom || m.senderId === store.me.id) msgs.scrollTop = msgs.scrollHeight;
    }
    async function loadOlder() {
      const r = await api.get(`/conversations/${id}/messages${oldest ? `?before=${oldest}` : ''}`);
      hasMore = r.hasMore;
      if (!r.messages.length) return r;
      const frag = document.createDocumentFragment();
      lastDay = null;
      r.messages.forEach((m) => { const d = dayDivider(m.createdAt); if (d) frag.appendChild(d); frag.appendChild(bubble(m)); });
      const prevH = msgs.scrollHeight;
      const first = msgs.querySelector('.msg, .day-divider');
      msgs.insertBefore(frag, first || typing);
      if (oldest) msgs.scrollTop = msgs.scrollHeight - prevH;
      oldest = r.messages[0].id;
      return r;
    }
    async function markRead() {
      try { const r = await api.post(`/conversations/${id}/read`); setUnread({ messages: r.unreadTotal }); const item = listEl.querySelector(`a[href="/messages/${id}"]`); if (item) { item.classList.remove('unread'); const dot = item.querySelector('.unread-dot'); if (dot) dot.remove(); } } catch { /* ignore */ }
    }
    async function sendMsg() {
      const body = input.value.trim();
      if (!body) return;
      send.disabled = true;
      input.value = '';
      input.style.height = 'auto';
      try {
        const r = await api.post(`/conversations/${id}/messages`, { body });
        addMessage(r.message);
        loadList();
      } catch (e) { toastError(e); input.value = body; } finally { send.disabled = !input.value.trim(); input.focus(); }
    }
    input.addEventListener('input', () => {
      send.disabled = !input.value.trim();
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 140) + 'px';
      if (Date.now() - lastTypingSent > 2500) { lastTypingSent = Date.now(); ws.send('dm:typing', { conversationId: id }); }
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } });
    msgs.addEventListener('scroll', async () => {
      if (msgs.scrollTop < 60 && hasMore && !msgs.dataset.loading) {
        msgs.dataset.loading = '1';
        try { await loadOlder(); } finally { delete msgs.dataset.loading; }
      }
    });

    const status = h('span.muted.small', other.online ? 'Active now' : '');
    threadEl.replaceChildren(
      h('div.thread-head',
        h('a.icon-btn.thread-back', { href: '/messages', 'aria-label': 'Back' }, icon('chevronLeft')),
        h('a.thread-user', { href: `/@${other.username}` }, avatar(other, 40, { link: false }), h('div', h('b', other.displayName), h('div', h('span.muted.small', '@' + other.username), ' ', status)))),
      msgs, seenEl, composer);
    msgs.appendChild(typing);
    msgs.appendChild(h('div.msgs-loading', spinner('sm')));
    try {
      await loadOlder();
      msgs.querySelector('.msgs-loading')?.remove();
      if (!msgs.querySelector('.msg')) msgs.insertBefore(h('div.thread-empty.muted', avatar(other, 72, { link: false }), h('p', `Say hi to ${other.displayName}`)), typing);
      msgs.scrollTop = msgs.scrollHeight;
    } catch (e) { msgs.replaceChildren(errorState(e)); }
    markRead();
    if (conv.canSend) input.focus();

    let typingTimer;
    subs.push(ws.on('dm:new', (m) => {
      if (m.message.conversationId !== id) return;
      msgs.querySelector('.thread-empty')?.remove();
      typing.classList.add('hidden');
      addMessage(m.message);
      if (!document.hidden) markRead();
    }));
    subs.push(ws.on('dm:sent', (m) => { if (m.message.conversationId === id) addMessage(m.message); }));
    subs.push(ws.on('dm:typing', (m) => {
      if (m.conversationId !== id) return;
      typing.classList.remove('hidden');
      msgs.scrollTop = msgs.scrollHeight;
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => typing.classList.add('hidden'), 3500);
    }));
    subs.push(ws.on('dm:read', (m) => {
      if (m.conversationId !== id) return;
      const last = [...msgs.querySelectorAll('.msg')].pop();
      if (last && last.classList.contains('mine')) seenEl.classList.remove('hidden');
    }));
    const onVis = () => { if (!document.hidden) markRead(); };
    document.addEventListener('visibilitychange', onVis);
    subs.push(() => document.removeEventListener('visibilitychange', onVis));
  }

  subs.push(ws.on('dm:new', () => loadList()));
  loadList();
  if (activeId) openThread(activeId);
  else threadEl.replaceChildren(h('div.thread-placeholder', icon('message', { size: 64 }), h('h2', 'Your messages'), h('p.muted', 'Send private messages to friends and creators.'), h('button.btn.btn-primary', { onclick: newMessage }, 'Send message')));
  return { el: page, title: 'Messages', cleanup: () => subs.forEach((u) => u()) };
}
