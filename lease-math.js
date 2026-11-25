/* Lease Tracker — all the lease arithmetic, kept free of any screen code so it can be tested on its own.
   Dates are plain 'YYYY-MM-DD' strings throughout. */
(function (root) {
  'use strict';

  const DAY = 864e5;

  function dayNum(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / DAY);
  }

  function isoFromDayNum(n) {
    return new Date(n * DAY).toISOString().slice(0, 10);
  }

  // Add calendar months, clamping the day (Jan 31 + 1 month = Feb 28/29).
  function addMonths(iso, months) {
    const [y, m, d] = iso.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1 + months, 1));
    const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    first.setUTCDate(Math.min(d, lastDay));
    return first.toISOString().slice(0, 10);
  }

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  function sortReadings(readings) {
    return readings.slice().sort((a, b) =>
      a.date === b.date ? a.odo - b.odo : (a.date < b.date ? -1 : 1));
  }

  function leaseEnd(vehicle) {
    return addMonths(vehicle.startDate, Number(vehicle.months));
  }

  // Miles the lease allows by a given date, spread evenly day by day.
  function allowedBy(vehicle, iso) {
    const start = dayNum(vehicle.startDate);
    const total = dayNum(leaseEnd(vehicle)) - start;
    if (total <= 0) return 0;
    const elapsed = clamp(dayNum(iso) - start, 0, total);
    return vehicle.milesAllowed * elapsed / total;
  }

  /* Everything the Status screen shows.
     `readings` should already be filtered to this vehicle. */
  function leaseStatus(vehicle, readings, todayIso) {
    const sorted = sortReadings(readings);
    const startDay = dayNum(vehicle.startDate);
    const endIso = leaseEnd(vehicle);
    const endDay = dayNum(endIso);
    const totalDays = Math.max(1, endDay - startDay);
    const today = dayNum(todayIso);

    const last = sorted.length
      ? sorted[sorted.length - 1]
      : { date: vehicle.startDate, odo: vehicle.startOdo, isStart: true };
    const lastDay = dayNum(last.date);

    const odometer = last.odo;
    const driven = odometer - vehicle.startOdo;
    const elapsedToday = clamp(today - startDay, 0, totalDays);
    const allowedToday = vehicle.milesAllowed * elapsedToday / totalDays;
    const delta = allowedToday - driven;            // positive = under the lease line

    const elapsedAtLast = clamp(lastDay - startDay, 0, totalDays);
    const pacePerDay = elapsedAtLast > 0 ? driven / elapsedAtLast : null;
    const projectedDriven = pacePerDay == null
      ? null
      : driven + pacePerDay * (totalDays - elapsedAtLast);
    const projectedDelta = projectedDriven == null ? null : vehicle.milesAllowed - projectedDriven;
    const fee = Number(vehicle.feePerMile) || 0;

    const daysLeft = totalDays - elapsedToday;
    const milesLeft = vehicle.milesAllowed - driven;
    const perDay = daysLeft > 0 ? milesLeft / daysLeft : null;

    let phase = 'active';
    if (today < startDay) phase = 'not-started';
    else if (today >= endDay) phase = 'ended';

    let tone = 'under';
    if (delta < 0) tone = 'over';
    else if (projectedDelta != null && projectedDelta < 0) tone = 'watch';

    return {
      phase, tone,
      endIso, totalDays, elapsedToday, daysLeft,
      odometer, driven, allowedToday, delta,
      lineOdometerToday: vehicle.startOdo + allowedToday,
      limitOdometer: vehicle.startOdo + vehicle.milesAllowed,
      costToday: Math.max(0, -delta) * fee,
      pacePerDay,
      projectedDriven, projectedDelta,
      projectedOdometer: projectedDriven == null ? null : vehicle.startOdo + projectedDriven,
      projectedCost: projectedDelta == null ? null : Math.max(0, -projectedDelta) * fee,
      milesLeft, perDay,
      perWeek: perDay == null ? null : perDay * 7,
      perMonth: perDay == null ? null : perDay * 365.25 / 12,
      lastReading: last,
      staleDays: last.isStart ? null : today - lastDay,
      readingCount: sorted.length
    };
  }

  /* History rows, oldest first: each reading with miles since the previous one
     and where it stood against the lease line on that date. */
  function historyRows(vehicle, readings) {
    const sorted = sortReadings(readings);
    let prev = { date: vehicle.startDate, odo: vehicle.startOdo };
    const fee = Number(vehicle.feePerMile) || 0;
    return sorted.map(r => {
      const days = dayNum(r.date) - dayNum(prev.date);
      const miles = r.odo - prev.odo;
      const delta = allowedBy(vehicle, r.date) - (r.odo - vehicle.startOdo);
      const row = {
        reading: r, miles, days,
        perDay: days > 0 ? miles / days : null,
        delta, cost: Math.max(0, -delta) * fee
      };
      prev = r;
      return row;
    });
  }

  /* Check a new reading before saving. Returns null if fine, or a sentence explaining the problem. */
  function checkReading(vehicle, readings, candidate, fmtDate, fmtNum) {
    if (!Number.isFinite(candidate.odo) || candidate.odo < 0) return 'Enter the number on your odometer.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate.date || '')) return 'Pick the date you read the odometer.';
    if (candidate.date < vehicle.startDate) {
      return 'That date is before the lease started (' + fmtDate(vehicle.startDate) + ').';
    }
    if (candidate.odo < vehicle.startOdo) {
      return 'That is lower than the odometer at lease start (' + fmtNum(vehicle.startOdo) + ').';
    }
    const others = sortReadings(readings.filter(r => r.id !== candidate.id));
    const before = others.filter(r => r.date <= candidate.date).pop();
    const after = others.find(r => r.date > candidate.date);
    if (before && candidate.odo < before.odo) {
      return 'That is lower than your reading on ' + fmtDate(before.date) + ' (' + fmtNum(before.odo) + '). Check the number.';
    }
    if (after && candidate.odo > after.odo) {
      return 'That is higher than your later reading on ' + fmtDate(after.date) + ' (' + fmtNum(after.odo) + '). Check the number or the date.';
    }
    return null;
  }

  const api = { dayNum, isoFromDayNum, addMonths, leaseEnd, allowedBy, sortReadings, leaseStatus, historyRows, checkReading };
  root.LeaseMath = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
