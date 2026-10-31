// Движок покера: холдем (NL), омаха (PL/NL), ананас. Работает у хоста, клиенты получают свою «проекцию».
import { newDeck, shuffle, evalHand, handDesc, bestFiveVariant, secureRandom } from './cards.js';
import { chenScore } from './equity.js';

export const BLIND_LEVELS = [
  [10, 20], [15, 30], [20, 40], [30, 60], [40, 80], [50, 100], [75, 150], [100, 200],
  [150, 300], [200, 400], [300, 600], [400, 800], [500, 1000], [700, 1400], [1000, 2000],
  [1500, 3000], [2000, 4000], [3000, 6000], [5000, 10000]
];

export const DEFAULT_SETTINGS = {
  mode: 'cash',          // 'cash' | 'tournament'
  variant: 'holdem',     // 'holdem' | 'omaha' | 'pineapple'
  limit: 'nl',           // 'nl' | 'pl'
  startChips: 2000,
  sb: 10, bb: 20,
  levelMinutes: 8,
  actionTimer: 30,       // секунд на ход, 0 = без лимита
  timeBank: 30,          // запас времени на игрока, сек
  hints: true,
  ante: true,            // турнир: анте с 4-го уровня
  rebuyLevels: 2,        // турнир: ребай доступен первые N уровней
  prizes: true,          // турнир: призовые места
  seats: 6
};

export const HOLE_COUNT = { holdem: 2, omaha: 4, pineapple: 3 };

export class Table {
  constructor(settings = {}, rnd = secureRandom) {
    this.s = { ...DEFAULT_SETTINGS, ...settings };
    if (this.s.variant === 'omaha' && !settings.limit) this.s.limit = 'pl';
    this.rnd = rnd;
    this.seats = new Array(this.s.seats).fill(null);
    this.dealer = -1;
    this.handNo = 0;
    this.phase = 'idle';      // idle | betting | discard | runout | over
    this.street = 'preflop';
    this.board = [];
    this.deck = [];
    this.currentBet = 0;
    this.minRaise = this.s.bb;
    this.toAct = -1;
    this.pending = null;
    this.sbSeat = -1; this.bbSeat = -1;
    this.lastResult = null;
    this.revealAll = false;
    this.events = [];
    this.levelIdx = 0;
    this.blinds = [this.s.sb, this.s.bb];
    this.ante = 0;
    this.tourStart = null;
    this.tourOver = false;
    this.places = [];
    this.prizes = null;
    this.bustCounter = 0;
    this.turnStartedAt = 0;
    this.departedPot = 0;
    this.dealOrder = [];
    this.fair = null;
  }

  // ---------- игроки ----------
  players() { return this.seats.filter(Boolean); }
  byId(id) { return this.seats.find(p => p && p.id === id) || null; }

  addPlayer({ id, name, bot = null, seat = null }) {
    if (this.byId(id)) return this.byId(id).seat;
    const idx = seat != null && !this.seats[seat] ? seat : this.seats.findIndex(x => !x);
    if (idx < 0) return -1;
    const lateTour = this.s.mode === 'tournament' && this.tourStart != null;
    const canLate = lateTour && this.levelIdx < this.s.rebuyLevels;
    this.seats[idx] = {
      id, name, bot, seat: idx,
      chips: lateTour && !canLate ? 0 : this.s.startChips,
      buyins: lateTour && !canLate ? 0 : 1,
      hole: [], bet: 0, total: 0, folded: true, allin: false, acted: false, raiseLocked: false,
      inHand: false, out: lateTour && !canLate, leaving: false, connected: true, lastAction: null,
      vpip: false, pfr: false, startStack: 0, place: 0, sitOut: false, timebank: this.s.timeBank,
      hist: [], aggN: 0, callN: 0, canRebuy: false, bustOrder: 0, needDiscard: false
    };
    this.emit({ t: 'join', id, name });
    return idx;
  }

  removePlayer(id) {
    const p = this.byId(id); if (!p) return;
    if (p.inHand && this.inHandPhase()) {
      p.leaving = true;
      if (!p.folded && this.toAct === p.seat && this.phase === 'betting') this.act(id, 'fold');
      else if (!p.folded) { p.folded = true; p.needDiscard = false; this._afterFoldOutOfTurn(); }
    } else this.seats[p.seat] = null;
    this.emit({ t: 'leave', id, name: p.name });
  }

