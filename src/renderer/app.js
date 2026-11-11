// DAYLOG — renderer
'use strict';

// Browser fallback so the UI can be previewed without Electron.
const bridge = window.api || {
  load: async () => JSON.parse(localStorage.getItem('daylog') || 'null'),
  save: async d => localStorage.setItem('daylog', JSON.stringify(d)),
  activityRange: async keys => Object.fromEntries(keys.map(k => [k, { apps: {}, idle: 0 }])),
  setFocus: async () => {},
  notify: async (t, b) => console.log('notify', t, b),
  ai: async () => ({ ok: false, error: 'AI only works inside the desktop app.' }),
  github: async () => ({ ok: false, error: 'GitHub only works inside the desktop app.' }),
  on: () => {}
};

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const dayKey = (d = new Date()) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const addDays = (key, n) => { const d = new Date(key + 'T00:00'); d.setDate(d.getDate() + n); return dayKey(d); };
const lastDays = (n, end = dayKey()) => Array.from({ length: n }, (_, i) => addDays(end, i - n + 1));
const fmtDate = key => new Date(key + 'T00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const short = key => new Date(key + 'T00:00').toLocaleDateString(undefined, { weekday: 'short' });
const dur = s => { s = Math.round(s); const hh = Math.floor(s / 3600), mm = Math.floor(s % 3600 / 60); return hh ? `${hh}h ${mm}m` : `${mm}m`; };
const nowHM = () => new Date().toTimeString().slice(0, 5);
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- state ----------
const DEFAULTS = {
  tasks: [], recurring: [], habits: [], focusLog: {}, reviews: {},
  templates: [], classes: [], deadlines: [], journal: {}, gh: null,
  settings: {
    theme: 'dark', apiKey: '', model: 'gemini-2.5-flash', trackActivity: true,
    blocklist: ['youtube', 'facebook', 'tiktok', 'netflix', 'reddit', 'instagram'],
    focusMin: 25, breakMin: 5, reviewTime: '21:00', focusMusic: '', dayEnd: '23:00', ghUser: 'ashweak', ghToken: ''
  },
  meta: { reviewNotified: '' }
};
let S, view = 'today', today = dayKey();
let saveT;
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => bridge.save(S), 150); };

// ---------- day logic ----------
function recurMatches(rule, key) {
  const d = new Date(key + 'T00:00').getDay();
  if (rule === 'daily') return true;
  if (rule === 'weekdays') return d >= 1 && d <= 5;
  if (rule === 'weekends') return d === 0 || d === 6;
  return rule === DAYS[d];
}

function rollover() {
  today = dayKey();
  for (const t of S.tasks) {
    if (!t.done && t.date < today && !t.recurId) { t.date = today; t.carried = (t.carried || 0) + 1; }
  }
  for (const r of S.recurring) {
    if (recurMatches(r.rule, today) && !S.tasks.some(t => t.recurId === r.id && t.date === today)) {
      S.tasks.push({ id: uid(), title: r.title, date: today, done: false, recurId: r.id, time: r.time || '', priority: 'normal', createdAt: Date.now() });
    }
  }
  save();
}

const tasksOn = key => S.tasks.filter(t => t.date === key);
function sortTasks(list) {
  return [...list].sort((a, b) =>
    (a.done - b.done) ||
    ((b.priority === 'high') - (a.priority === 'high')) ||
    ((a.time || '99') < (b.time || '99') ? -1 : (a.time || '99') > (b.time || '99') ? 1 : 0) ||
    a.createdAt - b.createdAt);
}

function habitStreak(hb) {
  let n = 0, k = today;
  if (!hb.log[k]) k = addDays(k, -1);
  while (hb.log[k]) { n++; k = addDays(k, -1); }
  return n;
}
function habitBest(hb) {
  const keys = Object.keys(hb.log).filter(k => hb.log[k]).sort();
  let best = 0, cur = 0, prev = null;
  for (const k of keys) { cur = prev && addDays(prev, 1) === k ? cur + 1 : 1; best = Math.max(best, cur); prev = k; }
  return best;
}

const MOODS = ['awful', 'bad', 'okay', 'good', 'great'];
const mins = s => +s.slice(0, 2) * 60 + +s.slice(3, 5);
const hm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const classesOn = key => S.classes.filter(c => c.day === DAYS[new Date(key + 'T00:00').getDay()]).sort((a, b) => a.start < b.start ? -1 : 1);
const daysLeft = due => Math.round((new Date(due + 'T00:00') - new Date(today + 'T00:00')) / 864e5);
const dueLabel = n => n < 0 ? `${-n}d overdue` : n === 0 ? 'today' : n === 1 ? 'tomorrow' : `${n}d left`;

function dayScore(k) {
  return S.tasks.filter(t => t.done && t.date === k).length + (S.focusLog[k] || 0) + S.habits.filter(hb => hb.log[k]).length;
}
// ---------- GitHub ----------
let ghBusy = false, ghError = '';
async function refreshGitHub(force) {
  const s = S.settings;
  if (!s.ghUser || ghBusy) return;
  if (!force && S.gh && S.gh.user === s.ghUser && Date.now() - S.gh.fetchedAt < 30 * 60000) return;
  ghBusy = true;
  const res = await bridge.github(s.ghUser, s.ghToken);
  ghBusy = false;
  if (!res.ok) { ghError = res.error; if (force) toast(res.error); return; }
  ghError = '';
  S.gh = { ...res.data, user: s.ghUser, fetchedAt: Date.now() };
  save(); paintMini();
  if (['progress', 'review'].includes(view)) render();
}
function ghStats() {
  const cal = S.gh?.calendar;
  if (!cal) return null;
  const c = k => cal[k] || 0;
  let streak = 0, k = today;
  if (!c(k)) k = addDays(k, -1);
  while (c(k)) { streak++; k = addDays(k, -1); }
  const best = Object.entries(cal).reduce((b, e) => e[1] > b[1] ? e : b, ['', 0]);
  return { today: c(today), week: lastDays(7).reduce((s, d) => s + c(d), 0), streak, best, total: S.gh.total ?? Object.values(cal).reduce((a, b) => a + b, 0) };
}
const ago = iso => { const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
function heatmap(levelOf, titleOf) {
  const end = new Date(today + 'T00:00');
  const start = new Date(end); start.setDate(start.getDate() - 52 * 7 - end.getDay());
  const cells = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = dayKey(d);
    cells.push(`<i class="hm${levelOf(key)}" title="${titleOf(key)}"></i>`);
  }
  return `<div class="heat">${cells.join('')}</div>`;
}
const heatKey = `<span>less <i class="hm0 key"></i><i class="hm1 key"></i><i class="hm2 key"></i><i class="hm3 key"></i><i class="hm4 key"></i> more</span>`;

const isDistraction = name => S.settings.blocklist.some(b => b && name.toLowerCase().includes(b.toLowerCase()));

