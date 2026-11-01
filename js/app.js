// Интерфейс: лобби, стол, подсказки, тренер, разбор раздач, настройки
import { rankOf, suitOf, SUIT_SYM, evalHand, handDesc, CATEGORY_RU, cardFromStr } from './cards.js';
import { equity, outs, potOdds, preflopTier, advice, coach, profileFromHist, equityKnown } from './equity.js';
import { HostController, savedHostTable, clearSavedHostTable } from './host.js';
import { ClientController } from './client.js';
import { netErrorKey, findRoom } from './net.js';
import { BOT_STYLES } from './bot.js';
import { recordHand, recordTournament, getStats, resetStats } from './stats.js';
import { t, setLang, getLang, detectLang, rankShort, fmt, actionText, handText, applyStatic } from './i18n.js';
import { SND, soundPrefs } from './sound.js';
import { animateDeal, animateBetsToPot, animateBet, animatePotToWinners } from './anim.js';
import { HandRecorder, listHands, verdict } from './history.js';
import { verifyHand } from './fair.js';

void CATEGORY_RU;
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } }
};

const EMOJI = ['👍', '😂', '😎', '🤔', '😱', '😭', '🔥', '💪', '🙈', '🤡', '🍀', '💸', '🤝', '👏', '🥶', '😡'];
const QUICK = ['👍', '😂', '😱', '🔥', '🤡', '💸'];
const AVATARS = ['🦊', '🐯', '🐼', '🐸', '🦁', '🐺', '🐨', '🐵', '🦄', '🐙', '👑', '😎', '🤠', '👽', '🐲', '🦅'];

// позиции мест (в % от области стола), 0 — я, далее по часовой; раскладка зависит от числа игроков
const P = { me: [50, 99], bl: [11, 60], l: [10, 41], tl: [14, 23], t: [50, 8], tr: [86, 23], r: [90, 41], br: [89, 60] };
const LAYOUT = {
  1: [P.me], 2: [P.me, P.t], 3: [P.me, P.tl, P.tr], 4: [P.me, P.l, P.t, P.r],
  5: [P.me, P.bl, P.tl, P.tr, P.br], 6: [P.me, P.bl, P.tl, P.t, P.tr, P.br]
};
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

// ---------- компьютерная раскладка ----------
const DESK_MQ = matchMedia('(min-width: 1000px) and (min-height: 540px) and (min-aspect-ratio: 6/5)');
const STAGE_ASPECT = 2.05;
const isDesk = () => document.body.classList.contains('desk');
// места по овалу стола: я внизу по центру, остальные по часовой стрелке на равных углах
function deskPositions(v) {
  const me = v.seats.find(s => s && s.id === v.you);
  const n = v.seats.length, base = me ? me.seat : 0;
  const occ = [];
  for (let k = 0; k < n; k++) { const i = (base + k) % n; if (v.seats[i]) occ.push(i); }
  const map = {};
  const cnt = Math.max(2, occ.length);
  occ.forEach((i, k) => {
    if (k === 0 && me) { map[i] = [50, 98]; return; }          // я: якорь — низ блока
    const a = (90 + k * 360 / cnt) * Math.PI / 180;
    map[i] = [50 + 45 * Math.cos(a), 49 + 37 * Math.sin(a)];
  });
  return map;
}
const posFor = v => isDesk() ? deskPositions(v) : seatPositions(v);

// блоки, которые на компьютере переезжают в нижнюю панель (запоминаем исходные места)
const MOVABLE = ['hints', 'drawer', 'coachBox', 'actions'];
const HOME = {};
function rememberHomes() { for (const id of MOVABLE) { const el = document.getElementById(id); HOME[id] = { parent: el.parentNode, next: el.nextSibling }; } }
function applyLayout() {
  const desk = DESK_MQ.matches;
  const was = isDesk();
  document.body.classList.toggle('desk', desk);
  if (desk && !was) {
    $('#dockBody').append($('#hints'), $('#drawer'));
    $('#dockRight').append($('#coachBox'), $('#actions'));
    setDockTab(st.dockTab || 'hints');
  } else if (!desk && was) {
    for (const id of [...MOVABLE].reverse()) { const h = HOME[id]; h.parent.insertBefore(document.getElementById(id), h.next); }
    $('#hints').classList.remove('dock-hidden');
    $('#drawer').classList.add('hidden');
    st.drawer = null;
  }
  fitStage();
  if (st.view) render();
}
// сцена стола: максимальный размер нужной пропорции внутри свободного места
function fitStage() {
  const stg = $('#stage');
  if (!isDesk()) { stg.style.width = stg.style.height = ''; return; }
  const wrap = $('#tableWrap');
  const W = wrap.clientWidth - 32, H = wrap.clientHeight - 6;
  const w = Math.max(320, Math.min(W, H * STAGE_ASPECT, 1680));
  stg.style.width = w + 'px';
  stg.style.height = (w / STAGE_ASPECT) + 'px';
  stg.style.setProperty('--tu', (w / 100).toFixed(2) + 'px');
}
function setDockTab(tab) {
  st.dockTab = tab;
  $$('.dock-tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('#hints').classList.toggle('dock-hidden', tab !== 'hints');
  if (tab === 'hints') { $('#drawer').classList.add('hidden'); st.drawer = null; }
  else openDrawer(tab);
}

const DEFAULT_PREFS = { lang: detectLang(), felt: 'green', back: 'red', four: false, sound: true, vibrate: true, hud: true, coach: false, detail: false, notify: false, avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)] };
const st = {
  ctl: null, view: null, prevView: null, clockOffset: 0,
  token: LS.get('rp_token', null) || (() => { const x = crypto.getRandomValues(new Uint32Array(4)).join('-'); LS.set('rp_token', x); return x; })(),
  name: LS.get('rp_name', ''),
  prefs: { ...DEFAULT_PREFS, ...LS.get('rp_prefs', {}) },
  preAction: null, raiseOpen: false, raiseVal: 0,
  hintsKey: '', hints: null, showProbs: false,
  allinKey: '', allinEq: null,
  chatUnread: 0, drawer: null, log: [], chat: [],
  hostStyle: 'normal', wakeLock: null, avatars: {},
  rec: new HandRecorder(), lastReview: null, statsCache: null,
  seedsSent: {}, lastCommitSeen: null, handCommit: null, dealHole: null, fairLast: null,
  boardShown: 0
};

// ---------- фоновые вычисления ----------
let worker = null, wid = 0;
const wcb = new Map();
try {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => { const cb = wcb.get(data.id); if (cb) { wcb.delete(data.id); cb(data); } };
  worker.onerror = () => { worker = null; };
} catch { worker = null; }
function compute(msg, cb) {
  const id = ++wid;
  if (worker) { wcb.set(id, cb); worker.postMessage({ ...msg, id }); return; }
  // запасной путь без воркера
  setTimeout(() => {
    try {
      if (msg.type === 'hints') {
        const v = msg.variant === 'pineapple' ? 'holdem' : msg.variant;
        const profiles = msg.opps.map(h => profileFromHist(h, msg.bb));
        const hole = msg.hole.length === 3 ? msg.hole.slice(0, 2) : msg.hole;
        const n = Math.max(1, msg.opps.length);
        cb({ range: equity(hole, msg.board, n, 1200, Math.random, { variant: v, profiles }), random: equity(hole, msg.board, n, 800, Math.random, { variant: v }), outs: outs(hole, msg.board, v) });
      } else if (msg.type === 'allin') cb({ eq: equityKnown(msg.hands, msg.board, Math.random, msg.variant === 'pineapple' ? 'holdem' : msg.variant) });
      else if (msg.type === 'review') cb({ eqs: msg.decisions.map(d => equity(d.hole.slice(0, d.variant === 'omaha' ? 4 : 2), d.board, Math.max(1, d.opps.length), 1000, Math.random, { variant: d.variant === 'pineapple' ? 'holdem' : d.variant, profiles: d.opps.map(h => profileFromHist(h, d.bb)) }).equity) });
    } catch (e) { console.warn(e); }
  }, 10);
}

// ---------- настройки устройства ----------
function applyPrefs() {
  setLang(st.prefs.lang);
  document.body.dataset.felt = st.prefs.felt;
  document.body.dataset.back = st.prefs.back;
  document.body.classList.toggle('four', !!st.prefs.four);
  soundPrefs.on = st.prefs.sound; soundPrefs.vibrate = st.prefs.vibrate;
  applyStatic();
  $$('#langSwitch button').forEach(b => b.classList.toggle('on', b.dataset.lang === getLang()));
  $('#btnAvatarLobby').innerHTML = avatarHTML(st.prefs.avatar, st.name);
  $('#btnSoundTop').textContent = st.prefs.sound ? '🔊' : '🔇';
  $('#quickEmoji').innerHTML = QUICK.map(e => `<button>${e}</button>`).join('');
  $('#emojiRow').innerHTML = EMOJI.map(e => `<button>${e}</button>`).join('');
  if (st.view) render();
}
function savePrefs() { LS.set('rp_prefs', st.prefs); applyPrefs(); }

function avatarHTML(a, name) {
  if (a && a.startsWith('data:')) return `<img src="${esc(a)}" alt="">`;
  if (a) return `<span class="emo">${esc(a)}</span>`;
  return esc((name || '?').slice(0, 1).toUpperCase());
}

// ---------- лобби ----------
function initLobby() {
  $('#inName').value = st.name;
  const params = new URLSearchParams(location.search);
  if (params.get('room')) $('#inCode').value = params.get('room').toUpperCase().slice(0, 5);
  const saved = savedHostTable();
  if (saved) { $('#restoreBox').classList.remove('hidden'); $('#restoreCode').textContent = saved.code; }
  $('#btnRestore').onclick = () => { if (needName()) startRestore(savedHostTable()); };
  $('#btnDropRestore').onclick = () => { clearSavedHostTable(); $('#restoreBox').classList.add('hidden'); };
  $('#btnCreate').onclick = () => { if (needName()) openCreate(false); };
  $('#btnTrain').onclick = () => { if (needName()) openCreate(true); };
  $('#btnJoin').onclick = () => {
    if (!needName()) return;
    const code = $('#inCode').value.trim().toUpperCase();
    if (code.length < 4) return toast(t('need_code'));
    startClient(code);
  };
  $('#inCode').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  $('#inName').addEventListener('input', () => { $('#btnAvatarLobby').innerHTML = avatarHTML(st.prefs.avatar, $('#inName').value); });
  $('#btnStatsLobby').onclick = openStats;
  $('#btnRulesLobby').onclick = openRules;
  $('#btnHistLobby').onclick = openHistory;
  $('#btnSettingsLobby').onclick = openSettings;
  $('#btnAvatarLobby').onclick = openSettings;
  $$('#langSwitch button').forEach(b => b.onclick = () => { st.prefs.lang = b.dataset.lang; savePrefs(); });
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
  if (!n) { toast(t('need_name')); $('#inName').focus(); return false; }
  st.name = n; LS.set('rp_name', n);
  SND.unlock();
  return true;
}

