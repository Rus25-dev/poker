// Движок техасского холдема (No-Limit). Работает у хоста, клиенты получают только свою «проекцию».
import { newDeck, shuffle, evaluate, handName, bestFive, secureRandom } from './cards.js';

export const BLIND_LEVELS = [
  [10, 20], [15, 30], [20, 40], [30, 60], [40, 80], [50, 100], [75, 150], [100, 200],
  [150, 300], [200, 400], [300, 600], [400, 800], [500, 1000], [700, 1400], [1000, 2000],
  [1500, 3000], [2000, 4000], [3000, 6000], [5000, 10000]
];

export const DEFAULT_SETTINGS = {
  mode: 'cash',          // 'cash' | 'tournament'
  startChips: 2000,
  sb: 10, bb: 20,
  levelMinutes: 8,       // турнир: длительность уровня блайндов
  actionTimer: 30,       // секунд на ход, 0 = без таймера
  hints: true,           // разрешить подсказки силы руки
  seats: 6
};

export class Table {
  constructor(settings = {}, rnd = secureRandom) {
    this.s = { ...DEFAULT_SETTINGS, ...settings };
    this.rnd = rnd;
    this.seats = new Array(this.s.seats).fill(null);
    this.dealer = -1;
    this.handNo = 0;
    this.phase = 'idle';      // idle | betting | runout | over
    this.street = 'preflop';
    this.board = [];
    this.deck = [];
    this.currentBet = 0;
    this.minRaise = this.s.bb;
    this.toAct = -1;
    this.pending = null;      // 'street' | 'finish' — хост вызывает advance() с задержкой
    this.sbSeat = -1; this.bbSeat = -1;
    this.lastResult = null;
    this.revealAll = false;
    this.events = [];
    this.levelIdx = 0;
    this.blinds = [this.s.sb, this.s.bb];
    this.tourStart = null;
    this.tourOver = false;
    this.places = [];          // [{id,name,place}]
    this.turnStartedAt = 0;
    this.departedPot = 0;
  }

  // ---------- игроки ----------
  players() { return this.seats.filter(Boolean); }
  byId(id) { return this.seats.find(p => p && p.id === id) || null; }

  addPlayer({ id, name, bot = null, seat = null }) {
    if (this.byId(id)) return this.byId(id).seat;
    let idx = seat != null && !this.seats[seat] ? seat : this.seats.findIndex(x => !x);
    if (idx < 0) return -1;
    const lateTour = this.s.mode === 'tournament' && this.tourStart != null;
    this.seats[idx] = {
      id, name, bot, seat: idx,
      chips: lateTour ? 0 : this.s.startChips,
      buyins: lateTour ? 0 : 1,
      hole: [], bet: 0, total: 0, folded: true, allin: false, acted: false, raiseLocked: false,
      inHand: false, out: lateTour, leaving: false, connected: true, lastAction: '',
      vpip: false, pfr: false, startStack: 0, place: 0
    };
    this.emit({ t: 'join', id, name });
    return idx;
  }

  removePlayer(id) {
    const p = this.byId(id); if (!p) return;
    if (p.inHand && this.phase !== 'idle' && this.phase !== 'over') {
      p.leaving = true;
      if (!p.folded && this.toAct === p.seat) this.act(id, 'fold');
      else if (!p.folded) { p.folded = true; this._afterFoldOutOfTurn(); }
    } else {
      this.seats[p.seat] = null;
    }
    this.emit({ t: 'leave', id, name: p.name });
  }

  rebuy(id) {
    const p = this.byId(id);
    if (!p || this.s.mode !== 'cash' || p.chips > 0 || p.inHand && this.phase !== 'idle' && this.phase !== 'over') return false;
    p.chips = this.s.startChips; p.buyins++; p.out = false;
    this.emit({ t: 'rebuy', id, name: p.name });
    return true;
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
    if (this.s.mode !== 'tournament') { this.blinds = [this.s.sb, this.s.bb]; return; }
    if (this.tourStart == null) this.tourStart = now;
    const idx = Math.min(BLIND_LEVELS.length - 1, Math.floor((now - this.tourStart) / (this.s.levelMinutes * 60000)));
    // уровни масштабируются от стартового большого блайнда
    const k = this.s.bb / 20;
    if (idx !== this.levelIdx || !this._lvlInit) {
      this.levelIdx = idx; this._lvlInit = true;
      const [a, b] = BLIND_LEVELS[idx];
      this.blinds = [Math.round(a * k), Math.round(b * k)];
      if (idx > 0) this.emit({ t: 'level', level: idx + 1, sb: this.blinds[0], bb: this.blinds[1] });
    }
  }
  nextLevelAt() {
    if (this.s.mode !== 'tournament' || this.tourStart == null) return null;
    return this.tourStart + (this.levelIdx + 1) * this.s.levelMinutes * 60000;
  }

