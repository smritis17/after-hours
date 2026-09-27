// After Hours calendar bridge (Cloudflare Worker)
//
//   PUT    /api/sync      app uploads its calendar feed + the Apple calendar links to read
//   DELETE /api/sync      disconnect: removes everything stored for this token
//   GET    /api/events    returns Apple Calendar events (next ~7 weeks) as JSON
//   GET    /cal/<id>.ics  the feed Apple Calendar subscribes to (blocks, reviews, follow-ups)
//
// The app authenticates with a random 256-bit token it generates on the phone; only a hash is stored.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
  'Access-Control-Max-Age': '86400',
};
const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const feed = url.pathname.match(/^\/cal\/([a-f0-9]{32})\.ics$/);
    if (feed && req.method === 'GET') {
      const ics = await env.KV.get('f:' + feed[1]);
      if (!ics) return new Response('Not found', { status: 404 });
      return new Response(ics, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-cache, max-age=0' } });
    }
    if (url.pathname === '/') return new Response('After Hours calendar bridge is running.');

    const token = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
    if (!/^[a-f0-9]{64}$/.test(token)) return json({ error: 'unauthorized' }, 401);
    const uk = 'u:' + await sha256(token);
    const rec = JSON.parse(await env.KV.get(uk) || 'null');

    if (url.pathname === '/api/sync' && req.method === 'PUT') {
      const text = await req.text();
      if (text.length > 600000) return json({ error: 'too large' }, 413);
      let d;
      try { d = JSON.parse(text); } catch { return json({ error: 'bad json' }, 400); }
      if (!/^[a-f0-9]{32}$/.test(d.feedId || '') || typeof d.ics !== 'string' || !d.ics.startsWith('BEGIN:VCALENDAR')) return json({ error: 'bad data' }, 400);
      // A feed id can only be written by the token that first claimed it
      const owner = await env.KV.get('o:' + d.feedId);
      if (owner && owner !== uk) return json({ error: 'forbidden' }, 403);
      const calUrls = (Array.isArray(d.calUrls) ? d.calUrls : [])
        .filter(u => typeof u === 'string' && /^(webcal|https?):\/\//i.test(u) && u.length < 2000).slice(0, 10);
      if (rec && rec.feedId !== d.feedId) await Promise.all([env.KV.delete('f:' + rec.feedId), env.KV.delete('o:' + rec.feedId)]);
      await Promise.all([
        env.KV.put(uk, JSON.stringify({ feedId: d.feedId, tz: String(d.tz || 'UTC').slice(0, 64), calUrls })),
        env.KV.put('f:' + d.feedId, d.ics),
        owner ? null : env.KV.put('o:' + d.feedId, uk),
      ]);
      return json({ ok: true });
    }

    if (url.pathname === '/api/sync' && req.method === 'DELETE') {
      if (rec) await Promise.all([env.KV.delete(uk), env.KV.delete('f:' + rec.feedId), env.KV.delete('o:' + rec.feedId)]);
      return json({ ok: true });
    }

    if (url.pathname === '/api/events' && req.method === 'GET') {
      if (!rec) return json({ events: [], errors: [], fetchedAt: Date.now() });
      const now = Date.now(), from = now - 8 * 864e5, to = now + 50 * 864e5;
      const events = [], errors = [];
      await Promise.all(rec.calUrls.map(async (u, i) => {
        try {
          const r = await fetch(u.replace(/^webcal:/i, 'https:'), { headers: { 'User-Agent': 'AfterHours/1.0' }, cf: { cacheTtl: 300 } });
          if (!r.ok) throw new Error('The calendar link returned HTTP ' + r.status);
          const text = await r.text();
          if (!text.includes('BEGIN:VCALENDAR')) throw new Error("That link isn't a calendar feed");
          for (const e of parseICS(text, rec.tz, from, to)) { e.cal = i; events.push(e); }
        } catch (err) { errors.push({ i, error: String(err.message || err) }); }
      }));
      return json({ events, errors, fetchedAt: now });
    }

    return json({ error: 'not found' }, 404);
  },
};

/* ---------- iCalendar parsing with recurrence expansion ---------- */
const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY = 864e5;