function openCreate(offline) {
  const s = { mode: 'cash', variant: 'holdem', startChips: 2000, bb: 20, levelMinutes: 8, actionTimer: 30, timeBank: 30, hints: true, ante: true, rebuyLevels: 2, prizes: true, ...LS.get('rp_settings2', {}) };
  const blindOpts = [[5, 10], [10, 20], [25, 50], [50, 100]];
  const opt = (arr, cur) => arr.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('');
  modal(`
    <h2>${t(offline ? 'training' : 'new_table')}</h2>
    <div class="form-grid">
      <div class="full"><div class="seg" id="segMode">
        <button data-v="cash" class="${s.mode === 'cash' ? 'on' : ''}">${t('mode_cash')}</button>
        <button data-v="tournament" class="${s.mode === 'tournament' ? 'on' : ''}">${t('mode_tour')}</button>
      </div></div>
      <div class="full"><label class="lbl">${t('variant')}</label><div class="seg" id="segVar">
        ${['holdem', 'omaha', 'pineapple'].map(v => `<button data-v="${v}" class="${s.variant === v ? 'on' : ''}">${t('v_' + v)}</button>`).join('')}
      </div></div>
      <div><label class="lbl">${t('start_stack')}</label><select id="fChips">${opt([1000, 1500, 2000, 3000, 5000, 10000].map(v => [v, v]), s.startChips)}</select></div>
      <div><label class="lbl">${t('blinds')}</label><select id="fBlinds">${opt(blindOpts.map(([a, b]) => [b, `${a} / ${b}`]), s.bb)}</select></div>
      <div><label class="lbl">${t('action_time')}</label><select id="fTimer">${opt([[0, t('no_limit')], [15, t('sec', { n: 15 })], [30, t('sec', { n: 30 })], [45, t('sec', { n: 45 })], [60, t('sec', { n: 60 })]], s.actionTimer)}</select></div>
      <div><label class="lbl">${t('time_bank')}</label><select id="fBank">${opt([[0, t('none')], [30, t('sec', { n: 30 })], [60, t('sec', { n: 60 })], [120, t('sec', { n: 120 })]], s.timeBank)}</select></div>
      <div class="tour-only ${s.mode === 'tournament' ? '' : 'hidden'}"><label class="lbl">${t('level_min')}</label><select id="fLevel">${opt([3, 5, 8, 10, 15, 20].map(v => [v, v]), s.levelMinutes)}</select></div>
      <div class="tour-only ${s.mode === 'tournament' ? '' : 'hidden'}"><label class="lbl">${t('rebuy_levels')}</label><select id="fRebuy">${opt([0, 1, 2, 3, 4].map(v => [v, v || t('none')]), s.rebuyLevels)}</select></div>
      <div class="full switch tour-only ${s.mode === 'tournament' ? '' : 'hidden'}"><span>${t('ante_toggle')}</span><input type="checkbox" id="fAnte" ${s.ante ? 'checked' : ''}></div>
      <div class="full switch tour-only ${s.mode === 'tournament' ? '' : 'hidden'}"><span>${t('prizes_toggle')}</span><input type="checkbox" id="fPrizes" ${s.prizes ? 'checked' : ''}></div>
      <div class="full switch"><span>${t('hints_toggle')}</span><input type="checkbox" id="fHints" ${s.hints ? 'checked' : ''}></div>
      ${offline ? `<div><label class="lbl">${t('bots_n')}</label><select id="fBots">${opt([1, 2, 3, 4, 5].map(v => [v, v]), 3)}</select></div>
      <div><label class="lbl">${t('bots_style')}</label><select id="fBotStyle"><option value="mix">${t('mixed')}</option>${Object.keys(BOT_STYLES).map(k => `<option value="${k}">${t('bot_' + k)}</option>`).join('')}</select></div>` : ''}
      <button class="btn gold big full" id="fGo">${t(offline ? 'play' : 'open_table')}</button>
    </div>`);
  let mode = s.mode, variant = s.variant;
  $$('#segMode button').forEach(b => b.onclick = () => {
    mode = b.dataset.v;
    $$('#segMode button').forEach(x => x.classList.toggle('on', x === b));
    $$('.tour-only').forEach(x => x.classList.toggle('hidden', mode !== 'tournament'));
  });
  $$('#segVar button').forEach(b => b.onclick = () => { variant = b.dataset.v; $$('#segVar button').forEach(x => x.classList.toggle('on', x === b)); });
  $('#fGo').onclick = () => {
    const bb = +$('#fBlinds').value;
    const settings = {
      mode, variant, limit: variant === 'omaha' ? 'pl' : 'nl', startChips: +$('#fChips').value, bb, sb: bb / 2,
      levelMinutes: +$('#fLevel').value, actionTimer: +$('#fTimer').value, timeBank: +$('#fBank').value, hints: $('#fHints').checked,
      ante: $('#fAnte').checked, rebuyLevels: +$('#fRebuy').value, prizes: $('#fPrizes').checked
    };
    LS.set('rp_settings2', settings);
    closeModal();
    if (offline) {
      const n = +($('#fBots')?.value || 3), style = $('#fBotStyle')?.value || 'mix';
      startHost({ settings, offline: true, bots: Array.from({ length: n }, (_, i) => style === 'mix' ? ['tight', 'normal', 'lag'][i % 3] : style) });
    } else startHost({ settings });
  };
}

function startHost({ settings, offline = false, restore = null, bots = [], migrate = null }) {
  enterGame(!migrate);
  st.ctl = new HostController({ name: st.name, token: st.token, settings, offline, restore, migrate, avatar: st.prefs.avatar }, UI);
  st.avatars = { ...st.ctl.avatars };
  $('#roomCode').textContent = offline ? t('offline') : st.ctl.code;
  if (offline) { bots.forEach(b => st.ctl.addBot(b)); setTimeout(() => st.ctl.start(), 400); }
  else st.ctl.sync(true);
}

function startClient(code) {
  enterGame(true);
  $('#roomCode').textContent = code;
  st.ctl = new ClientController({ name: st.name, token: st.token, code, avatar: st.prefs.avatar }, UI);
}

// восстановление стола хостом: сначала проверяем, не переехал ли стол к другому игроку
function startRestore(saved) {
  if (!saved) return;
  toast(t('st_connecting'));
  let settled = false;
  const f = findRoom(saved.code, {
    from: (saved.gen || 0) + 1, max: (saved.gen || 0) + 4,
    handlers: {
      onOpen: () => { if (settled) return; settled = true; f.stop(); clearSavedHostTable(); startClient(saved.code); },
      onData: () => {}, onClose: () => {}, onError: () => {}
    },
    onNone: () => { if (settled) return; settled = true; startHost({ restore: saved }); }
  });
  setTimeout(() => { if (!settled) { settled = true; f.stop(); startHost({ restore: saved }); } }, 7000);
}

function enterGame(reset) {
  $('#lobby').classList.add('hidden');
  $('#game').classList.remove('hidden');
  if (reset) { st.log = []; st.chat = []; st.view = null; st.prevView = null; st.preAction = null; st.boardShown = 0; }
  requestWake();
}

function leaveGame() {
  if (st.ctl) {
    if (!st.ctl.isHost()) st.ctl.send({ t: 'leave' });
    else clearSavedHostTable();
    const c = st.ctl; st.ctl = null;
    setTimeout(() => c.destroy(), 200);
  }
  $('#game').classList.add('hidden');
  $('#lobby').classList.remove('hidden');
  closeModal(); closeDrawer();
  $('#restoreBox').classList.toggle('hidden', !savedHostTable());
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
    beforeRender(st.prevView, view);
    render();
    afterRender(st.prevView, view);
  },
  onMessage(msg) {
    if (msg.t === 'events') msg.list.forEach(onEvent);
    else if (msg.t === 'chat') addChat(msg);
    else if (msg.t === 'emoji') floatAt(msg.id, msg.e);
    else if (msg.t === 'avatars') { st.avatars = msg.map || {}; if (st.view) render(); }
    else if (msg.t === 'error') toast(t(msg.key || 'err_generic', { v: fmt(msg.v) }));
  },
  onStatus(s) {
    const d = $('#netDot'); d.className = 'dot ' + s.kind;
    if (s.text) d.title = t(s.text, { n: s.n });
    if (s.kind === 'err' || s.text === 'st_migrating') toast(t(s.text, { n: s.n }));
  },
  onNetError(err) {
    const msg = t(netErrorKey(err));
    toast(msg); UI.onStatus({ kind: 'err', text: '' });
    if (st.ctl && !st.ctl.isHost() && !st.view) setTimeout(leaveGame, 1800);
  },
  onKicked() { toast(t('toast_kicked')); setTimeout(leaveGame, 1200); },
  onSeedSent(s) { st.seedsSent[s.commit] = s.seed; },
  onBecomeHost(m) {
    // этот телефон принимает стол у пропавшего хоста
    try { st.ctl && st.ctl.destroy(); } catch { /* */ }
    st.ctl = null;
    startHost({ migrate: { ...m, avatars: st.avatars } });
    toast(t('toast_host'));
  },
  // телефон хоста «спал» (приложение было свёрнуто): возможно, стол уже переехал к другому игроку
  onHostSuspended(h) {
    if (h !== st.ctl || h._probing) return;
    h._probing = true;
    let done = false;
    const f = findRoom(h.code, {
      from: h.gen + 1, max: h.gen + 4,
      handlers: {
        onOpen: () => { if (done) return; done = true; f.stop(); try { h.destroy(); } catch { /* */ } st.ctl = null; clearSavedHostTable(); startClient(h.code); },
        onData: () => {}, onClose: () => {}, onError: () => {}
      },
      onNone: () => { done = true; h._probing = false; }
    });
  },
  toastKey: k => toast(t(k)),
  toast
};

function onEvent(e) {
  const v = st.view;
  st.rec.event(e);
  switch (e.t) {
    case 'act': {
      addLog(`${e.name}: ${actionText(e.action)}`);
      const a = e.action.t;
      if (a === 'fold') SND.fold(); else if (a === 'check') SND.check(); else if (a === 'allin') { SND.chip(5); SND.allin(); } else SND.chip(a === 'raise' || a === 'bet' ? 4 : 2);
      break;
    }
    case 'street': addLog(`— ${t('s_' + e.street)}: ${e.board.map(cardText).join(' ')}`); break;
    case 'hand': addLog(t('l_hand', { n: e.handNo })); st.preAction = null; st.foldArmed = false; break;
    case 'result': {
      const r = e.result;
      for (const w of r.winners) addLog(t('l_win', { name: w.name, a: fmt(w.amount) }) + (w.desc ? ' — ' + handText(w.desc) : ''));
      recordHand(r); st.statsCache = null;
      if (v && r.winners.some(w => w.id === v.you)) setTimeout(() => SND.win(), 400); else SND.stack();
      break;
    }
    case 'level': addLog(t(e.ante ? 'l_level_ante' : 'l_level', { n: e.level, sb: fmt(e.sb), bb: fmt(e.bb), ante: fmt(e.ante) })); toast(t('toast_levelup', { sb: fmt(e.sb), bb: fmt(e.bb) })); break;
    case 'bust': addLog(t('l_bust', { name: e.name, p: e.place })); break;
    case 'bustRebuy': addLog(t('l_bust_rebuy', { name: e.name })); break;
    case 'rebuyClosed': addLog(t('l_rebuy_closed')); break;
    case 'tourover':
      addLog(t('l_tourover', { name: e.name }));
      recordTournament(e.places); st.statsCache = null;
      setTimeout(() => showTourOver(e.places, e.prizes), 1500);
      break;
    case 'join': addLog(t('l_join', { name: e.name })); break;
    case 'leave': addLog(t('l_leave', { name: e.name })); break;
    case 'rebuy': addLog(t('l_rebuy', { name: e.name })); break;
    case 'sitout': addLog(t(e.v ? 'l_sitout' : 'l_sitback', { name: e.name })); break;
    case 'show': addLog(t('l_show', { name: e.name, cards: e.hole.map(cardText).join(' ') })); break;
    case 'discardPhase': addLog(t('l_discard_phase')); break;
  }
}

