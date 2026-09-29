'use strict';

/* ---------- Config ---------- */
// Cloudflare Worker that bridges to Apple Calendar (see sync-worker/). Empty = calendar sync unavailable.
const SYNC_URL = 'https://after-hours-sync.after-hours-sync.workers.dev';

/* ---------- Utilities ---------- */
const KEY = 'afterhours.v1';
const UI_KEY = 'afterhours.ui';
const $ = (s, r = document) => r.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
const randHex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const dkey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const weekStart = d => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return addDays(x, -((x.getDay() + 6) % 7)); };
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const hhmm = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const todayKey = () => dkey(new Date());
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
  if (k === todayKey()) return 'Today';
  if (k === dkey(addDays(new Date(), 1))) return 'Tomorrow';
  if (k === dkey(addDays(new Date(), -1))) return 'Yesterday';
  const d = parseKey(k);
  return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
}
function fmtAgo(ms) {
  const d = Math.floor((Date.now() - ms) / 864e5);
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  return `${Math.floor(d / 30)} mo ago`;
}
const fmtRange = ws => { const we = addDays(ws, 6); return `${MON[ws.getMonth()]} ${ws.getDate()} – ${ws.getMonth() === we.getMonth() ? '' : MON[we.getMonth()] + ' '}${we.getDate()}`; };

const ICON = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
};

/* ---------- State ---------- */
const STAGES = {
  brand: ['Vision', 'Identity', 'First pieces', 'Samples', 'Marketing', 'Launch'],
  fashion: ['Concept', 'Sketch', 'Sourcing', 'Pattern', 'Sample', 'Finishing', 'Done'],
  startup: ['Prototype', 'Mentor feedback', 'Trial planning', 'Trials', 'Regulatory', 'Launch'],
  side: ['In progress', 'Next up', 'Someday', 'Paused', 'Done'],
};
const FABRIC_STATUS = ['In stash', 'Planned', 'Used up'];
const PEOPLE_STATUS = ['To contact', 'Reached out', 'Meeting set', 'Follow up', 'Engaged', 'Not now'];
const CLOSED_STATUS = ['Engaged', 'Not now'];

function defaultState() {
  return {
    version: 2,
    settings: { eveningStart: '18:00', eveningEnd: '22:00', workStart: '09:00', workEnd: '17:00', workDays: [1, 2, 3, 4, 5], reviewTime: '19:00', reminderMin: 10, theme: 'system', extraFields: false },
    areas: [
      { id: 'brand', name: 'Fashion Brand', color: '#d4899f', target: 6, stages: STAGES.brand.slice() },
      { id: 'fashion', name: 'Fashion Projects', color: '#9f8fd0', target: 4, stages: STAGES.fashion.slice() },
      { id: 'startup', name: 'Startup', color: '#6f9cc9', target: 8, stages: STAGES.startup.slice() },
      { id: 'side', name: 'Side Projects', color: '#79b08f', target: 2, stages: STAGES.side.slice(), pipe: false },
    ],
    projects: [], tasks: [], blocks: [], sessions: [], people: [], ideas: [], fabrics: [],
    top3: {}, reviews: {}, away: {}, energy: {}, restMoved: {}, timer: null, flags: {},
    sync: null, cal: { events: [], errors: [], fetchedAt: 0 },
  };
}

// Earlier versions shipped different default stages; move untouched areas to the new ones.
const OLD_STAGES = {
  brand: ['Vision', 'Identity', 'Collection', 'Sourcing', 'Sampling', 'Production', 'Launch'],
  startup: ['Idea', 'Validate', 'Build', 'Launch', 'Grow'],
  side: ['Someday', 'Next up', 'In progress', 'Paused', 'Done'],
};
const STAGE_MAP = {
  brand: { Collection: 'First pieces', Sourcing: 'Samples', Sampling: 'Samples', Production: 'Marketing' },
  startup: { Idea: 'Prototype', Validate: 'Mentor feedback', Build: 'Prototype', Grow: 'Launch' },
};
function migrate(d) {
  const def = defaultState();
  d = { ...def, ...d, settings: { ...def.settings, ...(d.settings || {}) } };
  if ((d.version || 1) < 2) {
    d.areas.forEach(a => {
      if (OLD_STAGES[a.id] && JSON.stringify(a.stages) === JSON.stringify(OLD_STAGES[a.id])) {
        a.stages = STAGES[a.id].slice();
        d.projects.forEach(p => { if (p.areaId === a.id && !a.stages.includes(p.stage)) p.stage = (STAGE_MAP[a.id] || {})[p.stage] || a.stages[0]; });
      }
      if (a.id === 'side' && a.pipe === undefined) a.pipe = false;
    });
    d.version = 2;
  }
  ['people', 'ideas', 'fabrics'].forEach(k => { if (!Array.isArray(d[k])) d[k] = []; });
  ['away', 'flags', 'top3', 'reviews', 'energy', 'restMoved'].forEach(k => { if (!d[k] || typeof d[k] !== 'object') d[k] = {}; });
  if (!d.cal || !Array.isArray(d.cal.events)) d.cal = def.cal;
  // Softer palette: swap untouched original colors for the muted ones
  const OLD_COLORS = { '#f29fc5': '#d4899f', '#c9a7ff': '#9f8fd0', '#7cc4ff': '#6f9cc9', '#8fe0b0': '#79b08f', '#f4b86a': '#c7896b' };
  d.areas.forEach(a => { if (OLD_COLORS[a.color]) a.color = OLD_COLORS[a.color]; });
  return d;
}
function load() {
  try { const raw = localStorage.getItem(KEY); if (raw) return migrate(JSON.parse(raw)); } catch (e) { /* use defaults */ }
  return defaultState();
}
let S = load();
const UI = { view: 'tonight', area: 'all', ideaArea: 'all', weekOffset: 0, reviewOffset: 0, sheetRefresh: null, projMode: 'list', studio: 'ideas', fabricFilter: 'all', fabricQuery: '' };
try { Object.assign(UI, JSON.parse(localStorage.getItem(UI_KEY) || '{}')); } catch (e) { /* ignore */ }
const saveUI = () => { try { localStorage.setItem(UI_KEY, JSON.stringify({ projMode: UI.projMode, studio: UI.studio })); } catch (e) { /* ignore */ } };

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch (e) { toast('Could not save. Export a backup from Settings.'); }
}
function commit() { save(); render(); schedulePush(); }

const area = id => S.areas.find(a => a.id === id);
const project = id => S.projects.find(p => p.id === id);
const task = id => S.tasks.find(t => t.id === id);
const person = id => S.people.find(p => p.id === id);
const blockMin = b => toMin(b.end) - toMin(b.start);
const eveningMin = () => toMin(S.settings.eveningEnd) - toMin(S.settings.eveningStart);
const isWorkDay = d => S.settings.workDays.includes(d.getDay());
const touchProject = id => { const p = project(id); if (p) p.updated = Date.now(); };
const isLight = t => t.energy === 'light' || (!t.energy && t.est && +t.est <= 30);

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
  const today = todayKey();
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
const dueFollowUps = () => S.people.filter(p => p.next && p.next <= todayKey() && !CLOSED_STATUS.includes(p.status)).sort((a, b) => a.next.localeCompare(b.next));

/* ---------- Today list + rollover ---------- */
const daysBetween = (a, b) => Math.round((parseKey(b) - parseKey(a)) / 864e5);
const todaysTasks = () => { const k = todayKey(); return S.tasks.filter(t => t.day === k); };
function carriedDays(t) { return t.firstDay && t.day && t.firstDay < t.day ? daysBetween(t.firstDay, t.day) : 0; }
function scheduleTask(t, day) {
  t.day = day || '';
  if (!day) t.firstDay = '';
  else if (!t.firstDay || t.firstDay > day) t.firstDay = day;
}
// Unchecked tasks from earlier days move to today; so does an unfinished Top 3
function rollover() {
  const k = todayKey();
  S.tasks.forEach(t => { if (!t.done && t.day && t.day < k) { if (!t.firstDay) t.firstDay = t.day; t.day = k; } });
  if (!(S.top3[k] || []).length) {
    const prev = Object.keys(S.top3).filter(x => x < k && S.top3[x].length).sort().pop();
    if (prev) {
      const ids = S.top3[prev].filter(id => { const t = task(id); return t && !t.done; }).slice(0, 3);
      if (ids.length) { S.top3[k] = ids; ids.forEach(id => { const t = task(id); if (t.day !== k) { if (!t.firstDay) t.firstDay = prev; t.day = k; } }); }
    }
  }
  // Keep Top 3 history small
  Object.keys(S.top3).forEach(x => { if (daysBetween(x, k) > 60) delete S.top3[x]; });
}

/* ---------- Energy: full / light / rest evenings ---------- */
const energyOf = k => S.energy[k] || '';
// What an evening turned out to be, for the review strip
function eveningKind(k) {
  if (S.energy[k]) return S.energy[k];
  if (isAway(k)) return 'away';
  const d0 = parseKey(k).getTime(), d1 = addDays(parseKey(k), 1).getTime();
  const worked = S.sessions.some(x => x.start >= d0 && x.start < d1) || S.tasks.some(t => t.doneAt >= d0 && t.doneAt < d1);
  return worked ? 'full' : '';
}
// Weekdays that were light or rest at least twice (and half the time) over the last 8 weeks
function lowEnergyDays() {
  const tally = {};
  for (let i = 1; i <= 56; i++) {
    const d = addDays(new Date(), -i), k = dkey(d), e = eveningKind(k);
    if (!e || e === 'away') continue;
    const t = tally[d.getDay()] = tally[d.getDay()] || { low: 0, n: 0 };
    t.n++; if (e === 'light' || e === 'rest') t.low++;
  }
  return Object.entries(tally).filter(([, t]) => t.low >= 2 && t.low / t.n >= .5).map(([d]) => +d);
}
const quickTasks = () => openTasks().sort((a, b) => (isLight(b) - isLight(a)) || ((+a.est || 999) - (+b.est || 999)) || taskSort(a, b));

/* ---------- Apple Calendar events ---------- */
const TRIP = /\b(trip|travel(l?ing)?|flight|fly(ing)?|vacation|holiday|away|out of town|getaway|retreat|wedding|visiting)\b|✈|🏖|🧳/i;
function calEvents(k) {
  const d0 = parseKey(k).getTime(), d1 = addDays(parseKey(k), 1).getTime();
  return (S.cal.events || []).filter(e => (e.allDay ? e.sd <= k && k < e.ed : e.s < d1 && e.e > d0))
    .sort((a, b) => (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0) || (a.s || 0) - (b.s || 0));
}
const spanDays = e => Math.round((parseKey(e.ed) - parseKey(e.sd)) / 864e5);
function eveningOverlap(k, st, en) {
  const base = parseKey(k);
  const a = new Date(base).setHours(0, toMin(st)), b = new Date(base).setHours(0, toMin(en));
  return calEvents(k).filter(e => !e.allDay && e.busy !== false).reduce((m, e) => m + Math.max(0, Math.min(b, e.e) - Math.max(a, e.s)) / 6e4, 0);
}
function autoAway(k) {
  const s = S.settings;
  return calEvents(k).some(e => (e.allDay ? spanDays(e) >= 2 || TRIP.test(e.title) : TRIP.test(e.title) && eveningOverlap(k, s.eveningStart, s.eveningEnd) > 0));
}
const isAway = k => (k in S.away ? S.away[k] : autoAway(k));
function awayReason(k) {
  if (k in S.away) return S.away[k] ? 'Marked away' : '';
  const e = calEvents(k).find(x => x.allDay ? spanDays(x) >= 2 || TRIP.test(x.title) : TRIP.test(x.title));
  return e ? e.title : '';
}
function calEventLine(e) {
  const t = e.allDay ? 'All day' : fmtTime(hhmm(e.s));
  return `<div class="cal-ev"><span class="cal-time">${t}</span>${esc(e.title)}</div>`;
}

/* ---------- Components ---------- */
function taskRow(t, { showProject = true, num } = {}) {
  const p = project(t.projectId), a = area(t.areaId), today = todayKey();
  const running = S.timer && S.timer.taskId === t.id;
  const bits = showProject ? [esc(p ? p.name : (a ? a.name : ''))].filter(Boolean) : [];
  const showDot = showProject;
  if (t.due) bits.push(`<span class="${!t.done && t.due < today ? 'overdue' : ''}">${fmtDay(t.due)}</span>`);
  const cd = !t.done && t.day === today ? carriedDays(t) : 0;
  if (cd) bits.push(`<span class="carried ${cd >= 3 ? 'stale' : ''}">↻ ${cd} day${cd > 1 ? 's' : ''}</span>`);
  return `<div class="task ${t.done ? 'done' : ''}">
    ${num ? `<span class="num">${num}</span>` : ''}
    <button class="check" data-a="toggle-task" data-id="${t.id}" aria-label="Mark done">${t.done ? ICON.check : ''}</button>
    <button class="task-main" data-a="edit-task" data-id="${t.id}">
      <span class="task-title">${t.priority === 'high' ? '<span class="pri">!</span>' : ''}${esc(t.title)}</span>
      ${bits.length ? `<span class="meta">${showDot && bits.length ? `<i class="dot" style="background:${a ? a.color : '#888'}"></i>` : ''}${bits.join(' · ')}</span>` : ''}
    </button>
    ${running ? `<button class="play on" data-a="stop-timer" aria-label="Stop timer">${ICON.stop}</button>` : ''}
  </div>`;
}

