/* FastCal: calorie tracking + intermittent fasting PWA. All data lives in localStorage on the device. */
'use strict';

// ---------- Storage ----------
const STORE_KEY = 'fastcal_v1';
const APP_VERSION = '3';
const MEALS = [
  { id: 'breakfast', label: 'Breakfast' },
  { id: 'lunch', label: 'Lunch' },
  { id: 'dinner', label: 'Dinner' },
  { id: 'snacks', label: 'Snacks' },
];
const DEFAULT_STATE = {
  settings: {
    fastHours: 16,
    eatStart: '12:00',          // eating window opens; it closes after (24 - fastHours) hours
    calorieGoal: 1800,
    meals: { breakfast: true, lunch: true, dinner: true, snacks: true },
    streakFreeze: true,
    reminders: true,
    weightUnit: 'lb',
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
  meta: { lastReminderDay: '', lastReminderFor: '' },
};

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY));
    if (!raw) return structuredClone(DEFAULT_STATE);
    const s = { ...structuredClone(DEFAULT_STATE), ...raw };
    s.settings = { ...DEFAULT_STATE.settings, ...raw.settings, meals: { ...DEFAULT_STATE.settings.meals, ...(raw.settings || {}).meals } };
    s.meta = { ...DEFAULT_STATE.meta, ...raw.meta };
    return s;
  } catch { return structuredClone(DEFAULT_STATE); }
}
let S = load();
function save() { localStorage.setItem(STORE_KEY, JSON.stringify(S)); }
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
function eatEndHM() { return hmFromMin(parseHM(S.settings.eatStart) + (24 - S.settings.fastHours) * 60); }
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
const weekId = key => { const d = new Date(key + 'T12:00:00'); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); return dayKey(d); }; // Monday of the week
function computeStreak() {
  const hits = goalDays();
  if (!hits.size) return { streak: 0, frozen: [], todayDone: false };
  const first = [...hits].sort()[0];
  const today = dayKey();
  const todayDone = hits.has(today);
  let day = todayDone ? today : addDays(today, -1); // today still in progress doesn't break streak
  let streak = 0, oldest = null; let frozen = []; const usedWeeks = new Set();
  while (day >= first) {
    if (hits.has(day)) { streak++; oldest = day; }
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

// ---------- UI shell ----------
let tab = 'home';
let foodDay = dayKey();
const view = document.getElementById('view');
document.querySelectorAll('.tabbar button').forEach(b => b.onclick = () => { tab = b.dataset.tab; render(); window.scrollTo(0, 0); });

function render() {
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const titles = { home: activeFast() ? 'Fasting' : 'Eating window', food: 'Food log', weight: 'Weight', library: 'Ingredients & recipes', settings: 'Settings' };
  document.getElementById('pageTitle').textContent = titles[tab];
  ({ home: renderHome, food: renderFood, weight: renderWeight, library: renderLibrary, settings: renderSettings })[tab]();
}

function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 2600); }

