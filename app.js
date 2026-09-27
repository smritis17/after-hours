'use strict';

/* ---------- Utilities ---------- */
const KEY = 'afterhours.v1';
const $ = (s, r = document) => r.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const dkey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const weekStart = d => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return addDays(x, -((x.getDay() + 6) % 7)); };
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtTime(t) {
  let [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return m ? `${h}:${pad(m)}${ap}` : `${h}${ap}`;
}
function fmtDur(min) {
  min = Math.round(min);
  const h = Math.floor(min / 60), m = min % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}
function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}
function fmtDay(k) {
  const today = dkey(new Date());
  if (k === today) return 'Today';
  if (k === dkey(addDays(new Date(), 1))) return 'Tomorrow';
  if (k === dkey(addDays(new Date(), -1))) return 'Yesterday';
  const d = parseKey(k);
  return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
}
const fmtRange = ws => { const we = addDays(ws, 6); return `${MON[ws.getMonth()]} ${ws.getDate()} – ${ws.getMonth() === we.getMonth() ? '' : MON[we.getMonth()] + ' '}${we.getDate()}`; };

const ICON = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
};

/* ---------- State ---------- */
function defaultState() {
  return {
    version: 1,
    settings: { eveningStart: '18:00', eveningEnd: '22:00', workStart: '09:00', workEnd: '17:00', workDays: [1, 2, 3, 4, 5] },
    areas: [
      { id: 'brand', name: 'Fashion Brand', color: '#f29fc5', target: 6, stages: ['Vision', 'Identity', 'Collection', 'Sourcing', 'Sampling', 'Production', 'Launch'] },
      { id: 'fashion', name: 'Fashion Projects', color: '#c9a7ff', target: 4, stages: ['Concept', 'Sketch', 'Sourcing', 'Pattern', 'Sample', 'Finishing', 'Done'] },
      { id: 'startup', name: 'Startup', color: '#7cc4ff', target: 8, stages: ['Idea', 'Validate', 'Build', 'Launch', 'Grow'] },
      { id: 'side', name: 'Side Projects', color: '#8fe0b0', target: 2, stages: ['Someday', 'Next up', 'In progress', 'Paused', 'Done'] },
    ],
    projects: [], tasks: [], blocks: [], sessions: [], top3: {}, reviews: {}, timer: null,
  };
}
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw), def = defaultState();
      return { ...def, ...d, settings: { ...def.settings, ...(d.settings || {}) } };
    }
  } catch (e) { /* fall through to defaults */ }
  return defaultState();
}
let S = load();
const UI = { view: 'tonight', area: 'all', weekOffset: 0, reviewOffset: 0, sheetRefresh: null };

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch (e) { toast('Could not save. Export a backup from Settings.'); }
}
function commit() { save(); render(); }

const area = id => S.areas.find(a => a.id === id);
const project = id => S.projects.find(p => p.id === id);
const task = id => S.tasks.find(t => t.id === id);
const blockMin = b => toMin(b.end) - toMin(b.start);
const eveningMin = () => toMin(S.settings.eveningEnd) - toMin(S.settings.eveningStart);
const isWorkDay = d => S.settings.workDays.includes(d.getDay());
const touchProject = id => { const p = project(id); if (p) p.updated = Date.now(); };

function minutesByArea(ws) {
  const s = ws.getTime(), e = addDays(ws, 7).getTime(), m = {};
  S.sessions.forEach(x => { if (x.start >= s && x.start < e) m[x.areaId] = (m[x.areaId] || 0) + x.min; });
  return m;
}
function plannedByArea(ws) {
  const s = dkey(ws), e = dkey(addDays(ws, 7)), m = {};
  S.blocks.forEach(b => { if (b.date >= s && b.date < e) m[b.areaId] = (m[b.areaId] || 0) + blockMin(b); });
  return m;
}
const PRI = { high: 0, normal: 1, low: 2 };
function taskSort(a, b) {
  const today = dkey(new Date());
  const ao = a.due && a.due < today ? 0 : 1, bo = b.due && b.due < today ? 0 : 1;
  return ao - bo || PRI[a.priority || 'normal'] - PRI[b.priority || 'normal'] ||
    (a.due || '9999').localeCompare(b.due || '9999') || a.created - b.created;
}
const openTasks = () => S.tasks.filter(t => !t.done);
function lastActivity(p) {
  let t = p.updated || p.created || 0;
  S.tasks.forEach(x => { if (x.projectId === p.id) t = Math.max(t, x.doneAt || 0, x.created || 0); });
  S.sessions.forEach(x => { if (x.projectId === p.id) t = Math.max(t, x.end); });
  return t;
}
const isFinalStage = p => { const a = area(p.areaId); return a && a.stages.indexOf(p.stage) === a.stages.length - 1; };

/* ---------- Components ---------- */
function taskRow(t, { showProject = true, num } = {}) {
  const p = project(t.projectId), a = area(t.areaId), today = dkey(new Date());
  const running = S.timer && S.timer.taskId === t.id;
  const bits = [esc(showProject && p ? p.name : (a ? a.name : ''))];
  if (t.est) bits.push(fmtDur(t.est));
  if (t.due) bits.push(`<span class="${!t.done && t.due < today ? 'overdue' : ''}">${fmtDay(t.due)}</span>`);
  return `<div class="task ${t.done ? 'done' : ''}">
    ${num ? `<span class="num">${num}</span>` : ''}
    <button class="check" data-a="toggle-task" data-id="${t.id}" aria-label="Mark done">${t.done ? ICON.check : ''}</button>
    <button class="task-main" data-a="edit-task" data-id="${t.id}">
      <span class="task-title">${t.priority === 'high' ? '<span class="pri">!</span>' : ''}${esc(t.title)}</span>
      <span class="meta"><i class="dot" style="background:${a ? a.color : '#888'}"></i>${bits.join(' · ')}</span>
    </button>
    ${t.done ? '' : `<button class="play ${running ? 'on' : ''}" data-a="${running ? 'stop-timer' : 'start-timer'}" data-id="${t.id}" aria-label="${running ? 'Stop timer' : 'Start focus timer'}">${running ? ICON.stop : ICON.play}</button>`}
  </div>`;
}

function blockCard(b) {
  const a = area(b.areaId), p = project(b.projectId);
  const sub = [a && a.name, p && b.title ? p.name : ''].filter(Boolean).join(' · ');
  return `<button class="block" data-a="edit-block" data-id="${b.id}" style="--c:${a ? a.color : '#888'}">
    <span class="block-time">${fmtTime(b.start)} – ${fmtTime(b.end)}</span>
    <span class="block-title">${esc(b.title || (p && p.name) || (a && a.name) || 'Block')}</span>
    ${sub && sub !== (b.title || (p && p.name) || (a && a.name)) ? `<span class="block-sub">${esc(sub)}</span>` : ''}
  </button>`;
}