  inHandPhase() { return ['betting', 'discard', 'runout'].includes(this.phase) || !!this.pending && this.phase !== 'over'; }

  rebuy(id) {
    const p = this.byId(id);
    if (!p || p.chips > 0) return false;
    if (p.inHand && this.inHandPhase()) return false;
    if (this.s.mode === 'cash') {
      p.chips = this.s.startChips; p.buyins++; p.out = false;
    } else {
      if (!p.canRebuy || this.levelIdx >= this.s.rebuyLevels || this.tourOver) return false;
      p.chips = this.s.startChips; p.buyins++; p.out = false; p.canRebuy = false;
    }
    this.emit({ t: 'rebuy', id, name: p.name });
    return true;
  }

  setSitOut(id, v) {
    const p = this.byId(id); if (!p) return;
    p.sitOut = !!v;
    this.emit({ t: 'sitout', id, name: p.name, v: p.sitOut });
  }

  emit(e) { this.events.push(e); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  canAct(p) { return p && p.inHand && !p.folded && !p.allin; }
  inHandList() { return this.players().filter(p => p.inHand && !p.folded); }
  pot() { return this.players().reduce((a, p) => a + p.total, 0) + this.departedPot; }

  nextSeat(from, pred) {
    const n = this.seats.length;
    for (let i = 1; i <= n; i++) {
      const idx = (from + i + n) % n;
      const p = this.seats[idx];
      if (p && pred(p)) return idx;
    }
    return -1;
  }

  // ---------- турнир ----------
  updateLevel(now = Date.now()) {
    if (this.s.mode !== 'tournament') { this.blinds = [this.s.sb, this.s.bb]; this.ante = 0; return; }
    if (this.tourStart == null) this.tourStart = now;
    const idx = Math.min(BLIND_LEVELS.length - 1, Math.floor((now - this.tourStart) / (this.s.levelMinutes * 60000)));
    const k = this.s.bb / 20;
    if (idx !== this.levelIdx || !this._lvlInit) {
      const prev = this.levelIdx;
      this.levelIdx = idx; this._lvlInit = true;
      const [a, b] = BLIND_LEVELS[idx];
      this.blinds = [Math.round(a * k), Math.round(b * k)];
      this.ante = this.s.ante && idx >= 3 ? Math.max(1, Math.round(this.blinds[1] / 10)) : 0;
      if (idx > 0) this.emit({ t: 'level', level: idx + 1, sb: this.blinds[0], bb: this.blinds[1], ante: this.ante });
      if (prev < this.s.rebuyLevels && idx >= this.s.rebuyLevels) {
        this.emit({ t: 'rebuyClosed' });
        this._finalizePendingBusts();
      }
    }
  }
  nextLevelAt() {
    if (this.s.mode !== 'tournament' || this.tourStart == null) return null;
    return this.tourStart + (this.levelIdx + 1) * this.s.levelMinutes * 60000;
  }

  // ---------- раздача ----------
  startHand(now = Date.now(), deck = null) {
    if (this.tourOver) return false;
    for (const p of this.players()) if (p.leaving) this.seats[p.seat] = null;
    this.updateLevel(now);
    if (this.tourOver) return false;
    for (const p of this.players()) {
      p.inHand = false; p.hole = []; p.bet = 0; p.total = 0; p.folded = true; p.allin = false;
      p.acted = false; p.raiseLocked = false; p.lastAction = null; p.vpip = false; p.pfr = false;
      p.hist = []; p.aggN = 0; p.callN = 0; p.needDiscard = false;
      if (p.chips <= 0) p.out = true;
    }
    const cashSit = this.s.mode === 'cash';
    // в кэше отошедшим и отключившимся карты не раздаём
    const active = this.players().filter(p => !p.out && p.chips > 0 && !(cashSit && (p.sitOut || (p.connected === false && !p.bot))));
    if (active.length < 2) {
      if (this.s.mode === 'tournament' && this.tourStart != null) {
        const alive = this.players().filter(p => p.chips > 0);
        if (alive.length === 1 && !this.players().some(p => p.canRebuy && this.levelIdx < this.s.rebuyLevels)) {
          this._finalizePendingBusts(); this._tourWinner(alive[0]);
        }
      }
      this.phase = 'idle';
      return false;
    }
    this.handNo++;
    this.departedPot = 0;
    this.board = [];
    this.lastResult = null;
    this.revealAll = false;
    for (const p of active) {
      p.inHand = true; p.folded = false; p.startStack = p.chips;
      p.timebank = Math.min(this.s.timeBank, p.timebank + 3);
    }
    const isIn = p => p.inHand;
    this.dealer = this.nextSeat(this.dealer, isIn);
    if (active.length === 2) {
      this.sbSeat = this.dealer;
      this.bbSeat = this.nextSeat(this.dealer, isIn);
    } else {
      this.sbSeat = this.nextSeat(this.dealer, isIn);
      this.bbSeat = this.nextSeat(this.sbSeat, isIn);
    }
    const [sb, bb] = this.blinds;
    if (this.ante > 0) for (const p of active) {
      const a = Math.min(this.ante, p.chips);
      p.chips -= a; p.total += a;
      if (p.chips === 0) p.allin = true;
      p.hist.push({ s: 'preflop', t: 'ante', a });
    }
    this._post(this.seats[this.sbSeat], sb, 'sb');
    this._post(this.seats[this.bbSeat], bb, 'bb');
    this.deck = deck ? deck.slice() : shuffle(newDeck(), this.rnd);
    const hc = HOLE_COUNT[this.s.variant] || 2;
    this.dealOrder = [];
    let s0 = this.sbSeat;
    for (let i = 0; i < active.length; i++) { this.dealOrder.push(s0); s0 = this.nextSeat(s0, isIn); }
    for (let r = 0; r < hc; r++) for (const s of this.dealOrder) this.seats[s].hole.push(this.deck.pop());
    this.street = 'preflop';
    this.currentBet = Math.max(bb, ...active.map(p => p.bet));
    this.minRaise = bb;
    this.phase = 'betting';
    this.pending = null;
    this.emit({ t: 'hand', handNo: this.handNo, dealer: this.dealer });
    this.toAct = this.nextSeat(this.bbSeat, p => this.canAct(p));
    this._checkRoundState(this.seats[this.bbSeat]);
    this.turnStartedAt = now;
    return true;
  }

  _post(p, amount, label) {
    const a = Math.min(amount, p.chips);
    p.chips -= a; p.bet += a; p.total += a;
    if (p.chips === 0) p.allin = true;
    p.lastAction = { t: label, a };
    p.hist.push({ s: 'preflop', t: label, a });
  }

  _pay(p, amount) {
    const a = Math.min(amount, p.chips);
    p.chips -= a; p.bet += a; p.total += a;
    if (p.chips === 0) p.allin = true;
    return a;
  }

  legal(id) {
    const p = this.byId(id);
    if (!p || this.phase !== 'betting' || this.toAct !== p.seat || this.pending) return null;
    const toCall = Math.max(0, this.currentBet - p.bet);
    let maxTo = p.bet + p.chips;
    if (this.s.limit === 'pl') {
      // пот-лимит: рейз максимум на размер банка после колла
      const potAfterCall = this.pot() + toCall;
      maxTo = Math.min(maxTo, this.currentBet + potAfterCall);
    }
    const minTo = Math.min(p.bet + p.chips, this.currentBet + this.minRaise);
    const othersCanAct = this.players().some(o => o !== p && this.canAct(o));
    return {
      canCheck: toCall === 0,
      toCall: Math.min(toCall, p.chips),
      canRaise: !p.raiseLocked && p.bet + p.chips > this.currentBet && othersCanAct,
      minTo: Math.min(minTo, maxTo), maxTo,
      allinTo: p.bet + p.chips,
      pot: this.pot(),
      currentBet: this.currentBet,
      myBet: p.bet,
      limit: this.s.limit
    };
  }

  act(id, type, amount = 0) {
    const p = this.byId(id);
    const L = this.legal(id);
    if (!L) return { ok: false, err: 'not_your_turn' };
    const toCall = this.currentBet - p.bet;
    const pre = this.street === 'preflop';
    if (type === 'allin') {
      if (p.bet + p.chips <= this.currentBet) type = 'call';
      else { type = 'raise'; amount = L.maxTo; }
    }
    switch (type) {
      case 'fold':
        p.folded = true; p.lastAction = { t: 'fold' };
        break;
      case 'check':
        if (toCall > 0) return { ok: false, err: 'cant_check' };
        p.lastAction = { t: 'check' };
        break;
      case 'call': {
        if (toCall <= 0) { p.lastAction = { t: 'check' }; type = 'check'; break; }
        const a = this._pay(p, toCall);
        p.lastAction = p.allin ? { t: 'allin', a: p.bet } : { t: 'call', a };
        if (pre) p.vpip = true; else p.callN++;
        break;
      }
      case 'raise': {
        if (!L.canRaise) return { ok: false, err: 'cant_raise' };
        let to = Math.floor(amount);
        to = Math.min(to, L.maxTo);
        if (to < L.minTo) return { ok: false, err: 'min_raise', v: L.minTo };
        if (to <= this.currentBet) return { ok: false, err: 'raise_small' };
        const raiseBy = to - this.currentBet;
        this._pay(p, to - p.bet);
        const full = raiseBy >= this.minRaise;
        const wasBet = this.currentBet === 0;
        this.currentBet = to;
        if (full) {
          this.minRaise = raiseBy;
          for (const o of this.players()) if (o !== p && this.canAct(o)) { o.acted = false; o.raiseLocked = false; }
        } else {
          for (const o of this.players()) if (o !== p && this.canAct(o) && o.acted) o.raiseLocked = true;
        }
        p.lastAction = p.allin ? { t: 'allin', a: to } : { t: wasBet ? 'bet' : 'raise', a: to };
        if (pre) { p.vpip = true; p.pfr = true; } else p.aggN++;
        break;
      }
      default:
        return { ok: false, err: 'unknown' };
    }
    p.hist.push({ s: this.street, t: p.lastAction.t === 'allin' ? (type === 'raise' ? 'raise' : 'call') : p.lastAction.t, a: p.lastAction.a || 0, allin: p.lastAction.t === 'allin' });
    p.acted = true;
    this.emit({ t: 'act', id, name: p.name, action: p.lastAction, seat: p.seat, street: this.street });
    this._checkRoundState(p);
    this.turnStartedAt = Date.now();
    return { ok: true };
  }

  useTimebank(id, secs) {
    const p = this.byId(id); if (!p) return;
    p.timebank = Math.max(0, p.timebank - secs);
  }

  _afterFoldOutOfTurn() {
    if (this.inHandList().length === 1) { this.pending = 'finish'; this.toAct = -1; if (this.phase === 'discard') this.phase = 'betting'; }
    else if (this.phase === 'discard') this._checkDiscardDone();
    else if (this.phase === 'betting' && this._roundDone()) this._checkRoundState(null);
  }

  _roundDone() {
    const able = this.players().filter(o => this.canAct(o));
    if (able.length === 0) return true;
    if (able.length === 1 && able[0].bet >= this.currentBet && this.inHandList().length > 1) {
      const others = this.inHandList().filter(o => o !== able[0]);
      if (others.every(o => o.allin)) return true;
    }
    return this.players().every(o => !this.canAct(o) || (o.acted && o.bet === this.currentBet));
  }

  _checkRoundState(last) {
    const alive = this.inHandList();
    if (alive.length === 1) { this.pending = 'finish'; this.toAct = -1; return; }
    if (this._roundDone()) {
      this.toAct = -1;
      if (this.street === 'preflop' && this.s.variant === 'pineapple' && alive.some(p => p.hole.length > 2)) {
        // ананас: после торговли до флопа каждый сбрасывает одну карту
        this.phase = 'discard';
        for (const p of alive) p.needDiscard = p.hole.length > 2;
        this.pending = null;
        this.emit({ t: 'discardPhase' });
        return;
      }
      const able = this.players().filter(o => this.canAct(o));
      if (able.length <= 1) { this.phase = 'runout'; this.revealAll = true; }
      this.pending = this.street === 'river' ? 'finish' : 'street';
      return;
    }
    const from = last ? last.seat : this.toAct;
    this.toAct = this.nextSeat(from, o => this.canAct(o) && (!o.acted || o.bet < this.currentBet));
  }

  discard(id, card) {
    const p = this.byId(id);
    if (!p || this.phase !== 'discard' || !p.needDiscard) return { ok: false, err: 'no_discard' };
    const i = p.hole.indexOf(card);
    if (i < 0) return { ok: false, err: 'no_card' };
    p.hole.splice(i, 1);
    p.needDiscard = false;
    this.emit({ t: 'discard', id, name: p.name });
    this._checkDiscardDone();
    return { ok: true };
  }

  // лучший сброс для авто-режима: оставить пару карт с наибольшей оценкой Чена
  autoDiscardCard(id) {
    const p = this.byId(id); if (!p || p.hole.length < 3) return null;
    let best = -99, drop = p.hole[2];
    for (let i = 0; i < 3; i++) {
      const keep = p.hole.filter((_, j) => j !== i);
      const sc = chenScore(keep);
      if (sc > best) { best = sc; drop = p.hole[i]; }
    }
    return drop;
  }

  _checkDiscardDone() {
    if (this.players().some(p => p.needDiscard && p.inHand && !p.folded)) return;
    const able = this.players().filter(o => this.canAct(o));
    if (able.length <= 1) { this.phase = 'runout'; this.revealAll = true; }
    else this.phase = 'betting';
    this.pending = 'street';
  }

  advance() {
    const what = this.pending;
    this.pending = null;
    if (what === 'finish') return this._finish();
    if (what !== 'street') return;
    for (const p of this.players()) { p.bet = 0; p.acted = false; p.raiseLocked = false; if (!p.folded && !p.allin) p.lastAction = null; }
    this.currentBet = 0;
    this.minRaise = this.blinds[1];
    this.deck.pop(); // сжигаем карту
    if (this.street === 'preflop') { this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop()); this.street = 'flop'; }
    else if (this.street === 'flop') { this.board.push(this.deck.pop()); this.street = 'turn'; }
    else if (this.street === 'turn') { this.board.push(this.deck.pop()); this.street = 'river'; }
    this.emit({ t: 'street', street: this.street, board: this.board.slice() });
    const able = this.players().filter(o => this.canAct(o));
    if (able.length <= 1) {
      this.phase = 'runout'; this.revealAll = true;
      this.pending = this.street === 'river' ? 'finish' : 'street';
      this.toAct = -1;
    } else {
      this.phase = 'betting';
      this.toAct = this.nextSeat(this.dealer, o => this.canAct(o));
      this.turnStartedAt = Date.now();
    }
  }