// ---------- focus timer (runs regardless of view) ----------
const F = { phase: 'focus', left: 0, running: false, timer: null };
function focusReset() { F.phase = 'focus'; F.left = S.settings.focusMin * 60; F.running = false; clearInterval(F.timer); bridge.setFocus(false); paintFocus(); }
function focusToggle() {
  F.running = !F.running;
  clearInterval(F.timer);
  if (F.running && F.phase === 'focus' && F.left === S.settings.focusMin * 60 && S.settings.focusMusic) bridge.openExternal?.(S.settings.focusMusic);
  if (F.running) F.timer = setInterval(focusTick, 1000);
  bridge.setFocus(F.running && F.phase === 'focus');
  paintFocus();
}
function focusSwitch(completed) {
  if (F.phase === 'focus') {
    if (completed) { S.focusLog[today] = (S.focusLog[today] || 0) + 1; save(); bridge.notify('Focus session done', `Nice. Take a ${S.settings.breakMin}-minute break.`); }
    F.phase = 'break'; F.left = S.settings.breakMin * 60;
  } else {
    if (completed) bridge.notify('Break over', 'Back to focus.');
    F.phase = 'focus'; F.left = S.settings.focusMin * 60;
  }
  bridge.setFocus(F.running && F.phase === 'focus');
  paintFocus();
  if (view === 'focus') render();
}
function focusTick() { F.left--; if (F.left <= 0) focusSwitch(true); else paintFocus(); }
function paintFocus() {
  const mm = String(Math.floor(F.left / 60)).padStart(2, '0'), ss = String(F.left % 60).padStart(2, '0');
  const c = $('#clock'); if (c) c.textContent = `${mm}:${ss}`;
  const p = $('#phase'); if (p) p.textContent = `${F.phase}${F.running ? '' : ' · paused'}`;
  const b = $('#focusBtn'); if (b) b.textContent = F.running ? 'Pause' : 'Start';
  paintMini();
}
function paintMini() {
  const list = tasksOn(today), done = list.filter(t => t.done).length;
  const dls = [...S.deadlines].sort((a, b) => a.due < b.due ? -1 : 1).slice(0, 3);
  $('#miniStatus').innerHTML =
    dls.map(d => `<div class="mdl"><b>${dueLabel(daysLeft(d.due))}</b> ${h(d.title)}</div>`).join('') +
    `<div><b>${done}/${list.length}</b> tasks today</div>` +
    (ghStats() ? `<div><b>${ghStats().today}</b> github contributions today</div>` : '') +
    (F.running ? `<div>${F.phase} · <b>${String(Math.floor(F.left / 60)).padStart(2, '0')}:${String(F.left % 60).padStart(2, '0')}</b></div>` : '');
}

// ---------- views ----------
const views = {};

views.today = () => {
  const list = sortTasks(tasksOn(today));
  const done = list.filter(t => t.done).length, pct = list.length ? Math.round(done / list.length * 100) : 0;
  const carried = list.filter(t => t.carried && !t.done).length;
  const planned = list.filter(t => !t.done).reduce((s, t) => s + (+t.est || 0), 0);
  const nowM = new Date().getHours() * 60 + new Date().getMinutes();
  const classM = classesOn(today).filter(c => mins(c.end) > nowM).reduce((s, c) => s + mins(c.end) - Math.max(mins(c.start), nowM), 0);
  const avail = Math.max(0, mins(S.settings.dayEnd) - nowM - classM);
  const over = planned > avail;
  const cls = classesOn(today);
  return `
  <div class="phead"><div><h1>TODAY</h1><p>${fmtDate(today)}</p></div><span class="badge">${over ? '⚠ overloaded' : `${pct}% complete`}</span></div>
  <div class="sec">
    <div class="stats">
      <div class="scell"><span class="snum">${done}</span><small>done</small></div>
      <div class="scell"><span class="snum">${list.length - done}</span><small>left</small></div>
      <div class="scell"><span class="snum">${carried}</span><small>carried over</small></div>
      <div class="scell"><span class="snum">${S.focusLog[today] || 0}<i>×${S.settings.focusMin}m</i></span><small>focus sessions</small></div>
    </div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <p class="note" style="margin:0">${planned ? `Planned ${dur(planned * 60)} · ${dur(avail * 60)} free until ${S.settings.dayEnd}${classM ? ' (after classes)' : ''}${over ? ` — <b class="warn">${dur((planned - avail) * 60)} over</b>. Move something to tomorrow.` : ''}` : 'Add time estimates to see if your day fits.'}</p>
  </div>
  ${cls.length ? `<div class="sec"><p class="label">classes today</p><div class="row">${cls.map(c => `<span class="chip">${c.start}–${c.end} · ${h(c.name)}${c.room ? ' · ' + h(c.room) : ''}</span>`).join('')}</div></div>` : ''}
  <div class="sec">
    <p class="label">01 — add task</p>
    <form class="row" data-form="addTask">
      <input class="in" id="newTask" placeholder="What needs doing?" autocomplete="off">
      <input class="in" type="time" id="newTime" title="Optional reminder time">
      <select class="in" id="newEst" title="Estimate">${estOpts()}</select>
      <select class="in" id="newPri"><option value="normal">normal</option><option value="high">high</option></select>
      <button class="btn pri">Add</button>
      <button class="btn" type="button" data-act="togglePlanner">✦ AI plan</button>
    </form>
    <div class="card" id="planner" ${planner.open ? '' : 'hidden'}>
      <p class="label" style="margin-bottom:10px">Brain dump → ordered day plan</p>
      <textarea class="in" id="dump" placeholder="e.g. finish CT 414 lab, fix portfolio footer, gym later, reply to Calvin, study for quiz tomorrow...">${h(planner.text)}</textarea>
      <div class="row" style="margin-top:10px"><button class="btn pri" data-act="runPlanner" ${planner.busy ? 'disabled' : ''}>${planner.busy ? 'Planning…' : 'Plan my day'}</button><span class="note">Uses your Gemini key from Settings.</span></div>
      ${planner.result ? `
        <ul class="list" style="margin-top:14px">${planner.result.map((p, i) => `
          <li class="item"><button class="chk ${p.pick ? 'on' : ''}" data-act="pickPlan" data-i="${i}"></button>
          <span class="t">${h(p.title)}</span>${p.est ? `<span class="meta">~${dur(p.est * 60)}</span>` : ''}${p.time ? `<span class="chip">${h(p.time)}</span>` : ''}${p.priority === 'high' ? '<span class="chip hi">HIGH</span>' : ''}
          ${p.why ? `<span class="meta">${h(p.why)}</span>` : ''}</li>`).join('')}</ul>
        <div class="row" style="margin-top:10px"><button class="btn pri" data-act="addPlan">Add selected</button><button class="link" data-act="clearPlan">discard</button></div>` : ''}
    </div>
  </div>
  <div class="sec">
    <p class="label">02 — tasks</p>
    ${list.length ? `<ul class="list">${list.map(taskRow).join('')}</ul>` : `<div class="empty"><b>Nothing planned yet</b>Add a task or let AI plan your day.</div>`}
  </div>
  <div class="sec">
    <p class="label">03 — recurring</p>
    <form class="row" data-form="addRecur">
      <input class="in" id="recTitle" placeholder="Recurring task (auto-added on matching days)" autocomplete="off">
      <select class="in" id="recRule">${['daily', 'weekdays', 'weekends', ...DAYS].map(r => `<option>${r}</option>`).join('')}</select>
      <input class="in" type="time" id="recTime">
      <button class="btn">Add</button>
    </form>
    ${S.recurring.length ? `<ul class="list">${S.recurring.map(r => `
      <li class="item"><span class="chip">↻ ${r.rule}</span><span class="t">${h(r.title)}</span>${r.time ? `<span class="meta">${r.time}</span>` : ''}
      <button class="link x" data-act="delRecur" data-id="${r.id}">remove</button></li>`).join('')}</ul>` : ''}
  </div>
  <div class="sec">
    <p class="label">04 — day templates</p>
    ${S.templates.length ? `<div class="row">${S.templates.map(t => `<span class="chip">${h(t.name)} (${t.tasks.length}) <button class="link" data-act="loadTpl" data-id="${t.id}">load</button> <button class="link" data-act="delTpl" data-id="${t.id}">✕</button></span>`).join('')}</div>` : '<p class="note" style="margin:0">Save today\'s tasks as a reusable set, e.g. "School day", "Rest day", "Exam week".</p>'}
    <form class="row" data-form="saveTpl"><input class="in" id="tplName" placeholder="Template name" autocomplete="off"><button class="btn" ${list.length ? '' : 'disabled'}>Save today as template</button></form>
  </div>
  <div class="sec">
    <p class="label">05 — deadlines</p>
    <form class="row" data-form="addDeadline"><input class="in" id="dlTitle" placeholder="e.g. CT 414 final project" autocomplete="off"><input class="in" type="date" id="dlDue"><button class="btn">Add</button></form>
    ${S.deadlines.length ? `<ul class="list">${[...S.deadlines].sort((a, b) => a.due < b.due ? -1 : 1).map(d => { const n = daysLeft(d.due); return `
      <li class="item"><span class="chip ${n <= 3 ? 'hi' : ''}">${dueLabel(n)}</span><span class="t">${h(d.title)}</span><span class="meta">${d.due}</span>
      <button class="link x" data-act="delDeadline" data-id="${d.id}">done ✕</button></li>`; }).join('')}</ul>` : ''}
  </div>`;
};
const EST = [['', '— est'], [15, '15m'], [30, '30m'], [45, '45m'], [60, '1h'], [90, '1.5h'], [120, '2h'], [180, '3h']];
const estOpts = (v = '') => EST.map(([m, l]) => `<option value="${m}" ${String(m) === String(v) ? 'selected' : ''}>${l}</option>`).join('');