const sheet = document.getElementById('sheet'), sheetBody = document.getElementById('sheetBody');
function openSheet(html) { sheetBody.innerHTML = html; sheet.classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
function closeSheet() { sheet.classList.add('hidden'); document.body.style.overflow = ''; }
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
function ringSVG(pct, color) {
  const r = 115, c = 2 * Math.PI * r, p = Math.min(1, Math.max(0, pct));
  return `<svg width="260" height="260" viewBox="0 0 260 260"><circle cx="130" cy="130" r="${r}" stroke="#273449" stroke-width="18" fill="none"/>
    <circle id="ringArc" cx="130" cy="130" r="${r}" stroke="${color}" stroke-width="18" fill="none" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p)}"/></svg>`;
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
        <div class="ring-wrap">${ringSVG((Date.now() - f.start) / goalMs, '#22c55e')}
          <div class="ring-center"><div class="ring-label">Fasting</div><div class="ring-time" id="tElapsed"></div><div class="ring-label" id="tRemain"></div></div></div>
        <div class="row between small muted"><span>Started ${fmtTime(f.start)} ${dayLabelFor(f.start)}</span><span>Goal ${fmtTime(f.start + goalMs)} ${dayLabelFor(f.start + goalMs)}</span></div>
        <div style="margin-top:14px" class="btn-grid">
          <button class="btn" id="editStart">Edit start</button>
          <button class="btn primary" id="endFast">End fast</button>
        </div>
        <button class="link" id="logDuringFast" style="margin-top:10px">+ Log food</button>
      </div>
      <div class="card small muted">Today: ${todayK} / ${st.calorieGoal} kcal · Eating window ${hm12(st.eatStart)}–${hm12(eatEndHM())}</div>`;
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
  } else {
    const last = lastFinishedFast();
    const pct = Math.min(1, todayK / st.calorieGoal);
    const nextFastAt = nextAt(eatEndHM());
    view.innerHTML = `
      <div class="card">
        <div class="row between">${streakHTML()}<span class="small muted">Since last fast: <b id="tSince">${last ? '' : '—'}</b></span></div>
      </div>
      <div class="card">
        <div class="row between"><div><div class="big-num">${todayK}</div><div class="small muted">of ${st.calorieGoal} kcal · ${Math.max(0, st.calorieGoal - todayK)} left</div></div>
        <span class="pill">Window closes ${fmtTime(nextFastAt)}</span></div>
        <div class="bar ${todayK > st.calorieGoal ? 'over' : ''}" style="margin-top:10px"><div style="width:${pct * 100}%"></div></div>
      </div>
      <div class="card">
        <h2>Log food</h2>
        <div class="meal-btns">${enabledMeals().map(m => `<button class="meal-btn" data-meal="${m.id}">${m.label}<small>${sumKcal(foodsOn(dayKey()).filter(x => x.meal === m.id))} kcal</small></button>`).join('')}</div>
        <div class="btn-grid" style="margin-top:10px"><button class="btn blue" id="snapBtn">📷 Snap a photo</button><button class="btn" id="quickBtn">⚡ Quick add</button></div>
      </div>
      <button class="btn primary" id="startFast">Start ${st.fastHours}h fast</button>
      <div class="center"><button class="link" id="startEarlier">Started earlier? Set start time</button></div>`;
    if (last) { const tick = () => { const el = document.getElementById('tSince'); if (el) el.textContent = fmtDur(Date.now() - last.end, false); }; tick(); setTick(tick); } else setTick(null);
    view.querySelectorAll('.meal-btn').forEach(b => b.onclick = () => openLogSheet(b.dataset.meal));
    document.getElementById('snapBtn').onclick = () => openLogSheet(guessMeal(), 'photo');
    document.getElementById('quickBtn').onclick = () => openLogSheet(guessMeal(), 'quick');
    document.getElementById('startFast').onclick = () => startFast();
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
        ${[['quick', '⚡ Quick'], ['photo', '📷 AI photo'], ['library', '📖 My foods']].map(([k, l]) => `<button data-mode="${k}" class="${state.mode === k ? 'active' : ''}">${l}</button>`).join('')}
      </div>
      <div id="modeBody"></div>`);
    document.getElementById('x').onclick = closeSheet;
    document.getElementById('mealSel').onchange = e => state.meal = e.target.value;
    sheetBody.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { state.mode = b.dataset.mode; draw(); });
    ({ quick: drawQuick, photo: drawPhoto, library: drawLibraryPick })[state.mode](document.getElementById('modeBody'), state);
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
  setTimeout(() => document.getElementById('qk').focus(), 50);
  document.getElementById('qAdd').onclick = () => {
    const kcal = +document.getElementById('qk').value; if (!kcal) return toast('Enter calories');
    addFoods([{ name: document.getElementById('qn').value || 'Quick add', kcal, protein: document.getElementById('qp').value, carbs: document.getElementById('qc').value, fat: document.getElementById('qf').value, source: 'quick' }], state.meal, state.date);
  };
}