  _finish() {
    const all = this.players().filter(p => p.inHand);
    const alive = all.filter(p => !p.folded);
    const v = this.s.variant;
    const res = { handNo: this.handNo, winners: [], showdown: false, shown: {}, board: this.board.slice(), pots: [], variant: v };
    const won = new Map();
    const credit = (p, amt) => { p.chips += amt; won.set(p.id, (won.get(p.id) || 0) + amt); };

    if (alive.length === 1) {
      const w = alive[0];
      const amt = this.pot();
      credit(w, amt);
      res.pots.push({ amount: amt, winners: [w.id] });
    } else {
      res.showdown = true;
      const scores = new Map();
      for (const p of alive) {
        const sc = evalHand(p.hole, this.board, v);
        scores.set(p.id, sc);
        res.shown[p.id] = { hole: p.hole.slice(), desc: handDesc(sc), best: bestFiveVariant(p.hole, this.board, v) };
      }
      const levels = [...new Set(all.map(p => p.total).filter(t => t > 0))].sort((a, b) => a - b);
      let prev = 0;
      let extra = this.departedPot || 0;
      for (const lvl of levels) {
        let amount = extra; extra = 0;
        for (const p of all) amount += Math.max(0, Math.min(p.total, lvl) - Math.min(p.total, prev));
        prev = lvl;
        if (amount <= 0) continue;
        let elig = alive.filter(p => p.total >= lvl);
        if (!elig.length) elig = alive.filter(p => p.total === Math.max(...alive.map(a => a.total)));
        const best = Math.max(...elig.map(p => scores.get(p.id)));
        const winners = elig.filter(p => scores.get(p.id) === best);
        const share = Math.floor(amount / winners.length);
        let rem = amount - share * winners.length;
        const n = this.seats.length;
        const order = winners.slice().sort((a, b) => ((a.seat - this.dealer - 1 + n * 4) % n) - ((b.seat - this.dealer - 1 + n * 4) % n));
        for (const w of order) { credit(w, share + (rem > 0 ? 1 : 0)); if (rem > 0) rem--; }
        res.pots.push({ amount, winners: winners.map(w => w.id) });
      }
    }
    for (const [id, amount] of won) {
      const p = this.byId(id);
      res.winners.push({ id, name: p.name, amount, desc: res.shown[id]?.desc || null });
    }
    res.players = all.map(p => ({
      id: p.id, name: p.name, bot: p.bot, net: p.chips - p.startStack, vpip: p.vpip, pfr: p.pfr,
      won: won.has(p.id), showdown: res.showdown && !p.folded, aggN: p.aggN, callN: p.callN
    }));
    res.pot = res.pots.reduce((a, x) => a + x.amount, 0);
    res.dealOrder = this.dealOrder.map(s => this.seats[s]?.id);
    for (const p of all) { p.total = 0; p.bet = 0; p.needDiscard = false; }
    this.departedPot = 0;
    this.lastResult = res;
    this.phase = 'over';
    this.toAct = -1;
    this.revealAll = res.showdown;
    this.emit({ t: 'result', result: res });
    if (this.s.mode === 'tournament') this._tourBusts(all);
    return res;
  }

