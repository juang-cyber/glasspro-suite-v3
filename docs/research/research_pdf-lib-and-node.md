# Implementation notes: pdf-lib 1.17.1 (merge/cover/stamp/table/encryption), better-sqlite3 v12 on Node 24 Docker, Express 4 patterns, Node 24 fetch/node:test/Intl WIB

# Implementation-ready notes (Node 24, verified 2026-09-15)

Everything marked **[tested]** was run locally on Node v24.19.0 with pdf-lib@1.17.1 / express@4.22.3 / cookie-session@2.1.1, and PDFs were rasterized with PDFium to confirm visual results. Scratch files live in `C:\Users\juang\AppData\Local\Temp\claude\Z--My-Drive-Glass-Pro-1--Project-Glass-Pro-Suite-V3-Claude\c1b09e78-3be9-4a31-a898-62deb2c8795f\scratchpad\{pdftest,exptest,nodetest}` (stamp.js, merge.js, enc.js, enc2.js, sanitize.js, app.js, sec.js, test/scheduler.test.js, wib.js).

---

## 1. pdf-lib 1.17.1

`npm i pdf-lib@1.17.1` (latest on npm, published 2021-11; effectively unmaintained). Exports used: `PDFDocument, StandardFonts, rgb, degrees, PageSizes, ParseSpeeds, EncryptedPDFError`.

### Loading (Buffer / Uint8Array / ArrayBuffer / base64 string)
```js
const { PDFDocument, ParseSpeeds } = require('pdf-lib');
const doc = await PDFDocument.load(fs.readFileSync(p), {   // Node Buffer is a Uint8Array -> accepted as-is [tested]
  ignoreEncryption: true,      // default false -> throws EncryptedPDFError on encrypted input (see 1.8)
  updateMetadata: false,       // default true rewrites Producer/ModDate
  parseSpeed: ParseSpeeds.Fastest, // default ParseSpeeds.Slow; Fastest = no yielding between objects
  throwOnInvalidObject: false, // default; pdf-lib logs "Trying to parse invalid object" warnings and continues
});
// from fetch: new Uint8Array(await res.arrayBuffer())  (or await res.bytes() on Node 24)
```
`save()` returns `Uint8Array` (SaveOptions: `useObjectStreams` default true, `addDefaultPage` true, `objectsPerTick` 50, `updateFieldAppearances` true). For Express: `Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)` (zero-copy).

### Merge with copyPages + cover page [tested: 12-page merge, rotations preserved]
```js
const { PDFDocument, StandardFonts, PageSizes } = require('pdf-lib');
async function mergeWithCover(pdfBuffers, coverLines) {
  const out = await PDFDocument.create();
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  const cover = out.addPage(PageSizes.A4);               // [595.28, 841.89]
  let y = cover.getHeight() - 80;
  coverLines.forEach((line, i) => { const size = i === 0 ? 24 : 12;
    cover.drawText(line, { x: 50, y, size, font: bold }); y -= size * 1.6; });
  for (const bytes of pdfBuffers) {                      // sequential: one source in memory at a time
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach(p => out.addPage(p));                  // copyPages does NOT add; addPage/insertPage(idx, p) does
  }
  return out.save();
}
```
Memory notes (guidance, not measured): every `load()` holds the whole parsed object graph; `copyPages` deep-copies each page's resources into the destination (shared resources are de-duplicated within one `copyPages` call, not across calls, so embedded fonts get duplicated per source document). Do not pre-load all sources into an array; load->copy->drop in a loop. pdf-lib is CPU-bound and synchronous inside `save()` (it only yields every `objectsPerTick` objects), so for big batches run the merge in a `worker_threads` Worker to keep the Express event loop responsive; raise `--max-old-space-size` if merging hundreds of MB.

