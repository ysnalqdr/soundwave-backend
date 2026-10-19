'use strict';
/**
 * logger.js — tampilan console Soundwave Backend (gaya "Terminal Pro").
 *
 * Prinsip:
 *  - Satu aksen warna (hijau Soundwave), sisanya redup. Tanpa emoji.
 *  - Kolom sejajar: waktu · metode · rute · status · durasi · referensi · catatan.
 *  - Semua angka nyata (uptime, memori, latency asli) — tidak ada hiasan.
 *  - Warna OTOMATIS mati saat output bukan terminal (mis. dijalankan detached
 *    sehingga output masuk ke server_out.log) supaya file log tetap bersih.
 *    Paksa nyala dengan FORCE_COLOR=1, matikan dengan NO_COLOR=1.
 *
 * Tanpa dependency eksternal — hanya ANSI escape bawaan.
 */

// ─── deteksi warna ───
const COLOR = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(process.stdout.isTTY);
})();

const sgr = (n) => (s) => (COLOR ? `\u001b[${n}m${s}\u001b[0m` : String(s));
const paint = {
  dim: sgr(2),
  bold: sgr(1),
  green: sgr('38;5;41'), // ≈ #00E676 (aksen Soundwave)
  yellow: sgr('38;5;221'),
  red: sgr('38;5;203'),
  white: sgr('97'),
};

// ─── lebar kolom ───
const W = { time: 8, method: 6, path: 30, status: 3, dur: 7, ref: 20 };
const NOTE_MAX = 62;
const VERBOSE = process.env.LOG_VERBOSE === '1';

// ─── helper teks (selalu pad/cut teks MENTAH dulu, baru diwarnai) ───
const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); };
const padL = (s, n) => { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; };
const cut = (s, n) => {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
};
const clock = () => {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const fmtMs = (ms) => (ms < 1 ? '<1ms' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`);
const memMb = () => Math.round(process.memoryUsage().rss / 1048576);
const uptimeStr = () => {
  const s = Math.floor((Date.now() - stats.startedAt) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}j ${Math.floor((s % 3600) / 60)}m`;
};

const out = (line) => process.stdout.write(line + '\n');

// ─── statistik ───
const stats = { total: 0, errors: 0, warnings: 0, startedAt: Date.now() };
const statsSnapshot = () => ({ ...stats, uptime: uptimeStr(), memMb: memMb() });

// ═══════════════════════════════════════════
// BANNER STARTUP
// ═══════════════════════════════════════════
function banner(info) {
  const inner = 60;
  out('╭' + '─'.repeat(inner) + '╮');
  out('│  ' + paint.bold(pad('SOUNDWAVE · backend ticketing', inner - 2)) + '│');
  out('╰' + '─'.repeat(inner) + '╯');
  out('');

  const kv = (k, v) => out('  ' + paint.dim(pad(k, 10)) + '  ' + v);
  kv('STATUS', paint.green('siap menerima request'));
  kv('PORT', `${info.port}  ${paint.dim('·')}  ${paint.dim('http://localhost:' + info.port)}`);
  kv('MIDTRANS', info.midtrans === 'PRODUCTION' ? paint.red('PRODUCTION') : paint.green('SANDBOX'));
  kv('FIREBASE', info.firebaseProject || '-');
  kv('RUNTIME', `Node ${info.nodeVersion}  ${paint.dim('·')}  PID ${info.pid}`);
  kv('MULAI', info.startedAt);
  out('');

  out('  ' + paint.dim(pad('RUTE', 54) + 'METODE'));
  out('  ' + paint.dim('─'.repeat(62)));
  for (const r of info.routes || []) {
    out('  ' + pad(r.path, 54) + paint.dim(r.method));
  }
  out('');
}

/** Judul seksi ringkas (dipakai start_tunnel.js) — gaya Terminal Pro. */
function judul(teks) {
  out('');
  out('  ' + paint.bold(teks));
  out('  ' + paint.dim('─'.repeat(62)));
}

/** Baris "siap dalam Xms" setelah server listening. */
function ready(ms) {
  out(paint.dim(pad(clock(), W.time)) + '  ' + paint.green('▲') + '  siap dalam ' + Math.round(ms) + 'ms');
}

// ═══════════════════════════════════════════
// BARIS REQUEST
// ═══════════════════════════════════════════
function request({ method, path, status, ms, ref, note }) {
  const sc = status >= 500 ? paint.red : status >= 400 ? paint.yellow : paint.green;
  const line =
    paint.dim(pad(clock(), W.time)) + '  ' +
    paint.dim(pad(method, W.method)) + '  ' +
    paint.white(pad(cut(path, W.path), W.path)) + '  ' +
    sc(padL(String(status), W.status)) + '  ' +
    paint.dim(padL(fmtMs(ms), W.dur)) + '  ' +
    (ref ? paint.bold(pad(cut(ref, W.ref), W.ref)) : ' '.repeat(W.ref)) + '  ' +
    paint.dim(cut(note || '', NOTE_MAX));
  out(line.replace(/\s+$/, ''));
}

/**
 * Middleware Express: catat setiap request yang masuk.
 * Catatan (note) otomatis diambil dari `message` pada body JSON bila route
 * tidak menyetel `res.locals.note` sendiri → pesan error ikut terlihat.
 */
function requestLogger() {
  return function (req, res, next) {
    if (req.method === 'OPTIONS') return next(); // preflight CORS, tidak perlu dicatat

    const start = process.hrtime.bigint();

    const originalJson = res.json.bind(res);
    res.json = function (body) {
      if (body && typeof body === 'object') {
        if (res.locals && res.locals.note == null && typeof body.message === 'string' && body.message.trim()) {
          res.locals.note = body.message.trim();
        }
        if (res.locals && res.locals.ref == null) {
          res.locals.ref = body.orderId || body.kodeBooking || body.refundId || null;
        }
      }
      return originalJson(body);
    };

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const status = res.statusCode;
      stats.total++;
      if (status >= 500) stats.errors++;
      else if (status >= 400) stats.warnings++;

      const ref = (res.locals && res.locals.ref) ||
        (req.body && (req.body.orderId || req.body.kodeBooking || req.body.refundId)) ||
        (req.params && (req.params.orderId || req.params.id)) || '';

      let noteText = (res.locals && res.locals.note) || '';
      if (!noteText && status === 404) noteText = 'rute tidak dikenal';

      request({
        method: req.method,
        path: (req.originalUrl || req.url || '').split('?')[0],
        status, ms, ref, note: noteText,
      });

      if (VERBOSE && res.locals && res.locals.detail) {
        out(' '.repeat(10) + paint.dim('↳ ' + cut(res.locals.detail, 110)));
      }
    });

    next();
  };
}

