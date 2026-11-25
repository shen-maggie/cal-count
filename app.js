/* calcount: calorie tracking + intermittent fasting PWA. Data lives in localStorage on the device, with optional cloud sync (sync.js). */
'use strict';

// ---------- Storage ----------
const STORE_KEY = 'calcount_v1';
const APP_VERSION = '28';
const MEALS = [
  { id: 'breakfast', label: 'Breakfast' },
  { id: 'lunch', label: 'Lunch' },
  { id: 'dinner', label: 'Dinner' },
  { id: 'snacks', label: 'Snacks' },
];
const DEFAULT_STATE = {
  settings: {
    fastHours: 16,
    eatStart: '12:00',          // first meal time when the schedule is the same every day
    sameEveryDay: true,
    schedule: null,             // per weekday (0=Sun..6=Sat): {on, eat:'HH:MM'} first meal / end of fast that day
    calorieGoal: 1800,
    weeklyBudget: 0,            // 0 = daily goal x 7
    weekStart: 1,               // 1 = Monday, 0 = Sunday
    meals: { breakfast: true, lunch: true, dinner: true, snacks: true },
    streakFreeze: true,
    reminders: true,
    weightUnit: 'lb',
    sex: '',                    // 'female' | 'male' (for the calorie calculator)
    age: null,
    heightCm: null,
    activity: 1.2,              // activity multiplier, same levels as calculator.net
    goalRate: -1,               // weight change per week, in the weight unit (lb or kg); negative = lose
    autoGoal: false,            // keep the daily goal in sync with the calculator as weight changes
    theme: 'cocoa',             // cocoa | auto | spring | summer | autumn | winter
    aiProvider: 'gemini',       // 'gemini' (free tier) or 'claude' (paid API)
    geminiKey: '',
    geminiModel: 'gemini-3.1-flash-lite',
    apiKey: '',                 // Anthropic key
    aiModel: 'claude-opus-5-5',
  },
  fasts: [],        // {id, start, end|null, goalH}
  foods: [],        // {id, ts, date, meal, name, kcal, protein, carbs, fat, source}
  weights: [],      // {date, value}
  ingredients: [],  // {id, name, unit, kcalPerUnit, unitSize}  e.g. unit 'g', unitSize 100, kcal per 100 g
  recipes: [],      // {id, name, servings, items:[{ingId, qty}]}
  meta: { lastReminderDay: '', lastReminderFor: '', lastRecapWeek: '' },
};

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY));
    if (!raw) return structuredClone(DEFAULT_STATE);
    const s = { ...structuredClone(DEFAULT_STATE), ...raw };
    s.settings = { ...DEFAULT_STATE.settings, ...raw.settings, meals: { ...DEFAULT_STATE.settings.meals, ...(raw.settings || {}).meals } };
    s.meta = { ...DEFAULT_STATE.meta, ...raw.meta };
    if (!Array.isArray(s.settings.schedule) || s.settings.schedule.length !== 7) s.settings.schedule = Array.from({ length: 7 }, () => ({ on: true, eat: s.settings.eatStart || '12:00' }));
    return s;
  } catch { return structuredClone(DEFAULT_STATE); }
}
let S = load();
function save() { S.meta.updatedAt = Date.now(); localStorage.setItem(STORE_KEY, JSON.stringify(S)); if (typeof Cloud !== 'undefined') Cloud.changed(); }

// ---------- Color themes ----------
const THEMES = {
  cocoa:  { label: 'Cocoa', bg: '#8b6f63', sw: ['#8b6f63', '#f1e4cf', '#9aa86f', '#d3715d'] },
  spring: { label: 'Spring', bg: '#6b6d43', sw: ['#99b4aa', '#aba66f', '#cf7d65', '#f2dec7'] },
  summer: { label: 'Summer honey', bg: '#5d695d', sw: ['#e48c35', '#f5b74e', '#aaa06d', '#5d695d'] },
  autumn: { label: 'Autumn', bg: '#66140e', sw: ['#f4d4a6', '#b1a56b', '#b36c60', '#8c0610'] },
  winter: { label: 'Winter', bg: '#525871', sw: ['#525871', '#857c91', '#cd9fa0', '#f8ccaa'] },
};
function seasonNow(d = new Date()) { const m = d.getMonth(); return m >= 2 && m <= 4 ? 'spring' : m >= 5 && m <= 7 ? 'summer' : m >= 8 && m <= 10 ? 'autumn' : 'winter'; }
function applyTheme() {
  const t = S.settings.theme === 'auto' ? seasonNow() : (THEMES[S.settings.theme] ? S.settings.theme : 'cocoa');
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEMES[t].bg);
}
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// ---------- Time helpers ----------
const dayKey = (d = new Date()) => new Date(d).toLocaleDateString('en-CA'); // YYYY-MM-DD local
const addDays = (key, n) => { const d = new Date(key + 'T12:00:00'); d.setDate(d.getDate() + n); return dayKey(d); };
function fmtDur(ms, withSec = true) {
  ms = Math.max(0, ms);
  const h = Math.floor(ms / 3.6e6), m = Math.floor(ms % 3.6e6 / 6e4), s = Math.floor(ms % 6e4 / 1000);
  const p = n => String(n).padStart(2, '0');
  return withSec ? `${h}:${p(m)}:${p(s)}` : `${h}h ${p(m)}m`;
}
const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = k => new Date(k + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
function parseHM(hm) { const [h, m] = hm.split(':').map(Number); return h * 60 + m; }
function hmFromMin(min) { min = ((min % 1440) + 1440) % 1440; return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`; }
// ----- Fasting schedule: each weekday has a first-meal time; the planned fast ends then and starts fastHours earlier.
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekdayOf = key => new Date(key + 'T12:00:00').getDay();
function schedFor(key) { const st = S.settings; return st.sameEveryDay ? { on: true, eat: st.eatStart } : st.schedule[weekdayOf(key)]; }
function atHM(key, hm) { const [h, m] = hm.split(':'); const d = new Date(key + 'T00:00:00'); d.setHours(+h, +m, 0, 0); return d.getTime(); }
// Planned fast that ends on eating day `key`, or null if that day is a no-fast day
function plannedFast(key) { const sc = schedFor(key); if (!sc || !sc.on) return null; const end = atHM(key, sc.eat); return { key, start: end - S.settings.fastHours * 3.6e6, end }; }
// The planned fast that is in progress or next up
function currentPlan(now = Date.now()) { for (let i = -1; i < 9; i++) { const p = plannedFast(addDays(dayKey(now), i)); if (p && p.end > now) return p; } return null; }
function hm12(hm) { const d = new Date(); const [h, m] = hm.split(':'); d.setHours(+h, +m, 0, 0); return fmtTime(d); }
// Next occurrence (Date) of an HH:MM time after `from`
function nextAt(hm, from = new Date()) { const d = new Date(from); const [h, m] = hm.split(':'); d.setHours(+h, +m, 0, 0); if (d <= from) d.setDate(d.getDate() + 1); return d; }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Fasting logic ----------
const activeFast = () => S.fasts.find(f => !f.end);
const lastFinishedFast = () => S.fasts.filter(f => f.end).sort((a, b) => b.end - a.end)[0];
function startFast(at = Date.now()) {
  if (activeFast()) return;
  S.fasts.push({ id: uid(), start: at, end: null, goalH: S.settings.fastHours });
  save(); toast('Fast started 💪'); render();
}
function endFast(at = Date.now()) {
  const f = activeFast(); if (!f) return;
  f.end = Math.max(at, f.start);
  save();
  const hrs = (f.end - f.start) / 3.6e6;
  toast(hrs >= f.goalH ? `Fast complete: ${fmtDur(f.end - f.start, false)} 🎉` : `Fast ended at ${fmtDur(f.end - f.start, false)}`);
  render();
}

// A day "hits the goal" when a fast that reached its goal ended on that day.
function goalDays() {
  const set = new Set();
  for (const f of S.fasts) if (f.end && (f.end - f.start) / 3.6e6 >= f.goalH) set.add(dayKey(f.end));
  return set;
}
const weekId = key => { const d = new Date(key + 'T12:00:00'); const day = (d.getDay() - S.settings.weekStart + 7) % 7; d.setDate(d.getDate() - day); return dayKey(d); }; // first day of the week
function computeStreak(today = dayKey()) {
  const hits = goalDays();
  if (!hits.size) return { streak: 0, frozen: [], todayDone: false };
  const first = [...hits].sort()[0];
  const todayDone = hits.has(today);
  let day = todayDone ? today : addDays(today, -1); // today still in progress doesn't break streak
  let streak = 0, oldest = null; let frozen = []; const usedWeeks = new Set();
  while (day >= first) {
    if (hits.has(day)) { if (day <= today) { streak++; oldest = day; } }
    else if (!plannedFast(day)) { /* scheduled no-fast day: doesn't count or break */ }
    else if (S.settings.streakFreeze && !usedWeeks.has(weekId(day))) { usedWeeks.add(weekId(day)); frozen.push(day); }
    else break;
    day = addDays(day, -1);
  }
  // A freeze only counts if it bridges to an earlier goal day
  frozen = oldest ? frozen.filter(d => d > oldest) : [];
  return { streak, frozen, todayDone };
}

// ---------- Food logic ----------
const enabledMeals = () => MEALS.filter(m => S.settings.meals[m.id]);
const foodsOn = key => S.foods.filter(f => f.date === key);
const sumKcal = arr => Math.round(arr.reduce((a, f) => a + (+f.kcal || 0), 0));
function lastMainMeal() { const main = enabledMeals().filter(m => m.id !== 'snacks'); return (main[main.length - 1] || enabledMeals()[0] || {}).id; }
function guessMeal() {
  const h = new Date().getHours(); const en = S.settings.meals;
  const order = h < 11 ? ['breakfast', 'lunch', 'snacks', 'dinner'] : h < 16 ? ['lunch', 'snacks', 'dinner', 'breakfast'] : ['dinner', 'snacks', 'lunch', 'breakfast'];
  return order.find(m => en[m]) || 'snacks';
}

// Adding food is the sync point between the calorie log and the fasting timer.
async function addFoods(items, meal, date = dayKey()) {
  const f = activeFast();
  if (f && date === dayKey()) {
    const done = (Date.now() - f.start) / 3.6e6 >= f.goalH;
    const ok = await confirmDialog({
      title: done ? 'End your fast?' : 'This will break your fast',
      body: done ? `You've fasted ${fmtDur(Date.now() - f.start, false)}. Logging food will end your fast.`
        : `You're ${fmtDur(Date.now() - f.start, false)} into a ${f.goalH}h fast (${fmtDur(f.start + f.goalH * 3.6e6 - Date.now(), false)} left). Logging food now ends the fast before it's complete.`,
      ok: done ? 'End fast & log' : 'Break fast & log', cancel: 'Cancel', danger: !done,
      extra: 'Log without ending fast',
    });
    if (ok === false) return false;
    if (ok === true) endFast();
  }
  for (const it of items) S.foods.push({ id: uid(), ts: Date.now(), date, meal, name: it.name || 'Food', kcal: Math.round(+it.kcal || 0), protein: +it.protein || 0, carbs: +it.carbs || 0, fat: +it.fat || 0, source: it.source || 'manual' });
  save(); closeSheet(); toast(`Logged ${sumKcal(items)} kcal to ${mealLabel(meal)}`); render();
  // After the last meal of the day, offer to start the fast.
  if (!activeFast() && date === dayKey() && meal === lastMainMeal()) {
    const go = await confirmDialog({ title: `Start your ${S.settings.fastHours}h fast?`, body: `You just logged ${mealLabel(meal).toLowerCase()}. Start fasting now? You'd finish at ${fmtTime(Date.now() + S.settings.fastHours * 3.6e6)} ${dayLabelFor(Date.now() + S.settings.fastHours * 3.6e6)}.`, ok: 'Start fast', cancel: 'Not yet' });
    if (go === true) startFast();
  }
  return true;
}
const mealLabel = id => (MEALS.find(m => m.id === id) || {}).label || id;
function dayLabelFor(t) { const k = dayKey(t); return k === dayKey() ? 'today' : k === addDays(dayKey(), 1) ? 'tomorrow' : fmtDay(k); }

// ---------- Recipes ----------
const ingById = id => S.ingredients.find(i => i.id === id);
function ingKcal(ing, qty) { return ing ? (+qty || 0) / (+ing.unitSize || 1) * (+ing.kcalPerUnit || 0) : 0; }
function recipeKcal(r) { return r.items.reduce((a, it) => a + ingKcal(ingById(it.ingId), it.qty), 0); }
const recipePerServing = r => recipeKcal(r) / (+r.servings || 1);