### Stamping every page, rotation-aware [tested on /Rotate 0, 90, 180, 270]
`page.getRotation()` returns `{ type, angle }` with angle a multiple of 90 (may be negative). Drawing coordinates are always in the *unrotated* page space, so on a rotated page you must map "visual" coordinates back and pass `rotate: degrees(angle)` to `drawText`/`drawRectangle`. Verified mapping (visual origin = bottom-left of the page as displayed):
```js
const { degrees, rgb, StandardFonts } = require('pdf-lib');
function visualSpace(page) {
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const { width: W, height: H } = page.getSize();       // MediaBox size
  const { x: ox, y: oy } = page.getMediaBox();          // handles non-zero MediaBox origin
  const swap = rot === 90 || rot === 270;
  const toRaw = (vx, vy) => rot === 90  ? { x: ox + W - vy, y: oy + vx }
                         : rot === 180 ? { x: ox + W - vx, y: oy + H - vy }
                         : rot === 270 ? { x: ox + vy,     y: oy + H - vx }
                         :               { x: ox + vx,     y: oy + vy };
  return { rotate: degrees(rot), toRaw, width: swap ? H : W, height: swap ? W : H };
}

async function stampAll(pdfBytes, { channel, orderNo, warning }) {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg  = await doc.embedFont(StandardFonts.Helvetica);
  for (const page of doc.getPages()) {
    const v = visualSpace(page), m = 12;
    // badge top-left: filled rect + white bold text
    const bt = toWinAnsi(channel), bs = 11, bw = bold.widthOfTextAtSize(bt, bs) + 12, bh = bs + 8;
    page.drawRectangle({ ...v.toRaw(m, v.height - m - bh), width: bw, height: bh, rotate: v.rotate, color: rgb(0.93, 0.33, 0.13) });
    page.drawText(bt, { ...v.toRaw(m + 6, v.height - m - bh + 6), size: bs, font: bold, color: rgb(1, 1, 1), rotate: v.rotate });
    // order number top-right (right-aligned via widthOfTextAtSize)
    const ot = toWinAnsi(orderNo), os = 10, ow = reg.widthOfTextAtSize(ot, os);
    page.drawText(ot, { ...v.toRaw(v.width - m - ow, v.height - m - os), size: os, font: reg, rotate: v.rotate });
    // big red warning, centered
    if (warning) { const wt = toWinAnsi(warning), ws = 26, ww = bold.widthOfTextAtSize(wt, ws);
      page.drawText(wt, { ...v.toRaw((v.width - ww) / 2, v.height / 2), size: ws, font: bold, rotate: v.rotate, color: rgb(0.85, 0, 0), opacity: 0.85 }); }
  }
  return doc.save();
}
```
Useful metrics: `font.widthOfTextAtSize(text, size)`, `font.heightAtSize(size)`. `drawText` options: `x,y,size,font,color,opacity,rotate,lineHeight,maxWidth,wordBreaks` (default `[' ']`), `blendMode`. Newlines: `\n \r \f \v` split lines (`lineSplit`), `\t` becomes 4 spaces (`cleanText`); with `maxWidth` it wraps on `wordBreaks`. Rectangle options: `x,y,width,height,color,borderColor,borderWidth,borderDashArray,opacity,borderOpacity,rotate` (rotates around the x,y corner - which is why the mapping above works). Gotcha: `getSize()` is MediaBox-based; if a page has a smaller CropBox the viewer shows only the CropBox - use `page.getCropBox()` for x/y/width/height in that case (same math; CropBox variant not tested).

### WinAnsi sanitizer (StandardFonts only encode WinAnsi) [tested]
Error thrown by `@pdf-lib/standard-fonts`: `WinAnsi cannot encode "中" (0x4e2d)`. Also thrown for control chars (`\u0000`, `\u0007`) and emoji. Do NOT blanket-`normalize('NFKC')` the string first - it turns `½` (encodable, 0xBD) into `1⁄2` (not encodable). Per-character fallback instead:
```js
const WINANSI = /^[\x20-\x7E\xA0-\xFF\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]$/;
function toWinAnsi(input, repl = '?') {
  const out = [];
  for (const ch of String(input ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, ' ')) { // for..of = code points (emoji-safe)
    if (ch === '\n' || WINANSI.test(ch)) { out.push(ch); continue; }
    const cand = ch.normalize('NFKD').replace(/\p{M}+/gu, '');   // "ﬁ"->"fi", "ệ"->"e", "Ｆ"->"F"
    if (cand && [...cand].every(c => WINANSI.test(c))) { out.push(cand); continue; }
    if (repl) out.push(repl);
  }
  return out.join('');
}
// Exact alternative: const { Encodings } = require('@pdf-lib/standard-fonts'); Encodings.WinAnsi.canEncodeUnicodeCodePoint(cp)
// (transitive dep of pdf-lib; add "@pdf-lib/standard-fonts": "^1.0.0" explicitly if you use it). Both gave identical output on all samples.
```
Sample: `'No. 26091… — 中文 🚀 café ½ “q” ﬁ Ｆull ệ €'` -> `"No. 26091… — ?? ? café ½ “q” fi Full e €"`. Real Unicode (CJK, emoji) needs a TTF via `@pdf-lib/fontkit` (`doc.registerFontkit(fontkit); doc.embedFont(ttfBytes, { subset: true })`) plus a font that actually has the glyphs (e.g. Noto Sans SC) - not needed for Indonesian labels.