  showCards(id) {
    const p = this.byId(id);
    if (!p || this.phase !== 'over' || !this.lastResult || !p.inHand || p.hole.length < 2) return false;
    if (this.lastResult.shown[id]) return false;
    const full = this.board.length >= 3;
    const sc = full ? evalHand(p.hole, this.board, this.s.variant) : null;
    this.lastResult.shown[id] = { hole: p.hole.slice(), desc: sc != null ? handDesc(sc) : null, best: [], voluntary: true };
    this.emit({ t: 'show', id, name: p.name, hole: p.hole.slice() });
    return true;
  }

  _tourBusts(all) {
    const busted = all.filter(p => p.chips <= 0 && !p.place && !p.canRebuy).sort((a, b) => a.startStack - b.startStack);
    if (!busted.length) return;
    if (this.levelIdx < this.s.rebuyLevels) {
      for (const p of busted) {
        p.out = true; p.canRebuy = true; p.bustOrder = ++this.bustCounter;
        this.emit({ t: 'bustRebuy', id: p.id, name: p.name });
      }
    } else {
      const remaining = this.players().filter(p => p.chips > 0).length;
      let place = remaining + busted.length;
      for (const p of busted) {
        p.place = place; p.out = true;
        this.places.push({ id: p.id, name: p.name, place, bot: p.bot });
        this.emit({ t: 'bust', id: p.id, name: p.name, place });
        place--;
      }
    }
    const left = this.players().filter(p => p.chips > 0);
    if (left.length === 1 && !(this.levelIdx < this.s.rebuyLevels && this.players().some(p => p.canRebuy))) {
      this._finalizePendingBusts();
      this._tourWinner(left[0]);
    }
  }