function projectCard(p) {
  const a = area(p.areaId) || S.areas[0];
  const ts = S.tasks.filter(t => t.projectId === p.id);
  const done = ts.filter(t => t.done).length;
  const next = ts.filter(t => !t.done).sort(taskSort)[0];
  const si = Math.max(0, a.stages.indexOf(p.stage));
  const meta = [ts.length ? `${done}/${ts.length} tasks` : 'No tasks yet'];
  if (next) meta.push(`Next: ${esc(next.title)}`);
  if (p.due) meta.push(`Target ${fmtDay(p.due)}`);
  return `<button class="proj" data-a="open-project" data-id="${p.id}" style="--c:${a.color}">
    <div class="proj-top"><span class="proj-name">${esc(p.name)}</span><span class="stage">${esc(a.stages[si] || '')}</span></div>
    <div class="pipe">${a.stages.map((s, i) => `<i class="${i <= si ? 'on' : ''}"></i>`).join('')}</div>
    <div class="meta">${meta.join(' · ')}</div>
  </button>`;
}

function timerCard() {
  if (S.timer) {
    const t = task(S.timer.taskId), a = area(S.timer.areaId), p = project(S.timer.projectId);
    return `<div class="card timer on" style="--c:${a ? a.color : 'var(--accent)'}">
      <div><div class="eyebrow">Focusing on</div>
        <div class="timer-title">${esc((t && t.title) || (p && p.name) || (a && a.name) || 'Focus')}</div>
        <div class="meta">${esc([a && a.name, t && p ? p.name : ''].filter(Boolean).join(' · '))}</div></div>
      <div class="timer-right"><div class="elapsed" data-elapsed>${fmtClock(Date.now() - S.timer.start)}</div>
        <button class="btn small" data-a="stop-timer">Stop &amp; log</button></div>
    </div>`;
  }
  return `<div class="card timer">
    <div><div class="timer-title">Focus timer</div><div class="meta">Logs your hours to each area</div></div>
    <div class="row gap"><button class="btn ghost small" data-a="log-time">Log time</button><button class="btn small" data-a="pick-focus">Start</button></div>
  </div>`;
}

function areaOptions(sel, { withProjects = false, blank = '' } = {}) {
  let h = blank ? `<option value="">${blank}</option>` : '';
  S.areas.forEach(a => {
    if (!withProjects) { h += `<option value="${a.id}" ${sel === a.id ? 'selected' : ''}>${esc(a.name)}</option>`; return; }
    h += `<optgroup label="${esc(a.name)}"><option value="area:${a.id}" ${sel === 'area:' + a.id ? 'selected' : ''}>${esc(a.name)}: general</option>`;
    S.projects.filter(p => p.areaId === a.id).forEach(p => {
      h += `<option value="proj:${p.id}" ${sel === 'proj:' + p.id ? 'selected' : ''}>${esc(p.name)}</option>`;
    });
    h += '</optgroup>';
  });
  return h;
}
function parseTarget(v) {
  if (v && v.startsWith('proj:')) { const p = project(v.slice(5)); if (p) return { areaId: p.areaId, projectId: p.id }; }
  return { areaId: v ? v.replace('area:', '') : S.areas[0].id, projectId: null };
}

function bar(a, logged, planned) {
  const t = Math.max((+a.target || 0) * 60, 1);
  return `<div class="bar-row">
    <div class="bar-label"><span><i class="dot" style="background:${a.color}"></i>${esc(a.name)}</span><span class="meta">${fmtDur(logged)} / ${a.target || 0}h</span></div>
    <div class="bar"><div class="bar-plan" style="width:${Math.min(100, planned / t * 100)}%;background:${a.color}"></div><div class="bar-fill" style="width:${Math.min(100, logged / t * 100)}%;background:${a.color}"></div></div>
  </div>`;
}

/* ---------- Views ---------- */
function viewTonight() {
  const now = new Date(), k = dkey(now), s = S.settings;
  const work = isWorkDay(now), nowMin = now.getHours() * 60 + now.getMinutes();
  const es = toMin(s.eveningStart), ee = toMin(s.eveningEnd);
  let sub;
  if (!work) sub = 'Weekend. Bonus time only, no pressure.';
  else if (nowMin < es) sub = `Your evening starts at ${fmtTime(s.eveningStart)}, ${fmtDur(es - nowMin)} from now`;
  else if (nowMin < ee) sub = `${fmtDur(ee - nowMin)} left tonight`;
  else sub = "Tonight's done. Rest up ✦";

  let h = `<p class="sub">${sub}</p>`;

  if (!S.projects.length && !S.tasks.length) {
    h += `<div class="card hero"><h2>Welcome to After Hours</h2>
      <p class="meta" style="margin-top:-6px">Built for 9–5 days and evening work.</p>
      <p><b>1.</b> Add your projects under your fashion brand, fashion projects, startup and side projects.<br>
      <b>2.</b> Plan your evenings: give each weeknight to an area.<br>
      <b>3.</b> Each evening, open <i>Tonight</i>, pick your top 3 and start the timer.</p>
      <div class="row gap"><button class="btn small" data-a="tab" data-v="projects">Add projects</button><button class="btn ghost small" data-a="plan" data-week="${dkey(weekStart(now))}">Plan evenings</button></div></div>`;
  }

  if (now.getDay() === 0 && !S.reviews[dkey(weekStart(now))]) {
    h += `<button class="banner" data-a="tab" data-v="review"><strong>It's Sunday: time for your 10-minute review →</strong><br><span class="meta">Look back at the week, then plan next week's evenings.</span></button>`;
  }

  h += timerCard();

  const blocks = S.blocks.filter(b => b.date === k).sort((a, b) => a.start.localeCompare(b.start));
  h += `<h3>${work ? "Tonight's plan" : "Today's plan"}</h3>`;
  if (blocks.length) h += blocks.map(blockCard).join('');
  else if (work) {
    h += `<div class="card"><div>Nothing's planned for tonight. Give the evening to:</div><div class="area-picks">${S.areas.map(a =>
      `<button class="chip" data-a="quick-block" data-area="${a.id}"><i class="dot" style="background:${a.color}"></i>${esc(a.name)}</button>`).join('')}</div></div>`;
  } else h += `<div class="empty small">No blocks. Enjoy your weekend, or <button class="link" data-a="new-block" data-date="${k}">add a bonus block</button>.</div>`;

  const top = (S.top3[k] || []).map(task).filter(Boolean);
  h += `<h3>Top 3</h3><div class="card top3">`;
  if (top.length) h += top.map((t, i) => taskRow(t, { num: i + 1 })).join('');
  else {
    const carry = carryOver();
    h += `<div class="empty small">What are the three things that would make tonight a win?</div>`;
    if (carry.length) h += `<button class="add-line" data-a="carry">↻ Carry over ${carry.length} unfinished from ${fmtDay(carry.key).toLowerCase()}</button><br>`;
  }
  if (top.length < 3) h += `<button class="add-line" data-a="pick-top3">+ Pick top 3</button>`;
  h += `</div>`;

  const blockAreas = new Set(blocks.map(b => b.areaId)), blockProjects = new Set(blocks.map(b => b.projectId).filter(Boolean));
  const topIds = new Set(S.top3[k] || []);
  const next = openTasks().filter(t => !topIds.has(t.id) && (!blockAreas.size || blockAreas.has(t.areaId)))
    .sort((a, b) => (blockProjects.has(b.projectId) - blockProjects.has(a.projectId)) || taskSort(a, b)).slice(0, 6);
  h += `<h3>Up next${blockAreas.size ? ' for tonight' : ''}</h3>`;
  h += next.length ? `<div class="card">${next.map(t => taskRow(t)).join('')}</div>`
    : `<div class="empty small">No open tasks here. Tap + to add one.</div>`;
  return h;
}

