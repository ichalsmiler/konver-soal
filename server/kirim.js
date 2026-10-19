#!/usr/bin/env node
/*
 * Layanan "Kirim soal": menerima file RTF dari aplikasi Konver Soal lalu mengirimnya
 * lewat email (SMTP, mis. Gmail dengan App Password) ke alamat tujuan yang dikunci di server.
 * Tanpa pustaka tambahan (hanya modul bawaan Node.js >= 14).
 *
 * Konfigurasi lewat variabel lingkungan (biasanya /etc/konver-soal/kirim.env):
 *   SMTP_HOST=smtp.gmail.com   SMTP_PORT=465   SMTP_SECURE=true
 *   SMTP_USER=pengirim@gmail.com   SMTP_PASS=<app password 16 huruf>
 *   MAIL_TO=soal@sman2makassar.sch.id   MAIL_FROM_NAME=Konver Soal
 *   PORT=3091   HOST=127.0.0.1   RATE_PER_HOUR=20
 *
 * Endpoint:  POST /api/kirim  (JSON)
 *   { nama, mapel, kelas, fileName, rtfBase64, jumlahSoal, perluDicek, namaFileAsli }
 */
'use strict';

const http = require('http');
const net = require('net');
const tls = require('tls');
const os = require('os');

const cfg = {
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '465', 10),
  secure: !/^(0|false|no)$/i.test(process.env.SMTP_SECURE || 'true'),
  user: process.env.SMTP_USER || '',
  pass: (process.env.SMTP_PASS || '').replace(/\s+/g, ''),
  to: process.env.MAIL_TO || 'soal@sman2makassar.sch.id',
  fromName: process.env.MAIL_FROM_NAME || 'Konver Soal',
  listenPort: parseInt(process.env.PORT || '3091', 10),
  listenHost: process.env.HOST || '127.0.0.1',
  ratePerHour: parseInt(process.env.RATE_PER_HOUR || '20', 10),
  maxBytes: 20 * 1024 * 1024, // RTF maks ±20 MB (batas lampiran Gmail 25 MB)
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- SMTP (minimal: TLS langsung / STARTTLS, AUTH LOGIN) ----------
function smtpSend({ from, to, data }) {
  return new Promise((resolve, reject) => {
    let sock = cfg.secure
      ? tls.connect(cfg.port, cfg.host, { servername: cfg.host })
      : net.connect(cfg.port, cfg.host);
    let buf = '';
    let waiter = null;
    const timer = setTimeout(() => fail(new Error('SMTP timeout')), 60000);
    const fail = err => { clearTimeout(timer); try { sock.destroy(); } catch (e) { /* abaikan */ } reject(err); };

    const onData = chunk => {
      buf += chunk.toString('utf8');
      // Respons lengkap: baris terakhir "NNN spasi ..."
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const resp = lines.slice(0, i + 1).join('\n');
          buf = lines.slice(i + 1).join('\r\n');
          if (waiter) { const w = waiter; waiter = null; w(resp); }
          return;
        }
      }
    };
    const attach = s => { s.on('data', onData); s.on('error', fail); };
    attach(sock);

    const expect = (code) => new Promise((res, rej) => {
      waiter = resp => (resp.startsWith(String(code)) ? res(resp) : rej(new Error('SMTP: ' + resp.split('\n').pop())));
    });
    const cmd = (line, code) => { const p = expect(code); sock.write(line + '\r\n'); return p; };

    (async () => {
      await expect(220);
      const me = os.hostname() || 'localhost';
      let ehlo = await cmd('EHLO ' + me, 250);
      if (!cfg.secure && /STARTTLS/i.test(ehlo)) {
        await cmd('STARTTLS', 220);
        sock.removeListener('data', onData);
        sock = tls.connect({ socket: sock, servername: cfg.host });
        attach(sock);
        await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
        ehlo = await cmd('EHLO ' + me, 250);
      }
      if (cfg.user) {
        await cmd('AUTH LOGIN', 334);
        await cmd(Buffer.from(cfg.user).toString('base64'), 334);
        await cmd(Buffer.from(cfg.pass).toString('base64'), 235);
      }
      await cmd('MAIL FROM:<' + from + '>', 250);
      await cmd('RCPT TO:<' + to + '>', 250);
      await cmd('DATA', 354);
      // Titik di awal baris digandakan (dot-stuffing)
      await cmd(data.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..') + '\r\n.', 250);
      await cmd('QUIT', 221).catch(() => {});
      clearTimeout(timer);
      sock.end();
      resolve();
    })().catch(fail);
  });
}

// ---------- Pesan MIME ----------
const encWord = s => '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
const wrap76 = s => s.replace(/(.{76})/g, '$1\r\n');

