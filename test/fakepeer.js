// Подмена PeerJS для тестов: соединения между вкладками через BroadcastChannel
(() => {
  const bc = new BroadcastChannel('fakepeer');
  const peers = {};
  class Conn {
    constructor(peer, remote, connId) { this.peer = remote; this._me = peer; this.connId = connId; this.open = false; this.h = {}; }
    on(e, cb) { (this.h[e] ||= []).push(cb); }
    _emit(e, ...a) { (this.h[e] || []).forEach(f => f(...a)); }
    send(d) { bc.postMessage({ type: 'data', to: this.peer, from: this._me.id, connId: this.connId, data: JSON.parse(JSON.stringify(d)) }); }
    close() { bc.postMessage({ type: 'close', to: this.peer, connId: this.connId }); this._emit('close'); }
  }
  class Peer {
    constructor(id) {
      if (typeof id !== 'string') id = 'anon-' + Math.random().toString(36).slice(2);
      this.id = id; this.h = {}; this.conns = {};
      peers[id] = this;
      setTimeout(() => this._emit('open', id), 50);
    }
    on(e, cb) { (this.h[e] ||= []).push(cb); }
    _emit(e, ...a) { (this.h[e] || []).forEach(f => f(...a)); }
    connect(target) {
      const connId = Math.random().toString(36).slice(2);
      const c = new Conn(this, target, connId); this.conns[connId] = c;
      bc.postMessage({ type: 'connect', to: target, from: this.id, connId });
      this._pending = setTimeout(() => this._emit('error', { type: 'peer-unavailable' }), 1500);
      return c;
    }
    reconnect() {} destroy() { Object.values(this.conns).forEach(c => c.close()); delete peers[this.id]; }
  }
  bc.onmessage = ({ data: m }) => {
    const p = peers[m.to]; if (!p) return;
    if (m.type === 'connect') {
      const c = new Conn(p, m.from, m.connId); c.open = true; p.conns[m.connId] = c;
      p._emit('connection', c);
      bc.postMessage({ type: 'accept', to: m.from, connId: m.connId });
    } else if (m.type === 'accept') {
      clearTimeout(p._pending); const c = p.conns[m.connId]; if (c) { c.open = true; c._emit('open'); }
    } else if (m.type === 'data') { const c = p.conns[m.connId]; if (c) c._emit('data', m.data); }
    else if (m.type === 'close') { const c = p.conns[m.connId]; if (c) { c.open = false; c._emit('close'); } }
  };
  Object.defineProperty(window, 'Peer', { value: Peer, writable: false });
})();