// ---------- Weekly budget & recap ----------
const weekBudget = () => +S.settings.weeklyBudget || S.settings.calorieGoal * 7;
const weekDays = wk => Array.from({ length: 7 }, (_, i) => addDays(wk, i));
function weekBudgetInfo(key = dayKey()) {
  const wk = weekId(key), days = weekDays(wk), budget = weekBudget();
  const total = sumKcal(S.foods.filter(f => days.includes(f.date)));
  const before = sumKcal(S.foods.filter(f => days.includes(f.date) && f.date < key));
  const daysLeft = days.filter(d => d >= key).length;
  return { wk, budget, total, left: budget - total, perDay: Math.max(0, Math.round((budget - before) / daysLeft)), daysLeft };
}
function weekBudgetHTML(key = dayKey()) {
  const w = weekBudgetInfo(key);
  return `<div class="row between small" style="margin-top:12px"><span>This week: <b>${w.total.toLocaleString()}</b> / ${w.budget.toLocaleString()}</span><span class="muted">${w.left >= 0 ? w.left.toLocaleString() + ' left' : (-w.left).toLocaleString() + ' over'}</span></div>
    <div class="bar ${w.total > w.budget ? 'over' : ''}" style="margin-top:6px;height:6px"><div style="width:${Math.min(100, w.total / w.budget * 100)}%;background:var(--accent2)"></div></div>
    ${w.daysLeft > 1 && w.left > 0 ? `<div class="small muted" style="margin-top:6px">To stay on budget: about ${w.perDay.toLocaleString()} kcal/day for the ${w.daysLeft} days left (incl. today)</div>` : ''}`;
}
function weekStats(wk) {
  const days = weekDays(wk), t0 = atHM(wk, '00:00'), t1 = atHM(addDays(wk, 7), '00:00'), now = Date.now();
  const foods = S.foods.filter(f => days.includes(f.date));
  const total = sumKcal(foods), logged = days.filter(d => foods.some(f => f.date === d));
  const overDays = logged.filter(d => sumKcal(foods.filter(f => f.date === d)) > S.settings.calorieGoal).length;
  let fastMs = 0, completed = 0, longest = 0;
  for (const f of S.fasts) {
    const a = Math.max(f.start, t0), b = Math.min(f.end || now, t1); if (b > a) fastMs += b - a;
    if (f.end && f.end >= t0 && f.end < t1) { const d = f.end - f.start; longest = Math.max(longest, d); if (d / 3.6e6 >= f.goalH) completed++; }
  }
  const lastDay = days[6] < dayKey() ? days[6] : dayKey();
  const ws = [...S.weights].sort((a, b) => a.date.localeCompare(b.date));
  const startW = ws.filter(w => w.date < wk).pop() || ws.find(w => days.includes(w.date));
  const endW = ws.filter(w => days.includes(w.date)).pop();
  const planned = days.filter(d => d <= lastDay && plannedFast(d)).length;
  return { wk, days, total, budget: weekBudget(), logged: logged.length, avg: logged.length ? Math.round(total / logged.length) : 0, overDays,
    fastHours: fastMs / 3.6e6, completed, planned, longest, streak: computeStreak(lastDay).streak,
    startW, endW, dW: startW && endW && startW !== endW ? endW.value - startW.value : null };
}
function openRecap(wk = weekId(addDays(dayKey(), -7))) {
  const r = weekStats(wk), unit = S.settings.weightUnit, cur = weekId(dayKey());
  const stat = (label, val, sub = '') => `<div class="card stat" style="margin:0"><div class="small muted">${label}</div><div style="font-family:var(--font-display);font-size:24px;font-weight:600">${val}</div>${sub ? `<div class="small muted">${sub}</div>` : ''}</div>`;
  openSheet(`<div class="row between"><h2>Weekly recap</h2><button class="icon" id="rcX">✕</button></div>
    <div class="row between"><button class="icon" id="rcPrev">‹</button><b>${fmtDay(wk)} – ${fmtDay(addDays(wk, 6))}${wk === cur ? ' (so far)' : ''}</b><button class="icon" id="rcNext" ${wk >= cur ? 'disabled style="opacity:.3"' : ''}>›</button></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px">
      ${stat('Calories', r.total.toLocaleString(), `of ${r.budget.toLocaleString()} budget · ${r.total <= r.budget ? (r.budget - r.total).toLocaleString() + ' under' : (r.total - r.budget).toLocaleString() + ' over'}`)}
      ${stat('Daily average', r.avg.toLocaleString(), `${r.logged} day${r.logged === 1 ? '' : 's'} logged · ${r.overDays} over goal`)}
      ${stat('Hours fasted', r.fastHours.toFixed(1), `${r.completed} of ${r.planned} planned fasts hit · longest ${fmtDur(r.longest, false)}`)}
      ${stat('Fasting streak', `🔥 ${r.streak}`, 'days, at end of week')}
      ${stat('Weight change', r.dW === null ? '—' : `${delta(r.dW)} ${unit}`, r.endW ? `${r.startW && r.startW !== r.endW ? r.startW.value + ' → ' : ''}${r.endW.value} ${unit}` : 'no weigh-ins this week')}
    </div>
    ${r.dW !== null && r.dW < 0 ? `<p class="center">Nice work, down ${Math.abs(r.dW).toFixed(1)} ${unit} this week 🎉</p>` : ''}`);
  document.getElementById('rcX').onclick = closeSheet;
  document.getElementById('rcPrev').onclick = () => openRecap(addDays(wk, -7));
  document.getElementById('rcNext').onclick = () => { if (wk < cur) openRecap(addDays(wk, 7)); };
}
// Show last week's recap once, the first time the app opens in a new week.
function maybeShowRecap() {
  const cur = weekId(dayKey()), prev = addDays(cur, -7);
  if (S.meta.lastRecapWeek === cur) return;
  const hadData = S.foods.some(f => f.date >= prev && f.date < cur) || S.fasts.some(f => f.start < atHM(cur, '00:00') && (f.end || Date.now()) >= atHM(prev, '00:00'));
  S.meta.lastRecapWeek = cur; save();
  if (hadData && sheet.classList.contains('hidden') && !document.querySelector('.dialog')) openRecap(prev);
}

// ---------- UI shell ----------
let tab = 'home';
let settingsSec = null; // which Settings category is open (null = the menu)
let foodDay = dayKey();
const view = document.getElementById('view');
document.querySelectorAll('.tabbar button').forEach(b => b.onclick = () => { tab = b.dataset.tab; settingsSec = null; render(); window.scrollTo(0, 0); });

function render() {
  applyAutoGoal();
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const titles = { home: activeFast() ? 'Fasting' : 'Eating window', food: 'Food log', weight: 'Weight', library: 'Ingredients & recipes', settings: 'Settings' };
  document.getElementById('pageTitle').textContent = tab === 'settings' && settingsSec ? SETTINGS_SECS[settingsSec].label : titles[tab];
  ({ home: renderHome, food: renderFood, weight: renderWeight, library: renderLibrary, settings: renderSettings })[tab]();
}

function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 2600); }

const sheet = document.getElementById('sheet'), sheetBody = document.getElementById('sheetBody');
function openSheet(html) { sheetBody.innerHTML = html; sheet.classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
function closeSheet() { stopScanner(); sheet.classList.add('hidden'); document.body.style.overflow = ''; }
sheet.querySelector('.sheet-backdrop').onclick = closeSheet;

// Promise-based dialog on its own layer above any open sheet. Resolves true (ok), 'extra', or false (cancel).
function confirmDialog({ title, body, ok = 'OK', cancel = 'Cancel', danger = false, extra = null }) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'sheet dialog';
    wrap.innerHTML = `<div class="sheet-backdrop"></div><div class="sheet-panel"><h2>${esc(title)}</h2><p class="muted">${esc(body)}</p>
      <div style="display:grid;gap:8px;margin-top:16px">
        <button class="btn ${danger ? 'danger' : 'primary'}" data-v="ok">${esc(ok)}</button>
        ${extra ? `<button class="btn" data-v="extra">${esc(extra)}</button>` : ''}
        <button class="btn" data-v="cancel">${esc(cancel)}</button></div></div>`;
    document.body.appendChild(wrap);
    const finish = v => { wrap.remove(); resolve(v); };
    wrap.querySelector('.sheet-backdrop').onclick = () => finish(false);
    wrap.querySelectorAll('[data-v]').forEach(b => b.onclick = () => finish(b.dataset.v === 'ok' ? true : b.dataset.v === 'extra' ? 'extra' : false));
  });
}
function closeSheetSilently() { closeSheet(); }

// ---------- Home ----------
// Ring with an inked outline on both edges, like a hand-drawn gauge
const RING = ['var(--ring1)', 'var(--ring2)', 'var(--ring3)', 'var(--ring4)']; // palette colors along the ring
function ringSVG(pct, color, id = 'ringArc') {
  const r = 115, c = 2 * Math.PI * r, p = Math.min(1, Math.max(0, pct));
  const base = `<circle cx="130" cy="130" r="${r}" style="stroke:var(--track)" stroke-width="22" fill="none"/>
    <circle cx="130" cy="130" r="${r + 12}" style="stroke:var(--ink)" stroke-width="2.5" fill="none"/>
    <circle cx="130" cy="130" r="${r - 12}" style="stroke:var(--ink)" stroke-width="2.5" fill="none"/>`;
  const arc = (stroke) => `<circle id="${id}" cx="130" cy="130" r="${r}" style="stroke:${stroke}" stroke-width="19" fill="none" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p)}"/>`;
  if (!Array.isArray(color)) return `<svg viewBox="0 0 260 260">${base}${arc(color)}</svg>`;
  // Gradient that follows the ring: small colored slices, revealed by the progress arc used as a mask
  const cs = color, c1 = cs[0], N = 90, pt = a => `${(130 + r * Math.cos(a)).toFixed(2)} ${(130 + r * Math.sin(a)).toFixed(2)}`;
  let segs = '';
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * 2 * Math.PI, a1 = Math.min(i + 1.6, N) / N * 2 * Math.PI, k = (i / (N - 1)) * (cs.length - 1), j = Math.min(Math.floor(k), cs.length - 2), mix = Math.round((k - j) * 100);
    segs += `<path d="M${pt(a0)} A${r} ${r} 0 0 1 ${pt(a1)}" style="stroke:color-mix(in oklab, ${cs[j + 1]} ${mix}%, ${cs[j]})" stroke-width="20" fill="none"/>`;
  }
  segs += `<path d="M${pt(-0.2)} A${r} ${r} 0 0 1 ${pt(0.01)}" style="stroke:${c1}" stroke-width="20" fill="none"/>`; // under the rounded start cap
  return `<svg viewBox="0 0 260 260">${base}<mask id="${id}Mask" maskUnits="userSpaceOnUse" x="0" y="0" width="260" height="260">${arc('#fff')}</mask><g mask="url(#${id}Mask)">${segs}</g></svg>`;
}
function streakHTML() {
  const { streak, frozen, todayDone } = computeStreak();
  const fz = frozen.length ? ` <span class="pill amber" title="Frozen: ${frozen.map(fmtDay).join(', ')}">🧊 ${frozen.length} freeze${frozen.length > 1 ? 's' : ''}</span>` : '';
  return `<div class="streak">🔥 <b>${streak}</b> day${streak === 1 ? '' : 's'} streak ${todayDone ? '<span class="pill green">today ✓</span>' : ''}${fz}</div>`;
}
function renderHome() {
  const f = activeFast(), st = S.settings;
  const todayK = sumKcal(foodsOn(dayKey()));
  if (f) {
    const goalMs = f.goalH * 3.6e6;
    view.innerHTML = `
      <div class="card center">
        ${streakHTML()}
        <div class="ring-wrap">${ringSVG((Date.now() - f.start) / goalMs, RING)}
          <div class="ring-center"><div class="ring-label">Fasting</div><div class="ring-time" id="tElapsed"></div><div class="ring-label" id="tRemain"></div></div></div>
        <div class="row between small muted"><span>Started ${fmtTime(f.start)} ${dayLabelFor(f.start)}</span><span>Goal ${fmtTime(f.start + goalMs)} ${dayLabelFor(f.start + goalMs)}</span></div>
        <div style="margin-top:14px" class="btn-grid">
          <button class="btn" id="editStart">Edit start</button>
          <button class="btn primary" id="endFast">End fast</button>
        </div>
        <button class="link" id="logDuringFast" style="margin-top:10px">+ Log food</button>
      </div>
      <div class="card small muted">Today: ${todayK} / ${st.calorieGoal} kcal${(() => { const p = currentPlan(); return p ? ` · Next meal planned ${fmtTime(p.end)} ${dayLabelFor(p.end)}` : ''; })()}</div>
      <div class="center"><button class="link" id="recapBtn">📊 Weekly recap</button></div>`;
    const tick = () => {
      const el = document.getElementById('tElapsed'); if (!el) return;
      const e = Date.now() - f.start; el.textContent = fmtDur(e);
      document.getElementById('tRemain').textContent = e >= goalMs ? `Goal reached! +${fmtDur(e - goalMs, false)}` : `${fmtDur(goalMs - e, false)} to go`;
      const arc = document.getElementById('ringArc'); const c = 2 * Math.PI * 115; arc.setAttribute('stroke-dashoffset', c * (1 - Math.min(1, e / goalMs)));
    };
    tick(); setTick(tick);
    document.getElementById('endFast').onclick = async () => {
      const done = Date.now() - f.start >= goalMs;
      if (!done) { const ok = await confirmDialog({ title: 'End fast early?', body: `You still have ${fmtDur(goalMs - (Date.now() - f.start), false)} to reach your ${f.goalH}h goal. This fast won't count toward your streak.`, ok: 'End fast', danger: true }); if (ok !== true) return; }
      endFast();
    };
    document.getElementById('editStart').onclick = () => editTimeSheet('Fast start time', f.start, t => { f.start = Math.min(t, Date.now()); save(); render(); });
    document.getElementById('logDuringFast').onclick = () => openLogSheet(guessMeal());
    document.getElementById('recapBtn').onclick = () => openRecap(weekId(dayKey()));
  } else {
    const last = lastFinishedFast();
    const pct = Math.min(1, todayK / st.calorieGoal);
    const plan = currentPlan();
    const planPill = !plan ? '' : plan.start > Date.now() ? `<span class="pill">Fast starts ${fmtTime(plan.start)}${dayLabelFor(plan.start) === 'today' ? '' : ' ' + dayLabelFor(plan.start)}</span>`
      : `<span class="pill amber">Fast was due ${fmtTime(plan.start)}</span>`;
    const over = todayK > st.calorieGoal;
    const mealIco = { breakfast: '🍳', lunch: '🥗', dinner: '🍲', snacks: '🍓' };
    view.innerHTML = `
      <div class="card">
        <div class="row between">${streakHTML()}<span class="small muted">Since last fast: <b id="tSince">${last ? '' : '—'}</b></span></div>
      </div>
      <div class="card center">
        ${planPill}
        <div class="ring-wrap sm">${ringSVG(pct, over ? 'var(--danger)' : RING, 'calArc')}
          <div class="ring-center"><div class="big-num">${Math.abs(st.calorieGoal - todayK).toLocaleString()}</div>
            <div class="ring-label">kcal ${over ? 'over' : 'left'}</div>
            <div class="small muted" style="margin-top:4px">${todayK.toLocaleString()} of ${st.calorieGoal.toLocaleString()} eaten</div></div></div>
        <div style="text-align:left">${weekBudgetHTML()}</div>
      </div>
      <div class="card">
        <h2>Log food</h2>
        <div class="meal-btns">${enabledMeals().map(m => `<button class="meal-btn" data-meal="${m.id}"><span class="ico">${mealIco[m.id]}</span>${m.label}<small>${sumKcal(foodsOn(dayKey()).filter(x => x.meal === m.id))} kcal</small></button>`).join('')}</div>
        <div class="btn-grid" style="margin-top:12px"><button class="btn blue" id="snapBtn">📷 Snap a photo</button><button class="btn blue" id="scanBtn">▥ Scan barcode</button>
          <button class="btn" id="quickBtn">⚡ Quick add</button><button class="btn" id="mineBtn">📖 My foods</button></div>
      </div>
      <button class="btn primary" id="startFast">🌙 Start ${st.fastHours}h fast</button>
      <div class="center" style="margin-top:6px"><button class="link" id="startEarlier">Started earlier?</button> · <button class="link" id="recapBtn">Weekly recap</button></div>`;
    if (last) { const tick = () => { const el = document.getElementById('tSince'); if (el) el.textContent = fmtDur(Date.now() - last.end, false); }; tick(); setTick(tick); } else setTick(null);
    view.querySelectorAll('.meal-btn').forEach(b => b.onclick = () => openLogSheet(b.dataset.meal, 'library'));
    document.getElementById('mineBtn').onclick = () => openLogSheet(guessMeal(), 'library');
    document.getElementById('snapBtn').onclick = () => openLogSheet(guessMeal(), 'photo');
    document.getElementById('quickBtn').onclick = () => openLogSheet(guessMeal(), 'quick');
    document.getElementById('scanBtn').onclick = () => openLogSheet(guessMeal(), 'scan');
    document.getElementById('startFast').onclick = () => startFast();
    document.getElementById('recapBtn').onclick = () => openRecap(weekId(dayKey()));
    document.getElementById('startEarlier').onclick = () => editTimeSheet('When did your fast start?', Date.now(), t => startFast(Math.min(t, Date.now())));
  }
}
let tickTimer = null;
function setTick(fn) { clearInterval(tickTimer); if (fn) tickTimer = setInterval(() => { if (tab === 'home') fn(); }, 1000); }