function taskRow(t) {
  return `<li class="item ${t.done ? 'done' : ''}">
    <button class="chk ${t.done ? 'on' : ''}" data-act="toggleTask" data-id="${t.id}" aria-label="Toggle done"></button>
    <span class="t">${h(t.title)}</span>
    ${t.est ? `<span class="meta">~${dur(t.est * 60)}</span>` : ''}
    ${t.time ? `<span class="chip">${t.time}</span>` : ''}
    ${t.priority === 'high' ? '<span class="chip hi">HIGH</span>' : ''}
    ${t.recurId ? '<span class="chip">↻</span>' : ''}
    ${t.carried && !t.done ? `<span class="meta">carried ×${t.carried}</span>` : ''}
    ${!t.done && !t.recurId ? `<button class="link x" data-act="tomorrow" data-id="${t.id}">→ tmrw</button>` : ''}
    <button class="link x" data-act="delTask" data-id="${t.id}">✕</button>
  </li>`;
}

views.habits = () => {
  const days = lastDays(14);
  return `
  <div class="phead"><div><h1>HABITS</h1><p>Small things, every day.</p></div></div>
  <div class="sec">
    <form class="row" data-form="addHabit"><input class="in" id="habitName" placeholder="New habit (e.g. code 1 hour, read 10 pages)" autocomplete="off"><button class="btn pri">Add</button></form>
  </div>
  <div class="sec">
    <p class="label">01 — last 14 days</p>
    ${S.habits.length ? `<ul class="list">${S.habits.map(hb => `
      <li class="item">
        <button class="chk ${hb.log[today] ? 'on' : ''}" data-act="habitDay" data-id="${hb.id}" data-day="${today}"></button>
        <span class="t">${h(hb.name)}</span>
        <span class="dots">${days.map(d => `<button class="dot ${hb.log[d] ? 'on' : ''} ${d === today ? 'today' : ''}" title="${d}" data-act="habitDay" data-id="${hb.id}" data-day="${d}"></button>`).join('')}</span>
        <span class="meta">🔥 ${habitStreak(hb)} · best ${habitBest(hb)}</span>
        <button class="link x" data-act="delHabit" data-id="${hb.id}">✕</button>
      </li>`).join('')}</ul>` : `<div class="empty"><b>No habits yet</b>Add one above and build a streak.</div>`}
  </div>`;
};

views.focus = () => `
  <div class="phead"><div><h1>FOCUS</h1><p>Pomodoro with distraction alerts.</p></div><span class="badge">${S.focusLog[today] || 0} sessions today</span></div>
  <div class="sec card">
    <div class="clock" id="clock"></div>
    <div class="phase" id="phase"></div>
    <div class="row" style="justify-content:center;margin-top:20px">
      <button class="btn pri" id="focusBtn" data-act="focusToggle"></button>
      <button class="btn" data-act="focusSkip">Skip</button>
      <button class="btn" data-act="focusReset">Reset</button>
    </div>
  </div>
  <div class="sec">
    <p class="label">01 — distraction list</p>
    <p class="note" style="margin:0">While a focus session runs, DAYLOG alerts you if the active app or window title matches one of these.</p>
    <div class="row">${S.settings.blocklist.map((b, i) => `<span class="chip">${h(b)} <button class="link" data-act="delBlock" data-i="${i}">✕</button></span>`).join('')}</div>
    <form class="row" data-form="addBlock"><input class="in" id="blockIn" placeholder="e.g. youtube, steam, discord" autocomplete="off"><button class="btn">Add</button></form>
  </div>`;