function carryOver() {
  const k = dkey(new Date());
  const prev = Object.keys(S.top3).filter(x => x < k).sort().pop();
  if (!prev) return [];
  const ids = S.top3[prev].filter(id => { const t = task(id); return t && !t.done; });
  ids.key = prev;
  return ids;
}

function chip(id, label, color) {
  return `<button class="chip ${UI.area === id ? 'on' : ''}" data-a="filter" data-id="${id}">${color ? `<i class="dot" style="background:${color}"></i>` : ''}${esc(label)}</button>`;
}

function viewProjects() {
  const logged = minutesByArea(weekStart(new Date()));
  if (UI.area !== 'all' && !area(UI.area)) UI.area = 'all';
  let h = `<div class="chips">${chip('all', 'All')}${S.areas.map(a => chip(a.id, a.name, a.color)).join('')}</div>`;

  if (UI.area === 'all') {
    h += S.areas.map(a => {
      const ps = S.projects.filter(p => p.areaId === a.id).sort((x, y) => a.stages.indexOf(x.stage) - a.stages.indexOf(y.stage));
      const loose = S.tasks.filter(t => t.areaId === a.id && !t.projectId && !t.done).length;
      return `<section class="area-sec">
        <div class="sec-head"><button class="sec-title" data-a="filter" data-id="${a.id}"><i class="dot" style="background:${a.color}"></i>${esc(a.name)} ›</button>
          <span class="meta">${fmtDur(logged[a.id] || 0)} / ${a.target || 0}h this week</span></div>
        ${ps.length ? ps.map(projectCard).join('') : '<div class="empty small">No projects yet</div>'}
        ${loose ? `<button class="meta" data-a="filter" data-id="${a.id}" style="padding:4px 2px">${loose} general task${loose > 1 ? 's' : ''} ›</button><br>` : ''}
        <button class="add-line" data-a="new-project" data-area="${a.id}">+ New project</button>
      </section>`;
    }).join('');
    return h;
  }

  const a = area(UI.area);
  h += `<div class="sec-head" style="margin-top:6px"><span class="meta">${fmtDur(logged[a.id] || 0)} of ${a.target || 0}h this week · swipe the stages →</span>
    <button class="add-line" style="padding:0" data-a="new-project" data-area="${a.id}">+ Project</button></div>`;
  h += `<div class="board">${a.stages.map((st, i) => {
    const ps = S.projects.filter(p => p.areaId === a.id && (p.stage === st || (i === 0 && !a.stages.includes(p.stage))));
    return `<div class="col"><div class="col-head">${esc(st)}<span>${ps.length}</span></div>${ps.map(projectCard).join('') || '<div class="empty small">·</div>'}</div>`;
  }).join('')}</div>`;
  const loose = S.tasks.filter(t => t.areaId === a.id && !t.projectId).sort((x, y) => x.done - y.done || taskSort(x, y));
  h += `<h3>General ${esc(a.name)} tasks</h3><div class="card">${loose.map(t => taskRow(t)).join('') || '<div class="empty small">None yet</div>'}
    <button class="add-line" data-a="new-task" data-area="${a.id}">+ Add task</button></div>`;
  return h;
}

function viewWeek() {
  const ws = addDays(weekStart(new Date()), UI.weekOffset * 7), today = dkey(new Date()), s = S.settings;
  const planned = plannedByArea(ws);
  let h = `<div class="weeknav"><button class="arrow" data-a="week" data-d="-1" aria-label="Previous week">‹</button>
    <div style="text-align:center"><strong>${fmtRange(ws)}</strong><div class="meta">${UI.weekOffset === 0 ? 'This week' : UI.weekOffset === 1 ? 'Next week' : UI.weekOffset === -1 ? 'Last week' : ''}</div></div>
    <button class="arrow" data-a="week" data-d="1" aria-label="Next week">›</button></div>`;
  h += `<div class="row gap"><button class="btn small" data-a="plan" data-week="${dkey(ws)}">Plan evenings</button>
    <button class="btn ghost small" data-a="ics-week" data-week="${dkey(ws)}">Export to calendar</button></div>`;
  h += `<div class="card">${S.areas.map(a => bar(a, planned[a.id] || 0, 0)).join('')}<div class="legend">Planned hours vs. weekly target</div></div>`;
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i), k = dkey(d), work = isWorkDay(d);
    const blocks = S.blocks.filter(b => b.date === k).sort((a, b) => a.start.localeCompare(b.start));
    h += `<div class="day ${k === today ? 'today' : ''} ${work ? '' : 'weekend'}">
      <div class="day-head"><span class="day-name">${DAYS[d.getDay()]} <span class="meta">${d.getDate()} ${MON[d.getMonth()]}</span></span>
        <button class="add-block" data-a="new-block" data-date="${k}" aria-label="Add block">+</button></div>
      ${work ? `<div class="work">Work ${fmtTime(s.workStart)}–${fmtTime(s.workEnd)}</div>` : ''}
      ${blocks.map(blockCard).join('')}
    </div>`;
  }
  return h;
}

