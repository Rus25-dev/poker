// Хост: держит стол, гоняет ботов и таймеры, рассылает каждому игроку его вид стола,
// честно тасует колоду (коммит сида + сиды игроков) и рассылает снимок для смены хоста.
import { Table } from './engine.js';
import { botDecide, BOT_NAMES } from './bot.js';
import { openRoom, makeCode, tokenHash } from './net.js';
import { fairDeck, sha256Hex, randomHex } from './cards.js';

const SAVE_KEY = 'rpoker_host_table_v2';
const DELAY_STREET = 900, DELAY_RUNOUT = 1700, DELAY_NEXT_HAND = 5000;
const BOT_AVATAR = { tight: '🦉', normal: '🤖', lag: '🦈' };

export class HostController {
  // opts: { name, token, settings, offline, restore, migrate: { snap, code, gen, tokens, myId, avatars } }
  constructor(opts, ui) {
    const { name, token, settings, offline = false, restore = null, migrate = null } = opts;
    this.ui = ui;
    this.offline = offline;
    this.timers = {};
    this.conns = new Map();
    this.paused = false;
    this.strikes = {};
    this.avatars = {};
    this.seeds = {};             // pid -> сид игрока для следующей раздачи
    if (migrate) {
      this.myId = migrate.myId;
      this.code = migrate.code;
      this.gen = migrate.gen;
      this.table = Table.fromSnapshot(migrate.snap);
      this.tokens = migrate.tokens || {};
      this.avatars = migrate.avatars || {};
      this.started = migrate.snap.handNo > 0;
      const me = this.table.byId(this.myId); if (me) me.connected = true;
      setTimeout(() => this._chatSys('sys_migrated', { name: me ? me.name : '' }), 300);
      if (this.started) setTimeout(() => this._nextHand(), 3500);
    } else if (restore) {
      this.myId = restore.myId;
      this.code = restore.code;
      this.gen = restore.gen || 0;
      this.table = reviveTable(restore.table);
      this.tokens = restore.tokens || {};
      this.avatars = restore.avatars || {};
      this.started = restore.started;
      for (const p of this.table.players()) if (!p.bot && p.id !== this.myId) p.connected = false;
      const me = this.table.byId(this.myId); if (me) me.connected = true;
      if (this.started) setTimeout(() => this._nextHand(), 3000);
    } else {
      this.myId = 'h-' + token.slice(0, 8);
      this.code = makeCode();
      this.gen = 0;
      this.table = new Table(settings);
      this.tokens = {};
      this.started = false;
      this.table.addPlayer({ id: this.myId, name });
    }
    this.tokens[tokenHash(token)] = this.myId;
    if (opts.avatar) this.avatars[this.myId] = opts.avatar;
    this._prepareSeed();
    if (!offline) {
      this._openRoom();
      // пульс: клиенты понимают, что хост жив; разрыв в тиках = телефон хоста «засыпал»
      this._lastTick = Date.now();
      this.timers.ping = setInterval(() => {
        const now = Date.now();
        if (now - this._lastTick > 9000 && this.ui.onHostSuspended) this.ui.onHostSuspended(this);
        this._lastTick = now;
        for (const [, c] of this.conns) if (c.pid) { try { c.conn.send({ t: 'ping' }); } catch { /* */ } }
      }, 2500);
    }
    else setTimeout(() => this.ui.onStatus({ kind: 'ok', text: '' }), 0);
  }

  isHost() { return true; }

  async _prepareSeed() {
    this.serverSeedNext = randomHex(32);
    this.commitNext = await sha256Hex(this.serverSeedNext);
    this.seeds = {};
  }

  _openRoom() {
    this.ui.onStatus({ kind: 'wait', text: 'st_opening' });
    this.peer = openRoom(this.code, this.gen, {
      onOpen: () => this.ui.onStatus({ kind: 'ok', text: 'st_open' }),
      onConn: conn => this._onConn(conn),
      onError: err => {
        if (err && err.type === 'unavailable-id' && this.gen > 0) {
          // адрес ещё не освободился — пробуем следующую эпоху
          this.gen++; setTimeout(() => this._openRoom(), 800); return;
        }
        this.ui.onNetError(err);
      }
    });
  }

  _onConn(conn) {
    conn.on('data', msg => this._onMsg(conn, msg));
    conn.on('close', () => {
      const c = this.conns.get(conn.peer);
      this.conns.delete(conn.peer);
      if (c && c.pid) {
        const p = this.table.byId(c.pid);
        if (p && ![...this.conns.values()].some(x => x.pid === c.pid)) { p.connected = false; this._chatSys('sys_disconnected', { name: p.name }); }
        this.sync(true);
      }
    });
  }