let actDay = null;
views.activity = async () => {
  actDay = actDay || today;
  const a = (await bridge.activityRange([actDay]))[actDay];
  const apps = Object.entries(a.apps).sort((x, y) => y[1] - x[1]);
  const total = apps.reduce((s, [, v]) => s + v, 0);
  const dist = apps.filter(([n]) => isDistraction(n)).reduce((s, [, v]) => s + v, 0);
  const max = apps[0]?.[1] || 1;
  return `
  <div class="phead"><div><h1>ACTIVITY</h1><p>${fmtDate(actDay)}</p></div>
    <div class="row"><button class="btn sm" data-act="actPrev">◂</button><button class="btn sm" data-act="actToday">today</button><button class="btn sm" data-act="actNext" ${actDay >= today ? 'disabled' : ''}>▸</button></div></div>
  <div class="sec"><div class="stats">
    <div class="scell"><span class="snum">${dur(total)}</span><small>active</small></div>
    <div class="scell"><span class="snum">${dur(a.idle)}</span><small>idle</small></div>
    <div class="scell"><span class="snum">${dur(dist)}</span><small>distracted</small></div>
    <div class="scell"><span class="snum">${apps.length}</span><small>apps used</small></div>
  </div></div>
  <div class="sec">
    <p class="label">01 — where your time went</p>
    ${apps.length ? `<div class="hbars">${apps.slice(0, 15).map(([n, v]) => `
      <div class="hb ${isDistraction(n) ? 'bad' : ''}"><span title="${h(n)}">${h(n)}</span><span class="track"><i style="width:${v / max * 100}%"></i></span><span>${dur(v)}</span></div>`).join('')}</div>
      <p class="note">Striped bars = apps on your distraction list.</p>`
      : `<div class="empty"><b>No activity recorded</b>${S.settings.trackActivity ? 'Tracking runs in the background while DAYLOG is open (even in the tray).' : 'Activity tracking is off in Settings.'}</div>`}
  </div>`;
};

views.review = async () => {
  const list = tasksOn(today), done = list.filter(t => t.done), open = list.filter(t => !t.done);
  const a = (await bridge.activityRange([today]))[today];
  const apps = Object.entries(a.apps).sort((x, y) => y[1] - x[1]).slice(0, 5);
  const r = S.reviews[today] || {};
  const habitsDone = S.habits.filter(hb => hb.log[today]);
  return `
  <div class="phead"><div><h1>REVIEW</h1><p>End of day · ${fmtDate(today)}</p></div><span class="badge">${done.length}/${list.length} done</span></div>
  <div class="sec grid2">
    <div class="card"><p class="label">done</p>
      ${done.length ? `<ul class="list" style="border:0">${done.map(t => `<li class="item"><span class="t">✓ ${h(t.title)}</span></li>`).join('')}</ul>` : '<p class="note">Nothing finished yet.</p>'}</div>
    <div class="card"><p class="label">unfinished</p>
      ${open.length ? `<ul class="list" style="border:0">${open.map(t => `<li class="item"><span class="t">${h(t.title)}</span>
        <button class="link" data-act="tomorrow" data-id="${t.id}">→ tmrw</button><button class="link" data-act="delTask" data-id="${t.id}">drop</button></li>`).join('')}</ul>
        <button class="btn sm" data-act="allTomorrow" style="margin-top:10px">Move all to tomorrow</button>` : '<p class="note">All clear. 🎉</p>'}</div>
  </div>
  <div class="sec grid2">
    <div class="card"><p class="label">top apps</p>
      ${apps.length ? apps.map(([n, v]) => `<div class="row" style="justify-content:space-between"><span>${h(n)}</span><span class="meta">${dur(v)}</span></div>`).join('') : '<p class="note">No activity yet.</p>'}</div>
    <div class="card"><p class="label">habits</p>
      ${S.habits.length ? S.habits.map(hb => `<div class="row" style="justify-content:space-between"><span>${hb.log[today] ? '✓' : '·'} ${h(hb.name)}</span><span class="meta">🔥 ${habitStreak(hb)}</span></div>`).join('') : '<p class="note">No habits set.</p>'}
      <p class="note">${habitsDone.length}/${S.habits.length} done · ${S.focusLog[today] || 0} focus sessions${ghStats() ? ` · ${ghStats().today} GitHub contributions` : ''}</p></div>
  </div>
  <div class="sec">
    <p class="label">01 — mood & one-liner</p>
    <div class="row moods">${MOODS.map((m, i) => `<button class="btn sm ${S.journal[today]?.mood === i ? 'pri' : ''}" data-act="setMood" data-i="${i}">${m}</button>`).join('')}</div>
    <form class="row" data-form="saveJournal"><input class="in" id="journalIn" maxlength="140" value="${h(S.journal[today]?.text || '')}" placeholder="Today in one line…" autocomplete="off"><button class="btn">Save</button></form>
  </div>
  <div class="sec">
    <p class="label">02 — reflection</p>
    <textarea class="in" id="reflect" placeholder="What went well? What got in the way?">${h(r.note || '')}</textarea>
    <div class="row"><button class="btn" data-act="saveReflect">Save</button><button class="btn pri" data-act="aiReview" ${review.busy ? 'disabled' : ''}>${review.busy ? 'Thinking…' : '✦ AI summary'}</button></div>
    ${r.ai ? `<div class="card ai-out"><p class="label">summary</p>${h(r.ai.summary)}
      ${r.ai.tomorrow?.length ? `\n\n<span class="label">tomorrow</span>\n${r.ai.tomorrow.map(x => '→ ' + h(x)).join('\n')}` : ''}</div>` : ''}
  </div>`;
};