const cardText = c => rankShort(rankOf(c)) + SUIT_SYM[suitOf(c)];
function mySeatObj(v = st.view) { return v && v.seats.find(s => s && s.id === v.you) || null; }

// ---------- переходы состояний: звуки, анимации, история, проверка честности ----------
let pendingBetRects = [];
function beforeRender(prev, v) {
  pendingBetRects = [];
  if (!prev) return;
  // ставки улицы уезжают в банк при смене улицы или конце раздачи
  const streetChanged = prev.handNo === v.handNo && (prev.street !== v.street || (v.phase === 'over' && prev.phase !== 'over'));
  if (streetChanged) pendingBetRects = $$('#seats .bet').map(el => el.getBoundingClientRect());
}

function afterRender(prev, v) {
  const me = mySeatObj(v);
  if (prev && pendingBetRects.length) animateBetsToPot(pendingBetRects, $('#potInfo'));
  // новая раздача
  if (v.handNo && (!prev || prev.handNo !== v.handNo) && v.phase !== 'idle') {
    st.boardShown = 0;
    st.handCommit = st.lastCommitSeen;
    st.dealHole = me && me.hole ? me.hole.slice() : null;
    st.rec.start(v);
    st.lastReview = null;
    const targets = [...$$('#seats .seat:not(.me) .cards')].filter(el => el.children.length);
    const mine = $('#seats .seat.me .cards .pair');
    if (me && me.inHand && mine) targets.push(mine);
    const per = Math.max(...v.seats.filter(Boolean).map(s => s.cardCount || 0), 2);
    const dur = animateDeal(targets, $('#board'), per);
    SND.deal(Math.min(12, targets.length * per));
    $$('#seats .cards .card, #myCards .pair .card').forEach(c => { c.style.animationDelay = (dur * 0.6) + 'ms'; c.classList.add('deal-in'); });
  }
  // новые ставки
  if (prev && prev.handNo === v.handNo) {
    v.seats.forEach((p, i) => {
      const q = prev.seats[i];
      if (p && q && p.bet > q.bet && p.bet > 0) animateBet(document.querySelector(`.seat[data-seat="${i}"] .ava`) || $('#myCards'), document.querySelector(`.bet[data-seat="${i}"]`));
    });
  }
  // банк к победителю
  if (prev && v.phase === 'over' && prev.phase !== 'over' && v.lastResult) {
    const els = v.lastResult.winners.map(w => w.id === v.you ? $('#seats .seat.me .ava') : document.querySelector(`.seat[data-id="${CSS.escape(w.id)}"] .ava`)).filter(Boolean);
    setTimeout(() => animatePotToWinners($('#potInfo'), els), 350);
    finishHandForMe(v);
  }
  // запоминаем опубликованный хеш сида следующей раздачи
  if (v.commitNext) st.lastCommitSeen = v.commitNext;
  // мой ход
  const myTurn = me && v.legal && v.toAct === me.seat;
  const wasMyTurn = prev && me && prev.legal && prev.toAct === me.seat && prev.handNo === v.handNo;
  if (myTurn && !wasMyTurn) {
    st.raiseOpen = false;
    if (st.preAction) {
      const pa = st.preAction; st.preAction = null;
      if (pa === 'checkfold') return setTimeout(() => act(v.legal.canCheck ? 'check' : 'fold'), 150);
      if (pa === 'check' && v.legal.canCheck) return setTimeout(() => act('check'), 150);
      if (pa === 'callany') return setTimeout(() => act(v.legal.canCheck ? 'check' : 'call'), 150);
    }
    SND.turn();
    notifyTurn(v);
  }
  if (prev && prev.currentBet !== v.currentBet && st.preAction === 'check') st.preAction = null;
}

function finishHandForMe(v) {
  const r = v.lastResult;
  const rec = st.rec.finish(r, v);
  if (rec && rec.decisions.length) {
    compute({ type: 'review', decisions: rec.decisions }, res => {
      if (!res.eqs) return;
      rec.review = rec.decisions.map((d, i) => ({ eq: res.eqs[i], ...verdict(d, res.eqs[i]) }));
      st.rec.update(rec);
      if (st.view && st.view.handNo === rec.handNo) { st.lastReview = rec; renderActions(st.view, mySeatObj()); }
      const bad = rec.review.filter(x => x.kind === 'bad_fold' || x.kind === 'bad_call');
      if (bad.length) addLog('🔍 ' + t('rev_summary', { n: bad.length, a: fmt(bad.reduce((a, x) => a + (x.ev || 0), 0)) }));
    });
  }
  // проверка честности (для игроков, не для хоста)
  if (r.fair && st.ctl && !st.ctl.isHost()) {
    verifyHand({
      fair: r.fair, result: r, myId: v.you, myHole: st.dealHole, mySeed: st.seedsSent[r.fair.commit],
      seenCommit: st.handCommit, variant: v.settings.variant
    }).then(res => {
      st.fairLast = { handNo: r.handNo, ...res };
      if (res.ok) addLog(t('l_fair_ok', { n: r.handNo }));
      else { const m = t('l_fair_bad', { n: r.handNo, r: t('r_' + res.reason) }); addLog(m); toast(m); }
      $('#btnFair').classList.toggle('bad', !res.ok);
    }).catch(() => {});
  }
}

