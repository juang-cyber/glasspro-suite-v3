'use strict';
// Error HTTP yang bisa dikirim ke client (pesan dalam Bahasa Indonesia).
class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.expose = true;
    this.details = details;
  }
}
const httpError = (status, code, message, details) => new HttpError(status, code, message, details);
const badRequest = (message, details) => httpError(400, 'bad_request', message, details);
const notFound = (message = 'Data tidak ditemukan') => httpError(404, 'not_found', message);
const conflict = (message, details) => httpError(409, 'conflict', message, details);

// Pembungkus handler async agar error masuk ke error handler express.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { HttpError, httpError, badRequest, notFound, conflict, wrap };