function blockCard(b) {
  const a = area(b.areaId), p = project(b.projectId);
  const main = b.title || (p && p.name) || (a && a.name) || 'Block';
  const sub = [a && a.name, p && b.title ? p.name : ''].filter(Boolean).join(' · ');
  return `<button class="block" data-a="edit-block" data-id="${b.id}" style="--c:${a ? a.color : '#888'}">
    <span class="block-time">${fmtTime(b.start)} – ${fmtTime(b.end)}</span>
    <span class="block-title">${esc(main)}</span>
    ${sub && sub !== main ? `<span class="block-sub">${esc(sub)}</span>` : ''}
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
    ${a.pipe === false ? '<div style="height:6px"></div>' : `<div class="pipe">${a.stages.map((s, i) => `<i class="${i <= si ? 'on' : ''}"></i>`).join('')}</div>`}
    <div class="meta">${meta.join(' · ')}</div>
  </button>`;
}

// Expanded project for the scrolling list: header plus what's left to do
function projectListItem(p) {
  const a = area(p.areaId) || S.areas[0];
  const ts = S.tasks.filter(t => t.projectId === p.id);
  const open = ts.filter(t => !t.done).sort(taskSort);
  const done = ts.length - open.length;
  return `<div class="proj list" style="--c:${a.color}">
    <button class="proj-head" data-a="open-project" data-id="${p.id}">
      <div class="proj-top"><span class="proj-name">${esc(p.name)}</span><span class="meta">${ts.length ? `${done}/${ts.length} done` : ''} ›</span></div>
      ${ts.length ? `<div class="progress"><i style="width:${done / ts.length * 100}%"></i></div>` : ''}
    </button>
    ${open.slice(0, 3).map(t => taskRow(t, { showProject: false })).join('')}
    ${open.length > 3 ? `<button class="meta" data-a="open-project" data-id="${p.id}" style="padding:6px 0">+ ${open.length - 3} more</button>` : ''}
    ${!open.length ? `<div class="empty small" style="padding:6px 0">${ts.length ? 'All tasks done 🎉' : 'Nothing listed yet'}</div>` : ''}
    <button class="add-line" data-a="new-task" data-project="${p.id}" style="padding:6px 0 0">+ Add task</button>
  </div>`;
}

function personRow(p) {
  const today = todayKey(), due = p.next && p.next <= today && !CLOSED_STATUS.includes(p.status);
  return `<button class="person" data-a="edit-person" data-id="${p.id}">
    <span class="avatar">${esc((p.name || '?').trim()[0] || '?').toUpperCase()}</span>
    <span class="person-main"><span class="person-name">${esc(p.name)}</span>
      <span class="meta">${esc([p.role, p.status].filter(Boolean).join(' · '))}${p.next && !CLOSED_STATUS.includes(p.status) ? ` · <span class="${due ? 'overdue' : ''}">follow up ${fmtDay(p.next).toLowerCase()}</span>` : ''}</span></span>
  </button>`;
}

function timerCard() {
  const t = task(S.timer.taskId), a = area(S.timer.areaId), p = project(S.timer.projectId);
  return `<div class="timer" style="--c:${a ? a.color : 'var(--accent)'}">
    <span class="timer-dot"></span>
    <div class="timer-main"><div class="timer-title">${esc((t && t.title) || (p && p.name) || (a && a.name) || 'Focus')}</div>
      <div class="elapsed" data-elapsed>${fmtClock(Date.now() - S.timer.start)}</div></div>
    <button class="btn small" data-a="stop-timer">Stop</button>
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
function currentBlock(blocks) {
  const now = new Date(), m = now.getHours() * 60 + now.getMinutes();
  return blocks.find(b => toMin(b.start) <= m && m < toMin(b.end)) || blocks.find(b => toMin(b.start) > m) || null;
}
function blockName(b) { const p = project(b.projectId), a = area(b.areaId); return b.title || (p && p.name) || (a && a.name) || 'Focus'; }

function focusCard(k, blocks) {
  const now = new Date(), m = now.getHours() * 60 + now.getMinutes(), s = S.settings;
  const work = isWorkDay(now), energy = energyOf(k);
  const energyLink = `<button class="card-link" data-a="energy">${energy ? 'Change tonight\'s energy' : 'Low on energy?'}</button>`;

  if (S.timer) {
    const t = task(S.timer.taskId), a = area(S.timer.areaId), p = project(S.timer.projectId);
    return `<div class="dcard focus"><span class="k">Focusing</span>
      <div class="big">${esc((t && t.title) || (p && p.name) || (a && a.name) || 'Focus')}</div>
      <span class="small">${esc([a && a.name, t && p ? p.name : ''].filter(Boolean).join(' · '))}</span>
      <div class="elapsed" data-elapsed>${fmtClock(Date.now() - S.timer.start)}</div>
      <div class="spacer"></div><div class="card-actions"><button class="go" data-a="stop-timer">Stop &amp; log</button></div></div>`;
  }
  if (energy === 'rest') {
    return `<div class="dcard focus"><span class="k">Rest night</span><div class="big">Take the night off</div>
      <span class="small">Today's unfinished tasks moved to tomorrow, and tonight's blocks are skipped. Resting counts too.</span>
      <div class="spacer"></div><button class="card-link" data-a="energy-undo">Changed your mind? Undo</button></div>`;
  }
  if (isAway(k)) {
    return `<div class="dcard focus"><span class="k">Away</span><div class="big">Enjoy the trip</div>
      <span class="small">Nothing planned today. The plan will be here when you're back.</span><div class="spacer"></div></div>`;
  }
  if (energy === 'light') {
    const q = quickTasks().slice(0, 3);
    return `<div class="dcard focus"><span class="k">Light night</span><div class="big">Just one small thing</div>
      <span class="small">Pick any of these, or do nothing. Small still counts.</span>
      <div class="focus-list">${q.map(t => taskRow(t)).join('') || '<p class="small">No tasks yet.</p>'}</div>
      <div class="spacer"></div>
      <div class="card-actions">${q[0] ? `<button class="go" data-a="start-timer" data-id="${q[0].id}">Start 25 minutes</button>` : ''}${energyLink}</div></div>`;
  }

  const cur = currentBlock(blocks);
  if (!blocks.length) {
    if (!work) return `<div class="dcard focus"><span class="k">Weekend</span><div class="big">No plan, no pressure</div>
      <span class="small">Bonus time only if you feel like it.</span><div class="spacer"></div>
      <div class="card-actions"><button class="go" data-a="new-block" data-date="${k}">Add a bonus block</button></div></div>`;
    return `<div class="dcard focus"><span class="k">Tonight · ${fmtTime(s.eveningStart)}–${fmtTime(s.eveningEnd)}</span><div class="big">What's tonight for?</div>
      <div class="focus-picks">${S.areas.map(a => `<button class="pick-area" data-a="quick-block" data-area="${a.id}"><i class="dot" style="background:${a.color}"></i>${esc(a.name)}</button>`).join('')}</div>
      <div class="spacer"></div><div class="card-actions">${energyLink}</div></div>`;
  }
  if (!cur) {
    const plan = blocks.map(b => { const a = area(b.areaId); return `<li class="past"><span class="t">${fmtTime(b.start).replace(/(am|pm)$/, '')}–${fmtTime(b.end)}</span><i class="bar" style="color:${a ? a.color : '#aaa'}"></i>${esc(blockName(b))}</li>`; }).join('');
    return `<div class="dcard focus"><span class="k">Tonight's plan is done</span><div class="big">That's a wrap</div>
      <span class="small">Rest up. Tomorrow's plan will be here when you open the app.</span><ul class="plan">${plan}</ul>
      <div class="spacer"></div><div class="card-actions"><button class="card-link" data-a="pick-focus">Keep going anyway</button></div></div>`;
  }
  const live = cur && toMin(cur.start) <= m;
  const focus = cur || blocks[blocks.length - 1];
  const nextTask = openTasks().filter(t => focus.projectId ? t.projectId === focus.projectId : t.areaId === focus.areaId).sort(taskSort)[0];
  const kline = live ? `Now · ${fmtDur(toMin(focus.end) - m)} left in this block` : cur ? `Starts at ${fmtTime(focus.start)}` : "Tonight's blocks are done";
  const plan = blocks.map(b => {
    const st = toMin(b.end) <= m ? 'past' : b === cur && live ? 'now' : 'later';
    const a = area(b.areaId);
    return `<li class="${st}"><span class="t">${fmtTime(b.start).replace(/(am|pm)$/, '')}–${fmtTime(b.end)}</span><i class="bar" style="color:${a ? a.color : '#aaa'}"></i>${esc(blockName(b))}</li>`;
  }).join('');
  return `<div class="dcard focus"><span class="k">${kline}</span>
    <div class="big">${esc(blockName(focus))}</div>
    ${nextTask ? `<span class="small">Next: ${esc(nextTask.title)}</span>` : ''}
    <ul class="plan">${plan}</ul>
    <div class="spacer"></div>
    <div class="card-actions"><button class="go" data-a="${nextTask ? 'start-timer' : 'focus-area'}" data-id="${nextTask ? nextTask.id : ''}" data-area="${focus.areaId}">Start focusing</button>${energyLink}</div></div>`;
}

function viewTonight() {
  const now = new Date(), k = todayKey();
  const blocks = S.blocks.filter(b => b.date === k && !b.skipped).sort((a, b) => a.start.localeCompare(b.start));
  let h = '';
  const thisWk = dkey(weekStart(now)), lastWk = dkey(addDays(weekStart(now), -7));
  if (now.getDay() === 0 && !S.reviews[thisWk]) h += `<button class="nudge" data-a="review-week" data-o="0">Sunday review · 10 min →</button>`;
  else if ([1, 2].includes(now.getDay()) && !S.reviews[lastWk] && S.sessions.length) h += `<button class="nudge" data-a="review-week" data-o="-1">Catch up on last week's review →</button>`;

  if (!S.projects.length && !S.tasks.length) {
    return h + `<div class="deck"><div class="dcard focus"><span class="k">Welcome</span><div class="big">Let's set up your evenings</div>
      <span class="small">Add your projects, or load a starter plan for your prototype and brand.</span><div class="spacer"></div>
      <div class="card-actions"><button class="go" data-a="tab" data-v="projects">Get started</button></div></div></div>`;
  }

  const rest = energyOf(k) === 'rest' || energyOf(k) === 'light';
  const topIdsList = (S.top3[k] || []).filter(id => task(id));
  const top = topIdsList.map(task);
  const rest3 = todaysTasks().filter(t => !topIdsList.includes(t.id)).sort((a, b) => a.done - b.done || taskSort(a, b));
  let today = `<div class="dcard"><span class="k">${rest ? 'Optional tonight' : top.length ? 'Top 3 first, then the rest' : 'Unfinished tasks roll over to tomorrow'}</span><div class="big">Today</div><div class="card-list">`;
  today += top.map((t, i) => taskRow(t, { num: i + 1 })).join('');
  if (top.length && rest3.length) today += `<div class="list-gap"></div>`;
  today += rest3.map(t => taskRow(t)).join('');
  if (!top.length && !rest3.length) today += `<p class="small">Nothing planned for today yet.</p>`;
  today += `</div>
    <form data-form="today-add" class="today-add"><input name="title" placeholder="Add something for today…" autocomplete="off" required><button class="add-btn" aria-label="Add">+</button></form>
    <div class="spacer"></div>
    <div class="card-actions"><button class="card-link" data-a="plan-today">Plan today from your tasks</button></div></div>`;

  const fu = dueFollowUps();
  const blockAreas = new Set(blocks.map(b => b.areaId)), blockProjects = new Set(blocks.map(b => b.projectId).filter(Boolean));
  const topIds = new Set([...(S.top3[k] || []), ...todaysTasks().map(t => t.id)]);
  const late = now.getHours() >= 21;
  const all = openTasks().filter(t => !topIds.has(t.id) && (!blockAreas.size || blockAreas.has(t.areaId)))
    .sort((a, b) => (late ? isLight(b) - isLight(a) : 0) || (blockProjects.has(b.projectId) - blockProjects.has(a.projectId)) || taskSort(a, b));
  const shown = UI.moreNext ? all.slice(0, 15) : all.slice(0, 5);
  let next = `<div class="dcard"><span class="k">${blockAreas.size ? "For tonight's areas" : 'Everything else'}</span><div class="big">Up next</div><div class="card-list">`;
  next += fu.map(personRow).join('');
  next += shown.map(t => taskRow(t)).join('') || (fu.length ? '' : '<p class="small">All clear. Tap + to add a task.</p>');
  if (all.length > shown.length) next += `<button class="add-line muted" data-a="more-next">Show ${all.length - shown.length} more</button>`;
  next += `</div></div>`;

  h += `<div class="deck" data-deck>${focusCard(k, blocks)}${today}${next}</div>
    <div class="deck-dots">${[0, 1, 2].map(i => `<i class="${i === (UI.deckIdx || 0) ? 'on' : ''}"></i>`).join('')}</div>`;
  return h;
}

