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
| **Tonight** | Opens to tonight's plan, your Top 3, a focus timer and the next tasks for tonight's area. |
| **Projects** | Each area has its own stage pipeline (e.g. Concept → Sketch → Sourcing → Pattern → Sample). Tap an area for a swipeable board. |
| **Week** | Evening time blocks (6–10pm by default). *Plan evenings* suggests whole nights per area based on your weekly hour targets. Export to Google/Apple Calendar. |
| **Review** | A 10-minute Sunday check-in: hours logged vs. target, wins, stalled projects, reflection, then plan next week. |

Settings (gear icon): evening/work hours, areas, colors, weekly hour targets, stages, backup/restore.

## Your data
Everything is stored **only on your device** (browser local storage). Nothing is sent anywhere.
Use **Settings → Export backup** now and then, and **Import backup** to restore or move to a new phone.

## Tech
Plain HTML/CSS/JS with no build step. It's a PWA with a service worker for offline use, hosted on GitHub Pages.