views.insights = async () => {
  const days = lastDays(7);
  const acts = await bridge.activityRange(days);
  const per = days.map(d => { const l = tasksOn(d); return { d, total: l.length, done: l.filter(t => t.done).length }; });
  const maxT = Math.max(1, ...per.map(p => p.total));
  const tDone = per.reduce((s, p) => s + p.done, 0), tAll = per.reduce((s, p) => s + p.total, 0);
  const focus = days.reduce((s, d) => s + (S.focusLog[d] || 0), 0);
  const appTot = {};
  let active = 0, distracted = 0;
  for (const d of days) for (const [n, v] of Object.entries(acts[d].apps)) { appTot[n] = (appTot[n] || 0) + v; active += v; if (isDistraction(n)) distracted += v; }
  const top = Object.entries(appTot).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxA = top[0]?.[1] || 1;
  const best = per.reduce((b, p) => p.done > b.done ? p : b, per[0]);
  const bestStreak = Math.max(0, ...S.habits.map(habitStreak));
  return `
  <div class="phead"><div><h1>INSIGHTS</h1><p>Last 7 days</p></div>${best.done ? `<span class="badge">best day: ${short(best.d)}</span>` : ''}</div>
  <div class="sec"><div class="stats">
    <div class="scell"><span class="snum">${tAll ? Math.round(tDone / tAll * 100) : 0}<i>%</i></span><small>completion</small></div>
    <div class="scell"><span class="snum">${tDone}</span><small>tasks done</small></div>
    <div class="scell"><span class="snum">${focus}</span><small>focus sessions</small></div>
    <div class="scell"><span class="snum">${active ? Math.round(distracted / active * 100) : 0}<i>%</i></span><small>distracted</small></div>
  </div></div>
  <div class="sec">
    <p class="label">01 — tasks done per day</p>
    <div class="cols">${per.map(p => `<div class="col" title="${p.done}/${p.total}"><span>${p.done}</span>
      <i style="height:${p.done / maxT * 140}px"></i></div>`).join('')}</div>
    <div class="colx">${per.map(p => `<span>${p.d === today ? 'today' : short(p.d)}</span>`).join('')}</div>
    <div class="colx">${per.map(p => { const j = S.journal[p.d]; return `<span title="${h(j?.text || '')}">${j?.mood != null ? MOODS[j.mood] : '·'}</span>`; }).join('')}</div>
    <p class="note" style="margin:0">Bottom row: your mood each day.</p>
  </div>
  <div class="sec">
    <p class="label">02 — top apps this week</p>
    ${top.length ? `<div class="hbars">${top.map(([n, v]) => `<div class="hb ${isDistraction(n) ? 'bad' : ''}"><span>${h(n)}</span><span class="track"><i style="width:${v / maxA * 100}%"></i></span><span>${dur(v)}</span></div>`).join('')}</div>` : '<div class="empty"><b>No activity yet</b>Check back after a day of use.</div>'}
  </div>
  <div class="sec">
    <p class="label">03 — habits</p>
    ${S.habits.length ? `<ul class="list">${S.habits.map(hb => { const n = days.filter(d => hb.log[d]).length; return `<li class="item"><span class="t">${h(hb.name)}</span><span class="meta">${n}/7 days · 🔥 ${habitStreak(hb)}</span></li>`; }).join('')}</ul>
      <p class="note">Longest current streak: ${bestStreak} days</p>` : '<p class="note">No habits yet.</p>'}
  </div>`;
};

const TL_START = 6, TL_END = 24, ROW = 48;
views.timeline = () => {
  const list = tasksOn(today).filter(t => !t.done);
  const loose = list.filter(t => !t.time);
  const placed = list.filter(t => t.time);
  const top = m => (m - TL_START * 60) / 60 * ROW;
  const nowM = new Date().getHours() * 60 + new Date().getMinutes();
  const hours = Array.from({ length: TL_END - TL_START }, (_, i) => TL_START + i);
  return `
  <div class="phead"><div><h1>TIMELINE</h1><p>Drag tasks onto the day. Snaps to 15 minutes.</p></div><span class="badge">${placed.length} scheduled</span></div>
  <div class="sec tl-wrap">
    <div class="tl-side">
      <p class="label">unscheduled</p>
      <div class="tl-pool" data-drop="pool">${loose.length ? loose.map(t => `<div class="tl-card" draggable="true" data-drag="${t.id}">${h(t.title)}<small>${t.est ? '~' + dur(t.est * 60) : 'no estimate'}</small></div>`).join('') : '<p class="note">Drop here to unschedule.</p>'}</div>
    </div>
    <div class="tl-grid" data-drop="grid" style="height:${hours.length * ROW}px">
      ${hours.map(hh => `<div class="tl-hour" style="top:${(hh - TL_START) * ROW}px"><span>${String(hh).padStart(2, '0')}:00</span></div>`).join('')}
      ${classesOn(today).map(c => `<div class="tl-block cls" style="top:${top(mins(c.start))}px;height:${Math.max(18, (mins(c.end) - mins(c.start)) / 60 * ROW)}px">${h(c.name)}<small>${c.start}–${c.end}${c.room ? ' · ' + h(c.room) : ''}</small></div>`).join('')}
      ${placed.map(t => `<div class="tl-block ${t.priority === 'high' ? 'hiP' : ''}" draggable="true" data-drag="${t.id}" style="top:${top(mins(t.time))}px;height:${Math.max(18, (+t.est || 30) / 60 * ROW)}px">${h(t.title)}<small>${t.time}${t.est ? ' · ' + dur(t.est * 60) : ''}</small></div>`).join('')}
      ${nowM >= TL_START * 60 ? `<div class="tl-now" style="top:${top(nowM)}px"></div>` : ''}
    </div>
  </div>
  <div class="sec">
    <p class="label">01 — class schedule</p>
    <form class="row" data-form="addClass">
      <input class="in" id="clsName" placeholder="Subject (e.g. CT 414)" autocomplete="off">
      <select class="in" id="clsDay">${DAYS.slice(1).concat('sun').map(d => `<option>${d}</option>`).join('')}</select>
      <input class="in" type="time" id="clsStart" value="08:00"><input class="in" type="time" id="clsEnd" value="10:00">
      <input class="in" id="clsRoom" placeholder="Room" style="max-width:110px" autocomplete="off">
      <button class="btn">Add</button>
    </form>
    ${S.classes.length ? `<ul class="list">${[...S.classes].sort((a, b) => (DAYS.indexOf(a.day) + 6) % 7 - (DAYS.indexOf(b.day) + 6) % 7 || (a.start < b.start ? -1 : 1)).map(c => `
      <li class="item"><span class="chip">${c.day}</span><span class="t">${h(c.name)}</span><span class="meta">${c.start}–${c.end}${c.room ? ' · ' + h(c.room) : ''}</span>
      <button class="link x" data-act="delClass" data-id="${c.id}">✕</button></li>`).join('')}</ul>` : '<p class="note">Add your timetable once. Classes then appear on Today and here automatically.</p>'}
  </div>`;
};

