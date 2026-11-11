// DAYLOG — main process: window, tray, hotkey, storage, activity tracking, AI calls.
const { app, shell, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, Notification, powerMonitor, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const DATA_DIR = app.getPath('userData');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const ACT_FILE = path.join(DATA_DIR, 'activity.json');
const POLL_MS = 5000;
const IDLE_SECONDS = 120;

let win, tray, quitting = false;
let focusActive = false, lastNudge = 0, warnWin = null;

// ---------- storage ----------
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}
const dayKey = (d = new Date()) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

let activity = readJSON(ACT_FILE, {}); // { 'YYYY-MM-DD': { apps: { name: seconds }, idle: seconds } }

// ---------- activity tracking ----------
let activeWindow = null;
async function loadTracker() {
  try { ({ activeWindow } = await import('get-windows')); }
  catch (e) { console.warn('Activity tracking unavailable:', e.message); }
}

async function pollActivity() {
  const data = readJSON(DATA_FILE, {});
  const s = data.settings || {};
  if (s.trackActivity === false || !activeWindow) return;
  const day = (activity[dayKey()] ||= { apps: {}, idle: 0 });
  const secs = POLL_MS / 1000;
  if (powerMonitor.getSystemIdleTime() >= IDLE_SECONDS) { day.idle += secs; return; }
  let w;
  try { w = await activeWindow(); } catch { return; }
  if (!w) return;
  const name = (w.owner && w.owner.name || 'Unknown').replace(/\.exe$/i, '');
  day.apps[name] = (day.apps[name] || 0) + secs;

  // Focus mode distraction nudge
  if (focusActive) {
    const hay = `${name} ${w.title || ''}`.toLowerCase();
    const hit = (s.blocklist || []).find(b => b && hay.includes(b.toLowerCase()));
    if (hit && !(warnWin && warnWin.isVisible()) && Date.now() - lastNudge > 30000) {
      lastNudge = Date.now();
      showWarning(hit, name, s.theme === 'light');
      win && win.webContents.send('distraction', hit);
    }
  }
}

// ---------- focus warning overlay ----------
function showWarning(hit, appName, light) {
  if (!warnWin || warnWin.isDestroyed()) {
    warnWin = new BrowserWindow({
      width: 480, height: 300, frame: false, resizable: false, minimizable: false, maximizable: false,
      skipTaskbar: true, alwaysOnTop: true, show: false, backgroundColor: light ? '#f4f4f2' : '#0a0a0a',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    warnWin.setAlwaysOnTop(true, 'screen-saver');
    warnWin.on('closed', () => { warnWin = null; });
  }
  warnWin.loadFile(path.join(__dirname, 'renderer', 'warning.html'), { query: { hit, app: appName, light: light ? '1' : '' } });
  warnWin.once('ready-to-show', () => { warnWin.center(); warnWin.show(); warnWin.focus(); });
}

// ---------- AI (Gemini) ----------
async function askGemini(prompt) {
  const s = readJSON(DATA_FILE, {}).settings || {};
  if (!s.apiKey) throw new Error('Add your Gemini API key in Settings first.');
  const model = s.model || 'gemini-2.5-flash';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.4 }
    })
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `AI request failed (${res.status})`);
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '{}';
  return JSON.parse(text);
}

// ---------- GitHub ----------
async function fetchGitHub(user, token) {
  if (!user) throw new Error('Set your GitHub username in Settings.');
  const headers = { 'User-Agent': 'daylog', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const out = { calendar: null, total: null, events: [] };

  // Contribution calendar (GraphQL needs a token)
  if (token) {
    const query = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}}}`;
    const r = await fetch('https://api.github.com/graphql', { method: 'POST', headers, body: JSON.stringify({ query, variables: { login: user } }) });
    const j = await r.json();
    if (!r.ok || j.errors) throw new Error(j.errors?.[0]?.message || j.message || `GitHub error ${r.status}`);
    const cal = j.data.user.contributionsCollection.contributionCalendar;
    out.total = cal.totalContributions;
    out.calendar = {};
    for (const w of cal.weeks) for (const d of w.contributionDays) out.calendar[d.date] = d.contributionCount;
  }

  // Recent public pushes (works without a token, 60 req/hour)
  const r = await fetch(`https://api.github.com/users/${encodeURIComponent(user)}/events/public?per_page=50`, { headers });
  if (r.ok) {
    const ev = await r.json();
    out.events = ev.filter(e => ['PushEvent', 'CreateEvent', 'PullRequestEvent'].includes(e.type)).slice(0, 12).map(e => ({
      type: e.type, repo: e.repo?.name || '', at: e.created_at,
      commits: e.payload?.size ?? e.payload?.distinct_size ?? e.payload?.commits?.length ?? null,
      msg: e.payload?.commits?.at?.(-1)?.message?.split('\n')[0] || e.payload?.pull_request?.title || (e.payload?.ref_type ? `created ${e.payload.ref_type} ${e.payload.ref || ''}`.trim() : '')
    }));
  } else if (!token) {
    throw new Error(`GitHub error ${r.status}${r.status === 403 ? ' (rate limit — add a token)' : ''}`);
  }
  return out;
}

// ---------- window / tray ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1120, height: 760, minWidth: 760, minHeight: 520,
    backgroundColor: '#0a0a0a',
    title: 'DAYLOG',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
}

function showWindow(action) {
  if (!win) return;
  win.show(); win.focus();
  if (action) win.webContents.send(action);
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'));
  tray = new Tray(img);
  tray.setToolTip('DAYLOG');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open DAYLOG', click: () => showWindow() },
    { label: 'Quick add task', click: () => showWindow('quick-add') },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', () => showWindow());
}

// ---------- IPC ----------
ipcMain.handle('data:load', () => readJSON(DATA_FILE, null));
ipcMain.handle('data:save', (_e, data) => { writeJSON(DATA_FILE, data); return true; });
ipcMain.handle('activity:range', (_e, keys) => Object.fromEntries(keys.map(k => [k, activity[k] || { apps: {}, idle: 0 }])));
ipcMain.handle('focus:set', (_e, on) => { focusActive = !!on; return focusActive; });
ipcMain.handle('warn:action', (_e, action) => {
  if (warnWin && !warnWin.isDestroyed()) warnWin.hide();
  lastNudge = Date.now();
  if (action === 'stop' && win) win.webContents.send('focus-stop');
  return true;
});
ipcMain.handle('notify', (_e, title, body) => { new Notification({ title, body }).show(); return true; });
ipcMain.handle('open:external', (_e, url) => {
  if (/^(https:|spotify:)/i.test(url)) shell.openExternal(url);
  return true;
});
ipcMain.handle('github:fetch', async (_e, user, token) => {
  try { return { ok: true, data: await fetchGitHub(user, token) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('ai:ask', async (_e, prompt) => {
  try { return { ok: true, data: await askGemini(prompt) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ---------- lifecycle ----------
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

app.whenReady().then(async () => {
  app.setAppUserModelId('com.lanceagua.daylog');
  createWindow();
  createTray();
  globalShortcut.register('CommandOrControl+Shift+Space', () => showWindow('quick-add'));
  await loadTracker();
  setInterval(pollActivity, POLL_MS);
  setInterval(() => writeJSON(ACT_FILE, activity), 30000);
});

app.on('before-quit', () => { quitting = true; writeJSON(ACT_FILE, activity); });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', e => e.preventDefault());
