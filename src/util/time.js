'use strict';
// Helper waktu WIB (Asia/Jakarta) tanpa dependency.
const DEFAULT_TZ = 'Asia/Jakarta';

function now() {
  return Math.floor(Date.now() / 1000);
}

function partsInTz(ts, tz = DEFAULT_TZ) {
  const d = typeof ts === 'number' ? new Date(ts * 1000) : ts instanceof Date ? ts : new Date();
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const out = {};
  for (const p of fmt.formatToParts(d)) if (p.type !== 'literal') out[p.type] = p.value;
  return {
    year: parseInt(out.year, 10),
    month: parseInt(out.month, 10),
    day: parseInt(out.day, 10),
    hour: parseInt(out.hour, 10) % 24,
    minute: parseInt(out.minute, 10),
    second: parseInt(out.second, 10),
  };
}

// 'DDMMYYYY' untuk nama file
function ddmmyyyy(ts, tz = DEFAULT_TZ) {
  const p = partsInTz(ts, tz);
  return `${String(p.day).padStart(2, '0')}${String(p.month).padStart(2, '0')}${p.year}`;
}

// 'YYYY-MM-DD' (untuk grouping per hari)
function isoDate(ts, tz = DEFAULT_TZ) {
  const p = partsInTz(ts, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// 'DD/MM/YYYY HH:mm'
function formatDateTime(ts, tz = DEFAULT_TZ) {
  if (!ts) return '-';
  const p = partsInTz(ts, tz);
  return `${String(p.day).padStart(2, '0')}/${String(p.month).padStart(2, '0')}/${p.year} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

function formatDate(ts, tz = DEFAULT_TZ) {
  if (!ts) return '-';
  const p = partsInTz(ts, tz);
  return `${String(p.day).padStart(2, '0')}/${String(p.month).padStart(2, '0')}/${p.year}`;
}

// menit sejak tengah malam WIB
function minutesOfDay(ts, tz = DEFAULT_TZ) {
  const p = partsInTz(ts, tz);
  return p.hour * 60 + p.minute;
}

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// unix detik awal hari (WIB) untuk tanggal ts
function startOfDay(ts, tz = DEFAULT_TZ) {
  const p = partsInTz(ts, tz);
  // WIB = UTC+7 tanpa DST
  const offsetMin = tzOffsetMinutes(tz, ts);
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0) / 1000) - offsetMin * 60;
}

function tzOffsetMinutes(tz = DEFAULT_TZ, ts = now()) {
  const d = new Date(ts * 1000);
  const p = partsInTz(ts, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - d.getTime()) / 60000);
}

module.exports = {
  DEFAULT_TZ, now, partsInTz, ddmmyyyy, isoDate, formatDateTime, formatDate,
  minutesOfDay, parseHHMM, startOfDay, tzOffsetMinutes,
};