### A4 product-list table with word-wrap and page breaks [tested: 60 rows, 3 pages, hard-breaking of overlong words]
Use your own wrap (you need the line count to size the row); `drawText({maxWidth})` cannot report height.
```js
function wrap(font, size, text, maxWidth) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const t = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(t, size) <= maxWidth) { line = t; continue; }
      if (line) lines.push(line);
      let w = word;                                        // hard-break a single overlong token
      while (font.widthOfTextAtSize(w, size) > maxWidth && w.length > 1) {
        let i = w.length; while (i > 1 && font.widthOfTextAtSize(w.slice(0, i), size) > maxWidth) i--;
        lines.push(w.slice(0, i)); w = w.slice(i);
      }
      line = w;
    }
    lines.push(line);
  }
  return lines;
}
// row loop (size 9, lh = size*1.3, pad 4, margin 40):
// wrapped = cells.map((t,i) => wrap(font,size,t,cols[i].w-2*pad)); h = max(lines)*lh + 2*pad;
// if (y - h < M) { page = doc.addPage(PageSizes.A4); y = PH - M; drawHeader(); }
// per cell: drawRectangle({x, y: y-h, width: c.w, height: h, borderColor: rgb(.6,.6,.6), borderWidth: .5});
//   lines.forEach((line, li) => page.drawText(line, { x: x+pad, y: y - pad - (li+1)*lh + (lh-size)/2 + 2, size, font }));
//   right-align numbers with x + c.w - pad - font.widthOfTextAtSize(line, size)
```
Full working version: `scratchpad/pdftest/merge.js` (`buildProductList`).

### Logo without PNG/SVG
- Badge = `drawRectangle` + `drawText` (above). Rounded/complex shapes: `page.drawSvgPath('M0 0 h60 a8 8 0 0 1 8 8 v20 ...', { x, y, color, borderColor, scale })` - SVG paths are drawn *downward* from `(x, y)` (SVG y-axis), so pass `y: top`. Also `drawCircle({x,y,size})`, `drawEllipse`, `drawLine({start,end,thickness,color,dashArray})`.
- Actual PNG: `const img = await doc.embedPng(pngBytes); const { width, height } = img.scale(0.25); page.drawImage(img, { x, y, width, height, opacity })`. `embedJpg` too. No SVG image embedding in 1.17.1 (paths only).

### Encryption: what `ignoreEncryption` really does [tested with an owner-password-only PDF made by @cantoo/pdf-lib 2.11.0]
| Operation on encrypted input via pdf-lib 1.17.1 `{ignoreEncryption:true}` | Result |
|---|---|
| `load()` without the flag | throws `Error: Input document to PDFDocument.load is encrypted...` (`EncryptedPDFError`) |
| load + `save()` (default `useObjectStreams:true`) | file PDFium cannot open: "Data format error" |
| load + `save({ useObjectStreams: false })`, untouched | opens, original content OK |
| load + `drawText` + `save({ useObjectStreams:false })` | opens, original OK, **stamp invisible** (new stream is plaintext but the file still has `/Encrypt`, so viewers "decrypt" it into garbage) |
| `copyPages` into a fresh doc | **blank page** (streams stay encrypted bytes, new file has no `/Encrypt`) |
| decrypt first with `@cantoo/pdf-lib` (`load(bytes,{password:''})` -> `save()`), then pdf-lib stamp | original + stamp both visible |

