// Хост: держит стол, гоняет ботов и таймеры, рассылает каждому игроку его вид стола
import { Table } from './engine.js';
import { botDecide, BOT_NAMES } from './bot.js';
import { openRoom, makeCode } from './net.js';

const SAVE_KEY = 'rpoker_host_table_v1';
const DELAY_STREET = 900, DELAY_RUNOUT = 1600, DELAY_NEXT_HAND = 4500;

export class HostController {
  constructor({ name, token, settings, offline = false, restore = null }, ui) {
    this.ui = ui;
    this.offline = offline;
    this.myId = 'h-' + token.slice(0, 8);
    this.code = restore?.code || makeCode();
    this.table = restore ? reviveTable(restore.table) : new Table(settings);
    this.conns = new Map();        // conn.peer -> { conn, pid }
    this.tokens = restore?.tokens || {}; // token -> pid
    this.timers = {};
    this.started = restore?.started || false;
    this.paused = false;
    if (!restore) this.table.addPlayer({ id: this.myId, name });
    else { const me = this.table.byId(this.myId); if (me) me.connected = true; }
    if (restore) for (const p of this.table.players()) if (!p.bot && p.id !== this.myId) p.connected = false;
    if (!offline) this._openRoom();
    if (restore && this.started) setTimeout(() => this._nextHand(), 2500);
    if (!offline) { /* статус придёт из onOpen */ }
    else setTimeout(() => this.ui.onStatus({ kind: 'ok', text: 'Тренировка с ботами (без сети)' }), 0);
  }

  isHost() { return true; }

  _openRoom() {
    this.ui.onStatus({ kind: 'wait', text: 'Открываю стол…' });
    this.peer = openRoom(this.code, {
      onOpen: () => this.ui.onStatus({ kind: 'ok', text: 'Стол открыт' }),
      onConn: conn => this._onConn(conn),
      onError: err => this.ui.onNetError(err)
    });
  }

  _onConn(conn) {
    conn.on('data', msg => this._onMsg(conn, msg));
    conn.on('close', () => {
      const c = this.conns.get(conn.peer);
      this.conns.delete(conn.peer);
      if (c && c.pid) {
        const p = this.table.byId(c.pid);
        if (p) { p.connected = false; this._chatSys(`${p.name} отключился`); }
        this.sync();
      }
    });
  }

