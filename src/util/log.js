'use strict';
// Logger sederhana dengan prefix waktu ISO dan level.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const level = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || 20;

function fmt(args) {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object') {
        try { return JSON.stringify(a); } catch { return String(a); }
      }
      return String(a);
    })
    .join(' ');
}

function make(tag) {
  const prefix = tag ? `[${tag}]` : '';
  return {
    debug: (...a) => level <= 10 && console.log(new Date().toISOString(), 'DEBUG', prefix, fmt(a)),
    info: (...a) => level <= 20 && console.log(new Date().toISOString(), 'INFO ', prefix, fmt(a)),
    warn: (...a) => level <= 30 && console.warn(new Date().toISOString(), 'WARN ', prefix, fmt(a)),
    error: (...a) => level <= 40 && console.error(new Date().toISOString(), 'ERROR', prefix, fmt(a)),
    child: (t) => make(tag ? `${tag}:${t}` : t),
  };
}

module.exports = make('app');
module.exports.make = make;
