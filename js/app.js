// Интерфейс: лобби, стол, подсказки, чат, статистика
import { cardLabel, rankOf, suitOf, RANK_RU, SUIT_SYM, evaluate, handName, CATEGORY_RU, cardFromStr } from './cards.js';
import { equity, outs, potOdds, preflopTier, advice, equityKnown } from './equity.js';
import { HostController, savedHostTable, clearSavedHostTable } from './host.js';
import { ClientController } from './client.js';
import { humanNetError } from './net.js';
import { BOT_STYLES } from './bot.js';
import { recordHand, recordTournament, getStats, resetStats } from './stats.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => (n ?? 0).toLocaleString('ru-RU');
const LS = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } }
};

const EMOJI = ['👍', '😂', '😎', '🤔', '😱', '😭', '🔥', '💪', '🙈', '🤡', '🍀', '💸', '🤝', '👏', '🥶', '😡'];
const QUICK = ['👍', '😂', '😱', '🔥', '🤡', '💸'];

// позиции мест (в % от области стола), 0 — я, далее по часовой; раскладка зависит от числа игроков
const P = { me: [50, 93], bl: [13, 72], l: [12, 46], tl: [14, 25], t: [50, 11], tr: [86, 25], r: [88, 46], br: [87, 72] };
const LAYOUT = {
  1: [P.me], 2: [P.me, P.t], 3: [P.me, P.tl, P.tr], 4: [P.me, P.l, P.t, P.r],
  5: [P.me, P.bl, P.tl, P.tr, P.br], 6: [P.me, P.bl, P.tl, P.t, P.tr, P.br]
};
// индекс места -> координаты с учётом того, кто сидит за столом
function seatPositions(v) {
  const me = v.seats.find(s => s && s.id === v.you);
  const n = v.seats.length, base = me ? me.seat : 0;
  const occ = [];
  for (let k = 0; k < n; k++) { const i = (base + k) % n; if (v.seats[i]) occ.push(i); }
  const lay = LAYOUT[Math.min(6, Math.max(1, occ.length))];
  const map = {};
  occ.forEach((i, k) => map[i] = lay[k] || P.t);
  return map;
}

const st = {
  ctl: null, view: null, prevView: null, clockOffset: 0,
  token: LS.get('rp_token', null) || (() => { const t = crypto.getRandomValues(new Uint32Array(4)).join('-'); LS.set('rp_token', t); return t; })(),
  name: LS.get('rp_name', ''),
  sound: LS.get('rp_sound', true),
  preAction: null, raiseOpen: false, raiseVal: 0,
  hintsKey: '', hintsData: null, showProbs: false,
  allinKey: '', allinEq: null,
  chatUnread: 0, drawer: null,
  log: [], chat: [], status: { kind: 'wait', text: '' },
  hostStyle: 'normal', wakeLock: null
};

// ---------- звук ----------
let actx = null;
function beep(freq = 660, dur = 0.08, type = 'sine', vol = 0.08, delay = 0) {
  if (!st.sound) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.value = freq;
    const t0 = actx.currentTime + delay;
    g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(actx.destination); o.start(t0); o.stop(t0 + dur + 0.02);
  } catch { /* звук недоступен */ }
}
const SND = {
  chip: () => { beep(1200, 0.04, 'triangle', 0.05); beep(1500, 0.04, 'triangle', 0.04, 0.05); },
  deal: () => beep(400, 0.05, 'square', 0.03),
  turn: () => { beep(880, 0.1, 'sine', 0.09); beep(1320, 0.12, 'sine', 0.08, 0.12); if (navigator.vibrate) navigator.vibrate([60, 40, 60]); },
  win: () => [523, 659, 784, 1046].forEach((f, i) => beep(f, 0.14, 'triangle', 0.08, i * 0.1)),
  fold: () => beep(220, 0.08, 'sine', 0.04)
};

// ---------- лобби ----------
function initLobby() {
  $('#inName').value = st.name;
  const params = new URLSearchParams(location.search);
  if (params.get('room')) $('#inCode').value = params.get('room').toUpperCase().slice(0, 5);
  const saved = savedHostTable();
  if (saved) { $('#restoreBox').classList.remove('hidden'); $('#restoreCode').textContent = saved.code; }
  $('#btnRestore').onclick = () => { if (!needName()) return; startHost({ restore: saved }); };
  $('#btnDropRestore').onclick = () => { clearSavedHostTable(); $('#restoreBox').classList.add('hidden'); };
  $('#btnCreate').onclick = () => { if (needName()) openCreate(false); };
  $('#btnTrain').onclick = () => { if (needName()) openCreate(true); };
  $('#btnJoin').onclick = () => {
    if (!needName()) return;
    const code = $('#inCode').value.trim().toUpperCase();
    if (code.length < 4) return toast('Введите код стола');
    startClient(code);
  };
  $('#inCode').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  $('#btnStatsLobby').onclick = openStats;
  $('#btnRulesLobby').onclick = openRules;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (!standalone) $('#installHint').classList.remove('hidden');
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    const b = $('#btnInstall'); b.classList.remove('hidden');
    b.onclick = () => { e.prompt(); b.classList.add('hidden'); };
  });
}

function needName() {
  const n = $('#inName').value.trim().slice(0, 16);
  if (!n) { toast('Введите имя'); $('#inName').focus(); return false; }
  st.name = n; LS.set('rp_name', n);
  return true;
}