  _onMsg(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    const c = this.conns.get(conn.peer) || { conn, pid: null };
    if (msg.t === 'join') {
      const name = String(msg.name || 'Player').slice(0, 16).trim() || 'Player';
      const th = tokenHash(String(msg.token || ''));
      let pid = this.tokens[th];
      if (pid && this.table.byId(pid)) {
        const p = this.table.byId(pid);
        p.connected = true;
        this._chatSys('sys_back', { name: p.name });
      } else {
        pid = 'p-' + makeCode(6);
        const uniq = this._uniqName(name);
        const seat = this.table.addPlayer({ id: pid, name: uniq });
        if (seat < 0) { conn.send({ t: 'error', key: 'err_full' }); return; }
        this.tokens[th] = pid;
        this._chatSys(this.table.byId(pid).out ? 'sys_joined_watch' : 'sys_joined', { name: uniq });
      }
      c.pid = pid;
      this.conns.set(conn.peer, c);
      conn.send({ t: 'welcome', id: pid, code: this.code, gen: this.gen });
      conn.send({ t: 'avatars', map: this.avatars });
      this.sync(true);
      return;
    }
    if (!c.pid) return;
    this.handle(c.pid, msg);
  }

  _uniqName(name) {
    const names = new Set(this.table.players().map(p => p.name));
    if (!names.has(name)) return name;
    for (let i = 2; ; i++) if (!names.has(`${name} ${i}`)) return `${name} ${i}`;
  }

  handle(pid, msg) {
    const t = this.table;
    const p = t.byId(pid);
    if (!p) return;
    switch (msg.t) {
      case 'act': {
        const elapsed = Date.now() - t.turnStartedAt;
        const over = elapsed - (t.s.actionTimer || 0) * 1000;
        const isTurn = t.toAct === p.seat;
        const r = t.act(pid, msg.type, msg.amount);
        if (!r.ok) { this._sendTo(pid, { t: 'error', key: 'err_' + r.err, v: r.v }); this._sendTo(pid, { t: 'state', view: this._view(pid) }); break; }
        this.strikes[pid] = 0;
        if (isTurn && t.s.actionTimer > 0 && over > 0) t.useTimebank(pid, Math.ceil(over / 1000));
        this.sync();
        break;
      }
      case 'discard': if (t.discard(pid, msg.card).ok) this.sync(); break;
      case 'show': if (t.showCards(pid)) this.sync(); break;
      case 'sitout':
        t.setSitOut(pid, msg.v);
        if (!msg.v) this.strikes[pid] = 0;
        this.sync();
        break;
      case 'chat': {
        const text = String(msg.text || '').slice(0, 200).trim();
        if (text) this._bcast({ t: 'chat', id: pid, name: p.name, text });
        break;
      }
      case 'emoji': this._bcast({ t: 'emoji', id: pid, e: String(msg.e || '').slice(0, 4) }); break;
      case 'profile':
        if (typeof msg.avatar === 'string' && msg.avatar.length < 20000) { this.avatars[pid] = msg.avatar; this._bcast({ t: 'avatars', map: this.avatars }); }
        break;
      case 'seed':
        if (typeof msg.seed === 'string' && msg.seed.length <= 64 && msg.forCommit === this.commitNext) this.seeds[pid] = msg.seed;
        break;
      case 'rebuy': if (t.rebuy(pid)) this.sync(); break;
      case 'leave': t.removePlayer(pid); this.sync(true); break;
    }
  }

  send(msg) { this.handle(this.myId, msg); }

  // ---------- управление столом ----------
  addBot(style = 'normal') {
    const used = new Set(this.table.players().map(p => p.name));
    const name = BOT_NAMES.find(n => !used.has(n)) || 'Bot ' + makeCode(2);
    const id = 'b-' + makeCode(5);
    const seat = this.table.addPlayer({ id, name, bot: style });
    if (seat < 0) { this.ui.toastKey('err_full'); return; }
    this.avatars[id] = BOT_AVATAR[style] || '🤖';
    this._bcast({ t: 'avatars', map: this.avatars });
    this.sync(true);
  }
  removeSeat(pid) {
    if (pid === this.myId || !this.table.byId(pid)) return;
    this.table.removePlayer(pid);
    for (const [, c] of this.conns) if (c.pid === pid) { try { c.conn.send({ t: 'kicked' }); } catch { /* */ } }
    this.sync(true);
  }
  start() {
    if (this.table.players().filter(p => !p.out && p.chips > 0).length < 2) { this.ui.toastKey('need_two'); return; }
    this.started = true; this.paused = false;
    this._nextHand();
  }
  togglePause() {
    this.paused = !this.paused;
    this._nextFor = null;
    this._chatSys(this.paused ? 'sys_paused' : 'sys_resumed');
    if (!this.paused && (this.table.phase === 'idle' || this.table.phase === 'over')) this._nextHand();
    this.sync();
  }
  newTournament() {
    const t = new Table(this.table.s);
    for (const p of this.table.players()) {
      if (p.leaving) continue;
      t.addPlayer({ id: p.id, name: p.name, bot: p.bot, seat: p.seat });
      t.byId(p.id).connected = p.connected;
    }
    this.table = t;
    this.started = false;
    this.sync(true);
  }