function notifyTurn(v) {
  if (!document.hidden || !st.prefs.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  const body = t('notif_turn_body', { c: $('#roomCode').textContent, a: fmt(v.legal.toCall) });
  const opts = { body, icon: 'icons/icon-192.png', tag: 'turn', renotify: true };
  if (navigator.serviceWorker?.controller) navigator.serviceWorker.ready.then(r => r.showNotification(t('notif_turn'), opts)).catch(() => {});
  else try { new Notification(t('notif_turn'), opts); } catch { /* */ }
}

function act(type, amount) {
  st.raiseOpen = false;
  if (st.view) st.rec.decision(st.view, type, amount);
  st.ctl.send({ t: 'act', type, amount });
}

// ---------- отрисовка ----------
function cardHTML(c, cls = '', hl = false) {
  if (c == null) return `<div class="card back ${cls}"></div>`;
  const s = suitOf(c);
  return `<div class="card s${s} ${cls} ${hl ? 'hl' : ''}" data-c="${c}"><span class="r">${rankShort(rankOf(c))}</span><span class="s">${SUIT_SYM[s]}</span></div>`;
}

function statsFor(name) {
  if (!st.statsCache) { st.statsCache = {}; for (const p of getStats().players) st.statsCache[p.name] = p; }
  return st.statsCache[name];
}

function render() {
  const v = st.view; if (!v) return;
  const me = mySeatObj(v);
  const desk = isDesk();
  const posMap = posFor(v);
  const lr = v.lastResult && v.phase === 'over' ? v.lastResult : null;
  const winners = new Set(lr ? lr.winners.map(w => w.id) : []);
  const bestCards = new Set();
  if (lr && lr.showdown) for (const w of lr.winners) (lr.shown[w.id]?.best || []).forEach(c => bestCards.add(c));

  // верхняя панель
  const tour = v.settings.mode === 'tournament';
  const vname = v.settings.variant !== 'holdem' ? ` · ${t('v_' + v.settings.variant).split(' ')[0]}` : '';
  setHTML($('#blindsInfo'), `<b>${fmt(v.blinds[0])} / ${fmt(v.blinds[1])}</b>${v.ante ? ` <small>${t('ante_info', { a: fmt(v.ante) })}</small>` : ''}<br><span id="lvlTimer">${tour ? t('lvl', { n: v.level }) : t('cash')}${vname}</span>`);
  $('#btnFair').classList.toggle('hidden', !!(st.ctl && st.ctl.offline));

  // места
  const items = [];
  const allinEq = computeAllinEq(v);
  const dealt = v.seats.filter(Boolean).map(s => s.cardCount).reduce((a, b) => Math.max(a, b), 0);
  for (let i = 0; i < v.seats.length; i++) {
    const p = v.seats[i];
    if (!p) continue;
    const [x, y] = posMap[i] || P.t;
    const isMe = p.id === v.you;
    const cls = ['seat', isMe ? 'me' : '', v.toAct === i ? 'turn' : '', winners.has(p.id) ? 'win' : '',
      p.inHand && p.folded && v.phase !== 'idle' ? 'folded' : '', p.out ? 'out' : '', p.connected === false && !p.bot ? 'off' : '',
      p.needDiscard ? 'discarding' : '', dealt >= 4 ? 'many' : ''].join(' ');
    let actCls = '';
    const at = p.lastAction?.t;
    if (at === 'fold') actCls = 'fold'; else if (at === 'allin') actCls = 'allin'; else if (at === 'raise' || at === 'bet') actCls = 'raise';
    const prevSeat = st.prevView && st.prevView.handNo === v.handNo ? st.prevView.seats[i] : null;
    const reveal = !!(p.hole && !isMe && prevSeat && !prevSeat.hole);
    // на компьютере мои карты рисует renderMine прямо в моё место за столом
    const cards = isMe ? '' : p.hole ? p.hole.map(c => cardHTML(c, 'sm' + (reveal ? ' flip' : ''), bestCards.has(c))).join('')
      : (p.cardCount ? Array.from({ length: p.cardCount }, () => cardHTML(null, 'sm')).join('') : '');
    const sh = lr && lr.shown[p.id];
    const shownHand = sh && sh.desc ? `<div class="hand">${esc(handText(sh.desc))}</div>` : '';
    const winAmt = lr ? lr.winners.find(w => w.id === p.id) : null;
    const eqBadge = allinEq && allinEq[p.id] != null ? `<div class="eq">${Math.round(allinEq[p.id] * 100)}%</div>` : '';
    const timer = v.toAct === i && (v.settings.actionTimer > 0) && !p.bot ? `<svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="none" stroke="var(--yellow)" stroke-width="3" stroke-dasharray="100.5" stroke-dashoffset="0" class="tring" data-tb="${p.timebank}"/></svg>` : '';
    let chipsTxt = fmt(p.chips);
    if (p.out && tour) chipsTxt = p.place ? t('place_n', { n: p.place }) : (p.canRebuy ? t('rebuy_wait') : t('spectator'));
    else if (p.sitOut) chipsTxt = `${fmt(p.chips)} · ${t('sitting_out')}`;
    let hud = '';
    if (st.prefs.hud && !isMe) {
      const s = statsFor(p.name);
      if (s && s.hands >= 8) hud = `<div class="hudl">${t('hud', { v: s.vpipPct, p: s.pfrPct, af: s.af })}</div>`;
      else if (s) hud = `<div class="hudl">${t('hud_few', { n: s.hands })}</div>`;
    }
    const isTop = !desk && y < 20;
    items.push({ k: 's' + i, h: `<div class="${cls}${isTop ? ' top' : ''}" data-id="${esc(p.id)}" data-seat="${i}" style="left:${x}%;top:${isTop ? '20px' : y + '%'}">
      ${p.lastAction && v.phase !== 'idle' ? `<div class="act ${actCls}">${esc(actionText(p.lastAction))}</div>` : ''}
      <div class="ava">${avatarHTML(st.avatars[p.id], p.name)}${timer}</div>${eqBadge}
      <div class="plate"><div class="nm">${esc(p.name)}</div><div class="ch">${winAmt ? '+' + fmt(winAmt.amount) : chipsTxt}</div>${hud}</div>
      <div class="cards">${cards}</div>${shownHand}
    </div>` });
    if (p.bet > 0) {
      let bx, by;
      if (desk) {
        if (isMe) { bx = 50; by = 61; }
        else { bx = x + (50 - x) * 0.47; by = y + (50 - y) * 0.47 + (y < 50 ? 4 : 0); }
      } else if (isMe) { bx = 50; by = 64; }          // уточняется по размеру карт в placeHeroBits()
      else {
        const pos = posMap[i];
        const M = new Map([[P.t, [72, 20]], [P.tl, [27, 34]], [P.tr, [73, 34]], [P.l, [14, 56]], [P.r, [86, 56]], [P.bl, [26, 68]], [P.br, [74, 68]]]);
        [bx, by] = M.get(pos) || [x + (50 - x) * 0.42, y + (50 - y) * 0.42];
      }
      items.push({ k: 'b' + i, h: `<div class="bet" data-seat="${i}" style="left:${bx}%;top:${by}%"><span class="chipico"></span>${fmt(p.bet)}</div>` });
    }
    if (i === v.dealer && v.handNo) {
      const isBottom = (posMap[i] || P.t) === P.me;
      let dx, dy;
      if (desk) {
        if (isMe) { dx = 60.5; dy = 82; }
        else { const side = Math.abs(50 - x) > 15; dx = x + (50 - x) * 0.3 + (side ? 0 : 8); dy = y + (50 - y) * 0.3 + (side ? (y < 50 ? 10 : -9) : 0); }
      } else if (isBottom) { dx = 71; dy = 79; }
      else { dx = x + (50 - x) * 0.3; dy = y + (50 - y) * 0.3 + (y < 30 ? 6 : 0); }
      items.push({ k: 'd', h: `<div class="dealer-btn${isMe ? ' me-d' : ''}" style="left:${dx}%;top:${dy}%">D</div>` });
    }
  }
  // на низком экране прячем рубашки соперников и уменьшаем места, чтобы ничего не наезжало на стол
  patchChildren($('#seats'), items);
  bindSeatTaps();

  // доска: новые карты переворачиваются по очереди
  const handLive = ['betting', 'runout', 'over', 'discard'].includes(v.phase);
  let bh = '';
  for (let k = 0; k < 5; k++) {
    const c = v.board[k];
    if (c != null) {
      const isNew = k >= st.boardShown;
      bh += cardHTML(c, isNew ? 'flip' : '', bestCards.has(c)).replace('class="card', `style="animation-delay:${isNew ? (k - st.boardShown) * 130 : 0}ms" class="card`);
    } else bh += handLive && v.handNo ? `<div class="card empty"></div>` : '';
  }
  if (v.board.length > st.boardShown) { const n = v.board.length - st.boardShown; for (let k = 0; k < n; k++) SND.flip && setTimeout(() => SND.flip(), k * 130); }
  st.boardShown = v.board.length;
  setHTML($('#board'), bh);
  $('#board').classList.toggle('omaha', v.settings.variant === 'omaha');
  setHTML($('#potInfo'), v.handNo && v.phase !== 'idle' ? t('pot', { a: fmt(lr ? lr.pot : v.pot) }) : '');

  // центр
  let msg = '';
  if (v.tourOver) msg = `<span class="win">${esc(t('c_tour_over', { name: v.places[0]?.name || '' }))}</span>`;
  else if (lr) msg = lr.winners.map(w => `<span class="win">${esc(w.name)} +${fmt(w.amount)}</span>${w.desc ? '<br>' + esc(handText(w.desc)) : ''}`).join('<br>');
  else if (!v.handNo || v.phase === 'idle') {
    const cnt = v.seats.filter(Boolean).length;
    msg = st.ctl?.isHost() ? `${t('c_players', { n: cnt })} ${v.handNo ? t('c_waiting') : t('c_invite')}` : t('c_wait_deal');
  } else if (v.phase === 'runout') msg = t('c_allin');
  else if (v.phase === 'discard') msg = t('c_discard');
  setHTML($('#centerMsg'), msg);

  renderMine(v, me);
  renderActions(v, me);
  placeHeroBits();
  tickTimers();
}

// обновить содержимое только если разметка изменилась (без пересоздания элементов и мигания)
function setHTML(el, html) {
  if (!el || el._h === html) return false;
  el.innerHTML = html; el._h = html;
  return true;
}
// обновить детей контейнера по ключам: неизменившиеся элементы остаются на месте
function patchChildren(container, items) {
  const existing = new Map();
  for (const el of [...container.children]) existing.set(el.dataset.k, el);
  const keep = new Set();
  for (const it of items) {
    keep.add(it.k);
    const old = existing.get(it.k);
    if (old && old._h === it.h) continue;
    const tpl = document.createElement('template');
    tpl.innerHTML = it.h.trim();
    const el = tpl.content.firstElementChild;
    el.dataset.k = it.k; el._h = it.h;
    if (old) old.replaceWith(el); else container.appendChild(el);
  }
  for (const [k, el] of existing) if (!keep.has(k)) el.remove();
}

// низкий стол на телефоне: прячем рубашки соперников и уменьшаем места
function updateCompact() {
  $('#tableWrap').classList.toggle('compact', !isDesk() && window.innerHeight < 720);
}
// на телефоне моя ставка — над моими картами, кнопка дилера — справа от них (по фактическому размеру)
function placeHeroBits() {
  if (isDesk() || !st.view) return;
  const hero = $('#seats .seat.me .cards');
  if (!hero) return;
  const stage = $('#stage').getBoundingClientRect(), r = hero.getBoundingClientRect();
  if (!stage.height || !r.height) return;
  const me = mySeatObj();
  const bet = me && $(`#seats .bet[data-seat="${me.seat}"]`);
  if (bet) { bet.style.left = '50%'; bet.style.top = (r.top - stage.top - 14) + 'px'; }
  if (me && st.view.dealer === me.seat) {
    const d = $('#seats .dealer-btn.me-d');
    if (d) { d.style.left = (r.right - stage.left + 16) + 'px'; d.style.top = (r.top - stage.top + r.height * 0.6) + 'px'; }
  }
}

function bindSeatTaps() {
  $$('#seats .seat').forEach(el => {
    el.onclick = () => {
      const v = st.view;
      const p = v.seats.find(s => s && s.id === el.dataset.id);
      if (!p) return;
      const host = st.ctl?.isHost();
      const canKick = host && p.id !== v.you;
      modal(`<div class="seat-modal"><div class="ava big">${avatarHTML(st.avatars[p.id], p.name)}</div><h2>${esc(p.name)}</h2></div>
        <p>${p.bot ? t('seat_bot', { s: t('bot_' + p.bot) }) : t(p.connected === false ? 'seat_off' : 'seat_on')} · ${t('seat_chips', { a: fmt(p.chips) })}${v.settings.mode === 'cash' ? ' · ' + t('seat_buyins', { n: p.buyins }) : ''}</p>
        ${statLine(p.name)}
        ${canKick ? `<button class="btn red big" id="kickBtn">${t(p.bot ? 'b_kick_bot' : 'b_kick')}</button>` : ''}`);
      if (canKick) $('#kickBtn').onclick = () => { st.ctl.removeSeat(p.id); closeModal(); };
    };
  });
}

function statLine(name) {
  const s = getStats().players.find(x => x.name === name);
  if (!s) return `<p class="hint">${t('st_none')}</p>`;
  return `<p class="hint">${t('st_line', { r: s.rating, h: s.hands, v: s.vpipPct, p: s.pfrPct, af: s.af, style: t(s.style) })}</p>`;
}

function renderMine(v, me) {
  const box = $('#myCards');
  if (!me) { box.innerHTML = ''; renderHints(v, null); return; }
  const myTurn = v.legal && v.toAct === me.seat;
  box.classList.toggle('turn', !!myTurn);
  box.classList.toggle('discard', !!me.needDiscard);
  const lr = v.phase === 'over' ? v.lastResult : null;
  const best = new Set(lr && lr.shown[me.id] ? lr.shown[me.id].best : []);
  const n = me.hole ? me.hole.length : 0;
  const size = n >= 4 ? 'md' : n === 3 ? 'lg3' : 'lg';
  const cards = n ? me.hole.map(c => cardHTML(c, size + (me.folded ? ' dim' : ''), best.has(c))).join('') : '';
  const pos = v.dealer === me.seat ? ' · D' : v.sbSeat === me.seat && v.handNo ? ' · ' + t('a_sb', { a: '' }).trim() : v.bbSeat === me.seat && v.handNo ? ' · ' + t('a_bb', { a: '' }).trim() : '';
  const myAct = me.lastAction && v.phase !== 'idle' ? `<span class="my-act">${esc(actionText(me.lastAction))}</span>` : '';
  box.innerHTML = `<div class="pair n${n}">${cards}</div><div class="me-info"><span class="me-ava">${avatarHTML(st.prefs.avatar, me.name)}</span><b>${fmt(me.chips)}</b>${pos}${myAct}</div>`;
  const heroSlot = $('#seats .seat.me .cards');
  if (heroSlot) setHTML(heroSlot, `<div class="pair n${n}">${cards}</div>`);
  if (me.needDiscard) {
    $$('#myCards .pair .card, #seats .seat.me .cards .card').forEach(el => el.onclick = e => { e.stopPropagation(); st.ctl.send({ t: 'discard', card: +el.dataset.c }); SND.fold(); });
  }
  renderHints(v, me);
}

// ---------- подсказки ----------
function renderHints(v, me) {
  const el = $('#hints');
  const coachEl = $('#coachBox');
  coachEl.classList.add('hidden');
  st.coachAct = null;
  if (!me) { setHTML(el, `<div class="hints-off">${t('w_watch')}</div>`); return; }
  if (!v.settings.hints) { setHTML(el, `<div class="hints-off">${t('h_off')}</div>`); return; }
  if (!me.hole || me.hole.length < 2 || !me.inHand) {
    setHTML(el, `<div class="hints-off">${me.out ? t(v.settings.mode === 'cash' ? 'h_nochips' : 'h_out') : t('h_wait')}</div>`);
    return;
  }
  const variant = v.settings.variant;
  const detail = !!st.prefs.detail;
  const live = v.phase === 'betting' || v.phase === 'discard' || v.phase === 'runout';
  const oppSeats = v.seats.filter(s => s && s.inHand && !s.folded && s.id !== me.id);
  const opps = oppSeats.map(s => s.hist || []);
  const key = me.hole.join(',') + '|' + v.board.join(',') + '|' + oppSeats.map(s => s.id + (s.hist || []).length).join(';');
  if (key !== st.hintsKey && live) {
    st.hintsKey = key;
    st.hints = null;
    compute({ type: 'hints', hole: me.hole, board: v.board, variant, opps, bb: v.blinds[1] }, res => {
      if (st.hintsKey !== key) return;
      st.hints = { ...res, key };
      st.prevHints = { hole: me.hole.join(','), d: st.hints };
      if (st.view) { renderHints(st.view, mySeatObj(st.view)); renderActions(st.view, mySeatObj(st.view)); }
    });
  }
  let d = st.hints && (st.hints.key === key || !live) ? st.hints : null;
  let stale = false;
  if (!d && st.prevHints && st.prevHints.hole === me.hole.join(',')) { d = st.prevHints.d; stale = true; }
  const toCall = v.legal ? v.legal.toCall : Math.max(0, v.currentBet - me.bet);
  // строка 1: что у меня на руках
  let head = '';
  if (v.board.length === 0) {
    const tr = preflopTier(me.hole, variant);
    head = `${t('h_preflop')} <span class="tier ${tr.color}">${t('tier_' + tr.tier)}</span>${detail ? ` <small>${t('h_score', { n: tr.score })}</small>` : ''}`;
  } else if (me.hole.length !== 3) {
    head = esc(handText(handDesc(evalHand(me.hole, v.board, variant === 'pineapple' ? 'holdem' : variant))));
  }
  let h = '';
  // главное: шанс выиграть одной цифрой со шкалой
  if (d && d.range) {
    const eqPct = Math.round(d.range.equity * 100);
    h += `<div class="hint-top"><span class="hand-now">${head}</span><b class="eq-big ${eqPct >= 50 ? 'hi' : eqPct >= 25 ? 'mid' : 'lo'}">${eqPct}%</b></div>`;
    const w = Math.round(d.range.win * 100), ti = Math.round(d.range.tie * 100);
    h += `<div class="eqbar"><i class="w" style="width:${w}%"></i><i class="t" style="width:${ti}%"></i></div>`;
  } else {
    h += `<div class="hint-top"><span class="hand-now">${head}</span>${live ? `<small>${t('h_calc')}</small>` : ''}</div>`;
  }
  // ананас: какую карту сбросить — это важно и в простом режиме
  if (d && d.keeps) {
    const k = d.keeps[0];
    const keep = me.hole.filter(c => c !== k.drop).map(cardText).join(' ');
    h += `<div class="line keep"><span>${t('h_keep', { cards: keep, p: Math.round(k.eq * 100) })}</span></div>`;
  }
  // короткий совет (только пока раздача идёт и мне есть что решать)
  let adv = '';
  if (d && d.range && live && !me.allin && !me.folded && !me.needDiscard) {
    const a = advice(d.range.equity, toCall, v.pot, oppSeats.length + 1);
    adv = `<span class="adv ${a.kind}">${t(a.key)}</span>`;
    if (!isDesk() && st.prefs.coach && v.legal && v.toAct === me.seat && !stale) {
      const c = coach({ eq: d.range.equity, toCall, pot: v.pot, players: oppSeats.length + 1, outs: d.outs?.count || 0, street: v.street, canRaise: v.legal.canRaise, stackBB: me.chips / v.blinds[1] });
      const actTxt = c.act === 'raise' ? t('ca_raise', { p: Math.round(c.size * 100) }) : t('ca_' + c.act);
      adv = `<span class="adv coach">🎓 <b>${esc(actTxt)}</b> — ${esc(t('why_' + c.why))}</span>`;
    }
  }
  h += `<div class="hint-foot">${adv || '<span></span>'}<button class="more-btn" id="tglDetail">${t(detail ? 'h_less_detail' : 'h_more_detail')}</button></div>`;
  // подробности по желанию
  if (detail && d && d.range) {
    h += `<div class="hint-detail">`;
    h += `<div class="line"><span>${t('h_vs_range')} <small>(${t('h_opps', { n: oppSeats.length })})</small></span><b>${(d.range.equity * 100).toFixed(1)}%</b></div>`;
    if (d.random) h += `<div class="line sub"><span>${t('h_vs_any', { p: (d.random.equity * 100).toFixed(1) })}</span></div>`;
    if (live && v.board.length >= 3 && v.board.length < 5 && d.outs && d.outs.count) {
      const left = 52 - me.hole.length - v.board.length;
      const next = d.outs.count / left;
      const toRiver = v.board.length === 3 ? 1 - (1 - d.outs.count / left) * (1 - d.outs.count / (left - 1)) : next;
      h += `<div class="line"><span>${t('h_outs', { n: d.outs.count })}</span><b>${t('h_next', { p: Math.round(next * 100) })}${v.board.length === 3 ? ' · ' + t('h_river', { p: Math.round(toRiver * 100) }) : ''}</b></div>`;
    }
    if (live && toCall > 0 && !me.allin && !me.folded) h += `<div class="line"><span>${t('h_call', { a: fmt(toCall), b: fmt(v.pot) })}</span><b>${t('h_need', { p: Math.round(potOdds(toCall, v.pot) * 100) })}</b></div>`;
    if (v.board.length < 5 && d.range.categories) {
      h += `<div class="more" id="tglProbs">${t(st.showProbs ? 'h_less' : 'h_more')}</div>`;
      if (st.showProbs) h += '<div class="probs">' + d.range.categories.map((p, i) => p > 0.0005 ? `<span>${t('cat_' + i)}</span><i style="width:${Math.max(1, p * 100)}%"></i><span>${(p * 100).toFixed(1)}%</span>` : '').reverse().join('') + '</div>';
    }
    h += `</div>`;
  }
  // тренер (на телефоне показан в строке совета, здесь — подсветка кнопки и блок для компьютера)
  if (d && d.range && !stale && st.prefs.coach && v.legal && v.toAct === me.seat) {
    const c = coach({ eq: d.range.equity, toCall, pot: v.pot, players: oppSeats.length + 1, outs: d.outs?.count || 0, street: v.street, canRaise: v.legal.canRaise, stackBB: me.chips / v.blinds[1] });
    const actTxt = c.act === 'raise' ? t('ca_raise', { p: Math.round(c.size * 100) }) : t('ca_' + c.act);
    coachEl.innerHTML = `<b>🎓 ${t('coach_title')}</b> ${esc(actTxt)} — ${esc(t('why_' + c.why))}`;
    coachEl.classList.remove('hidden');
    st.coachAct = c;
  }
  setHTML(el, h);
  el.classList.toggle('detail', detail);
  el.classList.toggle('stale', stale);
  $('#tglDetail').onclick = () => { st.prefs.detail = !st.prefs.detail; LS.set('rp_prefs', st.prefs); renderHints(st.view, mySeatObj(st.view)); };
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
    st.allinEq = null;
    compute({ type: 'allin', hands: ps.map(p => p.hole), board: v.board, variant: v.settings.variant }, res => {
      if (st.allinKey !== key || !res.eq) return;
      st.allinEq = {};
      ps.forEach((p, i) => st.allinEq[p.id] = res.eq[i]);
      render();
    });
  }
  return st.allinEq;
}

