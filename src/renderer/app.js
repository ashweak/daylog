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
const D = key => new Date(key + 'T00:00');
const fmtDate = key => D(key).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const fmtShort = key => D(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const short = key => D(key).toLocaleDateString(undefined, { weekday: 'short' });
const dur = s => { s = Math.round(s); const hh = Math.floor(s / 3600), mm = Math.floor(s % 3600 / 60); return hh ? `${hh}h ${mm}m` : `${mm}m`; };
const nowHM = () => new Date().toTimeString().slice(0, 5);
const mins = s => +s.slice(0, 2) * 60 + +s.slice(3, 5);
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const daysBetween = (a, b) => Math.round((D(b) - D(a)) / 864e5);
const relDay = key => { const n = daysBetween(today, key); return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n < 0 ? `${-n}d ago` : n < 7 ? short(key) : fmtShort(key); };

// Styled confirm dialog → resolves true/false
function confirmBox(title, body = '', yes = 'Confirm') {
  const m = $('#modal');
  $('#mTitle').textContent = title; $('#mBody').textContent = body; $('#mYes').textContent = yes;
  m.hidden = false; $('#mYes').focus();
  return new Promise(res => {
    const done = v => { m.hidden = true; m.onclick = null; document.removeEventListener('keydown', key, true); res(v); };
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); done(false); } if (e.key === 'Enter') { e.preventDefault(); done(true); } };
    m.onclick = e => { const b = e.target.closest('[data-m]'); if (b) done(b.dataset.m === 'yes'); else if (e.target === m) done(false); };
    document.addEventListener('keydown', key, true);
  });
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- state ----------
const DEFAULTS = {
  tasks: [], schedules: [], habits: [], focusLog: {}, gh: null,
  settings: {
    theme: 'dark', apiKey: '', model: 'gemini-2.5-flash', trackActivity: true,
    blocklist: ['youtube', 'facebook', 'tiktok', 'netflix', 'reddit', 'instagram'],
    focusMin: 25, breakMin: 5, focusMusic: '', dayEnd: '23:00', ghUser: 'ashweak', ghToken: '', desktopCar: true
  }
};
let S, view = 'dashboard', today = dayKey();
let saveT;
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => bridge.save(S), 150); };

// Migrate data from older versions (recurring rules → schedules, recurId → schedId)
function migrate(loaded) {
  if (!loaded) return;
  const map = { daily: ['daily'], weekdays: ['weekdays'], weekends: ['weekly', [0, 6]] };
  for (const r of loaded.recurring || []) {
    const [repeat, days] = map[r.rule] || ['weekly', [DAYS.indexOf(r.rule)]];
    (loaded.schedules ||= []).push({ id: r.id, title: r.title, start: today, repeat, days: days || [], until: '', time: r.time || '', priority: 'normal', est: 0 });
  }
  delete loaded.recurring;
  for (const t of loaded.tasks || []) if (t.recurId) { t.schedId = t.recurId; delete t.recurId; }
  for (const k of ['templates', 'classes', 'deadlines', 'journal', 'reviews', 'meta']) delete loaded[k];
}

