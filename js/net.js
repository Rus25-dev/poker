// Сеть: WebRTC через PeerJS. Хост держит стол, клиенты подключаются по коду комнаты.
// Сигнальный сервер нужен только для «рукопожатия»; игровые данные идут напрямую между телефонами.
// Если хост пропал, стол переезжает к другому игроку: у каждой «эпохи» (gen) свой адрес комнаты.
export const PEER_PREFIX = 'rus-poker-v1-';
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeCode(n = 5) {
  let s = '';
  const b = new Uint32Array(n);
  crypto.getRandomValues(b);
  for (let i = 0; i < n; i++) s += ALPHA[b[i] % ALPHA.length];
  return s;
}

export const peerIdFor = (code, gen = 0) => PEER_PREFIX + code.toUpperCase() + (gen > 0 ? '-g' + gen : '');

function peerLib() {
  if (!globalThis.Peer) throw new Error('net_lib');
  return globalThis.Peer;
}

// STUN/TURN: бесплатные публичные + свой TURN из настроек (для мобильного интернета с «тяжёлым» NAT)
export function iceConfig() {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' }
  ];
  try {
    const c = JSON.parse(localStorage.getItem('rp_ice') || 'null');
    if (c && c.url) servers.unshift({ urls: c.url.split(/[\s,]+/).filter(Boolean), username: c.user || undefined, credential: c.pass || undefined });
  } catch { /* */ }
  return { iceServers: servers };
}
const opts = () => ({ debug: 1, config: iceConfig() });

// Хост: открывает комнату
export function openRoom(code, gen, { onConn, onError, onOpen }) {
  const Peer = peerLib();
  const peer = new Peer(peerIdFor(code, gen), opts());
  peer.on('open', () => onOpen && onOpen(code));
  peer.on('connection', conn => onConn(conn));
  peer.on('error', err => onError && onError(err));
  peer.on('disconnected', () => { try { peer.reconnect(); } catch { /* */ } });
  return peer;
}

// Клиент: подключается к комнате конкретной эпохи
export function joinRoom(code, gen, { onOpen, onData, onClose, onError }) {
  const Peer = peerLib();
  const peer = new Peer(opts());
  let conn = null, done = false;
  const fail = e => { if (done) return; done = true; onError && onError(e); };
  peer.on('open', () => {
    conn = peer.connect(peerIdFor(code, gen), { reliable: true, serialization: 'json' });
    conn.on('open', () => { done = true; onOpen && onOpen(conn); });
    conn.on('data', d => onData && onData(d));
    conn.on('close', () => onClose && onClose());
    conn.on('error', e => fail(e));
  });
  peer.on('error', err => { if (conn && conn.open) { onClose && onClose(); return; } fail(err); });
  return {
    peer,
    send: m => { if (conn && conn.open) conn.send(m); },
    close: () => { try { peer.destroy(); } catch { /* */ } }
  };
}

// Поиск живой эпохи комнаты: перебираем gen 0..max, пока не найдём открытый стол
export function findRoom(code, { from = 0, max = 6, onFound, onNone, handlers }) {
  let gen = from, link = null, stopped = false;
  const tryGen = () => {
    if (stopped) return;
    if (gen > max) { onNone && onNone(); return; }
    const g = gen;
    link = joinRoom(code, g, {
      ...handlers,
      onOpen: c => { onFound && onFound(g, link); handlers.onOpen && handlers.onOpen(c, g); },
      onError: e => {
        if (e && e.type === 'peer-unavailable') { try { link.close(); } catch { /* */ } gen++; tryGen(); }
        else handlers.onError && handlers.onError(e);
      }
    });
  };
  tryGen();
  return { stop: () => { stopped = true; try { link && link.close(); } catch { /* */ } }, get link() { return link; } };
}

// Короткий хеш (для сопоставления токена игрока без раскрытия самого токена)
export function tokenHash(s) {
  let h1 = 0x811c9dc5, h2 = 0x1234567;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 2246822507); }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

export function netErrorKey(err) {
  const t = err && err.type;
  if (err && err.message === 'net_lib') return 'err_netlib';
  if (t === 'peer-unavailable') return 'err_noroom';
  if (t === 'unavailable-id') return 'err_codebusy';
  if (t === 'network' || t === 'server-error' || t === 'socket-error') return 'err_network';
  if (t === 'browser-incompatible') return 'err_browser';
  return 'err_generic';
}