views.progress = () => {
  const lvl = sc => sc === 0 ? 0 : sc <= 2 ? 1 : sc <= 4 ? 2 : sc <= 7 ? 3 : 4;
  let activeDays = 0;
  const own = heatmap(k => { const v = lvl(dayScore(k)); if (v) activeDays++; return v; }, k => `${k}: ${dayScore(k)} points`);
  const g = ghStats(), cal = S.gh?.calendar || {};
  const glvl = n => n === 0 ? 0 : n <= 2 ? 1 : n <= 5 ? 2 : n <= 9 ? 3 : 4;
  const ev = S.gh?.events || [];
  return `
  <div class="phead"><div><h1>PROGRESS</h1><p>Your work over the year.</p></div>${g ? `<span class="badge">${g.streak}-day commit streak</span>` : ''}</div>
  <div class="sec">
    <div class="row" style="justify-content:space-between"><p class="label">01 — github · ${h(S.settings.ghUser || 'not set')}</p>
      <button class="link" data-act="ghRefresh">${ghBusy ? 'syncing…' : '↻ refresh'}</button></div>
    ${g ? `
    <div class="stats">
      <div class="scell"><span class="snum">${g.total}</span><small>contributions · year</small></div>
      <div class="scell"><span class="snum">${g.week}</span><small>this week</small></div>
      <div class="scell"><span class="snum">${g.today}</span><small>today</small></div>
      <div class="scell"><span class="snum">${g.streak}<i>d</i></span><small>commit streak</small></div>
    </div>
    ${heatmap(k => glvl(cal[k] || 0), k => `${k}: ${cal[k] || 0} contributions`)}
    <div class="row note" style="justify-content:space-between"><span>Best day: ${g.best[1]} on ${g.best[0] || '—'} · synced ${ago(new Date(S.gh.fetchedAt).toISOString())}</span>${heatKey}</div>`
    : `<div class="empty"><b>${S.settings.ghToken ? 'Not synced yet' : 'Add a GitHub token in Settings'}</b>${ghError ? h(ghError) : 'A token is needed for the contribution graph. Recent pushes work without one.'}</div>`}
    ${ev.length ? `<p class="label" style="margin-top:8px">recent activity</p><ul class="list">${ev.slice(0, 8).map(e => `
      <li class="item"><span class="chip">${e.type === 'PushEvent' ? `push${e.commits != null ? ' ×' + e.commits : ''}` : e.type === 'PullRequestEvent' ? 'PR' : 'create'}</span>
      <span class="t">${h(e.repo.split('/').pop())}${e.msg ? ` <span class="meta">— ${h(e.msg)}</span>` : ''}</span><span class="meta">${ago(e.at)}</span></li>`).join('')}</ul>` : ''}
  </div>
  <div class="sec">
    <p class="label">02 — daylog · year of work</p>
    ${own}
    <div class="row note" style="justify-content:space-between"><span>${activeDays} active days this year</span>${heatKey}</div>
  </div>
  <div class="sec">
    <p class="label">03 — share your week</p>
    <div class="row"><button class="btn pri" data-act="shareCard">Download weekly card (PNG)</button><span class="note">A pixel-style stats image for socials.</span></div>
    <canvas id="shareCanvas" width="1080" height="1080" hidden></canvas>
  </div>`;
};

async function drawShareCard() {
  await document.fonts.ready;
  const light = S.settings.theme === 'light';
  const C = light ? { bg: '#f4f4f2', line: '#d9d9d7', dim: '#5b5b59', hi: '#161616', raise: '#e6e6e4' } : { bg: '#0a0a0a', line: '#262626', dim: '#858585', hi: '#e0e0e0', raise: '#1a1a1a' };
  const cv = $('#shareCanvas'), x = cv.getContext('2d');
  const days = lastDays(7), per = days.map(d => S.tasks.filter(t => t.date === d && t.done).length);
  const all = days.reduce((s, d) => s + tasksOn(d).length, 0), done = per.reduce((a, b) => a + b, 0);
  const focus = days.reduce((s, d) => s + (S.focusLog[d] || 0), 0);
  const streak = Math.max(0, ...S.habits.map(habitStreak));
  x.imageSmoothingEnabled = false;
  x.fillStyle = C.bg; x.fillRect(0, 0, 1080, 1080);
  x.strokeStyle = C.line; x.lineWidth = 4; x.strokeRect(40, 40, 1000, 1000);
  x.fillStyle = C.hi; x.font = '40px "Press Start 2P"'; x.fillText('DAYLOG_', 90, 150);
  x.fillStyle = C.dim; x.font = '44px VT323';
  x.fillText(`WEEK OF ${new Date(days[0] + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase()} – ${new Date(today + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase()}`, 90, 215);
  const g = ghStats();
  const stats = [[done, 'TASKS DONE'], [`${all ? Math.round(done / all * 100) : 0}%`, 'COMPLETION'], [focus, 'FOCUS SESSIONS'], g ? [g.week, 'GITHUB CONTRIBUTIONS'] : [`${streak}D`, 'BEST STREAK']];
  stats.forEach(([v, l], i) => {
    const cx = 90 + (i % 2) * 470, cy = 330 + Math.floor(i / 2) * 190;
    x.fillStyle = C.hi; x.font = '64px "Press Start 2P"'; x.fillText(String(v), cx, cy);
    x.fillStyle = C.dim; x.font = '36px VT323'; x.fillText(l, cx, cy + 55);
  });
  x.fillStyle = C.line; x.fillRect(90, 640, 900, 4);
  const max = Math.max(1, ...per);
  per.forEach((v, i) => {
    const bx = 90 + i * 130, bh = Math.round(v / max * 200);
    x.fillStyle = C.raise; x.fillRect(bx, 680, 100, 200);
    x.fillStyle = C.hi; x.fillRect(bx, 880 - bh, 100, bh);
    x.fillStyle = C.dim; x.font = '32px VT323'; x.fillText(short(days[i]).toUpperCase(), bx + 22, 925);
  });
  x.fillStyle = C.dim; x.font = '36px VT323'; x.textAlign = 'right'; x.fillText('ashweak.github.io', 990, 1000); x.textAlign = 'left';
  const a = document.createElement('a'); a.href = cv.toDataURL('image/png'); a.download = `daylog-week-${today}.png`; a.click();
}

views.settings = () => {
  const s = S.settings;
  return `
  <div class="phead"><div><h1>SETTINGS</h1><p>Data stays on this computer.</p></div></div>
  <div class="sec">
    <p class="label">01 — ai planner (gemini)</p>
    <div class="row"><input class="in" type="password" id="setKey" value="${h(s.apiKey)}" placeholder="Gemini API key (aistudio.google.com)"></div>
    <div class="row"><input class="in" id="setModel" value="${h(s.model)}" placeholder="model"></div>
  </div>
  <div class="sec">
    <p class="label">02 — tracking & reminders</p>
    <label class="row"><button type="button" class="chk ${s.trackActivity ? 'on' : ''}" data-act="toggleTrack"></button> Track active apps in the background</label>
    <label class="row">End-of-day review reminder <input class="in" type="time" id="setReview" value="${s.reviewTime}"></label>
    <label class="row">Focus minutes <input class="in" type="number" min="5" max="120" id="setFocus" value="${s.focusMin}" style="width:90px">
      Break minutes <input class="in" type="number" min="1" max="60" id="setBreak" value="${s.breakMin}" style="width:90px"></label>
    <label class="row">Day ends at <input class="in" type="time" id="setDayEnd" value="${s.dayEnd}"> <span class="note">used for the overload warning</span></label>
    <div class="row"><input class="in" id="setMusic" value="${h(s.focusMusic)}" placeholder="Focus music link: Spotify playlist / YouTube lo-fi URL (opens when a focus session starts)"></div>
    <div class="row"><button class="btn pri" data-act="saveSettings">Save settings</button></div>
  </div>
  <div class="sec">
    <p class="label">03 — github</p>
    <div class="row"><input class="in" id="setGhUser" value="${h(s.ghUser)}" placeholder="GitHub username"></div>
    <div class="row"><input class="in" type="password" id="setGhToken" value="${h(s.ghToken)}" placeholder="GitHub token (github.com/settings/tokens — classic, scope: read:user)"></div>
    <p class="note" style="margin:0">The token is needed for the contribution graph and stays on this computer.</p>
  </div>
  <div class="sec">
    <p class="label">04 — data</p>
    <div class="row"><button class="btn" data-act="export">Export JSON</button></div>
  </div>`;
};

