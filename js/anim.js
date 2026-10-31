// Анимации поверх стола: полёт карт при раздаче, фишек в банк и банка к победителю
const fx = () => document.getElementById('fx');
const center = r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
export const animPrefs = { on: !matchMedia('(prefers-reduced-motion: reduce)').matches };

function fly(el, from, to, { dur = 420, delay = 0, scale0 = 0.6, scale1 = 1, rot = 0, fade = false } = {}) {
  if (!animPrefs.on) return Promise.resolve();
  el.style.left = '0px'; el.style.top = '0px';
  fx().appendChild(el);
  const w = el.offsetWidth / 2, h = el.offsetHeight / 2;
  const a = el.animate([
    { transform: `translate(${from.x - w}px, ${from.y - h}px) scale(${scale0}) rotate(${rot}deg)`, opacity: 1 },
    { transform: `translate(${to.x - w}px, ${to.y - h}px) scale(${scale1}) rotate(0deg)`, opacity: fade ? 0 : 1 }
  ], { duration: dur, delay, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'both' });
  // страховка: если вкладка была в фоне и анимация не доиграла — убираем элемент по таймеру
  setTimeout(() => el.remove(), dur + delay + 400);
  return a.finished.then(() => el.remove(), () => el.remove());
}

// раздача: рубашки летят из центра стола к местам игроков
export function animateDeal(targets, fromEl, perSeat) {
  if (!animPrefs.on || !fromEl) return 0;
  const from = center(fromEl.getBoundingClientRect());
  let i = 0;
  for (let r = 0; r < perSeat; r++) for (const el of targets) {
    const to = center(el.getBoundingClientRect());
    const c = document.createElement('div');
    c.className = 'card back fly';
    fly(c, from, to, { dur: 330, delay: i * 60, scale0: 0.5, rot: -25 + Math.random() * 50 });
    i++;
  }
  return i * 60 + 330;
}

// ставки улицы съезжаются в банк
export function animateBetsToPot(rects, potEl) {
  if (!animPrefs.on || !potEl || !rects.length) return;
  const to = center(potEl.getBoundingClientRect());
  rects.forEach((r, k) => {
    const c = document.createElement('div');
    c.className = 'chip-fly';
    fly(c, center(r), to, { dur: 450, delay: k * 40, fade: true });
  });
}

// фишка летит от игрока к месту ставки
export function animateBet(fromEl, toEl) {
  if (!animPrefs.on || !fromEl || !toEl) return;
  const c = document.createElement('div');
  c.className = 'chip-fly';
  fly(c, center(fromEl.getBoundingClientRect()), center(toEl.getBoundingClientRect()), { dur: 320 });
}

// банк уезжает к победителю(ям) стопкой фишек
export function animatePotToWinners(potEl, winnerEls) {
  if (!animPrefs.on || !potEl) return;
  const from = center(potEl.getBoundingClientRect());
  winnerEls.forEach((w, wi) => {
    const to = center(w.getBoundingClientRect());
    for (let k = 0; k < 6; k++) {
      const c = document.createElement('div');
      c.className = 'chip-fly';
      fly(c, { x: from.x + (Math.random() - 0.5) * 30, y: from.y + (Math.random() - 0.5) * 10 }, to, { dur: 650, delay: wi * 150 + k * 55, scale1: 0.8, fade: k > 3 });
    }
  });
}