function unfold(t) { return t.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n'); }
function parseLine(l) {
  let i = -1, q = false;
  for (let j = 0; j < l.length; j++) { const c = l[j]; if (c === '"') q = !q; else if (c === ':' && !q) { i = j; break; } }
  if (i < 0) return null;
  const [name, ...ps] = l.slice(0, i).split(';');
  const params = {};
  ps.forEach(p => { const j = p.indexOf('='); if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, ''); });
  return { name: name.toUpperCase(), params, value: l.slice(i + 1) };
}
const unesc = s => s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');

const dtfCache = {};
function validTz(tz) {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
function offsetMs(utc, tz) {
  const f = dtfCache[tz] || (dtfCache[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  const o = {};
  f.formatToParts(new Date(utc)).forEach(p => { o[p.type] = p.value; });
  return Date.UTC(+o.year, o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second) - utc;
}
function zonedToUtc(w, tz) {
  const g = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  if (tz === 'UTC') return g;
  let u = g - offsetMs(g, tz);
  u = g - offsetMs(u, tz);
  return u;
}
// "20260927" | "20260927T180000" | "20260927T180000Z" -> { wall, allDay, zone }
function parseDT(value, params, userTz) {
  const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/);
  if (!m) return null;
  const allDay = params.VALUE === 'DATE' || !m[4];
  const wall = { y: +m[1], m: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0) };
  const zone = m[7] ? 'UTC' : validTz(params.TZID) ? params.TZID : userTz;
  return { wall, allDay, zone };
}
const dnum = w => Date.UTC(w.y, w.m - 1, w.d) / DAY;
const dow = w => new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay();
const addDaysW = (w, n) => { const d = new Date(Date.UTC(w.y, w.m - 1, w.d + n)); return { ...w, y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; };
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const fmtDn = n => new Date(n * DAY).toISOString().slice(0, 10);
function parseDuration(v) {
  const m = (v || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (((+m[2] || 0) * 7 + (+m[3] || 0)) * DAY + (+m[4] || 0) * 36e5 + (+m[5] || 0) * 6e4 + (+m[6] || 0) * 1e3);
}

function* candidates(base, r) {
  const I = Math.max(1, +r.INTERVAL || 1), byday = r.BYDAY ? r.BYDAY.split(',') : null;
  if (r.FREQ === 'DAILY') { for (let k = 0; k < 20000; k++) yield addDaysW(base, k * I); }
  else if (r.FREQ === 'WEEKLY') {
    const days = (byday || [WD[dow(base)]]).map(x => WD.indexOf(x.slice(-2))).filter(x => x >= 0).map(x => (x + 6) % 7).sort((a, b) => a - b);
    const ws = addDaysW(base, -((dow(base) + 6) % 7));
    for (let k = 0; k < 5000; k++) for (const d of days) yield addDaysW(ws, k * 7 * I + d);
  } else if (r.FREQ === 'MONTHLY') {
    for (let k = 0; k < 2000; k++) {
      const mi = base.m - 1 + k * I, y = base.y + Math.floor(mi / 12), m = (mi % 12) + 1, n = dim(y, m);
      let ds = [];
      if (byday) {
        byday.forEach(x => {
          const mm = x.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/);
          if (!mm) return;
          const all = [];
          for (let d = 1; d <= n; d++) if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === WD.indexOf(mm[2])) all.push(d);
          if (mm[1]) { const i = +mm[1], v = i > 0 ? all[i - 1] : all[all.length + i]; if (v) ds.push(v); } else ds.push(...all);
        });
      } else if (r.BYMONTHDAY) ds = r.BYMONTHDAY.split(',').map(Number).map(x => (x < 0 ? n + 1 + x : x)).filter(x => x >= 1 && x <= n);
      else if (base.d <= n) ds = [base.d];
      for (const d of [...new Set(ds)].sort((a, b) => a - b)) yield { ...base, y, m, d };
    }
  } else if (r.FREQ === 'YEARLY') {
    for (let k = 0; k < 200; k++) { const y = base.y + k * I; if (base.d <= dim(y, base.m)) yield { ...base, y }; }
  }
}

function parseICS(text, userTz, from, to) {
  const raw = [];
  let cur = null, depth = 0;
  for (const l of unfold(text)) {
    const p = l && parseLine(l);
    if (!p) continue;
    if (p.name === 'BEGIN') { if (p.value === 'VEVENT') { cur = { ex: [] }; depth = 0; } else if (cur) depth++; continue; }
    if (p.name === 'END') { if (p.value === 'VEVENT' && cur) { raw.push(cur); cur = null; } else if (cur) depth--; continue; }
    if (!cur || depth > 0) continue;
    if (p.name === 'EXDATE') cur.ex.push(p); else cur[p.name] = p;
  }

  const keyOf = (dt, allDay) => (allDay ? dnum(dt.wall) : zonedToUtc(dt.wall, dt.zone));
  const overrides = {};
  raw.forEach(e => {
    if (e['RECURRENCE-ID'] && e.UID) {
      const dt = parseDT(e['RECURRENCE-ID'].value, e['RECURRENCE-ID'].params, userTz);
      if (dt) (overrides[e.UID.value] = overrides[e.UID.value] || []).push(dt);
    }
  });

  const out = [];
  for (const e of raw) {
    if (!e.DTSTART || (e.STATUS && e.STATUS.value.toUpperCase() === 'CANCELLED')) continue;
    const st = parseDT(e.DTSTART.value, e.DTSTART.params, userTz);
    if (!st) continue;
    const title = unesc(e.SUMMARY ? e.SUMMARY.value : 'Busy');
    const busy = !(e.TRANSP && e.TRANSP.value.toUpperCase() === 'TRANSPARENT');
    let dur;
    if (e.DTEND) {
      const en = parseDT(e.DTEND.value, e.DTEND.params, userTz);
      dur = st.allDay ? Math.max(1, dnum(en.wall) - dnum(st.wall)) : zonedToUtc(en.wall, en.zone) - zonedToUtc(st.wall, st.zone);
    } else if (e.DURATION) dur = st.allDay ? Math.max(1, Math.round(parseDuration(e.DURATION.value) / DAY)) : parseDuration(e.DURATION.value);
    else dur = st.allDay ? 1 : 0;

    const emit = w => {
      if (st.allDay) {
        const s = dnum(w), en = s + dur;
        if (en * DAY > from && s * DAY < to) out.push({ title, allDay: true, sd: fmtDn(s), ed: fmtDn(en), busy });
      } else {
        const s = zonedToUtc(w, st.zone), en = s + dur;
        if (en > from && s < to) out.push({ title, s, e: en, busy });
      }
    };

    const rr = e.RRULE && !e['RECURRENCE-ID'] ? Object.fromEntries(e.RRULE.value.split(';').map(x => x.split('=')).map(([k, v]) => [k.toUpperCase(), v])) : null;
    if (!rr || !rr.FREQ) { emit(st.wall); continue; }

    const ex = new Set();
    e.ex.forEach(p => p.value.split(',').forEach(v => { const dt = parseDT(v, p.params, userTz); if (dt) ex.add(keyOf({ ...dt, zone: dt.zone }, st.allDay)); }));
    (overrides[e.UID && e.UID.value] || []).forEach(dt => ex.add(keyOf(dt, st.allDay)));

    let until = Infinity;
    if (rr.UNTIL) {
      const u = parseDT(rr.UNTIL, {}, st.zone);
      if (u) until = st.allDay ? dnum(u.wall) : u.allDay ? zonedToUtc({ ...u.wall, h: 23, mi: 59, s: 59 }, st.zone) : zonedToUtc(u.wall, u.zone);
    }
    const count = rr.COUNT ? +rr.COUNT : Infinity;
    const baseKey = keyOf(st, st.allDay), endKey = st.allDay ? to / DAY : to;
    let n = 0, it = 0;
    for (const w of candidates(st.wall, rr)) {
      if (++it > 20000) break;
      const k = st.allDay ? dnum(w) : zonedToUtc(w, st.zone);
      if (k < baseKey) continue;
      if (k > until || ++n > count || k > endKey) break;
      if (!ex.has(k)) emit(w);
    }
  }
  return out;
}

export { parseICS };