function toLocalInput(t) { const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }
function editTimeSheet(title, t, cb) {
  openSheet(`<h2>${esc(title)}</h2><input type="datetime-local" id="dt" value="${toLocalInput(t)}"><div class="btn-grid" style="margin-top:12px"><button class="btn" id="c">Cancel</button><button class="btn primary" id="o">Save</button></div>`);
  document.getElementById('c').onclick = closeSheet;
  document.getElementById('o').onclick = () => { const v = new Date(document.getElementById('dt').value).getTime(); if (!isNaN(v)) { closeSheetSilently(); cb(v); } };
}

// ---------- Log food sheet ----------
function openLogSheet(meal, mode = 'quick', date = dayKey()) {
  const state = { meal, mode, date };
  const draw = () => {
    openSheet(`
      <div class="row between"><h2>Log food</h2><button class="icon" id="x">✕</button></div>
      ${activeFast() && date === dayKey() ? `<div class="warnbox">⚠️ You're fasting. Logging food will ask to end your fast.</div>` : ''}
      <label>Meal</label>
      <select id="mealSel">${enabledMeals().map(m => `<option value="${m.id}" ${m.id === state.meal ? 'selected' : ''}>${m.label}</option>`).join('')}</select>
      <div class="seg" style="margin-top:12px">
        ${[['quick', '⚡ Quick'], ['scan', '▥ Scan'], ['photo', '📷 Photo'], ['library', '📖 Foods']].map(([k, l]) => `<button data-mode="${k}" class="${state.mode === k ? 'active' : ''}">${l}</button>`).join('')}
      </div>
      <div id="modeBody"></div>`);
    document.getElementById('x').onclick = () => { stopScanner(); closeSheet(); };
    document.getElementById('mealSel').onchange = e => state.meal = e.target.value;
    sheetBody.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { stopScanner(); state.mode = b.dataset.mode; draw(); });
    ({ quick: drawQuick, scan: drawScan, photo: drawPhoto, library: drawLibraryPick })[state.mode](document.getElementById('modeBody'), state);
  };
  draw();
}

function drawQuick(el, state) {
  el.innerHTML = `
    <label>Calories</label><input id="qk" type="number" inputmode="numeric" placeholder="e.g. 450">
    <label>Description (optional)</label><input id="qn" placeholder="e.g. Chipotle bowl">
    <details style="margin-top:8px"><summary class="small muted">Macros (optional)</summary>
      <div class="row"><div class="grow"><label>Protein g</label><input id="qp" type="number" inputmode="decimal"></div><div class="grow"><label>Carbs g</label><input id="qc" type="number" inputmode="decimal"></div><div class="grow"><label>Fat g</label><input id="qf" type="number" inputmode="decimal"></div></div></details>
    <button class="btn primary" id="qAdd" style="margin-top:14px">Add</button>`;
  setTimeout(() => document.getElementById('qk')?.focus(), 50);
  document.getElementById('qAdd').onclick = () => {
    const kcal = +document.getElementById('qk').value; if (!kcal) return toast('Enter calories');
    addFoods([{ name: document.getElementById('qn').value || 'Quick add', kcal, protein: document.getElementById('qp').value, carbs: document.getElementById('qc').value, fat: document.getElementById('qf').value, source: 'quick' }], state.meal, state.date);
  };
}

// ---------- Barcode scanning (Open Food Facts, free product database) ----------
let scanStop = null;
function stopScanner() { if (scanStop) { try { scanStop(); } catch {} scanStop = null; } }
let zxingLoad = null;
function loadZXing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  return zxingLoad ||= new Promise((ok, fail) => { const sc = document.createElement('script'); sc.src = 'vendor/zxing.min.js'; sc.onload = () => ok(window.ZXing); sc.onerror = () => { zxingLoad = null; fail(new Error('Scanner failed to load')); }; document.head.appendChild(sc); });
}
async function zxReader() {
  const Z = await loadZXing(), hints = new Map();
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E, Z.BarcodeFormat.CODE_128]);
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  return new Z.BrowserMultiFormatReader(hints, 300);
}
function drawScan(el, state) {
  el.innerHTML = `
    <div class="scan-box" id="scanBox"><video id="scanVid" playsinline muted></video><div class="scan-line"></div></div>
    <p class="small muted center" id="scanMsg">Starting camera…</p>
    <div class="btn-grid" id="scanOpts"><button class="btn" id="scanPhotoBtn">🖼 Scan from photo</button><button class="btn" id="scanTypeBtn">⌨️ Type the number</button></div>
    <input type="file" accept="image/*" id="scanPhoto" class="visually-hidden">
    <div id="scanType" class="hidden"><label>Barcode number</label><div class="row"><input id="scanCode" inputmode="numeric" placeholder="e.g. 012345678905" class="grow"><button class="btn small primary" id="scanGo">Look up</button></div></div>
    <div id="scanResult"></div>`;
  const msg = t => { const m = document.getElementById('scanMsg'); if (m) m.textContent = t; };
  let done = false;
  const found = code => { if (done) return; done = true; stopScanner(); ['scanBox', 'scanOpts', 'scanType'].forEach(id => document.getElementById(id)?.classList.add('hidden')); navigator.vibrate?.(60); lookupBarcode(code, state); };
  document.getElementById('scanTypeBtn').onclick = () => { document.getElementById('scanType').classList.remove('hidden'); document.getElementById('scanCode').focus(); };
  document.getElementById('scanGo').onclick = () => { const c = document.getElementById('scanCode').value.replace(/\D/g, ''); if (c.length < 6) return toast('Enter the digits under the barcode'); done = false; found(c); };
  document.getElementById('scanPhotoBtn').onclick = () => document.getElementById('scanPhoto').click();
  document.getElementById('scanPhoto').onchange = async e => {
    const f = e.target.files[0]; if (!f) return; msg('Reading barcode…');
    const url = URL.createObjectURL(f);
    try { const r = await (await zxReader()).decodeFromImageUrl(url); done = false; found(r.getText()); }
    catch { msg('No barcode found in that photo. Get closer, keep it flat and well lit, or type the number.'); }
    finally { URL.revokeObjectURL(url); }
  };
  // Live camera scan
  (async () => {
    if (!navigator.mediaDevices?.getUserMedia) return msg('Camera not available here. Scan from a photo or type the number.');
    try {
      const vid = document.getElementById('scanVid');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (!document.getElementById('scanVid')) { stream.getTracks().forEach(t => t.stop()); return; }
      let stopped = false;
      scanStop = () => { stopped = true; stream.getTracks().forEach(t => t.stop()); };
      vid.srcObject = stream; await vid.play();
      msg('Point the camera at the barcode');
      if ('BarcodeDetector' in window) {
        const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] });
        const loop = async () => { if (stopped || done) return; try { const r = await det.detect(vid); if (r[0]) return found(r[0].rawValue); } catch {} setTimeout(loop, 200); };
        loop();
      } else {
        const reader = await zxReader();
        if (stopped) return;
        const cv = document.createElement('canvas'), ctx = cv.getContext('2d', { willReadFrequently: true });
        const loop = () => {
          if (stopped || done) return;
          if (vid.videoWidth) {
            // decode the middle band of the frame, where the guide line is
            const w = vid.videoWidth, h = Math.round(vid.videoHeight * 0.5);
            cv.width = w; cv.height = h; ctx.drawImage(vid, 0, (vid.videoHeight - h) / 2, w, h, 0, 0, w, h);
            try { const r = reader.decodeBitmap(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(cv)))); if (r) return found(r.getText()); } catch {}
          }
          setTimeout(loop, 150);
        };
        loop();
      }
    } catch (e) {
      msg(e && e.name === 'NotAllowedError' ? 'Camera access was blocked. Allow it in iPhone Settings, or scan from a photo instead.' : 'Couldn\'t start the camera. Scan from a photo or type the number.');
    }
  })();
}
async function lookupBarcode(code, state) {
  const out = document.getElementById('scanResult'); if (!out) return;
  out.innerHTML = `<div class="spinner"></div><p class="small muted center">Looking up ${esc(code)}…</p>`;
  const msg = document.getElementById('scanMsg'); if (msg) msg.textContent = '';
  const saved = S.ingredients.find(i => i.barcode === code);
  let prod = null;
  try {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,product_name_en,brands,nutriments,serving_size,serving_quantity,image_front_small_url`, { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    if (j.status === 1 && j.product) prod = j.product;
  } catch { if (!saved) { out.innerHTML = `<div class="warnbox">Couldn't reach the food database. Check your connection and try again.</div><button class="btn" id="scanAgain">Scan again</button>`; document.getElementById('scanAgain').onclick = () => drawScan(document.getElementById('modeBody'), state); return; } }
  const n = (prod && prod.nutriments) || {};
  const kcal100 = n['energy-kcal_100g'] ?? (n['energy_100g'] != null ? n['energy_100g'] / 4.184 : null);
  if (!prod || kcal100 == null) {
    if (saved) return showScanned({ name: saved.name, kcal100: saved.kcalPerUnit, p: saved.p, c: saved.c, f: saved.f, srvG: saved.srvG, srvLabel: saved.srvLabel, code }, state);
    out.innerHTML = `<div class="warnbox">${prod ? 'This product has no calorie info yet.' : 'Product not found.'} You can log it with Quick add from the nutrition label.</div>
      <div class="btn-grid"><button class="btn" id="scanAgain">Scan again</button><button class="btn primary" id="scanQuick">Quick add</button></div>
      <p class="small muted center">Barcode ${esc(code)}. Products come from Open Food Facts, a free community database.</p>`;
    document.getElementById('scanAgain').onclick = () => drawScan(document.getElementById('modeBody'), state);
    document.getElementById('scanQuick').onclick = () => { state.mode = 'quick'; sheetBody.querySelector('[data-mode="quick"]').click(); };
    return;
  }
  const brand = (prod.brands || '').split(',')[0].trim(), pname = (prod.product_name_en || prod.product_name || 'Scanned item').trim();
  const name = brand && !pname.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${pname}` : pname;
  const srvG = +prod.serving_quantity || null;
  showScanned({ name, kcal100, p: n.proteins_100g, c: n.carbohydrates_100g, f: n.fat_100g, srvG, srvLabel: prod.serving_size || (srvG ? `${srvG} g` : ''), img: prod.image_front_small_url, code }, state);
}
function showScanned(it, state) {
  const out = document.getElementById('scanResult');
  const per = g => ({ kcal: it.kcal100 * g / 100, protein: it.p != null ? it.p * g / 100 : '', carbs: it.c != null ? it.c * g / 100 : '', fat: it.f != null ? it.f * g / 100 : '' });
  let unit = it.srvG ? 'srv' : 'g';
  out.innerHTML = `
    <div class="card stat" style="margin:4px 0 0">
      <div class="row">${it.img ? `<img src="${esc(it.img)}" alt="" style="width:56px;height:56px;object-fit:contain;border-radius:10px;background:#fff;border:1.5px solid var(--line-soft)">` : ''}
        <div class="grow"><b>${esc(it.name)}</b><br><span class="small muted">${Math.round(it.kcal100)} kcal / 100 g${it.srvG ? ` · 1 serving${it.srvLabel ? ` (${esc(it.srvLabel)})` : ''} = ${Math.round(it.kcal100 * it.srvG / 100)} kcal` : ''}</span></div></div>
      <div class="row" style="margin-top:10px"><input type="number" inputmode="decimal" id="scAmt" value="${it.srvG ? 1 : 100}" step="any" class="grow">
        ${it.srvG ? `<div class="seg" style="margin:0;flex:0 0 auto"><button data-su="srv" class="active">servings</button><button data-su="g">grams</button></div>` : '<span class="muted">grams</span>'}</div>
      <p class="center" style="margin:10px 0 4px"><span class="big-num" id="scK" style="font-size:30px"></span> <span class="muted">kcal</span></p>
      <p class="small muted center" id="scM" style="margin:0"></p>
    </div>
    <div class="btn-grid" style="margin-top:12px"><button class="btn" id="scanAgain">Scan another</button><button class="btn primary" id="scAdd">Add</button></div>
    <p class="small muted center">Saved to your foods so you can find it by name next time. Data from Open Food Facts.</p>`;
  const grams = () => { const a = +document.getElementById('scAmt').value || 0; return unit === 'srv' ? a * it.srvG : a; };
  const upd = () => { const v = per(grams()); document.getElementById('scK').textContent = Math.round(v.kcal); document.getElementById('scM').textContent = v.protein !== '' ? `P ${Math.round(v.protein)} g · C ${Math.round(v.carbs)} g · F ${Math.round(v.fat)} g` : ''; };
  document.getElementById('scAmt').oninput = upd;
  out.querySelectorAll('[data-su]').forEach(b => b.onclick = () => {
    if (b.dataset.su === unit) return;
    const amt = document.getElementById('scAmt'), g = grams(); unit = b.dataset.su;
    amt.value = unit === 'srv' ? Math.round(g / it.srvG * 100) / 100 : Math.round(g);
    out.querySelectorAll('[data-su]').forEach(x => x.classList.toggle('active', x === b)); upd();
  });
  upd();
  // Keep it as a saved food (per 100 g) so it shows up in search and recipes
  let ing = S.ingredients.find(i => i.barcode === it.code);
  if (!ing) { ing = { id: uid(), name: it.name, unit: 'g', unitSize: 100, kcalPerUnit: Math.round(it.kcal100), barcode: it.code, p: it.p, c: it.c, f: it.f, srvG: it.srvG, srvLabel: it.srvLabel }; S.ingredients.push(ing); save(); }
  document.getElementById('scanAgain').onclick = () => drawScan(document.getElementById('modeBody'), state);
  document.getElementById('scAdd').onclick = () => {
    const g = grams(); if (!g) return toast('Enter an amount');
    const amt = +document.getElementById('scAmt').value;
    addFoods([{ name: `${it.name} (${unit === 'srv' ? `${amt} srv` : `${Math.round(g)} g`})`, ...per(g), source: 'barcode' }], state.meal, state.date);
  };
}

// Common foods (foods.js) as objects, per 100 g
const CF = (typeof COMMON_FOODS !== 'undefined' ? COMMON_FOODS : []).map(([name, kcal, p, c, f, srvLabel, srvG], i) => ({ i, name, kcal, p, c, f, srvLabel, srvG }));
const cfScale = (food, grams) => ({ kcal: food.kcal * grams / 100, protein: food.p * grams / 100, carbs: food.c * grams / 100, fat: food.f * grams / 100 });
function searchCommon(q, limit = 40) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return CF.filter(f => words.every(w => f.name.toLowerCase().includes(w)))
    .sort((a, b) => a.name.toLowerCase().indexOf(words[0]) - b.name.toLowerCase().indexOf(words[0]) || a.i - b.i).slice(0, limit);
}
// Chain restaurant items (restaurants.js), per serving
const RF = (typeof RESTAURANT_FOODS !== 'undefined' ? RESTAURANT_FOODS : []).map(([chain, item, kcal, p, c, f, srv], i) => ({ i, chain, item, kcal, p, c, f, srv, hay: `${chain} ${item}`.toLowerCase().replace(/[’']/g, '') }));
const RF_CHAINS = [...new Set(RF.map(r => r.chain))];
function searchRestaurants(q, limit = 40) {
  const words = q.toLowerCase().replace(/[’']/g, '').split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return RF.filter(r => words.every(w => r.hay.includes(w))).slice(0, limit);
}
// Saved copy of a common food so recipes can use it like any ingredient
function ingredientFromCommon(food) {
  let ing = S.ingredients.find(i => i.name.toLowerCase() === food.name.toLowerCase() && i.unit === 'g');
  if (!ing) { ing = { id: uid(), name: food.name, unit: 'g', unitSize: 100, kcalPerUnit: food.kcal, common: true }; S.ingredients.push(ing); save(); }
  return ing;
}

function drawLibraryPick(el, state) {
  el.innerHTML = `
    <input id="libSearch" placeholder="Search foods, restaurants, recipes… e.g. big mac" autocomplete="off">
    <ul class="list" id="libList"></ul>
    <p class="small muted">Common foods use USDA averages (amounts in grams). Restaurant items are approximate, from each chain's published nutrition info.</p>`;
  const list = document.getElementById('libList');
  const draw = q => {
    q = (q || '').toLowerCase().trim();
    const recs = S.recipes.filter(r => r.name.toLowerCase().includes(q)).map(r => `<li><span class="name">🍲 ${esc(r.name)}<br><span class="small muted">${Math.round(recipePerServing(r))} kcal / serving</span></span><input type="number" inputmode="decimal" value="1" step="0.25" style="width:70px" data-r="${r.id}"><span class="small muted">srv</span><button class="btn small primary" data-addr="${r.id}">Add</button></li>`);
    const ings = S.ingredients.filter(i => !i.common && i.name.toLowerCase().includes(q)).map(i => `<li><span class="name">🥕 ${esc(i.name)}<br><span class="small muted">${i.kcalPerUnit} kcal / ${i.unitSize} ${esc(i.unit)}</span></span><input type="number" inputmode="decimal" value="${i.unitSize}" style="width:70px" data-i="${i.id}"><span class="small muted">${esc(i.unit)}</span><button class="btn small primary" data-addi="${i.id}">Add</button></li>`);
    const commons = searchCommon(q).map(f => `<li><span class="name">${esc(f.name)}<br><span class="small muted">${f.kcal} kcal/100 g · ${esc(f.srvLabel)} = ${f.srvG} g (${Math.round(f.kcal * f.srvG / 100)})</span></span><input type="number" inputmode="decimal" value="${f.srvG}" style="width:70px" data-c="${f.i}"><span class="small muted">g</span><button class="btn small primary" data-addc="${f.i}">Add</button></li>`);
    const rests = searchRestaurants(q).map(r => `<li><span class="name">🍔 ${esc(r.item)}<br><span class="small muted">${esc(r.chain)} · ${r.kcal} kcal / ${esc(r.srv)}</span></span><input type="number" inputmode="decimal" value="1" step="0.5" style="width:60px" data-rq="${r.i}"><span class="small muted">×</span><button class="btn small primary" data-addrf="${r.i}">Add</button></li>`);
    const chips = !q ? `<li style="display:block;border:0"><div class="small muted" style="margin-bottom:6px">Restaurants</div><div class="chips">${RF_CHAINS.map(c => `<button class="chip" data-chain="${esc(c)}">${esc(c)}</button>`).join('')}</div></li>` : '';
    const ask = q && aiKey() ? `<li style="display:block;border:0;padding-top:12px"><button class="btn blue" id="askAI">✨ Look up “${esc(q)}” with AI</button><div id="askOut"></div></li>` : '';
    list.innerHTML = (recs.concat(ings, rests, commons).join('') || `<li class="muted">${q ? `No matches.${aiKey() ? ' Try the AI lookup below, or Quick add.' : ' Try Quick add, or add an AI key in Settings to look up any food.'}` : 'Type to search your foods, restaurant menus and common foods.'}</li>`) + chips + ask;
    list.querySelectorAll('[data-chain]').forEach(b => b.onclick = () => { const inp = document.getElementById('libSearch'); inp.value = b.dataset.chain; draw(inp.value); });
    list.querySelectorAll('[data-addrf]').forEach(b => b.onclick = () => { const r = RF[+b.dataset.addrf]; const n = +list.querySelector(`[data-rq="${r.i}"]`).value || 1; addFoods([{ name: `${r.chain} ${r.item}${n !== 1 ? ` (×${n})` : ''}`, kcal: r.kcal * n, protein: r.p * n, carbs: r.c * n, fat: r.f * n, source: 'restaurant' }], state.meal, state.date); });
    if (ask) document.getElementById('askAI').onclick = async e => {
      const out = document.getElementById('askOut'); e.target.disabled = true;
      out.innerHTML = '<div class="spinner"></div><p class="center small muted" id="aiStatus">Looking it up…</p>';
      try { renderAIResult(out, await estimateFood(null, '', lookupPrompt(q)), state); }
      catch (err) { out.innerHTML = `<div class="warnbox">${esc(err.message)}</div>`; }
      e.target.disabled = false;
    };
    list.querySelectorAll('[data-addr]').forEach(b => b.onclick = () => { const r = S.recipes.find(x => x.id === b.dataset.addr); const srv = +list.querySelector(`[data-r="${r.id}"]`).value || 1; addFoods([{ name: `${r.name} (${srv} srv)`, kcal: recipePerServing(r) * srv, source: 'recipe' }], state.meal, state.date); });
    list.querySelectorAll('[data-addi]').forEach(b => b.onclick = () => { const i = ingById(b.dataset.addi); const q = +list.querySelector(`[data-i="${i.id}"]`).value || 0; addFoods([{ name: `${i.name} (${q} ${i.unit})`, kcal: ingKcal(i, q), source: 'ingredient' }], state.meal, state.date); });
    list.querySelectorAll('[data-addc]').forEach(b => b.onclick = () => { const f = CF[+b.dataset.addc]; const g = +list.querySelector(`[data-c="${f.i}"]`).value || 0; addFoods([{ name: `${f.name} (${g} g)`, ...cfScale(f, g), source: 'common' }], state.meal, state.date); });
  };
  draw(''); document.getElementById('libSearch').oninput = e => draw(e.target.value);
  if (!S.recipes.length && !S.ingredients.some(i => !i.common)) setTimeout(() => document.getElementById('libSearch')?.focus(), 50);
}

// ---------- AI photo estimation (Gemini or Claude API, called directly from the browser) ----------
const aiKey = () => S.settings.aiProvider === 'claude' ? S.settings.apiKey : S.settings.geminiKey;
function drawPhoto(el, state) {
  if (!aiKey()) {
    el.innerHTML = `<p class="muted">To use AI photo estimates, add a ${S.settings.aiProvider === 'claude' ? 'Anthropic' : 'free Google Gemini'} API key in Settings. It stays on this device only.</p><button class="btn" id="goSet">Open Settings</button>`;
    document.getElementById('goSet').onclick = () => { closeSheet(); tab = 'settings'; render(); };
    return;
  }
  el.innerHTML = `
    <div class="btn-grid"><button class="btn blue" id="camBtn">📷 Take photo</button><button class="btn blue" id="libBtn">🖼 Choose photo</button></div>
    <input type="file" accept="image/*" capture="environment" id="camIn" class="visually-hidden">
    <input type="file" accept="image/*" id="photoIn" class="visually-hidden">
    <img id="prev" class="preview-img hidden" alt="">
    <label>Size / weight hints (optional, improves accuracy)</label>
    <textarea id="hint" rows="2" placeholder="e.g. plate is 10 in wide; chicken ~150 g; 1 cup rice"></textarea>
    <button class="btn primary" id="estBtn" style="margin-top:12px" disabled>Estimate calories</button>
    <div id="aiOut"></div>`;
  let imgData = null;
  document.getElementById('camBtn').onclick = () => document.getElementById('camIn').click();
  document.getElementById('libBtn').onclick = () => document.getElementById('photoIn').click();
  const onPick = async e => {
    const file = e.target.files[0]; if (!file) return;
    const out = document.getElementById('aiOut'); out.innerHTML = '';
    try {
      imgData = await resizeImage(file, 1024);
      const p = document.getElementById('prev'); p.src = 'data:image/jpeg;base64,' + imgData; p.classList.remove('hidden');
      document.getElementById('estBtn').disabled = false;
    } catch (err) { out.innerHTML = `<div class="warnbox">${esc(err.message)}</div>`; }
    e.target.value = '';
  };
  document.getElementById('camIn').onchange = onPick;
  document.getElementById('photoIn').onchange = onPick;
  document.getElementById('estBtn').onclick = async () => {
    const out = document.getElementById('aiOut');
    out.innerHTML = '<div class="spinner"></div><p class="center small muted" id="aiStatus">Estimating…</p>';
    document.getElementById('estBtn').disabled = true;
    try {
      const res = await estimateFood(imgData, document.getElementById('hint').value);
      renderAIResult(out, res, state);
    } catch (err) {
      out.innerHTML = `<div class="warnbox">${esc(err.message)}</div>`;
    } finally { const b = document.getElementById('estBtn'); if (b) b.disabled = false; }
  };
}

function resizeImage(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.8).split(',')[1]);
    };
    img.onerror = () => reject(new Error('Could not read that photo. Try another one, or take a new photo.'));
    img.src = URL.createObjectURL(file);
  });
}

