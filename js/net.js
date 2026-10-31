// Сеть: WebRTC через PeerJS. Хост держит стол, клиенты подключаются по коду комнаты.
// Сигнальный сервер PeerJS нужен только для «рукопожатия»; игровые данные идут напрямую между телефонами.
export const PEER_PREFIX = 'rus-poker-v1-';
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeCode(n = 5) {
  let s = '';
  const b = new Uint32Array(n);
  crypto.getRandomValues(b);
  for (let i = 0; i < n; i++) s += ALPHA[b[i] % ALPHA.length];
  return s;
}

function peerLib() {
  if (!globalThis.Peer) throw new Error('Сетевая библиотека не загрузилась — проверьте интернет');
  return globalThis.Peer;
}

const PEER_OPTS = { debug: 1 };

// Хост: открывает комнату с заданным кодом
export function openRoom(code, { onConn, onError, onOpen }) {
  const Peer = peerLib();
  const peer = new Peer(PEER_PREFIX + code, PEER_OPTS);
  peer.on('open', () => onOpen && onOpen(code));
  peer.on('connection', conn => onConn(conn));
  peer.on('error', err => onError && onError(err));
  peer.on('disconnected', () => { try { peer.reconnect(); } catch { /* сигнальный сервер недоступен */ } });
  return peer;
}

// Клиент: подключается к комнате
export function joinRoom(code, { onOpen, onData, onClose, onError }) {
  const Peer = peerLib();
  const peer = new Peer(PEER_OPTS);
  let conn = null;
  peer.on('open', () => {
    conn = peer.connect(PEER_PREFIX + code.toUpperCase(), { reliable: true, serialization: 'json' });
    conn.on('open', () => onOpen && onOpen(conn));
    conn.on('data', d => onData && onData(d));
    conn.on('close', () => onClose && onClose());
    conn.on('error', e => onError && onError(e));
  });
  peer.on('error', err => onError && onError(err));
  return {
    peer,
    send: m => { if (conn && conn.open) conn.send(m); },
    close: () => { try { peer.destroy(); } catch { /* уже закрыт */ } }
  };
}

export function humanNetError(err) {
  const t = err && err.type;
  if (t === 'peer-unavailable') return 'Стол с таким кодом не найден. Проверьте код или попросите хоста открыть стол заново.';
  if (t === 'unavailable-id') return 'Этот код комнаты уже занят. Попробуйте ещё раз.';
  if (t === 'network' || t === 'server-error' || t === 'socket-error') return 'Нет связи с сервером соединения. Проверьте интернет.';
  if (t === 'browser-incompatible') return 'Браузер не поддерживает WebRTC. Откройте в Chrome или Safari.';
  return 'Ошибка сети: ' + (err && (err.message || err.type) || 'неизвестно');
}