// ---------- scheduling ----------
const lastDom = (y, m) => new Date(y, m + 1, 0).getDate();
function matches(s, key) {
  if (key < s.start || (s.until && key > s.until)) return false;
  const d = D(key), st = D(s.start), dow = d.getDay();
  switch (s.repeat) {
    case 'daily': return true;
    case 'weekdays': return dow >= 1 && dow <= 5;
    case 'weekly': return (s.days?.length ? s.days : [st.getDay()]).includes(dow);
    case 'monthly': return d.getDate() === Math.min(st.getDate(), lastDom(d.getFullYear(), d.getMonth()));
    case 'yearly': return d.getMonth() === st.getMonth() && d.getDate() === Math.min(st.getDate(), lastDom(d.getFullYear(), d.getMonth()));
    default: return false;
  }
}
function repeatLabel(s) {
  const st = D(s.start);
  const base = {
    daily: 'every day', weekdays: 'weekdays',
    weekly: 'weekly · ' + (s.days?.length ? s.days : [st.getDay()]).map(i => DAYS[i]).join(', '),
    monthly: `monthly · day ${st.getDate()}`,
    yearly: `yearly · ${st.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
  }[s.repeat];
  return base + (s.until ? ` · until ${fmtShort(s.until)}` : '');
}
// Everything planned on a date: real tasks + not-yet-created repeat occurrences (future days)
function itemsOn(key) {
  const real = S.tasks.filter(t => t.date === key);
  if (key <= today) return real;
  const virt = S.schedules.filter(s => matches(s, key) && !real.some(t => t.schedId === s.id))
    .map(s => ({ id: 'v-' + s.id, title: s.title, date: key, time: s.time, priority: s.priority, est: s.est, schedId: s.id, virtual: true }));
  return [...real, ...virt];
}

function rollover() {
  today = dayKey();
  for (const t of S.tasks) {
    if (!t.done && t.date < today && !t.schedId) { t.from ||= t.date; t.date = today; t.carried = (t.carried || 0) + 1; }
  }
  for (const s of S.schedules) {
    if (matches(s, today) && !S.tasks.some(t => t.schedId === s.id && t.date === today)) {
      S.tasks.push({ id: uid(), title: s.title, date: today, done: false, schedId: s.id, time: s.time || '', est: s.est || 0, priority: s.priority || 'normal', createdAt: Date.now() });
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
    (a.createdAt || 0) - (b.createdAt || 0));
}
// Upcoming items, skipping every-day/weekday repeats (they'd flood the list)
function upcoming(days) {
  const noisy = new Set(S.schedules.filter(s => s.repeat === 'daily' || s.repeat === 'weekdays').map(s => s.id));
  const out = [];
  for (let i = 1; i <= days; i++) { const k = addDays(today, i); for (const t of itemsOn(k)) if (!t.done && !noisy.has(t.schedId)) out.push(t); }
  return out;
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

// ---------- GitHub ----------
let ghBusy = false, ghError = '';
async function refreshGitHub(force) {
  const s = S.settings;
  if (!s.ghUser || ghBusy) return;
  if (!force && S.gh && S.gh.user === s.ghUser && Date.now() - S.gh.fetchedAt < 10 * 60000) return;
  ghBusy = true;
  const res = await bridge.github(s.ghUser, s.ghToken);
  ghBusy = false;
  if (!res.ok) { ghError = res.error; if (force) toast(res.error); return; }
  ghError = '';
  S.gh = { ...res.data, user: s.ghUser, fetchedAt: Date.now() };
  save(); paintMini();
  if (view === 'dashboard') render();
}
function ghStats() {
  const cal = S.gh?.calendar;
  if (!cal) return null;
  const c = k => cal[k] || 0;
  let streak = 0, k = today;
  if (!c(k)) k = addDays(k, -1);
  while (c(k)) { streak++; k = addDays(k, -1); }
  return { today: c(today), week: lastDays(7).reduce((s, d) => s + c(d), 0), streak, total: S.gh.total ?? Object.values(cal).reduce((a, b) => a + b, 0) };
}
const ago = iso => { const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
function heatmap(weeks, levelOf, titleOf) {
  const end = D(today);
  const start = new Date(end); start.setDate(start.getDate() - (weeks - 1) * 7 - end.getDay());
  const cells = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = dayKey(d);
    cells.push(`<i class="hm${levelOf(key)}" title="${titleOf(key)}"></i>`);
  }
  return `<div class="heat">${cells.join('')}</div>`;
}

// GitHub-style contribution graph (53 weeks, month + weekday labels)
function ghGraph() {
  const cal = S.gh?.calendar || {}, lv = S.gh?.levels || {};
  const end = D(today), start = new Date(end); start.setDate(start.getDate() - 52 * 7 - end.getDay());
  const max = Math.max(1, ...Object.values(cal));
  const level = k => k in lv ? lv[k] : !cal[k] ? 0 : Math.min(4, Math.ceil(cal[k] / max * 4));
  const parts = [], months = [];
  let col = 0, lastMonth = -1;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const k = dayKey(d), dow = d.getDay();
    if (dow === 0 && d.getMonth() !== lastMonth) { if (col < 52) months.push(`<span class="gm" style="grid-column:${col + 2}">${d.toLocaleDateString(undefined, { month: 'short' })}</span>`); lastMonth = d.getMonth(); }
    const n = cal[k] || 0;
    parts.push(`<i class="g${level(k)}" style="grid-column:${col + 2};grid-row:${dow + 2}" title="${n ? n : 'No'} contribution${n === 1 ? '' : 's'} on ${fmtShort(k)}"></i>`);
    if (dow === 6) col++;
  }
  const dl = [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']].map(([r, l]) => `<span class="gd" style="grid-row:${r + 2}">${l}</span>`).join('');
  return `<div class="ghwrap"><div class="ghg">${months.join('')}${dl}${parts.join('')}</div></div>
    <div class="row note" style="justify-content:space-between;margin-top:6px"><span>${S.gh ? `synced ${ago(new Date(S.gh.fetchedAt).toISOString())} · updates automatically` : ''}</span>
    <span class="glegend">Less <i class="g0"></i><i class="g1"></i><i class="g2"></i><i class="g3"></i><i class="g4"></i> More</span></div>`;
}

const isDistraction = name => S.settings.blocklist.some(b => b && name.toLowerCase().includes(b.toLowerCase()));

// ---------- focus timer (runs regardless of view) ----------
const F = { phase: 'focus', left: 0, running: false, timer: null };
const clockStr = () => `${String(Math.floor(F.left / 60)).padStart(2, '0')}:${String(F.left % 60).padStart(2, '0')}`;
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
  const c = $('#clock'); if (c) c.textContent = clockStr();
  const p = $('#phase'); if (p) p.textContent = `${F.phase}${F.running ? '' : ' · paused'}`;
  const b = $('#focusBtn'); if (b) b.textContent = F.running ? 'Pause' : 'Start';
  paintMini();
}
function paintMini() {
  const list = tasksOn(today), done = list.filter(t => t.done).length;
  const next = upcoming(30).filter(t => !t.schedId).slice(0, 2);
  const g = ghStats();
  $('#miniStatus').innerHTML =
    `<div><b>${done}/${list.length}</b> tasks today</div>` +
    next.map(t => `<div class="mdl"><b>${relDay(t.date)}</b> ${h(t.title)}</div>`).join('') +
    (g ? `<div><b>${g.today}</b> github contributions today</div>` : '') +
    (F.running ? `<div>${F.phase} · <b>${clockStr()}</b></div>` : '');
}

// ---------- shared pieces ----------
const EST = [['', '— est'], [15, '15m'], [30, '30m'], [45, '45m'], [60, '1h'], [90, '1.5h'], [120, '2h'], [180, '3h']];
const estOpts = (v = '') => EST.map(([m, l]) => `<option value="${m}" ${String(m) === String(v) ? 'selected' : ''}>${l}</option>`).join('');
const REPEATS = [['once', 'once'], ['daily', 'every day'], ['weekdays', 'weekdays'], ['weekly', 'weekly'], ['monthly', 'monthly'], ['yearly', 'yearly']];

function addForm(date = today) {
  const dow = D(date).getDay();
  return `
  <form class="addf" data-form="addTask">
    <div class="row">
      <input class="in" name="title" placeholder="What needs doing?" autocomplete="off">
      <button class="btn pri">Add</button>
    </div>
    <div class="row">
      <label class="fl">date <input class="in" type="date" name="date" value="${date}"></label>
      <label class="fl">repeat <select class="in" name="repeat">${REPEATS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
      <label class="fl until" hidden>until <input class="in" type="date" name="until" title="Leave empty to repeat forever"></label>
      <label class="fl">time <input class="in" type="time" name="time"></label>
      <label class="fl">est <select class="in" name="est">${estOpts()}</select></label>
      <label class="fl">priority <select class="in" name="priority"><option value="normal">normal</option><option value="high">high</option></select></label>
    </div>
    <div class="row wdays" hidden>${DAYS.map((d, i) => `<button type="button" class="btn sm ${i === dow ? 'pri' : ''}" data-act="wd" data-i="${i}">${d}</button>`).join('')}<span class="note">repeat on these days</span></div>
  </form>`;
}

function taskRow(t, opts = {}) {
  const late = t.from && !t.done ? daysBetween(t.from, today) : 0;
  return `<li class="item ${t.done ? 'done' : ''}">
    ${t.virtual ? '<span class="chk ghost" title="Scheduled — appears on its day"></span>' : `<button class="chk ${t.done ? 'on' : ''}" data-act="toggleTask" data-id="${t.id}" aria-label="Toggle done"></button>`}
    <span class="t">${h(t.title)}</span>
    ${opts.showDate ? `<span class="meta">${relDay(t.date)}</span>` : ''}
    ${t.est ? `<span class="meta">~${dur(t.est * 60)}</span>` : ''}
    ${t.time ? `<span class="chip">${t.time}</span>` : ''}
    ${t.priority === 'high' ? '<span class="chip hi">HIGH</span>' : ''}
    ${t.schedId ? '<span class="chip" title="Repeating">↻</span>' : ''}
    ${late > 0 ? `<span class="chip warnc">${late}d late</span>` : ''}
    ${!t.done && !t.schedId && !t.virtual ? `<button class="link x" data-act="tomorrow" data-id="${t.id}">→ tmrw</button>` : ''}
    ${t.virtual ? '' : `<button class="link x" data-act="delTask" data-id="${t.id}">✕</button>`}
  </li>`;
}

// ---------- views ----------
const views = {};

views.dashboard = async () => {
  const list = tasksOn(today), done = list.filter(t => t.done).length, pct = list.length ? Math.round(done / list.length * 100) : 0;
  const overdue = sortTasks(list.filter(t => !t.done && t.from));
  const dueToday = sortTasks(list.filter(t => !t.done && !t.from));
  const up = upcoming(14);
  const weekDue = up.filter(t => daysBetween(today, t.date) <= 7).length;
  const acts = await bridge.activityRange(lastDays(7));
  const act = acts[today];
  const apps = Object.entries(act.apps).sort((x, y) => y[1] - x[1]);
  const active = apps.reduce((s, [, v]) => s + v, 0);
  const per = lastDays(7).map(d => { const l = tasksOn(d); return { d, total: l.length, done: l.filter(t => t.done).length }; });
  const maxT = Math.max(1, ...per.map(p => p.total));
  const wDone = per.reduce((s, p) => s + p.done, 0), wAll = per.reduce((s, p) => s + p.total, 0);
  const g = ghStats(), cal = S.gh?.calendar || {};
  const glvl = n => n === 0 ? 0 : n <= 2 ? 1 : n <= 5 ? 2 : n <= 9 ? 3 : 4;
  const hr = new Date().getHours();
  const greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  // group upcoming by date
  const groups = {};
  for (const t of up) (groups[t.date] ||= []).push(t);

  return `
  <div class="phead"><div><h1>DASHBOARD</h1><p>${greet}. ${fmtDate(today)}</p></div><span class="badge">${pct}% of today done</span></div>
  <div class="sec">
    <div class="stats s5">
      <div class="scell"><span class="snum">${done}<i>/${list.length}</i></span><small>done today</small></div>
      <div class="scell"><span class="snum">${overdue.length}</span><small>overdue</small></div>
      <div class="scell"><span class="snum">${weekDue}</span><small>due this week</small></div>
      <div class="scell"><span class="snum">${S.focusLog[today] || 0}</span><small>focus sessions</small></div>
      <div class="scell"><span class="snum">${dur(active)}</span><small>active time</small></div>
    </div>
    <div class="bar"><i style="width:${pct}%"></i></div>
  </div>

  <div class="sec grid2">
    <div class="card">
      <div class="row" style="justify-content:space-between"><p class="label">due today</p><button class="link" data-act="go" data-view="today">open today →</button></div>
      ${dueToday.length ? `<ul class="list flat">${dueToday.slice(0, 8).map(t => taskRow(t)).join('')}</ul>${dueToday.length > 8 ? `<p class="note">+${dueToday.length - 8} more</p>` : ''}` : `<p class="note">${list.length ? 'All done for today. 🎉' : 'Nothing due today.'}</p>`}
    </div>
    <div class="card">
      <div class="row" style="justify-content:space-between"><p class="label">overdue</p>${overdue.length ? '<button class="link" data-act="allTomorrow">move all → tmrw</button>' : ''}</div>
      ${overdue.length ? `<ul class="list flat">${overdue.map(t => taskRow(t)).join('')}</ul>` : '<p class="note">Nothing overdue.</p>'}
    </div>
  </div>

  <div class="sec">
    <div class="row" style="justify-content:space-between"><p class="label">01 — upcoming · next 14 days <span class="note" style="text-transform:none;letter-spacing:0">(daily repeats hidden)</span></p><button class="link" data-act="go" data-view="schedule">calendar →</button></div>
    ${up.length ? Object.entries(groups).map(([k, items]) => `
      <div class="dgroup"><span class="dlabel">${relDay(k)}<small>${daysBetween(today, k) < 7 ? fmtShort(k) : short(k)}</small></span>
      <ul class="list flat" style="flex:1">${sortTasks(items).map(t => taskRow(t)).join('')}</ul></div>`).join('')
      : '<div class="empty"><b>Nothing scheduled</b>Add tasks with a future date or a repeat.</div>'}
  </div>

  <div class="sec grid2">
    <div class="card">
      <p class="label">this week · ${wAll ? Math.round(wDone / wAll * 100) : 0}% completed</p>
      <div class="cols sm">${per.map(p => `<div class="col" title="${p.done}/${p.total}"><span>${p.done}</span><i style="height:${p.done / maxT * 90}px"></i></div>`).join('')}</div>
      <div class="colx">${per.map(p => `<span>${p.d === today ? 'today' : short(p.d)}</span>`).join('')}</div>
    </div>
    <div class="card">
      <div class="row" style="justify-content:space-between"><p class="label">habits</p><button class="link" data-act="go" data-view="habits">manage →</button></div>
      ${S.habits.length ? S.habits.map(hb => `<div class="item flat"><button class="chk ${hb.log[today] ? 'on' : ''}" data-act="habitDay" data-id="${hb.id}" data-day="${today}"></button><span class="t">${h(hb.name)}</span><span class="meta">🔥 ${habitStreak(hb)}</span></div>`).join('') : '<p class="note">No habits yet.</p>'}
    </div>
  </div>

  <div class="sec">
    <div class="row" style="justify-content:space-between"><p class="label">02 — github · ${h(S.settings.ghUser || 'not set')}</p><button class="link" data-act="ghRefresh">${ghBusy ? 'syncing…' : '↻ refresh'}</button></div>
    ${g ? `<h3 class="ghtitle">${g.total} contributions in the last year</h3>
      <div class="row ghs"><span><b>${g.today}</b> today</span><span><b>${g.week}</b> this week</span><span><b>${g.streak}d</b> streak</span></div>
      ${ghGraph()}`
      : `<div class="empty"><b>${ghBusy ? 'Syncing with GitHub…' : 'GitHub not synced yet'}</b>${ghError ? h(ghError) : S.settings.ghUser ? 'It loads automatically when you are online.' : 'Set your GitHub username in Settings.'}</div>`}
  </div>

  <div class="sec grid2">
    <div class="card">
      <div class="row" style="justify-content:space-between"><p class="label">top apps today</p><button class="link" data-act="go" data-view="activity">activity →</button></div>
      ${apps.length ? `<div class="hbars">${apps.slice(0, 5).map(([n, v]) => `<div class="hb ${isDistraction(n) ? 'bad' : ''}"><span>${h(n)}</span><span class="track"><i style="width:${v / apps[0][1] * 100}%"></i></span><span>${dur(v)}</span></div>`).join('')}</div>` : '<p class="note">No activity recorded yet.</p>'}
    </div>
    <div class="card">
      <p class="label">recent github activity</p>
      ${(S.gh?.events || []).length ? (S.gh.events).slice(0, 5).map(e => `<div class="row" style="justify-content:space-between;font-size:16px;flex-wrap:nowrap"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(e.repo.split('/').pop())}${e.msg ? ` <span class="meta">— ${h(e.msg)}</span>` : ''}</span><span class="meta">${ago(e.at)}</span></div>`).join('') : '<p class="note">No recent public pushes.</p>'}
    </div>
  </div>`;
};

const planner = { open: false, text: '', busy: false, result: null };
views.today = () => {
  const list = sortTasks(tasksOn(today));
  const done = list.filter(t => t.done).length, pct = list.length ? Math.round(done / list.length * 100) : 0;
  const planned = list.filter(t => !t.done).reduce((s, t) => s + (+t.est || 0), 0);
  const nowM = new Date().getHours() * 60 + new Date().getMinutes();
  const avail = Math.max(0, mins(S.settings.dayEnd) - nowM);
  const over = planned > avail;
  return `
  <div class="phead"><div><h1>TODAY</h1><p>${fmtDate(today)}</p></div><span class="badge">${over ? '⚠ overloaded' : `${pct}% complete`}</span></div>
  <div class="sec">
    <div class="bar"><i style="width:${pct}%"></i></div>
    <p class="note" style="margin:0">${done}/${list.length} done${planned ? ` · planned ${dur(planned * 60)} · ${dur(avail * 60)} left until ${S.settings.dayEnd}${over ? ` — <b class="warn">${dur((planned - avail) * 60)} over</b>` : ''}` : ''}</p>
  </div>
  <div class="sec">
    <div class="row" style="justify-content:space-between"><p class="label">01 — add task</p><button class="btn sm" type="button" data-act="togglePlanner">✦ AI plan</button></div>
    ${addForm(today)}
    <div class="card" id="planner" ${planner.open ? '' : 'hidden'}>
      <p class="label" style="margin-bottom:10px">Brain dump → ordered day plan</p>
      <textarea class="in" id="dump" placeholder="e.g. finish CT 414 lab, fix portfolio footer, gym later, study for quiz tomorrow...">${h(planner.text)}</textarea>
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
    ${list.length ? `<ul class="list">${list.map(t => taskRow(t)).join('')}</ul>` : `<div class="empty"><b>Nothing planned yet</b>Add a task or let AI plan your day.</div>`}
  </div>`;
};

let calMonth = null, calSel = null;
views.schedule = () => {
  calMonth ||= today.slice(0, 7); calSel ||= today;
  const [y, m] = calMonth.split('-').map(Number);
  const first = new Date(y, m - 1, 1), startPad = first.getDay(), nDays = lastDom(y, m - 1);
  const cells = [];
  for (let i = 0; i < startPad; i++) cells.push('<div class="cday pad"></div>');
  for (let d = 1; d <= nDays; d++) {
    const k = `${calMonth}-${String(d).padStart(2, '0')}`, items = sortTasks(itemsOn(k));
    cells.push(`<button class="cday ${k === today ? 'today' : ''} ${k === calSel ? 'sel' : ''} ${k < today ? 'past' : ''}" data-act="calPick" data-day="${k}">
      <span class="cnum">${d}</span>${items.slice(0, 3).map(t => `<span class="cit ${t.done ? 'done' : ''} ${t.priority === 'high' ? 'hiP' : ''}">${t.schedId ? '↻ ' : ''}${h(t.title)}</span>`).join('')}${items.length > 3 ? `<span class="cmore">+${items.length - 3}</span>` : ''}</button>`);
  }
  const selItems = sortTasks(itemsOn(calSel));
  return `
  <div class="phead"><div><h1>SCHEDULE</h1><p>Plan days, months or the whole year ahead.</p></div>
    <div class="row"><button class="btn sm" data-act="calPrev">◂</button><button class="btn sm" data-act="calToday">today</button><button class="btn sm" data-act="calNext">▸</button></div></div>
  <div class="sec">
    <p class="label">${first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</p>
    <div class="cal">${DAYS.map(d => `<div class="chead">${d}</div>`).join('')}${cells.join('')}</div>
  </div>
  <div class="sec">
    <p class="label">${fmtDate(calSel)}</p>
    ${selItems.length ? `<ul class="list">${selItems.map(t => taskRow(t)).join('')}</ul>` : '<p class="note" style="margin:0">Nothing on this day.</p>'}
    ${calSel >= today ? addForm(calSel) : ''}
  </div>
  <div class="sec">
    <p class="label">01 — repeating tasks (${S.schedules.length})</p>
    ${S.schedules.length ? `<ul class="list">${S.schedules.map(s => `
      <li class="item"><span class="chip">↻</span><span class="t">${h(s.title)}</span>
      <span class="meta">${repeatLabel(s)}${s.time ? ' · ' + s.time : ''}</span>
      <span class="meta">from ${fmtShort(s.start)}</span>
      <button class="link x" data-act="delSched" data-id="${s.id}">stop</button></li>`).join('')}</ul>`
      : '<p class="note" style="margin:0">Pick a repeat option when adding a task: every day, weekdays, weekly, monthly or yearly — with an optional end date.</p>'}
  </div>`;
};

views.habits = () => {
  const days = lastDays(14);
  return `
  <div class="phead"><div><h1>HABITS</h1><p>Small things, every day.</p></div></div>
  <div class="sec">
    <form class="row" data-form="addHabit"><input class="in" name="name" placeholder="New habit (e.g. code 1 hour, read 10 pages)" autocomplete="off"><button class="btn pri">Add</button></form>
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
    <form class="row" data-form="addBlock"><input class="in" name="block" placeholder="e.g. youtube, steam, discord" autocomplete="off"><button class="btn">Add</button></form>
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
    <p class="label">02 — tracking & focus</p>
    <label class="row"><button type="button" class="chk ${s.trackActivity ? 'on' : ''}" data-act="toggleTrack"></button> Track active apps in the background</label>
    <label class="row"><button type="button" class="chk ${s.desktopCar ? 'on' : ''}" data-act="toggleCar"></button> Pixel supercar driving along the bottom of the desktop</label>
    <label class="row">Focus minutes <input class="in" type="number" min="5" max="120" id="setFocus" value="${s.focusMin}" style="width:90px">
      Break minutes <input class="in" type="number" min="1" max="60" id="setBreak" value="${s.breakMin}" style="width:90px"></label>
    <label class="row">Day ends at <input class="in" type="time" id="setDayEnd" value="${s.dayEnd}"> <span class="note">used for the overload warning</span></label>
    <div class="row"><input class="in" id="setMusic" value="${h(s.focusMusic)}" placeholder="Focus music link: Spotify playlist / YouTube lo-fi URL (opens when a focus session starts)"></div>
  </div>
  <div class="sec">
    <p class="label">03 — github</p>
    <div class="row"><input class="in" id="setGhUser" value="${h(s.ghUser)}" placeholder="GitHub username"></div>
    <div class="row"><input class="in" type="password" id="setGhToken" value="${h(s.ghToken)}" placeholder="Optional token (classic, scope read:user) — includes private contributions"></div>
    <p class="note" style="margin:0">Your public contribution graph loads with just the username and refreshes every 10 minutes. A token is optional (adds private contributions) and stays on this computer.</p>
  </div>
  <div class="sec">
    <div class="row"><button class="btn pri" data-act="saveSettings">Save settings</button><button class="btn" data-act="export">Export JSON</button></div>
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
const find = id => S.tasks.find(t => t.id === id);
const NO_RENDER = ['focusToggle', 'focusSkip', 'focusReset', 'wd'];

const actions = {
  go: ({ view: v }) => { view = v; },
  toggleTask: async ({ id }) => {
    const t = find(id);
    if (!t.done && !(await confirmBox(`Mark "${t.title}" as done?`, 'You can undo this by clicking the checkbox again.', 'Mark as done'))) return 'cancel';
    t.done = !t.done; t.doneAt = t.done ? Date.now() : null;
    if (t.done) toast('Task completed ✓');
  },
  delTask: ({ id }) => { S.tasks = S.tasks.filter(t => t.id !== id); },
  tomorrow: ({ id }) => { const t = find(id); t.from ||= t.date; t.date = addDays(today, 1); toast('Moved to tomorrow'); },
  allTomorrow: () => { tasksOn(today).filter(t => !t.done && !t.schedId).forEach(t => { t.from ||= t.date; t.date = addDays(today, 1); }); toast('Moved to tomorrow'); },
  delSched: ({ id }) => {
    S.schedules = S.schedules.filter(s => s.id !== id);
    S.tasks = S.tasks.filter(t => !(t.schedId === id && !t.done && t.date >= today));
    toast('Repeating task stopped');
  },
  wd: (_d, el) => el.classList.toggle('pri'),
  calPick: ({ day }) => { calSel = day; },
  calPrev: () => { const [y, m] = calMonth.split('-').map(Number); calMonth = dayKey(new Date(y, m - 2, 1)).slice(0, 7); },
  calNext: () => { const [y, m] = calMonth.split('-').map(Number); calMonth = dayKey(new Date(y, m, 1)).slice(0, 7); },
  calToday: () => { calMonth = today.slice(0, 7); calSel = today; },
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
Existing tasks: ${JSON.stringify(existing)}
My day ends at ${S.settings.dayEnd}.
Brain dump: """${planner.text}"""
Return JSON: {"tasks":[{"title":string,"time":"HH:MM" or "","est":minutes (15-180),"priority":"high"|"normal","why":short reason max 6 words}]}`);
    planner.busy = false;
    if (!res.ok) return toast(res.error);
    planner.result = (res.data.tasks || []).map(t => ({ ...t, pick: true }));
  },
  ghRefresh: async () => { const p = refreshGitHub(true); await render(); await p; },
  focusToggle: () => focusToggle(),
  focusSkip: () => focusSwitch(false),
  focusReset: () => focusReset(),
  delBlock: ({ i }) => { S.settings.blocklist.splice(+i, 1); },
  actPrev: () => { actDay = addDays(actDay, -1); },
  actNext: () => { actDay = addDays(actDay, 1); },
  actToday: () => { actDay = today; },
  toggleTrack: () => { S.settings.trackActivity = !S.settings.trackActivity; },
  toggleCar: () => { S.settings.desktopCar = !S.settings.desktopCar; bridge.setCar?.(S.settings.desktopCar); },
  saveSettings: () => {
    const s = S.settings;
    s.apiKey = $('#setKey').value.trim(); s.model = $('#setModel').value.trim() || 'gemini-2.5-flash';
    s.focusMin = Math.max(5, +$('#setFocus').value || 25); s.breakMin = Math.max(1, +$('#setBreak').value || 5);
    s.dayEnd = $('#setDayEnd').value || '23:00'; s.focusMusic = $('#setMusic').value.trim();
    const ghChanged = s.ghUser !== $('#setGhUser').value.trim() || s.ghToken !== $('#setGhToken').value.trim();
    s.ghUser = $('#setGhUser').value.trim(); s.ghToken = $('#setGhToken').value.trim();
    if (ghChanged && s.ghUser) refreshGitHub(true);
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
  addTask: f => {
    const v = n => f.elements[n].value.trim();
    const title = v('title'); if (!title) return toast('Write a task first');
    const date = v('date') || today, repeat = v('repeat'), base = { title, time: v('time'), est: +v('est') || 0, priority: v('priority') };
    if (repeat === 'once') {
      S.tasks.push({ id: uid(), ...base, date, done: false, createdAt: Date.now() });
      if (date !== today) toast(`Added for ${relDay(date)}`);
    } else {
      const until = v('until');
      if (until && until < date) return toast('End date is before the start date');
      const days = [...f.querySelectorAll('.wdays .pri')].map(b => +b.dataset.i);
      const s = { id: uid(), ...base, start: date, repeat, days: repeat === 'weekly' ? (days.length ? days : [D(date).getDay()]) : [], until };
      S.schedules.push(s);
      rollover();
      toast(`Repeats ${repeatLabel(s)}`);
    }
    return true;
  },
  addHabit: f => { const name = f.elements.name.value.trim(); if (name) S.habits.push({ id: uid(), name, log: {} }); return true; },
  addBlock: f => { const b = f.elements.block.value.trim().toLowerCase(); if (b && !S.settings.blocklist.includes(b)) S.settings.blocklist.push(b); return true; }
};

document.addEventListener('click', async e => {
  const nav = e.target.closest('.nav a');
  if (nav) { view = nav.dataset.view; return render(); }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  e.preventDefault();
  if ((await actions[el.dataset.act]?.(el.dataset, el)) === 'cancel') return;
  save();
  if (!NO_RENDER.includes(el.dataset.act)) {
    await render();
    if (el.dataset.act === 'togglePlanner' && planner.open) $('#dump')?.focus();
  }
});

// Show/hide "until" and weekday pickers based on the repeat choice
document.addEventListener('change', e => {
  if (e.target.name !== 'repeat') return;
  const f = e.target.form, r = e.target.value;
  f.querySelector('.until').hidden = r === 'once';
  f.querySelector('.wdays').hidden = r !== 'weekly';
});

document.addEventListener('submit', async e => {
  const name = e.target.dataset.form; if (!name) return;
  e.preventDefault();
  const ok = forms[name](e.target);
  if (!ok) return;
  save(); await render();
  $(`[data-form="${name}"] input`)?.focus();
});

$('#themeBtn').addEventListener('click', () => { S.settings.theme = S.settings.theme === 'light' ? 'dark' : 'light'; applyTheme(); save(); });
function applyTheme() {
  const light = S.settings.theme === 'light';
  $('#root').classList.toggle('light', light);
  document.body.style.background = light ? '#f4f4f2' : '#0a0a0a';
  $('#themeBtn span').textContent = light ? 'Dark mode' : 'Light mode';
}

// Keyboard: N = new task, 1-7 = switch views
const ORDER = ['dashboard', 'today', 'schedule', 'habits', 'focus', 'activity', 'settings'];
document.addEventListener('keydown', e => {
  if (e.target.matches('input,textarea,select')) return;
  if (e.key === 'n') { e.preventDefault(); quickAdd(); }
  if (/^[1-7]$/.test(e.key)) { view = ORDER[+e.key - 1]; render(); }
});
async function quickAdd() { view = 'today'; await render(); $('[data-form="addTask"] input[name=title]').focus(); }

// ---------- background checks (every 30s) ----------
function tick() {
  refreshGitHub();
  if (dayKey() !== today) { rollover(); render(); }
  const now = mins(nowHM());
  for (const t of tasksOn(today)) {
    const late = t.time ? now - mins(t.time) : -1;
    if (!t.done && late >= 0 && late <= 2 && !t.reminded) { t.reminded = true; bridge.notify('Task reminder', t.title); save(); }
  }
}

// ---------- boot ----------
(async () => {
  const loaded = await bridge.load();
  migrate(loaded);
  S = { ...structuredClone(DEFAULTS), ...(loaded || {}) };
  S.settings = { ...DEFAULTS.settings, ...(loaded?.settings || {}) };
  delete S.settings.reviewTime;
  applyTheme();
  rollover();
  F.left = S.settings.focusMin * 60;
  bridge.on('quick-add', quickAdd);
  bridge.on('car-changed', on => { S.settings.desktopCar = on; save(); if (view === 'settings') render(); });
  window.addEventListener('focus', () => { if (S.gh && Date.now() - S.gh.fetchedAt > 2 * 60000) refreshGitHub(true); });
  bridge.on('distraction', hit => toast(`Focus: "${hit}" detected`));
  bridge.on('focus-stop', () => { if (F.running) focusToggle(); toast('Focus session paused'); if (view === 'focus') render(); });
  await render();
  setInterval(tick, 30000); tick();
})();