  // ---------- игровой цикл ----------
  async _nextHand() {
    clearTimeout(this.timers.next);
    if (this.paused || !this.started || this._dealing) return;
    this._dealing = true;
    try {
      // честная колода: сид хоста (его хеш опубликован заранее) + сиды игроков + номер раздачи
      if (!this.commitNext) await this._prepareSeed();
      const serverSeed = this.serverSeedNext, commit = this.commitNext;
      const seeds = { ...this.seeds };
      const handNo = this.table.handNo + 1;
      const material = fairMaterial(serverSeed, seeds, handNo);
      const deck = await fairDeck(material);
      this.table.fair = { commit, seeds, handNo };
      this._curSeed = { serverSeed, commit, seeds, handNo };
      const ok = this.table.startHand(Date.now(), deck);
      await this._prepareSeed();
      if (!ok) {
        this._nextFor = null;
        this.sync(true);
        if (!this.table.tourOver) this._chatSys('sys_waiting');
        return;
      }
      this.sync(true);
    } finally { this._dealing = false; }
  }

  // full=true — также рассылаем снимок стола для смены хоста
  sync(full = false) {
    const t = this.table;
    if (t.phase === 'over' && t.lastResult && this._curSeed && !t.lastResult.fair && t.lastResult.handNo === this._curSeed.handNo) {
      t.lastResult.fair = { ...this._curSeed, nextCommit: this.commitNext };
      full = true;
    }
    if (t.phase === 'over' && t.lastResult?.fair && !t.lastResult.fair.nextCommit) t.lastResult.fair.nextCommit = this.commitNext;
    const events = t.drainEvents();
    if (events.length) this._bcast({ t: 'events', list: events });
    if (full || events.some(e => e.t === 'hand')) this._sendSnapshot();
    for (const [, c] of this.conns) if (c.pid) { try { c.conn.send({ t: 'state', view: this._view(c.pid) }); } catch { /* */ } }
    this.ui.onState(this._view(this.myId));
    this._schedule();
    this._persist();
  }

  _view(pid) {
    const v = this.table.viewFor(pid);
    v.commitNext = this.commitNext;
    v.gen = this.gen;
    v.hostId = this.myId;
    return v;
  }

  _sendSnapshot() {
    if (this.offline) return;
    // преемники: подключённые люди по порядку мест после хоста
    const n = this.table.seats.length;
    const me = this.table.byId(this.myId);
    const connected = new Set([...this.conns.values()].map(c => c.pid));
    const succ = [];
    for (let k = 1; k <= n; k++) {
      const p = this.table.seats[((me ? me.seat : 0) + k) % n];
      if (p && !p.bot && connected.has(p.id)) succ.push(p.id);
    }
    const msg = { t: 'snap', snap: this.table.publicSnapshot(), gen: this.gen, code: this.code, succ, tokens: this.tokens, hostId: this.myId };
    for (const [, c] of this.conns) if (c.pid) { try { c.conn.send(msg); } catch { /* */ } }
  }

