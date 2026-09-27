# After Hours 🌙

A phone-first task manager for evening work: the fashion brand, fashion projects, the startup and side projects, all fitted around a 9–5.

**Live app:** https://smritis17.github.io/after-hours/

## Install on your phone
- **iPhone:** open the link in Safari → Share → *Add to Home Screen*
- **Android:** open in Chrome → ⋮ menu → *Add to Home screen* / *Install app*

It opens full-screen like a native app and works offline.

## How it works
| Tab | What it's for |
|---|---|
| **Tonight** | Opens to tonight's plan (with your Apple Calendar events), follow-ups due, Top 3, a focus timer and what's next. A *Low energy tonight* toggle shows only light/admin tasks. |
| **Projects** | Each area has its own stages. The startup goes Prototype → Mentor feedback → Trial planning → Trials → Regulatory → Launch. Tap an area for a scrolling list (what's left per project) or a board. Each area also has a **People** tracker for mentors and contacts, with follow-up dates. |
| **Ideas** | One-tap capture for any idea, with an optional link. Sort ideas into an area, star them, or turn them into a project or task. |
| **Week** | Evening time blocks (6–10pm by default) alongside your Apple Calendar. Mark days **Away**; trips are detected automatically. *Plan evenings* suggests whole nights per area from your weekly hour targets and skips busy or away evenings. |
| **Review** | A 10-minute Sunday check-in (or Monday if you're away on Sunday): hours vs. target, wins, stalled projects, follow-ups, reflection, then plan next week. |

## Apple Calendar sync
Settings → Apple Calendar connects both ways through a small Cloudflare Worker (`sync-worker/`):
- **After Hours → Apple Calendar:** subscribe once, and your blocks, Sunday review and follow-ups show up with alerts. That's how you get reminders on your phone.
- **Apple Calendar → After Hours:** paste a calendar's public share link, and events show in the app, trips mark you away, and the planner keeps busy evenings free.

Settings (gear icon): evening/work hours, areas, colors, weekly hour targets, stages, backup/restore.

## Your data
Everything is stored **only on your device** (browser local storage). Nothing is sent anywhere.
Use **Settings → Export backup** now and then, and **Import backup** to restore or move to a new phone.

## Tech
Plain HTML/CSS/JS with no build step. It's a PWA with a service worker for offline use, hosted on GitHub Pages.