// ---------- кнопки действий ----------
function renderActions(v, me) {
  const el = $('#actions');
  $('#dockRight').classList.toggle('raising', !!(st.raiseOpen && v.legal));
  $('#hud').classList.toggle('raising', !!(st.raiseOpen && v.legal));
  $('#game').classList.toggle('raising', !!(st.raiseOpen && v.legal));
  $('#game').classList.toggle('prestart', !v.handNo);
  const host = st.ctl?.isHost();
  if (v.tourOver) {
    setHTML(el, `<div class="row">${host ? `<button class="btn gold" id="aNewTour">${t('b_newtour')}</button>` : ''}<button class="btn ghost" id="aPlaces">${t('b_results')}</button></div>`);
    if ($('#aNewTour')) $('#aNewTour').onclick = () => st.ctl.newTournament();
    $('#aPlaces').onclick = () => showTourOver(v.places, v.prizes);
    return;
  }
  if (!v.handNo || (v.phase === 'idle' && host && !st.ctl.started)) {
    if (host) {
      setHTML(el, `<div class="row">
          <select id="aBotStyle" style="flex:1.3">${Object.keys(BOT_STYLES).map(k => `<option value="${k}" ${k === st.hostStyle ? 'selected' : ''}>${t('bot_' + k)}</option>`).join('')}</select>
          <button class="btn ghost" id="aAddBot">${t('b_add_bot')}</button>
        </div>
        <div class="row"><button class="btn ghost" id="aShare">${t('b_invite')}</button><button class="btn gold" id="aStart">${t('b_start')}</button></div>`);
      $('#aBotStyle').onchange = e => st.hostStyle = e.target.value;
      $('#aAddBot').onclick = () => st.ctl.addBot(st.hostStyle);
      $('#aStart').onclick = () => st.ctl.start();
      $('#aShare').onclick = share;
    } else setHTML(el, `<div class="wait-msg">${t('w_wait_host')}</div>`);
    return;
  }
  if (!me) { setHTML(el, `<div class="wait-msg">${t('w_watch')}</div>`); return; }
  // ананас: выбор сброса
  if (v.phase === 'discard') {
    if (me.needDiscard) {
      const rec = st.hints?.keeps?.[0];
      setHTML(el, `<div class="discard-box"><b>${t('discard_title')}</b><span>${t('discard_hint')}</span>${rec && v.settings.hints ? `<span class="rec">${t('discard_rec', { c: cardText(rec.drop) })}</span>` : ''}</div>`);
    } else setHTML(el, `<div class="wait-msg">${t('discard_wait')}</div>`);
    return;
  }
  // нет фишек
  if ((me.chips <= 0 && !(me.inHand && v.phase !== 'over' && v.phase !== 'idle')) || me.out) {
    const canRebuy = v.settings.mode === 'cash' || (me.canRebuy && v.rebuyOpen);
    if (canRebuy) {
      setHTML(el, `<button class="btn gold big" id="aRebuy">${t('b_rebuy', { a: fmt(v.settings.startChips) })}</button>`);
      $('#aRebuy').onclick = () => st.ctl.send({ t: 'rebuy' });
    } else setHTML(el, `<div class="wait-msg">${me.place ? t('w_out_place', { p: me.place }) : t('w_out')}</div>`);
    return;
  }
  if (me.sitOut) {
    setHTML(el, `<div class="wait-msg">${t('w_sitout')}</div><button class="btn green big" id="aBack">${t('b_back_table')}</button>`);
    $('#aBack').onclick = () => st.ctl.send({ t: 'sitout', v: false });
    return;
  }
  const L = v.legal;
  if (L && v.toAct === me.seat) {
    if (st.raiseOpen && L.canRaise) return renderRaise(v, L);
    const callTxt = L.canCheck ? t('b_check') : (L.toCall >= me.chips ? t('b_allin_call', { a: fmt(L.toCall) }) : t('b_call', { a: fmt(L.toCall) }));
    const rec = st.coachAct ? (st.coachAct.act === 'raise' || st.coachAct.act === 'allin' ? 'aRaise' : st.coachAct.act === 'fold' ? 'aFold' : 'aCall') : '';
    setHTML(el, `<div class="row">
      <button class="btn red ${rec === 'aFold' ? 'rec' : ''}" id="aFold">${t('b_fold')}<kbd>F</kbd></button>
      <button class="btn green ${rec === 'aCall' ? 'rec' : ''}" id="aCall">${callTxt}<kbd>C</kbd></button>
      ${L.canRaise ? `<button class="btn gold ${rec === 'aRaise' ? 'rec' : ''}" id="aRaise">${t(L.currentBet === 0 ? 'b_bet' : 'b_raise')}<kbd>R</kbd></button>` : ''}
    </div>`);
    // фолд, когда можно бесплатно чекнуть, — подтверждается вторым нажатием
    const armFold = () => { const b = $('#aFold'); if (b) { b.classList.add('armed'); b.innerHTML = `${t('fold_sure')}<kbd>F</kbd>`; el._h = null; } };
    if (st.foldArmed) armFold();
    $('#aFold').onclick = () => {
      if (L.canCheck && !st.foldArmed) {
        st.foldArmed = true; armFold(); if (navigator.vibrate) try { navigator.vibrate(20); } catch { /* */ }
        clearTimeout(st.foldT);
        st.foldT = setTimeout(() => { st.foldArmed = false; if (st.view) renderActions(st.view, mySeatObj()); }, 2500);
        return;
      }
      st.foldArmed = false; clearTimeout(st.foldT); act('fold');
    };
    $('#aCall').onclick = () => act(L.canCheck ? 'check' : 'call');
    if (L.canRaise) $('#aRaise').onclick = () => {
      st.raiseOpen = true;
      st.raiseVal = st.coachAct && st.coachAct.size ? Math.round(L.currentBet + (L.pot + L.toCall) * st.coachAct.size) : L.minTo;
      renderActions(st.view, mySeatObj());
    };
    return;
  }
  // конец раздачи: показать карты, разбор
  if (v.phase === 'over') {
    const btns = [];
    if (me.inHand && me.hole && me.hole.length && !(v.lastResult?.shown || {})[me.id]) btns.push(`<button class="btn ghost" id="aShow">${t('b_show')}</button>`);
    if (st.lastReview && st.lastReview.handNo === v.handNo) btns.push(`<button class="btn ghost" id="aReview">${t('b_review')}</button>`);
    btns.push(`<button class="btn ghost" id="aSit">${t('b_sitout')}</button>`);
    setHTML(el, `<div class="row">${btns.join('')}</div>`);
    if ($('#aShow')) $('#aShow').onclick = () => st.ctl.send({ t: 'show' });
    if ($('#aReview')) $('#aReview').onclick = () => openReview(st.lastReview);
    $('#aSit').onclick = () => st.ctl.send({ t: 'sitout', v: true });
    return;
  }
  if (me.inHand && !me.folded && !me.allin && v.phase === 'betting') {
    const pa = st.preAction;
    setHTML(el, `<div class="pre-acts">
      <label><input type="checkbox" data-pa="checkfold" ${pa === 'checkfold' ? 'checked' : ''}> ${t('pre_cf')}</label>
      <label><input type="checkbox" data-pa="check" ${pa === 'check' ? 'checked' : ''}> ${t('pre_check')}</label>
      <label><input type="checkbox" data-pa="callany" ${pa === 'callany' ? 'checked' : ''}> ${t('pre_callany')}</label>
    </div>`);
    $$('#actions input[data-pa]').forEach(i => i.onchange = () => { st.preAction = i.checked ? i.dataset.pa : null; renderActions(st.view, mySeatObj()); });
    return;
  }
  let txt = t('w_next');
  if (me.allin && me.inHand) txt = t('w_allin');
  else if (me.folded && me.inHand) txt = t('w_folded');
  if (host && st.ctl.paused) txt = t('w_paused');
  setHTML(el, `<div class="row"><div class="wait-msg" style="flex:3">${txt}</div><button class="btn ghost sm" id="aSit" style="flex:1">${t('b_sitout')}</button></div>`);
  $('#aSit').onclick = () => st.ctl.send({ t: 'sitout', v: true });
}