  _schedule() {
    const t = this.table;
    for (const k of ['adv', 'bot', 'turn', 'disc']) clearTimeout(this.timers[k]);
    if (t.pending) {
      const d = t.phase === 'runout' ? DELAY_RUNOUT : DELAY_STREET;
      this.timers.adv = setTimeout(() => { t.advance(); this.sync(); }, t.pending === 'finish' && t.phase !== 'runout' ? 700 : d);
      return;
    }
    if (t.phase === 'discard') {
      // боты сбрасывают сразу, люди — по таймеру
      for (const p of t.players()) if (p.needDiscard && (p.bot || p.sitOut)) t.discard(p.id, t.autoDiscardCard(p.id));
      if (t.phase !== 'discard') { this.sync(); return; }
      const lim = Math.max(10, t.s.actionTimer || 25) * 1000;
      this.timers.disc = setTimeout(() => {
        for (const p of t.players()) if (p.needDiscard) t.discard(p.id, t.autoDiscardCard(p.id));
        this.sync();
      }, t.players().some(p => p.needDiscard && p.connected) ? lim : 3000);
      return;
    }
    if (t.phase === 'over') {
      // следующую раздачу планируем один раз на раздачу, чтобы лишние синхронизации её не откладывали
      if (!t.tourOver && this._nextFor !== t.handNo) {
        this._nextFor = t.handNo;
        clearTimeout(this.timers.next);
        this.timers.next = setTimeout(() => this._nextHand(), DELAY_NEXT_HAND);
      }
      return;
    }
    if (t.phase === 'betting' && t.toAct >= 0) {
      const p = t.seats[t.toAct];
      if (p.bot) {
        this.timers.bot = setTimeout(() => {
          const d = botDecide(t.viewFor(p.id), p.id, p.bot) || { type: 'fold' };
          let r = t.act(p.id, d.type, d.amount);
          if (!r.ok) r = t.act(p.id, t.legal(p.id)?.canCheck ? 'check' : 'fold');
          this.sync();
        }, 700 + Math.random() * 1100);
        return;
      }
      if (p.sitOut) {
        this.timers.turn = setTimeout(() => { const L = t.legal(p.id); if (L) { t.act(p.id, L.canCheck ? 'check' : 'fold'); this.sync(); } }, 500);
        return;
      }
      const base = (t.s.actionTimer || 0) * 1000;
      if (base > 0 || !p.connected) {
        const limit = !p.connected ? 2500 : base + p.timebank * 1000;
        const hand = t.handNo, seat = t.toAct, started = t.turnStartedAt;
        const left = Math.max(500, limit - (Date.now() - started));
        this.timers.turn = setTimeout(() => {
          if (t.handNo !== hand || t.toAct !== seat || t.turnStartedAt !== started) return;
          const L = t.legal(p.id);
          if (p.connected) t.useTimebank(p.id, p.timebank);
          t.act(p.id, L && L.canCheck ? 'check' : 'fold');
          if (p.connected) {
            this._chatSys('sys_timeout', { name: p.name });
            this.strikes[p.id] = (this.strikes[p.id] || 0) + 1;
            if (this.strikes[p.id] >= 2) { t.setSitOut(p.id, true); this._chatSys('sys_autositout', { name: p.name }); }
          }
          this.sync();
        }, left);
      }
    }
  }

  _sendTo(pid, msg) {
    if (pid === this.myId) { this.ui.onMessage(msg); return; }
    for (const [, c] of this.conns) if (c.pid === pid) { try { c.conn.send(msg); } catch { /* */ } }
  }
  _bcast(msg) {
    for (const [, c] of this.conns) if (c.pid) { try { c.conn.send(msg); } catch { /* */ } }
    this.ui.onMessage(msg);
  }
  _chatSys(key, params = {}) { this._bcast({ t: 'chat', id: null, sys: true, key, params }); }

  _persist() {
    if (this.offline) return;
    clearTimeout(this.timers.save);
    this.timers.save = setTimeout(() => {
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify({
          at: Date.now(), code: this.code, gen: this.gen, tokens: this.tokens, started: this.started, myId: this.myId,
          avatars: Object.fromEntries(Object.entries(this.avatars).filter(([, v]) => v.length < 200)),
          table: { ...this.table, rnd: undefined, events: [] }
        }));
      } catch { /* */ }
    }, 400);
  }

  destroy() {
    for (const k in this.timers) { clearTimeout(this.timers[k]); clearInterval(this.timers[k]); }
    try { this.peer && this.peer.destroy(); } catch { /* */ }
  }
}

export function fairMaterial(serverSeed, seeds, handNo) {
  return serverSeed + '|' + Object.keys(seeds).sort().map(k => k + ':' + seeds[k]).join(',') + '|' + handNo;
}

export function savedHostTable() {
  try {
    const d = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (!d || Date.now() - d.at > 12 * 3600 * 1000) return null;
    return d;
  } catch { return null; }
}
export function clearSavedHostTable() { try { localStorage.removeItem(SAVE_KEY); } catch { /* */ } }

function reviveTable(data) {
  const t = new Table(data.s);
  const rnd = t.rnd;
  Object.assign(t, data);
  t.rnd = rnd;
  t.events = [];
  if (t.inHandPhase() || t.phase === 'betting') {
    for (const p of t.players()) if (p.inHand) { p.chips = p.startStack; p.total = 0; p.bet = 0; p.inHand = false; p.folded = true; }
    t.phase = 'idle'; t.pending = null; t.toAct = -1; t.board = [];
  }
  return t;
}