  // ---------- раздача ----------
  startHand(now = Date.now()) {
    if (this.tourOver) return false;
    for (const p of this.players()) if (p.leaving) this.seats[p.seat] = null;
    this.updateLevel(now);
    for (const p of this.players()) {
      p.inHand = false; p.hole = []; p.bet = 0; p.total = 0; p.folded = true; p.allin = false;
      p.acted = false; p.raiseLocked = false; p.lastAction = ''; p.vpip = false; p.pfr = false;
      if (p.chips <= 0) p.out = true;
    }
    const active = this.players().filter(p => !p.out && p.chips > 0);
    if (active.length < 2) {
      if (this.s.mode === 'tournament' && this.tourStart != null && active.length === 1) this._tourWinner(active[0]);
      this.phase = 'idle';
      return false;
    }
    this.handNo++;
    this.departedPot = 0;
    this.board = [];
    this.lastResult = null;
    this.revealAll = false;
    for (const p of active) { p.inHand = true; p.folded = false; p.startStack = p.chips; }
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
    this._post(this.seats[this.sbSeat], sb, 'МБ');
    this._post(this.seats[this.bbSeat], bb, 'ББ');
    this.deck = shuffle(newDeck(), this.rnd);
    for (let r = 0; r < 2; r++) {
      let s = this.sbSeat;
      for (let i = 0; i < active.length; i++) {
        this.seats[s].hole.push(this.deck.pop());
        s = this.nextSeat(s, isIn);
      }
    }
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
    p.lastAction = `${label} ${a}`;
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
    const maxTo = p.bet + p.chips;
    const minTo = Math.min(maxTo, this.currentBet + this.minRaise);
    const othersCanAct = this.players().some(o => o !== p && this.canAct(o));
    return {
      canCheck: toCall === 0,
      toCall: Math.min(toCall, p.chips),
      canRaise: !p.raiseLocked && maxTo > this.currentBet && othersCanAct,
      minTo, maxTo,
      pot: this.pot(),
      currentBet: this.currentBet,
      myBet: p.bet
    };
  }

  act(id, type, amount = 0) {
    const p = this.byId(id);
    const L = this.legal(id);
    if (!L) return { ok: false, err: 'Сейчас не ваш ход' };
    const toCall = this.currentBet - p.bet;
    const pre = this.street === 'preflop';
    if (type === 'allin') {
      if (p.bet + p.chips <= this.currentBet) type = 'call';
      else { type = 'raise'; amount = p.bet + p.chips; }
    }
    switch (type) {
      case 'fold':
        p.folded = true; p.lastAction = 'Фолд';
        break;
      case 'check':
        if (toCall > 0) return { ok: false, err: 'Нельзя чек — есть ставка' };
        p.lastAction = 'Чек';
        break;
      case 'call': {
        if (toCall <= 0) { p.lastAction = 'Чек'; break; }
        const a = this._pay(p, toCall);
        p.lastAction = p.allin ? `Олл-ин ${p.bet}` : `Колл ${a}`;
        if (pre) p.vpip = true;
        break;
      }
      case 'raise': {
        if (!L.canRaise) return { ok: false, err: 'Рейз недоступен' };
        let to = Math.floor(amount);
        to = Math.min(to, L.maxTo);
        if (to < L.minTo) return { ok: false, err: `Минимальный рейз до ${L.minTo}` };
        if (to <= this.currentBet) return { ok: false, err: 'Рейз должен быть больше ставки' };
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
        p.lastAction = p.allin ? `Олл-ин ${to}` : (wasBet ? `Бет ${to}` : `Рейз до ${to}`);
        if (pre) { p.vpip = true; p.pfr = true; }
        break;
      }
      default:
        return { ok: false, err: 'Неизвестное действие' };
    }
    p.acted = true;
    this.emit({ t: 'act', id, name: p.name, action: p.lastAction, seat: p.seat });
    this._checkRoundState(p);
    this.turnStartedAt = Date.now();
    return { ok: true };
  }

  _afterFoldOutOfTurn() {
    if (this.inHandList().length === 1) { this.pending = 'finish'; this.toAct = -1; }
    else if (this._roundDone()) this._checkRoundState(null);
  }

  _roundDone() {
    const able = this.players().filter(o => this.canAct(o));
    if (able.length === 0) return true;
    if (able.length === 1 && able[0].bet >= this.currentBet && this.inHandList().length > 1) {
      // единственный, кто может ходить, уже уравнял — торговаться не с кем
      const others = this.inHandList().filter(o => o !== able[0]);
      if (others.every(o => o.allin)) return true;
    }
    return this.players().every(o => !this.canAct(o) || (o.acted && o.bet === this.currentBet));
  }

