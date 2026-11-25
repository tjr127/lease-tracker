/* Lease Tracker — screens, storage, and syncing with your Google Sheet.
   The arithmetic lives in lease-math.js. */
(function () {
  'use strict';

  const M = window.LeaseMath;
  const $ = sel => document.querySelector(sel);

  // ---------- storage ----------

  const store = {
    get(key, fallback) {
      try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
      catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full or blocked */ }
    }
  };

  let state = store.get('lt.state.v1', { vehicles: [], readings: [] });
  let queue = store.get('lt.queue.v1', []);          // changes not yet written to the Sheet
  let conn = store.get('lt.conn.v1', { url: '', key: '', lastSaved: null });
  let ui = store.get('lt.ui.v1', { activeId: null, tab: 'status' });
  let addingVehicle = false;
  let sync = { state: conn.url ? 'saved' : 'local', message: '' };

  function persist() {
    store.set('lt.state.v1', state);
    store.set('lt.queue.v1', queue);
    store.set('lt.ui.v1', ui);
  }

  // ---------- formatting ----------

  const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const fmt = n => nf.format(Math.round(n));
  const money = n => '$' + (n >= 100 || Number.isInteger(n)
    ? nf.format(Math.round(n))
    : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const feeText = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  const plural = (n, word) => fmt(n) + ' ' + word + (Math.round(n) === 1 ? '' : 's');

  function parts(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
  function fmtDate(iso, withYear) {
    const sameYear = iso.slice(0, 4) === todayIso().slice(0, 4);
    const opts = { month: 'short', day: 'numeric' };
    if (withYear || !sameYear) opts.year = 'numeric';
    return parts(iso).toLocaleDateString('en-US', opts);
  }
  function todayIso() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function newId(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ---------- data changes ----------

  function activeVehicle() {
    return state.vehicles.find(v => v.id === ui.activeId) || state.vehicles[0] || null;
  }
  function readingsFor(v) { return state.readings.filter(r => r.vehicleId === v.id); }

  function applyOp(op) {
    if (op.type === 'upsertVehicle') {
      const i = state.vehicles.findIndex(v => v.id === op.vehicle.id);
      if (i >= 0) state.vehicles[i] = op.vehicle; else state.vehicles.push(op.vehicle);
    } else if (op.type === 'deleteVehicle') {
      state.vehicles = state.vehicles.filter(v => v.id !== op.id);
      state.readings = state.readings.filter(r => r.vehicleId !== op.id);
    } else if (op.type === 'upsertReading') {
      const i = state.readings.findIndex(r => r.id === op.reading.id);
      if (i >= 0) state.readings[i] = op.reading; else state.readings.push(op.reading);
    } else if (op.type === 'deleteReading') {
      state.readings = state.readings.filter(r => r.id !== op.id);
    }
  }

  function commit(op) {
    applyOp(op);
    queue.push(op);
    persist();
    render();
    syncNow();
  }

  // ---------- Google Sheet sync ----------

  let syncing = false, syncAgain = false, retryTimer;

  const SYNC_ERRORS = {
    'bad-key': 'The passphrase does not match the one in your script.',
    'passphrase-not-set': 'Set your own PASSPHRASE at the top of the script, then deploy a new version.',
    'bad-request': 'The Sheet script could not read the request. Redeploy the latest script.'
  };

  async function callSheet(url, key, ops) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        // text/plain keeps this a "simple" request, which Apps Script web apps require
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ key: key, ops: ops }),
        redirect: 'follow'
      });
    } catch (e) {
      throw new Error('unreachable');             // no signal, or Google could not be reached
    }
    let data;
    try { data = await res.json(); } catch (e) { throw new Error('not-a-script'); }
    if (!data.ok) throw new Error(data.error || 'unknown');
    return data;
  }

  function describeSyncError(code) {
    if (SYNC_ERRORS[code]) return SYNC_ERRORS[code];
    if (code === 'unreachable') return 'Could not reach Google. Check your connection, then the web app URL.';
    if (code === 'not-a-script') {
      return 'That address did not answer like the Lease Tracker script. Check the web app URL and that access is set to "Anyone".';
    }
    return 'The Sheet reported a problem: ' + code;
  }

  async function syncNow() {
    if (!conn.url) { setSync('local'); return; }
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    setSync('saving');
    const sent = queue.slice();
    try {
      const data = await callSheet(conn.url, conn.key, sent);
      queue = queue.slice(sent.length);
      state = { vehicles: data.vehicles, readings: data.readings };
      queue.forEach(applyOp);                         // anything logged while the request was in flight
      conn.lastSaved = Date.now();
      store.set('lt.conn.v1', conn);
      persist();
      setSync('saved');
      render();
    } catch (e) {
      if (e.message === 'unreachable') {            // keep the changes queued and try again shortly
        setSync('offline');
        clearTimeout(retryTimer);
        retryTimer = setTimeout(syncNow, 30000);
      } else setSync('error', describeSyncError(e.message));
    } finally {
      syncing = false;
      if (syncAgain) { syncAgain = false; syncNow(); }
    }
  }

  function setSync(stateName, message) {
    sync = { state: stateName, message: message || '' };
    const btn = $('#syncBtn');
    const waiting = queue.length;
    const text = {
      local: 'On this phone only',
      saving: 'Saving…',
      saved: 'Saved to Sheet',
      offline: waiting ? plural(waiting, 'change') + ' waiting to save' : 'Can’t reach Sheet',
      error: 'Sheet problem'
    }[stateName];
    btn.dataset.state = stateName;
    $('#syncText').textContent = text;
    const slot = $('#sheetState');
    if (slot) slot.innerHTML = sheetStateHtml();
  }

  // ---------- rendering ----------

  const ICON = {
    under: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 9.5l3.5 3.5 7.5-8"/></svg>',
    watch: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2.5l7 12.5H2z"/><path d="M9 7.5v3.5M9 13.2v.1"/></svg>',
    over: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2.5h6l3.5 3.5v6L12 15.5H6L2.5 12V6z"/><path d="M9 5.8v4M9 12.2v.1"/></svg>'
  };

  let lastViewKey = null;

  // The Sheet address and passphrase are usually pasted from another app, one at a time.
  // Keep them as you go, so leaving the app (or Android closing it) does not lose them.
  function restoreDraft() {
    const draft = store.get('lt.draft.v1', null);
    if (!draft) return;
    const u = $('#cUrl'), k = $('#cKey');
    if (u && !u.value && draft.url) u.value = draft.url;
    if (k && !k.value && draft.key) k.value = draft.key;
  }
  function saveDraft() {
    const u = $('#cUrl'), k = $('#cKey');
    if (u && k) store.set('lt.draft.v1', { url: u.value, key: k.value });
  }

  function render() {
    const v = activeVehicle();
    if (v && ui.activeId !== v.id) { ui.activeId = v.id; persist(); }
    if (!v) { ui.tab = 'setup'; addingVehicle = true; }

    $('#vehicleName').textContent = v ? v.name : 'Lease Tracker';
    $('#vehicleBtn').disabled = !state.vehicles.length;
    document.querySelectorAll('.tabs button').forEach(b => {
      if (b.dataset.tab === ui.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    document.body.classList.toggle('no-log', !v || ui.tab === 'setup' || addingVehicle);

    const view = $('#view');
    // Redrawing the same form (after switching apps, or a background sync) must not wipe what was typed.
    const viewKey = [ui.tab, v ? v.id : '', addingVehicle, conn.url ? 'connected' : 'local'].join('|');
    const typed = {};
    if (viewKey === lastViewKey) {
      view.querySelectorAll('input').forEach(el => { if (el.id) typed[el.id] = el.value; });
    }
    lastViewKey = viewKey;
    if (ui.tab === 'setup' || !v) view.innerHTML = setupHtml(addingVehicle ? null : v);
    else if (ui.tab === 'history') view.innerHTML = historyHtml(v);
    else view.innerHTML = statusHtml(v);

    Object.keys(typed).forEach(id => { const el = document.getElementById(id); if (el) el.value = typed[id]; });
    restoreDraft();

    if (ui.tab === 'status' && v) wireChart(v);
    if (ui.tab === 'setup' || !v) wireSetup(addingVehicle ? null : v);
  }

  // ----- status -----

  function statusHtml(v) {
    const s = M.leaseStatus(v, readingsFor(v), todayIso());
    const fee = Number(v.feePerMile) || 0;
    let html = '';

    if (s.phase === 'not-started') {
      return '<section class="verdict"><p class="asof">' + esc(v.name) + '</p>' +
        '<h1>Lease starts ' + fmtDate(v.startDate, true) + '</h1>' +
        '<p class="explain">Readings count from that date. Until then there is nothing to track.</p></section>';
    }

    if (!s.readingCount) {
      html += '<section class="verdict"><p class="asof">Today, ' + fmtDate(todayIso()) + '</p>' +
        '<h1>Add today’s odometer</h1>' +
        '<p class="explain">The lease expects ' + fmt(s.lineOdometerToday) + ' on the odometer by today. Log your reading to see where you stand.</p></section>';
      html += roadHtml(v, s, false);
      html += factsHtml(v, s);
      return html;
    }

    const gap = Math.abs(s.delta);
    const ended = s.phase === 'ended';
    let h1;
    if (gap < 0.5) h1 = ended ? 'Finished right on the line' : 'Right on the lease line';
    else h1 = (ended ? 'Finished ' : '') + plural(gap, 'mile') + (s.delta >= 0 ? ' under' : ' over');

    const toneLabel = {
      under: ended ? 'Inside the allowance' : 'On track',
      watch: 'Under today, but on pace to finish over',
      over: ended ? 'Over the allowance' : 'Over the lease line'
    }[s.tone];

    let explain = 'The lease ' + (ended ? 'allowed ' : 'expects ') + fmt(s.lineOdometerToday) + ' on the odometer by ' +
      (ended ? 'the end' : 'today') + '. Yours read ' + fmt(s.odometer) + ' on ' + fmtDate(s.lastReading.date) + '.';
    if (s.delta < 0 && fee) explain += ' At ' + feeText(fee) + ' a mile, that gap is ' + money(s.costToday) + '.';

    html += '<section class="verdict">' +
      '<p class="asof">' + (ended ? 'Lease ended ' + fmtDate(s.endIso, true) : 'Today, ' + fmtDate(todayIso())) + '</p>' +
      '<h1>' + h1 + '</h1>' +
      '<p class="tone" data-tone="' + s.tone + '">' + ICON[s.tone] + toneLabel + '</p>' +
      '<p class="explain" style="margin-top:10px">' + explain + '</p>' +
      '</section>';

    html += roadHtml(v, s, true);

    if (!ended && s.staleDays >= 10) {
      html += '<p class="note">Your last reading was ' + plural(s.staleDays, 'day') + ' ago. Log today’s odometer for a current number.</p>';
    }

    if (!ended && s.projectedDelta != null) {
      const over = s.projectedDelta < 0;
      const amount = plural(Math.abs(s.projectedDelta), 'mile');
      let detail = 'That puts ' + fmt(s.projectedOdometer) + ' on the odometer when the lease ends ' + fmtDate(s.endIso, true) + '.';
      if (over && fee) detail += ' At ' + feeText(fee) + ' a mile, about ' + money(s.projectedCost) + '.';
      detail += ' You are averaging ' + fmt(s.pacePerDay * 365.25 / 12) + ' miles a month.';
      html += '<section class="block forecast"><h2>At your pace so far</h2>' +
        '<p class="headline">' + (over ? 'You’ll finish about ' + amount + ' over' : 'You’ll turn it in about ' + amount + ' under') + '</p>' +
        '<p class="detail">' + detail + '</p></section>';
    }

    if (!ended) {
      html += '<section class="block"><h2>To stay inside the lease, you can drive</h2>';
      if (s.milesLeft > 0 && s.perDay != null) {
        html += '<div class="budget">' +
          '<div><b>' + fmt(s.perDay) + '</b><span>miles a day</span></div>' +
          '<div><b>' + fmt(s.perWeek) + '</b><span>a week</span></div>' +
          '<div><b>' + fmt(s.perMonth) + '</b><span>a month</span></div></div>';
      } else {
        html += '<p>The whole allowance is used.' + (fee ? ' Every mile from here costs ' + feeText(fee) + '.' : '') + '</p>';
      }
      html += '</section>';
    }

    html += '<section class="block"><h2>Odometer against the lease line</h2>' +
      '<div class="legend">' +
      '<span><svg width="22" height="8" aria-hidden="true"><path d="M1 4h20" stroke="var(--series)" stroke-width="2.5" stroke-linecap="round"/></svg>Your odometer</span>' +
      (s.projectedOdometer != null && !ended ? '<span><svg width="22" height="8" aria-hidden="true"><path d="M1 4h20" stroke="var(--series)" stroke-width="2" stroke-dasharray="4 4"/></svg>At your pace</span>' : '') +
      '<span><svg width="22" height="8" aria-hidden="true"><path d="M1 4h20" stroke="var(--ink-2)" stroke-width="1.5"/></svg>Lease line</span>' +
      '</div><div class="chart-box" id="chartBox">' + chartSvg(v, s) + '<div class="tip" id="chartTip"></div></div></section>';

    html += factsHtml(v, s);
    return html;
  }

  function anchor(pct) {
    if (pct < 22) return 'left:' + pct + '%';
    if (pct > 78) return 'right:' + (100 - pct) + '%;text-align:right';
    return 'left:' + pct + '%;transform:translateX(-50%);text-align:center';
  }

  function roadHtml(v, s, hasReading) {
    const max = Math.max(v.milesAllowed, s.driven, 1);
    const you = Math.max(0, s.driven) / max * 100;
    const line = s.allowedToday / max * 100;
    const lo = Math.min(you, line), hi = Math.max(you, line);
    let h = '<div class="road" role="img" aria-label="Lease allowance used: ' + fmt(s.driven) + ' of ' + fmt(v.milesAllowed) +
      ' miles. The lease line today is at ' + fmt(s.allowedToday) + ' miles.">';
    h += '<span class="road-label top" style="' + anchor(line) + '">Lease line <b>' + fmt(s.lineOdometerToday) + '</b></span>';
    h += '<div class="road-bed">';
    if (hasReading) {
      h += '<div class="road-driven" style="width:' + you + '%"></div>';
      h += '<div class="road-gap" data-tone="' + s.tone + '" style="left:' + lo + '%;width:' + (hi - lo) + '%"></div>';
    }
    h += '</div>';
    h += '<span class="road-line" style="left:calc(' + line + '% - 1px)"></span>';
    if (hasReading) {
      h += '<span class="road-you" style="left:' + you + '%"></span>';
      h += '<span class="road-label bottom" style="' + anchor(you) + '">Your odometer <b>' + fmt(s.odometer) + '</b></span>';
    }
    h += '</div><div class="road-ends"><span>Start ' + fmt(v.startOdo) + '</span><span>Limit ' + fmt(s.limitOdometer) + '</span></div>';
    return h;
  }

  function factsHtml(v, s) {
    const fee = Number(v.feePerMile) || 0;
    const rows = [
      ['Driven on this lease', fmt(s.driven)],
      ['Left in the allowance', s.milesLeft >= 0 ? fmt(s.milesLeft) : fmt(-s.milesLeft) + ' over'],
      ['Lease ends', fmtDate(s.endIso, true)],
      ['Time left', s.daysLeft > 0 ? plural(s.daysLeft, 'day') : 'Ended'],
      ['Allowance', fmt(v.milesAllowed) + ' miles, ' + v.months + ' months'],
      ['Extra-mile charge', fee ? feeText(fee) : 'Not set']
    ];
    return '<section class="block"><h2>The lease</h2><dl class="facts">' +
      rows.map(r => '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>').join('') + '</dl></section>';
  }

  // ----- chart -----

  const CH = { w: 360, h: 210, l: 6, r: 6, t: 20, b: 24 };

  function chartGeometry(v, s) {
    const d0 = M.dayNum(v.startDate), d1 = M.dayNum(s.endIso);
    const yMin = v.startOdo;
    const yTop = Math.max(s.limitOdometer, s.odometer, s.projectedOdometer || 0);
    const yMax = yMin + (yTop - yMin) * 1.12;
    const x = d => CH.l + (d - d0) / Math.max(1, d1 - d0) * (CH.w - CH.l - CH.r);
    const y = o => CH.h - CH.b - (o - yMin) / Math.max(1, yMax - yMin) * (CH.h - CH.t - CH.b);
    return { d0, d1, yMin, yMax, x, y };
  }

  function chartSvg(v, s) {
    const g = chartGeometry(v, s);
    const rs = M.sortReadings(readingsFor(v)).filter(r => M.dayNum(r.date) <= g.d1);
    const pts = [[g.d0, v.startOdo]].concat(rs.map(r => [M.dayNum(r.date), r.odo]));
    const path = pts.map((p, i) => (i ? 'L' : 'M') + g.x(p[0]).toFixed(1) + ' ' + g.y(p[1]).toFixed(1)).join(' ');
    const last = pts[pts.length - 1];
    const ended = s.phase === 'ended';
    const showProj = s.projectedOdometer != null && !ended && last[0] < g.d1;
    const baseY = CH.h - CH.b;
    let o = '<svg viewBox="0 0 ' + CH.w + ' ' + CH.h + '" role="img" aria-label="Line chart of odometer readings against the lease line. The History tab lists every reading.">';

    // recessive grid: baseline plus two reference levels
    [0.5, 1].forEach(f => {
      const val = v.startOdo + v.milesAllowed * f, yy = g.y(val).toFixed(1);
      o += '<line x1="' + CH.l + '" x2="' + (CH.w - CH.r) + '" y1="' + yy + '" y2="' + yy + '" stroke="var(--rule)" stroke-width="1"/>';
      if (f < 1) o += '<text x="' + CH.l + '" y="' + (yy - 4) + '">' + fmt(val) + '</text>';
    });
    o += '<line x1="' + CH.l + '" x2="' + (CH.w - CH.r) + '" y1="' + baseY + '" y2="' + baseY + '" stroke="var(--rule)" stroke-width="1"/>';

    // today
    const today = M.dayNum(todayIso());
    if (today > g.d0 && today < g.d1) {
      const tx = g.x(today).toFixed(1);
      o += '<line x1="' + tx + '" x2="' + tx + '" y1="' + CH.t + '" y2="' + baseY + '" stroke="var(--ink-2)" stroke-width="1" stroke-dasharray="2 3"/>';
      o += '<text x="' + tx + '" y="' + (CH.h - 7) + '" text-anchor="middle">Today</text>';
    }
    o += '<text x="' + CH.l + '" y="' + (CH.h - 7) + '">' + fmtDate(v.startDate, true) + '</text>';
    o += '<text x="' + (CH.w - CH.r) + '" y="' + (CH.h - 7) + '" text-anchor="end">' + fmtDate(s.endIso, true) + '</text>';

    // lease line
    o += '<line x1="' + g.x(g.d0) + '" y1="' + g.y(v.startOdo) + '" x2="' + g.x(g.d1) + '" y2="' + g.y(s.limitOdometer) + '" stroke="var(--ink-2)" stroke-width="1.5"/>';

    // pace projection
    if (showProj) {
      o += '<line x1="' + g.x(last[0]).toFixed(1) + '" y1="' + g.y(last[1]).toFixed(1) + '" x2="' + g.x(g.d1) + '" y2="' + g.y(s.projectedOdometer).toFixed(1) +
        '" stroke="var(--series)" stroke-width="2" stroke-dasharray="4 4"/>';
    }

    // actual readings
    o += '<path d="' + path + '" fill="none" stroke="var(--series)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>';
    if (pts.length <= 30) {
      pts.slice(1).forEach(p => {
        o += '<circle cx="' + g.x(p[0]).toFixed(1) + '" cy="' + g.y(p[1]).toFixed(1) + '" r="3.5" fill="var(--series)" stroke="var(--concrete)" stroke-width="2"/>';
      });
    } else {
      o += '<circle cx="' + g.x(last[0]).toFixed(1) + '" cy="' + g.y(last[1]).toFixed(1) + '" r="4" fill="var(--series)" stroke="var(--concrete)" stroke-width="2"/>';
    }

    // direct labels at the right edge
    const limY = g.y(s.limitOdometer);
    const xr = CH.w - CH.r;
    if (showProj) {
      const projY = g.y(s.projectedOdometer);
      const projAbove = projY < limY;
      o += '<text class="lbl" x="' + xr + '" y="' + (projAbove ? projY - 7 : projY + 17).toFixed(1) + '" text-anchor="end">On pace ' + fmt(s.projectedOdometer) + '</text>';
      o += '<text class="lbl" x="' + xr + '" y="' + (projAbove ? limY + 15 : limY - 7).toFixed(1) + '" text-anchor="end">Limit ' + fmt(s.limitOdometer) + '</text>';
    } else {
      o += '<text class="lbl" x="' + xr + '" y="' + (limY - 7).toFixed(1) + '" text-anchor="end">Limit ' + fmt(s.limitOdometer) + '</text>';
    }

    o += '<line id="chartCross" y1="' + CH.t + '" y2="' + baseY + '" stroke="var(--ink)" stroke-width="1" visibility="hidden"/>';
    o += '</svg>';
    return o;
  }

  function wireChart(v) {
    const box = $('#chartBox');
    if (!box) return;
    const svg = box.querySelector('svg'), tip = $('#chartTip'), cross = $('#chartCross');
    const s = M.leaseStatus(v, readingsFor(v), todayIso());
    const g = chartGeometry(v, s);
    const rs = M.sortReadings(readingsFor(v));
    const pts = [[g.d0, v.startOdo]].concat(rs.map(r => [M.dayNum(r.date), r.odo]));
    const lastDay = pts[pts.length - 1][0];

    function odoAt(day) {
      if (day <= lastDay) {
        for (let i = 1; i < pts.length; i++) {
          if (day <= pts[i][0]) {
            const a = pts[i - 1], b = pts[i];
            return { v: b[0] === a[0] ? b[1] : a[1] + (b[1] - a[1]) * (day - a[0]) / (b[0] - a[0]), label: 'Odometer' };
          }
        }
        return { v: pts[0][1], label: 'Odometer' };
      }
      if (s.pacePerDay == null) return null;
      return { v: pts[pts.length - 1][1] + s.pacePerDay * (day - lastDay), label: 'At your pace' };
    }

    function show(ev) {
      const rect = svg.getBoundingClientRect();
      const px = (ev.clientX - rect.left) / rect.width * CH.w;
      const frac = Math.min(1, Math.max(0, (px - CH.l) / (CH.w - CH.l - CH.r)));
      const day = Math.round(g.d0 + frac * (g.d1 - g.d0));
      const iso = M.isoFromDayNum(day);
      const cx = g.x(day);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
      const o = odoAt(day);
      tip.innerHTML = '<b>' + fmtDate(iso, true) + '</b><br>Lease line ' + fmt(v.startOdo + M.allowedBy(v, iso)) +
        (o ? '<br>' + o.label + ' ' + fmt(o.v) : '');
      tip.style.display = 'block';
      const left = cx / CH.w * rect.width;
      const tw = tip.offsetWidth;
      tip.style.left = Math.min(rect.width - tw, Math.max(0, left - tw / 2)) + 'px';
    }
    function hide() { tip.style.display = 'none'; cross.setAttribute('visibility', 'hidden'); }
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('pointercancel', hide);
  }

  // ----- history -----

  function historyHtml(v) {
    const rows = M.historyRows(v, readingsFor(v)).reverse();
    let h = '<h1 class="screen-title">History</h1>';
    if (!rows.length) {
      return h + '<div class="empty"><p><b>No readings yet.</b></p><p>Tap Log odometer whenever you think of it. Once a week is plenty.</p></div>';
    }
    h += '<p class="screen-sub">' + plural(rows.length, 'reading') + ' since ' + fmtDate(v.startDate, true) + '.</p><ul class="readings">';
    rows.forEach(row => {
      const r = row.reading;
      const tone = row.delta < 0 ? 'over' : 'under';
      const since = (row.miles >= 0 ? '+' : '') + fmt(row.miles) + ' mi' +
        (row.days > 0 ? ' in ' + plural(row.days, 'day') + ' (' + fmt(row.perDay) + ' a day)' : '');
      h += '<li><span class="date">' + fmtDate(r.date, true) + '</span><span class="odo">' + fmt(r.odo) + '</span>' +
        '<span class="since">' + since + '</span>' +
        '<span class="stand tone" data-tone="' + tone + '" style="justify-content:flex-end;font-size:.9rem">' + fmt(Math.abs(row.delta)) + (row.delta < 0 ? ' over' : ' under') +
        (row.cost > 0 ? ' (' + money(row.cost) + ')' : '') + '</span>' +
        (r.note ? '<span class="memo">' + esc(r.note) + '</span>' : '') +
        '<button class="remove" type="button" data-remove="' + esc(r.id) + '">Remove this reading</button></li>';
    });
    h += '<li><span class="date">' + fmtDate(v.startDate, true) + '</span><span class="odo">' + fmt(v.startOdo) + '</span><span class="since">Lease start</span></li>';
    return h + '</ul>';
  }

  // ----- setup -----

  function setupHtml(v) {
    const first = !state.vehicles.length;
    const val = k => v ? esc(v[k]) : '';
    let h = '<h1 class="screen-title">' + (v ? 'Lease setup' : first ? 'Set up your lease' : 'Add a vehicle') + '</h1>' +
      '<p class="screen-sub">' + (v ? 'These numbers come from your lease agreement.' : 'Enter the numbers from your lease agreement. You can change them later.') + '</p>';

    h += '<form class="stack" id="leaseForm" novalidate>' +
      '<div class="field"><label for="fName">Vehicle name</label><input id="fName" maxlength="40" autocomplete="off" placeholder="My truck" value="' + val('name') + '"></div>' +
      '<div class="two">' +
      '<div class="field"><label for="fStart">Lease start date</label><input id="fStart" type="date" value="' + val('startDate') + '"></div>' +
      '<div class="field"><label for="fMonths">Length in months</label><input id="fMonths" inputmode="numeric" placeholder="36" value="' + val('months') + '"></div>' +
      '</div>' +
      '<div class="field"><label for="fMiles">Total miles allowed</label><input id="fMiles" inputmode="numeric" placeholder="36,000" value="' + (v ? fmt(v.milesAllowed) : '') + '">' +
      '<p class="hint" id="fMilesHint">The whole lease, not per year.</p></div>' +
      '<div class="two">' +
      '<div class="field"><label for="fOdo">Odometer at lease start</label><input id="fOdo" inputmode="numeric" placeholder="12" value="' + (v ? fmt(v.startOdo) : '') + '"></div>' +
      '<div class="field"><label for="fFee">Charge per extra mile ($)</label><input id="fFee" inputmode="decimal" placeholder="0.25" value="' + val('feePerMile') + '"></div>' +
      '</div>' +
      '<p class="error" id="leaseError" role="alert"></p>' +
      '<div class="btn-row">' +
      (!v && !first ? '<button class="btn quiet" type="button" id="cancelAdd">Cancel</button>' : '') +
      '<button class="btn primary" type="submit">' + (v ? 'Save lease' : 'Save and start tracking') + '</button></div>' +
      (v ? '<div class="btn-row"><button class="btn danger" type="button" id="deleteVehicle">Delete this vehicle</button></div>' : '') +
      '</form>';

    h += '<section class="block" style="margin-top:30px;border-top:1px solid var(--rule)"><h2>Google Sheet</h2><div id="sheetState">' + sheetStateHtml() + '</div>';
    if (conn.url) {
      h += '<div class="btn-row" style="margin-top:14px"><button class="btn" type="button" id="syncNowBtn">Sync now</button>' +
        '<button class="btn quiet" type="button" id="disconnectBtn">Disconnect</button></div>';
    } else {
      h += '<ol class="steps">' +
        '<li>Create a Google Sheet, then open Extensions, Apps Script.</li>' +
        '<li>Paste in the script and set your own passphrase on the first line. <button class="remove" style="display:inline;padding:0;min-height:0;border:0;background:none;text-decoration:underline" type="button" id="copyScript">Copy the script</button></li>' +
        '<li>Deploy as a web app: run as you, access for anyone.</li>' +
        '<li>Paste the web app URL and your passphrase below.</li></ol>' +
        '<form class="stack" id="connForm" novalidate>' +
        '<div class="field"><label for="cUrl">Web app URL</label><input id="cUrl" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://script.google.com/macros/s/…/exec"></div>' +
        '<div class="field"><label for="cKey">Passphrase</label><input id="cKey" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"></div>' +
        '<p class="error" id="connError" role="alert"></p>' +
        '<div class="btn-row"><button class="btn primary" type="submit" id="connectBtn">Connect Sheet</button></div></form>';
    }
    return h + '</section>';
  }

  function sheetStateHtml() {
    if (!conn.url) {
      return '<p>Readings are saved on this phone only. Connect a Google Sheet to back them up and see them anywhere.</p>';
    }
    if (sync.state === 'error') return '<p class="error">' + esc(sync.message) + '</p>';
    if (sync.state === 'offline') {
      return '<p>Can’t reach your Sheet right now. ' + (queue.length ? plural(queue.length, 'change') + ' will be saved when the connection is back.' : 'Nothing is waiting to be saved.') + '</p>';
    }
    if (sync.state === 'saving') return '<p>Saving to your Sheet…</p>';
    const when = conn.lastSaved
      ? new Date(conn.lastSaved).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : null;
    return '<p>Connected. ' + (when ? 'Last saved ' + when + '.' : '') + '</p>';
  }

  const digits = s => { const d = String(s).replace(/[^\d]/g, ''); return d ? parseInt(d, 10) : NaN; };

  function wireSetup(v) {
    const miles = $('#fMiles'), months = $('#fMonths'), hint = $('#fMilesHint');
    function updateHint() {
      const m = digits(miles.value), mo = digits(months.value);
      hint.textContent = m > 0 && mo > 0
        ? 'That is ' + fmt(m / mo * 12) + ' miles a year.'
        : 'The whole lease, not per year.';
    }
    miles.addEventListener('input', updateHint);
    months.addEventListener('input', updateHint);
    updateHint();

    $('#leaseForm').addEventListener('submit', ev => {
      ev.preventDefault();
      const err = $('#leaseError');
      const vehicle = {
        id: v ? v.id : newId('v'),
        name: $('#fName').value.trim(),
        startDate: $('#fStart').value,
        months: digits(months.value),
        milesAllowed: digits(miles.value),
        startOdo: digits($('#fOdo').value),
        feePerMile: parseFloat($('#fFee').value.replace(/[^\d.]/g, '')) || 0
      };
      if (!vehicle.name) { err.textContent = 'Give the vehicle a name.'; return; }
      if (!vehicle.startDate) { err.textContent = 'Pick the lease start date.'; return; }
      if (!(vehicle.months >= 1 && vehicle.months <= 120)) { err.textContent = 'Enter the lease length in months, for example 36.'; return; }
      if (!(vehicle.milesAllowed > 0)) { err.textContent = 'Enter the total miles the lease allows.'; return; }
      if (!Number.isFinite(vehicle.startOdo)) { err.textContent = 'Enter the odometer reading when the lease began. Use 0 if you are not sure.'; return; }
      const wasNew = !v;
      addingVehicle = false;
      ui.activeId = vehicle.id;
      if (wasNew) ui.tab = 'status';
      commit({ type: 'upsertVehicle', vehicle: vehicle });
      toast('Lease saved');
      window.scrollTo(0, 0);
    });

    const cancel = $('#cancelAdd');
    if (cancel) cancel.addEventListener('click', () => { addingVehicle = false; render(); });

    const del = $('#deleteVehicle');
    if (del) del.addEventListener('click', () => {
      confirmAction('Delete ' + v.name + '?', 'This removes the lease and all ' + plural(readingsFor(v).length, 'reading') + ' for it, on this phone and in your Sheet.', 'Delete vehicle', () => {
        commit({ type: 'deleteVehicle', id: v.id });
        toast('Vehicle deleted');
      });
    });

    const copy = $('#copyScript');
    if (copy) copy.addEventListener('click', async () => {
      try {
        const text = await (await fetch('google-sheet/Code.gs')).text();
        await navigator.clipboard.writeText(text);
        toast('Script copied');
      } catch (e) { toast('Could not copy. Open google-sheet/Code.gs in the repo instead.'); }
    });

    const form = $('#connForm');
    if (form) form.addEventListener('input', saveDraft);
    if (form) form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const err = $('#connError'), btn = $('#connectBtn');
      const url = $('#cUrl').value.trim(), key = $('#cKey').value.trim();
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(url)) {
        err.textContent = 'The URL should look like https://script.google.com/macros/s/…/exec';
        return;
      }
      if (!key) { err.textContent = 'Enter the passphrase you set in the script.'; return; }
      err.textContent = ''; btn.disabled = true; btn.textContent = 'Connecting…';
      try {
        await callSheet(url, key, []);                // a read-only test before anything is stored
        conn = { url: url, key: key, lastSaved: null };
        store.set('lt.conn.v1', conn);
        try { localStorage.removeItem('lt.draft.v1'); } catch (e) { /* nothing to clear */ }
        // everything already on this phone gets written to the Sheet on first sync
        queue = state.vehicles.map(x => ({ type: 'upsertVehicle', vehicle: x }))
          .concat(state.readings.map(x => ({ type: 'upsertReading', reading: x })));
        persist();
        const hadVehicles = state.vehicles.length > 0;
        addingVehicle = false;
        await syncNow();
        if (!hadVehicles && state.vehicles.length) ui.tab = 'status';   // a second device: go straight to the numbers
        persist();
        toast('Sheet connected');
        render();
      } catch (e) {
        err.textContent = describeSyncError(e.message);
        btn.disabled = false; btn.textContent = 'Connect Sheet';
      }
    });

    const again = $('#syncNowBtn');
    if (again) again.addEventListener('click', () => syncNow());
    const off = $('#disconnectBtn');
    if (off) off.addEventListener('click', () => {
      confirmAction('Disconnect the Sheet?', 'Your readings stay on this phone and in the Sheet. New readings will stop being saved to the Sheet.', 'Disconnect', () => {
        conn = { url: '', key: '', lastSaved: null };
        store.set('lt.conn.v1', conn);
        queue = []; persist();
        setSync('local'); render();
      });
    });
  }

  // ---------- dialogs ----------

  function openLog() {
    const v = activeVehicle();
    if (!v) return;
    const s = M.leaseStatus(v, readingsFor(v), todayIso());
    $('#logLede').textContent = s.readingCount
      ? 'Last reading: ' + fmt(s.odometer) + ' on ' + fmtDate(s.lastReading.date) + '.'
      : 'Lease started at ' + fmt(v.startOdo) + '.';
    $('#logOdo').value = '';
    $('#logDate').value = todayIso();
    $('#logDate').max = todayIso();
    $('#logDate').min = v.startDate;
    $('#logNote').value = '';
    $('#logError').textContent = '';
    $('#logPreview').textContent = '';
    $('#logDialog').showModal();
    $('#logOdo').focus();
  }

  function wireStatic() {
    $('#logBtn').addEventListener('click', openLog);

    $('#logOdo').addEventListener('input', () => {
      const v = activeVehicle(); if (!v) return;
      const el = $('#logOdo');
      const n = digits(el.value);
      el.value = Number.isFinite(n) ? fmt(n) : '';
      const s = M.leaseStatus(v, readingsFor(v), todayIso());
      const diff = n - s.odometer;
      $('#logPreview').textContent = Number.isFinite(n) && diff >= 0
        ? '+' + plural(diff, 'mile') + ' since ' + (s.readingCount ? fmtDate(s.lastReading.date) : 'lease start')
        : '';
      $('#logError').textContent = '';
    });

    $('#logForm').addEventListener('submit', ev => {
      ev.preventDefault();
      const v = activeVehicle(); if (!v) return;
      const reading = {
        id: newId('r'), vehicleId: v.id,
        date: $('#logDate').value, odo: digits($('#logOdo').value),
        note: $('#logNote').value.trim(), loggedAt: new Date().toISOString()
      };
      if (reading.date > todayIso()) { $('#logError').textContent = 'That date is in the future.'; return; }
      const problem = M.checkReading(v, readingsFor(v), reading, d => fmtDate(d, true), fmt);
      if (problem) { $('#logError').textContent = problem; return; }
      $('#logDialog').close();
      ui.tab = 'status';
      commit({ type: 'upsertReading', reading: reading });
      toast('Reading saved');
      window.scrollTo(0, 0);
    });

    document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
      ui.tab = b.dataset.tab; addingVehicle = false; persist(); render(); window.scrollTo(0, 0);
    }));

    $('#vehicleBtn').addEventListener('click', () => {
      const cur = activeVehicle();
      $('#vehicleList').innerHTML = state.vehicles.map(v =>
        '<button type="button" data-vehicle="' + esc(v.id) + '" aria-pressed="' + (cur && cur.id === v.id) + '"><b>' + esc(v.name) + '</b>' +
        '<span>' + fmt(v.milesAllowed) + ' miles over ' + v.months + ' months</span></button>').join('');
      $('#vehicleDialog').showModal();
    });
    $('#vehicleList').addEventListener('click', ev => {
      const b = ev.target.closest('[data-vehicle]'); if (!b) return;
      ui.activeId = b.dataset.vehicle; ui.tab = 'status'; addingVehicle = false; persist();
      $('#vehicleDialog').close(); render();
    });
    $('#addVehicleBtn').addEventListener('click', () => {
      $('#vehicleDialog').close(); addingVehicle = true; ui.tab = 'setup'; render(); window.scrollTo(0, 0);
    });

    $('#syncBtn').addEventListener('click', () => {
      if (!conn.url || sync.state === 'error') { ui.tab = 'setup'; addingVehicle = false; render(); const el = $('#sheetState'); if (el) el.scrollIntoView({ block: 'center' }); }
      else syncNow();
    });

    $('#view').addEventListener('click', ev => {
      const b = ev.target.closest('[data-remove]'); if (!b) return;
      const r = state.readings.find(x => x.id === b.dataset.remove); if (!r) return;
      confirmAction('Remove this reading?', fmt(r.odo) + ' on ' + fmtDate(r.date, true) + '. It is removed here and in your Sheet.', 'Remove reading', () => {
        commit({ type: 'deleteReading', id: r.id });
        toast('Reading removed');
      });
    });

    document.querySelectorAll('dialog').forEach(d => {
      d.addEventListener('click', ev => { if (ev.target === d || ev.target.closest('[data-close]')) d.close(); });
    });

    window.addEventListener('online', syncNow);
    window.addEventListener('offline', () => { if (conn.url) setSync('offline'); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); syncNow(); } });
  }

  let confirmFn = null;
  function confirmAction(title, body, yesLabel, fn) {
    $('#confirmTitle').textContent = title;
    $('#confirmBody').textContent = body;
    $('#confirmYes').textContent = yesLabel;
    confirmFn = fn;
    $('#confirmDialog').showModal();
  }

  let toastTimer;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---------- start ----------

  wireStatic();
  $('#confirmYes').addEventListener('click', () => { $('#confirmDialog').close(); if (confirmFn) confirmFn(); confirmFn = null; });
  setSync(conn.url ? 'saved' : 'local');
  render();
  syncNow();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    const hadWorker = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadWorker && !reloaded) { reloaded = true; location.reload(); }   // a new version just took over
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
