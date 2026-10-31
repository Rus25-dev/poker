// Клиент: подключается к хосту по коду, переподключается при обрыве,
// а если хост пропал насовсем — стол переезжает к первому преемнику.
import { findRoom } from './net.js';
import { randomHex } from './cards.js';

export class ClientController {
  constructor({ name, token, code, avatar }, ui) {
    this.ui = ui; this.name = name; this.token = token; this.code = code.toUpperCase(); this.avatar = avatar;
    this.myId = null;
    this.gen = 0;
    this.state = 'connecting';   // connecting | connected | reconnecting | migrating | closed
    this.attempt = 0;            // номер текущей попытки: колбэки старых попыток игнорируются
    this.retries = 0;
    this.snap = null;
    this.seedSentFor = null;
    this.everConnected = false;
    this.lastMsgAt = Date.now();
    this._hb = setInterval(() => {
      if (this.state === 'connected' && Date.now() - this.lastMsgAt > 12000) this._lost(this.attempt);
    }, 2000);
    this._connect(0, 6);
  }
  isHost() { return false; }
  get closed() { return this.state === 'closed'; }

  _dropLink() {
    const f = this.finder; this.finder = null; this.link = null;
    try { f && f.stop(); } catch { /* */ }
  }

  _connect(fromGen, scan) {
    const id = ++this.attempt;
    this._dropLink();
    this.ui.onStatus({ kind: 'wait', text: this.retries ? 'st_reconnecting' : 'st_connecting', n: this.retries });
    const f = findRoom(this.code, {
      from: fromGen, max: fromGen + scan,
      handlers: {
        onOpen: (conn, g) => {
          if (id !== this.attempt || this.closed) return;
          this.finder = f; this.link = f.link;
          this._onConnected(g);
        },
        onData: msg => { if (id === this.attempt) this._onMsg(msg); },
        onClose: () => this._lost(id),
        onError: () => this._lost(id)
      },
      onNone: () => {
        if (id !== this.attempt || this.closed) return;
        if (!this.everConnected) { this.state = 'closed'; this.ui.onNetError({ type: 'peer-unavailable' }); return; }
        this._lost(id);
      }
    });
    this.finder = f;
  }

  _onConnected(g) {
    this.state = 'connected';
    this.gen = g;
    this.retries = 0;
    this.everConnected = true;
    this.lastMsgAt = Date.now();
    this.link.send({ t: 'join', name: this.name, token: this.token });
    if (this.avatar) this.link.send({ t: 'profile', avatar: this.avatar });
    this.ui.onStatus({ kind: 'ok', text: 'st_seated' });
  }

  _lost(id) {
    if (id !== this.attempt || this.closed || this.state === 'migrating') return;
    this.attempt++;            // гасим колбэки этой попытки
    this._dropLink();
    this.state = 'reconnecting';
    this.retries++;
    // две неудачные попытки подряд — хост, похоже, пропал: запускаем смену хоста
    if (this.retries >= 2 && this.snap) return this._startMigration();
    if (this.retries > 60) { this.state = 'closed'; this.ui.onStatus({ kind: 'err', text: 'st_lost' }); return; }
    clearTimeout(this._rt);
    this._rt = setTimeout(() => { if (this.state === 'reconnecting') this._connect(this.gen, 1); }, Math.min(4000, 800 + this.retries * 500));
  }

  _startMigration() {
    this.state = 'migrating';
    const succ = (this.snap.succ || []).filter(x => x !== this.snap.hostId);
    const idx = succ.indexOf(this.myId);
    const baseGen = this.snap.gen + 1;
    this.ui.onStatus({ kind: 'wait', text: 'st_migrating' });
    // очередь: первый преемник берёт стол сразу, следующие — если предыдущий за 9 с не появился
    const deadline = Date.now() + (idx < 0 ? 1e12 : idx * 9000 + 300);
    const probe = () => {
      if (this.state !== 'migrating') return;
      if (Date.now() >= deadline) {
        this.state = 'closed';
        clearInterval(this._hb);
        this.ui.onBecomeHost({ snap: this.snap.snap, code: this.code, gen: baseGen + Math.max(0, idx), tokens: this.snap.tokens, myId: this.myId });
        return;
      }
      const id = ++this.attempt;
      const f = findRoom(this.code, {
        from: baseGen, max: baseGen + Math.max(1, succ.length),
        handlers: {
          onOpen: (conn, g) => {
            if (id !== this.attempt || this.state !== 'migrating') return;
            this.finder = f; this.link = f.link;
            this._onConnected(g);
          },
          onData: msg => { if (id === this.attempt) this._onMsg(msg); },
          onClose: () => this._lost(id),
          onError: () => {}
        },
        onNone: () => { if (id === this.attempt && this.state === 'migrating') this._migT = setTimeout(probe, 1200); }
      });
      this.finder = f;
    };
    if (idx === 0) this._migT = setTimeout(probe, 300); else probe();
  }

  _onMsg(msg) {
    if (!msg) return;
    this.lastMsgAt = Date.now();
    switch (msg.t) {
      case 'ping': return;
      case 'welcome': this.myId = msg.id; this.gen = msg.gen || this.gen; return;
      case 'snap': this.snap = msg; return;
      case 'state': {
        const v = msg.view;
        // свой вклад в тасовку следующей раздачи — после того как хост зафиксировал свой сид
        if (v.commitNext && v.commitNext !== this.seedSentFor) {
          this.seedSentFor = v.commitNext;
          this.mySeed = { commit: v.commitNext, seed: randomHex(16) };
          this.send({ t: 'seed', seed: this.mySeed.seed, forCommit: v.commitNext });
          this.ui.onSeedSent(this.mySeed);
        }
        this.ui.onState(v);
        return;
      }
      case 'kicked': this.destroy(); this.ui.onKicked(); return;
      default: this.ui.onMessage(msg);
    }
  }

  send(msg) { this.link && this.link.send(msg); }

  destroy() {
    this.state = 'closed'; this.attempt++;
    clearTimeout(this._rt); clearTimeout(this._migT); clearInterval(this._hb);
    this._dropLink();
  }
}
