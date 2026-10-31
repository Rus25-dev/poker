// История раздач и разбор решений: запись событий, моих решений, расчёт EV-ошибок
const KEY = 'rp_hand_history_v1';
const MAX = 40;

function load() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } }
function save(list) { try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch { /* */ } }

export class HandRecorder {
  constructor() { this.cur = null; }

  start(v) {
    const me = v.seats.find(s => s && s.id === v.you);
    this.cur = {
      handNo: v.handNo, at: Date.now(), variant: v.settings.variant, myId: v.you, bb: v.blinds[1],
      myHole: me && me.hole ? me.hole.slice() : [], startChips: me ? me.chips + me.bet : 0,
      players: v.seats.filter(Boolean).map(s => ({ id: s.id, name: s.name })), events: [], decisions: []
    };
  }

  event(e) {
    if (!this.cur) return;
    if (e.t === 'act') this.cur.events.push({ t: 'act', name: e.name, id: e.id, action: e.action, street: e.street });
    else if (e.t === 'street') this.cur.events.push({ t: 'street', street: e.street, board: e.board });
    else if (e.t === 'show') this.cur.events.push({ t: 'show', name: e.name, hole: e.hole });
  }

  // снимок перед моим действием
  decision(v, action, amount) {
    if (!this.cur || v.handNo !== this.cur.handNo) return;
    const me = v.seats.find(s => s && s.id === v.you);
    if (!me || !me.hole) return;
    const opps = v.seats.filter(s => s && s.inHand && !s.folded && s.id !== v.you).map(s => s.hist || []);
    this.cur.decisions.push({
      street: v.street, board: v.board.slice(), hole: me.hole.slice(), pot: v.pot, toCall: v.legal ? v.legal.toCall : 0,
      action, amount: amount || 0, opps, variant: v.settings.variant, bb: v.blinds[1], evIdx: this.cur.events.length
    });
  }

  finish(result, v) {
    if (!this.cur || result.handNo !== this.cur.handNo) return null;
    const me = v.seats.find(s => s && s.id === v.you);
    const rec = this.cur;
    rec.board = result.board.slice();
    rec.winners = result.winners.map(w => ({ name: w.name, amount: w.amount, desc: w.desc }));
    rec.shown = result.shown;
    rec.net = me ? me.chips - rec.startChips : 0;
    if (me && me.hole && me.hole.length) rec.myHole = me.hole.slice();
    this.cur = null;
    const list = load();
    list.unshift(rec);
    save(list);
    return rec;
  }

  update(rec) {
    const list = load();
    const i = list.findIndex(x => x.handNo === rec.handNo && x.at === rec.at);
    if (i >= 0) { list[i] = rec; save(list); }
  }
}

export function listHands() { return load(); }

// вердикт по решению с известным эквити
export function verdict(d, eq) {
  const potAfter = d.pot + d.toCall;
  const callEV = eq * potAfter - d.toCall;
  const thr = Math.max(d.bb, d.pot * 0.04);
  if (d.action === 'fold' && d.toCall > 0 && callEV > thr) return { kind: 'bad_fold', ev: Math.round(callEV) };
  if (d.action === 'call' && callEV < -thr) return { kind: 'bad_call', ev: Math.round(-callEV) };
  if (d.action === 'check' && eq > 0.72 && d.street !== 'preflop') return { kind: 'missed' };
  if ((d.action === 'raise' || d.action === 'allin') && eq < 0.3 && d.street !== 'preflop') return { kind: 'bluff' };
  if ((d.action === 'raise' || d.action === 'allin') && eq > 0.6) return { kind: 'value' };
  return { kind: 'ok' };
}