  _checkRoundState(last) {
    const alive = this.inHandList();
    if (alive.length === 1) { this.pending = 'finish'; this.toAct = -1; return; }
    if (this._roundDone()) {
      const able = this.players().filter(o => this.canAct(o));
      this.toAct = -1;
      if (able.length <= 1) { this.phase = 'runout'; this.revealAll = true; }
      this.pending = this.street === 'river' ? 'finish' : 'street';
      return;
    }
    const from = last ? last.seat : this.toAct;
    this.toAct = this.nextSeat(from, o => this.canAct(o) && (!o.acted || o.bet < this.currentBet));
  }

  // Хост вызывает после паузы, когда pending установлен
  advance() {
    const what = this.pending;
    this.pending = null;
    if (what === 'finish') return this._finish();
    if (what !== 'street') return;
    for (const p of this.players()) { p.bet = 0; p.acted = false; p.raiseLocked = false; if (!p.folded && !p.allin) p.lastAction = ''; }
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
    const res = { handNo: this.handNo, winners: [], showdown: false, shown: {}, board: this.board.slice(), pots: [] };
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
        const sc = evaluate([...p.hole, ...this.board]);
        scores.set(p.id, sc);
        res.shown[p.id] = { hole: p.hole.slice(), hand: handName(sc), best: bestFive([...p.hole, ...this.board]) };
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
        // нечётная фишка — первому слева от дилера
        const order = winners.slice().sort((a, b) => ((a.seat - this.dealer - 1 + 64) % this.seats.length) - ((b.seat - this.dealer - 1 + 64) % this.seats.length));
        for (const w of order) { credit(w, share + (rem > 0 ? 1 : 0)); if (rem > 0) rem--; }
        res.pots.push({ amount, winners: winners.map(w => w.id) });
      }
    }
    for (const [id, amount] of won) {
      const p = this.byId(id);
      res.winners.push({ id, name: p.name, amount, hand: res.shown[id]?.hand || '' });
    }
    res.players = all.map(p => ({
      id: p.id, name: p.name, bot: p.bot, net: p.chips - p.startStack, vpip: p.vpip, pfr: p.pfr,
      won: won.has(p.id), showdown: res.showdown && !p.folded
    }));
    res.pot = res.pots.reduce((a, x) => a + x.amount, 0);
    for (const p of all) { p.total = 0; p.bet = 0; }
    this.departedPot = 0;
    this.lastResult = res;
    this.phase = 'over';
    this.toAct = -1;
    this.revealAll = res.showdown;
    this.emit({ t: 'result', result: res });
    if (this.s.mode === 'tournament') this._tourBusts(all);
    return res;
  }

  _tourBusts(all) {
    const busted = all.filter(p => p.chips <= 0 && !p.place).sort((a, b) => a.startStack - b.startStack);
    const remaining = this.players().filter(p => p.chips > 0).length;
    let place = remaining + busted.length;
    for (const p of busted) {
      p.place = place; p.out = true;
      this.places.push({ id: p.id, name: p.name, place, bot: p.bot });
      this.emit({ t: 'bust', id: p.id, name: p.name, place });
      place--;
    }
    const left = this.players().filter(p => p.chips > 0);
    if (left.length === 1) this._tourWinner(left[0]);
  }

  _tourWinner(p) {
    if (this.tourOver) return;
    p.place = 1;
    this.places.push({ id: p.id, name: p.name, place: 1, bot: p.bot });
    this.tourOver = true;
    this.emit({ t: 'tourover', id: p.id, name: p.name, places: this.places.slice().sort((a, b) => a.place - b.place) });
  }

  // ---------- проекция состояния для конкретного игрока ----------
  viewFor(id) {
    const showdownShown = this.lastResult?.shown || {};
    return {
      v: 1,
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
      level: this.levelIdx + 1,
      nextLevelAt: this.nextLevelAt(),
      turnStartedAt: this.turnStartedAt,
      tourOver: this.tourOver,
      places: this.places.slice().sort((a, b) => a.place - b.place),
      lastResult: this.lastResult,
      legal: this.legal(id),
      seats: this.seats.map(p => p && {
        id: p.id, name: p.name, bot: p.bot, seat: p.seat, chips: p.chips, bet: p.bet,
        folded: p.folded, allin: p.allin, inHand: p.inHand, out: p.out, connected: p.connected,
        lastAction: p.lastAction, buyins: p.buyins, place: p.place,
        hasCards: p.inHand && !p.folded && p.hole.length === 2,
        hole: (p.id === id || (this.revealAll && p.inHand && !p.folded) || showdownShown[p.id]) ? p.hole.slice() : null
      })
    };
  }
}