So: `ignoreEncryption` is only useful for reading metadata/page count. For real work on restricted (owner-password) PDFs decrypt first: `npm i @cantoo/pdf-lib` (v2.11.0, 2026-09-11; API-compatible fork with `PDFDocument.load(b, { password })`, `doc.isEncrypted`, `doc.encrypt({...})`) or shell out to `qpdf --decrypt --password='' in.pdf out.pdf` (Debian: `apt-get install qpdf`). Detect cheaply: `(await PDFDocument.load(b,{ignoreEncryption:true})).isEncrypted`. Note: pdf-lib printed `Trying to parse invalid object ... Invalid object ref` warnings while parsing the fork's output but rendered correctly - harmless here, but do not set `throwOnInvalidObject:true` in production.

---

## 2. better-sqlite3 v12 on Node 24 in Docker

Facts (GitHub API + npm registry, 2026-09-15):
- Latest v12 **on npm** is **12.11.1** (2026-06-15). Tags v12.11.2 and v12.12.0 exist on GitHub (12.12.0 has 145 assets) but `registry.npmjs.org/better-sqlite3/12.12.0` returns "version not found" - treat 12.11.1 as the installable v12 unless npm catches up.
- v12 install script: `prebuild-install || node-gyp rebuild --release`; `engines.node`: `20.x || 22.x || 23.x || 24.x || 25.x || 26.x`.
- v12.11.1 release assets include, for Node 24 (ABI `node-v137`): `linux-x64`, `linux-arm64`, `linux-arm`, **`linuxmusl-x64`, `linuxmusl-arm64`, `linuxmusl-arm`**, `darwin-*`, `win32-*`. So **both** `node:24-bookworm-slim` (glibc) and `node:24-alpine` (musl) install with **no compiler** on x64 and arm64.
- Build matrix (`.github/workflows/build.yml` @ v12.12.0): glibc binaries for Node 22-24 are built on `node:20-bullseye` (glibc 2.31) -> runs on bookworm (glibc 2.36) and any newer Debian/Ubuntu; musl binaries are built on `node:20-alpine`. (The "glibc 2.41" warning in the 12.12.0 notes applies only to Electron >= 43 builds.)
- Historic gap: issue #1382 (Node 24.2 + musl + arm64 missing, June 2025) is closed; assets now exist. musl builds can still lag a few days after a new Node major.
- Caveat: `prebuild-install` **downloads the tarball from github.com at `npm ci` time**. No outbound network in the build stage (or `npm ci --ignore-scripts`, which skips the install script entirely) => no binary, falls back to node-gyp => needs `python3 make g++`. Force compile with `npm_config_build_from_source=true`.
- v13.0.x (npm latest 13.0.3, N-API, `engines >=22`) bundles all prebuilds inside the tarball (`prebuilds/`, ~27 MB unpacked, no install script, no download) - the most robust "never compiles" option if moving off v12 is acceptable.

Recommended: **`node:24-bookworm-slim`** (glibc, matches the builder ABI exactly, no musl edge cases, `apt-get install qpdf` available if needed). Alpine works too and is ~40 MB smaller.
```dockerfile
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
# prebuilt binary is downloaded here; keep network on. Fallback toolchain only if you must build from source:
# RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm ci --omit=dev \
 && node -e "require('better-sqlite3')(':memory:').prepare('select sqlite_version() v').get()"   # fail the build if binary missing

FROM node:24-bookworm-slim
ENV NODE_ENV=production TZ=Asia/Jakarta
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
USER node
CMD ["node", "server.js"]
```
Alpine fallback toolchain: `RUN apk add --no-cache python3 make g++`. Keep builder and runtime on the same base family (glibc vs musl) and same arch; `docker build --platform linux/amd64` if your host is arm64 Mac and the server is x64.
Zero-dependency alternative: Node 24 ships `node:sqlite` (`import { DatabaseSync } from 'node:sqlite'`, Stability 1.2 Release Candidate, no flag) with the same sync `prepare/run/get/all` style - viable for a small app, but API is not identical (no `pragma()` helper, `transaction()` wrapper, etc.).

---

## 3. Express 4 patterns [tested: scratchpad/exptest/app.js, sec.js]

