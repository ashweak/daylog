// DAYLOG — main process: window, tray, hotkey, storage, activity tracking, AI calls.
const { app, shell, dialog, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, Notification, powerMonitor, nativeImage } = require('electron');
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
// Windows: a small PowerShell helper reports the foreground window every 5s (no native modules needed).
const { spawn } = require('child_process');
let fg = null, tracker = null, trackerFails = 0;
const PS_TRACKER = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class DaylogWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
$names = @{}
while ($true) {
  $h = [DaylogWin]::GetForegroundWindow(); $procId = 0
  [void][DaylogWin]::GetWindowThreadProcessId($h, [ref]$procId)
  $sb = New-Object System.Text.StringBuilder 512; [void][DaylogWin]::GetWindowText($h, $sb, 512)
  if (-not $names.ContainsKey($procId)) {
    $n = ''
    try { $p = Get-Process -Id $procId; $n = $p.MainModule.FileVersionInfo.FileDescription; if (-not $n) { $n = $p.ProcessName } } catch { try { $n = (Get-Process -Id $procId).ProcessName } catch {} }
    $names[$procId] = $n
  }
  [Console]::Out.WriteLine((@{ name = $names[$procId]; title = $sb.ToString() } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  Start-Sleep -Seconds 5
}`;
function startTracker() {
  if (process.platform !== 'win32' || tracker) return;
  const encoded = Buffer.from(PS_TRACKER, 'utf16le').toString('base64');
  tracker = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
  let buf = '';
  tracker.stdout.on('data', d => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      try { const j = JSON.parse(line); fg = { name: j.name || 'Unknown', title: j.title || '', at: Date.now() }; trackerFails = 0; } catch {}
    }
  });
  tracker.on('exit', () => {
    tracker = null;
    if (!quitting && trackerFails++ < 5) setTimeout(startTracker, 5000 * trackerFails);
  });
}
async function activeWindow() {
  if (!fg || Date.now() - fg.at > 15000) return null;
  return { owner: { name: fg.name }, title: fg.title };
}
async function loadTracker() { startTracker(); }

async function pollActivity() {
  const data = readJSON(DATA_FILE, {});
  const s = data.settings || {};
  if (s.trackActivity === false) return;
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

function updateTrayMenu() {
  tray && tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open DAYLOG', click: () => showWindow() },
    { label: 'Quick add task', click: () => showWindow('quick-add') },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  ]));
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
// Parses https://github.com/users/<user>/contributions (the public graph HTML)
function parseContribPage(html) {
  const attr = (tag, name) => (tag.match(new RegExp(`\\s${name}="([^"]*)"`)) || [])[1];
  const tips = {};
  for (const m of html.matchAll(/<tool-tip\b([^>]*)>([\s\S]*?)<\/tool-tip>/g)) {
    const f = attr(m[1], 'for'); if (!f) continue;
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    tips[f] = /^no contributions/i.test(text) ? 0 : parseInt(text.replace(/,/g, ''), 10) || 0;
  }
  const calendar = {}, levels = {};
  for (const m of html.matchAll(/<td\b[^>]*ContributionCalendar-day[^>]*>/g)) {
    const date = attr(m[0], 'data-date'); if (!date) continue;
    const lvl = +attr(m[0], 'data-level') || 0, id = attr(m[0], 'id');
    levels[date] = lvl;
    calendar[date] = id in tips ? tips[id] : (+attr(m[0], 'data-count') || (lvl ? 1 : 0));
  }
  if (!Object.keys(calendar).length) throw new Error('Could not read the GitHub contribution graph');
  const tm = html.replace(/<[^>]+>/g, ' ').match(/([\d,]+)\s+contributions?\s+in\s+the\s+last\s+year/i);
  const total = tm ? +tm[1].replace(/,/g, '') : Object.values(calendar).reduce((a, b) => a + b, 0);
  return { calendar, levels, total };
}

async function fetchGitHub(user, token) {
  if (!user) throw new Error('Set your GitHub username in Settings.');
  const headers = { 'User-Agent': 'daylog', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const out = { calendar: null, levels: null, total: null, events: [] };

  // Contribution calendar: GraphQL with a token, otherwise the public profile graph (no token needed)
  if (token) {
    const query = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{totalContributions weeks{contributionDays{date contributionCount contributionLevel}}}}}}`;
    const r = await fetch('https://api.github.com/graphql', { method: 'POST', headers, body: JSON.stringify({ query, variables: { login: user } }) });
    const j = await r.json();
    if (!r.ok || j.errors) throw new Error(j.errors?.[0]?.message || j.message || `GitHub error ${r.status}`);
    const cal = j.data.user.contributionsCollection.contributionCalendar;
    const LV = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };
    out.total = cal.totalContributions; out.calendar = {}; out.levels = {};
    for (const w of cal.weeks) for (const d of w.contributionDays) { out.calendar[d.date] = d.contributionCount; out.levels[d.date] = LV[d.contributionLevel] ?? 0; }
  } else {
    const r = await fetch(`https://github.com/users/${encodeURIComponent(user)}/contributions`, { headers: { 'User-Agent': 'Mozilla/5.0 daylog' } });
    if (!r.ok) throw new Error(r.status === 404 ? `GitHub user "${user}" not found` : `GitHub error ${r.status}`);
    Object.assign(out, parseContribPage(await r.text()));
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

