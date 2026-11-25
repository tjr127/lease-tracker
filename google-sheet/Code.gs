const PASSPHRASE = 'change-me';   // <-- 1. Replace change-me with your own passphrase. Keep the quotes.

/**
 * Lease Tracker — Google Sheet backend.
 *
 * Setup (once):
 *   1. In your Google Sheet: Extensions > Apps Script. Delete what is there and paste this whole file.
 *   2. Change PASSPHRASE on the first line to something only you know.
 *   3. Deploy > New deployment > type "Web app".
 *        Execute as:      Me
 *        Who has access:  Anyone
 *      Approve the permission prompt, then copy the Web app URL (it ends in /exec).
 *   4. In the Lease Tracker app: Lease setup > Google Sheet. Paste the URL and your passphrase.
 *
 * If you edit this script later: Deploy > Manage deployments > edit (pencil) > Version: New version.
 * That keeps the same URL.
 *
 * The script creates two tabs, Vehicles and Readings. You can read, sort, chart, and edit them
 * by hand. Leave the header row and the id columns alone; a row you add yourself can leave id blank.
 */

const TABS = {
  vehicles: {
    name: 'Vehicles',
    cols: ['id', 'name', 'start_date', 'months', 'miles_allowed', 'start_odometer', 'fee_per_mile'],
    keys: ['id', 'name', 'startDate', 'months', 'milesAllowed', 'startOdo', 'feePerMile'],
    dates: ['startDate'],
    numbers: ['months', 'milesAllowed', 'startOdo', 'feePerMile'],
    prefix: 'v'
  },
  readings: {
    name: 'Readings',
    cols: ['id', 'vehicle_id', 'date', 'odometer', 'note', 'logged_at'],
    keys: ['id', 'vehicleId', 'date', 'odo', 'note', 'loggedAt'],
    dates: ['date'],
    numbers: ['odo'],
    prefix: 'r'
  }
};

function doGet() {
  return json_({ ok: true, app: 'Lease Tracker', message: 'The script is deployed. Paste this URL into the app.' });
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json_({ ok: false, error: 'bad-request' }); }

  if (PASSPHRASE === 'change-me' || !PASSPHRASE) return json_({ ok: false, error: 'passphrase-not-set' });
  if (body.key !== PASSPHRASE) return json_({ ok: false, error: 'bad-key' });

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    (body.ops || []).forEach(function (op) { applyOp_(ss, op); });
    return json_({ ok: true, vehicles: readAll_(ss, TABS.vehicles), readings: readAll_(ss, TABS.readings) });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (err) { /* lock was never taken */ }
  }
}

/** Optional: run this once from the editor to create the tabs before the first sync. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  sheet_(ss, TABS.vehicles);
  sheet_(ss, TABS.readings);
}

// ---------- internals ----------

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Sheets would read text starting with = + - or @ as a formula. A leading apostrophe keeps it as text.
function plainText_(v) {
  return (typeof v === 'string' && /^[=+\-@]/.test(v)) ? "'" + v : v;
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

function sheet_(ss, tab) {
  var sh = ss.getSheetByName(tab.name);
  if (!sh) {
    sh = ss.insertSheet(tab.name);
    sh.getRange(1, 1, 1, tab.cols.length).setValues([tab.cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function applyOp_(ss, op) {
  if (op.type === 'upsertVehicle') upsert_(ss, TABS.vehicles, op.vehicle);
  else if (op.type === 'upsertReading') upsert_(ss, TABS.readings, op.reading);
  else if (op.type === 'deleteReading') removeWhere_(ss, TABS.readings, 0, op.id);
  else if (op.type === 'deleteVehicle') {
    removeWhere_(ss, TABS.vehicles, 0, op.id);
    removeWhere_(ss, TABS.readings, 1, op.id);     // its readings go with it
  }
}

function upsert_(ss, tab, item) {
  if (!item || !item.id) return;
  var sh = sheet_(ss, tab);
  var row = tab.keys.map(function (k) { return item[k] == null ? '' : plainText_(item[k]); });
  var last = sh.getLastRow();
  if (last > 1) {
    var ids = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(item.id)) {
        sh.getRange(i + 2, 1, 1, row.length).setValues([row]);
        return;
      }
    }
  }
  sh.appendRow(row);
}

function removeWhere_(ss, tab, colIndex, value) {
  var sh = sheet_(ss, tab);
  var last = sh.getLastRow();
  if (last < 2) return;
  var vals = sh.getRange(2, colIndex + 1, last - 1, 1).getValues();
  for (var i = vals.length - 1; i >= 0; i--) {            // bottom up so row numbers stay valid
    if (String(vals[i][0]) === String(value)) sh.deleteRow(i + 2);
  }
}

function readAll_(ss, tab) {
  var sh = sheet_(ss, tab);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var range = sh.getRange(2, 1, last - 1, tab.cols.length);
  var rows = range.getValues();
  var tz = ss.getSpreadsheetTimeZone();
  var out = [];
  rows.forEach(function (row, i) {
    var blank = row.every(function (c) { return c === '' || c == null; });
    if (blank) return;
    if (row[0] === '' || row[0] == null) {                 // a row typed in by hand: give it an id
      row[0] = tab.prefix + new Date().getTime().toString(36) + i;
      sh.getRange(i + 2, 1).setValue(row[0]);
    }
    var item = {};
    tab.keys.forEach(function (k, c) {
      var val = row[c];
      if (tab.dates.indexOf(k) >= 0) {
        val = isDate_(val) ? Utilities.formatDate(val, tz, 'yyyy-MM-dd') : String(val).slice(0, 10);
      } else if (tab.numbers.indexOf(k) >= 0) {
        val = Number(val) || 0;
      } else if (isDate_(val)) {
        val = val.toISOString();
      } else {
        val = String(val);
      }
      item[k] = val;
    });
    out.push(item);
  });
  return out;
}