function renderRaise(v, L) {
  const el = $('#actions');
  const pot = L.pot + L.toCall;
  const clamp = x => Math.max(L.minTo, Math.min(L.maxTo, Math.round(x)));
  const presets = [
    [t('p_min'), L.minTo], [t('p_half'), clamp(L.currentBet + pot / 2)], [t('p_34'), clamp(L.currentBet + pot * 0.75)],
    [t('p_pot'), clamp(L.currentBet + pot)], [L.maxTo < L.allinTo ? t('p_max') : t('p_allin'), L.maxTo]
  ];
  if (v.street === 'preflop' && L.currentBet <= v.blinds[1]) {
    presets[1] = [t('p_bb', { n: 2.5 }), clamp(v.blinds[1] * 2.5)]; presets[2] = [t('p_bb', { n: 3 }), clamp(v.blinds[1] * 3)];
  }
  const step = Math.max(1, v.blinds[0]);
  st.raiseVal = clamp(st.raiseVal);
  const label = val => val >= L.allinTo ? t('amt_allin', { a: fmt(val) }) : t(L.currentBet === 0 ? 'amt_bet' : 'amt_raise', { a: fmt(val) });
  const isAllin = st.raiseVal >= L.allinTo;
  setHTML(el, `<div class="raise-box">
    <div class="amt">${label(st.raiseVal)}</div>
    ${L.limit === 'pl' ? `<div class="hint">${t('amt_pl', { a: fmt(L.maxTo) })}</div>` : ''}
    <div class="row r-slider" style="gap:6px">
      <button class="btn ghost sm" id="rMinus" style="flex:none;width:44px">−</button>
      <input type="range" id="rSlider" min="${L.minTo}" max="${L.maxTo}" step="${step}" value="${st.raiseVal}">
      <button class="btn ghost sm" id="rPlus" style="flex:none;width:44px">+</button>
    </div>
    <div class="presets">${presets.map(([tx, val], i) => `<button class="btn ghost" data-v="${val}">${tx}<kbd>${i + 1}</kbd></button>`).join('')}</div>
    <div class="row r-go"><button class="btn ghost" id="rBack">${t('b_back')}<kbd>Esc</kbd></button><button class="btn gold" id="rGo">${goLabel(isAllin)}</button></div>
  </div>`);
  const upd = val => { st.raiseVal = clamp(val); renderRaise(st.view, st.view.legal); };
  const nudge = (dir, big) => upd(st.raiseVal + dir * step * 2 * (big ? 5 : 1));
  $('#rSlider').oninput = e => {
    st.raiseVal = clamp(+e.target.value);
    el.querySelector('.amt').textContent = label(st.raiseVal);
    $('#rGo').innerHTML = goLabel(st.raiseVal >= L.allinTo);
    el._h = null;
    SND.tick();
  };
  $('#rMinus').onclick = () => nudge(-1);
  $('#rPlus').onclick = () => nudge(1);
  $$('.presets .btn').forEach(b => b.onclick = () => upd(+b.dataset.v));
  $('#rBack').onclick = () => { st.raiseOpen = false; renderActions(st.view, mySeatObj()); };
  const go = () => act(st.raiseVal >= L.allinTo ? 'allin' : 'raise', st.raiseVal);
  $('#rGo').onclick = go;
  // колесо мыши над панелью ставки меняет размер (с Shift — крупнее)
  el.querySelector('.raise-box').onwheel = e => { e.preventDefault(); nudge(e.deltaY < 0 ? 1 : -1, e.shiftKey); };
  st.raiseCtl = { go, nudge, preset: i => presets[i] && upd(presets[i][1]) };
}
const goLabel = allin => `${t(allin ? 'b_allin' : 'b_confirm')}<kbd>Enter</kbd>`;

// ---------- горячие клавиши (по физическим клавишам — работает в любой раскладке) ----------
function onHotkey(e) {
  if (!st.ctl || !st.view || $('#game').classList.contains('hidden')) return;
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = (tag === 'input' && e.target.type !== 'range' && e.target.type !== 'checkbox') || tag === 'textarea' || tag === 'select';
  const modalOpen = !$('#modal').classList.contains('hidden');
  if (e.code === 'Escape') {
    if (modalOpen) return closeModal();
    if (typing) return e.target.blur();
    if (st.raiseOpen) { st.raiseOpen = false; return renderActions(st.view, mySeatObj()); }
    if (st.drawer && !isDesk()) return closeDrawer();
    return;
  }
  if (typing || modalOpen || e.ctrlKey || e.metaKey || e.altKey) return;
  // пробел/Enter на кнопке в фокусе не должны срабатывать дважды
  if (tag === 'button' && (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter')) e.preventDefault();
  const v = st.view, me = mySeatObj(v);
  const L = me && v.legal && v.toAct === me.seat ? v.legal : null;
  if (L && st.raiseOpen && st.raiseCtl) {
    if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); return st.raiseCtl.go(); }
    if (['ArrowUp', 'ArrowRight', 'Equal', 'NumpadAdd'].includes(e.code)) { e.preventDefault(); return st.raiseCtl.nudge(1, e.shiftKey); }
    if (['ArrowDown', 'ArrowLeft', 'Minus', 'NumpadSubtract'].includes(e.code)) { e.preventDefault(); return st.raiseCtl.nudge(-1, e.shiftKey); }
    const m = /^(Digit|Numpad)([1-5])$/.exec(e.code);
    if (m) return st.raiseCtl.preset(+m[2] - 1);
  }
  if (L) {
    if (e.code === 'KeyF') return $('#aFold')?.click();
    if (e.code === 'KeyC' || e.code === 'Space') { e.preventDefault(); return $('#aCall')?.click(); }
    if (e.code === 'KeyR' && !st.raiseOpen) return $('#aRaise')?.click();
  }
  // Enter — написать в чат (на компьютере)
  if ((e.code === 'Enter' || e.code === 'NumpadEnter') && isDesk()) { e.preventDefault(); setDockTab('chat'); $('#chatIn').focus(); }
}

// ---------- таймеры (кольцо хода, уровень блайндов) ----------
function tickTimers() {
  const v = st.view; if (!v) return;
  const now = Date.now() + st.clockOffset;
  const ring = document.querySelector('.tring');
  if (ring && v.settings.actionTimer > 0 && v.toAct >= 0) {
    const base = v.settings.actionTimer * 1000;
    const el = now - v.turnStartedAt;
    const tb = +(ring.dataset.tb || 0) * 1000;
    if (el <= base) {
      const frac = Math.min(1, el / base);
      ring.setAttribute('stroke-dashoffset', String(100.5 * frac));
      ring.setAttribute('stroke', frac > 0.75 ? 'var(--red)' : 'var(--yellow)');
    } else {
      const frac = tb ? Math.min(1, (el - base) / tb) : 1;
      ring.setAttribute('stroke-dashoffset', String(100.5 * frac));
      ring.setAttribute('stroke', 'var(--purple)');
    }
    const me = mySeatObj(v);
    if (me && v.toAct === me.seat && el > base - 5000 && el < base && Math.floor(el / 1000) !== st._lastTick) { st._lastTick = Math.floor(el / 1000); SND.tick(); }
  }
  const lt = $('#lvlTimer');
  if (lt && v.settings.mode === 'tournament' && v.nextLevelAt && !v.tourOver) {
    const left = Math.max(0, v.nextLevelAt - now);
    const m = Math.floor(left / 60000), s = Math.floor(left / 1000) % 60;
    lt.textContent = `${t('lvl', { n: v.level })} · ${m}:${String(s).padStart(2, '0')}`;
  }
}
setInterval(tickTimers, 250);