  // закрылся период ребаев: выбывшим без докупки раздаём места (позже выбыл — место выше)
  _finalizePendingBusts() {
    const pend = this.players().filter(p => p.canRebuy && p.chips <= 0 && !p.place).sort((a, b) => b.bustOrder - a.bustOrder);
    let place = this.players().filter(p => p.chips > 0).length + 1;
    for (const p of pend) {
      p.canRebuy = false; p.place = place; p.out = true;
      this.places.push({ id: p.id, name: p.name, place, bot: p.bot });
      this.emit({ t: 'bust', id: p.id, name: p.name, place });
      place++;
    }
  }

  _tourWinner(p) {
    if (this.tourOver) return;
    p.place = 1;
    this.places.push({ id: p.id, name: p.name, place: 1, bot: p.bot });
    this.tourOver = true;
    const places = this.places.slice().sort((a, b) => a.place - b.place);
    if (this.s.prizes) {
      const entries = this.players().reduce((a, x) => a + x.buyins, 0);
      const n = places.length;
      const pct = n <= 3 ? [100] : n <= 5 ? [65, 35] : [50, 30, 20];
      const pool = entries * 100;
      this.prizes = pct.map((x, i) => ({ place: i + 1, pct: x, amount: Math.round(pool * x / 100), name: places[i]?.name }));
    }
    this.emit({ t: 'tourover', id: p.id, name: p.name, places, prizes: this.prizes });
  }