const FOOD_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items', 'total_kcal', 'confidence', 'notes'],
  properties: {
    items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'portion', 'kcal', 'protein_g', 'carbs_g', 'fat_g'],
      properties: { name: { type: 'string' }, portion: { type: 'string' }, kcal: { type: 'number' }, protein_g: { type: 'number' }, carbs_g: { type: 'number' }, fat_g: { type: 'number' } } } },
    total_kcal: { type: 'number' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    notes: { type: 'string' },
  },
};

function foodPrompt(hint) {
  return `Identify each food in this photo and estimate its portion size and nutrition. ` +
    (hint.trim() ? `The user gave these measurements, which you should trust over visual estimates: "${hint.trim()}". ` : `No measurements were given, so estimate portions from visual cues such as plate and utensil size. `) +
    `Be realistic about hidden calories (oil, butter, sauces, dressings). In notes, say in one short sentence what most affects accuracy.`;
}
const estimateFood = (b64, hint, prompt) => S.settings.aiProvider === 'claude' ? estimateClaude(b64, hint, prompt) : estimateGemini(b64, hint, prompt);
// Text-only lookup, e.g. a restaurant item not in the built-in list
function lookupPrompt(q) {
  return `Give the nutrition facts for: "${q}". If it is a menu item from a restaurant chain, use that chain's official published US nutrition information for its standard serving. ` +
    `Otherwise use a typical serving. List it as one item (or one item per part if it is clearly several foods), with the serving in portion. ` +
    `Set confidence to high only if you are confident these are the official published numbers. In notes, say in one short sentence where the numbers come from or what makes them uncertain.`;
}