function viewReview() {
  const ws = addDays(weekStart(new Date()), UI.reviewOffset * 7), wk = dkey(ws);
  const s0 = ws.getTime(), e0 = addDays(ws, 7).getTime();
  const logged = minutesByArea(ws), planned = plannedByArea(ws);
  const doneTasks = S.tasks.filter(t => t.doneAt >= s0 && t.doneAt < e0);
  const total = Object.values(logged).reduce((a, b) => a + b, 0);
  const evenings = new Set(S.sessions.filter(x => x.start >= s0 && x.start < e0).map(x => dkey(new Date(x.start)))).size;
  const r = S.reviews[wk] || {};
  const today = dkey(new Date());

  let h = `<div class="weeknav"><button class="arrow" data-a="rweek" data-d="-1" aria-label="Previous week">‹</button>
    <div style="text-align:center"><strong>${fmtRange(ws)}</strong><div class="meta">${UI.reviewOffset === 0 ? 'This week' : UI.reviewOffset === -1 ? 'Last week' : ''}</div></div>
    <button class="arrow" data-a="rweek" data-d="1" ${UI.reviewOffset >= 0 ? 'disabled style="opacity:.3"' : ''} aria-label="Next week">›</button></div>`;
  h += `<div class="stats"><div class="stat"><b>${doneTasks.length}</b><span>tasks done</span></div>
    <div class="stat"><b>${fmtDur(total)}</b><span>focused</span></div>
    <div class="stat"><b>${evenings}</b><span>days worked</span></div></div>`;

  h += `<h3>Time balance</h3><div class="card">${S.areas.map(a => bar(a, logged[a.id] || 0, planned[a.id] || 0)).join('')}
    <div class="legend">Solid = hours logged · faint = hours planned · right edge = weekly target</div></div>`;

  if (doneTasks.length) h += `<h3>Wins</h3><div class="card">${doneTasks.slice(0, 10).map(t => taskRow(t)).join('')}</div>`;

  const stuck = S.projects.filter(p => !isFinalStage(p) && Date.now() - lastActivity(p) > 10 * 864e5);
  const overdue = openTasks().filter(t => t.due && t.due < today);
  if (stuck.length || overdue.length) {
    h += `<h3>Needs attention</h3>`;
    if (stuck.length) h += `<div class="meta" style="margin:0 2px">No movement in 10+ days: move them forward, pause them, or drop them.</div>${stuck.map(projectCard).join('')}`;
    if (overdue.length) h += `<div class="card">${overdue.map(t => taskRow(t)).join('')}</div>`;
  }

  h += `<h3>Reflect</h3><form class="card" data-form="review" data-week="${wk}">
    <label>What went well?<textarea name="wins" placeholder="Finished the tech pack, sent the investor update…">${esc(r.wins)}</textarea></label>
    <label>What got in the way?<textarea name="blockers" placeholder="Late meetings, too many things in one evening…">${esc(r.blockers)}</textarea></label>
    <label>The one thing that matters most next week<input name="focus" value="${esc(r.focus)}" placeholder="e.g. Order fabric samples"></label>
    <button class="btn wide">${r.savedAt ? 'Update review' : 'Save review'}</button>
  </form>`;
  h += `<button class="btn ghost wide" data-a="plan" data-week="${dkey(addDays(ws, 7))}">Plan next week's evenings →</button>`;
  return h;
}

/* ---------- Sheets ---------- */
function sheet(html, refresh = null) {
  const el = $('#sheet');
  $('#sheet-body').innerHTML = html;
  UI.sheetRefresh = refresh;
  if (el.hidden) {
    el.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
    $('.sheet-panel').scrollTop = 0;
  }
}
function closeSheet() {
  const el = $('#sheet');
  el.classList.remove('open');
  UI.sheetRefresh = null;
  setTimeout(() => { if (!el.classList.contains('open')) el.hidden = true; }, 250);
}
const refreshSheet = () => { if (UI.sheetRefresh && !$('#sheet').hidden) UI.sheetRefresh(); };

function openTask(id, def = {}) {
  const t = id ? task(id) : { title: '', areaId: def.areaId || S.areas[0].id, projectId: def.projectId || null, due: '', est: '', priority: 'normal', notes: '' };
  if (!t) return;
  const sel = t.projectId ? 'proj:' + t.projectId : 'area:' + t.areaId;
  const inTop = id && (S.top3[dkey(new Date())] || []).includes(id);
  const est = [15, 30, 45, 60, 90, 120, 180];
  sheet(`<form data-form="task" data-id="${id || ''}">
    <h2>${id ? 'Edit task' : 'New task'}</h2>
    <label>Task<input name="title" required value="${esc(t.title)}" placeholder="e.g. Sketch 3 silhouettes" ${id ? '' : 'autofocus'}></label>
    <label>Project<select name="target">${areaOptions(sel, { withProjects: true })}</select></label>
    <div class="two">
      <label>Due<input type="date" name="due" value="${esc(t.due)}"></label>
      <label>Time needed<select name="est"><option value="">None</option>${est.map(m => `<option value="${m}" ${+t.est === m ? 'selected' : ''}>${fmtDur(m)}</option>`).join('')}</select></label>
    </div>
    <label>Priority<div class="seg">${['low', 'normal', 'high'].map(p => `<label><input type="radio" name="priority" value="${p}" ${(t.priority || 'normal') === p ? 'checked' : ''}><span>${p[0].toUpperCase() + p.slice(1)}</span></label>`).join('')}</div></label>
    <label>Notes<textarea name="notes" placeholder="Links, measurements, ideas…">${esc(t.notes)}</textarea></label>
    <label class="check-label"><input type="checkbox" name="top3" ${inTop ? 'checked' : ''}> Add to tonight's Top 3</label>
    <div class="sheet-actions">
      ${id ? `<button type="button" class="btn ghost danger" data-a="del-task" data-id="${id}">Delete</button>` : ''}
      <button class="btn">${id ? 'Save' : 'Add task'}</button>
    </div>
  </form>`);
}

function openProject(id, areaId) {
  const p = id ? project(id) : { name: '', areaId: areaId || S.areas[0].id, stage: null, notes: '', due: '' };
  if (!p) return closeSheet();
  const a = area(p.areaId) || S.areas[0];
  const si = Math.max(0, a.stages.indexOf(p.stage));
  let h = `<form data-form="project" data-id="${id || ''}"><h2>${id ? esc(p.name) : 'New project'}</h2>`;
  if (id) {
    h += `<div class="meta">Stage: tap to move it along</div><div class="stages" style="--c:${a.color}">${a.stages.map((s, i) =>
      `<button type="button" class="${i === si ? 'on' : i < si ? 'past' : ''}" data-a="set-stage" data-id="${id}" data-i="${i}">${esc(s)}</button>`).join('')}</div>`;
  }
  h += `<label>Name<input name="name" required value="${esc(p.name)}" placeholder="e.g. Spring capsule collection" ${id ? '' : 'autofocus'}></label>
    <div class="two"><label>Area<select name="areaId">${areaOptions(p.areaId)}</select></label>
    ${id ? '' : `<label>Stage<select name="stage">${a.stages.map(s => `<option>${esc(s)}</option>`).join('')}</select></label>`}
    <label>Target date<input type="date" name="due" value="${esc(p.due)}"></label></div>
    <label>Notes<textarea name="notes" placeholder="Vision, references, suppliers, links…">${esc(p.notes)}</textarea></label>
    <div class="sheet-actions">${id ? `<button type="button" class="btn ghost danger" data-a="del-project" data-id="${id}">Delete</button>` : ''}<button class="btn">${id ? 'Save' : 'Create project'}</button></div>
  </form>`;
  if (id) {
    const ts = S.tasks.filter(t => t.projectId === id).sort((x, y) => x.done - y.done || taskSort(x, y));
    const mins = S.sessions.filter(x => x.projectId === id).reduce((s, x) => s + x.min, 0);
    h += `<h3>Tasks ${mins ? `<span class="meta" style="text-transform:none;letter-spacing:0"> · ${fmtDur(mins)} logged</span>` : ''}</h3>
      <div class="card">${ts.map(t => taskRow(t, { showProject: false })).join('') || '<div class="empty small">No tasks yet</div>'}
      <form data-form="inline-task" data-project="${id}" class="row gap" style="margin-top:10px"><input name="title" placeholder="Add a task…" required><button class="btn small">Add</button></form></div>`;
  }
  sheet(h, id ? () => openProject(id) : null);
}