  // ---------- снимок для передачи стола другому хосту ----------
  publicSnapshot() {
    const midHand = this.inHandPhase();
    return {
      s: this.s, dealer: this.dealer, handNo: this.handNo, levelIdx: this.levelIdx, tourStart: this.tourStart,
      places: this.places, tourOver: this.tourOver, prizes: this.prizes, bustCounter: this.bustCounter,
      seats: this.seats.map(p => p && {
        id: p.id, name: p.name, bot: p.bot, seat: p.seat,
        chips: midHand && p.inHand ? p.startStack : p.chips,
        buyins: p.buyins, out: p.out, place: p.place, canRebuy: p.canRebuy, bustOrder: p.bustOrder,
        timebank: p.timebank, sitOut: p.sitOut
      })
    };
  }

  static fromSnapshot(snap) {
    const t = new Table(snap.s);
    Object.assign(t, {
      dealer: snap.dealer, handNo: snap.handNo, levelIdx: snap.levelIdx, tourStart: snap.tourStart,
      places: snap.places || [], tourOver: snap.tourOver, prizes: snap.prizes, bustCounter: snap.bustCounter || 0,
      _lvlInit: false
    });
    snap.seats.forEach((sp, i) => {
      if (!sp) return;
      t.addPlayer({ id: sp.id, name: sp.name, bot: sp.bot, seat: i });
      Object.assign(t.seats[i], {
        chips: sp.chips, buyins: sp.buyins, out: sp.out, place: sp.place, canRebuy: sp.canRebuy,
        bustOrder: sp.bustOrder, timebank: sp.timebank, sitOut: sp.sitOut, connected: !!sp.bot
      });
    });
    t.events = [];
    return t;
  }