// Google Gemini (free tier available at aistudio.google.com)
// Free-tier models are often "overloaded" (503). We retry with backoff, then try other Flash models.
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Friendly model names, e.g. claude-haiku-5-5 → Claude Haiku 5.5, gemini-3.1-flash-lite → Gemini 3.1 Flash Lite
function modelName(id) {
  id = String(id || '').replace(/^models\//, '').replace(/-\d{8}$/, '');
  let m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?$/);
  if (m) return `Claude ${m[1][0].toUpperCase() + m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
  return id.split('-').map(w => /^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1)).join(' ');
}
const aiStatus = msg => { const el = document.getElementById('aiStatus'); if (el) el.textContent = msg; };
// fetch() that turns network failures ("Load failed" on iPhone) into a readable message
async function apiFetch(url, opts, who) {
  try { return await fetch(url, opts); }
  catch { throw new Error(`Couldn't reach ${who}. Check your internet connection and try again.`); }
}
// Keep "thinking" low: food estimates don't need deep reasoning, and it's the main source of delay.
function thinkingFor(model) {
  if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  if (/^gemini-[3-9]/.test(model)) return { thinkingLevel: 'low' };
  return null;
}
async function callGemini(model, b64, prompt, think = true) {
  const tc = think ? thinkingFor(model) : null;
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const resp = await apiFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': S.settings.geminiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [...(b64 ? [{ inline_data: { mime_type: 'image/jpeg', data: b64 } }] : []), { text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', ...(tc ? { thinkingConfig: tc } : {}) },
      }),
    }, 'Google Gemini');
    const data = await resp.json().catch(() => ({}));
    const r = { status: resp.status, ok: resp.ok, data, msg: data?.error?.message || resp.statusText, model };
    // Older/other models may reject the thinking setting: retry once without it
    if (tc && r.status === 400 && /think/i.test(r.msg)) return callGemini(model, b64, prompt, false);
    return r;
  } catch (e) {
    if (ctrl.signal.aborted) return { status: 504, ok: false, data: {}, msg: 'timed out', model };
    throw e;
  } finally { clearTimeout(timer); }
}
async function estimateGemini(b64, hint, custom) {
  const prompt = (custom || foodPrompt(hint)) + ` Reply with JSON only, matching this shape: {"items":[{"name":string,"portion":string,"kcal":number,"protein_g":number,"carbs_g":number,"fat_g":number}],"total_kcal":number,"confidence":"low"|"medium"|"high","notes":string}`;
  const busy = s => s === 500 || s === 503 || s === 504;
  let model = S.settings.geminiModel || 'gemini-3.1-flash-lite';
  const t0 = Date.now();
  aiStatus(`Asking ${modelName(model)}…`);
  let r = await callGemini(model, b64, prompt);
  // Model retired: switch to a current Flash model for good.
  if (r.status === 404) {
    const alt = (await geminiModels()).find(m => m !== model);
    if (alt) { model = alt; S.settings.geminiModel = alt; save(); r = await callGemini(model, b64, prompt); }
  }
  // Busy or slow: try up to two other Flash models right away, then the original once more.
  if (busy(r.status)) {
    for (const alt of (await geminiModels()).filter(m => m !== model).slice(0, 2)) {
      aiStatus(`${modelName(model)} is busy. Trying ${modelName(alt)}…`);
      r = await callGemini(alt, b64, prompt); if (!busy(r.status)) break;
    }
  }
  if (busy(r.status)) { aiStatus('All busy. Retrying in a moment…'); await sleep(2000); r = await callGemini(model, b64, prompt); }
  if (!r.ok) {
    if (r.status === 400 && /API key/i.test(r.msg) || r.status === 403) throw new Error('Your Gemini API key was rejected. Check it in Settings.');
    if (r.status === 429) throw new Error('Gemini free-tier limit reached. Wait a bit and try again, or use Quick add.');
    if (busy(r.status)) throw new Error('Google\'s free Gemini servers are busy right now. Try again in a minute, or use Quick add.');
    throw new Error(`AI request failed (${r.status}): ${r.msg}`);
  }
  const text = (r.data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  if (!text) throw new Error('Gemini returned no estimate. Try again or use Quick add.');
  const res = parseFoodJSON(text);
  res.via = `${modelName(r.model)} · ${Math.round((Date.now() - t0) / 1000)}s`;
  return res;
}
// Current Flash models that accept images, lite first (they have the most generous free limits).
async function geminiModels() {
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': S.settings.geminiKey } });
    const ms = ((await r.json()).models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace('models/', ''));
    const flash = ms.filter(n => /flash/.test(n) && !/image|tts|audio|live|exp|preview|embed/.test(n));
    return [...flash.filter(n => /lite/.test(n)), ...flash.filter(n => !/lite/.test(n))];
  } catch { return []; }
}
function parseFoodJSON(text) {
  try {
    const j = JSON.parse(text.replace(/^```(json)?|```$/gm, '').trim());
    j.items = (j.items || []).map(i => ({ name: i.name || 'Food', portion: i.portion || '', kcal: +i.kcal || 0, protein_g: +i.protein_g || 0, carbs_g: +i.carbs_g || 0, fat_g: +i.fat_g || 0 }));
    j.confidence = j.confidence || 'medium'; j.notes = j.notes || '';
    return j;
  } catch { throw new Error('Could not read the AI response. Try again.'); }
}

// Anthropic Claude (paid API)
async function estimateClaude(b64, hint, custom) {
  const prompt = custom || foodPrompt(hint);
  const model = S.settings.aiModel || 'claude-opus-5-5';
  const canFallback = !/haiku/.test(model); // server-side refusal fallback isn't offered for Haiku
  const t0 = Date.now();
  aiStatus(`Asking ${modelName(model)}…`);
  const resp = await apiFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': S.settings.apiKey,
      'anthropic-version': '2026-10-21',
      ...(canFallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      ...(canFallback ? { fallbacks: 'default' } : {}),
      output_config: { effort: 'low', format: { type: 'json_schema', schema: FOOD_SCHEMA } },
      messages: [{ role: 'user', content: [
        ...(b64 ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }] : []),
        { type: 'text', text: prompt },
      ] }],
    }),
  }, 'Anthropic');
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.error?.message || resp.statusText;
    if (resp.status === 401) throw new Error('Your API key was rejected. Check it in Settings.');
    if (resp.status === 429) throw new Error('Rate limited by the API. Wait a moment and try again.');
    throw new Error(`AI request failed (${resp.status}): ${msg}`);
  }
  if (data.stop_reason === 'refusal') throw new Error('The AI declined to estimate this photo. Try Quick add instead.');
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const res = parseFoodJSON(text);
  res.via = `${modelName(data.model || model)} · ${Math.round((Date.now() - t0) / 1000)}s`; // data.model is the one that actually answered
  return res;
}

function renderAIResult(out, res, state) {
  const items = res.items.map(i => ({ ...i }));
  const draw = () => {
    out.innerHTML = `
      <h3 style="margin-top:14px">Estimate <span class="pill ${res.confidence === 'high' ? 'green' : res.confidence === 'low' ? 'amber' : ''}">${esc(res.confidence)} confidence</span></h3>
      ${items.map((it, n) => `<div class="ai-item"><div class="row"><input value="${esc(it.name)}" data-n="${n}" data-f="name" class="grow"><input type="number" inputmode="numeric" value="${Math.round(it.kcal)}" data-n="${n}" data-f="kcal" style="width:80px"><span class="small muted">kcal</span><button class="icon" data-del="${n}">✕</button></div>
        <div class="small muted" style="margin-top:4px">${esc(it.portion)} · P ${Math.round(it.protein_g)}g · C ${Math.round(it.carbs_g)}g · F ${Math.round(it.fat_g)}g</div></div>`).join('')}
      <p class="small muted">${esc(res.notes)}</p>${res.via ? `<p class="small muted" style="margin-top:-4px">✨ Estimated by ${esc(res.via)}</p>` : ''}
      <div class="row between"><b>Total</b><b id="aiTot">${sumKcal(items)} kcal</b></div>
      <button class="btn primary" id="aiLog" style="margin-top:10px">Log ${items.length} item${items.length === 1 ? '' : 's'}</button>`;
    out.querySelectorAll('input[data-n]').forEach(inp => inp.oninput = () => { const it = items[+inp.dataset.n]; it[inp.dataset.f] = inp.dataset.f === 'kcal' ? +inp.value : inp.value; document.getElementById('aiTot').textContent = sumKcal(items) + ' kcal'; });
    out.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { items.splice(+b.dataset.del, 1); draw(); });
    document.getElementById('aiLog').onclick = () => { if (!items.length) return; addFoods(items.map(i => ({ name: i.name, kcal: i.kcal, protein: i.protein_g, carbs: i.carbs_g, fat: i.fat_g, source: 'ai' })), state.meal, state.date); };
  };
  draw();
}

// ---------- Food tab ----------
function renderFood() {
  setTick(null);
  const items = foodsOn(foodDay), total = sumKcal(items), goal = S.settings.calorieGoal;
  const macros = ['protein', 'carbs', 'fat'].map(k => Math.round(items.reduce((a, f) => a + (+f[k] || 0), 0)));
  // Show disabled meals only if they have entries on this day (e.g. logged before disabling).
  const meals = MEALS.filter(m => S.settings.meals[m.id] || items.some(f => f.meal === m.id));
  view.innerHTML = `
    <div class="card"><div class="row between"><button class="icon" id="prevDay">‹</button><b>${foodDay === dayKey() ? 'Today' : fmtDay(foodDay)}</b><button class="icon" id="nextDay" ${foodDay >= dayKey() ? 'disabled style="opacity:.3"' : ''}>›</button></div>
      <div class="row between" style="margin-top:8px"><span class="big-num">${total}</span><span class="muted small">Goal ${goal} · ${goal - total >= 0 ? goal - total + ' left' : total - goal + ' over'}</span></div>
      <div class="bar ${total > goal ? 'over' : ''}" style="margin-top:8px"><div style="width:${Math.min(100, total / goal * 100)}%"></div></div>
      <div class="small muted" style="margin-top:8px">Protein ${macros[0]}g · Carbs ${macros[1]}g · Fat ${macros[2]}g</div>
      ${weekBudgetHTML(foodDay)}</div>
    ${meals.map(m => { const mi = items.filter(f => f.meal === m.id); return `
      <div class="card"><div class="row between"><h3>${m.label}</h3><span class="muted">${sumKcal(mi)} kcal</span></div>
        <ul class="list">${mi.map(f => `<li><span class="name">${f.source === 'ai' ? '📷 ' : ''}${esc(f.name)}</span><span class="kcal">${f.kcal}</span><button class="icon" data-delf="${f.id}">✕</button></li>`).join('')}</ul>
        <button class="link" data-add="${m.id}">+ Add food</button></div>`; }).join('')}
    ${enabledMeals().length < MEALS.length ? `<p class="small muted center">Some meals are hidden. Turn them back on in Settings.</p>` : ''}`;
  document.getElementById('prevDay').onclick = () => { foodDay = addDays(foodDay, -1); render(); };
  document.getElementById('nextDay').onclick = () => { if (foodDay < dayKey()) { foodDay = addDays(foodDay, 1); render(); } };
  view.querySelectorAll('[data-add]').forEach(b => b.onclick = () => openLogSheet(b.dataset.add, 'quick', foodDay));
  view.querySelectorAll('[data-delf]').forEach(b => b.onclick = () => { S.foods = S.foods.filter(f => f.id !== b.dataset.delf); save(); render(); });
}