function openEnergy() {
  const k = todayKey(), cur = energyOf(k) || 'full';
  const opt = (v, t, d) => `<button class="energy-opt ${cur === v ? 'on' : ''}" data-a="set-energy" data-v="${v}"><b>${t}</b><span>${d}</span></button>`;
  sheet(`<h2>How's your energy tonight?</h2>
    ${opt('full', 'Full evening', 'Stick to the plan.')}
    ${opt('light', 'Light night', 'Just one small thing: your quickest tasks and a 25-minute timer.')}
    ${opt('rest', 'Rest tonight', 'Take the night off. Today\'s unfinished tasks move to tomorrow and tonight\'s blocks are skipped.')}
    <p class="meta" style="margin-top:14px">Your choice is saved so the weekly review can spot patterns, like evenings that are often low-energy.</p>`);
}

function carryOver() {
  const k = todayKey();
  const prev = Object.keys(S.top3).filter(x => x < k).sort().pop();
  if (!prev) return [];
  const ids = S.top3[prev].filter(id => { const t = task(id); return t && !t.done; });
  ids.key = prev;
  return ids;
}

function chip(id, label, color, action = 'filter', current = UI.area) {
  return `<button class="chip ${current === id ? 'on' : ''}" data-a="${action}" data-id="${id}">${color ? `<i class="dot" style="background:${color}"></i>` : ''}${esc(label)}</button>`;
}

function viewProjects() {
  const logged = minutesByArea(weekStart(new Date()));
  if (UI.area !== 'all' && !area(UI.area)) UI.area = 'all';
  let h = '';
  if (UI.area === 'all') {
    if (!S.flags.starter && !S.flags.starterDismissed) {
      h += `<div class="starter"><span>✨ Want a starter plan for your prototype and brand?</span>
        <span class="row gap"><button class="link" data-a="starter">Add it</button><button class="link muted" data-a="starter-dismiss">No thanks</button></span></div>`;
    }
    h += `<div class="deck" data-deck>${S.areas.map(a => {
      const ps = S.projects.filter(p => p.areaId === a.id && !isFinalStage(p)).sort((x, y) => lastActivity(y) - lastActivity(x));
      const open = S.tasks.filter(t => t.areaId === a.id && !t.done).sort(taskSort);
      return `<div class="dcard area-card" style="--c:${a.color}">
        <span class="k"><i class="dot" style="background:${a.color}"></i>${fmtDur(logged[a.id] || 0)} of ${a.target || 0}h this week</span>
        <div class="big">${esc(a.name)}</div>
        <span class="small">${ps.length ? `${ps.length} active project${ps.length > 1 ? 's' : ''} · ${open.length} open task${open.length === 1 ? '' : 's'}` : 'No projects yet'}</span>
        <div class="card-list">${ps.slice(0, 4).map(p => `<button class="mini-proj" data-a="open-project" data-id="${p.id}"><span>${esc(p.name)}</span><span class="stage">${esc(p.stage || '')}</span></button>`).join('')}</div>
        <div class="spacer"></div>
        <div class="card-actions"><button class="go" data-a="filter" data-id="${a.id}">Open ${esc(a.name)}</button><button class="card-link" data-a="new-project" data-area="${a.id}">+ New project</button></div>
      </div>`;
    }).join('')}</div>
    <div class="deck-dots">${S.areas.map((_, i) => `<i class="${i === (UI.deckIdx || 0) ? 'on' : ''}"></i>`).join('')}</div>`;
    return h;
  }

  const a = area(UI.area);
  h += `<button class="back" data-a="filter" data-id="all">‹ All areas</button>`;
  h += `<p class="meta" style="margin:0 0 4px">${fmtDur(logged[a.id] || 0)} of ${a.target || 0}h this week</p>`;

  if (false) {
    h += `<div class="meta" style="margin:6px 2px">Swipe across the stages →</div><div class="board">${a.stages.map((st, i) => {
      const ps = S.projects.filter(p => p.areaId === a.id && (p.stage === st || (i === 0 && !a.stages.includes(p.stage))));
      return `<div class="col"><div class="col-head">${esc(st)}<span>${ps.length}</span></div>${ps.map(projectCard).join('') || '<div class="empty small">·</div>'}</div>`;
    }).join('')}</div>`;
  } else {
    a.stages.forEach((st, i) => {
      const ps = S.projects.filter(p => p.areaId === a.id && (p.stage === st || (i === 0 && !a.stages.includes(p.stage))));
      if (!ps.length) return;
      const last = i === a.stages.length - 1 && a.stages.length > 2;
      const body = ps.map(projectListItem).join('');
      h += last ? `<details class="stage-sec"><summary><h3>${esc(st)} · ${ps.length}</h3></summary>${body}</details>`
        : `<h3>${esc(st)} · ${ps.length}</h3>${body}`;
    });
    if (!S.projects.some(p => p.areaId === a.id)) h += `<div class="empty">No ${esc(a.name.toLowerCase())} yet.</div>`;
  }
  h += `<button class="add-line" data-a="new-project" data-area="${a.id}">+ New project</button>`;

  const loose = S.tasks.filter(t => t.areaId === a.id && !t.projectId && !t.done).sort(taskSort);
  if (loose.length) h += `<h3>Other tasks</h3><div class="list">${loose.map(t => taskRow(t)).join('')}</div>`;

  const ppl = S.people.filter(p => p.areaId === a.id)
    .sort((x, y) => CLOSED_STATUS.includes(x.status) - CLOSED_STATUS.includes(y.status) || (x.next || '9999').localeCompare(y.next || '9999'));
  if (ppl.length || a.id === 'startup') {
    h += `<h3>${a.id === 'startup' ? 'Mentors &amp; contacts' : 'People'}</h3><div class="list">${ppl.map(personRow).join('') || '<p class="empty small">Track who you\'ve reached out to and when to follow up.</p>'}
      <button class="add-line" data-a="new-person" data-area="${a.id}">+ Add person</button></div>`;
  }
  h += `<div class="foot row gap">${loose.length ? '' : `<button class="link muted" data-a="new-task" data-area="${a.id}">+ Task without a project</button>`}${ppl.length || a.id === 'startup' ? '' : `<button class="link muted" data-a="new-person" data-area="${a.id}">+ Person</button>`}</div>`;
  return h;
}

function viewStudio() {
  const tog = `<div class="seg studio-seg">${[['ideas', '💡 Ideas'], ['fabrics', '🧵 Fabric closet']].map(([m, l]) => `<button class="${UI.studio === m ? 'on' : ''}" data-a="studio" data-m="${m}">${l}</button>`).join('')}</div>`;
  return tog + (UI.studio === 'fabrics' ? viewFabrics() : viewIdeas());
}

const fabric = id => S.fabrics.find(f => f.id === id);
function fabricMatches(f) {
  if (UI.fabricFilter !== 'all' && f.status !== UI.fabricFilter) return false;
  const q = UI.fabricQuery.trim().toLowerCase();
  if (!q) return true;
  const p = project(f.projectId);
  return [f.name, f.fiber, f.color, f.amount, f.source, f.plans, p && p.name].join(' ').toLowerCase().includes(q);
}
function fabricCard(f) {
  const img = f.photos && f.photos[0], plan = (f.plans || '').split('\n')[0], p = project(f.projectId);
  const st = f.status === 'Planned' ? 'planned' : f.status === 'Used up' ? 'used' : '';
  return `<button class="fabric ${st}" data-a="edit-fabric" data-id="${f.id}">
    <span class="swatch">${img ? `<img data-img="thumb:${img}" alt="">` : '<span class="no-photo">🧵</span>'}${st ? `<i class="st st-${st}">${esc(f.status)}</i>` : ''}</span>
    <span class="fabric-name">${esc(f.name || 'Untitled fabric')}</span>
    <span class="meta">${esc([f.amount, f.fiber].filter(Boolean).join(' · ') || f.color || '')}</span>
    ${plan || p ? `<span class="fabric-plan">→ ${esc(plan || p.name)}</span>` : ''}
  </button>`;
}
function fabricGrid() {
  const list = S.fabrics.filter(fabricMatches).sort((a, b) => (a.status === 'Used up') - (b.status === 'Used up') || b.created - a.created);
  if (!S.fabrics.length) return `<div class="empty">Your fabric closet is empty. Tap <b>+ Add fabric</b> and snap a photo of each fabric you own.</div>`;
  return list.length ? `<div class="fab-grid">${list.map(fabricCard).join('')}</div>` : `<div class="empty">No fabrics match.</div>`;
}
function viewFabrics() {
  const n = s => S.fabrics.filter(f => f.status === s).length;
  let h = `<div class="row between" style="margin:10px 0 4px"><span class="meta">${S.fabrics.length} fabric${S.fabrics.length === 1 ? '' : 's'}${n('Planned') ? ` · ${n('Planned')} planned` : ''}</span>
    <button class="btn small" data-a="new-fabric">+ Add fabric</button></div>`;
  if (S.fabrics.length > 3) h += `<input class="search" id="fabric-search" type="search" placeholder="Search: linen, silk, trousers…" value="${esc(UI.fabricQuery)}">`;
  h += `<div class="chips">${['all', ...FABRIC_STATUS].map(x => `<button class="chip ${UI.fabricFilter === x ? 'on' : ''}" data-a="fabric-filter" data-id="${x}">${x === 'all' ? 'All' : x}</button>`).join('')}</div>`;
  h += `<div id="fabric-grid">${fabricGrid()}</div>`;
  return h;
}

function viewIdeas() {
  if (UI.ideaArea !== 'all' && UI.ideaArea !== 'none' && !area(UI.ideaArea)) UI.ideaArea = 'all';
  const list = S.ideas.filter(i => UI.ideaArea === 'all' || (UI.ideaArea === 'none' ? !area(i.areaId) : i.areaId === UI.ideaArea))
    .sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || b.created - a.created);
  let h = `<form class="capture" data-form="idea">
    <textarea name="text" placeholder="Capture an idea: a design, a feature, a new side project…" required rows="2"></textarea>
    <div class="row gap" style="margin-top:8px"><select name="areaId">${areaOptions('', { blank: 'No area yet' })}</select>
    <button class="btn small">Save</button></div>
    <details class="more"><summary>Add a link</summary><input name="link" type="url" placeholder="https://…"></details>
  </form>`;
  h += `<div class="chips">${chip('all', 'All', null, 'idea-filter', UI.ideaArea)}${S.areas.map(a => chip(a.id, a.name, a.color, 'idea-filter', UI.ideaArea)).join('')}${chip('none', 'Unsorted', null, 'idea-filter', UI.ideaArea)}</div>`;
  h += list.length ? list.map(i => {
    const a = area(i.areaId);
    return `<button class="idea" data-a="edit-idea" data-id="${i.id}" style="--c:${a ? a.color : 'var(--line)'}">
      <span class="idea-text">${i.starred ? '<span class="pri">★</span>' : ''}${esc(i.text)}</span>
      <span class="meta">${esc(a ? a.name : 'Unsorted')} · ${fmtAgo(i.created)}${i.link ? ' · 🔗 link' : ''}</span></button>`;
  }).join('') : `<div class="empty">Nothing here yet. Ideas you capture land here until you're ready to turn them into a project or task.</div>`;
  return h;
}