// ═══════════════════════════════════════════
// BARIS EVENT (bukan request)
// ═══════════════════════════════════════════
const line = (symbol, text, color) =>
  out(paint.dim(pad(clock(), W.time)) + '  ' + color(symbol) + '  ' + text);

const ok = (msg) => line('✓', msg, paint.green);
const warn = (msg) => line('!', msg, paint.yellow);
const err = (msg) => line('✗', msg, paint.red);
const info = (msg) => line('·', paint.dim(msg), paint.dim);

/**
 * Catat detail error route tanpa mengotori console.
 * Detail hanya ditampilkan bila LOG_VERBOSE=1.
 */
function fail(res, label, error) {
  const msg = (error && error.message) ? error.message : String(error);
  if (res && res.locals) res.locals.detail = `${label}: ${msg}`;
  return msg;
}

/** Catat catatan pada baris request berikutnya. */
function note(res, text) {
  if (res && res.locals) res.locals.note = text;
}

// ═══════════════════════════════════════════
// HEARTBEAT + SHUTDOWN
// ═══════════════════════════════════════════
let hbTimer = null;
function startHeartbeat(intervalMs = 60000) {
  if (hbTimer) clearInterval(hbTimer);
  hbTimer = setInterval(() => {
    out(
      paint.dim(clock()) + '  ' + paint.dim('·') + '  ' +
      paint.dim(`${stats.total} request  ·  ${stats.errors} error  ·  uptime ${uptimeStr()}  ·  ${memMb()} MB`)
    );
  }, intervalMs);
  if (hbTimer.unref) hbTimer.unref();
  return hbTimer;
}

function shutdown(reason = '') {
  if (hbTimer) clearInterval(hbTimer);
  out('');
  out(paint.dim(pad(clock(), W.time)) + '  ' + paint.red('▼') + '  ' +
    `server berhenti${reason ? ' (' + reason + ')' : ''}  ${paint.dim('·')}  ` +
    paint.dim(`${stats.total} request  ·  ${stats.errors} error  ·  uptime ${uptimeStr()}`));
}

module.exports = {
  banner, ready, request, requestLogger, ok, warn, err, info, fail, note, judul,
  startHeartbeat, shutdown, statsSnapshot,
  colorEnabled: COLOR,
  paint, pad, padL, cut,
};