// ---------- render ----------
async function render() {
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('on', a.dataset.view === view));
  const html = await views[view]();
  $('#main').innerHTML = `<div class="wrap">${html}</div>`;
  if (view === 'focus') paintFocus();
  paintMini();
}

// ---------- actions ----------
const planner = { open: false, text: '', busy: false, result: null };
const review = { busy: false };
const find = id => S.tasks.find(t => t.id === id);

const actions = {
  toggleTask: ({ id }) => { const t = find(id); t.done = !t.done; t.doneAt = t.done ? Date.now() : null; },
  delTask: ({ id }) => { S.tasks = S.tasks.filter(t => t.id !== id); },
  tomorrow: ({ id }) => { const t = find(id); t.date = addDays(today, 1); toast('Moved to tomorrow'); },
  allTomorrow: () => { tasksOn(today).filter(t => !t.done && !t.recurId).forEach(t => (t.date = addDays(today, 1))); toast('Moved to tomorrow'); },
  delRecur: ({ id }) => { S.recurring = S.recurring.filter(r => r.id !== id); },
  habitDay: ({ id, day }) => { const hb = S.habits.find(x => x.id === id); hb.log[day] = !hb.log[day]; if (!hb.log[day]) delete hb.log[day]; },
  delHabit: ({ id }) => { S.habits = S.habits.filter(x => x.id !== id); },
  togglePlanner: () => { planner.open = !planner.open; },
  pickPlan: ({ i }) => { planner.result[i].pick = !planner.result[i].pick; },
  clearPlan: () => { planner.result = null; },
  addPlan: () => {
    planner.result.filter(p => p.pick).forEach(p => S.tasks.push({ id: uid(), title: p.title, date: today, done: false, time: p.time || '', est: +p.est || 0, priority: p.priority === 'high' ? 'high' : 'normal', createdAt: Date.now() }));
    planner.result = null; planner.text = ''; planner.open = false; toast('Plan added');
  },
  runPlanner: async () => {
    planner.text = $('#dump').value.trim();
    if (!planner.text) return toast('Write your brain dump first');
    planner.busy = true; await render();
    const existing = tasksOn(today).filter(t => !t.done).map(t => t.title);
    const res = await bridge.ai(`You are a day planner for a 4th-year IT student/developer. It is ${nowHM()} on ${fmtDate(today)}.
Turn this brain dump into a realistic, ordered plan for the rest of today. Split vague items into concrete tasks, drop duplicates of the existing tasks, keep titles short (max 8 words).
Existing tasks: ${JSON.stringify(existing)}\nMy classes today (keep these times free): ${JSON.stringify(classesOn(today).map(c => `${c.start}-${c.end} ${c.name}`))}\nMy day ends at ${S.settings.dayEnd}.
Brain dump: """${planner.text}"""
Return JSON: {"tasks":[{"title":string,"time":"HH:MM" or "","est":minutes (15-180),"priority":"high"|"normal","why":short reason max 6 words}]}`);
    planner.busy = false;
    if (!res.ok) return toast(res.error);
    planner.result = (res.data.tasks || []).map(t => ({ ...t, pick: true }));
  },
  saveReflect: () => { (S.reviews[today] ||= {}).note = $('#reflect').value; toast('Saved'); },
  aiReview: async () => {
    const r = (S.reviews[today] ||= {}); r.note = $('#reflect').value;
    review.busy = true; await render();
    const list = tasksOn(today);
    const a = (await bridge.activityRange([today]))[today];
    const apps = Object.entries(a.apps).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([n, v]) => `${n}: ${dur(v)}`);
    const res = await bridge.ai(`Write a short, honest end-of-day review for me (second person, friendly, max 90 words).
Done: ${JSON.stringify(list.filter(t => t.done).map(t => t.title))}
Unfinished: ${JSON.stringify(list.filter(t => !t.done).map(t => t.title))}
App usage: ${JSON.stringify(apps)} (distraction list: ${S.settings.blocklist.join(', ')})
Habits done: ${S.habits.filter(hb => hb.log[today]).length}/${S.habits.length}. Focus sessions: ${S.focusLog[today] || 0}. GitHub contributions today: ${ghStats()?.today ?? 'unknown'}.
My reflection: """${r.note || ''}"""
Return JSON: {"summary":string,"tomorrow":[up to 3 short suggestions]}`);
    review.busy = false;
    if (!res.ok) return toast(res.error);
    r.ai = res.data;
  },
  setMood: ({ i }) => { const j = (S.journal[today] ||= {}); j.mood = j.mood === +i ? null : +i; },
  loadTpl: ({ id }) => {
    const tp = S.templates.find(t => t.id === id), have = new Set(tasksOn(today).map(t => t.title.toLowerCase()));
    let n = 0;
    for (const t of tp.tasks) if (!have.has(t.title.toLowerCase())) { S.tasks.push({ id: uid(), ...t, date: today, done: false, createdAt: Date.now() }); n++; }
    toast(`Loaded ${n} task(s) from "${tp.name}"`);
  },
  delTpl: ({ id }) => { S.templates = S.templates.filter(t => t.id !== id); },
  delDeadline: ({ id }) => { S.deadlines = S.deadlines.filter(d => d.id !== id); },
  delClass: ({ id }) => { S.classes = S.classes.filter(c => c.id !== id); },
  shareCard: () => drawShareCard(),
  ghRefresh: async () => { const p = refreshGitHub(true); await render(); await p; },
  focusToggle: () => focusToggle(),
  focusSkip: () => focusSwitch(false),
  focusReset: () => focusReset(),
  delBlock: ({ i }) => { S.settings.blocklist.splice(+i, 1); },
  actPrev: () => { actDay = addDays(actDay, -1); },
  actNext: () => { actDay = addDays(actDay, 1); },
  actToday: () => { actDay = today; },
  toggleTrack: () => { S.settings.trackActivity = !S.settings.trackActivity; },
  saveSettings: () => {
    const s = S.settings;
    s.apiKey = $('#setKey').value.trim(); s.model = $('#setModel').value.trim() || 'gemini-2.5-flash';
    s.reviewTime = $('#setReview').value || '21:00';
    s.dayEnd = $('#setDayEnd').value || '23:00'; s.focusMusic = $('#setMusic').value.trim();
    const ghChanged = s.ghUser !== $('#setGhUser').value.trim() || s.ghToken !== $('#setGhToken').value.trim();
    s.ghUser = $('#setGhUser').value.trim(); s.ghToken = $('#setGhToken').value.trim();
    if (ghChanged && s.ghUser) refreshGitHub(true);
    s.focusMin = Math.max(5, +$('#setFocus').value || 25); s.breakMin = Math.max(1, +$('#setBreak').value || 5);
    if (!F.running) focusReset();
    toast('Settings saved');
  },
  export: () => {
    const a = document.createElement('a');
    const copy = { ...S, gh: undefined, settings: { ...S.settings, apiKey: '', ghToken: '' } };
    a.href = URL.createObjectURL(new Blob([JSON.stringify(copy, null, 2)], { type: 'application/json' }));
    a.download = `daylog-${today}.json`; a.click();
  }
};