function viewWeek() {
  const ws = addDays(weekStart(new Date()), UI.weekOffset * 7), today = todayKey();
  const label = UI.weekOffset === 0 ? 'This week' : UI.weekOffset === 1 ? 'Next week' : UI.weekOffset === -1 ? 'Last week' : '';
  let h = `<div class="weeknav"><button class="arrow" data-a="week" data-d="-1" aria-label="Previous week">‹</button>
    <div style="text-align:center"><strong>${fmtRange(ws)}</strong>${label ? `<div class="meta">${label}</div>` : ''}</div>
    <button class="arrow" data-a="week" data-d="1" aria-label="Next week">›</button></div>
    <div class="row gap"><button class="btn" style="flex:1" data-a="plan" data-week="${dkey(ws)}">Plan evenings</button><button class="btn ghost" data-a="review-week" data-o="${Math.min(0, UI.weekOffset)}">Review</button></div>`;
  const review = reviewSlot(addDays(ws, 6));
  h += `<div class="days">`;
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i), k = dkey(d), away = isAway(k);
    const blocks = S.blocks.filter(b => b.date === k).sort((a, b) => a.start.localeCompare(b.start));
    const evs = calEvents(k);
    h += `<div class="day ${k === today ? 'today' : ''} ${away ? 'away' : ''}">
      <div class="day-head"><span class="day-name">${DOW[d.getDay()]} <span class="day-num">${d.getDate()}</span></span>
        <span class="row">${away ? `<button class="away-btn on" data-a="toggle-away" data-date="${k}">✈ Away</button>` : ''}
        <button class="add-block" data-a="new-block" data-date="${k}" aria-label="Add block">+</button></span></div>
      ${evs.map(calEventLine).join('')}
      ${blocks.map(blockCard).join('')}
      ${(() => { const n = S.tasks.filter(t => t.day === k && !t.done).length; return n && k >= today ? `<div class="day-tasks">${n} task${n > 1 ? 's' : ''} planned</div>` : ''; })()}
      ${review.date === k ? `<button class="review-slot" data-a="review-week" data-o="${UI.weekOffset}">${fmtTime(review.start)} · Weekly review</button>` : ''}
    </div>`;
  }
  h += `</div>`;
  return h;
}

// Sunday review lands on Sunday evening, or Monday evening if you're away on Sunday
function reviewSlot(sunday) {
  const k = dkey(sunday);
  if (!isAway(k)) return { date: k, start: S.settings.reviewTime };
  return { date: dkey(addDays(sunday, 1)), start: S.settings.eveningStart };
}

