# DAYLOG

A personal desktop app for planning, tracking and reviewing your day. Built with Electron, styled after [ashweak.github.io](https://ashweak.github.io).

## Features
- **Today** — tasks with optional reminder time and priority, progress bar, auto carry-over of unfinished tasks
- **Recurring tasks** — daily / weekdays / weekends / a specific weekday, auto-added each matching day
- **AI day planner** — brain dump → ordered task list (Gemini)
- **Habits** — 14-day grid, current and best streaks
- **Focus** — Pomodoro timer plus alerts when a distracting app or site is in the foreground
- **Activity** — tracks which app is active in the background (idle time excluded)
- **Review** — end-of-day summary, move leftovers to tomorrow, reflection notes, AI summary
- **Insights** — 7-day completion, focus sessions, distraction %, top apps, habit consistency
- **Timeline** — drag tasks onto an hour grid; your class schedule shows as fixed blocks
- **Estimates & overload warning** — warns when planned work exceeds the free time left today
- **Day templates** — save/load task sets like "School day" or "Exam week"
- **Deadlines** — countdowns in the sidebar
- **Mood journal** — daily mood + one-liner, shown in Insights
- **GitHub** — your contribution graph, commit streak, today/this-week counts and recent pushes (Settings: username + classic token with `read:user`)
- **Progress** — a year heatmap of your DAYLOG activity, and a downloadable weekly stats card
- **Focus music** — opens your Spotify/YouTube link when a focus session starts
- Tray icon, global quick-add hotkey (`Ctrl+Shift+Space`), task and review reminders, dark/light theme
- All data is local (`%APPDATA%/daylog/data.json` and `activity.json`)

## Run
```bash
npm install
npm start
```
Build a Windows installer: `npm run dist` (output in `dist/`).

AI features: paste a free Gemini API key from https://aistudio.google.com into **Settings**.

## Shortcuts
`Ctrl+Shift+Space` quick add (global) · `N` new task · `1`–`9` switch views

## Stack
Electron · vanilla JS · `get-windows` (active-window tracking) · Gemini API · GitHub GraphQL/REST API