Pin the major: `npm i express@4` -> 4.22.3 (`express@latest` is now 5.2.1; Express 5 breaks `app.get('*')`, needs `'/{*splat}'`, and auto-handles rejected promises).

```js
const express = require('express'), cookieSession = require('cookie-session');
const path = require('path'), fs = require('fs'), { pipeline } = require('stream');
const app = express();
app.set('trust proxy', 1);                       // exactly one reverse proxy hop; affects req.secure/req.protocol/req.ip
app.use(express.json({ limit: '1mb' }));         // bad JSON -> err.status=400, type 'entity.parse.failed' -> JSON error handler below

app.use(cookieSession({
  name: 'gp.sid', keys: [process.env.SESSION_KEY, process.env.SESSION_KEY_PREV].filter(Boolean),
  maxAge: 7 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
}));
// req.session.user = {...}; req.session = null to log out. Set-Cookie is only sent when the session object changed
// (touch e.g. req.session.t = Date.now() to slide expiry). Cookie holds the whole session (4 KB limit) - store ids only.

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);   // Express 4 does not catch async errors

// PDF from memory (pdf-lib bytes)
app.get('/api/orders/:id/label.pdf', wrap(async (req, res) => {
  const bytes = await buildPdf(req.params.id);   // Uint8Array
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  res.attachment(`Label ${req.params.id}.pdf`);  // Content-Disposition (RFC 5987 filename* for non-ASCII) + Content-Type from extension
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
}));
// PDF from disk, streamed (or simply res.download(absPath, downloadName, next))
app.get('/api/files/:name', (req, res, next) => {
  const file = path.join(SAFE_DIR, path.basename(req.params.name));
  res.attachment(path.basename(file)); res.type('application/pdf');
  pipeline(fs.createReadStream(file), res, err => { if (err) next(err); });
});

// SPA: hashed assets cacheable, index.html never cached, API 404s stay JSON
const dist = path.join(__dirname, 'dist');
app.use(express.static(dist, { index: false, maxAge: '1y', immutable: true }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } }));

// JSON error handler: MUST have 4 params and be registered last
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
});
```
Verified responses: `/deep/route` -> index.html with `cache-control: no-cache`; `/app.js` -> `public, max-age=31536000, immutable`; `/api/nothing` -> 404 JSON; thrown `err.status=418` -> `{"error":"nope"}`; non-ASCII filename -> `attachment; filename="Label Toko ? ..."; filename*=UTF-8''Label%20Toko%20%E2%9C%93...`.

**Secure-cookie gotcha [tested]:** with `secure: true`, cookie-session does **not** error when the request is not seen as HTTPS - it returns 200 and silently sends **no Set-Cookie** (login "works" but the session never sticks). Only `trust proxy` + `X-Forwarded-Proto: https` (which the proxy must set) produced `s=...; secure; httponly` and `req.secure === true`. Without `trust proxy`, the header is ignored. Do not use `secure:true` in local HTTP dev.

Minimal in-process scheduler with overlap guard [tested with node:test mock timers]:
```js
export function startJob(name, fn, intervalMs, { runNow = true, log = console } = {}) {
  let running = false, stopped = false;
  const tick = async () => {
    if (running || stopped) { if (running) log.warn?.(`[${name}] skipped: previous run still active`); return; }
    running = true;
    try { await fn(); } catch (err) { log.error?.(`[${name}] failed`, err); } finally { running = false; }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();                                    // never keeps the process alive by itself
  if (runNow) queueMicrotask(tick);
  return { stop() { stopped = true; clearInterval(timer); }, get running() { return running; } };
}
// const sync = startJob('shopee-sync', syncOrders, 5 * 60_000);
// process.on('SIGTERM', () => { sync.stop(); server.close(() => process.exit(0)); });
```
Pass `AbortSignal.timeout(...)` into the job's fetches so a hung HTTP call cannot pin `running=true` forever. Single-replica only (no distributed lock); if you scale to 2 containers, guard with a DB row or run the job in one instance.

---

## 4. Node 24 specifics