function viewReview() {
  const ws = addDays(weekStart(new Date()), UI.reviewOffset * 7), wk = dkey(ws);
  const s0 = ws.getTime(), e0 = addDays(ws, 7).getTime();
  const logged = minutesByArea(ws), planned = plannedByArea(ws);
  const doneTasks = S.tasks.filter(t => t.doneAt >= s0 && t.doneAt < e0);
  const total = Object.values(logged).reduce((a, b) => a + b, 0);
  const evenings = new Set(S.sessions.filter(x => x.start >= s0 && x.start < e0).map(x => dkey(new Date(x.start)))).size;
  const r = S.reviews[wk] || {};
  const today = todayKey();

  let h = `<button class="back" data-a="tab" data-v="week">‹ Week</button><div class="weeknav"><button class="arrow" data-a="rweek" data-d="-1" aria-label="Previous week">‹</button>
    <div style="text-align:center"><strong>${fmtRange(ws)}</strong><div class="meta">${UI.reviewOffset === 0 ? 'This week' : UI.reviewOffset === -1 ? 'Last week' : ''}</div></div>
    <button class="arrow" data-a="rweek" data-d="1" ${UI.reviewOffset >= 0 ? 'disabled style="opacity:.3"' : ''} aria-label="Next week">›</button></div>`;
  h += `<div class="stats"><div class="stat"><b>${doneTasks.length}</b><span>tasks done</span></div>
    <div class="stat"><b>${fmtDur(total)}</b><span>focused</span></div>
    <div class="stat"><b>${evenings}</b><span>days worked</span></div></div>`;

  const kinds = [...Array(7)].map((_, i) => { const d = addDays(ws, i); return { d, e: eveningKind(dkey(d)) }; });
  const cnt = e => kinds.filter(x => x.e === e).length;
  const SYM = { full: '●', light: '◐', rest: '○', away: '✈', '': '·' };
  const LBL = { full: 'worked', light: 'light', rest: 'rest', away: 'away', '': '' };
  h += `<h3>Your evenings</h3><div class="evenings">${kinds.map(x => `<div class="ev ${x.e || 'none'}"><span class="sym">${SYM[x.e]}</span><span class="dow">${DOW[x.d.getDay()][0]}</span><span class="lbl">${LBL[x.e]}</span></div>`).join('')}</div>`;
  const parts = [cnt('full') && `${cnt('full')} worked`, cnt('light') && `${cnt('light')} light`, cnt('rest') && `${cnt('rest')} rest`].filter(Boolean);
  const lows = lowEnergyDays();
  h += `<p class="meta">${parts.length ? parts.join(' · ') + '. Rest nights are part of the plan, not a miss.' : 'Nothing logged yet this week.'}</p>`;
  if (lows.length) h += `<p class="insight">${lows.map(d => DAYS[d] + 's').join(' and ')} are often low-energy for you, so the planner keeps those evenings light.</p>`;
  h += `<h3>Time balance</h3><div>${S.areas.map(a => bar(a, logged[a.id] || 0, planned[a.id] || 0)).join('')}
    <div class="legend">Solid = logged · faint = planned · full bar = weekly target</div>
    <button class="link muted" data-a="log-time" style="margin-top:10px">+ Log time you forgot to track</button></div>`;


  const stuck = S.projects.filter(p => !isFinalStage(p) && Date.now() - lastActivity(p) > 10 * 864e5);
  const overdue = openTasks().filter(t => (t.due && t.due < today) || carriedDays(t) >= 3);
  const fu = dueFollowUps();
  if (stuck.length || overdue.length || fu.length) {
    h += `<h3>Needs attention</h3>`;
    if (stuck.length) h += `<div class="meta" style="margin:0 2px">No movement in 10+ days: move them forward, pause them, or drop them.</div>${stuck.map(projectCard).join('')}`;
    if (overdue.length) h += `<div class="list">${overdue.map(t => taskRow(t)).join('')}</div>`;
    if (fu.length) h += `<div class="list">${fu.map(personRow).join('')}</div>`;
  }

  const ideas = S.ideas.filter(i => !area(i.areaId)).length;
  if (ideas) h += `<button class="nudge" data-a="tab" data-v="ideas">💡 ${ideas} unsorted idea${ideas > 1 ? 's' : ''} to sort →</button>`;

  h += `<h3>Reflect</h3><form data-form="review" data-week="${wk}">
    <label>What went well?<textarea name="wins" placeholder="Finished the prototype housing, emailed two mentors…">${esc(r.wins)}</textarea></label>
    <label>What got in the way?<textarea name="blockers" placeholder="Late meetings, too many things in one evening…">${esc(r.blockers)}</textarea></label>
    <label>The one thing that matters most next week<input name="focus" value="${esc(r.focus)}" placeholder="e.g. Book first mentor call"></label>
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
  hydrateImages();
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

function whenOf(t) {
  const k = todayKey(), tom = dkey(addDays(new Date(), 1));
  if (!t.day) return '';
  return t.day <= k ? 'today' : t.day === tom ? 'tomorrow' : 'later';
}
function openTask(id, def = {}) {
  const t = id ? task(id) : { day: def.day === undefined ? todayKey() : def.day, title: def.title || '', areaId: def.areaId || S.areas[0].id, projectId: def.projectId || null, due: '', est: '', priority: 'normal', notes: def.notes || '', energy: '' };
  if (!t) return;
  const sel = t.projectId ? 'proj:' + t.projectId : 'area:' + t.areaId;
  const inTop = id && (S.top3[todayKey()] || []).includes(id);
  const est = [15, 30, 45, 60, 90, 120, 180];
  sheet(`<form data-form="task" data-id="${id || ''}" data-idea="${def.ideaId || ''}">
    <h2>${id ? 'Edit task' : 'New task'}</h2>
    <label>Task<input name="title" required value="${esc(t.title)}" placeholder="e.g. Test prototype battery life" ${id ? '' : 'autofocus'}></label>
    <label>Project<select name="target">${areaOptions(sel, { withProjects: true })}</select></label>
    <label>When<div class="seg">${[['today', 'Today'], ['tomorrow', 'Tomorrow'], ['', 'Someday']].map(([v, l]) => `<label><input type="radio" name="when" value="${v}" ${whenOf(t) === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></label>
    ${id && carriedDays(t) >= 3 && !t.done ? `<div class="stale-note">This has rolled over ${carriedDays(t)} days. Try breaking it into something smaller, or move it off today:
      <div class="row gap" style="margin-top:8px"><button type="button" class="link" data-a="task-when" data-id="${id}" data-v="tomorrow">Tomorrow</button><button type="button" class="link" data-a="task-when" data-id="${id}" data-v="">Someday</button></div></div>` : ''}
    <label>Due date (optional)<input type="date" name="due" value="${esc(t.due)}"></label>
    <label class="check-label"><input type="checkbox" name="quick" ${isLight(t) ? 'checked' : ''}> Quick task <span class="meta">(30 min or less, good for light nights)</span></label>
    <label class="check-label"><input type="checkbox" name="top3" ${inTop ? 'checked' : ''}> Add to tonight's Top 3</label>
    <details class="more" ${t.notes || (S.settings.extraFields && (t.est || t.energy === 'deep' || (t.priority && t.priority !== 'normal'))) ? 'open' : ''}><summary>${S.settings.extraFields ? 'More details' : 'Notes'}</summary>
    ${S.settings.extraFields ? `<div class="two" style="margin-top:10px">
      <label>Time needed<select name="est"><option value="">None</option>${est.map(m => `<option value="${m}" ${+t.est === m ? 'selected' : ''}>${fmtDur(m)}</option>`).join('')}</select></label>
      <label>Priority<select name="priority">${['low', 'normal', 'high'].map(p => `<option value="${p}" ${(t.priority || 'normal') === p ? 'selected' : ''}>${p[0].toUpperCase() + p.slice(1)}</option>`).join('')}</select></label>
    </div>` : `<input type="hidden" name="est" value="${esc(t.est)}"><input type="hidden" name="priority" value="${esc(t.priority || 'normal')}">`}
    <label style="margin-top:10px">Notes<textarea name="notes" placeholder="Links, measurements, ideas…">${esc(t.notes)}</textarea></label>
    </details>
    ${id && !t.done && !(S.timer && S.timer.taskId === id) ? `<button type="button" class="btn ghost wide" data-a="start-timer" data-id="${id}" style="margin-top:6px">▶ Start focus timer</button>` : ''}
    <div class="sheet-actions">
      ${id ? `<button type="button" class="btn ghost danger" data-a="del-task" data-id="${id}">Delete</button>` : ''}
      <button class="btn">${id ? 'Save' : 'Add task'}</button>
    </div>
  </form>`);
}

function openProject(id, areaId, def = {}) {
  const p = id ? project(id) : { name: def.name || '', areaId: areaId || S.areas[0].id, stage: null, notes: def.notes || '', due: '' };
  if (!p) return closeSheet();
  const a = area(p.areaId) || S.areas[0];
  const si = Math.max(0, a.stages.indexOf(p.stage));
  let h = `<form data-form="project" data-id="${id || ''}" data-idea="${def.ideaId || ''}"><h2>${id ? esc(p.name) : 'New project'}</h2>`;
  if (id) {
    h += `<div class="meta">${a.pipe === false ? 'Status' : 'Stage: tap to move it along'}</div><div class="stages" style="--c:${a.color}">${a.stages.map((s, i) =>
      `<button type="button" class="${i === si ? 'on' : i < si && a.pipe !== false ? 'past' : ''}" data-a="set-stage" data-id="${id}" data-i="${i}">${esc(s)}</button>`).join('')}</div>`;
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
  const fabs = id ? S.fabrics.filter(f => f.projectId === id) : [];
  if (fabs.length) h += `<h3>Fabrics</h3><div class="fab-grid small">${fabs.map(fabricCard).join('')}</div>`;
  sheet(h, id ? () => openProject(id) : null);
}

function openPerson(id, areaId) {
  const p = id ? person(id) : { name: '', role: '', areaId: areaId || 'startup', status: 'To contact', next: '', notes: '', contact: '' };
  if (!p) return closeSheet();
  sheet(`<form data-form="person" data-id="${id || ''}">
    <h2>${id ? esc(p.name) : 'New person'}</h2>
    <label>Name<input name="name" required value="${esc(p.name)}" placeholder="e.g. Dr. Patel" ${id ? '' : 'autofocus'}></label>
    <label>Who they are<input name="role" value="${esc(p.role)}" placeholder="e.g. Cardiologist, mentor from accelerator"></label>
    <label>Email / phone / LinkedIn<input name="contact" value="${esc(p.contact)}"></label>
    <div class="two"><label>Area<select name="areaId">${areaOptions(p.areaId)}</select></label>
    <label>Status<select name="status">${PEOPLE_STATUS.map(s => `<option ${p.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label></div>
    <label>Next follow-up<input type="date" name="next" value="${esc(p.next)}"></label>
    ${id ? `<div class="row gap" style="margin:-4px 0 12px"><button type="button" class="btn ghost small" data-a="log-contact" data-id="${id}">✓ Contacted today</button><span class="meta">${p.last ? `Last contact ${fmtDay(p.last).toLowerCase()}` : 'Sets a follow-up for a week from now'}</span></div>` : ''}
    <label>Notes<textarea name="notes" placeholder="What you talked about, what they suggested, intros offered…">${esc(p.notes)}</textarea></label>
    <div class="sheet-actions">${id ? `<button type="button" class="btn ghost danger" data-a="del-person" data-id="${id}">Delete</button>` : ''}<button class="btn">${id ? 'Save' : 'Add person'}</button></div>
  </form>`);
}

function openIdea(id) {
  const i = S.ideas.find(x => x.id === id);
  if (!i) return;
  sheet(`<form data-form="idea-edit" data-id="${id}">
    <h2>Idea</h2>
    <label>Idea<textarea name="text" required>${esc(i.text)}</textarea></label>
    <label>Area<select name="areaId">${areaOptions(i.areaId || '', { blank: 'Unsorted' })}</select></label>
    <label>Link<input name="link" type="url" value="${esc(i.link)}"></label>
    ${i.link ? `<p style="margin:-4px 2px 12px"><a class="link" href="${esc(i.link)}" target="_blank" rel="noopener">Open link ↗</a></p>` : ''}
    <label class="check-label"><input type="checkbox" name="starred" ${i.starred ? 'checked' : ''}> ★ Star (keeps it at the top)</label>
    <div class="sheet-actions"><button type="button" class="btn ghost danger" data-a="del-idea" data-id="${id}">Delete</button><button class="btn">Save</button></div>
  </form>
  <h3>Ready to act on it?</h3>
  <div class="row gap"><button class="btn ghost small" data-a="idea-to-project" data-id="${id}">→ Make it a project</button><button class="btn ghost small" data-a="idea-to-task" data-id="${id}">→ Make it a task</button></div>`);
}

function photoStrip(ids) {
  return ids.map(i => `<div class="ph"><img data-img="img:${i}" alt=""><button type="button" class="ph-x" data-a="rm-photo" data-id="${i}" aria-label="Remove photo">×</button></div>`).join('')
    || '<div class="ph empty-ph">No photos yet</div>';
}
function openFabric(id) {
  const f = id ? fabric(id) : { name: '', fiber: '', color: '', amount: '', source: '', status: 'In stash', projectId: '', plans: '', photos: [] };
  if (!f) return closeSheet();
  const projOpts = S.areas.map(a => {
    const ps = S.projects.filter(p => p.areaId === a.id);
    return ps.length ? `<optgroup label="${esc(a.name)}">${ps.map(p => `<option value="${p.id}" ${f.projectId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</optgroup>` : '';
  }).join('');
  sheet(`<form data-form="fabric" data-id="${id || ''}">
    <h2>${id ? esc(f.name || 'Fabric') : 'Add fabric'}</h2>
    <div class="photo-strip" id="photo-strip">${photoStrip(f.photos || [])}</div>
    <input type="hidden" name="photos" value="${esc((f.photos || []).join(','))}">
    <label class="btn ghost small photo-add">📷 Add photos<input class="vh" type="file" accept="image/*" multiple data-photo></label>
    <label>Name<input name="name" value="${esc(f.name)}" placeholder="e.g. Sage washed linen"></label>
    <div class="two"><label>Fiber / type<input name="fiber" value="${esc(f.fiber)}" placeholder="Linen, silk, denim…"></label>
      <label>Amount<input name="amount" value="${esc(f.amount)}" placeholder="e.g. 3 yd × 54in"></label></div>
    <div class="two"><label>Color / print<input name="color" value="${esc(f.color)}" placeholder="e.g. Sage, gingham"></label>
      <label>Status<select name="status">${FABRIC_STATUS.map(x => `<option ${f.status === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label></div>
    <label>What I want to make with it<textarea name="plans" placeholder="e.g. Wide-leg trousers, or lining for the spring jacket">${esc(f.plans)}</textarea></label>
    <label>For a project<select name="projectId"><option value="">None</option>${projOpts}</select></label>
    <label>Where from / cost<input name="source" value="${esc(f.source)}" placeholder="e.g. Mood Fabrics, $14/yd"></label>
    <div class="sheet-actions">${id ? `<button type="button" class="btn ghost danger" data-a="del-fabric" data-id="${id}">Delete</button>` : ''}<button class="btn">${id ? 'Save' : 'Add to closet'}</button></div>
  </form>`);
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
    <label>Focus (optional)<input name="title" value="${esc(b.title)}" placeholder="e.g. Finish sensor calibration"></label>
    ${id && !S.sync ? `<div class="row gap" style="margin:4px 0 8px"><a class="btn ghost small" href="${gcalLink(b)}" target="_blank" rel="noopener">Google Calendar</a><button type="button" class="btn ghost small" data-a="ics-block" data-id="${id}">Apple / .ics</button></div>` : ''}
    <div class="sheet-actions">${id ? `<button type="button" class="btn ghost danger" data-a="del-block" data-id="${id}">Delete</button>` : ''}<button class="btn">${id ? 'Save' : 'Add block'}</button></div>
  </form>
  ${id ? '' : `<p class="foot"><button class="link muted" data-a="toggle-away" data-date="${esc(b.date)}">${isAway(b.date) ? 'Not away this day' : '✈ Away this day? Mark it and skip planning'}</button></p>`}`);
}

function suggestPlan(nHalves) {
  // Hand out evening halves by remaining weekly target, then group them so each
  // area gets whole evenings where possible (less context switching).
  const half = eveningMin() / 2 / 60;
  const rem = Object.fromEntries(S.areas.map(a => [a.id, +a.target || 0]));
  const count = {};
  for (let i = 0; i < nHalves; i++) {
    let best = null;
    S.areas.forEach(a => { if (rem[a.id] > 0 && (best === null || rem[a.id] > rem[best])) best = a.id; });
    if (!best) break;
    rem[best] -= half; count[best] = (count[best] || 0) + 1;
  }
  const seq = [];
  S.areas.slice().sort((a, b) => (count[b.id] || 0) - (count[a.id] || 0)).forEach(a => { for (let i = 0; i < (count[a.id] || 0); i++) seq.push(a.id); });
  return seq;
}

function openPlanner(wk) {
  const ws = parseKey(wk), s = S.settings;
  const mid = fromMin(toMin(s.eveningStart) + Math.round(eveningMin() / 2));
  const lowDays = lowEnergyDays();
  const days = [...Array(7)].map((_, i) => {
    const d = addDays(ws, i), k = dkey(d), away = isAway(k);
    const busyA = eveningOverlap(k, s.eveningStart, mid) >= 30, busyB = eveningOverlap(k, mid, s.eveningEnd) >= 30;
    const low = lowDays.includes(d.getDay());
    return { d, k, away, low, busy: [busyA, busyB], open: isWorkDay(d) && !away ? [!busyA, !busyB && !low] : [false, false] };
  });
  const seq = suggestPlan(days.reduce((n, x) => n + x.open.filter(Boolean).length, 0));
  let si = 0;
  const opts = sel => `<option value="">-</option>` + S.areas.map(a => `<option value="${a.id}" ${sel === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
  const rows = days.map((x, i) => {
    const existing = S.blocks.filter(b => b.date === x.k && b.planned).sort((a, b) => a.start.localeCompare(b.start));
    let pair = ['', ''];
    if (existing.length) {
      pair = [existing.find(b => b.start < mid), existing.find(b => b.end > mid)].map(b => (b ? b.areaId : ''));
    } else pair = x.open.map(o => (o ? seq[si++] || '' : ''));
    const evs = calEvents(x.k).filter(e => !e.allDay);
    const note = x.away ? `✈ ${esc(awayReason(x.k) || 'Away')}` : [x.low && isWorkDay(x.d) ? 'Usually low-energy, so kept light' : '', ...evs.map(e => `${fmtTime(hhmm(e.s))} ${esc(e.title)}`)].filter(Boolean).join(' · ');
    return `<div class="plan-row"><span class="${isWorkDay(x.d) && !x.away ? '' : 'meta'}">${DOW[x.d.getDay()]} ${x.d.getDate()}</span>
      <select name="a${i}">${opts(pair[0])}</select><select name="b${i}">${opts(pair[1])}</select></div>
      ${note ? `<div class="plan-note">${note}</div>` : ''}`;
  }).join('');
  sheet(`<form data-form="plan" data-week="${wk}">
    <h2>Plan your evenings</h2>
    <p class="meta" style="margin-top:-8px">Week of ${fmtRange(ws)}. Suggestions come from your weekly targets, with whole evenings per area where possible.${S.cal.events.length ? ' Away days and busy evenings from Apple Calendar are left free.' : ''} Change anything you like.</p>
    <div class="plan-head"><span></span><span>${fmtTime(s.eveningStart)}–${fmtTime(mid)}</span><span>${fmtTime(mid)}–${fmtTime(s.eveningEnd)}</span></div>
    ${rows}
    <p class="meta">Blocks you added by hand stay put. Re-planning replaces only the blocks the planner made.</p>
    <div class="sheet-actions"><button class="btn">Save plan</button></div>
  </form>`);
}

function openFocusPicker() {
  const k = todayKey();
  const top = (S.top3[k] || []).map(task).filter(t => t && !t.done);
  const rest = openTasks().filter(t => !top.includes(t)).sort(taskSort).slice(0, 15);
  const pick = t => { const a = area(t.areaId); return `<button class="pick" data-a="start-timer" data-id="${t.id}"><i class="dot" style="background:${a ? a.color : '#888'}"></i>${esc(t.title)}<span class="meta">${esc((project(t.projectId) || {}).name || '')}</span></button>`; };
  sheet(`<h2>What are you working on?</h2>
    ${top.length ? `<h3>Top 3</h3>${top.map(pick).join('')}` : ''}
    <h3>A whole area</h3><div class="area-picks">${S.areas.map(a => `<button class="chip" data-a="focus-area" data-area="${a.id}"><i class="dot" style="background:${a.color}"></i>${esc(a.name)}</button>`).join('')}</div>
    ${rest.length ? `<h3>A task</h3>${rest.map(pick).join('')}` : ''}`);
}

function openTodayPicker() {
  const k = todayKey(), tops = S.top3[k] || [];
  const list = openTasks().sort((a, b) => ((b.day === k) - (a.day === k)) || taskSort(a, b));
  sheet(`<h2>Plan today</h2><p class="meta" style="margin-top:-8px">Tap a task to add it to today. Tap ★ to make it one of your Top 3 (${tops.length}/3).</p>
    ${list.map(t => { const a = area(t.areaId), on = t.day === k, star = tops.includes(t.id); return `<div class="pick ${on ? 'on' : ''}">
      <button class="pick-main" data-a="toggle-today" data-id="${t.id}"><i class="dot" style="background:${a ? a.color : '#888'}"></i>${esc(t.title)}<span class="meta">${esc((project(t.projectId) || a || {}).name || '')}</span></button>
      <button class="star ${star ? 'on' : ''}" data-a="toggle-top3" data-id="${t.id}" aria-label="Top 3">${star ? '★' : '☆'}</button></div>`; }).join('') || '<div class="empty">Add some tasks first with the + button.</div>'}
    <div class="sheet-actions"><button class="btn" data-a="close-sheet">Done</button></div>`, openTodayPicker);
}

function openTop3Picker() {
  const k = todayKey(), sel = S.top3[k] || [];
  const tonight = new Set(S.blocks.filter(b => b.date === k).map(b => b.areaId));
  const list = openTasks().sort((a, b) => (tonight.has(b.areaId) - tonight.has(a.areaId)) || taskSort(a, b));
  sheet(`<h2>Tonight's Top 3</h2><p class="meta" style="margin-top:-8px">${sel.length}/3 picked${tonight.size ? ". Tasks for tonight's areas are listed first." : ''}</p>
    ${list.map(t => { const a = area(t.areaId); return `<button class="pick ${sel.includes(t.id) ? 'on' : ''}" data-a="toggle-top3" data-id="${t.id}"><i class="dot" style="background:${a ? a.color : '#888'}"></i>${esc(t.title)}<span class="meta">${sel.includes(t.id) ? '★' : esc((project(t.projectId) || a || {}).name || '')}</span></button>`; }).join('') || '<div class="empty">Add some tasks first with the + button.</div>'}
    <div class="sheet-actions"><button class="btn" data-a="close-sheet">Done</button></div>`, openTop3Picker);
}

function openLogTime() {
  sheet(`<form data-form="log"><h2>Log time</h2><p class="meta" style="margin-top:-8px">Forgot the timer? Add the time here.</p>
    <label>Worked on<select name="target">${areaOptions('', { withProjects: true })}</select></label>
    <div class="two"><label>Date<input type="date" name="date" value="${todayKey()}" required></label>
    <label>Minutes<input type="number" name="min" min="1" step="5" value="60" inputmode="numeric" required></label></div>
    <div class="sheet-actions"><button class="btn">Log it</button></div></form>`);
}

function calendarSettings() {
  const exp = `<p><button class="link muted" data-a="ics-week" data-week="${dkey(weekStart(new Date()))}">Export this week as a calendar file</button></p>`;
  if (!SYNC_URL) return `<p class="meta">Calendar sync isn't set up yet.</p>` + exp;
  if (!S.sync) {
    return `<p class="meta" style="margin-top:-4px">Two-way sync with Apple Calendar:</p>
      <ul class="meta steps"><li>Your evening blocks, Sunday review and follow-ups appear in Apple Calendar, with alerts on your phone.</li>
      <li>Your Apple events show up here. Trips mark you away, and the planner keeps busy evenings free.</li></ul>
      <button class="btn small" data-a="cal-connect">Connect Apple Calendar</button>${exp}`;
  }
  const feed = `${SYNC_URL.replace(/^https?:/, 'webcal:')}/cal/${S.sync.feedId}.ics`;
  const st = S.sync.lastErr ? `<span class="overdue">⚠ ${esc(S.sync.lastErr)}</span>` : S.sync.lastSync ? `Plan synced ${fmtAgo(S.sync.lastSync) === 'today' ? 'today at ' + fmtTime(hhmm(S.sync.lastSync)) : fmtAgo(S.sync.lastSync)}` : 'Not synced yet';
  const errs = (S.cal.errors || []);
  return `<div class="cal-step"><b>1 · Your plan → Apple Calendar</b>
      <p class="meta">Tap Subscribe and confirm on your iPhone. <b>Turn off "Remove Alerts"</b> so reminders come through.</p>
      <div class="row gap"><a class="btn small" href="${feed}">Subscribe in Apple Calendar</a><button type="button" class="btn ghost small" data-a="copy" data-text="${esc(feed.replace(/^webcal:/, 'https:'))}">Copy link</button></div>
      <label style="margin-top:12px">Alert before each block<select data-a-change="reminder">${[0, 5, 10, 15, 30].map(m => `<option value="${m}" ${+S.settings.reminderMin === m ? 'selected' : ''}>${m ? m + ' min before' : 'At start time'}</option>`).join('')}</select></label>
      <p class="meta" style="margin:0">${st}</p></div>
    <div class="cal-step"><b>2 · Apple Calendar → After Hours</b>
      <p class="meta">In the iPhone <b>Calendar</b> app, tap <b>Calendars</b>, tap ⓘ next to a calendar, turn on <b>Public Calendar</b>, then tap <b>Share Link… → Copy</b> and paste it below. Add one link per calendar (e.g. Home, Travel). Anyone with a public link can view that calendar, so keep it to yourself.</p>
      ${S.sync.calUrls.map((u, i) => `<div class="row gap cal-url"><span class="meta">📅 Calendar ${i + 1}${errs.find(e => e.i === i) ? ` <span class="overdue">⚠ ${esc(errs.find(e => e.i === i).error)}</span>` : ''}</span><button type="button" class="meta" data-a="cal-remove" data-i="${i}" style="margin-left:auto;color:var(--danger)">Remove</button></div>`).join('')}
      <form data-form="calurl" class="row gap"><input name="url" placeholder="webcal://p…-caldav.icloud.com/published/…" required><button class="btn small">Add</button></form>
      <p class="meta" style="margin:8px 0 0">${S.sync.calUrls.length ? `${S.cal.events.length} events loaded${S.cal.fetchedAt ? ', updated ' + (fmtAgo(S.cal.fetchedAt) === 'today' ? fmtTime(hhmm(S.cal.fetchedAt)) : fmtAgo(S.cal.fetchedAt)) : ''}` : ''}</p></div>
    <div class="row gap"><button type="button" class="btn ghost small" data-a="cal-refresh">Sync now</button><button type="button" class="btn ghost small danger" data-a="cal-disconnect">Disconnect</button></div>`;
}

function openSettings() {
  const s = S.settings;
  sheet(`<form data-form="settings"><h2>Settings</h2>
    <h3 style="margin-top:0">Your day</h3>
    <div class="two"><label>Evening starts<input type="time" name="eveningStart" value="${s.eveningStart}"></label><label>Evening ends<input type="time" name="eveningEnd" value="${s.eveningEnd}"></label></div>
    <div class="two"><label>Work starts<input type="time" name="workStart" value="${s.workStart}"></label><label>Work ends<input type="time" name="workEnd" value="${s.workEnd}"></label></div>
    <label>Work days</label><div class="area-picks" style="margin:-6px 0 14px">${[1, 2, 3, 4, 5, 6, 0].map(d => `<label class="chip check-label" style="margin:0;gap:6px"><input type="checkbox" name="wd" value="${d}" ${s.workDays.includes(d) ? 'checked' : ''}>${DOW[d]}</label>`).join('')}</div>
    <label>Sunday review time<input type="time" name="reviewTime" value="${s.reviewTime}"></label>
    <label class="check-label" style="margin-bottom:14px"><input type="checkbox" name="extraFields" ${s.extraFields ? 'checked' : ''}> Extra task fields (time needed, priority)</label>
    <label>Appearance<div class="seg">${[['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<label><input type="radio" name="theme" value="${v}" ${(s.theme || 'system') === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></label>
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
  <h3>Apple Calendar</h3>
  ${calendarSettings()}
  <h3>Backup</h3>
  <p class="meta" style="margin-top:-4px">Your projects and tasks are stored on this device only. Export a backup now and then (e.g. to iCloud Drive).</p>
  <div class="row gap"><button class="btn ghost small" data-a="export">Export backup</button><button class="btn ghost small" data-a="import">Import backup</button></div>
  <h3>Danger zone</h3><button class="btn ghost small danger" data-a="reset">Erase everything</button>`, openSettingsKeepScroll);
}
function openSettingsKeepScroll() {
  const p = $('.sheet-panel'), y = p.scrollTop;
  openSettings();
  p.scrollTop = y;
}

/* ---------- Calendar files ---------- */
const icsDate = (k, t) => k.replace(/-/g, '') + 'T' + t.replace(':', '') + '00';
const icsDay = k => k.replace(/-/g, '');
const icsEsc = s => String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
const fold = line => { const c = Array.from(line); if (c.length <= 73) return line; const out = []; for (let i = 0; i < c.length; i += 72) out.push(c.slice(i, i + 72).join('')); return out.join('\r\n '); };
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
function vevent({ id, date, start, end, allDay, title, desc, alarm, alarmAt }) {
  const L = ['BEGIN:VEVENT', `UID:${id}@afterhours`, `DTSTAMP:${icsDay(todayKey())}T000000Z`];
  if (allDay) L.push(`DTSTART;VALUE=DATE:${icsDay(date)}`, `DTEND;VALUE=DATE:${icsDay(dkey(addDays(parseKey(date), 1)))}`, 'TRANSP:TRANSPARENT');
  else L.push(`DTSTART:${icsDate(date, start)}`, `DTEND:${icsDate(date, end)}`);
  L.push(`SUMMARY:${icsEsc(title)}`);
  if (desc) L.push(`DESCRIPTION:${icsEsc(desc)}`);
  if (alarm != null || alarmAt != null) {
    const trig = allDay ? `TRIGGER:PT${Math.floor(alarmAt / 60)}H${alarmAt % 60}M` : `TRIGGER:-PT${alarm}M`;
    L.push('BEGIN:VALARM', trig, 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(title)}`, 'END:VALARM');
  }
  L.push('END:VEVENT');
  return L.map(fold).join('\r\n');
}
const blockEvent = b => { const { title, desc } = blockText(b); return vevent({ id: b.id, date: b.date, start: b.start, end: b.end, title, desc, alarm: +S.settings.reminderMin || 0 }); };
function calendar(events, extra = []) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//After Hours//EN', 'CALSCALE:GREGORIAN', ...extra, ...events, 'END:VCALENDAR'].join('\r\n');
}
function feedIcs() {
  const s = S.settings, from = dkey(addDays(new Date(), -14)), ev = [];
  S.blocks.filter(b => b.date >= from && !b.skipped).forEach(b => ev.push(blockEvent(b)));
  for (let w = 0; w < 6; w++) {
    const sun = addDays(weekStart(new Date()), 6 + 7 * w), slot = reviewSlot(sun);
    ev.push(vevent({ id: 'review-' + dkey(sun), date: slot.date, start: slot.start, end: fromMin(Math.min(toMin(slot.start) + 20, 1439)),
      title: 'After Hours · Weekly review & plan', desc: 'Open After Hours → Review. 10 minutes: look back, then plan next week’s evenings.', alarm: 0 }));
  }
  S.people.filter(p => p.next && !CLOSED_STATUS.includes(p.status)).forEach(p => ev.push(vevent({
    id: 'fu-' + p.id, date: p.next, allDay: true, title: `Follow up: ${p.name}`, desc: [p.role, p.contact].filter(Boolean).join('\n'), alarmAt: toMin(s.eveningStart),
  })));
  return calendar(ev, ['METHOD:PUBLISH', 'X-WR-CALNAME:After Hours', 'X-APPLE-CALENDAR-COLOR:#F4B86A', 'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M']);
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ---------- Apple Calendar sync ---------- */
const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0; return h; };
const api = (path, opts = {}) => fetch(SYNC_URL + path, { ...opts, headers: { Authorization: 'Bearer ' + S.sync.token, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
let pushTimer;
function schedulePush() { if (S.sync && SYNC_URL) { clearTimeout(pushTimer); pushTimer = setTimeout(() => pushFeed(), 1500); } }
async function pushFeed(force) {
  if (!S.sync || !SYNC_URL) return false;
  const body = JSON.stringify({ feedId: S.sync.feedId, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, calUrls: S.sync.calUrls, ics: feedIcs() });
  const h = hash(body);
  if (!force && h === S.sync.lastHash) return true;
  try {
    const r = await api('/api/sync', { method: 'PUT', body });
    if (!r.ok) throw new Error('Sync server error ' + r.status);
    Object.assign(S.sync, { lastHash: h, lastSync: Date.now(), lastErr: '' });
    save();
    return true;
  } catch (e) {
    S.sync.lastErr = navigator.onLine === false ? "Offline: it'll sync when you're back online" : String(e.message || e);
    save();
    return false;
  }
}
async function pullEvents(force) {
  if (!S.sync || !SYNC_URL || !S.sync.calUrls.length) return;
  if (!force && Date.now() - (S.cal.fetchedAt || 0) < 10 * 60e3) return;
  try {
    const r = await api('/api/events');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    S.cal = { events: d.events || [], errors: d.errors || [], fetchedAt: d.fetchedAt || Date.now() };
    save(); render(); schedulePush(); // away days may have changed the review slot
  } catch (e) { /* keep the last copy of events */ }
}

/* ---------- Photos (IndexedDB: plenty of room, unlike localStorage) ---------- */
const IDB = (() => {
  let dbp;
  const db = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('afterhours-media', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('images');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const run = (mode, fn) => db().then(d => new Promise((res, rej) => {
    const t = d.transaction('images', mode), req = fn(t.objectStore('images'));
    t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error);
  }));
  return { get: k => run('readonly', st => st.get(k)), put: (k, v) => run('readwrite', st => st.put(v, k)), del: k => run('readwrite', st => st.delete(k)), keys: () => run('readonly', st => st.getAllKeys()) };
})();
async function compressImage(blob, max) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.82));
  } finally { URL.revokeObjectURL(url); }
}
const storePhoto = async (id, full, thumb) => { await IDB.put('img:' + id, full); await IDB.put('thumb:' + id, thumb); };
const deletePhoto = id => { IDB.del('img:' + id).catch(() => {}); IDB.del('thumb:' + id).catch(() => {}); };
const blobToDataURL = b => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
const imgURLs = {};
function hydrateImages() {
  document.querySelectorAll('img[data-img]:not([src])').forEach(async el => {
    const k = el.dataset.img;
    try {
      if (!imgURLs[k]) { const b = await IDB.get(k); if (!b) return; imgURLs[k] = URL.createObjectURL(b); }
      el.src = imgURLs[k];
    } catch (e) { /* photo unavailable */ }
  });
}
async function addPhotos(input) {
  const form = input.closest('form'), hid = form.querySelector('[name=photos]');
  const ids = hid.value ? hid.value.split(',') : [];
  const files = [...input.files];
  input.value = '';
  if (!files.length) return;
  toast(files.length > 1 ? `Adding ${files.length} photos…` : 'Adding photo…');
  for (const file of files) {
    try {
      const id = uid(), full = await compressImage(file, 1600);
      await storePhoto(id, full, await compressImage(full, 480));
      ids.push(id);
    } catch (e) { toast("Couldn't read that image"); }
  }
  hid.value = ids.join(',');
  $('#photo-strip').innerHTML = photoStrip(ids);
  hydrateImages();
  const f = fabric(form.dataset.id);
  if (f) { f.photos = ids; save(); render(); }
}
// Remove photos left behind by fabrics that were never saved or were deleted
async function cleanupPhotos() {
  try {
    const used = new Set(S.fabrics.flatMap(f => f.photos || []));
    (await IDB.keys()).forEach(k => { if (!used.has(String(k).split(':')[1])) IDB.del(k); });
  } catch (e) { /* ignore */ }
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

/* ---------- Starter plan ---------- */
const STARTER = [
  { area: 'startup', name: 'Finish the prototype', stage: 'Prototype', tasks: [['List everything left to finish on the prototype', 'light', 15], ['Fix the biggest remaining issue', 'deep'], ['Test it end-to-end, wearing it yourself', 'deep'], ['Take photos and a short demo video', 'light', 30], ['One-page summary: problem, device, who it helps', 'deep']] },
  { area: 'startup', name: 'Mentor outreach', stage: 'Mentor feedback', tasks: [['List mentors and advisors to contact (add them under People)', 'light', 15], ['Draft a short outreach message and attach the demo', 'deep'], ['Send the first 3 outreach messages', 'light', 30], ['Prep questions: trial design, IRB/ethics, FDA pathway', 'deep'], ['Book feedback calls', 'light', 15]] },
  { area: 'startup', name: 'Trial planning', stage: 'Trial planning', tasks: [['Research similar wearable pilot studies', 'deep'], ['Identify a possible clinical partner or site', 'deep'], ['Outline a pilot study plan with mentors', 'deep']] },
  { area: 'brand', name: 'Brand foundation', stage: 'Vision', tasks: [['Describe your customer in one paragraph', 'deep'], ['Pick 3 words the brand should feel like', 'light', 15], ['Build a moodboard', 'deep'], ['Brainstorm names and check handles/domains', 'light', 30]] },
  { area: 'brand', name: 'First pieces', stage: 'First pieces', tasks: [['Sketch 10+ piece ideas', 'deep'], ['Choose the first 3–5 pieces', 'deep'], ['Research fabrics and price points', 'deep']] },
  { area: 'brand', name: 'Marketing plan', stage: 'Marketing', tasks: [['Pick your main channel (Instagram, TikTok…)', 'light', 15], ['Plan your first 9 posts', 'deep'], ['Set up a waitlist or email list', 'light', 30], ['Film behind-the-scenes clips while you make things', 'light', 30]] },
];

/* ---------- Actions ---------- */
const A = {
  'tab': d => { UI.view = d.v; closeSheet(); window.scrollTo(0, 0); render(); },
  'close-sheet': () => closeSheet(),
  'settings': () => openSettings(),
  'quick-add': () => {
    if (UI.view === 'ideas' && UI.studio === 'fabrics') return openFabric(null);
    if (UI.view === 'ideas') { const t = $('.capture textarea'); if (t) { t.focus(); t.scrollIntoView({ block: 'center' }); } return; }
    openTask(null, UI.view === 'projects' && UI.area !== 'all' ? { areaId: UI.area, day: '' } : {});
  },
  'filter': d => { UI.area = d.id; render(); window.scrollTo(0, 0); },
  'studio': d => { UI.studio = d.m; saveUI(); render(); window.scrollTo(0, 0); },
  'fabric-filter': d => { UI.fabricFilter = d.id; render(); },
  'new-fabric': () => openFabric(null),
  'edit-fabric': d => openFabric(d.id),
  'del-fabric': d => {
    const f = fabric(d.id); if (!f || !confirm('Delete this fabric and its photos?')) return;
    (f.photos || []).forEach(deletePhoto);
    S.fabrics = S.fabrics.filter(x => x.id !== d.id); closeSheet(); commit();
  },
  'rm-photo': d => {
    const form = $('form[data-form="fabric"]'); if (!form) return;
    const hid = form.querySelector('[name=photos]'), ids = hid.value.split(',').filter(x => x && x !== d.id);
    hid.value = ids.join(','); $('#photo-strip').innerHTML = photoStrip(ids); hydrateImages();
    const f = fabric(form.dataset.id); if (f) { f.photos = ids; deletePhoto(d.id); save(); render(); }
  },
  'idea-filter': d => { UI.ideaArea = d.id; render(); },
  'proj-mode': d => { UI.projMode = d.m; saveUI(); render(); },
  'new-project': d => openProject(null, d.area),
  'open-project': d => openProject(d.id),
  'new-task': d => { const p = project(d.project); openTask(null, p ? { areaId: p.areaId, projectId: p.id, day: '' } : { areaId: d.area, day: '' }); },
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
  'starter': () => {
    let n = 0;
    STARTER.forEach(sp => {
      const a = area(sp.area); if (!a) return;
      const p = { id: uid(), name: sp.name, areaId: a.id, stage: a.stages.includes(sp.stage) ? sp.stage : a.stages[0], due: '', notes: '', created: Date.now(), updated: Date.now() };
      S.projects.push(p); n++;
      sp.tasks.forEach(([title, energy, est], i) => S.tasks.push({ id: uid(), created: Date.now() + i, done: false, doneAt: null, title, areaId: a.id, projectId: p.id, due: '', est: est || '', priority: 'normal', notes: '', energy }));
    });
    S.flags.starter = true; commit(); toast(`Added ${n} projects. Edit anything that doesn't fit.`);
  },
  'starter-dismiss': () => { S.flags.starterDismissed = true; commit(); },
  'more-next': () => { UI.moreNext = true; render(); },
  'energy': () => openEnergy(),
  'set-energy': d => {
    const k = todayKey(), tom = dkey(addDays(new Date(), 1));
    if (energyOf(k) === 'rest' && d.v !== 'rest') A['energy-undo']();
    if (d.v === 'full') delete S.energy[k]; else S.energy[k] = d.v;
    if (d.v === 'rest') {
      if (S.timer) stopTimer(true);
      const moved = (S.top3[k] || []).filter(id => { const t = task(id); return t && !t.done; });
      const tl = S.top3[tom] = S.top3[tom] || [];
      moved.forEach(id => { if (!tl.includes(id) && tl.length < 3) tl.push(id); });
      S.top3[k] = (S.top3[k] || []).filter(id => !moved.includes(id));
      S.restMoved[k] = moved;
      S.restMovedTasks = S.restMovedTasks || {};
      S.restMovedTasks[k] = S.tasks.filter(t => t.day === k && !t.done).map(t => t.id);
      S.restMovedTasks[k].forEach(id => { const t = task(id); t.day = tom; });
      S.blocks.forEach(b => { if (b.date === k) b.skipped = true; });
    }
    UI.deckIdx = 0; closeSheet(); commit();
    toast(d.v === 'rest' ? 'Rest night logged. See you tomorrow 🌙' : d.v === 'light' ? 'Light night. One small thing is plenty.' : 'Full evening. You\'ve got this.');
  },
  'energy-undo': () => {
    const k = todayKey(), tom = dkey(addDays(new Date(), 1)), moved = S.restMoved[k] || [];
    delete S.energy[k];
    S.top3[tom] = (S.top3[tom] || []).filter(id => !moved.includes(id));
    S.top3[k] = [...new Set([...(S.top3[k] || []), ...moved])].slice(0, 3);
    delete S.restMoved[k];
    ((S.restMovedTasks || {})[k] || []).forEach(id => { const t = task(id); if (t && !t.done) t.day = k; });
    if (S.restMovedTasks) delete S.restMovedTasks[k];
    S.blocks.forEach(b => { if (b.date === k) delete b.skipped; });
    commit();
  },
  'new-person': d => openPerson(null, d.area),
  'edit-person': d => openPerson(d.id),
  'log-contact': d => {
    const p = person(d.id); if (!p) return;
    p.last = todayKey(); p.next = dkey(addDays(new Date(), 7));
    if (p.status === 'To contact') p.status = 'Reached out';
    p.updated = Date.now(); commit(); openPerson(p.id); toast('Logged. Follow-up set for next week.');
  },
  'del-person': d => { if (!confirm('Delete this person?')) return; S.people = S.people.filter(p => p.id !== d.id); closeSheet(); commit(); },
  'edit-idea': d => openIdea(d.id),
  'del-idea': d => { if (!confirm('Delete this idea?')) return; S.ideas = S.ideas.filter(i => i.id !== d.id); closeSheet(); commit(); },
  'idea-to-project': d => { const i = S.ideas.find(x => x.id === d.id); if (!i) return; const [first, ...rest] = i.text.split('\n'); openProject(null, area(i.areaId) ? i.areaId : 'side', { name: first.slice(0, 80), notes: [rest.join('\n'), i.link].filter(Boolean).join('\n'), ideaId: i.id }); },
  'idea-to-task': d => { const i = S.ideas.find(x => x.id === d.id); if (!i) return; const [first, ...rest] = i.text.split('\n'); openTask(null, { title: first.slice(0, 120), areaId: area(i.areaId) ? i.areaId : undefined, notes: [rest.join('\n'), i.link].filter(Boolean).join('\n'), ideaId: i.id }); },
  'start-timer': d => { const t = task(d.id); if (t) startTimer({ taskId: t.id, projectId: t.projectId, areaId: t.areaId }); },
  'focus-area': d => startTimer({ areaId: d.area }),
  'stop-timer': () => stopTimer(false),
  'pick-focus': () => openFocusPicker(),
  'log-time': () => openLogTime(),
  'pick-top3': () => openTop3Picker(),
  'plan-today': () => openTodayPicker(),
  'toggle-today': d => {
    const t = task(d.id), k = todayKey(); if (!t) return;
    if (t.day === k) { scheduleTask(t, ''); S.top3[k] = (S.top3[k] || []).filter(id => id !== t.id); } else scheduleTask(t, k);
    commit(); refreshSheet();
  },
  'task-when': d => { const t = task(d.id); if (!t) return; scheduleTask(t, d.v === 'tomorrow' ? dkey(addDays(new Date(), 1)) : ''); if (d.v !== 'today') S.top3[todayKey()] = (S.top3[todayKey()] || []).filter(id => id !== t.id); closeSheet(); commit(); toast(d.v === 'tomorrow' ? 'Moved to tomorrow' : 'Moved off your days. It\'s still in the project.'); },
  'toggle-top3': d => {
    const k = todayKey(), l = S.top3[k] = S.top3[k] || [], i = l.indexOf(d.id);
    if (i > -1) l.splice(i, 1); else if (l.length >= 3) return toast('Three is the limit. Unpick one first.'); else { l.push(d.id); const t = task(d.id); if (t && t.day !== k) scheduleTask(t, k); }
    commit(); refreshSheet();
  },
  'carry': () => { const c = carryOver(); S.top3[todayKey()] = c.slice(0, 3); commit(); },
  'quick-block': d => { S.blocks.push({ id: uid(), date: todayKey(), start: S.settings.eveningStart, end: S.settings.eveningEnd, areaId: d.area, projectId: null, title: '', planned: true }); commit(); },
  'new-block': d => openBlock(null, d.date),
  'edit-block': d => openBlock(d.id),
  'del-block': d => { S.blocks = S.blocks.filter(b => b.id !== d.id); closeSheet(); commit(); },
  'toggle-away': d => {
    closeSheet();
    const now = !isAway(d.date);
    if (now === autoAway(d.date)) delete S.away[d.date]; else S.away[d.date] = now;
    if (now) {
      const planned = S.blocks.filter(b => b.date === d.date && b.planned);
      if (planned.length && confirm(`Clear the ${planned.length} planned block${planned.length > 1 ? 's' : ''} on this day?`)) S.blocks = S.blocks.filter(b => !planned.includes(b));
    }
    commit();
  },
  'ics-block': d => { const b = S.blocks.find(x => x.id === d.id); if (b) download('after-hours-block.ics', calendar([blockEvent(b)]), 'text/calendar'); },
  'ics-week': d => {
    const e = dkey(addDays(parseKey(d.week), 7));
    const bs = S.blocks.filter(b => b.date >= d.week && b.date < e);
    if (!bs.length) return toast('No blocks this week yet. Tap "Plan evenings" first.');
    download(`after-hours-week-${d.week}.ics`, calendar(bs.map(blockEvent)), 'text/calendar');
    toast(`Exported ${bs.length} blocks. Open the file to add them to your calendar.`);
  },
  'week': d => { UI.weekOffset += +d.d; render(); },
  'rweek': d => { UI.reviewOffset = Math.min(0, UI.reviewOffset + +d.d); render(); },
  'review-week': d => { UI.reviewOffset = Math.min(0, +d.o || 0); UI.view = 'review'; window.scrollTo(0, 0); render(); },
  'plan': d => openPlanner(d.week),
  'add-area': () => {
    S.areas.push({ id: uid(), name: 'New area', color: '#c7896b', target: 2, stages: ['To do', 'Doing', 'Done'] });
    save(); openSettings();
    setTimeout(() => { const f = document.querySelectorAll('.area-edit'); if (f.length) f[f.length - 1].scrollIntoView({ block: 'center' }); }, 50);
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
    S.people.forEach(p => { if (p.areaId === d.id) p.areaId = S.areas[0].id; });
    commit(); openSettingsKeepScroll();
  },
  'cal-connect': async () => {
    S.sync = { token: randHex(32), feedId: randHex(16), calUrls: [], lastHash: 0, lastSync: 0, lastErr: '' };
    save(); openSettingsKeepScroll();
    const ok = await pushFeed(true);
    openSettingsKeepScroll();
    toast(ok ? 'Connected. Now tap "Subscribe in Apple Calendar".' : "Couldn't reach the sync server. Try Sync now.");
  },
  'cal-remove': async d => { S.sync.calUrls.splice(+d.i, 1); S.cal = { events: [], errors: [], fetchedAt: 0 }; save(); await pushFeed(true); await pullEvents(true); openSettingsKeepScroll(); },
  'cal-refresh': async () => { toast('Syncing…'); await pushFeed(true); await pullEvents(true); openSettingsKeepScroll(); toast(S.sync.lastErr ? S.sync.lastErr : 'Synced ✓'); },
  'cal-disconnect': async () => {
    if (!confirm('Disconnect Apple Calendar? The After Hours calendar will stop updating. You can delete it in Apple Calendar afterwards.')) return;
    try { await api('/api/sync', { method: 'DELETE' }); } catch (e) { /* server copy expires unused */ }
    S.sync = null; S.cal = { events: [], errors: [], fetchedAt: 0 }; commit(); openSettingsKeepScroll();
  },
  'copy': async d => { try { await navigator.clipboard.writeText(d.text); toast('Link copied'); } catch (e) { prompt('Copy this link:', d.text); } },
  'export': async () => {
    const images = {};
    for (const f of S.fabrics) for (const id of f.photos || []) {
      try { const b = await IDB.get('img:' + id); if (b) images[id] = await blobToDataURL(b); } catch (e) { /* skip unreadable photo */ }
    }
    download(`after-hours-backup-${todayKey()}.json`, JSON.stringify({ ...S, sync: null, images }), 'application/json');
  },
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
    const data = { title: f.get('title').trim(), ...tg, due: f.get('due') || '', est: f.get('est') ? +f.get('est') : '', priority: f.get('priority') || 'normal', energy: f.get('quick') ? 'light' : (task(id) && task(id).energy === 'deep' ? 'deep' : ''), notes: f.get('notes') || '' };
    let t;
    if (id) { t = task(id); Object.assign(t, data); }
    else { t = { id: uid(), created: Date.now(), done: false, doneAt: null, ...data }; S.tasks.push(t); }
    const k = todayKey(), l = S.top3[k] = S.top3[k] || [], i = l.indexOf(t.id);
    const w = f.get('when');
    if (w !== 'later' && w !== null) scheduleTask(t, w === 'today' ? (t.day && t.day <= k ? t.day : k) : w === 'tomorrow' ? dkey(addDays(new Date(), 1)) : '');
    if (f.get('top3') && t.day !== k) scheduleTask(t, k);
    if (f.get('top3') && i === -1) { if (l.length < 3) l.push(t.id); else toast('Top 3 is full, so the task was saved without it'); }
    if (!f.get('top3') && i > -1) l.splice(i, 1);
    if (form.dataset.idea) S.ideas = S.ideas.filter(x => x.id !== form.dataset.idea);
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
      if (form.dataset.idea) S.ideas = S.ideas.filter(x => x.id !== form.dataset.idea);
      openProject(p.id);
    }
    commit();
  },
  'inline-task'(f, form) {
    const p = project(form.dataset.project);
    S.tasks.push({ id: uid(), created: Date.now(), done: false, doneAt: null, title: f.get('title').trim(), areaId: p.areaId, projectId: p.id, due: '', est: '', priority: 'normal', notes: '', energy: '', day: '' });
    touchProject(p.id); commit(); refreshSheet();
    setTimeout(() => { const i = $('form[data-form="inline-task"] input'); if (i) i.focus(); }, 30);
  },
  'today-add'(f) {
    const title = (f.get('title') || '').trim(); if (!title) return;
    const b = currentBlock(S.blocks.filter(x => x.date === todayKey() && !x.skipped).sort((a, c) => a.start.localeCompare(c.start)));
    const t = { id: uid(), created: Date.now(), done: false, doneAt: null, title, areaId: b ? b.areaId : S.areas[0].id, projectId: b ? b.projectId : null, due: '', est: '', priority: 'normal', notes: '', energy: '' };
    scheduleTask(t, todayKey()); S.tasks.push(t); commit();
    setTimeout(() => { const i = $('.today-add input'); if (i) i.focus(); }, 30);
  },
  person(f, form) {
    const id = form.dataset.id;
    const data = { name: f.get('name').trim(), role: f.get('role') || '', contact: f.get('contact') || '', areaId: f.get('areaId'), status: f.get('status'), next: f.get('next') || '', notes: f.get('notes') || '', updated: Date.now() };
    if (id) Object.assign(person(id), data);
    else S.people.push({ id: uid(), created: Date.now(), last: '', ...data });
    closeSheet(); commit();
  },
  idea(f, form) {
    const text = (f.get('text') || '').trim();
    if (!text) return;
    S.ideas.push({ id: uid(), text, link: (f.get('link') || '').trim(), areaId: f.get('areaId') || '', created: Date.now(), starred: false });
    form.reset(); commit(); toast('Idea saved 💡');
  },
  fabric(f, form) {
    const id = form.dataset.id;
    const data = { name: (f.get('name') || '').trim(), fiber: f.get('fiber') || '', color: f.get('color') || '', amount: f.get('amount') || '', source: f.get('source') || '',
      status: f.get('status'), plans: f.get('plans') || '', projectId: f.get('projectId') || '', photos: (f.get('photos') || '').split(',').filter(Boolean), updated: Date.now() };
    if (id) Object.assign(fabric(id), data);
    else S.fabrics.push({ id: uid(), created: Date.now(), ...data });
    closeSheet(); commit();
    if (!id) toast('Added to your fabric closet 🧵');
  },
  'idea-edit'(f, form) {
    const i = S.ideas.find(x => x.id === form.dataset.id);
    Object.assign(i, { text: f.get('text').trim(), areaId: f.get('areaId') || '', link: (f.get('link') || '').trim(), starred: !!f.get('starred') });
    closeSheet(); commit();
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
    toast(`${n} block${n === 1 ? '' : 's'} planned${S.sync ? '. Syncing to Apple Calendar.' : '.'}`);
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
    ['eveningStart', 'eveningEnd', 'workStart', 'workEnd', 'reviewTime'].forEach(k => { if (f.get(k)) s[k] = f.get(k); });
    if (toMin(s.eveningEnd) <= toMin(s.eveningStart)) return toast('Your evening has to end after it starts');
    s.workDays = f.getAll('wd').map(Number);
    s.theme = f.get('theme') || 'system';
    s.extraFields = !!f.get('extraFields');
    applyTheme();
    S.areas.forEach(a => {
      a.name = (f.get('name_' + a.id) || a.name).trim();
      a.color = f.get('color_' + a.id) || a.color;
      a.target = +f.get('target_' + a.id) || 0;
      const st = (f.get('stages_' + a.id) || '').split(',').map(x => x.trim()).filter(Boolean);
      if (st.length) a.stages = st;
    });
    closeSheet(); commit(); toast('Settings saved');
  },
  async calurl(f) {
    let u = (f.get('url') || '').trim();
    if (!/^(webcal|https?):\/\//i.test(u)) return toast('Paste the full link, starting with webcal:// or https://');
    if (S.sync.calUrls.includes(u)) return toast('That calendar is already added');
    S.sync.calUrls.push(u); save();
    toast('Loading your calendar…');
    await pushFeed(true); await pullEvents(true);
    openSettingsKeepScroll();
    const err = (S.cal.errors || []).find(e => e.i === S.sync.calUrls.length - 1);
    toast(err ? `Couldn't read that calendar: ${err.error}` : `Loaded ${S.cal.events.length} events ✓`);
  },
};

/* ---------- Render ---------- */
function applyTheme() {
  const t = S.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
function render() {
  const now = new Date();
  const titles = { tonight: isAway(todayKey()) ? 'Today' : isWorkDay(now) ? 'Tonight' : 'This weekend', projects: UI.area !== 'all' && area(UI.area) ? area(UI.area).name : 'Projects', ideas: 'Studio', week: 'Week', review: 'Weekly review' };
  $('#title').textContent = titles[UI.view];
  $('#eyebrow').textContent = `${DAYS[now.getDay()]} · ${MON[now.getMonth()]} ${now.getDate()}`;
  const views = { tonight: viewTonight, projects: viewProjects, ideas: viewStudio, week: viewWeek, review: viewReview };
  // Keep an in-progress idea draft when the list re-renders
  const oldDeck = $('[data-deck]'), deckPos = oldDeck && UI.lastView === UI.view + UI.area ? oldDeck.scrollLeft : 0;
  if (UI.lastView !== UI.view + UI.area) UI.deckIdx = 0;
  UI.lastView = UI.view + UI.area;
  const draft = UI.view === 'ideas' && $('.capture textarea') ? $('.capture textarea').value : '';
  $('#main').innerHTML = views[UI.view]();
  if (draft && $('.capture textarea') && document.activeElement !== $('.capture textarea')) $('.capture textarea').value = draft;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.v === (UI.view === 'review' ? 'week' : UI.view)));
  $('.fab').hidden = UI.view === 'tonight'; // Tonight has its own add field on the Today card
  hydrateImages();
  const deck = $('[data-deck]');
  if (deck && deckPos) deck.scrollLeft = deckPos;
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
  if (e.target.matches('input[data-photo]')) addPhotos(e.target);
  if (e.target.dataset.aChange === 'reminder') { S.settings.reminderMin = +e.target.value; commit(); toast('Alert time updated'); }
});
// Swipe decks: keep the page dots in step with the visible card
document.addEventListener('scroll', e => {
  const deck = e.target;
  if (!deck.matches || !deck.matches('[data-deck]')) return;
  const mid = deck.scrollLeft + deck.clientWidth / 2;
  let best = 0, bd = Infinity;
  [...deck.children].forEach((c, i) => { const d = Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid); if (d < bd) { bd = d; best = i; } });
  UI.deckIdx = best;
  const dots = deck.nextElementSibling;
  if (dots) [...dots.children].forEach((d, i) => d.classList.toggle('on', i === best));
}, true);
document.addEventListener('input', e => {
  if (e.target.id === 'fabric-search') { UI.fabricQuery = e.target.value; $('#fabric-grid').innerHTML = fabricGrid(); hydrateImages(); }
});
$('#importFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (!d || !Array.isArray(d.areas) || !Array.isArray(d.tasks)) throw new Error('bad');
    if (!confirm('Replace everything on this device with the backup?')) return;
    const keepSync = S.sync;
    if (d.images) {
      toast('Restoring photos…');
      for (const [id, url] of Object.entries(d.images)) {
        try { const full = await (await fetch(url)).blob(); await storePhoto(id, full, await compressImage(full, 480)); } catch (e) { /* skip */ }
      }
      delete d.images;
    }
    S = migrate(d);
    S.sync = keepSync;
    closeSheet(); commit(); toast('Backup restored');
  } catch (err) { toast("That file isn't an After Hours backup"); }
});

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

let lastDay = todayKey();
setInterval(() => { if (todayKey() !== lastDay) { lastDay = todayKey(); rollover(); commit(); } }, 60000);
setInterval(() => {
  if (S.timer) document.querySelectorAll('[data-elapsed]').forEach(el => { el.textContent = fmtClock(Date.now() - S.timer.start); });
}, 1000);
// Coming back to the app: reload state (the day may have changed) and refresh calendar events
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  S = load();
  rollover(); save();
  if ($('#sheet').hidden) render();
  pullEvents(); schedulePush();
});

applyTheme();
rollover(); save();
render();
pullEvents(); schedulePush();
setTimeout(cleanupPhotos, 4000);
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // A new version was deployed: reload once so the update shows up right away
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && $('#sheet').hidden) location.reload(); });
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