  _onMsg(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    const c = this.conns.get(conn.peer) || { conn, pid: null };
    if (msg.t === 'join') {
      const name = String(msg.name || 'Игрок').slice(0, 16).trim() || 'Игрок';
      let pid = this.tokens[msg.token];
      if (pid && this.table.byId(pid)) {
        const p = this.table.byId(pid);
        p.connected = true;
        this._chatSys(`${p.name} вернулся за стол`);
      } else {
        pid = 'p-' + makeCode(6);
        const uniq = this._uniqName(name);
        const seat = this.table.addPlayer({ id: pid, name: uniq });
        if (seat < 0) { conn.send({ t: 'error', msg: 'Мест за столом нет' }); return; }
        this.tokens[msg.token] = pid;
        if (this.table.byId(pid).out) this._chatSys(`${uniq} сел за стол (зрителем до конца турнира)`);
        else this._chatSys(`${uniq} сел за стол`);
      }
      c.pid = pid;
      this.conns.set(conn.peer, c);
      conn.send({ t: 'welcome', id: pid, code: this.code });
      this.sync();
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

  // Общий обработчик действий (и для себя, и для клиентов)
  handle(pid, msg) {
    const p = this.table.byId(pid);
    if (!p) return;
    switch (msg.t) {
      case 'act': {
        const r = this.table.act(pid, msg.type, msg.amount);
        if (!r.ok) this._sendTo(pid, { t: 'error', msg: r.err });
        this.sync();
        break;
      }
      case 'chat': {
        const text = String(msg.text || '').slice(0, 200).trim();
        if (text) this._bcast({ t: 'chat', id: pid, name: p.name, text });
        break;
      }
      case 'emoji':
        this._bcast({ t: 'emoji', id: pid, e: String(msg.e || '').slice(0, 4) });
        break;
      case 'rebuy':
        if (this.table.rebuy(pid)) this.sync();
        break;
      case 'leave':
        this.table.removePlayer(pid);
        this.sync();
        break;
    }
  }

  // Действие самого хоста (через тот же путь)
  send(msg) { this.handle(this.myId, msg); }

  // ---------- управление столом (только хост) ----------
  addBot(style = 'normal') {
    const used = new Set(this.table.players().map(p => p.name));
    const name = BOT_NAMES.find(n => !used.has(n)) || 'Бот ' + makeCode(2);
    const seat = this.table.addPlayer({ id: 'b-' + makeCode(5), name, bot: style });
    if (seat < 0) this.ui.toast('Мест нет');
    this.sync();
  }
  removeSeat(pid) {
    if (pid === this.myId) return;
    const p = this.table.byId(pid);
    if (!p) return;
    this.table.removePlayer(pid);
    for (const [k, c] of this.conns) if (c.pid === pid) { try { c.conn.send({ t: 'kicked' }); } catch { /* */ } }
    this.sync();
  }
  start() {
    if (this.table.players().filter(p => !p.out && p.chips > 0).length < 2) { this.ui.toast('Нужно минимум 2 игрока — добавьте друзей или ботов'); return; }
    this.started = true; this.paused = false;
    this._nextHand();
  }
  togglePause() {
    this.paused = !this.paused;
    this._chatSys(this.paused ? 'Хост поставил игру на паузу после этой раздачи' : 'Игра продолжается');
    if (!this.paused && (this.table.phase === 'idle' || this.table.phase === 'over')) this._nextHand();
    this.sync();
  }
  newTournament() {
    const s = this.table.s;
    const t = new Table(s);
    for (const p of this.table.players()) {
      if (p.leaving) continue;
      t.addPlayer({ id: p.id, name: p.name, bot: p.bot, seat: p.seat });
      t.byId(p.id).connected = p.connected;
    }
    this.table = t;
    this.started = false;
    this.sync();
  }

  // ---------- игровой цикл ----------
  _nextHand() {
    clearTimeout(this.timers.next);
    if (this.paused || !this.started) return;
    if (!this.table.startHand()) {
      this.sync();
      if (!this.table.tourOver) this._chatSys('Ждём игроков: нужно минимум двое с фишками');
      return;
    }
    this.sync();
  }

  sync() {
    const t = this.table;
    const events = t.drainEvents();
    if (events.length) this._bcast({ t: 'events', list: events });
    for (const [, c] of this.conns) if (c.pid) { try { c.conn.send({ t: 'state', view: t.viewFor(c.pid) }); } catch { /* */ } }
    this.ui.onState(t.viewFor(this.myId));
    this._schedule();
    this._persist();
  }

  _schedule() {
    const t = this.table;
    clearTimeout(this.timers.adv); clearTimeout(this.timers.bot); clearTimeout(this.timers.turn);
    if (t.pending) {
      const d = t.phase === 'runout' ? DELAY_RUNOUT : DELAY_STREET;
      this.timers.adv = setTimeout(() => { t.advance(); this.sync(); }, t.pending === 'finish' && t.phase !== 'runout' ? 600 : d);
      return;
    }
    if (t.phase === 'over') {
      clearTimeout(this.timers.next);
      this.timers.next = setTimeout(() => this._nextHand(), t.tourOver ? 1e9 : DELAY_NEXT_HAND);
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
      const limit = !p.connected ? 6 : (t.s.actionTimer || 0);
      if (limit > 0) {
        const hand = t.handNo, seat = t.toAct, started = t.turnStartedAt;
        const left = Math.max(500, limit * 1000 - (Date.now() - started));
        this.timers.turn = setTimeout(() => {
          if (t.handNo !== hand || t.toAct !== seat || t.turnStartedAt !== started) return;
          const L = t.legal(p.id);
          t.act(p.id, L && L.canCheck ? 'check' : 'fold');
          if (p.connected) this._chatSys(`${p.name}: время вышло`);
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
  _chatSys(text) { this._bcast({ t: 'chat', id: null, name: '', text, sys: true }); }

  _persist() {
    if (this.offline) return;
    clearTimeout(this.timers.save);
    this.timers.save = setTimeout(() => {
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify({
          at: Date.now(), code: this.code, tokens: this.tokens, started: this.started,
          table: { ...this.table, rnd: undefined, events: [] }
        }));
      } catch { /* */ }
    }, 300);
  }

  destroy() {
    for (const k in this.timers) clearTimeout(this.timers[k]);
    try { this.peer && this.peer.destroy(); } catch { /* */ }
  }
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
  Object.assign(t, data);
  delete t.rnd;               // берём криптослучайность из прототипа-конструктора
  t.rnd = new Table().rnd;
  t.events = [];
  // недоигранную раздачу откатываем: возвращаем вложенное в банк
  if (t.phase === 'betting' || t.phase === 'runout' || t.pending) {
    for (const p of t.players()) { p.chips += p.total; p.total = 0; p.bet = 0; p.inHand = false; p.folded = true; }
    t.phase = 'idle'; t.pending = null; t.toAct = -1; t.board = [];
  }
  return t;
}
