// ===== SETUP: bot protection =====
// The reCAPTCHA v3 SECRET key is read from Script Properties instead of being
// hardcoded here — see "Project Settings > Script Properties" in the Apps
// Script editor, key name "RECAPTCHA_SECRET" (get the value from
// https://www.google.com/recaptcha/admin — same registration as the site key
// in the HTML). Leave the property unset to skip recaptcha verification —
// the honeypot, field validation, and throttle below still apply either way.
var RECAPTCHA_SECRET = PropertiesService.getScriptProperties().getProperty('RECAPTCHA_SECRET') || '';

// Max submissions allowed from the same email address per hour, per tab.
var THROTTLE_MAX = 5;

// Required fields, per tab. The registration form on the main site collects a
// phone number; the enrollment form does not (phone is not an Enrollments
// column), so the two tabs can't share one list.
var REQUIRED_FIELDS = {
  'Registrations': ['player_name', 'parent_name', 'email', 'phone'],
  'Enrollments':   ['player_name', 'parent_name', 'email']
};

// Canonical column order for tabs we control. When one of these tabs is empty,
// these headers are written in this exact order, so the layout never depends on
// whichever payload happens to arrive first. Any tab not listed here falls back
// to the keys of the first submission, as before.
var TAB_HEADERS = {
  'Enrollments': [
    'player_name', 'age_group', 'parent_name', 'email', 'package',
    'registration', 'package_total', 'size_shirt', 'size_shorts',
    'size_socks', 'uniform_kit', 'uniform_total', 'grand_total',
    'paid_reg', 'paid_package', 'paid_uniform', 'submitted_at'
  ]
};

// The spreadsheet this script writes to. Referenced explicitly by ID so it
// works from a standalone Web App deployment (getActiveSpreadsheet() only
// works for scripts bound to a sheet, and returns null otherwise).
// Like the reCAPTCHA secret, the ID is read from Script Properties (key name
// "SPREADSHEET_ID") so it never appears in source code. Copy it from the
// sheet's URL: https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit
var SPREADSHEET_ID = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');

// Address that receives an email alert for each new submission.
// Set in Script Properties (key name "NOTIFY_EMAIL").
var NOTIFY_EMAIL = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL');

// Google Sheets treats a cell starting with =, +, -, or @ as a formula.
// User-submitted text (names, addresses, signatures — and even arbitrary
// JSON keys, since a POST body can be crafted by hand, not just by the
// form) must not be allowed to land in a cell as a live formula.
function sheetSafe(v) {
  if (v === null || v === undefined) return '';
  // Numbers, booleans, and dates aren't formula-injection vectors and should
  // keep their type so the sheet stores them as values rather than as text.
  if (typeof v === 'number' || typeof v === 'boolean' || v instanceof Date) return v;
  var s = String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

// Diagnostic logging — writes to a "Debug" tab so you can see what happened
// on each submission without digging through the Executions panel.
function logDebug(label, payload) {
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var dbg = ss.getSheetByName('Debug') || ss.insertSheet('Debug');
    dbg.appendRow([new Date(), label, JSON.stringify(payload)]);
  } catch (e) { /* never let logging itself break the flow */ }
}

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok', message: 'This endpoint accepts POST requests only.' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);

  try {
    var data = JSON.parse(e.postData.contents);
    var tabName = data.sheet || 'Registrations';
    delete data.sheet;

    logDebug('doPost start', data);

    // 1. Honeypot — real visitors never fill this in. If it's set, this is
    // a bot: report success (so it has no signal it was caught) but do
    // nothing else — no sheet write, no email.
    var isBot = !!data.website;
    delete data.website;

    if (isBot) {
      logDebug('rejected: honeypot', {});
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'ok' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 2. Required-field validation — per tab, see REQUIRED_FIELDS above.
    var required = REQUIRED_FIELDS[tabName] || ['player_name', 'parent_name', 'email'];
    for (var i = 0; i < required.length; i++) {
      if (!data[required[i]]) {
        logDebug('rejected: missing field', required[i]);
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'error', message: 'missing ' + required[i] }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email)) {
      logDebug('rejected: invalid email', data.email);
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'error', message: 'invalid email' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 3. reCAPTCHA v3 verification.
    var recaptchaToken = data.recaptcha_token;
    delete data.recaptcha_token;

    if (RECAPTCHA_SECRET) {
      if (!recaptchaToken) {
        logDebug('rejected: missing recaptcha token', {});
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'error', message: 'missing recaptcha token' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      var verify = UrlFetchApp.fetch('https://www.google.com/recaptcha/api/siteverify', {
        method: 'post',
        payload: { secret: RECAPTCHA_SECRET, response: recaptchaToken }
      });
      var result = JSON.parse(verify.getContentText());
      logDebug('recaptcha result', result);

      // "browser-error" means Google's own verification infrastructure
      // failed to evaluate the session — a known side effect of reCAPTCHA
      // running inside a cross-origin iframe (Wix serves this embed from
      // filesusr.com, not the site's own domain), not a bot signal. Treat
      // it as a pass rather than a rejection. Everything else (bad score,
      // wrong action, genuine failure) is still rejected as before.
      var isBrowserError = result['error-codes'] && result['error-codes'].indexOf('browser-error') !== -1;
      if (!isBrowserError && (!result.success || result.score < 0.5 || result.action !== 'register')) {
        logDebug('rejected: recaptcha check failed', result);
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'error', message: 'recaptcha failed' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    // 4. Per-email throttle.
    var cache = CacheService.getScriptCache();
    var cacheKey = 'sub_' + tabName + '_' + String(data.email).toLowerCase();
    var count = parseInt(cache.get(cacheKey) || '0', 10);
    if (count >= THROTTLE_MAX) {
      logDebug('rejected: rate limited', data.email);
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'error', message: 'rate limited, try again later' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    cache.put(cacheKey, String(count + 1), 3600); // 1 hour

    // Timestamp on the server — the client clock and timezone can't be trusted.
    data.submitted_at = new Date();

    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheetByName(tabName);
    if (!sheet) sheet = ss.insertSheet(tabName);

    var keys = Object.keys(data);

    // write headers on first use
    if (sheet.getLastRow() === 0) {
      var initial = TAB_HEADERS[tabName] || keys;
      sheet.appendRow(initial.map(function (h) { return sheetSafe(h); }));
      sheet.getRange(1, 1, 1, initial.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }

    // match the existing header order; add any new columns on the end
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
                       .getValues()[0].filter(String);
    keys.forEach(function (k) {
      if (headers.indexOf(k) === -1) {
        headers.push(k);
        sheet.getRange(1, headers.length).setValue(sheetSafe(k)).setFontWeight('bold');
      }
    });

    var row = headers.map(function (h) {
      return data[h] !== undefined ? sheetSafe(data[h]) : '';
    });
    sheet.appendRow(row);
    logDebug('wrote row', row);

    // email alert (skipped if NOTIFY_EMAIL is not set)
    if (NOTIFY_EMAIL) {
      var who = data.player_name || 'Unknown player';
      MailApp.sendEmail({
        to: NOTIFY_EMAIL,
        subject: '[' + tabName + '] ' + who,
        body: headers.map(function (h) {
          return h + ': ' + (data[h] || '');
        }).join('\n')
      });
    }

    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    logDebug('EXCEPTION', err.message);
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', message: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}