  // ---------- проекция для игрока ----------
  viewFor(id) {
    const shownR = this.lastResult?.shown || {};
    return {
      v: 2,
      you: id,
      now: Date.now(),
      settings: this.s,
      handNo: this.handNo,
      phase: this.phase,
      street: this.street,
      board: this.board.slice(),
      pot: this.pot(),
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      toAct: this.toAct,
      dealer: this.dealer, sbSeat: this.sbSeat, bbSeat: this.bbSeat,
      blinds: this.blinds.slice(),
      ante: this.ante,
      level: this.levelIdx + 1,
      nextLevelAt: this.nextLevelAt(),
      rebuyOpen: this.s.mode === 'cash' || (this.levelIdx < this.s.rebuyLevels && !this.tourOver),
      turnStartedAt: this.turnStartedAt,
      tourOver: this.tourOver,
      places: this.places.slice().sort((a, b) => a.place - b.place),
      prizes: this.prizes,
      lastResult: this.lastResult,
      legal: this.legal(id),
      fair: this.fair ? { commit: this.fair.commit, seeds: this.fair.seeds, handNo: this.fair.handNo } : null,
      seats: this.seats.map(p => p && {
        id: p.id, name: p.name, bot: p.bot, seat: p.seat, chips: p.chips, bet: p.bet,
        folded: p.folded, allin: p.allin, inHand: p.inHand, out: p.out, connected: p.connected,
        lastAction: p.lastAction, buyins: p.buyins, place: p.place, sitOut: p.sitOut,
        timebank: p.timebank, canRebuy: p.canRebuy, needDiscard: p.needDiscard,
        hist: p.hist,
        cardCount: p.inHand && !p.folded ? p.hole.length : 0,
        hole: (p.id === id || (this.revealAll && p.inHand && !p.folded) || shownR[p.id]) ? p.hole.slice() : null
      })
    };
  }
}