// ---------- чат, лог, эмодзи ----------
function chatText(m) { return m.sys ? t(m.key, m.params) : m.text; }
function addChat(m) {
  st.chat.push(m);
  if (st.chat.length > 200) st.chat.shift();
  if (!m.sys && m.id !== st.view?.you) {
    floatAt(m.id, m.text, true);
    if (st.drawer !== 'chat') { st.chatUnread++; for (const b of [$('#chatBadge'), $('#dockBadge')]) { b.textContent = st.chatUnread; b.classList.remove('hidden'); } }
  }
  if (st.drawer === 'chat') renderChat();
}
function addLog(x) { st.log.push(x); if (st.log.length > 300) st.log.shift(); if (st.drawer === 'log') renderLog(); }
function renderChat() {
  const el = $('#chatList');
  el.innerHTML = st.chat.map(m => m.sys ? `<div class="m sys">${esc(chatText(m))}</div>` : `<div class="m ${m.id === st.view?.you ? 'me' : ''}"><b>${esc(m.name)}:</b> ${esc(m.text)}</div>`).join('') || `<div class="m sys">${t('no_msgs')}</div>`;
  el.scrollTop = el.scrollHeight;
}
function renderLog() { const el = $('#logList'); el.innerHTML = st.log.map(x => `<div class="m">${esc(x)}</div>`).join(''); el.scrollTop = el.scrollHeight; }

function openDrawer(kind) {
  st.drawer = kind;
  $('#drawer').classList.remove('hidden');
  $('#drawerTitle').textContent = t(kind === 'chat' ? 'chat_title' : 'log_title');
  $('#chatList').classList.toggle('hidden', kind !== 'chat');
  $('#logList').classList.toggle('hidden', kind !== 'log');
  $('#chatForm').classList.toggle('hidden', kind !== 'chat');
  $('#emojiRow').classList.toggle('hidden', kind !== 'chat');
  if (kind === 'chat') { st.chatUnread = 0; $('#chatBadge').classList.add('hidden'); $('#dockBadge').classList.add('hidden'); renderChat(); } else renderLog();
}
function closeDrawer() {
  if (isDesk()) return setDockTab('hints');
  st.drawer = null; $('#drawer').classList.add('hidden');
}

function floatAt(id, content, isMsg = false) {
  const v = st.view; if (!v) return;
  let x = 50, y = 80;
  const p = v.seats.find(s => s && s.id === id);
  if (p) { [x, y] = posFor(v)[p.seat] || P.t; if (p.id === v.you) y = 72; }
  const f = document.createElement('div');
  f.className = 'floater' + (isMsg ? ' msg' : '');
  f.style.left = x + '%'; f.style.top = (y - 6) + '%';
  f.textContent = isMsg ? String(content).slice(0, 80) : content;
  $('#floaters').appendChild(f);
  setTimeout(() => f.remove(), isMsg ? 3600 : 2300);
}
function sendEmoji(e) { st.ctl && st.ctl.send({ t: 'emoji', e }); }

// ---------- окна ----------
// подтверждение в окне приложения вместо системного диалога браузера
function ask(text) {
  return new Promise(res => {
    modal(`<h2 class="ask-title">${esc(text)}</h2><div class="row ask-row"><button class="btn ghost" id="askNo">${t('ask_cancel')}</button><button class="btn red" id="askYes">${t('ask_ok')}</button></div>`);
    $('#askNo').onclick = () => { closeModal(); res(false); };
    $('#askYes').onclick = () => { closeModal(); res(true); };
  });
}
function modal(html) { $('#modalBody').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); }
let toastT = null;
function toast(x) { const el = $('#toast'); el.textContent = x; el.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), 3200); }

function share() {
  if (!st.ctl || st.ctl.offline) return toast(t('toast_train_invite'));
  const code = st.ctl.code;
  const url = `${location.origin}${location.pathname}?room=${code}`;
  const text = t('share_text', { c: code });
  if (navigator.share) navigator.share({ title: t('title'), text, url }).catch(() => {});
  else navigator.clipboard?.writeText(`${text}\n${url}`).then(() => toast(t('toast_copied')), () => toast(t('toast_code', { c: code })));
}

function openMenu() {
  const host = st.ctl?.isHost();
  modal(`<h2>${t('menu')}</h2><div class="menu-list">
    <button class="btn ghost" id="mShare">${t('m_invite', { c: esc($('#roomCode').textContent) })}</button>
    <button class="btn ghost" id="mHist">${t('m_history')}</button>
    <button class="btn ghost" id="mStats">${t('m_stats')}</button>
    <button class="btn ghost" id="mRules">${t('m_rules')}</button>
    <button class="btn ghost" id="mFair">${t('m_fair')}</button>
    <button class="btn ghost" id="mSettings">${t('m_settings')}</button>
    ${host && st.ctl.started ? `<button class="btn ghost" id="mPause">${t(st.ctl.paused ? 'm_resume' : 'm_pause')}</button>` : ''}
    ${host ? `<button class="btn ghost" id="mBot">${t('m_bot')}</button>` : ''}
    <button class="btn red" id="mLeave">${t(host ? 'm_close' : 'm_leave')}</button>
  </div>`);
  $('#mShare').onclick = share;
  $('#mHist').onclick = openHistory;
  $('#mStats').onclick = openStats;
  $('#mRules').onclick = openRules;
  $('#mFair').onclick = openFair;
  $('#mSettings').onclick = openSettings;
  if ($('#mPause')) $('#mPause').onclick = () => { st.ctl.togglePause(); closeModal(); };
  if ($('#mBot')) $('#mBot').onclick = () => { st.ctl.addBot(st.hostStyle); closeModal(); };
  $('#mLeave').onclick = async () => { if (await ask(t(host ? 'confirm_close' : 'confirm_leave'))) leaveGame(); };
}

function openSettings() {
  const p = st.prefs;
  const ice = LS.get('rp_ice', {}) || {};
  const seg = (id, vals, cur) => `<div class="seg" id="${id}">${vals.map(([v, l]) => `<button data-v="${v}" class="${v === cur ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const sw = (id, key, on) => `<div class="switch"><span>${t(key)}</span><input type="checkbox" id="${id}" ${on ? 'checked' : ''}></div>`;
  modal(`<h2>${t('set_title')}</h2>
    <label class="lbl">${t('set_lang')}</label>${seg('sLang', [['ru', 'Русский'], ['kk', 'Қазақша'], ['en', 'English']], p.lang)}
    <h3>${t('set_avatar')}</h3>
    <div class="ava-grid">${AVATARS.map(a => `<button data-a="${a}" class="${a === p.avatar ? 'on' : ''}">${a}</button>`).join('')}
      <label class="btn ghost sm photo-btn">${t('avatar_photo')}<input type="file" accept="image/*" capture="user" id="sPhoto" hidden></label></div>
    ${p.avatar && p.avatar.startsWith('data:') ? `<div class="row"><img src="${esc(p.avatar)}" class="ava-prev"><button class="btn ghost sm" id="sAvaReset">${t('avatar_reset')}</button></div>` : ''}
    <h3>${t('set_felt')}</h3>${seg('sFelt', ['green', 'blue', 'red', 'graphite'].map(f => [f, t('felt_' + f)]), p.felt)}
    <h3>${t('set_back')}</h3>${seg('sBack', ['red', 'blue', 'black'].map(f => [f, t('back_' + f)]), p.back)}
    <div class="settings-sw">
      ${sw('s4', 'set_4color', p.four)}${sw('sSound', 'set_sound', p.sound)}${sw('sVib', 'set_vibro', p.vibrate)}
      ${sw('sDetail', 'set_detail', p.detail)}${sw('sHud', 'set_hud', p.hud)}${sw('sCoach', 'set_coach', p.coach)}${sw('sNotify', 'set_notify', p.notify)}
    </div>
    <h3>${t('set_turn')}</h3><p class="hint" style="text-align:left">${t('turn_hint')}</p>
    <div class="form-grid"><input class="full" id="sTurnUrl" placeholder="${t('turn_url')}" value="${esc(ice.url || '')}">
      <input id="sTurnUser" placeholder="${t('turn_user')}" value="${esc(ice.user || '')}"><input id="sTurnPass" type="password" placeholder="${t('turn_pass')}" value="${esc(ice.pass || '')}"></div>
    <button class="btn gold big" id="sSave" style="margin-top:12px">${t('save')}</button>`);
  const bindSeg = (id, key) => $$(`#${id} button`).forEach(b => b.onclick = () => { $$(`#${id} button`).forEach(x => x.classList.toggle('on', x === b)); p[key] = b.dataset.v; if (key === 'lang') { savePrefs(); openSettings(); } else savePrefs(); });
  bindSeg('sLang', 'lang'); bindSeg('sFelt', 'felt'); bindSeg('sBack', 'back');
  $$('.ava-grid button[data-a]').forEach(b => b.onclick = () => { p.avatar = b.dataset.a; savePrefs(); pushAvatar(); openSettings(); });
  if ($('#sAvaReset')) $('#sAvaReset').onclick = () => { p.avatar = AVATARS[0]; savePrefs(); pushAvatar(); openSettings(); };
  $('#sPhoto').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = 96;
      const s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 96, 96);
      p.avatar = c.toDataURL('image/jpeg', 0.72);
      URL.revokeObjectURL(img.src);
      savePrefs(); pushAvatar(); openSettings();
    };
    img.src = URL.createObjectURL(f);
  };
  $('#sNotify').onchange = async e => {
    if (e.target.checked && 'Notification' in window && Notification.permission !== 'granted') {
      const r = await Notification.requestPermission().catch(() => 'denied');
      if (r !== 'granted') { e.target.checked = false; toast(t('notify_denied')); }
    }
  };
  $('#sSave').onclick = () => {
    Object.assign(p, { detail: $('#sDetail').checked, four: $('#s4').checked, sound: $('#sSound').checked, vibrate: $('#sVib').checked, hud: $('#sHud').checked, coach: $('#sCoach').checked, notify: $('#sNotify').checked });
    LS.set('rp_ice', { url: $('#sTurnUrl').value.trim(), user: $('#sTurnUser').value.trim(), pass: $('#sTurnPass').value });
    savePrefs(); closeModal(); toast(t('saved'));
  };
}
function pushAvatar() {
  if (!st.ctl || !st.view) return;
  if (st.ctl.isHost()) { st.ctl.avatars[st.ctl.myId] = st.prefs.avatar; st.ctl._bcast({ t: 'avatars', map: st.ctl.avatars }); }
  else st.ctl.send({ t: 'profile', avatar: st.prefs.avatar });
}

