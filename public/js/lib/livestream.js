// WebRTC helpers for LIVE. Topology: the host opens one RTCPeerConnection per viewer and sends
// its tracks; signaling (offer/answer/ICE) is relayed by the server over WebSocket.
import { ws } from './ws.js';
import { store } from './store.js';
import { api } from './api.js';

let iceCache = null;
export async function iceServers() {
  if (iceCache) return iceCache;
  if (store.config && store.config.iceServers && store.config.iceServers.length) return (iceCache = store.config.iceServers);
  try { iceCache = (await api.get('/live/config')).iceServers; } catch { iceCache = [{ urls: 'stun:stun.l.google.com:19302' }]; }
  return iceCache;
}

/** Host side: fan out the local MediaStream to every viewer that joins. */
export function createBroadcaster(streamId, getStream) {
  const peers = new Map(); // peerId -> RTCPeerConnection
  const subs = [];

  async function connectPeer(peerId) {
    closePeer(peerId);
    const pc = new RTCPeerConnection({ iceServers: await iceServers() });
    peers.set(peerId, pc);
    const stream = getStream();
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    pc.onicecandidate = (e) => { if (e.candidate) ws.send('live:signal', { streamId, to: peerId, data: { type: 'candidate', candidate: e.candidate } }); };
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) closePeer(peerId); };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send('live:signal', { streamId, to: peerId, data: { type: 'offer', sdp: pc.localDescription.sdp } });
  }

  function closePeer(peerId) {
    const pc = peers.get(peerId);
    if (pc) { pc.close(); peers.delete(peerId); }
  }

  subs.push(ws.on('live:peer-join', (m) => { if (m.streamId === streamId) connectPeer(m.peerId).catch((e) => console.error('peer', e)); }));
  subs.push(ws.on('live:peer-leave', (m) => { if (m.streamId === streamId) closePeer(m.peerId); }));
  subs.push(ws.on('live:signal', async (m) => {
    if (m.streamId !== streamId) return;
    const pc = peers.get(m.from);
    if (!pc) return;
    try {
      if (m.data.type === 'answer') await pc.setRemoteDescription({ type: 'answer', sdp: m.data.sdp });
      else if (m.data.type === 'candidate' && m.data.candidate) await pc.addIceCandidate(m.data.candidate);
    } catch (e) { console.warn('signal error', e); }
  }));
  // Re-register as host after every (re)connection.
  const announce = () => ws.send('live:host', { streamId });
  subs.push(ws.onOpen(announce));
  if (ws.connected) announce();

  return {
    /** Swap tracks on all peers (e.g. when switching camera/screen). */
    replaceTracks(stream) {
      for (const pc of peers.values()) {
        for (const sender of pc.getSenders()) {
          const t = stream.getTracks().find((x) => sender.track && x.kind === sender.track.kind);
          if (t) sender.replaceTrack(t);
        }
      }
    },
    get peerCount() { return peers.size; },
    stop() {
      subs.forEach((u) => u());
      for (const id of [...peers.keys()]) closePeer(id);
    },
  };
}

/** Viewer side: answer the host's offer and expose the remote stream. */
export function createViewer(streamId, { onStream, onState }) {
  let pc = null;
  const subs = [];
  const pendingCandidates = [];

  async function handleOffer(sdp) {
    if (pc) pc.close();
    pc = new RTCPeerConnection({ iceServers: await iceServers() });
    pc.ontrack = (e) => onStream(e.streams[0] || new MediaStream([e.track]));
    pc.onicecandidate = (e) => { if (e.candidate) ws.send('live:signal', { streamId, data: { type: 'candidate', candidate: e.candidate } }); };
    pc.onconnectionstatechange = () => onState && onState(pc.connectionState);
    await pc.setRemoteDescription({ type: 'offer', sdp });
    while (pendingCandidates.length) await pc.addIceCandidate(pendingCandidates.shift()).catch(() => {});
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send('live:signal', { streamId, data: { type: 'answer', sdp: pc.localDescription.sdp } });
  }

  subs.push(ws.on('live:signal', async (m) => {
    if (m.streamId !== streamId || m.from !== 'host') return;
    try {
      if (m.data.type === 'offer') await handleOffer(m.data.sdp);
      else if (m.data.type === 'candidate' && m.data.candidate) {
        if (pc && pc.remoteDescription) await pc.addIceCandidate(m.data.candidate);
        else pendingCandidates.push(m.data.candidate);
      }
    } catch (e) { console.warn('viewer signal error', e); }
  }));
  const join = () => ws.send('live:join', { streamId });
  subs.push(ws.onOpen(join));
  if (ws.connected) join();

  return {
    stop() {
      ws.send('live:leave', { streamId });
      subs.forEach((u) => u());
      if (pc) pc.close();
    },
  };
}

export function stopStream(stream) {
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());
}

/** Grab a JPEG still from a <video> element. */
export function snapshot(video, maxW = 360) {
  return new Promise((resolve) => {
    if (!video.videoWidth) return resolve(null);
    const c = document.createElement('canvas');
    const scale = Math.min(1, maxW / video.videoWidth);
    c.width = Math.round(video.videoWidth * scale);
    c.height = Math.round(video.videoHeight * scale);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    c.toBlob(resolve, 'image/jpeg', 0.75);
  });
}