### fetch [tested: Response.prototype.bytes exists on 24.19.0; TimeoutError verified]
```js
async function getJson(url, { timeoutMs = 15_000, ...init } = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${url}`), { status: res.status, body: await res.text().catch(() => '') });
  return res.json();
}
async function getBytes(url, { timeoutMs = 60_000, signal } = {}) {
  const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());   // or: const u8 = await res.bytes()  (Uint8Array) -> PDFDocument.load(u8)
}
```
Errors: timeout rejects with `DOMException` `name === 'TimeoutError'`; manual abort -> `'AbortError'`; network/DNS -> `TypeError: fetch failed` with `err.cause` (e.g. `ECONNREFUSED`). Node's undici also has its own 300 s headers/body timeouts. Corporate proxy: `HTTP_PROXY/HTTPS_PROXY/NO_PROXY` are honoured by `fetch` only when `NODE_USE_ENV_PROXY=1` or `node --use-env-proxy` (fetch: v24.0.0+; `node:http/https`: v24.5.0+).

### node:test [tested: `node --test` with ESM, describe/it, t.mock.timers, assert.rejects]
- Run `node --test` (no deps). Default discovery (v24 docs): `**/*.test.{js,mjs,cjs}`, `**/*-test.*`, `**/*_test.*`, `**/test-*.*`, `**/test.*`, `**/test/**/*.*` (plus `.ts/.mts/.cts` since type stripping is on by default in 24; stable flag name `--no-strip-types` since 24.12). Explicit: `node --test "test/**/*.test.js"`.
- Flags: `--test-only` (with `{ only: true }`), `--test-name-pattern=<re>`, `--test-skip-pattern`, `--test-reporter=spec|tap|dot|junit|lcov` (+`--test-reporter-destination`), `--test-concurrency=N`, `--test-timeout=ms`, `--test-force-exit`, `--watch`, `--experimental-test-coverage` (still experimental-named in v24).
- Layout that needs nothing else: `src/*.js` + `test/*.test.js`, `package.json` `"scripts": { "test": "node --test" }` and `"type": "module"` (or use `.mjs`/CommonJS `require('node:test')`).
```js
import { test, describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
describe('scheduler', () => {
  it('does not overlap slow runs', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });          // also 'setTimeout', 'Date'
    let calls = 0, release;
    const job = startJob('sync', () => { calls++; return new Promise(r => (release = r)); }, 1000, { runNow: false, log: {} });
    t.mock.timers.tick(1000); t.mock.timers.tick(1000);        // second tick skipped by guard
    assert.equal(calls, 1);
    release(); await Promise.resolve(); await Promise.resolve();
    t.mock.timers.tick(1000); assert.equal(calls, 2); job.stop();
  });
});
test('spies', (t) => { const fn = t.mock.fn(x => x * 2); fn(2); assert.equal(fn.mock.callCount(), 1); });
// subtests: await t.test('name', ...); mocks created via `t.mock` auto-restore per test. mock.module() is still Stability 1 (experimental); snapshot testing is stable.
// HTTP tests: start express on port 0, fetch `http://127.0.0.1:${srv.address().port}`, close in `after`.
```

### Asia/Jakarta (WIB) without luxon [tested incl. midnight/day rollover]
Node's official builds bundle full ICU, so `Intl` with an explicit `timeZone` is correct regardless of the container's `TZ`/tzdata. luxon (3.7.2) is fine but just wraps Intl for this use.
```js
const WIB = 'Asia/Jakarta';   // UTC+7, no DST
const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: WIB, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });   // h23, NOT hour12:false (can yield "24")
export function wibParts(d = new Date()) {
  const o = {};
  for (const { type, value } of fmt.formatToParts(d)) if (type !== 'literal') o[type] = Number(value);
  return o;                                        // { year, month, day, hour, minute, second }
}
const pad = n => String(n).padStart(2, '0');
export const wibHourMinute = (d = new Date()) => { const p = wibParts(d); return { hour: p.hour, minute: p.minute }; };
export const ddmmyyyyWIB   = (d = new Date()) => { const p = wibParts(d); return `${pad(p.day)}${pad(p.month)}${p.year}`; };
// wibParts(new Date('2026-09-15T17:00:00Z')) -> {day:16, month:9, year:2026, hour:0, minute:0, second:0}; ddmmyyyyWIB -> "16092026"
// ISO-like log stamp: new Date().toLocaleString('sv-SE', { timeZone: WIB }) -> "2026-09-16 00:00:00"
```
Reuse the `Intl.DateTimeFormat` instance (construction is the expensive part). Setting `ENV TZ=Asia/Jakarta` in Docker additionally makes `new Date().getHours()` WIB, but keep the explicit-timeZone helper as the source of truth.

## Uncertainties
- better-sqlite3 v12.11.2 / v12.12.0 exist as GitHub releases with assets but were NOT on the npm registry at check time ('version not found'); the installable v12 was 12.11.1. This may be a publishing lag - re-check before pinning.
- pdf-lib memory statements (copyPages de-dup per call, font duplication across calls, heap size for large merges) are from reading the library's design, not measured; the merge itself was only tested with small files.
- The rotation helper was verified on pages whose MediaBox starts at (0,0) and whose CropBox equals the MediaBox; pages with an offset MediaBox or a smaller CropBox use the same math but were not exercised.
- Encryption tests used a PDF encrypted (AES-256, empty user password) by @cantoo/pdf-lib 2.11.0; real marketplace label PDFs may use RC4/AES-128 or Identity crypt filters and could behave slightly differently - but the structural problem (pdf-lib 1.17.1 never decrypts/encrypts streams) is the same.
- The claim that Node 24 honours ICU tz data for `process.env.TZ` on Alpine without the `tzdata` package is not verified; using Intl with an explicit timeZone sidesteps it.
- NODE_USE_ENV_PROXY version numbers (fetch v24.0.0+, node:http v24.5.0+) come from the nodejs.org enterprise-network guide via search summary, not from the CLI doc text itself.
- node --test flag list is from the v24.21.0 docs page summary; `--experimental-test-coverage` naming in 24.x was reported by that summary but not run.
- Express secure-cookie test observed 'no Set-Cookie, HTTP 200' for secure:true over plain HTTP with cookie-session 2.1.1; earlier cookie-session versions may throw instead.

## Sources
- https://api.github.com/repos/WiseLibs/better-sqlite3/releases (asset lists for v12.9.0-v12.12.0, v13.0.0-v13.0.3)
- https://registry.npmjs.org/better-sqlite3 (versions, engines, install scripts)
- https://raw.githubusercontent.com/WiseLibs/better-sqlite3/v12.12.0/.github/workflows/build.yml
- https://raw.githubusercontent.com/WiseLibs/better-sqlite3/v13.0.3/package.json
- https://github.com/WiseLibs/better-sqlite3/issues/1382
- https://raw.githubusercontent.com/Hopding/pdf-lib/master/src/api/PDFDocument.ts
- https://raw.githubusercontent.com/Hopding/pdf-lib/master/src/api/PDFPage.ts
- https://raw.githubusercontent.com/Hopding/pdf-lib/master/src/utils/strings.ts
- https://raw.githubusercontent.com/Hopding/standard-fonts/master/src/Encoding.ts
- https://raw.githubusercontent.com/cantoo-scribe/pdf-lib/master/README.md
- https://registry.npmjs.org/pdf-lib, /@cantoo%2Fpdf-lib, /express, /cookie-session, /luxon, /@pdf-lib%2Ffontkit
- https://raw.githubusercontent.com/expressjs/cookie-session/master/README.md
- https://nodejs.org/docs/latest-v24.x/api/test.html
- https://nodejs.org/docs/latest-v24.x/api/sqlite.html
- https://nodejs.org/docs/latest-v24.x/api/globals.html
- https://nodejs.org/docs/latest-v24.x/api/cli.html
- https://nodejs.org/learn/http/enterprise-network-configuration
- https://github.com/nodejs/node/pull/57165
- Local verification scripts (Node v24.19.0): C:\Users\juang\AppData\Local\Temp\claude\Z--My-Drive-Glass-Pro-1--Project-Glass-Pro-Suite-V3-Claude\c1b09e78-3be9-4a31-a898-62deb2c8795f\scratchpad\pdftest\{stamp.js,merge.js,enc.js,enc2.js,sanitize.js,wib.js}, ...\scratchpad\exptest\{app.js,sec.js}, ...\scratchpad\nodetest\test\scheduler.test.js