function openStats() {
  const { players, tournaments } = getStats();
  const rows = players.map((p, i) => `<tr><td>${i + 1}</td><td>${p.bot ? '🤖 ' : ''}${esc(p.name)}</td><td>${p.rating}</td><td>${p.hands}</td><td>${p.winPct}%</td><td>${p.vpipPct}/${p.pfrPct}</td><td>${p.af}</td><td class="${p.net >= 0 ? 'pos' : 'neg'}">${p.net >= 0 ? '+' : ''}${fmt(p.net)}</td><td>${p.tourWins}/${p.tours}</td></tr>`).join('');
  modal(`<h2>${t('st_title')}</h2>
    ${players.length ? `<div style="overflow-x:auto"><table class="stats"><tr><th>#</th><th>${t('col_player')}</th><th>${t('col_elo')}</th><th>${t('col_hands')}</th><th>${t('col_wins')}</th><th>${t('col_vpip')}</th><th>AF</th><th>${t('col_chips')}</th><th>${t('col_tours')}</th></tr>${rows}</table></div>
    <p class="hint">${t('st_legend')}</p>
    <h3>${t('st_styles')}</h3>${players.filter(p => p.hands >= 20).map(p => `<div class="hint" style="text-align:left">${esc(t('st_style_line', { name: p.name, style: t(p.style), sd: p.sdPct, big: fmt(p.biggestPot) }))}</div>`).join('') || `<p class="hint">${t('st_need20')}</p>`}
    ${tournaments.length ? `<h3>${t('st_recent')}</h3>${tournaments.slice(0, 8).map(x => `<div class="hint" style="text-align:left">${new Date(x.at).toLocaleDateString()}: ${x.places.slice(0, 3).map(p => `${p.place}. ${esc(p.name)}`).join(', ')}</div>`).join('')}` : ''}
    <button class="btn ghost" id="sReset" style="margin-top:12px">${t('st_reset')}</button>` : `<p class="hint">${t('st_empty')}</p>`}`);
  if ($('#sReset')) $('#sReset').onclick = async () => { if (await ask(t('st_reset_confirm'))) { resetStats(); st.statsCache = null; } openStats(); };
}

function openRules() {
  const ex = [
    [9, 'As Ks Qs Js Ts', 0.000032], [8, '9h 8h 7h 6h 5h', 0.000279], [7, 'Qc Qd Qh Qs 7d', 0.00168], [6, 'Kd Kc Kh 4s 4d', 0.026],
    [5, 'Ad Jd 8d 5d 2d', 0.0303], [4, 'Tc 9d 8s 7h 6c', 0.0462], [3, '7c 7d 7h Ks 2d', 0.0483], [2, 'Jc Jd 4h 4s Ad', 0.235],
    [1, 'Th Td Ac 8s 3d', 0.438], [0, 'Ac Qd 9h 6s 3c', 0.174]
  ];
  modal(`<h2>${t('rules_title')}</h2><div class="rank-list">${ex.map(([c, cs, p]) => `<div class="rank-item"><div class="cards-mini">${cs.split(' ').map(s => cardHTML(cardFromStr(s), 'sm')).join('')}</div><div><div class="nm">${t('cat_' + c)}</div><div class="pr">${t('prob7', { p: (p * 100).toFixed(p < 0.001 ? 4 : 1) })}</div></div></div>`).join('')}</div>
  <h3>${t('rules_h')}</h3>
  <p class="hint" style="text-align:left">${t('rules_text')}</p><p class="hint" style="text-align:left">${t('rules_omaha')}</p><p class="hint" style="text-align:left">${t('rules_pine')}</p>
  <h3>${t('hints_h')}</h3><p class="hint" style="text-align:left">${t('hints_text')}</p>
  ${isDesk() ? `<h3>${t('kb_title')}</h3><p class="hint" style="text-align:left">${t('kb_text')}</p>` : ''}`);
}

function openFair() {
  const v = st.view;
  let status = t('fair_none');
  if (st.fairLast) status = st.fairLast.ok ? t('fair_last_ok', { n: st.fairLast.handNo }) : t('fair_last_bad', { n: st.fairLast.handNo, r: t('r_' + st.fairLast.reason) });
  modal(`<h2>${t('fair_title')}</h2><p class="hint" style="text-align:left">${t('fair_text')}</p>
    <p><b>${st.ctl?.offline ? t('fair_bots') : status}</b></p>
    ${v && v.commitNext ? `<p class="hint mono">${t('fair_commit', { h: v.commitNext.slice(0, 24) + '…' })}</p>` : ''}`);
}

function showTourOver(places, prizes) {
  modal(`<h2>${t('tour_results')}</h2><ol class="places">${places.map(p => `<li>${esc(t('place_line', { name: p.name, p: p.place }))}</li>`).join('')}</ol>
    ${prizes && prizes.length ? `<div class="prizes">${prizes.map(z => `<div>${esc(t('prize_line', { p: z.place, name: z.name || '—', pct: z.pct, a: fmt(z.amount) }))}</div>`).join('')}</div>` : ''}
    <p class="hint">${t('elo_updated')}</p>`);
}

// ---------- история и разбор раздач ----------
function openHistory() {
  const list = listHands();
  modal(`<h2>${t('hist_title')}</h2>${list.length ? `<div class="hist-list">${list.map((h, i) => {
    const bad = (h.review || []).filter(x => x.kind === 'bad_fold' || x.kind === 'bad_call').length;
    return `<button class="hist-item" data-i="${i}"><span class="cards-mini">${(h.myHole || []).map(c => cardHTML(c, 'sm')).join('')}</span>
      <span class="hi-main">${t('hist_item', { n: h.handNo, time: new Date(h.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}${bad ? ' · ⚠ ' + bad : ''}</span>
      <span class="${h.net >= 0 ? 'pos' : 'neg'}">${h.net >= 0 ? t('hist_won', { a: fmt(h.net) }) : t('hist_lost', { a: fmt(-h.net) })}</span></button>`;
  }).join('')}</div>` : `<p class="hint">${t('hist_empty')}</p>`}`);
  $$('.hist-item').forEach(b => b.onclick = () => openReview(list[+b.dataset.i]));
}

function openReview(h) {
  if (!h) return;
  const steps = h.events;
  let si = steps.length;
  const boardAt = i => { let b = []; for (let k = 0; k < i; k++) if (steps[k].t === 'street') b = steps[k].board; return k => b[k]; };
  const decHTML = () => {
    if (!h.decisions.length) return `<p class="hint">${t('rev_no_decisions')}</p>`;
    if (!h.review) return `<p class="hint">${t('rev_calc')}</p>`;
    const bad = h.review.filter(x => x.kind === 'bad_fold' || x.kind === 'bad_call');
    const sum = bad.length ? t('rev_summary', { n: bad.length, a: fmt(bad.reduce((a, x) => a + (x.ev || 0), 0)) }) : t('rev_clean');
    return `<div class="rev-sum">${sum}</div>` + h.decisions.map((d, i) => {
      const r = h.review[i];
      const need = d.toCall ? Math.round(potOdds(d.toCall, d.pot) * 100) : 0;
      const txt = { ok: t('rev_ok'), bad_fold: t('rev_bad_fold', { a: fmt(r.ev) }), bad_call: t('rev_bad_call', { a: fmt(r.ev) }), missed: t('rev_missed'), bluff: t('rev_bluff', { p: Math.round(r.eq * 100) }), value: t('rev_value') }[r.kind];
      const actT = actionText({ t: d.action === 'raise' ? (d.amount ? 'raise' : 'bet') : d.action, a: d.amount || d.toCall });
      return `<div class="rev-item ${r.kind}" data-ev="${d.evIdx}"><div><b>${t('s_' + d.street)}</b> · ${esc(actT)} <small>${t('rev_eq', { p: Math.round(r.eq * 100) })}${d.toCall ? ' · ' + t('rev_need', { p: need }) : ''}</small></div><div>${txt}</div></div>`;
    }).join('');
  };
  const draw = () => {
    const b = boardAt(si);
    const ev = steps.slice(0, si).filter(s => s.t === 'act').slice(-6);
    $('#revBody').innerHTML = `
      <div class="rev-cards"><div><div class="lbl">${t('your_cards')}</div><div class="cards-mini">${(h.myHole || []).map(c => cardHTML(c, 'sm')).join('')}</div></div>
      <div><div class="lbl">${t('board')}</div><div class="cards-mini">${[0, 1, 2, 3, 4].map(k => b(k) != null ? cardHTML(b(k), 'sm') : '<div class="card sm empty"></div>').join('')}</div></div></div>
      <div class="rev-steps">${ev.map(e => `<div>${esc(e.name)}: ${esc(actionText(e.action))}</div>`).join('')}</div>
      <div class="row"><button class="btn ghost sm" id="rvPrev">◀</button><span class="hint" style="flex:2">${t('step', { i: si, n: steps.length })}</span><button class="btn ghost sm" id="rvNext">▶</button></div>`;
    $('#rvPrev').onclick = () => { si = Math.max(0, si - 1); draw(); };
    $('#rvNext').onclick = () => { si = Math.min(steps.length, si + 1); draw(); };
  };
  modal(`<h2>${t('rev_title', { n: h.handNo })}</h2>
    <div class="rev-win">${(h.winners || []).map(w => `🏆 ${esc(w.name)} +${fmt(w.amount)}${w.desc ? ' — ' + esc(handText(w.desc)) : ''}`).join('<br>')}</div>
    <div id="revDec">${decHTML()}</div><h3>${t('replay')}</h3><div id="revBody"></div>`);
  draw();
  $$('.rev-item').forEach(x => x.onclick = () => { si = Math.min(steps.length, +x.dataset.ev + 1); draw(); });
  if (h.decisions.length && !h.review) {
    compute({ type: 'review', decisions: h.decisions }, res => {
      if (!res.eqs) return;
      h.review = h.decisions.map((d, i) => ({ eq: res.eqs[i], ...verdict(d, res.eqs[i]) }));
      st.rec.update(h);
      if ($('#revDec')) $('#revDec').innerHTML = decHTML();
    });
  }
}

// ---------- привязка кнопок ----------
function initGameUI() {
  rememberHomes();
  $$('.dock-tabs button').forEach(b => b.onclick = () => setDockTab(b.dataset.tab));
  $('#btnHistTop').onclick = openHistory;
  $('#btnStatsTop').onclick = openStats;
  $('#btnSettingsTop').onclick = openSettings;
  $('#btnSoundTop').onclick = () => { st.prefs.sound = !st.prefs.sound; savePrefs(); };
  document.addEventListener('keydown', onHotkey);
  DESK_MQ.addEventListener('change', applyLayout);
  new ResizeObserver(() => { fitStage(); updateCompact(); placeHeroBits(); }).observe($('#tableWrap'));
  updateCompact();
  applyLayout();
  $('#btnMenu').onclick = openMenu;
  $('#btnFair').onclick = openFair;
  $('#btnCode').onclick = share;
  $('#btnChat').onclick = () => openDrawer('chat');
  $('#btnLog').onclick = () => openDrawer('log');
  $('#drawerClose').onclick = closeDrawer;
  $('#modalClose').onclick = closeModal;
  $('#modal').onclick = e => { if (e.target.id === 'modal') closeModal(); };
  $('#quickEmoji').onclick = e => { if (e.target.tagName === 'BUTTON') sendEmoji(e.target.textContent); };
  $('#emojiRow').onclick = e => { if (e.target.tagName === 'BUTTON') sendEmoji(e.target.textContent); };
  $('#chatForm').onsubmit = e => {
    e.preventDefault();
    const x = $('#chatIn').value.trim();
    if (x && st.ctl) st.ctl.send({ t: 'chat', text: x });
    $('#chatIn').value = '';
  };
  document.addEventListener('pointerdown', () => SND.unlock(), { once: true });
  window.addEventListener('beforeunload', e => { if (st.ctl && st.ctl.isHost() && !st.ctl.offline && st.ctl.started) { e.preventDefault(); e.returnValue = ''; } });
}

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

applyPrefs();
initLobby();
initGameUI();
window.__poker = st;