// Public repos for the Projects tab
async function fetchRepos(user, token) {
  const headers = { 'User-Agent': 'daylog', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = token ? 'https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner'
                    : `https://api.github.com/users/${encodeURIComponent(user)}/repos?per_page=100&sort=pushed`;
  const r = await fetch(url, { headers });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || `GitHub error ${r.status}`);
  return j.filter(x => !x.fork).map(x => ({
    full: x.full_name, name: x.name, desc: x.description || '', lang: x.language || '', pushed: x.pushed_at,
    issues: x.open_issues_count, stars: x.stargazers_count, homepage: x.homepage || '', url: x.html_url, archived: x.archived, private: x.private
  }));
}
// Latest GitHub Actions run (CI / Pages deploy) for a repo
async function fetchDeploy(full, token) {
  const headers = { 'User-Agent': 'daylog', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`https://api.github.com/repos/${full}/actions/runs?per_page=1`, { headers });
  if (!r.ok) return { none: true, code: r.status };
  const run = (await r.json()).workflow_runs?.[0];
  if (!run) return { none: true };
  return { name: run.name, status: run.status, conclusion: run.conclusion, at: run.updated_at, url: run.html_url, branch: run.head_branch };
}

// ---------- backups ----------
const BACKUP_KEEP = 14;
function defaultBackupDir() { return fs.existsSync('D:\\') ? 'D:\\DAYLOG Backups' : path.join(app.getPath('documents'), 'DAYLOG Backups'); }
function backupDir() { return (readJSON(DATA_FILE, {}).settings || {}).backupDir || defaultBackupDir(); }
function runBackup(force) {
  const dir = backupDir(), stamp = new Date().toISOString().slice(0, 10);
  const target = path.join(dir, `daylog-${stamp}.json`);
  if (!force && fs.existsSync(target)) return { ok: true, skipped: true, path: target };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const data = readJSON(DATA_FILE, {});
    if (data.settings) data.settings = { ...data.settings, apiKey: '', ghToken: '' };
    writeJSON(target, { exportedAt: new Date().toISOString(), data, activity });
    const old = fs.readdirSync(dir).filter(f => /^daylog-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(0, -BACKUP_KEEP);
    old.forEach(f => fs.unlinkSync(path.join(dir, f)));
    return { ok: true, path: target, at: Date.now() };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Is a live site up? (status + response time)
async function checkSite(url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'daylog-status' } });
    return { up: r.status < 500, code: r.status, ms: Date.now() - t0, at: Date.now() };
  } catch (e) { return { up: false, code: 0, ms: Date.now() - t0, at: Date.now(), error: e.name === 'TimeoutError' ? 'timeout' : 'unreachable' }; }
}

// ---------- window / tray ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1120, height: 760, minWidth: 760, minHeight: 520,
    backgroundColor: '#0a0a0a',
    title: 'DAYLOG',
    show: false,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden') && !app.getLoginItemSettings().wasOpenedAsHidden) win.show(); });
  // Links with target=_blank open in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
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
  updateTrayMenu();
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
ipcMain.handle('github:repos', async (_e, user, token) => {
  try { return { ok: true, data: await fetchRepos(user, token) }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('site:check', (_e, url) => /^https?:\/\//i.test(url) ? checkSite(url) : { up: false, code: 0, error: 'bad url' });
ipcMain.handle('github:deploy', async (_e, full, token) => { try { return await fetchDeploy(full, token); } catch { return { none: true }; } });
ipcMain.handle('login:get', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('login:set', (_e, on) => { app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] }); return app.getLoginItemSettings().openAtLogin; });
ipcMain.handle('backup:run', () => runBackup(true));
ipcMain.handle('backup:info', () => {
  const dir = backupDir();
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.startsWith('daylog-')).sort(); } catch {}
  return { dir, count: files.length, last: files.at(-1) || null };
});
ipcMain.handle('backup:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose backup folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('backup:open', () => { const d = backupDir(); fs.mkdirSync(d, { recursive: true }); shell.openPath(d); return true; });
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
  setTimeout(() => runBackup(false), 15000);
  setInterval(() => runBackup(false), 3 * 3600000);
});

app.on('before-quit', () => { quitting = true; writeJSON(ACT_FILE, activity); if (tracker) tracker.kill(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', e => e.preventDefault());

if (process.env.DAYLOG_TEST) module.exports = { parseContribPage };