// ---------- Weight tab ----------
function renderWeight() {
  setTick(null);
  const unit = S.settings.weightUnit;
  const ws = [...S.weights].sort((a, b) => a.date.localeCompare(b.date));
  const latest = ws[ws.length - 1];
  const weekAgo = ws.filter(w => w.date <= addDays(dayKey(), -7)).pop();
  const first = ws[0];
  view.innerHTML = `
    <div class="card">
      <div class="row"><input type="number" inputmode="decimal" step="0.1" id="wVal" placeholder="Weight (${unit})" class="grow"><input type="date" id="wDate" value="${dayKey()}" style="width:150px"></div>
      <button class="btn primary" id="wAdd" style="margin-top:10px">Log weight</button>
      <div class="center"><button class="link" id="wImport" style="margin-top:6px">Import past weights</button></div>
    </div>
    ${ws.length ? `<div class="card">
      <div class="row between"><div><div class="big-num">${latest.value}</div><div class="small muted">${unit} · ${fmtDay(latest.date)}</div></div>
      <div class="small" style="text-align:right">${weekAgo ? `7d: <b>${delta(latest.value - weekAgo.value)}</b><br>` : ''}Total: <b>${delta(latest.value - first.value)}</b></div></div>
      <div class="seg" style="margin-top:12px" id="rangeSeg">${['30', '90', '365', 'all'].map(r => `<button data-r="${r}" class="${weightRange === r ? 'active' : ''}">${r === 'all' ? 'All' : r === '365' ? '1y' : r + 'd'}</button>`).join('')}</div>
      <div class="chart" id="chart"></div>
      <div class="small muted"><span style="color:var(--berry)">●</span> daily weigh-in &nbsp; <span style="color:var(--accent)">━</span> 7-day trend</div>
    </div>
    <div class="card"><h3>History</h3><ul class="list">${[...ws].reverse().slice(0, 60).map(w => `<li><span class="name">${fmtDay(w.date)}</span><span class="kcal">${w.value} ${unit}</span><button class="icon" data-delw="${w.date}">✕</button></li>`).join('')}</ul></div>` : '<div class="card muted">Log your first weigh-in to see your trend.</div>'}`;
  document.getElementById('wAdd').onclick = () => {
    const v = +document.getElementById('wVal').value, d = document.getElementById('wDate').value;
    if (!v || !d) return toast('Enter a weight');
    S.weights = S.weights.filter(w => w.date !== d); S.weights.push({ date: d, value: v }); save(); toast('Weight logged'); render();
  };
  document.getElementById('wImport').onclick = openWeightImport;
  view.querySelectorAll('[data-delw]').forEach(b => b.onclick = () => { S.weights = S.weights.filter(w => w.date !== b.dataset.delw); save(); render(); });
  view.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { weightRange = b.dataset.r; render(); });
  if (ws.length) drawChart(document.getElementById('chart'), ws);
}
let weightRange = '90';
// ---------- Import past weights from pasted text ----------
// Reads one weigh-in per line, e.g. "may 16 - 123.0", "Sept 5: 119", "2025-03-01 130.2", "3/1/25 130.2", "12 Jan 2025 64.5".
// Anything after the weight (notes) is ignored. Lines without a year count backwards from today.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function parseWeightLines(text) {
  const rows = [], skipped = [];
  const mon = m => MONTHS.indexOf(m.slice(0, 3)) + 1;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().toLowerCase().replace(/^[-•*\s]+/, '');
    if (!line) continue;
    let m, y = null, mo, d, rest;
    if ((m = line.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(.*)$/))) [, y, mo, d, rest] = m;
    else if ((m = line.match(/^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?(?!\d)(.*)$/))) [, mo, d, y, rest] = m;
    else if ((m = line.match(/^([a-z]{3,9})\.?\s*(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?!\d)(.*)$/)) && mon(m[1]) > 0) { [, mo, d, y, rest] = m; mo = mon(mo); }
    else if ((m = line.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?(?:,?\s+(\d{4}))?(.*)$/)) && mon(m[2]) > 0) { [, d, mo, y, rest] = m; mo = mon(mo); }
    else { skipped.push(raw.trim()); continue; }
    const w = (rest || '').match(/(\d{2,3}(?:[.,]\d+)?)/);
    mo = +mo; d = +d; y = y ? +y : null; if (y && y < 100) y += 2000;
    const val = w ? parseFloat(w[1].replace(',', '.')) : NaN;
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31) || !(val >= 20 && val <= 1000)) { skipped.push(raw.trim()); continue; }
    rows.push({ y, mo, d, value: Math.round(val * 10) / 10 });
  }
  // Fill in missing years: the last line is the most recent date on or before today; earlier lines step back a year when the date goes "up".
  const today = dayKey(), cy = +today.slice(0, 4);
  const key = (y, mo, d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  let nextKey = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (!r.y) {
      let y = nextKey ? +nextKey.slice(0, 4) : cy;
      if (key(y, r.mo, r.d) > (nextKey || today)) y--;
      r.y = y;
    }
    r.date = key(r.y, r.mo, r.d); nextKey = r.date;
  }
  return { rows: rows.filter(r => !isNaN(new Date(r.date).getTime())), skipped };
}
function openWeightImport() {
  const unit = S.settings.weightUnit;
  openSheet(`<div class="row between"><h2>Import past weights</h2><button class="icon" id="x">✕</button></div>
    <p class="small muted" style="margin-top:0">Paste your list, one weigh-in per line, like <b>may 16 - 123.0</b> or <b>2025-05-16 123</b>. Notes after the number are ignored. Weights are read as ${unit}.</p>
    <textarea id="wiText" rows="8" placeholder="may 9 - 124.2&#10;may 16 - 123.0&#10;june 12 - 120.4"></textarea>
    <div id="wiPrev" class="small" style="margin-top:8px"></div>
    <button class="btn primary" id="wiGo" style="margin-top:12px" disabled>Import</button>`);
  document.getElementById('x').onclick = closeSheet;
  let parsed = { rows: [], skipped: [] };
  const prev = () => {
    parsed = parseWeightLines(document.getElementById('wiText').value);
    const { rows, skipped } = parsed, el = document.getElementById('wiPrev');
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    const clash = rows.filter(r => S.weights.some(w => w.date === r.date)).length;
    el.innerHTML = rows.length ? `<b>${rows.length} weigh-in${rows.length > 1 ? 's' : ''}</b> from ${fmtDay(sorted[0].date)} ${sorted[0].y} to ${fmtDay(sorted[sorted.length - 1].date)} ${sorted[sorted.length - 1].y}${clash ? `. ${clash} replace${clash > 1 ? '' : 's'} a weight already logged that day` : ''}.
      <ul class="list" style="max-height:180px;overflow:auto">${sorted.map(r => `<li><span class="name">${fmtDay(r.date)} ${r.y}</span><span class="kcal">${r.value} ${unit}</span></li>`).join('')}</ul>`
      + (skipped.length ? `<p class="muted">Skipped ${skipped.length} line${skipped.length > 1 ? 's' : ''} I couldn't read: ${skipped.slice(0, 3).map(esc).join(' · ')}${skipped.length > 3 ? ' …' : ''}</p>` : '')
      : (document.getElementById('wiText').value.trim() ? '<span class="muted">No weigh-ins found yet. Each line needs a date and a weight.</span>' : '');
    const go = document.getElementById('wiGo'); go.disabled = !rows.length; go.textContent = rows.length ? `Import ${rows.length} weigh-in${rows.length > 1 ? 's' : ''}` : 'Import';
  };
  document.getElementById('wiText').oninput = prev;
  document.getElementById('wiGo').onclick = () => {
    const dates = new Set(parsed.rows.map(r => r.date));
    S.weights = S.weights.filter(w => !dates.has(w.date)).concat(parsed.rows.map(r => ({ date: r.date, value: r.value })));
    save(); closeSheet(); weightRange = 'all'; toast(`Imported ${parsed.rows.length} weigh-ins`); render();
  };
}

const delta = d => `${d > 0 ? '+' : ''}${d.toFixed(1)}`;

function drawChart(el, ws) {
  const from = weightRange === 'all' ? ws[0].date : addDays(dayKey(), -+weightRange);
  // 7-day trailing average for trend, computed on all data then clipped
  const trend = ws.map(w => { const lo = addDays(w.date, -6); const win = ws.filter(x => x.date >= lo && x.date <= w.date); return { date: w.date, value: win.reduce((a, x) => a + x.value, 0) / win.length }; });
  const pts = ws.filter(w => w.date >= from), tr = trend.filter(w => w.date >= from);
  if (!pts.length) { el.innerHTML = '<p class="muted small">No weigh-ins in this range.</p>'; return; }
  const W = 340, H = 180, P = { l: 36, r: 8, t: 10, b: 22 };
  const t0 = new Date(pts[0].date + 'T12:00').getTime(), t1 = Math.max(new Date(pts[pts.length - 1].date + 'T12:00').getTime(), t0 + 864e5);
  const vals = pts.map(p => p.value).concat(tr.map(p => p.value));
  let lo = Math.min(...vals), hi = Math.max(...vals); const pad = Math.max(1, (hi - lo) * 0.15); lo -= pad; hi += pad;
  const x = d => P.l + (new Date(d + 'T12:00').getTime() - t0) / (t1 - t0) * (W - P.l - P.r);
  const y = v => P.t + (hi - v) / (hi - lo) * (H - P.t - P.b);
  const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}">
    ${ticks.map(t => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}" style="stroke:var(--line-soft)" stroke-dasharray="3 3"/><text x="${P.l - 4}" y="${y(t) + 4}" style="fill:var(--muted)" font-size="10" text-anchor="end">${t.toFixed(1)}</text>`).join('')}
    <text x="${P.l}" y="${H - 6}" style="fill:var(--muted)" font-size="10">${fmtDay(pts[0].date)}</text>
    <text x="${W - P.r}" y="${H - 6}" style="fill:var(--muted)" font-size="10" text-anchor="end">${fmtDay(pts[pts.length - 1].date)}</text>
    ${tr.length > 1 ? `<polyline fill="none" style="stroke:var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="${tr.map(p => `${x(p.date)},${y(p.value)}`).join(' ')}"/>` : ''}
    ${pts.map(p => `<circle cx="${x(p.date)}" cy="${y(p.value)}" r="3.5" style="fill:var(--berry);stroke:var(--ink)" stroke-width="1"/>`).join('')}
  </svg>`;
}

// ---------- Library (ingredients & recipes) ----------
let libMode = 'recipes';
function renderLibrary() {
  setTick(null);
  view.innerHTML = `
    <div class="seg">${['recipes', 'ingredients'].map(m => `<button data-lm="${m}" class="${libMode === m ? 'active' : ''}">${m === 'recipes' ? 'Recipes' : 'Ingredients'}</button>`).join('')}</div>
    <div id="libBody"></div>`;
  view.querySelectorAll('[data-lm]').forEach(b => b.onclick = () => { libMode = b.dataset.lm; render(); });
  const body = document.getElementById('libBody');
  if (libMode === 'ingredients') {
    body.innerHTML = `<button class="btn primary" id="newIng">+ New ingredient</button>
      <div class="card" style="margin-top:12px"><ul class="list">${S.ingredients.map(i => `<li><span class="name">${esc(i.name)}<br><span class="small muted">${i.kcalPerUnit} kcal per ${i.unitSize} ${esc(i.unit)}</span></span><button class="icon" data-edi="${i.id}">✎</button><button class="icon" data-deli="${i.id}">✕</button></li>`).join('') || '<li class="muted">No custom ingredients yet. Common foods (chicken, rice, apples…) are built in. Add your own here from a nutrition label.</li>'}</ul></div>`;
    document.getElementById('newIng').onclick = () => ingredientSheet();
    body.querySelectorAll('[data-edi]').forEach(b => b.onclick = () => ingredientSheet(ingById(b.dataset.edi)));
    body.querySelectorAll('[data-deli]').forEach(b => b.onclick = async () => {
      const used = S.recipes.filter(r => r.items.some(it => it.ingId === b.dataset.deli));
      if (used.length && (await confirmDialog({ title: 'Delete ingredient?', body: `It's used in: ${used.map(r => r.name).join(', ')}. Those recipes will lose it.`, ok: 'Delete', danger: true })) !== true) return;
      S.ingredients = S.ingredients.filter(i => i.id !== b.dataset.deli); S.recipes.forEach(r => r.items = r.items.filter(it => it.ingId !== b.dataset.deli)); save(); render();
    });
  } else {
    body.innerHTML = `<button class="btn primary" id="newRec">+ New recipe</button>
      <div class="card" style="margin-top:12px"><ul class="list">${S.recipes.map(r => `<li><span class="name">${esc(r.name)}<br><span class="small muted">${Math.round(recipePerServing(r))} kcal/serving · ${r.servings} servings · ${Math.round(recipeKcal(r))} total</span></span><button class="icon" data-edr="${r.id}">✎</button><button class="icon" data-delr="${r.id}">✕</button></li>`).join('') || '<li class="muted">No recipes yet. Build one from your ingredients.</li>'}</ul></div>`;
    document.getElementById('newRec').onclick = () => recipeSheet();
    body.querySelectorAll('[data-edr]').forEach(b => b.onclick = () => recipeSheet(S.recipes.find(r => r.id === b.dataset.edr)));
    body.querySelectorAll('[data-delr]').forEach(b => b.onclick = () => { S.recipes = S.recipes.filter(r => r.id !== b.dataset.delr); save(); render(); });
  }
}

function ingredientSheet(ing, onSaved) {
  const i = ing || { name: '', unit: 'g', unitSize: 100, kcalPerUnit: '' };
  openSheet(`<h2>${ing ? 'Edit' : 'New'} ingredient</h2>
    <label>Name</label><input id="iN" value="${esc(i.name)}" placeholder="e.g. Chicken breast">
    <div class="row"><div class="grow"><label>Calories</label><input id="iK" type="number" inputmode="decimal" value="${i.kcalPerUnit}"></div>
    <div style="padding-top:30px">per</div><div style="width:80px"><label>Amount</label><input id="iS" type="number" inputmode="decimal" value="${i.unitSize}"></div>
    <div style="width:110px"><label>Unit</label><select id="iU">${['g', 'oz', 'ml', 'cup', 'tbsp', 'tsp', 'piece', 'serving'].map(u => `<option ${u === i.unit ? 'selected' : ''}>${u}</option>`).join('')}</select></div></div>
    <div class="btn-grid" style="margin-top:14px"><button class="btn" id="iC">Cancel</button><button class="btn primary" id="iO">Save</button></div>`);
  document.getElementById('iC').onclick = closeSheet;
  document.getElementById('iO').onclick = () => {
    const name = document.getElementById('iN').value.trim(), k = +document.getElementById('iK').value, sz = +document.getElementById('iS').value;
    if (!name || !k || !sz) return toast('Fill in name, calories and amount');
    const obj = ing || { id: uid() }; Object.assign(obj, { name, kcalPerUnit: k, unitSize: sz, unit: document.getElementById('iU').value });
    if (!ing) S.ingredients.push(obj); save(); closeSheetSilently(); if (onSaved) onSaved(obj); else render();
  };
}

function recipeSheet(rec) {
  const r = rec ? structuredClone(rec) : { id: uid(), name: '', servings: 1, items: [] };
  const draw = () => {
    openSheet(`<div class="row between"><h2>${rec ? 'Edit' : 'New'} recipe</h2><button class="icon" id="rX">✕</button></div>
      <label>Name</label><input id="rN" value="${esc(r.name)}" placeholder="e.g. Turkey chili">
      <label>Servings it makes</label><input id="rS" type="number" inputmode="decimal" value="${r.servings}">
      <h3 style="margin-top:14px">Ingredients</h3>
      <ul class="list">${r.items.map((it, n) => { const ing = ingById(it.ingId); return `<li><span class="name">${esc(ing?.name || '?')}</span><input type="number" inputmode="decimal" value="${it.qty}" data-q="${n}" style="width:70px"><span class="small muted">${esc(ing?.unit || '')}</span><span class="kcal" style="width:60px;text-align:right">${Math.round(ingKcal(ing, it.qty))}</span><button class="icon" data-rm="${n}">✕</button></li>`; }).join('') || '<li class="muted small">No ingredients added</li>'}</ul>
      <div style="margin-top:8px"><input id="rSearch" placeholder="Add ingredient: search foods…" autocomplete="off"><ul class="list" id="rResults"></ul></div>
      <div class="row between" style="margin-top:12px"><span class="muted">Total ${Math.round(recipeKcal(r))} kcal</span><b>${Math.round(recipePerServing(r))} kcal / serving</b></div>
      <button class="btn primary" id="rSave" style="margin-top:14px">Save recipe</button>`);
    const sync = () => { r.name = document.getElementById('rN').value; r.servings = +document.getElementById('rS').value || 1; };
    document.getElementById('rX').onclick = closeSheet;
    document.getElementById('rS').onchange = () => { sync(); draw(); };
    sheetBody.querySelectorAll('[data-q]').forEach(inp => inp.onchange = () => { sync(); r.items[+inp.dataset.q].qty = +inp.value; draw(); });
    sheetBody.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { sync(); r.items.splice(+b.dataset.rm, 1); draw(); });
    const rRes = document.getElementById('rResults');
    const addIng = ing => { sync(); r.items.push({ ingId: ing.id, qty: ing.unitSize }); draw(); };
    document.getElementById('rSearch').oninput = e => {
      const q = e.target.value.trim().toLowerCase();
      if (!q) { rRes.innerHTML = ''; return; }
      const mine = S.ingredients.filter(i => i.name.toLowerCase().includes(q)).slice(0, 8);
      const commons = searchCommon(q, 12).filter(f => !mine.some(i => i.name.toLowerCase() === f.name.toLowerCase()));
      rRes.innerHTML = mine.map(i => `<li><span class="name">🥕 ${esc(i.name)} <span class="small muted">${i.kcalPerUnit} kcal/${i.unitSize} ${esc(i.unit)}</span></span><button class="btn small" data-mi="${i.id}">Add</button></li>`).join('')
        + commons.map(f => `<li><span class="name">${esc(f.name)} <span class="small muted">${f.kcal} kcal/100 g</span></span><button class="btn small" data-ci="${f.i}">Add</button></li>`).join('')
        + `<li><span class="name muted">Not here?</span><button class="btn small" data-new="1">+ New ingredient</button></li>`;
      rRes.querySelectorAll('[data-mi]').forEach(b => b.onclick = () => addIng(ingById(b.dataset.mi)));
      rRes.querySelectorAll('[data-ci]').forEach(b => b.onclick = () => { const f = CF[+b.dataset.ci]; const ing = ingredientFromCommon(f); sync(); r.items.push({ ingId: ing.id, qty: f.srvG }); draw(); });
      rRes.querySelector('[data-new]').onclick = () => { sync(); ingredientSheet(null, ing => { r.items.push({ ingId: ing.id, qty: ing.unitSize }); draw(); }); };
    };
    document.getElementById('rSave').onclick = () => {
      sync(); if (!r.name.trim()) return toast('Give the recipe a name');
      const idx = S.recipes.findIndex(x => x.id === r.id); if (idx >= 0) S.recipes[idx] = r; else S.recipes.push(r);
      save(); closeSheetSilently(); render();
    };
  };
  draw();
}