function buildMessage({ nama, mapel, kelas, fileName, rtf, jumlahSoal, perluDicek, namaFileAsli }) {
  const boundary = 'ks-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const subject = 'Soal ' + mapel + ' - Kelas ' + kelas + ' - ' + nama;
  const waktu = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Makassar' });
  const text = [
    'Kiriman soal dari aplikasi Konver Soal.',
    '',
    'Nama guru      : ' + nama,
    'Mata pelajaran : ' + mapel,
    'Kelas          : ' + kelas,
    'Jumlah soal    : ' + (jumlahSoal != null ? jumlahSoal : '-'),
    'Perlu dicek    : ' + (perluDicek != null ? perluDicek : '-'),
    'File asli      : ' + (namaFileAsli || '-'),
    'Waktu kirim    : ' + waktu + ' WITA',
    '',
    'File RTF terlampir.',
  ].join('\r\n');
  return [
    'From: ' + encWord(cfg.fromName) + ' <' + cfg.user + '>',
    'To: <' + cfg.to + '>',
    'Subject: ' + encWord(subject),
    'Date: ' + new Date().toUTCString().replace('GMT', '+0000'),
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(text, 'utf8').toString('base64')),
    '--' + boundary,
    'Content-Type: application/rtf; name="' + fileName + '"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="' + fileName + '"',
    '',
    wrap76(rtf.toString('base64')),
    '--' + boundary + '--',
    '',
  ].join('\r\n');
}

// ---------- HTTP ----------
const hits = new Map(); // ip -> [waktu kirim]
function rateOk(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  if (list.length >= cfg.ratePerHour) { hits.set(ip, list); return false; }
  list.push(now);
  hits.set(ip, list);
  return true;
}

const clean = (s, max) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const safeName = s => clean(s, 120).replace(/[^\w .()\-]+/g, '_') || 'soal.rtf';

function reply(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/kirim/status') {
    return reply(res, 200, { ok: true, siap: !!(cfg.user && cfg.pass), tujuan: cfg.to });
  }
  if (req.method !== 'POST' || req.url !== '/api/kirim') return reply(res, 404, { ok: false, pesan: 'Tidak ditemukan' });
  if (!cfg.user || !cfg.pass) return reply(res, 503, { ok: false, pesan: 'Pengiriman email belum diatur di server (SMTP_USER/SMTP_PASS).' });

  const ip = (req.headers['x-real-ip'] || req.socket.remoteAddress || '').toString();
  if (!rateOk(ip)) return reply(res, 429, { ok: false, pesan: 'Terlalu banyak kiriman. Coba lagi nanti.' });

  const chunks = [];
  let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > cfg.maxBytes * 1.4) { reply(res, 413, { ok: false, pesan: 'File terlalu besar.' }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', async () => {
    if (res.writableEnded) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return reply(res, 400, { ok: false, pesan: 'Data tidak valid.' }); }
    const nama = clean(body.nama, 80), mapel = clean(body.mapel, 80), kelas = clean(body.kelas, 40);
    if (!nama || !mapel || !kelas) return reply(res, 400, { ok: false, pesan: 'Nama guru, mata pelajaran, dan kelas wajib diisi.' });
    const rtf = Buffer.from(String(body.rtfBase64 || ''), 'base64');
    if (rtf.length < 10 || rtf.length > cfg.maxBytes || !rtf.slice(0, 6).toString('latin1').startsWith('{\\rtf')) {
      return reply(res, 400, { ok: false, pesan: 'Lampiran bukan file RTF yang valid.' });
    }
    let fileName = safeName(body.fileName);
    if (!/\.rtf$/i.test(fileName)) fileName += '.rtf';
    try {
      const data = buildMessage({
        nama, mapel, kelas, fileName, rtf,
        jumlahSoal: Number.isFinite(body.jumlahSoal) ? body.jumlahSoal : null,
        perluDicek: Number.isFinite(body.perluDicek) ? body.perluDicek : null,
        namaFileAsli: clean(body.namaFileAsli, 160),
      });
      await smtpSend({ from: cfg.user, to: cfg.to, data });
      log('terkirim', ip, mapel, kelas, nama, fileName, rtf.length + ' B');
      reply(res, 200, { ok: true, pesan: 'Soal terkirim ke ' + cfg.to });
    } catch (e) {
      log('gagal', ip, e.message);
      reply(res, 502, { ok: false, pesan: 'Gagal mengirim email: ' + e.message });
    }
  });
});

server.listen(cfg.listenPort, cfg.listenHost, () => {
  log('Layanan kirim soal aktif di http://' + cfg.listenHost + ':' + cfg.listenPort + ' -> ' + cfg.to +
    (cfg.user ? '' : ' (SMTP belum diatur)'));
});
