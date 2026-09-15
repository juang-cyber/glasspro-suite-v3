'use strict';
// Penentuan Part (sesi proses) berdasarkan jam WIB.
const { DEFAULTS } = require('../settings-defaults');
const time = require('../util/time');

const PART_KEYS = ['p1', 'p2', 'p3'];

function partsSetting(settings) {
  const src = (settings && settings.parts) || {};
  const out = {};
  for (const k of PART_KEYS) out[k] = { ...DEFAULTS.parts[k], ...(src[k] || {}) };
  return out;
}

function isValidPart(part) { return PART_KEYS.includes(part); }

// { start:'HH:MM', end:'HH:MM', label, start_min, end_min }
function partWindow(settings, part) {
  const p = partsSetting(settings)[part];
  if (!p) return null;
  const startMin = time.parseHHMM(p.start);
  const endMin = time.parseHHMM(p.end);
  return {
    part,
    label: p.label || part.toUpperCase(),
    start: p.start,
    end: p.end,
    start_min: startMin === null ? time.parseHHMM(DEFAULTS.parts[part].start) : startMin,
    end_min: endMin === null ? time.parseHHMM(DEFAULTS.parts[part].end) : endMin,
  };
}

// Part otomatis: jam WIB < mulai p2 → p1; < mulai p3 → p2; selain itu p3.
// now: unix detik (default sekarang).
function currentPart(settings, now) {
  const ts = Number(now) || time.now();
  const tz = (settings && settings.app && settings.app.timezone) || time.DEFAULT_TZ;
  const minutes = time.minutesOfDay(ts, tz);
  const w1 = partWindow(settings, 'p1');
  const w2 = partWindow(settings, 'p2');
  const w3 = partWindow(settings, 'p3');
  let part;
  if (minutes < w2.start_min) part = 'p1';
  else if (minutes < w3.start_min) part = 'p2';
  else part = 'p3';
  const win = { p1: w1, p2: w2, p3: w3 }[part];
  const inWindow = minutes >= win.start_min && minutes <= win.end_min;
  const nextMap = { p1: w2, p2: w3, p3: w1 };
  const next = nextMap[part];
  return {
    part,
    label: win.label,
    window: { start: win.start, end: win.end },
    in_window: inWindow,
    minutes_of_day: minutes,
    next: { part: next.part, start: next.start, tomorrow: part === 'p3' },
  };
}

// Label singkat semua part untuk UI/dashboard.
function allParts(settings) {
  return PART_KEYS.map((k) => partWindow(settings, k));
}

module.exports = { PART_KEYS, isValidPart, partWindow, currentPart, allParts };