// ---------- Settings ----------

// ---------- Calorie calculator (same formulas as calculator.net) ----------
// BMR: Mifflin-St Jeor. Maintenance = BMR × activity. 1 lb of body weight ≈ 3,500 kcal, 1 kg ≈ 7,700 kcal.
const ACTIVITY = [
  [1.2, 'Sedentary', 'little or no exercise'],
  [1.375, 'Light', 'exercise 1–3 times a week'],
  [1.465, 'Moderate', 'exercise 4–5 times a week'],
  [1.55, 'Active', 'daily exercise, or intense exercise 3–4 times a week'],
  [1.725, 'Very active', 'intense exercise 6–7 times a week'],
  [1.9, 'Extra active', 'very intense exercise daily, or a physical job'],
];
const GOAL_RATES = { lb: [-2, -1.5, -1, -0.5, 0, 0.5, 1], kg: [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5] };
function latestWeight() { return S.weights.length ? [...S.weights].sort((a, b) => a.date < b.date ? 1 : -1)[0].value : null; }
function calorieCalc() {
  const st = S.settings, w = latestWeight();
  if (!st.sex || !st.age || !st.heightCm || !w) return null;
  const kg = st.weightUnit === 'kg' ? w : w * 0.45359237;
  const bmr = 10 * kg + 6.25 * st.heightCm - 5 * st.age + (st.sex === 'male' ? 5 : -161);
  const maintain = bmr * st.activity;
  const perUnit = st.weightUnit === 'kg' ? 7700 : 3500;
  const target = maintain + (st.goalRate * perUnit) / 7;
  const floor = st.sex === 'male' ? 1500 : 1200;
  const round = n => Math.round(n / 10) * 10;
  return { bmr: round(bmr), maintain: round(maintain), target: round(Math.max(target, 0)), floor, low: target < floor };
}
function rateLabel(r, u) { return r === 0 ? 'Maintain weight' : `${r < 0 ? 'Lose' : 'Gain'} ${Math.abs(r)} ${u} a week`; }
function applyAutoGoal() {
  if (!S.settings.autoGoal) return;
  const c = calorieCalc();
  if (c && c.target && S.settings.calorieGoal !== c.target) { S.settings.calorieGoal = c.target; save(); }
}
const SETTINGS_SECS = {
  account:  { label: 'Account', icon: '👤' },
  goal:     { label: 'Calorie goal', icon: '🎯', sub: 'Body stats, maintenance, weekly budget' },
  fasting:  { label: 'Fasting', icon: '⏱️', sub: 'Schedule and streak' },
  meals:    { label: 'Meals', icon: '🍽️', sub: 'Which meals to show' },
  remind:   { label: 'Reminders', icon: '🔔', sub: 'Notifications and calendar' },
  look:     { label: 'Appearance', icon: '🎨', sub: 'Color palette' },
  units:    { label: 'Units', icon: '⚖️', sub: 'Imperial or metric' },
  ai:       { label: 'AI photo logging', icon: '📷', sub: 'Gemini or Claude' },
  data:     { label: 'Backup & data', icon: '🗄️', sub: 'Export, import, erase' },
};
function settingsMenuHTML() {
  const st = S.settings, c = calorieCalc(), th = THEMES[st.theme === 'auto' ? seasonNow() : st.theme] || THEMES.cocoa;
  const subs = {
    account: Cloud.signedIn() ? 'Signed in · syncing' : 'Optional · sign in to sync',
    goal: `${st.calorieGoal.toLocaleString()} kcal a day${st.autoGoal && c ? ' · auto' : ''}`,
    fasting: `${st.fastHours}:${24 - st.fastHours}${st.sameEveryDay ? ` · first meal ${hm12(st.eatStart)}` : ' · custom by day'}`,
    look: st.theme === 'auto' ? `Match season (${th.label})` : th.label,
    units: st.weightUnit === 'kg' ? 'Metric (kg, cm)' : 'Imperial (lb, ft/in)',
    ai: st.aiProvider === 'claude' ? 'Anthropic Claude' : 'Google Gemini',
  };
  const row = k => `<button class="menu-row" data-sec-open="${k}"><span class="menu-ico">${SETTINGS_SECS[k].icon}</span><span class="grow"><span class="menu-label">${SETTINGS_SECS[k].label}</span><span class="menu-sub">${esc(subs[k] || SETTINGS_SECS[k].sub)}</span></span><svg class="menu-chev" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>`;
  const group = (title, keys) => `${title ? `<div class="menu-head">${title}</div>` : ''}<div class="card menu">${keys.map(row).join('')}</div>`;
  return group('', ['account']) + group('Goals', ['goal', 'fasting', 'meals']) + group('General', ['remind', 'look', 'units', 'ai']) + group('Data', ['data'])
    + `<p class="small center" style="color:var(--on-bg);opacity:.8;margin:6px 0 0">App version ${APP_VERSION}</p>`;
}
function goalCardHTML() {
  const st = S.settings, u = st.weightUnit, c = calorieCalc(), w = latestWeight();
  const ftIn = st.heightCm ? [Math.floor(st.heightCm / 30.48), Math.round((st.heightCm / 2.54) % 12)] : ['', ''];
  if (ftIn[1] === 12) { ftIn[0]++; ftIn[1] = 0; }
  return `<div class="card"><h2>About you</h2>
      <div class="seg" id="gSex">${[['female', 'Female'], ['male', 'Male']].map(([v, l]) => `<button data-sex="${v}" class="${st.sex === v ? 'active' : ''}">${l}</button>`).join('')}</div>
      <div class="btn-grid">
        <div><label style="margin-top:0">Age</label><input type="number" inputmode="numeric" id="gAge" value="${st.age || ''}" placeholder="years"></div>
        <div><label style="margin-top:0">Current weight (${u})</label><input type="number" inputmode="decimal" step="0.1" id="gWt" value="${w ?? ''}" placeholder="${u}"></div>
      </div>
      <label>Height</label>
      ${u === 'kg' ? `<div class="unit-in"><input type="number" inputmode="numeric" id="gCm" value="${st.heightCm ? Math.round(st.heightCm) : ''}"><span>cm</span></div>`
        : `<div class="btn-grid"><div class="unit-in"><input type="number" inputmode="numeric" id="gFt" value="${ftIn[0]}"><span>ft</span></div><div class="unit-in"><input type="number" inputmode="numeric" id="gIn" value="${ftIn[1]}"><span>in</span></div></div>`}
      <label>Activity</label><select id="gAct">${ACTIVITY.map(([m, l, d]) => `<option value="${m}" ${st.activity === m ? 'selected' : ''}>${l}: ${d}</option>`).join('')}</select>
      <p class="small muted">Weight comes from your latest weigh-in. Changing it here logs today's weight.</p></div>
    <div class="card"><h2>Your goal</h2>
      <select id="gRate">${GOAL_RATES[u].map(r => `<option value="${r}" ${st.goalRate === r ? 'selected' : ''}>${rateLabel(r, u)}</option>`).join('')}</select>
      ${c ? `<div class="btn-grid" style="margin-top:12px">
          <div class="card stat center" style="margin:0;padding:10px"><div class="small muted">Maintenance</div><div class="big-num" style="font-size:28px">${c.maintain.toLocaleString()}</div><div class="small muted">kcal a day</div></div>
          <div class="card stat center" style="margin:0;padding:10px"><div class="small muted">${st.goalRate === 0 ? 'Target' : rateLabel(st.goalRate, u)}</div><div class="big-num" style="font-size:28px">${c.target.toLocaleString()}</div><div class="small muted">kcal a day</div></div>
        </div>
        <p class="small muted">Resting burn (BMR) is ${c.bmr.toLocaleString()} kcal. Estimates use the Mifflin-St Jeor formula, the same as calculator.net.</p>
        ${c.low ? `<div class="warnbox">That's below ${c.floor.toLocaleString()} kcal a day, the usual minimum for ${st.sex === 'male' ? 'men' : 'women'} without medical supervision. Consider a slower rate.</div>` : ''}
        <div class="switch"><span>Set my daily goal from this<br><span class="small muted">Updates by itself as your weight changes</span></span><input type="checkbox" id="gAuto" ${st.autoGoal ? 'checked' : ''}></div>`
      : `<p class="small muted">Fill in everything above to see your maintenance calories and a target for your goal.</p>`}
    </div>`;
}
function bindGoalCard() {
  const st = S.settings, $ = id => document.getElementById(id);
  const upd = (k, v) => { st[k] = v; save(); render(); };
  view.querySelectorAll('[data-sex]').forEach(b => b.onclick = () => upd('sex', b.dataset.sex));
  $('gAge').onchange = e => upd('age', Math.max(0, Math.round(+e.target.value)) || null);
  $('gWt').onchange = e => { const v = parseFloat(e.target.value); if (!(v > 0)) return; const d = dayKey(); S.weights = S.weights.filter(w => w.date !== d); S.weights.push({ date: d, value: Math.round(v * 10) / 10 }); save(); toast('Weight logged for today'); render(); };
  if ($('gCm')) $('gCm').onchange = e => upd('heightCm', +e.target.value || null);
  if ($('gFt')) $('gFt').onchange = $('gIn').onchange = () => { const cm = ((+$('gFt').value || 0) * 12 + (+$('gIn').value || 0)) * 2.54; upd('heightCm', cm > 0 ? Math.round(cm * 10) / 10 : null); };
  $('gAct').onchange = e => upd('activity', +e.target.value);
  $('gRate').onchange = e => upd('goalRate', +e.target.value);
  if ($('gAuto')) $('gAuto').onchange = e => { st.autoGoal = e.target.checked; save(); if (e.target.checked) toast(`Daily goal set to ${calorieCalc().target.toLocaleString()} kcal`); render(); };
}