const forms = {
  addTask: () => {
    const title = $('#newTask').value.trim(); if (!title) return;
    S.tasks.push({ id: uid(), title, date: today, done: false, time: $('#newTime').value, est: +$('#newEst').value || 0, priority: $('#newPri').value, createdAt: Date.now() });
  },
  addRecur: () => {
    const title = $('#recTitle').value.trim(); if (!title) return;
    S.recurring.push({ id: uid(), title, rule: $('#recRule').value, time: $('#recTime').value });
    rollover();
  },
  addHabit: () => {
    const name = $('#habitName').value.trim(); if (!name) return;
    S.habits.push({ id: uid(), name, log: {} });
  },
  saveTpl: () => {
    const name = $('#tplName').value.trim() || `Template ${S.templates.length + 1}`;
    S.templates.push({ id: uid(), name, tasks: tasksOn(today).filter(t => !t.recurId).map(({ title, time, est, priority }) => ({ title, time: time || '', est: est || 0, priority: priority || 'normal' })) });
    toast(`Saved "${name}"`);
  },
  addDeadline: () => {
    const title = $('#dlTitle').value.trim(), due = $('#dlDue').value; if (!title || !due) return toast('Add a title and a date');
    S.deadlines.push({ id: uid(), title, due });
  },
  addClass: () => {
    const name = $('#clsName').value.trim(), start = $('#clsStart').value, end = $('#clsEnd').value;
    if (!name || !start || !end || end <= start) return toast('Check the subject and times');
    S.classes.push({ id: uid(), name, day: $('#clsDay').value, start, end, room: $('#clsRoom').value.trim() });
  },
  saveJournal: () => { (S.journal[today] ||= {}).text = $('#journalIn').value.trim(); toast('Saved'); },
  addBlock: () => {
    const v = $('#blockIn').value.trim().toLowerCase(); if (v && !S.settings.blocklist.includes(v)) S.settings.blocklist.push(v);
  }
};

document.addEventListener('click', async e => {
  const nav = e.target.closest('.nav a');
  if (nav) { view = nav.dataset.view; return render(); }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  e.preventDefault();
  await actions[el.dataset.act]?.(el.dataset);
  save();
  if (!['focusToggle', 'focusSkip', 'focusReset'].includes(el.dataset.act)) {
    await render();
    if (el.dataset.act === 'togglePlanner' && planner.open) $('#dump')?.focus();
  }
});

document.addEventListener('submit', async e => {
  const f = e.target.dataset.form; if (!f) return;
  e.preventDefault();
  forms[f]();
  save(); await render();
  const first = $(`[data-form="${f}"] input`); first && first.focus();
});

// Timeline drag & drop
document.addEventListener('dragstart', e => {
  const el = e.target.closest('[data-drag]'); if (!el) return;
  e.dataTransfer.setData('text/plain', el.dataset.drag);
  const r = el.getBoundingClientRect(); e.dataTransfer.setData('offset', String(e.clientY - r.top));
  el.classList.add('dragging');
});
document.addEventListener('dragover', e => { if (e.target.closest('[data-drop]')) e.preventDefault(); });
document.addEventListener('drop', async e => {
  const zone = e.target.closest('[data-drop]'); if (!zone) return;
  e.preventDefault();
  const t = find(e.dataTransfer.getData('text/plain')); if (!t) return;
  if (zone.dataset.drop === 'pool') t.time = '';
  else {
    const y = e.clientY - zone.getBoundingClientRect().top - (+e.dataTransfer.getData('offset') || 0);
    const m = Math.round((TL_START * 60 + y / ROW * 60) / 15) * 15;
    t.time = hm(Math.min(Math.max(m, TL_START * 60), TL_END * 60 - 15));
    t.reminded = false;
  }
  save(); await render();
});

$('#themeBtn').addEventListener('click', () => { S.settings.theme = S.settings.theme === 'light' ? 'dark' : 'light'; applyTheme(); save(); });
function applyTheme() {
  const light = S.settings.theme === 'light';
  $('#root').classList.toggle('light', light);
  document.body.style.background = light ? '#f4f4f2' : '#0a0a0a';
  $('#themeBtn span').textContent = light ? 'Dark mode' : 'Light mode';
}

// Keyboard: N = new task, 1-9 = switch views
const ORDER = ['today', 'timeline', 'habits', 'focus', 'activity', 'review', 'insights', 'progress', 'settings'];
document.addEventListener('keydown', e => {
  if (e.target.matches('input,textarea,select')) return;
  if (e.key === 'n') { e.preventDefault(); quickAdd(); }
  if (/^[1-9]$/.test(e.key)) { view = ORDER[+e.key - 1]; render(); }
});
async function quickAdd() { view = 'today'; await render(); $('#newTask').focus(); }

// ---------- background checks (every 30s) ----------
function tick() {
  refreshGitHub();
  if (dayKey() !== today) { rollover(); render(); }
  const hm = nowHM(), mins = s => +s.slice(0, 2) * 60 + +s.slice(3, 5);
  for (const t of tasksOn(today)) {
    const late = t.time ? mins(hm) - mins(t.time) : -1;
    if (!t.done && late >= 0 && late <= 2 && !t.reminded) { t.reminded = true; bridge.notify('Task reminder', t.title); save(); }
  }
  if (S.settings.reviewTime && hm >= S.settings.reviewTime && S.meta.reviewNotified !== today) {
    S.meta.reviewNotified = today; save();
    const left = tasksOn(today).filter(t => !t.done).length;
    bridge.notify('End-of-day review', left ? `${left} task(s) left. Take 2 minutes to review your day.` : 'Everything done. Review your day?');
  }
}

// ---------- boot ----------
(async () => {
  const loaded = await bridge.load();
  S = { ...structuredClone(DEFAULTS), ...(loaded || {}) };
  S.settings = { ...DEFAULTS.settings, ...(loaded?.settings || {}) };
  S.meta = { ...DEFAULTS.meta, ...(loaded?.meta || {}) };
  applyTheme();
  rollover();
  F.left = S.settings.focusMin * 60;
  bridge.on('quick-add', quickAdd);
  bridge.on('distraction', hit => toast(`Focus: "${hit}" detected`));
  await render();
  setInterval(tick, 30000); tick();
  refreshGitHub();
})();