function openCreate(offline) {
  const s = LS.get('rp_settings', { mode: 'cash', startChips: 2000, bb: 20, levelMinutes: 8, actionTimer: 30, hints: true });
  const blindOpts = [[5, 10], [10, 20], [25, 50], [50, 100]];
  modal(`
    <h2>${offline ? 'Тренировка с ботами' : 'Новый стол'}</h2>
    <div class="form-grid">
      <div class="full"><div class="seg" id="segMode">
        <button data-v="cash" class="${s.mode === 'cash' ? 'on' : ''}">Кэш-игра</button>
        <button data-v="tournament" class="${s.mode === 'tournament' ? 'on' : ''}">Турнир</button>
      </div></div>
      <div><label class="lbl">Стартовый стек</label>
        <select id="fChips">${[1000, 1500, 2000, 3000, 5000, 10000].map(v => `<option ${v === s.startChips ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div><label class="lbl">Блайнды</label>
        <select id="fBlinds">${blindOpts.map(([a, b]) => `<option value="${b}" ${b === s.bb ? 'selected' : ''}>${a} / ${b}</option>`).join('')}</select></div>
      <div id="fLevelWrap" class="${s.mode === 'tournament' ? '' : 'hidden'}"><label class="lbl">Рост блайндов, мин</label>
        <select id="fLevel">${[3, 5, 8, 10, 15, 20].map(v => `<option ${v === s.levelMinutes ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div><label class="lbl">Время на ход</label>
        <select id="fTimer">${[[0, 'без лимита'], [15, '15 с'], [30, '30 с'], [45, '45 с'], [60, '60 с']].map(([v, t]) => `<option value="${v}" ${v === s.actionTimer ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="full switch"><span>Подсказки силы руки и проценты</span><input type="checkbox" id="fHints" ${s.hints ? 'checked' : ''}></div>
      ${offline ? `<div><label class="lbl">Ботов</label><select id="fBots">${[1, 2, 3, 4, 5].map(v => `<option ${v === 3 ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div><label class="lbl">Характер ботов</label><select id="fBotStyle"><option value="mix">Смешанные</option>${Object.entries(BOT_STYLES).map(([k, b]) => `<option value="${k}">${b.name}</option>`).join('')}</select></div>` : ''}
      <button class="btn gold big full" id="fGo">${offline ? 'Играть' : 'Открыть стол'}</button>
    </div>`);
  let mode = s.mode;
  document.querySelectorAll('#segMode button').forEach(b => b.onclick = () => {
    mode = b.dataset.v;
    document.querySelectorAll('#segMode button').forEach(x => x.classList.toggle('on', x === b));
    $('#fLevelWrap').classList.toggle('hidden', mode !== 'tournament');
  });
  $('#fGo').onclick = () => {
    const bb = +$('#fBlinds').value;
    const settings = {
      mode, startChips: +$('#fChips').value, bb, sb: bb / 2,
      levelMinutes: +$('#fLevel').value, actionTimer: +$('#fTimer').value, hints: $('#fHints').checked
    };
    LS.set('rp_settings', settings);
    closeModal();
    if (offline) {
      const n = +$('#fBots')?.value || 3, style = $('#fBotStyle')?.value || 'mix';
      startHost({ settings, offline: true, bots: Array.from({ length: n }, (_, i) => style === 'mix' ? ['tight', 'normal', 'lag'][i % 3] : style) });
    } else startHost({ settings });
  };
}

function startHost({ settings, offline = false, restore = null, bots = [] }) {
  enterGame();
  st.ctl = new HostController({ name: st.name, token: st.token, settings, offline, restore }, UI);
  $('#roomCode').textContent = offline ? 'ОФЛАЙН' : st.ctl.code;
  if (offline) { bots.forEach(b => st.ctl.addBot(b)); setTimeout(() => st.ctl.start(), 400); }
  else st.ctl.sync();
}

function startClient(code) {
  enterGame();
  $('#roomCode').textContent = code;
  st.ctl = new ClientController({ name: st.name, token: st.token, code }, UI);
}

function enterGame() {
  $('#lobby').classList.add('hidden');
  $('#game').classList.remove('hidden');
  st.log = []; st.chat = []; st.view = null; st.prevView = null; st.preAction = null;
  requestWake();
}

function leaveGame() {
  if (st.ctl) {
    if (!st.ctl.isHost()) st.ctl.send({ t: 'leave' });
    else clearSavedHostTable();
    setTimeout(() => { st.ctl && st.ctl.destroy(); st.ctl = null; }, 200);
  }
  $('#game').classList.add('hidden');
  $('#lobby').classList.remove('hidden');
  closeModal(); closeDrawer();
  const saved = savedHostTable();
  $('#restoreBox').classList.toggle('hidden', !saved);
  history.replaceState(null, '', location.pathname);
}

async function requestWake() {
  try { if ('wakeLock' in navigator) st.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && st.ctl) requestWake(); });

// ---------- колбэки контроллера ----------
const UI = {
  onState(view) {
    st.prevView = st.view;
    st.view = view;
    st.clockOffset = view.now - Date.now();
    handleTransitions(st.prevView, view);
    render();
  },
  onMessage(msg) {
    if (msg.t === 'events') msg.list.forEach(onEvent);
    else if (msg.t === 'chat') addChat(msg);
    else if (msg.t === 'emoji') floatAt(msg.id, msg.e);
    else if (msg.t === 'error') toast(msg.msg);
  },
  onStatus(s) { st.status = s; const d = $('#netDot'); d.className = 'dot ' + s.kind; if (s.kind !== 'ok' || s.text) d.title = s.text; if (s.kind === 'err') toast(s.text); },
  onNetError(err) { toast(humanNetError(err)); UI.onStatus({ kind: 'err', text: humanNetError(err) }); if (st.ctl && !st.ctl.isHost() && !st.view) setTimeout(leaveGame, 1500); },
  onKicked() { toast('Хост убрал вас со стола'); setTimeout(leaveGame, 1200); },
  toast
};

function onEvent(e) {
  const v = st.view;
  switch (e.t) {
    case 'act': {
      addLog(`${e.name}: ${e.action}`);
      if (/Фолд/.test(e.action)) SND.fold(); else if (!/Чек/.test(e.action)) SND.chip();
      break;
    }
    case 'street': addLog(`— ${({ flop: 'Флоп', turn: 'Тёрн', river: 'Ривер' })[e.street]}: ${e.board.map(cardLabel).join(' ')}`); SND.deal(); break;
    case 'hand': addLog(`━━ Раздача №${e.handNo} ━━`); st.preAction = null; SND.deal(); break;
    case 'result': {
      const r = e.result;
      for (const w of r.winners) addLog(`🏆 ${w.name} +${fmt(w.amount)}${w.hand ? ' — ' + w.hand : ''}`);
      recordHand(r);
      if (v && r.winners.some(w => w.id === v.you)) SND.win();
      break;
    }
    case 'level': addLog(`⏫ Уровень ${e.level}: блайнды ${fmt(e.sb)}/${fmt(e.bb)}`); toast(`Блайнды растут: ${fmt(e.sb)} / ${fmt(e.bb)}`); break;
    case 'bust': addLog(`💀 ${e.name} выбывает — ${e.place} место`); break;
    case 'tourover':
      addLog(`👑 ${e.name} выигрывает турнир!`);
      recordTournament(e.places);
      setTimeout(() => showTourOver(e.places), 1500);
      break;
    case 'join': addLog(`${e.name} за столом`); break;
    case 'leave': addLog(`${e.name} ушёл`); break;
    case 'rebuy': addLog(`${e.name} докупился`); break;
  }
}

function handleTransitions(prev, v) {
  const me = mySeatObj(v);
  if (!me) return;
  const myTurn = v.legal && v.toAct === me.seat;
  const wasMyTurn = prev && prev.legal && prev.toAct === me.seat && prev.handNo === v.handNo;
  if (myTurn && !wasMyTurn) {
    st.raiseOpen = false;
    // заранее выбранное действие
    if (st.preAction) {
      const pa = st.preAction; st.preAction = null;
      if (pa === 'checkfold') return setTimeout(() => act(v.legal.canCheck ? 'check' : 'fold'), 150);
      if (pa === 'check' && v.legal.canCheck) return setTimeout(() => act('check'), 150);
      if (pa === 'callany') return setTimeout(() => act(v.legal.canCheck ? 'check' : 'call'), 150);
    }
    SND.turn();
  }
  if (prev && prev.currentBet !== v.currentBet && st.preAction === 'check') st.preAction = null;
}

function mySeatObj(v = st.view) { return v && v.seats.find(s => s && s.id === v.you) || null; }

function act(type, amount) {
  st.raiseOpen = false;
  st.ctl.send({ t: 'act', type, amount });
}

// ---------- отрисовка ----------
function cardHTML(c, cls = '', hl = false) {
  if (c == null) return `<div class="card back ${cls}"></div>`;
  const red = suitOf(c) === 1 || suitOf(c) === 2;
  return `<div class="card ${red ? 'red' : ''} ${cls} ${hl ? 'hl' : ''}"><span class="r">${RANK_RU[rankOf(c)]}</span><span class="s">${SUIT_SYM[suitOf(c)]}</span></div>`;
}

function render() {
  const v = st.view; if (!v) return;
  const me = mySeatObj(v);
  const base = me ? me.seat : 0;
  const n = v.seats.length;
  const rel = i => (i - base + n) % n;
  const posMap = seatPositions(v);
  const posOf = i => posMap[i] || P.t;
  const lr = v.lastResult && v.phase === 'over' ? v.lastResult : null;
  const winners = new Set(lr ? lr.winners.map(w => w.id) : []);
  const bestCards = new Set();
  if (lr && lr.showdown) for (const w of lr.winners) (lr.shown[w.id]?.best || []).forEach(c => bestCards.add(c));

  // блайнды и уровень
  const lvl = v.settings.mode === 'tournament' ? `Ур. ${v.level} · ` : '';
  $('#blindsInfo').innerHTML = `<b>${fmt(v.blinds[0])} / ${fmt(v.blinds[1])}</b><br><span id="lvlTimer">${lvl}${v.settings.mode === 'tournament' ? '' : 'кэш'}</span>`;

  // места
  let html = '';
  const allinEq = computeAllinEq(v);
  for (let i = 0; i < n; i++) {
    const p = v.seats[i];
    if (!p) continue;
    const [x, y] = posOf(i);
    const isMe = p.id === v.you;
    const cls = ['seat', isMe ? 'me' : '', v.toAct === i ? 'turn' : '', winners.has(p.id) ? 'win' : '', p.inHand && p.folded && v.phase !== 'idle' ? 'folded' : '', p.out ? 'out' : '', p.connected === false && !p.bot ? 'off' : ''].join(' ');
    let actCls = '';
    if (/Фолд/.test(p.lastAction)) actCls = 'fold'; else if (/Олл/.test(p.lastAction)) actCls = 'allin'; else if (/Рейз|Бет/.test(p.lastAction)) actCls = 'raise';
    const cards = p.hole ? p.hole.map(c => cardHTML(c, 'sm', bestCards.has(c))).join('') : (p.hasCards ? cardHTML(null, 'sm') + cardHTML(null, 'sm') : '');
    const shownHand = lr && lr.shown[p.id] ? `<div class="hand">${esc(lr.shown[p.id].hand)}</div>` : '';
    const winAmt = lr ? lr.winners.find(w => w.id === p.id) : null;
    const eqBadge = allinEq && allinEq[p.id] != null ? `<div class="eq">${Math.round(allinEq[p.id] * 100)}%</div>` : '';
    const timer = v.toAct === i && v.settings.actionTimer > 0 && !p.bot ? `<svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="none" stroke="var(--yellow)" stroke-width="3" stroke-dasharray="100.5" stroke-dashoffset="0" class="tring"/></svg>` : '';
    const label = p.bot ? '🤖' : esc(p.name.slice(0, 1).toUpperCase());
    const chipsTxt = p.out && v.settings.mode === 'tournament' ? (p.place ? `${p.place} место` : 'зритель') : fmt(p.chips);
    html += `<div class="${cls}" data-id="${esc(p.id)}" style="left:${x}%;top:${y}%">
      ${p.lastAction && v.phase !== 'idle' ? `<div class="act ${actCls}">${esc(p.lastAction)}</div>` : ''}
      <div class="ava">${label}${timer}</div>${eqBadge}
      <div class="plate"><div class="nm">${esc(p.name)}</div><div class="ch">${winAmt ? '+' + fmt(winAmt.amount) : chipsTxt}</div></div>
      <div class="cards">${cards}</div>${shownHand}
    </div>`;
    // ставка
    if (p.bet > 0) {
      const bx = x + (50 - x) * 0.42, by = y + (50 - y) * 0.42;
      html += `<div class="bet" style="left:${bx}%;top:${by}%"><span class="chipico"></span>${fmt(p.bet)}</div>`;
    }
    if (i === v.dealer && v.handNo) {
      const dx = x + (50 - x) * 0.28 + (rel(i) === 0 ? 14 : 0), dy = y + (50 - y) * 0.28;
      html += `<div class="dealer-btn" style="left:${dx}%;top:${dy}%">D</div>`;
    }
  }
  $('#seats').innerHTML = html;
  bindSeatTaps();

  // доска
  const handLive = v.phase === 'betting' || v.phase === 'runout' || v.phase === 'over';
  let bh = '';
  for (let k = 0; k < 5; k++) {
    const c = v.board[k];
    bh += c != null ? cardHTML(c, '', bestCards.has(c)) : (handLive && v.handNo ? `<div class="card empty"></div>` : '');
  }
  $('#board').innerHTML = bh;
  $('#potInfo').innerHTML = v.handNo && v.phase !== 'idle' ? `Банк: ${fmt(lr ? lr.pot : v.pot)}` : '';

  // сообщение в центре
  let msg = '';
  if (v.tourOver) msg = `<span class="win">👑 Турнир окончен: ${esc(v.places[0]?.name || '')}</span>`;
  else if (lr) {
    msg = lr.winners.map(w => `<span class="win">${esc(w.name)} +${fmt(w.amount)}</span>${w.hand ? '<br>' + esc(w.hand) : ''}`).join('<br>');
  } else if (!v.handNo || v.phase === 'idle') {
    const cnt = v.seats.filter(Boolean).length;
    msg = st.ctl?.isHost() ? `Игроков за столом: ${cnt}. ${v.handNo ? 'Ожидание…' : 'Позовите друзей по коду или добавьте ботов'}` : 'Ожидание раздачи…';
  } else if (v.phase === 'runout') msg = 'Олл-ин! Открываем карты';
  $('#centerMsg').innerHTML = msg;

  renderMine(v, me);
  renderActions(v, me);
}

function bindSeatTaps() {
  document.querySelectorAll('#seats .seat').forEach(el => {
    el.onclick = () => {
      const p = st.view.seats.find(s => s && s.id === el.dataset.id);
      if (!p) return;
      const host = st.ctl?.isHost();
      const canKick = host && p.id !== st.view.you;
      modal(`<h2>${esc(p.name)}</h2>
        <p>${p.bot ? 'Бот: ' + esc(BOT_STYLES[p.bot]?.name || '') : (p.connected === false ? 'Отключён' : 'В сети')} · фишки ${fmt(p.chips)}${v_mode() === 'cash' ? ` · закупов: ${p.buyins}` : ''}</p>
        ${statLine(p.name)}
        ${canKick ? `<button class="btn red big" id="kickBtn">${p.bot ? 'Убрать бота' : 'Убрать со стола'}</button>` : ''}`);
      if (canKick) $('#kickBtn').onclick = () => { st.ctl.removeSeat(p.id); closeModal(); };
    };
  });
}
const v_mode = () => st.view?.settings.mode;

function statLine(name) {
  const s = getStats().players.find(x => x.name === name);
  if (!s) return '<p class="hint">Статистики пока нет</p>';
  return `<p class="hint">Рейтинг ${s.rating} · раздач ${s.hands} · VPIP ${s.vpipPct}% · PFR ${s.pfrPct}% · ${s.style}</p>`;
}

function renderMine(v, me) {
  const box = $('#myCards');
  if (!me) { box.innerHTML = '<div class="me-info">Вы наблюдаете</div>'; $('#hints').innerHTML = ''; return; }
  const myTurn = v.legal && v.toAct === me.seat;
  box.classList.toggle('turn', !!myTurn);
  const lr = v.phase === 'over' ? v.lastResult : null;
  const best = new Set(lr && lr.shown[me.id] ? lr.shown[me.id].best : []);
  const cards = me.hole && me.hole.length ? me.hole.map(c => cardHTML(c, 'lg' + (me.folded ? ' dim' : ''), best.has(c))).join('') : `<div class="card lg empty"></div><div class="card lg empty"></div>`;
  const dealer = v.dealer === me.seat ? ' · D' : v.sbSeat === me.seat && v.handNo ? ' · МБ' : v.bbSeat === me.seat && v.handNo ? ' · ББ' : '';
  box.innerHTML = `<div class="pair">${cards}</div><div class="me-info"><b>${fmt(me.chips)}</b>${me.bet ? ` · ставка ${fmt(me.bet)}` : ''}${dealer}</div>`;
  renderHints(v, me);
}

// ---------- подсказки ----------
function renderHints(v, me) {
  const el = $('#hints');
  if (!v.settings.hints) { el.innerHTML = '<div class="hints-off">Подсказки выключены хостом</div>'; return; }
  if (!me.hole || me.hole.length < 2 || !me.inHand) {
    el.innerHTML = `<div class="hints-off">${me.out ? (v.settings.mode === 'cash' ? 'Фишки закончились' : 'Вы выбыли') : 'Ждём раздачу — здесь появятся сила руки и проценты'}</div>`;
    return;
  }
  const opp = v.seats.filter(s => s && s.inHand && !s.folded && s.id !== me.id).length;
  const key = me.hole.join(',') + '|' + v.board.join(',') + '|' + opp;
  if (key !== st.hintsKey) {
    st.hintsKey = key;
    st.hintsData = null;
    setTimeout(() => {
      if (st.hintsKey !== key) return;
      const e = equity(me.hole, v.board, Math.max(1, opp), v.board.length ? 3000 : 2500);
      const o = outs(me.hole, v.board);
      st.hintsData = { e, o, key };
      if (st.view) renderHints(st.view, mySeatObj(st.view));
    }, 20);
  }
  const d = st.hintsData && st.hintsData.key === key ? st.hintsData : null;
  const toCall = v.legal ? v.legal.toCall : Math.max(0, v.currentBet - me.bet);
  let h = '';
  if (v.board.length === 0) {
    const t = preflopTier(me.hole);
    h += `<div class="hand-now">Префлоп: <span class="tier ${t.color}">${t.tier}</span> <small style="color:var(--mut)">(Чен ${t.score})</small></div>`;
  } else {
    const sc = evaluate([...me.hole, ...v.board]);
    h += `<div class="hand-now">${esc(handName(sc))}</div>`;
  }
  if (d) {
    const w = Math.round(d.e.win * 100), t = Math.round(d.e.tie * 100);
    h += `<div class="line"><span>Шанс выиграть vs ${opp} ${opp === 1 ? 'соперника' : 'соперников'}</span><b>${(d.e.equity * 100).toFixed(1)}%</b></div>`;
    h += `<div class="eqbar"><i class="w" style="width:${w}%"></i><i class="t" style="width:${t}%"></i></div>`;
    if (v.board.length >= 3 && v.board.length < 5 && d.o.count) {
      const left = 52 - 2 - v.board.length;
      const next = d.o.count / left;
      const toRiver = v.board.length === 3 ? 1 - (1 - d.o.count / left) * (1 - d.o.count / (left - 1)) : next;
      h += `<div class="line"><span>Ауты: ${d.o.count}</span><b>${Math.round(next * 100)}% след. карта${v.board.length === 3 ? ` · ${Math.round(toRiver * 100)}% к риверу` : ''}</b></div>`;
    }
    if (toCall > 0) {
      const need = potOdds(toCall, v.pot);
      h += `<div class="line"><span>Колл ${fmt(toCall)} в банк ${fmt(v.pot)}</span><b>нужно ≥ ${Math.round(need * 100)}%</b></div>`;
    }
    if (!me.allin && !me.folded) {
      const a = advice(d.e.equity, toCall, v.pot, opp + 1);
      h += `<div class="adv ${a.kind}">${a.text}</div>`;
    }
    if (v.board.length < 5) {
      h += `<div class="more" id="tglProbs">${st.showProbs ? '▲ скрыть' : '▼ шансы комбинаций к риверу'}</div>`;
      if (st.showProbs) {
        h += '<div class="probs">' + d.e.categories.map((p, i) => p > 0.0005 ? `<span>${CATEGORY_RU[i]}</span><i style="width:${Math.max(1, p * 100)}%"></i><span>${(p * 100).toFixed(1)}%</span>` : '').reverse().join('') + '</div>';
      }
    }
  } else h += '<div class="line"><span>Считаю шансы…</span></div>';
  el.innerHTML = h;
  const tg = $('#tglProbs');
  if (tg) tg.onclick = () => { st.showProbs = !st.showProbs; renderHints(st.view, mySeatObj(st.view)); };
}

// эквити всех открытых рук при олл-ине — как в телетрансляции
function computeAllinEq(v) {
  if (!v.settings.hints || v.phase !== 'runout') { st.allinKey = ''; return null; }
  const ps = v.seats.filter(s => s && s.inHand && !s.folded && s.hole);
  if (ps.length < 2 || v.board.length >= 5) return null;
  const key = ps.map(p => p.hole.join(',')).join('|') + '#' + v.board.join(',');
  if (key !== st.allinKey) {
    st.allinKey = key;
    const eq = equityKnown(ps.map(p => p.hole), v.board);
    st.allinEq = {};
    ps.forEach((p, i) => st.allinEq[p.id] = eq[i]);
  }
  return st.allinEq;
}

// ---------- кнопки действий ----------
function renderActions(v, me) {
  const el = $('#actions');
  const host = st.ctl?.isHost();
  // турнир закончен
  if (v.tourOver) {
    el.innerHTML = host ? `<div class="row"><button class="btn gold" id="aNewTour">🔁 Новый турнир</button><button class="btn ghost" id="aPlaces">🏆 Итоги</button></div>` : `<div class="row"><button class="btn ghost" id="aPlaces">🏆 Итоги турнира</button></div>`;
    if ($('#aNewTour')) $('#aNewTour').onclick = () => st.ctl.newTournament();
    $('#aPlaces').onclick = () => showTourOver(v.places);
    return;
  }
  // до старта: комната ожидания
  if (!v.handNo || (v.phase === 'idle' && host && !st.ctl.started)) {
    if (host) {
      el.innerHTML = `<div class="row">
          <select id="aBotStyle" style="flex:1.3">${Object.entries(BOT_STYLES).map(([k, b]) => `<option value="${k}" ${k === st.hostStyle ? 'selected' : ''}>${b.name}</option>`).join('')}</select>
          <button class="btn ghost" id="aAddBot">＋ Бот</button>
        </div>
        <div class="row"><button class="btn ghost" id="aShare">🔗 Пригласить</button><button class="btn gold" id="aStart">▶ Начать игру</button></div>`;
      $('#aBotStyle').onchange = e => st.hostStyle = e.target.value;
      $('#aAddBot').onclick = () => st.ctl.addBot(st.hostStyle);
      $('#aStart').onclick = () => st.ctl.start();
      $('#aShare').onclick = share;
    } else el.innerHTML = `<div class="wait-msg">Вы за столом. Ждём, пока хост начнёт игру…</div>`;
    return;
  }
  if (!me) { el.innerHTML = '<div class="wait-msg">Режим наблюдения</div>'; return; }
  // нет фишек
  if (me.chips <= 0 && !me.inHand || me.out) {
    if (v.settings.mode === 'cash') {
      el.innerHTML = `<button class="btn gold big" id="aRebuy">💰 Докупиться (${fmt(v.settings.startChips)})</button>`;
      $('#aRebuy').onclick = () => st.ctl.send({ t: 'rebuy' });
    } else el.innerHTML = `<div class="wait-msg">Вы выбыли${me.place ? ` — ${me.place} место` : ''}. Смотрите, кто победит!</div>`;
    return;
  }
  const L = v.legal;
  if (L && v.toAct === me.seat) {
    if (st.raiseOpen && L.canRaise) return renderRaise(v, L);
    const callTxt = L.canCheck ? 'Чек' : (L.toCall >= me.chips ? `Олл-ин ${fmt(L.toCall)}` : `Колл ${fmt(L.toCall)}`);
    const raiseTxt = L.currentBet === 0 ? 'Бет' : 'Рейз';
    el.innerHTML = `<div class="row">
      <button class="btn red" id="aFold">Фолд</button>
      <button class="btn green" id="aCall">${callTxt}</button>
      ${L.canRaise ? `<button class="btn gold" id="aRaise">${raiseTxt}</button>` : ''}
    </div>`;
    $('#aFold').onclick = () => {
      if (L.canCheck) { if (!confirm('Можно бесплатно чекнуть. Всё равно сбросить?')) return; }
      act('fold');
    };
    $('#aCall').onclick = () => act(L.canCheck ? 'check' : 'call');
    if (L.canRaise) $('#aRaise').onclick = () => { st.raiseOpen = true; st.raiseVal = L.minTo; renderActions(st.view, mySeatObj()); };
    return;
  }
  // не мой ход — предварительные действия
  if (me.inHand && !me.folded && !me.allin && (v.phase === 'betting')) {
    const pa = st.preAction;
    el.innerHTML = `<div class="pre-acts">
      <label><input type="checkbox" data-pa="checkfold" ${pa === 'checkfold' ? 'checked' : ''}> Чек/Фолд</label>
      <label><input type="checkbox" data-pa="check" ${pa === 'check' ? 'checked' : ''}> Чек</label>
      <label><input type="checkbox" data-pa="callany" ${pa === 'callany' ? 'checked' : ''}> Колл любой</label>
    </div>`;
    el.querySelectorAll('input[data-pa]').forEach(i => i.onchange = () => {
      st.preAction = i.checked ? i.dataset.pa : null;
      renderActions(st.view, mySeatObj());
    });
    return;
  }
  let txt = 'Ждём следующую раздачу…';
  if (me.allin && me.inHand && v.phase !== 'over') txt = 'Вы в олл-ине — удачи! 🍀';
  else if (me.folded && v.phase !== 'over' && me.inHand) txt = 'Вы сбросили карты';
  if (host && st.ctl.paused) txt = 'Пауза. Продолжить можно в меню ☰';
  el.innerHTML = `<div class="wait-msg">${txt}</div>`;
}

function renderRaise(v, L) {
  const el = $('#actions');
  const pot = L.pot + L.toCall; // банк после колла
  const clamp = x => Math.max(L.minTo, Math.min(L.maxTo, Math.round(x)));
  const presets = [
    ['Мин', L.minTo], ['½ банка', clamp(L.currentBet + pot / 2)], ['¾', clamp(L.currentBet + pot * 0.75)],
    ['Банк', clamp(L.currentBet + pot)], ['Олл-ин', L.maxTo]
  ];
  if (v.street === 'preflop' && L.currentBet <= v.blinds[1]) {
    presets[1] = ['2.5 ББ', clamp(v.blinds[1] * 2.5)]; presets[2] = ['3 ББ', clamp(v.blinds[1] * 3)];
  }
  const step = Math.max(1, v.blinds[0]);
  st.raiseVal = clamp(st.raiseVal);
  const allin = st.raiseVal >= L.maxTo;
  el.innerHTML = `<div class="raise-box">
    <div class="amt">${allin ? 'Олл-ин ' : (L.currentBet === 0 ? 'Бет ' : 'Рейз до ')}${fmt(st.raiseVal)}</div>
    <div class="row" style="gap:6px">
      <button class="btn ghost sm" id="rMinus" style="flex:none;width:44px">−</button>
      <input type="range" id="rSlider" min="${L.minTo}" max="${L.maxTo}" step="${step}" value="${st.raiseVal}">
      <button class="btn ghost sm" id="rPlus" style="flex:none;width:44px">+</button>
    </div>
    <div class="presets">${presets.map(([t, val]) => `<button class="btn ghost" data-v="${val}">${t}</button>`).join('')}</div>
    <div class="row"><button class="btn ghost" id="rBack">Назад</button><button class="btn gold" id="rGo">${allin ? 'Олл-ин!' : 'Подтвердить'}</button></div>
  </div>`;
  const upd = val => { st.raiseVal = clamp(val); renderRaise(st.view, st.view.legal); };
  $('#rSlider').oninput = e => { st.raiseVal = clamp(+e.target.value); el.querySelector('.amt').textContent = (st.raiseVal >= L.maxTo ? 'Олл-ин ' : (L.currentBet === 0 ? 'Бет ' : 'Рейз до ')) + fmt(st.raiseVal); $('#rGo').textContent = st.raiseVal >= L.maxTo ? 'Олл-ин!' : 'Подтвердить'; };
  $('#rMinus').onclick = () => upd(st.raiseVal - step * 2);
  $('#rPlus').onclick = () => upd(st.raiseVal + step * 2);
  el.querySelectorAll('.presets .btn').forEach(b => b.onclick = () => upd(+b.dataset.v));
  $('#rBack').onclick = () => { st.raiseOpen = false; renderActions(st.view, mySeatObj()); };
  $('#rGo').onclick = () => act(st.raiseVal >= L.maxTo ? 'allin' : 'raise', st.raiseVal);
}

// ---------- таймеры (кольцо хода, уровень блайндов) ----------
setInterval(() => {
  const v = st.view; if (!v) return;
  const now = Date.now() + st.clockOffset;
  const ring = document.querySelector('.tring');
  if (ring && v.settings.actionTimer > 0 && v.toAct >= 0) {
    const frac = Math.min(1, (now - v.turnStartedAt) / (v.settings.actionTimer * 1000));
    ring.setAttribute('stroke-dashoffset', String(100.5 * frac));
    ring.setAttribute('stroke', frac > 0.75 ? 'var(--red)' : 'var(--yellow)');
  }
  const lt = $('#lvlTimer');
  if (lt && v.settings.mode === 'tournament' && v.nextLevelAt && !v.tourOver) {
    const left = Math.max(0, v.nextLevelAt - now);
    const m = Math.floor(left / 60000), s = Math.floor(left / 1000) % 60;
    lt.textContent = `Ур. ${v.level} · ${m}:${String(s).padStart(2, '0')}`;
  }
}, 250);

// ---------- чат, лог, эмодзи ----------
function addChat(m) {
  st.chat.push(m);
  if (st.chat.length > 200) st.chat.shift();
  if (!m.sys && m.id !== st.view?.you) {
    floatAt(m.id, m.text, true);
    if (st.drawer !== 'chat') { st.chatUnread++; const b = $('#chatBadge'); b.textContent = st.chatUnread; b.classList.remove('hidden'); }
  }
  if (st.drawer === 'chat') renderChat();
}
function addLog(t) { st.log.push(t); if (st.log.length > 300) st.log.shift(); if (st.drawer === 'log') renderLog(); }
function renderChat() {
  const el = $('#chatList');
  el.innerHTML = st.chat.map(m => m.sys ? `<div class="m sys">${esc(m.text)}</div>` : `<div class="m ${m.id === st.view?.you ? 'me' : ''}"><b>${esc(m.name)}:</b> ${esc(m.text)}</div>`).join('') || '<div class="m sys">Сообщений пока нет</div>';
  el.scrollTop = el.scrollHeight;
}
function renderLog() { const el = $('#logList'); el.innerHTML = st.log.map(t => `<div class="m">${esc(t)}</div>`).join(''); el.scrollTop = el.scrollHeight; }

function openDrawer(kind) {
  st.drawer = kind;
  $('#drawer').classList.remove('hidden');
  $('#drawerTitle').textContent = kind === 'chat' ? 'Чат стола' : 'Ход игры';
  $('#chatList').classList.toggle('hidden', kind !== 'chat');
  $('#logList').classList.toggle('hidden', kind !== 'log');
  $('#chatForm').classList.toggle('hidden', kind !== 'chat');
  $('#emojiRow').classList.toggle('hidden', kind !== 'chat');
  if (kind === 'chat') { st.chatUnread = 0; $('#chatBadge').classList.add('hidden'); renderChat(); } else renderLog();
}
function closeDrawer() { st.drawer = null; $('#drawer').classList.add('hidden'); }

function floatAt(id, content, isMsg = false) {
  const v = st.view; if (!v) return;
  let x = 50, y = 80;
  const me = mySeatObj(v);
  const p = v.seats.find(s => s && s.id === id);
  if (p) {
    [x, y] = seatPositions(v)[p.seat] || P.t;
    if (p.id === v.you) y = 82;
  }
  const f = document.createElement('div');
  f.className = 'floater' + (isMsg ? ' msg' : '');
  f.style.left = x + '%'; f.style.top = (y - 6) + '%';
  f.textContent = isMsg ? String(content).slice(0, 80) : content;
  $('#floaters').appendChild(f);
  setTimeout(() => f.remove(), isMsg ? 3600 : 2300);
}

function sendEmoji(e) { st.ctl && st.ctl.send({ t: 'emoji', e }); }

// ---------- окна ----------
function modal(html) { $('#modalBody').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); }
let toastT = null;
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), 3000); }

function share() {
  if (!st.ctl || st.ctl.offline) return toast('В тренировке приглашать некого 🙂');
  const code = st.ctl.isHost() ? st.ctl.code : st.ctl.code;
  const url = `${location.origin}${location.pathname}?room=${code}`;
  const text = `Залетай в покер! Код стола: ${code}`;
  if (navigator.share) navigator.share({ title: 'Покер с друзьями', text, url }).catch(() => {});
  else navigator.clipboard?.writeText(`${text}\n${url}`).then(() => toast('Ссылка скопирована'), () => toast(`Код: ${code}`));
}

function openMenu() {
  const host = st.ctl?.isHost();
  modal(`<h2>Меню</h2><div class="menu-list">
    <button class="btn ghost" id="mShare">🔗 Пригласить друзей (код ${esc($('#roomCode').textContent)})</button>
    <button class="btn ghost" id="mStats">📊 Рейтинг и статистика</button>
    <button class="btn ghost" id="mRules">🃏 Комбинации и правила</button>
    <button class="btn ghost" id="mSound">${st.sound ? '🔊 Звук: вкл' : '🔇 Звук: выкл'}</button>
    ${host && st.ctl.started ? `<button class="btn ghost" id="mPause">${st.ctl.paused ? '▶ Продолжить игру' : '⏸ Пауза после раздачи'}</button>` : ''}
    ${host ? `<button class="btn ghost" id="mBot">🤖 Добавить бота</button>` : ''}
    <button class="btn red" id="mLeave">🚪 ${host ? 'Закрыть стол' : 'Покинуть стол'}</button>
  </div>`);
  $('#mShare').onclick = share;
  $('#mStats').onclick = openStats;
  $('#mRules').onclick = openRules;
  $('#mSound').onclick = () => { st.sound = !st.sound; LS.set('rp_sound', st.sound); openMenu(); };
  if ($('#mPause')) $('#mPause').onclick = () => { st.ctl.togglePause(); closeModal(); };
  if ($('#mBot')) $('#mBot').onclick = () => { st.ctl.addBot(st.hostStyle); closeModal(); };
  $('#mLeave').onclick = () => { if (confirm(host ? 'Закрыть стол для всех?' : 'Покинуть стол?')) leaveGame(); };
}

function openStats() {
  const { players, tournaments } = getStats();
  const rows = players.map((p, i) => `<tr><td>${i + 1}</td><td>${p.bot ? '🤖 ' : ''}${esc(p.name)}</td><td>${p.rating}</td><td>${p.hands}</td><td>${p.winPct}%</td><td>${p.vpipPct}/${p.pfrPct}</td><td class="${p.net >= 0 ? 'pos' : 'neg'}">${p.net >= 0 ? '+' : ''}${fmt(p.net)}</td><td>${p.tourWins}/${p.tours}</td></tr>`).join('');
  modal(`<h2>Рейтинг</h2>
    ${players.length ? `<div style="overflow-x:auto"><table class="stats"><tr><th>#</th><th>Игрок</th><th>Эло</th><th>Разд.</th><th>Побед</th><th>VPIP/PFR</th><th>Фишки</th><th>Турн.</th></tr>${rows}</table></div>
    <p class="hint">Эло — рейтинг по турнирам (старт 1500). VPIP — как часто добровольно входит в банк, PFR — как часто рейзит до флопа. Фишки — итог в кэш-играх.</p>
    <h3>Стили игры</h3>${players.filter(p => p.hands >= 20).map(p => `<div class="hint" style="text-align:left">${esc(p.name)}: ${p.style}, выигрыш на вскрытии ${p.sdPct}%, крупнейший банк ${fmt(p.biggestPot)}</div>`).join('') || '<p class="hint">Нужно сыграть от 20 раздач</p>'}
    ${tournaments.length ? `<h3>Последние турниры</h3>${tournaments.slice(0, 8).map(t => `<div class="hint" style="text-align:left">${new Date(t.at).toLocaleDateString('ru-RU')}: ${t.places.slice(0, 3).map(p => `${p.place}. ${esc(p.name)}`).join(', ')}</div>`).join('')}` : ''}
    <button class="btn ghost" id="sReset" style="margin-top:12px">Сбросить статистику на этом телефоне</button>` : '<p class="hint">Пока пусто — сыграйте пару раздач.</p>'}`);
  if ($('#sReset')) $('#sReset').onclick = () => { if (confirm('Сбросить всю статистику?')) { resetStats(); openStats(); } };
}

function openRules() {
  const ex = [
    ['Роял-флеш', 'As Ks Qs Js Ts', 0.000032], ['Стрит-флеш', '9h 8h 7h 6h 5h', 0.000279], ['Каре', 'Qc Qd Qh Qs 7d', 0.00168],
    ['Фулл-хаус', 'Kd Kc Kh 4s 4d', 0.026], ['Флеш', 'Ad Jd 8d 5d 2d', 0.0303], ['Стрит', 'Tc 9d 8s 7h 6c', 0.0462],
    ['Сет', '7c 7d 7h Ks 2d', 0.0483], ['Две пары', 'Jc Jd 4h 4s Ad', 0.235], ['Пара', 'Th Td Ac 8s 3d', 0.438], ['Старшая карта', 'Ac Qd 9h 6s 3c', 0.174]
  ];
  modal(`<h2>Комбинации (от старшей)</h2><div class="rank-list">${ex.map(([n, cs, p]) => `<div class="rank-item"><div class="cards-mini">${cs.split(' ').map(s => cardHTML(cardFromStr(s), 'sm')).join('')}</div><div><div class="nm">${n}</div><div class="pr">≈ ${(p * 100).toFixed(p < 0.001 ? 4 : 1)}% на 7 картах</div></div></div>`).join('')}</div>
  <h3>Коротко о правилах</h3>
  <p class="hint" style="text-align:left">Каждому сдаётся 2 карты, на стол выходят 5 общих (флоп — 3, тёрн — 1, ривер — 1). Собирается лучшая пятёрка из 7 карт. Торговля идёт до флопа и на каждой улице: фолд, чек, колл, бет/рейз, олл-ин. Если остаётся один игрок — он забирает банк без вскрытия.</p>
  <h3>Как читать подсказки</h3>
  <p class="hint" style="text-align:left">«Шанс выиграть» — доля банка, которую рука забирает в среднем против случайных карт активных соперников (метод Монте-Карло, тысячи симуляций). «Нужно ≥ X%» — шансы банка: если ваш шанс выше, колл окупается на дистанции. Ауты — карты, которые улучшат вашу комбинацию.</p>`);
}

function showTourOver(places) {
  modal(`<h2>🏆 Итоги турнира</h2><ol class="places">${places.map(p => `<li>${esc(p.name)} — ${p.place} место</li>`).join('')}</ol>
    <p class="hint">Рейтинг Эло обновлён — смотрите «Рейтинг».</p>`);
}

// ---------- привязка кнопок ----------
function initGameUI() {
  $('#btnMenu').onclick = openMenu;
  $('#btnCode').onclick = share;
  $('#btnChat').onclick = () => openDrawer('chat');
  $('#btnLog').onclick = () => openDrawer('log');
  $('#drawerClose').onclick = closeDrawer;
  $('#modalClose').onclick = closeModal;
  $('#modal').onclick = e => { if (e.target.id === 'modal') closeModal(); };
  $('#quickEmoji').innerHTML = QUICK.map(e => `<button>${e}</button>`).join('');
  $('#quickEmoji').onclick = e => { if (e.target.tagName === 'BUTTON') sendEmoji(e.target.textContent); };
  $('#emojiRow').innerHTML = EMOJI.map(e => `<button>${e}</button>`).join('');
  $('#emojiRow').onclick = e => { if (e.target.tagName === 'BUTTON') { sendEmoji(e.target.textContent); } };
  $('#chatForm').onsubmit = e => {
    e.preventDefault();
    const t = $('#chatIn').value.trim();
    if (t && st.ctl) st.ctl.send({ t: 'chat', text: t });
    $('#chatIn').value = '';
  };
  window.addEventListener('beforeunload', e => { if (st.ctl && st.ctl.isHost() && !st.ctl.offline && st.ctl.started) { e.preventDefault(); e.returnValue = ''; } });
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

initLobby();
initGameUI();
// для отладки в консоли
window.__poker = st;
