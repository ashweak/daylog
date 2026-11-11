# DAYLOG

A personal desktop app for planning, tracking and reviewing your day. Built with Electron, styled after [ashweak.github.io](https://ashweak.github.io).

## Features
- **Dashboard**: today's progress, due today, overdue, the next 14 days, this week's completion, habits, top apps and GitHub contributions in one place
- **GitHub graph**: your contribution graph (GitHub style), fits the window (full year on wide screens, fewer months on small ones), auto-refreshed every 10 minutes. Needs only your username; a token is optional (adds private contributions)
- **Scheduling**: add a task for any date, or repeat it every day, on weekdays, weekly (pick days), monthly or yearly, with an optional end date
- **Projects**: every GitHub repo is imported automatically with last push, language, open issues and a live-site up/down check; set a status (planning → live → done) and link tasks so progress fills in by itself
- **Notes**: searchable notes with autosave, pinning and project links
- **Deploy status**: latest GitHub Actions / Pages run on each project (passed, failed, running)
- **Start with Windows**: optional, opens quietly in the tray
- **Auto backup**: daily copy of your data (last 14 kept) to a folder you choose
- **Schedule calendar**: month view of every task and repeat, click a day to see or add tasks
- **Today**: task list with reminder time, estimate, priority, overload warning, carry-over of unfinished tasks, AI day planner (Gemini)
- **Habits**: 14-day grid with streaks
- **Focus**: Pomodoro; opening a blocked app shows an always-on-top warning window; optional focus music link
- **Confirm on complete**: a dialog asks before a task is marked done
- **Activity**: tracks which app is active (idle excluded)
- Tray icon, global quick add (`Ctrl+Shift+Space`), task reminders, dark/light theme
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