function renderSettings() {
  setTick(null);
  const st = S.settings;
  const notifState = !('Notification' in window) ? 'unsupported' : Notification.permission;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const sec = settingsSec;
  view.innerHTML = (sec ? `<button class="link back-link" id="secBack">‹ Settings</button>` : settingsMenuHTML()) + `
    <section data-sec="goal">${goalCardHTML()}
    <div class="card"><h2>Daily & weekly budget</h2>
      <label style="margin-top:0">Daily calorie goal</label><input type="number" inputmode="numeric" id="sGoal" value="${st.calorieGoal}" ${st.autoGoal && calorieCalc() ? 'disabled' : ''}>
      ${st.autoGoal && calorieCalc() ? '<p class="small muted">Set by the calculator above. Turn off "Set my daily goal from this" to type your own.</p>' : ''}
      <label>Weekly calorie budget</label><input type="number" inputmode="numeric" id="sWeek" value="${st.weeklyBudget || ''}" placeholder="${(st.calorieGoal * 7).toLocaleString()} (daily goal × 7)">
      <p class="small muted">Leave blank to use your daily goal × 7. Set your own if you want room for a bigger weekend.</p>
      <label>Week starts on</label><select id="sWkStart"><option value="1" ${st.weekStart === 1 ? 'selected' : ''}>Monday</option><option value="0" ${st.weekStart === 0 ? 'selected' : ''}>Sunday</option></select></div></section>
    <section data-sec="fasting"><div class="card"><h2>Fasting schedule</h2>
      <label>Fasting plan</label>
      <select id="sPlan">${[12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].map(h => `<option value="${h}" ${h === st.fastHours ? 'selected' : ''}>${h}:${24 - h} (${h}h fast)</option>`).join('')}</select>
      <div class="switch"><span>Same schedule every day</span><input type="checkbox" id="sSame" ${st.sameEveryDay ? 'checked' : ''}></div>
      ${st.sameEveryDay ? `<label>First meal (fast ends) at</label><input type="time" id="sEat" value="${st.eatStart}">
      <p class="small muted">Eating ${hm12(st.eatStart)}–${hm12(hmFromMin(parseHM(st.eatStart) + (24 - st.fastHours) * 60))}. You'll be reminded at ${hm12(hmFromMin(parseHM(st.eatStart) - st.fastHours * 60))} to start your fast if you haven't.</p>`
      : `<p class="small muted">Set when you eat your first meal each day. Your fast ends then and starts ${st.fastHours}h earlier, which is when you're reminded. Turn a day off to skip fasting (it won't break your streak).</p>
      ${[0, 1, 2, 3, 4, 5, 6].map(i => (i + st.weekStart) % 7).map(d => { const sc = st.schedule[d]; return `<div class="row" style="padding:6px 0;border-bottom:1.5px dashed var(--line-soft)"><input type="checkbox" data-son="${d}" ${sc.on ? 'checked' : ''} style="width:auto;transform:scale(1.2)"><b style="width:40px">${DAY_NAMES[d]}</b><input type="time" data-seat="${d}" value="${sc.eat}" ${sc.on ? '' : 'disabled'} style="width:130px"><span class="small muted grow" style="text-align:right">${sc.on ? `fast starts ${parseHM(sc.eat) - st.fastHours * 60 < 0 ? DAY_NAMES[(d + 6) % 7] + ' ' : ''}${hm12(hmFromMin(parseHM(sc.eat) - st.fastHours * 60))}` : 'no fast'}</span></div>`; }).join('')}`}
    </div>
    <div class="card"><h2>Streak</h2>
      <div class="switch"><span>Weekly streak freeze<br><span class="small muted">One missed day per week won't break your streak</span></span><input type="checkbox" id="sFreeze" ${st.streakFreeze ? 'checked' : ''}></div></div></section>
    <section data-sec="remind"><div class="card"><h2>Reminders</h2>
      <div class="switch"><span>Fast reminders</span><input type="checkbox" id="sRem" ${st.reminders ? 'checked' : ''}></div>
      <p class="small muted">Notifications: <b>${notifState}</b>${standalone ? '' : ' · On iPhone, add this app to your Home Screen first (Share → Add to Home Screen), then enable here.'}</p>
      <div class="btn-grid"><button class="btn" id="sNotif">Enable notifications</button><button class="btn" id="sIcs">📅 Add to calendar</button></div>
      <p class="small muted">Web apps can't schedule alerts while fully closed. The calendar option adds recurring reminders that match your schedule and always fire. Re-download it if you change your schedule.</p>
    </div></section>
    <section data-sec="meals"><div class="card"><h2>Meals to show</h2>
      ${MEALS.map(m => `<div class="switch"><span>${m.label}</span><input type="checkbox" data-meal="${m.id}" ${st.meals[m.id] ? 'checked' : ''}></div>`).join('')}
      <p class="small muted">After you log your last meal of the day (${mealLabel(lastMainMeal())}), you'll be asked to start your fast.</p></div></section>
    <section data-sec="look"><div class="card"><h2>Color palette</h2>
      <div class="theme-grid">${['auto', ...Object.keys(THEMES)].map(k => { const t = THEMES[k === 'auto' ? seasonNow() : k]; return `<button class="theme-opt ${st.theme === k ? 'active' : ''}" data-theme-opt="${k}"><span class="sw">${t.sw.map(c => `<i style="background:${c}"></i>`).join('')}</span>${k === 'auto' ? `Match season<br><span class="small muted">now: ${THEMES[seasonNow()].label}</span>` : t.label}</button>`; }).join('')}</div></div></section>
    <section data-sec="units"><div class="card"><h2>Units</h2><div class="seg" style="margin:0">${[['lb', 'Imperial'], ['kg', 'Metric']].map(([v, l]) => `<button data-unit="${v}" class="${st.weightUnit === v ? 'active' : ''}">${l}</button>`).join('')}</div><p class="small muted" style="margin-bottom:0">${st.weightUnit === 'kg' ? 'Weight in kg, height in cm.' : 'Weight in lb, height in ft and in.'} Switching converts your logged weights.</p></div></section>
    <section data-sec="ai"><div class="card"><h2>AI photo logging</h2>
      <label>AI provider</label><select id="sProv"><option value="gemini" ${st.aiProvider !== 'claude' ? 'selected' : ''}>Google Gemini (free tier)</option><option value="claude" ${st.aiProvider === 'claude' ? 'selected' : ''}>Anthropic Claude (paid, ~1–2¢/photo)</option></select>
      ${st.aiProvider === 'claude' ? `
      <label>Anthropic API key</label><input type="password" id="sKey" value="${esc(st.apiKey)}" placeholder="sk-ant-…" autocomplete="off">
      <p class="small muted">Get one at console.anthropic.com. Kept on this device (and in your account if you sign in) and sent only to Anthropic.</p>
      <label>Model</label><select id="sModel">${[['claude-opus-5-5', 'Claude Opus 5.5 (most accurate)'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (cheaper)'], ['claude-haiku-5-5', 'Claude Haiku 5.5 (cheapest)']].map(([v, l]) => `<option value="${v}" ${st.aiModel === v ? 'selected' : ''}>${l}</option>`).join('')}</select>` : `
      <label>Gemini API key</label><input type="password" id="sGKey" value="${esc(st.geminiKey)}" placeholder="AIza…" autocomplete="off">
      <p class="small muted">Free key at aistudio.google.com (no card needed). Kept on this device (and in your account if you sign in) and sent only to Google. Free-tier photos may be used by Google to improve its products.</p>
      <label>Model</label><input id="sGModel" value="${esc(st.geminiModel)}" autocomplete="off" autocapitalize="off">
      <p class="small muted">If this model is retired, the app switches to a current Flash model automatically.</p>`}</div></section>
    <section data-sec="account">${Cloud.cardHTML()}</section>
    <section data-sec="data"><div class="card"><h2>Data</h2><p class="small muted">${Cloud.signedIn() ? 'Saved on this phone and synced to your account.' : 'Everything is stored on this phone only. Export a backup now and then, or sign in under Account to sync.'}</p>
      <div class="btn-grid"><button class="btn" id="sExp">Export backup</button><button class="btn" id="sImpBtn">Import backup</button><input type="file" accept=".json,application/json,text/plain" id="sImp" class="visually-hidden"></div>
      <button class="btn danger" id="sWipe" style="margin-top:8px">Erase all data</button></div></section>`;
  view.querySelectorAll('section[data-sec]').forEach(el => { if (el.dataset.sec !== sec) el.classList.add('hidden'); });
  view.querySelectorAll('[data-sec-open]').forEach(b => b.onclick = () => { settingsSec = b.dataset.secOpen; render(); window.scrollTo(0, 0); });
  if (sec) document.getElementById('secBack').onclick = () => { settingsSec = null; render(); window.scrollTo(0, 0); };
  bindGoalCard();
  const set = (k, v) => { st[k] = v; save(); };
  const bindEl = (id, fn) => { const el = document.getElementById(id); if (el) el.onchange = fn; };
  document.getElementById('sPlan').onchange = e => { set('fastHours', +e.target.value); const f = activeFast(); if (f) { f.goalH = +e.target.value; save(); } render(); };
  document.getElementById('sSame').onchange = e => { if (!e.target.checked) st.schedule = st.schedule.map(sc => ({ ...sc, eat: sc.eat || st.eatStart })); set('sameEveryDay', e.target.checked); render(); };
  bindEl('sEat', e => { set('eatStart', e.target.value || '12:00'); st.schedule = st.schedule.map(sc => ({ ...sc, eat: e.target.value || '12:00' })); save(); render(); });
  view.querySelectorAll('[data-son]').forEach(c => c.onchange = () => { st.schedule[+c.dataset.son].on = c.checked; save(); render(); });
  view.querySelectorAll('[data-seat]').forEach(c => c.onchange = () => { st.schedule[+c.dataset.seat].eat = c.value || '12:00'; save(); render(); });
  document.getElementById('sWeek').onchange = e => set('weeklyBudget', +e.target.value || 0);
  document.getElementById('sWkStart').onchange = e => { set('weekStart', +e.target.value); render(); };
  document.getElementById('sRem').onchange = e => set('reminders', e.target.checked);
  document.getElementById('sFreeze').onchange = e => set('streakFreeze', e.target.checked);
  document.getElementById('sGoal').onchange = e => { set('calorieGoal', +e.target.value || 1800); render(); };
  view.querySelectorAll('[data-theme-opt]').forEach(b => b.onclick = () => { set('theme', b.dataset.themeOpt); applyTheme(); render(); });
  view.querySelectorAll('[data-unit]').forEach(b => b.onclick = () => { const u = b.dataset.unit; if (u !== st.weightUnit) { const r = u === 'kg' ? st.goalRate / 2 : st.goalRate * 2; st.goalRate = GOAL_RATES[u].reduce((b, x) => Math.abs(x - r) < Math.abs(b - r) ? x : b); const f = u === 'kg' ? 0.45359237 : 1 / 0.45359237; S.weights.forEach(w => { w.value = Math.round(w.value * f * 10) / 10; }); } set('weightUnit', u); render(); });
  document.getElementById('sProv').onchange = e => { set('aiProvider', e.target.value); render(); };
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.onchange = fn; };
  bind('sKey', e => set('apiKey', e.target.value.trim()));
  bind('sModel', e => set('aiModel', e.target.value));
  bind('sGKey', e => set('geminiKey', e.target.value.trim()));
  bind('sGModel', e => set('geminiModel', e.target.value.trim() || 'gemini-3.1-flash-lite'));
  view.querySelectorAll('[data-meal]').forEach(c => c.onchange = () => {
    st.meals[c.dataset.meal] = c.checked;
    if (!enabledMeals().length) { st.meals[c.dataset.meal] = true; c.checked = true; return toast('Keep at least one meal'); }
    save(); render();
  });
  document.getElementById('sNotif').onclick = async () => {
    if (!('Notification' in window)) return toast(standalone ? 'Notifications not supported on this device' : 'Add to Home Screen first, then try again');
    const p = await Notification.requestPermission(); toast(p === 'granted' ? 'Notifications on' : 'Notifications ' + p); if (p === 'granted') notify('calcount', 'Reminders are on. You\'ll get a nudge when it\'s time to start your fast.'); render();
  };
  Cloud.bindCard();
  document.getElementById('sIcs').onclick = downloadICS;
  document.getElementById('sExp').onclick = () => exportBackup();
  document.getElementById('sImpBtn').onclick = () => document.getElementById('sImp').click();
  document.getElementById('sImp').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const d = JSON.parse(await f.text()); if (!d.settings) throw 0; localStorage.setItem(STORE_KEY, JSON.stringify(d)); S = load(); save(); applyTheme(); toast('Backup restored'); render(); } catch { toast('That file isn\'t a calcount backup'); }
  };
  document.getElementById('sWipe').onclick = async () => {
    const body = 'This deletes all fasts, food, weights and recipes from this device.' + (Cloud.signedIn() ? ' The copy in your account is kept, and this phone is signed out.' : '');
    if ((await confirmDialog({ title: 'Erase everything?', body, ok: 'Erase', danger: true })) !== true) return;
    if (Cloud.signedIn()) await Cloud.signOut();
    localStorage.removeItem(STORE_KEY); S = load(); applyTheme(); render();
  };
}

// On iPhone, share the file so it can be saved to Files (plain downloads are unreliable in Home Screen apps).
async function exportBackup() {
  const name = `calcount-backup-${dayKey()}.json`, text = JSON.stringify(S, null, 1);
  try {
    const file = new File([text], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'calcount backup' }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  download(name, text, 'application/json');
}
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
function downloadICS() {
  const p = n => String(n).padStart(2, '0'), BY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const dt = d => `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`;
  // Group reminder times (fast start) by weekday they fall on, one weekly event per distinct time
  const groups = {};
  for (let i = 1; i <= 7; i++) {
    const pf = plannedFast(addDays(dayKey(), i)); if (!pf) continue;
    const s0 = new Date(pf.start), hm = `${p(s0.getHours())}:${p(s0.getMinutes())}`;
    (groups[hm] = groups[hm] || []).push(s0);
  }
  const events = Object.entries(groups).map(([hm, starts], n) => {
    starts.sort((a, b) => a - b); const first = starts[0].getTime() > Date.now() ? starts[0] : new Date(starts[0].getTime() + 7 * 864e5);
    const days = [...new Set(starts.map(d => BY[d.getDay()]))].join(',');
    return ['BEGIN:VEVENT', `UID:calcount-${Date.now()}-${n}@calcount`, `DTSTAMP:${dt(new Date())}`, `DTSTART:${dt(first)}`, `DTEND:${dt(new Date(first.getTime() + 15 * 6e4))}`,
      `RRULE:FREQ=WEEKLY;BYDAY=${days}`, `SUMMARY:Start your ${S.settings.fastHours}h fast`, 'DESCRIPTION:Time to start fasting. Open calcount and tap Start fast.',
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Start your fast', 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT'].join('\r\n');
  });
  if (!events.length) return toast('No fasting days are scheduled');
  download('calcount-reminders.ics', ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//calcount//EN', ...events, 'END:VCALENDAR'].join('\r\n'), 'text/calendar');
}

// ---------- Reminders ----------
async function notify(title, body) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return false;
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'calcount' });
    else new Notification(title, { body });
    return true;
  } catch { return false; }
}
// Checks once a minute (and whenever the app comes back to the foreground) whether a planned fast should have
// started and no fast is running. Shows a system notification if allowed, plus an in-app prompt.
async function checkReminder() {
  if (!S.settings.reminders || activeFast()) return;
  const plan = currentPlan(); if (!plan || plan.start > Date.now()) return;
  // Don't nag if the last fast ended recently (e.g. just broke a fast this morning)
  const last = lastFinishedFast(); if (last && last.end > plan.start) return;
  if (S.meta.lastReminderFor === plan.key || document.querySelector('.dialog')) return;
  S.meta.lastReminderFor = plan.key; save();
  const when = fmtTime(plan.start), meal = `${fmtTime(plan.end)} ${dayLabelFor(plan.end)}`;
  notify('Time to start your fast ⏱', `Your fast was planned for ${when} so you can eat at ${meal}. Tap to start it.`);
  const go = await confirmDialog({ title: 'Time to start your fast', body: `Your ${S.settings.fastHours}h fast was planned to start at ${when}, so you can eat at ${meal}. Start it now?`, ok: 'Start fast now', extra: `I stopped eating at ${when}`, cancel: 'Later' });
  if (go === true) startFast();
  else if (go === 'extra') startFast(plan.start);
}
setInterval(checkReminder, 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); maybeShowRecap(); checkReminder(); Cloud.syncNow(); } });

// ---------- Boot ----------
applyTheme();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
const params = new URLSearchParams(location.search);
if (params.get('action') === 'log') setTimeout(() => openLogSheet(guessMeal()), 100);
if (params.get('action') === 'photo') setTimeout(() => openLogSheet(guessMeal(), 'photo'), 100);
render();
Cloud.handleEmailLink(); Cloud.syncNow();
setTimeout(() => { maybeShowRecap(); checkReminder(); }, 1500);