function drawLibraryPick(el, state) {
  if (!S.ingredients.length && !S.recipes.length) { el.innerHTML = `<p class="muted">No saved ingredients or recipes yet. Add them in the Recipes tab.</p>`; return; }
  el.innerHTML = `
    <input id="libSearch" placeholder="Search…">
    <ul class="list" id="libList"></ul>`;
  const list = document.getElementById('libList');
  const draw = q => {
    q = (q || '').toLowerCase();
    const recs = S.recipes.filter(r => r.name.toLowerCase().includes(q)).map(r => `<li><span class="name">🍲 ${esc(r.name)}<br><span class="small muted">${Math.round(recipePerServing(r))} kcal / serving</span></span><input type="number" inputmode="decimal" value="1" step="0.25" style="width:70px" data-r="${r.id}"><span class="small muted">srv</span><button class="btn small primary" data-addr="${r.id}">Add</button></li>`);
    const ings = S.ingredients.filter(i => i.name.toLowerCase().includes(q)).map(i => `<li><span class="name">🥕 ${esc(i.name)}<br><span class="small muted">${i.kcalPerUnit} kcal / ${i.unitSize} ${esc(i.unit)}</span></span><input type="number" inputmode="decimal" value="${i.unitSize}" style="width:70px" data-i="${i.id}"><span class="small muted">${esc(i.unit)}</span><button class="btn small primary" data-addi="${i.id}">Add</button></li>`);
    list.innerHTML = recs.concat(ings).join('') || '<li class="muted">No matches</li>';
    list.querySelectorAll('[data-addr]').forEach(b => b.onclick = () => { const r = S.recipes.find(x => x.id === b.dataset.addr); const srv = +list.querySelector(`[data-r="${r.id}"]`).value || 1; addFoods([{ name: `${r.name} (${srv} srv)`, kcal: recipePerServing(r) * srv, source: 'recipe' }], state.meal, state.date); });
    list.querySelectorAll('[data-addi]').forEach(b => b.onclick = () => { const i = ingById(b.dataset.addi); const q = +list.querySelector(`[data-i="${i.id}"]`).value || 0; addFoods([{ name: `${i.name} (${q} ${i.unit})`, kcal: ingKcal(i, q), source: 'ingredient' }], state.meal, state.date); });
  };
  draw(''); document.getElementById('libSearch').oninput = e => draw(e.target.value);
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
    <label class="btn blue" style="display:block;text-align:center;cursor:pointer">📷 Take or choose photo<input type="file" accept="image/*" capture="environment" id="photoIn" class="hidden"></label>
    <img id="prev" class="preview-img hidden" alt="">
    <label>Size / weight hints (optional, improves accuracy)</label>
    <textarea id="hint" rows="2" placeholder="e.g. plate is 10 in wide; chicken ~150 g; 1 cup rice"></textarea>
    <button class="btn primary" id="estBtn" style="margin-top:12px" disabled>Estimate calories</button>
    <div id="aiOut"></div>`;
  let imgData = null;
  document.getElementById('photoIn').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    imgData = await resizeImage(file, 1280);
    const p = document.getElementById('prev'); p.src = 'data:image/jpeg;base64,' + imgData; p.classList.remove('hidden');
    document.getElementById('estBtn').disabled = false;
  };
  document.getElementById('estBtn').onclick = async () => {
    const out = document.getElementById('aiOut');
    out.innerHTML = '<div class="spinner"></div><p class="center small muted">Estimating…</p>';
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
      resolve(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
    };
    img.onerror = () => reject(new Error('Could not read that image'));
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
const estimateFood = (b64, hint) => S.settings.aiProvider === 'claude' ? estimateClaude(b64, hint) : estimateGemini(b64, hint);

// Google Gemini (free tier available at aistudio.google.com)
async function estimateGemini(b64, hint, retried = false) {
  const model = S.settings.geminiModel || 'gemini-3.1-flash-lite';
  const prompt = foodPrompt(hint) + ` Reply with JSON only, matching this shape: {"items":[{"name":string,"portion":string,"kcal":number,"protein_g":number,"carbs_g":number,"fat_g":number}],"total_kcal":number,"confidence":"low"|"medium"|"high","notes":string}`;
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': S.settings.geminiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'image/jpeg', data: b64 } }, { text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    // Model names change over time: if ours is gone, pick a current Flash model and retry once.
    if (resp.status === 404 && !retried) { const m = await pickGeminiModel(); if (m && m !== model) { S.settings.geminiModel = m; save(); return estimateGemini(b64, hint, true); } }
    const msg = data?.error?.message || resp.statusText;
    if (resp.status === 400 && /API key/i.test(msg) || resp.status === 403) throw new Error('Your Gemini API key was rejected. Check it in Settings.');
    if (resp.status === 429) throw new Error('Gemini free-tier limit reached. Wait a bit and try again, or use Quick add.');
    throw new Error(`AI request failed (${resp.status}): ${msg}`);
  }
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  if (!text) throw new Error('Gemini returned no estimate for this photo. Try again or use Quick add.');
  return parseFoodJSON(text);
}
async function pickGeminiModel() {
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': S.settings.geminiKey } });
    const ms = ((await r.json()).models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace('models/', ''));
    const flash = ms.filter(n => /flash/.test(n) && !/image|tts|audio|live|exp|preview/.test(n));
    return (flash.find(n => /lite/.test(n)) || flash[0] || ms[0]);
  } catch { return null; }
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
async function estimateClaude(b64, hint) {
  const prompt = foodPrompt(hint);
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': S.settings.apiKey,
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: S.settings.aiModel || 'claude-opus-5-5',
      max_tokens: 4000,
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: FOOD_SCHEMA } },
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
        { type: 'text', text: prompt },
      ] }],
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.error?.message || resp.statusText;
    if (resp.status === 401) throw new Error('Your API key was rejected. Check it in Settings.');
    if (resp.status === 429) throw new Error('Rate limited by the API. Wait a moment and try again.');
    throw new Error(`AI request failed (${resp.status}): ${msg}`);
  }
  if (data.stop_reason === 'refusal') throw new Error('The AI declined to estimate this photo. Try Quick add instead.');
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return parseFoodJSON(text);
}

function renderAIResult(out, res, state) {
  const items = res.items.map(i => ({ ...i }));
  const draw = () => {
    out.innerHTML = `
      <h3 style="margin-top:14px">Estimate <span class="pill ${res.confidence === 'high' ? 'green' : res.confidence === 'low' ? 'amber' : ''}">${esc(res.confidence)} confidence</span></h3>
      ${items.map((it, n) => `<div class="ai-item"><div class="row"><input value="${esc(it.name)}" data-n="${n}" data-f="name" class="grow"><input type="number" inputmode="numeric" value="${Math.round(it.kcal)}" data-n="${n}" data-f="kcal" style="width:80px"><span class="small muted">kcal</span><button class="icon" data-del="${n}">✕</button></div>
        <div class="small muted" style="margin-top:4px">${esc(it.portion)} · P ${Math.round(it.protein_g)}g · C ${Math.round(it.carbs_g)}g · F ${Math.round(it.fat_g)}g</div></div>`).join('')}
      <p class="small muted">${esc(res.notes)}</p>
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
      <div class="small muted" style="margin-top:8px">Protein ${macros[0]}g · Carbs ${macros[1]}g · Fat ${macros[2]}g</div></div>
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
    </div>
    ${ws.length ? `<div class="card">
      <div class="row between"><div><div class="big-num">${latest.value}</div><div class="small muted">${unit} · ${fmtDay(latest.date)}</div></div>
      <div class="small" style="text-align:right">${weekAgo ? `7d: <b>${delta(latest.value - weekAgo.value)}</b><br>` : ''}Total: <b>${delta(latest.value - first.value)}</b></div></div>
      <div class="seg" style="margin-top:12px" id="rangeSeg">${['30', '90', '365', 'all'].map(r => `<button data-r="${r}" class="${weightRange === r ? 'active' : ''}">${r === 'all' ? 'All' : r === '365' ? '1y' : r + 'd'}</button>`).join('')}</div>
      <div class="chart" id="chart"></div>
      <div class="small muted"><span style="color:#38bdf8">●</span> daily weigh-in &nbsp; <span style="color:#22c55e">━</span> 7-day trend</div>
    </div>
    <div class="card"><h3>History</h3><ul class="list">${[...ws].reverse().slice(0, 60).map(w => `<li><span class="name">${fmtDay(w.date)}</span><span class="kcal">${w.value} ${unit}</span><button class="icon" data-delw="${w.date}">✕</button></li>`).join('')}</ul></div>` : '<div class="card muted">Log your first weigh-in to see your trend.</div>'}`;
  document.getElementById('wAdd').onclick = () => {
    const v = +document.getElementById('wVal').value, d = document.getElementById('wDate').value;
    if (!v || !d) return toast('Enter a weight');
    S.weights = S.weights.filter(w => w.date !== d); S.weights.push({ date: d, value: v }); save(); toast('Weight logged'); render();
  };
  view.querySelectorAll('[data-delw]').forEach(b => b.onclick = () => { S.weights = S.weights.filter(w => w.date !== b.dataset.delw); save(); render(); });
  view.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { weightRange = b.dataset.r; render(); });
  if (ws.length) drawChart(document.getElementById('chart'), ws);
}
let weightRange = '90';
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
    ${ticks.map(t => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}" stroke="#334155" stroke-dasharray="3 3"/><text x="${P.l - 4}" y="${y(t) + 4}" fill="#94a3b8" font-size="10" text-anchor="end">${t.toFixed(1)}</text>`).join('')}
    <text x="${P.l}" y="${H - 6}" fill="#94a3b8" font-size="10">${fmtDay(pts[0].date)}</text>
    <text x="${W - P.r}" y="${H - 6}" fill="#94a3b8" font-size="10" text-anchor="end">${fmtDay(pts[pts.length - 1].date)}</text>
    ${tr.length > 1 ? `<polyline fill="none" stroke="#22c55e" stroke-width="2.5" points="${tr.map(p => `${x(p.date)},${y(p.value)}`).join(' ')}"/>` : ''}
    ${pts.map(p => `<circle cx="${x(p.date)}" cy="${y(p.value)}" r="3" fill="#38bdf8"/>`).join('')}
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
      <div class="card" style="margin-top:12px"><ul class="list">${S.ingredients.map(i => `<li><span class="name">${esc(i.name)}<br><span class="small muted">${i.kcalPerUnit} kcal per ${i.unitSize} ${esc(i.unit)}</span></span><button class="icon" data-edi="${i.id}">✎</button><button class="icon" data-deli="${i.id}">✕</button></li>`).join('') || '<li class="muted">No ingredients yet. Add the ones you use often, from a nutrition label.</li>'}</ul></div>`;
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
      <div class="row" style="margin-top:8px"><select id="rAddSel" class="grow"><option value="">Add ingredient…</option>${S.ingredients.map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}<option value="__new">+ Create new ingredient</option></select></div>
      <div class="row between" style="margin-top:12px"><span class="muted">Total ${Math.round(recipeKcal(r))} kcal</span><b>${Math.round(recipePerServing(r))} kcal / serving</b></div>
      <button class="btn primary" id="rSave" style="margin-top:14px">Save recipe</button>`);
    const sync = () => { r.name = document.getElementById('rN').value; r.servings = +document.getElementById('rS').value || 1; };
    document.getElementById('rX').onclick = closeSheet;
    document.getElementById('rS').onchange = () => { sync(); draw(); };
    sheetBody.querySelectorAll('[data-q]').forEach(inp => inp.onchange = () => { sync(); r.items[+inp.dataset.q].qty = +inp.value; draw(); });
    sheetBody.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { sync(); r.items.splice(+b.dataset.rm, 1); draw(); });
    document.getElementById('rAddSel').onchange = e => {
      sync();
      if (e.target.value === '__new') return ingredientSheet(null, ing => { r.items.push({ ingId: ing.id, qty: ing.unitSize }); draw(); });
      const ing = ingById(e.target.value); if (ing) { r.items.push({ ingId: ing.id, qty: ing.unitSize }); draw(); }
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
function renderSettings() {
  setTick(null);
  const st = S.settings;
  const notifState = !('Notification' in window) ? 'unsupported' : Notification.permission;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  view.innerHTML = `
    <div class="card"><h2>Fasting schedule</h2>
      <label>Fasting plan</label>
      <select id="sPlan">${[12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].map(h => `<option value="${h}" ${h === st.fastHours ? 'selected' : ''}>${h}:${24 - h} (${h}h fast)</option>`).join('')}</select>
      <label>Eating window opens at</label><input type="time" id="sEat" value="${st.eatStart}">
      <p class="small muted">Eating ${hm12(st.eatStart)}–${hm12(eatEndHM())}. You'll be reminded at ${hm12(eatEndHM())} to start fasting if you haven't.</p>
      <div class="switch"><span>Fast reminders</span><input type="checkbox" id="sRem" ${st.reminders ? 'checked' : ''}></div>
      <p class="small muted">Notifications: <b>${notifState}</b>${standalone ? '' : ' · On iPhone, add this app to your Home Screen first (Share → Add to Home Screen), then enable here.'}</p>
      <div class="btn-grid"><button class="btn" id="sNotif">Enable notifications</button><button class="btn" id="sIcs">📅 Add to calendar</button></div>
      <p class="small muted">Web apps can't schedule alerts while fully closed. The calendar option adds a daily ${hm12(eatEndHM())} reminder that always fires.</p>
    </div>
    <div class="card"><h2>Streak</h2>
      <div class="switch"><span>Weekly streak freeze<br><span class="small muted">One missed day per week won't break your streak</span></span><input type="checkbox" id="sFreeze" ${st.streakFreeze ? 'checked' : ''}></div></div>
    <div class="card"><h2>Calories & meals</h2>
      <label>Daily calorie goal</label><input type="number" inputmode="numeric" id="sGoal" value="${st.calorieGoal}">
      <label style="margin-top:12px">Meals to show</label>
      ${MEALS.map(m => `<div class="switch"><span>${m.label}</span><input type="checkbox" data-meal="${m.id}" ${st.meals[m.id] ? 'checked' : ''}></div>`).join('')}
      <p class="small muted">After you log your last meal of the day (${mealLabel(lastMainMeal())}), you'll be asked to start your fast.</p></div>
    <div class="card"><h2>Weight</h2><label>Unit</label><select id="sUnit"><option ${st.weightUnit === 'lb' ? 'selected' : ''}>lb</option><option ${st.weightUnit === 'kg' ? 'selected' : ''}>kg</option></select></div>
    <div class="card"><h2>AI photo logging</h2>
      <label>AI provider</label><select id="sProv"><option value="gemini" ${st.aiProvider !== 'claude' ? 'selected' : ''}>Google Gemini (free tier)</option><option value="claude" ${st.aiProvider === 'claude' ? 'selected' : ''}>Anthropic Claude (paid, ~1–2¢/photo)</option></select>
      ${st.aiProvider === 'claude' ? `
      <label>Anthropic API key</label><input type="password" id="sKey" value="${esc(st.apiKey)}" placeholder="sk-ant-…" autocomplete="off">
      <p class="small muted">Get one at console.anthropic.com. Stored only on this device and sent only to Anthropic.</p>
      <label>Model</label><select id="sModel">${[['claude-opus-5-5', 'Claude Opus 5.5 (most accurate)'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (cheaper)'], ['claude-haiku-5-5', 'Claude Haiku 5.5 (cheapest)']].map(([v, l]) => `<option value="${v}" ${st.aiModel === v ? 'selected' : ''}>${l}</option>`).join('')}</select>` : `
      <label>Gemini API key</label><input type="password" id="sGKey" value="${esc(st.geminiKey)}" placeholder="AIza…" autocomplete="off">
      <p class="small muted">Free key at aistudio.google.com (no card needed). Stored only on this device and sent only to Google. Free-tier photos may be used by Google to improve its products.</p>
      <label>Model</label><input id="sGModel" value="${esc(st.geminiModel)}" autocomplete="off" autocapitalize="off">
      <p class="small muted">If this model is retired, the app switches to a current Flash model automatically.</p>`}</div>
    <div class="card"><h2>Data</h2><p class="small muted">Everything is stored on this phone only. Export a backup now and then. · App version ${APP_VERSION}</p>
      <div class="btn-grid"><button class="btn" id="sExp">Export backup</button><label class="btn" style="text-align:center;margin:0;color:var(--text);font-size:16px">Import<input type="file" accept="application/json" id="sImp" class="hidden"></label></div>
      <button class="btn danger" id="sWipe" style="margin-top:8px">Erase all data</button></div>`;
  const set = (k, v) => { st[k] = v; save(); };
  document.getElementById('sPlan').onchange = e => { set('fastHours', +e.target.value); const f = activeFast(); if (f) { f.goalH = +e.target.value; save(); } render(); };
  document.getElementById('sEat').onchange = e => { set('eatStart', e.target.value || '12:00'); render(); };
  document.getElementById('sRem').onchange = e => set('reminders', e.target.checked);
  document.getElementById('sFreeze').onchange = e => set('streakFreeze', e.target.checked);
  document.getElementById('sGoal').onchange = e => set('calorieGoal', +e.target.value || 1800);
  document.getElementById('sUnit').onchange = e => set('weightUnit', e.target.value);
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
    const p = await Notification.requestPermission(); toast(p === 'granted' ? 'Notifications on' : 'Notifications ' + p); if (p === 'granted') notify('FastCal', 'Reminders are on. You\'ll get a nudge when your eating window closes.'); render();
  };
  document.getElementById('sIcs').onclick = downloadICS;
  document.getElementById('sExp').onclick = () => download(`fastcal-backup-${dayKey()}.json`, JSON.stringify(S, null, 1), 'application/json');
  document.getElementById('sImp').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const d = JSON.parse(await f.text()); if (!d.settings) throw 0; localStorage.setItem(STORE_KEY, JSON.stringify(d)); S = load(); toast('Backup restored'); render(); } catch { toast('That file isn\'t a FastCal backup'); }
  };
  document.getElementById('sWipe').onclick = async () => { if ((await confirmDialog({ title: 'Erase everything?', body: 'This deletes all fasts, food, weights and recipes from this device.', ok: 'Erase', danger: true })) === true) { localStorage.removeItem(STORE_KEY); S = load(); render(); } };
}

function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
function downloadICS() {
  const start = nextAt(eatEndHM()); const p = n => String(n).padStart(2, '0');
  const dt = d => `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`;
  const end = new Date(start.getTime() + 15 * 6e4);
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FastCal//EN', 'BEGIN:VEVENT', `UID:fastcal-${Date.now()}@fastcal`, `DTSTAMP:${dt(new Date())}`,
    `DTSTART:${dt(start)}`, `DTEND:${dt(end)}`, 'RRULE:FREQ=DAILY', `SUMMARY:Start your ${S.settings.fastHours}h fast`, 'DESCRIPTION:Eating window is closing. Open FastCal and start your fast.',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Start your fast', 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  download('fastcal-reminder.ics', ics, 'text/calendar');
}

// ---------- Reminders ----------
async function notify(title, body) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return false;
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'fastcal' });
    else new Notification(title, { body });
    return true;
  } catch { return false; }
}
// Checks once a minute (and whenever the app comes back to the foreground) whether the eating window
// has closed today without a fast started. Shows a system notification if allowed, plus an in-app prompt.
async function checkReminder() {
  if (!S.settings.reminders || activeFast()) return;
  const now = new Date(), endMin = parseHM(eatEndHM()), nowMin = now.getHours() * 60 + now.getMinutes();
  const startMin = parseHM(S.settings.eatStart);
  // Window that "should be fasting": from eatEnd until next eatStart (handles windows crossing midnight)
  const inFastPeriod = endMin > startMin ? (nowMin >= endMin || nowMin < startMin) : (nowMin >= endMin && nowMin < startMin);
  if (!inFastPeriod) return;
  // Identify this fasting period by the date the eating window closed
  const periodKey = nowMin >= endMin ? dayKey(now) : addDays(dayKey(now), -1);
  if (S.meta.lastReminderFor === periodKey || document.querySelector('.dialog')) return;
  S.meta.lastReminderFor = periodKey; save();
  notify('Time to start your fast ⏱', `Your eating window closed at ${hm12(eatEndHM())}. Tap to start your ${S.settings.fastHours}h fast.`);
  const go = await confirmDialog({ title: 'Time to start your fast', body: `Your eating window closed at ${hm12(eatEndHM())}. Start your ${S.settings.fastHours}h fast now?`, ok: 'Start fast now', extra: `I stopped eating at ${hm12(eatEndHM())}`, cancel: 'Later' });
  if (go === true) startFast();
  else if (go === 'extra') { const t = new Date(); const [h, m] = eatEndHM().split(':'); t.setHours(+h, +m, 0, 0); if (t > Date.now()) t.setDate(t.getDate() - 1); startFast(t.getTime()); }
}
setInterval(checkReminder, 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); checkReminder(); } });

// ---------- Boot ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
const params = new URLSearchParams(location.search);
if (params.get('action') === 'log') setTimeout(() => openLogSheet(guessMeal()), 100);
if (params.get('action') === 'photo') setTimeout(() => openLogSheet(guessMeal(), 'photo'), 100);
render();
setTimeout(checkReminder, 1500);