function openBlock(id, date) {
  const s = S.settings;
  const b = id ? S.blocks.find(x => x.id === id) : { date, start: s.eveningStart, end: s.eveningEnd, areaId: S.areas[0].id, projectId: null, title: '' };
  if (!b) return;
  const sel = b.projectId ? 'proj:' + b.projectId : 'area:' + b.areaId;
  sheet(`<form data-form="block" data-id="${id || ''}">
    <h2>${id ? 'Time block' : 'New time block'}</h2>
    <label>Date<input type="date" name="date" required value="${esc(b.date)}"></label>
    <div class="two"><label>Start<input type="time" name="start" required value="${b.start}"></label><label>End<input type="time" name="end" required value="${b.end}"></label></div>
    <label>Working on<select name="target">${areaOptions(sel, { withProjects: true })}</select></label>
    <label>Focus (optional)<input name="title" value="${esc(b.title)}" placeholder="e.g. Pitch deck v2"></label>
    ${id ? `<div class="row gap" style="margin:4px 0 8px"><a class="btn ghost small" href="${gcalLink(b)}" target="_blank" rel="noopener">Add to Google Calendar</a><button type="button" class="btn ghost small" data-a="ics-block" data-id="${id}">Apple / .ics</button></div>` : ''}
    <div class="sheet-actions">${id ? `<button type="button" class="btn ghost danger" data-a="del-block" data-id="${id}">Delete</button>` : ''}<button class="btn">${id ? 'Save' : 'Add block'}</button></div>
  </form>`);
}

function suggestPlan(nDays) {
  // Split each evening into two halves; hand out halves by remaining weekly target,
  // then group them so each area gets whole evenings where possible (less context switching).
  const half = eveningMin() / 2 / 60;
  const rem = Object.fromEntries(S.areas.map(a => [a.id, +a.target || 0]));
  const count = {};
  for (let i = 0; i < nDays * 2; i++) {
    let best = null;
    S.areas.forEach(a => { if (rem[a.id] > 0 && (best === null || rem[a.id] > rem[best])) best = a.id; });
    if (!best) break;
    rem[best] -= half; count[best] = (count[best] || 0) + 1;
  }
  const seq = [];
  S.areas.slice().sort((a, b) => (count[b.id] || 0) - (count[a.id] || 0)).forEach(a => { for (let i = 0; i < (count[a.id] || 0); i++) seq.push(a.id); });
  const out = [];
  for (let i = 0; i < nDays; i++) out.push([seq[i * 2] || '', seq[i * 2 + 1] || '']);
  return out;
}

function openPlanner(wk) {
  const ws = parseKey(wk), s = S.settings;
  const days = [...Array(7)].map((_, i) => addDays(ws, i));
  const sug = suggestPlan(days.filter(isWorkDay).length);
  const mid = fromMin(toMin(s.eveningStart) + Math.round(eveningMin() / 2));
  let wi = 0;
  const opts = sel => `<option value="">-</option>` + S.areas.map(a => `<option value="${a.id}" ${sel === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
  const rows = days.map((d, i) => {
    const k = dkey(d);
    const existing = S.blocks.filter(b => b.date === k && b.planned).sort((a, b) => a.start.localeCompare(b.start));
    let pair = ['', ''];
    if (existing.length) pair = existing.length === 1 && blockMin(existing[0]) > eveningMin() / 2 ? [existing[0].areaId, existing[0].areaId] : [existing[0].areaId, existing[1] ? existing[1].areaId : ''];
    else if (isWorkDay(d)) pair = sug[wi] || pair;
    if (isWorkDay(d)) wi++;
    return `<div class="plan-row"><span class="${isWorkDay(d) ? '' : 'meta'}">${DOW[d.getDay()]} ${d.getDate()}</span>
      <select name="a${i}">${opts(pair[0])}</select><select name="b${i}">${opts(pair[1])}</select></div>`;
  }).join('');
  sheet(`<form data-form="plan" data-week="${wk}">
    <h2>Plan your evenings</h2>
    <p class="meta" style="margin-top:-8px">Week of ${fmtRange(ws)}. The picks below are suggested from your weekly targets, and each area gets whole evenings where possible so you're not switching back and forth. Change anything you like.</p>
    <div class="plan-head"><span></span><span>${fmtTime(s.eveningStart)}–${fmtTime(mid)}</span><span>${fmtTime(mid)}–${fmtTime(s.eveningEnd)}</span></div>
    ${rows}
    <p class="meta">Blocks you added by hand stay put. Re-planning replaces only the blocks the planner made.</p>
    <div class="sheet-actions"><button class="btn">Save plan</button></div>
  </form>`);
}

function openFocusPicker() {
  const k = dkey(new Date());
  const top = (S.top3[k] || []).map(task).filter(t => t && !t.done);
  const rest = openTasks().filter(t => !top.includes(t)).sort(taskSort).slice(0, 15);
  const pick = t => { const a = area(t.areaId); return `<button class="pick" data-a="start-timer" data-id="${t.id}"><i class="dot" style="background:${a ? a.color : '#888'}"></i>${esc(t.title)}<span class="meta">${esc((project(t.projectId) || {}).name || '')}</span></button>`; };
  sheet(`<h2>What are you working on?</h2>
    ${top.length ? `<h3>Top 3</h3>${top.map(pick).join('')}` : ''}
    <h3>A whole area</h3><div class="area-picks">${S.areas.map(a => `<button class="chip" data-a="focus-area" data-area="${a.id}"><i class="dot" style="background:${a.color}"></i>${esc(a.name)}</button>`).join('')}</div>
    ${rest.length ? `<h3>A task</h3>${rest.map(pick).join('')}` : ''}`);
}

function openTop3Picker() {
  const k = dkey(new Date()), sel = S.top3[k] || [];
  const tonight = new Set(S.blocks.filter(b => b.date === k).map(b => b.areaId));
  const list = openTasks().sort((a, b) => (tonight.has(b.areaId) - tonight.has(a.areaId)) || taskSort(a, b));
  sheet(`<h2>Tonight's Top 3</h2><p class="meta" style="margin-top:-8px">${sel.length}/3 picked${tonight.size ? ". Tasks for tonight's areas are listed first." : ''}</p>
    ${list.map(t => { const a = area(t.areaId); return `<button class="pick ${sel.includes(t.id) ? 'on' : ''}" data-a="toggle-top3" data-id="${t.id}"><i class="dot" style="background:${a ? a.color : '#888'}"></i>${esc(t.title)}<span class="meta">${sel.includes(t.id) ? '★' : esc((project(t.projectId) || a || {}).name || '')}</span></button>`; }).join('') || '<div class="empty">Add some tasks first with the + button.</div>'}
    <div class="sheet-actions"><button class="btn" data-a="close-sheet">Done</button></div>`, openTop3Picker);
}

function openLogTime() {
  sheet(`<form data-form="log"><h2>Log time</h2><p class="meta" style="margin-top:-8px">Forgot the timer? Add the time here.</p>
    <label>Worked on<select name="target">${areaOptions('', { withProjects: true })}</select></label>
    <div class="two"><label>Date<input type="date" name="date" value="${dkey(new Date())}" required></label>
    <label>Minutes<input type="number" name="min" min="1" step="5" value="60" inputmode="numeric" required></label></div>
    <div class="sheet-actions"><button class="btn">Log it</button></div></form>`);
}

function openSettings() {
  const s = S.settings;
  sheet(`<form data-form="settings"><h2>Settings</h2>
    <h3 style="margin-top:0">Your day</h3>
    <div class="two"><label>Evening starts<input type="time" name="eveningStart" value="${s.eveningStart}"></label><label>Evening ends<input type="time" name="eveningEnd" value="${s.eveningEnd}"></label></div>
    <div class="two"><label>Work starts<input type="time" name="workStart" value="${s.workStart}"></label><label>Work ends<input type="time" name="workEnd" value="${s.workEnd}"></label></div>
    <label>Work days</label><div class="area-picks" style="margin:-6px 0 14px">${[1, 2, 3, 4, 5, 6, 0].map(d => `<label class="chip check-label" style="margin:0;gap:6px"><input type="checkbox" name="wd" value="${d}" ${s.workDays.includes(d) ? 'checked' : ''}>${DOW[d]}</label>`).join('')}</div>
    <h3>Areas & weekly hour targets</h3>
    <p class="meta" style="margin-top:-4px">You have about ${fmtDur(eveningMin() * s.workDays.length)} of weeknight time. Stages are comma-separated, in order.</p>
    ${S.areas.map(a => `<div class="area-edit">
      <div class="row"><input type="color" name="color_${a.id}" value="${a.color}"><input name="name_${a.id}" value="${esc(a.name)}" required>
        <input type="number" name="target_${a.id}" value="${a.target}" min="0" step="0.5" style="width:74px;flex:none" aria-label="Hours per week"><span class="meta">h/wk</span></div>
      <input name="stages_${a.id}" value="${esc(a.stages.join(', '))}">
      <button type="button" class="meta" data-a="del-area" data-id="${a.id}" style="margin-top:8px;color:var(--danger)">Remove area</button>
    </div>`).join('')}
    <button type="button" class="add-line" data-a="add-area">+ Add area</button>
    <div class="sheet-actions"><button class="btn">Save settings</button></div>
  </form>
  <h3>Backup</h3>
  <p class="meta" style="margin-top:-4px">Everything is stored on this device only. Export a backup now and then (e.g. to iCloud Drive), especially before clearing browser data.</p>
  <div class="row gap"><button class="btn ghost small" data-a="export">Export backup</button><button class="btn ghost small" data-a="import">Import backup</button></div>
  <h3>Danger zone</h3><button class="btn ghost small danger" data-a="reset">Erase everything</button>`);
}

/* ---------- Calendar export ---------- */
const icsDate = (k, t) => k.replace(/-/g, '') + 'T' + t.replace(':', '') + '00';
const icsEsc = s => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
function blockText(b) {
  const a = area(b.areaId), p = project(b.projectId);
  const title = `After Hours · ${b.title || (p && p.name) || (a && a.name) || 'Focus'}`;
  const ts = openTasks().filter(t => b.projectId ? t.projectId === b.projectId : t.areaId === b.areaId).sort(taskSort).slice(0, 5);
  const desc = [a && a.name, p && p.name].filter(Boolean).join(' / ') + (ts.length ? '\n\nUp next:\n' + ts.map(t => '• ' + t.title).join('\n') : '');
  return { title, desc };
}
function gcalLink(b) {
  const { title, desc } = blockText(b);
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${icsDate(b.date, b.start)}/${icsDate(b.date, b.end)}&details=${encodeURIComponent(desc)}`;
}
function ics(blocks) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const ev = blocks.map(b => {
    const { title, desc } = blockText(b);
    return ['BEGIN:VEVENT', `UID:${b.id}@afterhours`, `DTSTAMP:${stamp}`, `DTSTART:${icsDate(b.date, b.start)}`, `DTEND:${icsDate(b.date, b.end)}`,
      `SUMMARY:${icsEsc(title)}`, `DESCRIPTION:${icsEsc(desc)}`, 'BEGIN:VALARM', 'TRIGGER:-PT10M', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(title)}`, 'END:VALARM', 'END:VEVENT'].join('\r\n');
  });
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//After Hours//EN', 'CALSCALE:GREGORIAN', ...ev, 'END:VCALENDAR'].join('\r\n');
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ---------- Timer ---------- */
function startTimer(o) {
  if (S.timer) stopTimer(true);
  S.timer = { ...o, start: Date.now() };
  closeSheet(); commit();
  toast('Timer running. You can close the app and it keeps counting.');
}
function stopTimer(silent) {
  const tm = S.timer;
  if (!tm) return;
  const min = (Date.now() - tm.start) / 60000;
  S.timer = null;
  if (min >= 1) {
    S.sessions.push({ id: uid(), taskId: tm.taskId || null, projectId: tm.projectId || null, areaId: tm.areaId, start: tm.start, end: Date.now(), min: Math.round(min) });
    touchProject(tm.projectId);
  }
  if (!silent) {
    commit(); refreshSheet();
    toast(min >= 1 ? `Logged ${fmtDur(min)} to ${(area(tm.areaId) || {}).name || 'your area'}` : 'Under a minute, so nothing was logged');
  }
}

/* ---------- Actions ---------- */
const A = {
  'tab': d => { UI.view = d.v; closeSheet(); window.scrollTo(0, 0); render(); },
  'close-sheet': () => closeSheet(),
  'settings': () => openSettings(),
  'quick-add': () => openTask(null, { areaId: UI.view === 'projects' && UI.area !== 'all' ? UI.area : undefined }),
  'filter': d => { UI.area = d.id; render(); window.scrollTo(0, 0); },
  'new-project': d => openProject(null, d.area),
  'open-project': d => openProject(d.id),
  'new-task': d => openTask(null, { areaId: d.area }),
  'edit-task': d => openTask(d.id),
  'toggle-task': d => {
    const t = task(d.id); if (!t) return;
    t.done = !t.done; t.doneAt = t.done ? Date.now() : null;
    if (t.done && S.timer && S.timer.taskId === t.id) stopTimer(true);
    touchProject(t.projectId);
    commit(); refreshSheet();
    if (t.done) toast('Done ✓');
  },
  'del-task': d => { if (!confirm('Delete this task?')) return; S.tasks = S.tasks.filter(t => t.id !== d.id); Object.values(S.top3).forEach(l => { const i = l.indexOf(d.id); if (i > -1) l.splice(i, 1); }); closeSheet(); commit(); },
  'set-stage': d => { const p = project(d.id); p.stage = area(p.areaId).stages[+d.i]; touchProject(p.id); commit(); refreshSheet(); },
  'del-project': d => {
    const n = S.tasks.filter(t => t.projectId === d.id).length;
    if (!confirm(`Delete this project${n ? ` and its ${n} task${n > 1 ? 's' : ''}` : ''}?`)) return;
    S.projects = S.projects.filter(p => p.id !== d.id); S.tasks = S.tasks.filter(t => t.projectId !== d.id);
    S.blocks.forEach(b => { if (b.projectId === d.id) b.projectId = null; });
    closeSheet(); commit();
  },
  'start-timer': d => { const t = task(d.id); if (t) startTimer({ taskId: t.id, projectId: t.projectId, areaId: t.areaId }); },
  'focus-area': d => startTimer({ areaId: d.area }),
  'stop-timer': () => stopTimer(false),
  'pick-focus': () => openFocusPicker(),
  'log-time': () => openLogTime(),
  'pick-top3': () => openTop3Picker(),
  'toggle-top3': d => {
    const k = dkey(new Date()), l = S.top3[k] = S.top3[k] || [], i = l.indexOf(d.id);
    if (i > -1) l.splice(i, 1); else if (l.length >= 3) return toast('Three is the limit. Unpick one first.'); else l.push(d.id);
    commit(); refreshSheet();
  },
  'carry': () => { const c = carryOver(); S.top3[dkey(new Date())] = c.slice(0, 3); commit(); },
  'quick-block': d => { S.blocks.push({ id: uid(), date: dkey(new Date()), start: S.settings.eveningStart, end: S.settings.eveningEnd, areaId: d.area, projectId: null, title: '', planned: true }); commit(); },
  'new-block': d => openBlock(null, d.date),
  'edit-block': d => openBlock(d.id),
  'del-block': d => { S.blocks = S.blocks.filter(b => b.id !== d.id); closeSheet(); commit(); },
  'ics-block': d => { const b = S.blocks.find(x => x.id === d.id); if (b) download('after-hours-block.ics', ics([b]), 'text/calendar'); },
  'ics-week': d => {
    const e = dkey(addDays(parseKey(d.week), 7));
    const bs = S.blocks.filter(b => b.date >= d.week && b.date < e);
    if (!bs.length) return toast('No blocks this week yet. Tap "Plan evenings" first.');
    download(`after-hours-week-${d.week}.ics`, ics(bs), 'text/calendar');
    toast(`Exported ${bs.length} blocks. Open the file to add them to your calendar.`);
  },
  'week': d => { UI.weekOffset += +d.d; render(); },
  'rweek': d => { UI.reviewOffset = Math.min(0, UI.reviewOffset + +d.d); render(); },
  'plan': d => openPlanner(d.week),
  'add-area': () => {
    S.areas.push({ id: uid(), name: 'New area', color: '#f4b86a', target: 2, stages: ['To do', 'Doing', 'Done'] });
    save(); openSettings();
    setTimeout(() => { const p = $('.sheet-panel'); p.scrollTop = p.scrollHeight; }, 50);
  },
  'del-area': d => {
    if (S.areas.length <= 1) return toast('Keep at least one area.');
    const a = area(d.id), n = S.projects.filter(p => p.areaId === d.id).length;
    if (!confirm(`Remove "${a.name}"${n ? ` along with its ${n} project${n > 1 ? 's' : ''} and their tasks` : ''}?`)) return;
    const pids = new Set(S.projects.filter(p => p.areaId === d.id).map(p => p.id));
    S.areas = S.areas.filter(x => x.id !== d.id);
    S.projects = S.projects.filter(p => !pids.has(p.id));
    S.tasks = S.tasks.filter(t => t.areaId !== d.id && !pids.has(t.projectId));
    S.blocks = S.blocks.filter(b => b.areaId !== d.id);
    save(); openSettings(); render();
  },
  'export': () => download(`after-hours-backup-${dkey(new Date())}.json`, JSON.stringify(S, null, 1), 'application/json'),
  'import': () => $('#importFile').click(),
  'reset': () => {
    if (!confirm('Erase all projects, tasks, blocks and logged time on this device?')) return;
    if (!confirm('Are you sure? This cannot be undone unless you have a backup.')) return;
    S = defaultState(); closeSheet(); commit();
  },
};

const F = {
  task(f, form) {
    const id = form.dataset.id, tg = parseTarget(f.get('target'));
    const data = { title: f.get('title').trim(), ...tg, due: f.get('due') || '', est: f.get('est') ? +f.get('est') : '', priority: f.get('priority') || 'normal', notes: f.get('notes') || '' };
    let t;
    if (id) { t = task(id); Object.assign(t, data); }
    else { t = { id: uid(), created: Date.now(), done: false, doneAt: null, ...data }; S.tasks.push(t); }
    const k = dkey(new Date()), l = S.top3[k] = S.top3[k] || [], i = l.indexOf(t.id);
    if (f.get('top3') && i === -1) { if (l.length < 3) l.push(t.id); else toast('Top 3 is full, so the task was saved without it'); }
    if (!f.get('top3') && i > -1) l.splice(i, 1);
    touchProject(t.projectId);
    closeSheet(); commit();
    if (!id) toast('Task added');
  },
  project(f, form) {
    const id = form.dataset.id;
    const data = { name: f.get('name').trim(), areaId: f.get('areaId'), due: f.get('due') || '', notes: f.get('notes') || '', updated: Date.now() };
    if (id) {
      const p = project(id), moved = p.areaId !== data.areaId;
      Object.assign(p, data);
      if (moved) { p.stage = area(p.areaId).stages[0]; S.tasks.forEach(t => { if (t.projectId === id) t.areaId = p.areaId; }); }
      closeSheet();
    } else {
      const p = { id: uid(), created: Date.now(), stage: f.get('stage'), ...data };
      S.projects.push(p);
      openProject(p.id);
    }
    commit();
  },
  'inline-task'(f, form) {
    const p = project(form.dataset.project);
    S.tasks.push({ id: uid(), created: Date.now(), done: false, doneAt: null, title: f.get('title').trim(), areaId: p.areaId, projectId: p.id, due: '', est: '', priority: 'normal', notes: '' });
    touchProject(p.id); commit(); refreshSheet();
    setTimeout(() => { const i = $('form[data-form="inline-task"] input'); if (i) i.focus(); }, 30);
  },
  block(f, form) {
    const id = form.dataset.id;
    if (f.get('end') <= f.get('start')) return toast('The end time has to be after the start time');
    const data = { date: f.get('date'), start: f.get('start'), end: f.get('end'), ...parseTarget(f.get('target')), title: (f.get('title') || '').trim() };
    if (id) Object.assign(S.blocks.find(b => b.id === id), data);
    else S.blocks.push({ id: uid(), ...data });
    closeSheet(); commit();
  },
  plan(f, form) {
    const ws = parseKey(form.dataset.week), s = S.settings;
    const start = dkey(ws), end = dkey(addDays(ws, 7));
    const mid = fromMin(toMin(s.eveningStart) + Math.round(eveningMin() / 2));
    S.blocks = S.blocks.filter(b => !(b.planned && b.date >= start && b.date < end));
    let n = 0;
    for (let i = 0; i < 7; i++) {
      const k = dkey(addDays(ws, i)), a = f.get('a' + i), b = f.get('b' + i);
      const mk = (ar, st, en) => { S.blocks.push({ id: uid(), date: k, start: st, end: en, areaId: ar, projectId: null, title: '', planned: true }); n++; };
      if (a && a === b) mk(a, s.eveningStart, s.eveningEnd);
      else { if (a) mk(a, s.eveningStart, mid); if (b) mk(b, mid, s.eveningEnd); }
    }
    UI.view = 'week'; UI.weekOffset = Math.round((ws - weekStart(new Date())) / (7 * 864e5));
    closeSheet(); commit();
    toast(`${n} block${n === 1 ? '' : 's'} planned. Tap "Export to calendar" if you want reminders.`);
  },
  review(f, form) {
    S.reviews[form.dataset.week] = { wins: f.get('wins'), blockers: f.get('blockers'), focus: f.get('focus'), savedAt: Date.now() };
    commit(); toast('Review saved ✦');
  },
  log(f) {
    const tg = parseTarget(f.get('target')), min = Math.max(1, +f.get('min'));
    const start = parseKey(f.get('date')); start.setMinutes(toMin(S.settings.eveningStart));
    S.sessions.push({ id: uid(), taskId: null, ...tg, start: start.getTime(), end: start.getTime() + min * 60000, min });
    touchProject(tg.projectId);
    closeSheet(); commit(); toast(`Logged ${fmtDur(min)}`);
  },
  settings(f) {
    const s = S.settings;
    ['eveningStart', 'eveningEnd', 'workStart', 'workEnd'].forEach(k => { if (f.get(k)) s[k] = f.get(k); });
    if (toMin(s.eveningEnd) <= toMin(s.eveningStart)) return toast('Your evening has to end after it starts');
    s.workDays = f.getAll('wd').map(Number);
    S.areas.forEach(a => {
      a.name = (f.get('name_' + a.id) || a.name).trim();
      a.color = f.get('color_' + a.id) || a.color;
      a.target = +f.get('target_' + a.id) || 0;
      const st = (f.get('stages_' + a.id) || '').split(',').map(x => x.trim()).filter(Boolean);
      if (st.length) a.stages = st;
    });
    closeSheet(); commit(); toast('Settings saved');
  },
};

/* ---------- Render ---------- */
function render() {
  const now = new Date();
  const titles = { tonight: isWorkDay(now) ? 'Tonight' : 'This weekend', projects: 'Projects', week: 'Week', review: 'Weekly review' };
  $('#title').textContent = titles[UI.view];
  $('#eyebrow').textContent = `${DAYS[now.getDay()]} · ${MON[now.getMonth()]} ${now.getDate()}`;
  const views = { tonight: viewTonight, projects: viewProjects, week: viewWeek, review: viewReview };
  $('#main').innerHTML = views[UI.view]();
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.v === UI.view));
  const pill = $('#timerpill');
  if (S.timer && UI.view !== 'tonight') {
    const t = task(S.timer.taskId), a = area(S.timer.areaId);
    pill.hidden = false;
    pill.style.setProperty('--c', a ? a.color : '');
    pill.innerHTML = `<span data-elapsed>${fmtClock(Date.now() - S.timer.start)}</span> · ${esc((t && t.title) || (a && a.name) || '')}`;
  } else pill.hidden = true;
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-a]');
  if (!el || el.disabled) return;
  const fn = A[el.dataset.a];
  if (fn) { e.preventDefault(); fn(el.dataset, el); }
});
document.addEventListener('submit', e => {
  const form = e.target, fn = F[form.dataset.form];
  if (!fn) return;
  e.preventDefault();
  fn(new FormData(form), form);
});
document.addEventListener('change', e => {
  // Keep the new-project stage list in sync with the chosen area
  if (e.target.matches('form[data-form="project"] select[name="areaId"]')) {
    const st = e.target.form.querySelector('select[name="stage"]'), a = area(e.target.value);
    if (st && a) st.innerHTML = a.stages.map(s => `<option>${esc(s)}</option>`).join('');
  }
});
$('#importFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (!d || !Array.isArray(d.areas) || !Array.isArray(d.tasks)) throw new Error('bad');
    if (!confirm('Replace everything on this device with the backup?')) return;
    const def = defaultState();
    S = { ...def, ...d, settings: { ...def.settings, ...(d.settings || {}) } };
    closeSheet(); commit(); toast('Backup restored');
  } catch (err) { toast("That file isn't an After Hours backup"); }
});

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
}

setInterval(() => {
  if (S.timer) document.querySelectorAll('[data-elapsed]').forEach(el => { el.textContent = fmtClock(Date.now() - S.timer.start); });
}, 1000);
// Re-render when the app comes back to the foreground (day may have changed, other tab may have saved)
document.addEventListener('visibilitychange', () => { if (!document.hidden) { S = load(); if ($('#sheet').hidden) render(); } });

render();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
