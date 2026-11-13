#!/usr/bin/env node
/*
 * Layanan "Kirim soal": menerima file RTF dari aplikasi Konver Soal lalu mengirimnya
 * lewat email (SMTP, mis. Gmail dengan App Password) ke alamat tujuan yang dikunci di server.
 * Tanpa pustaka tambahan (hanya modul bawaan Node.js >= 14).
 *
 * Konfigurasi lewat variabel lingkungan (biasanya /etc/konver-soal/kirim.env):
 *   SMTP_HOST=smtp.gmail.com   SMTP_PORT=465   SMTP_SECURE=true
 *   SMTP_USER=pengirim@gmail.com   SMTP_PASS=<app password 16 huruf>
 *   MAIL_TO=terimasoal@sman2makassar.sch.id   MAIL_FROM_NAME=Konver Soal
 *   PORT=3091   HOST=127.0.0.1   RATE_PER_HOUR=20
 *   ADMIN_PASS=<kata sandi admin untuk mengunci semester & tahun ajaran>
 *
 * Endpoint:  GET/POST /api/pengaturan  (semester & tahun ajaran yang dikunci admin)
 *   POST { sandi, kunci, semester, tahunAjaran }  atau  { sandi, cekSandi: true }
 *
 * Endpoint:  GET/POST /api/guru  (guru tambahan dari admin, melengkapi js/data-guru.js)
 *   POST { sandi, aksi: 'tambah' | 'hapus' | 'ubah', ... }  (lihat fungsi guru() di bawah)
 *
 * Endpoint:  POST /api/kirim  (JSON)
 *   { nama, mapel, kelas, fileName, rtf (teks) | rtfBase64, jumlahSoal, perluDicek, namaFileAsli }
 *   Body boleh dikompres (Content-Encoding: gzip).
 */
'use strict';

const http = require('http');
const net = require('net');
const tls = require('tls');
const os = require('os');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cfg = {
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '465', 10),
  secure: !/^(0|false|no)$/i.test(process.env.SMTP_SECURE || 'true'),
  // Buang spasi/karakter tak terlihat (mis. ikut tertempel) dan tanda kutip di tepi.
  user: (process.env.SMTP_USER || '').replace(/[\s​-‍﻿]+/g, '').replace(/^["']|["']$/g, ''),
  pass: (process.env.SMTP_PASS || '').replace(/[\s​-‍﻿]+/g, '').replace(/^["']|["']$/g, ''),
  to: process.env.MAIL_TO || 'terimasoal@sman2makassar.sch.id',
  fromName: process.env.MAIL_FROM_NAME || 'Konver Soal',
  listenPort: parseInt(process.env.PORT || '3091', 10),
  listenHost: process.env.HOST || '127.0.0.1',
  ratePerHour: parseInt(process.env.RATE_PER_HOUR || '20', 10),
  maxBytes: 20 * 1024 * 1024, // RTF maks ±20 MB (batas lampiran Gmail 25 MB)
  adminPass: (process.env.ADMIN_PASS || '').trim(),
  // systemd StateDirectory= mengisi STATE_DIRECTORY (mis. /var/lib/konver-soal)
  stateDir: process.env.STATE_DIRECTORY || process.env.STATE_DIR || path.join(__dirname, 'data'),
};

// ---------- Pengaturan yang dikunci admin (semester & tahun ajaran) ----------
const RE_SEMESTER = /^(Ganjil|Genap)$/;
const RE_TA = /^(\d{4})\/(\d{4})$/;
const settingsFile = () => path.join(cfg.stateDir, 'pengaturan.json');

function readSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    const ok = !!s.kunci && RE_SEMESTER.test(s.semester) && RE_TA.test(s.tahunAjaran);
    return ok ? { kunci: true, semester: s.semester, tahunAjaran: s.tahunAjaran, diubah: s.diubah || null } : { kunci: false };
  } catch (e) {
    return { kunci: false };
  }
}

function writeSettings(s) {
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  const tmp = settingsFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, settingsFile());
}

// ---------- Guru tambahan dari admin (melengkapi js/data-guru.js) ----------
const RE_KELAS = /^(X|XI|XII)$/;
const guruFile = () => path.join(cfg.stateDir, 'guru.json');
const MAX_GURU = 1000;

// guru.json: { tambahan: [{ nama, mapel, kelas }], koreksi: [{ asal, jadi }] }
//   tambahan = guru baru dari admin
//   koreksi  = perubahan pada guru bawaan (js/data-guru.js): asal = baris aslinya, jadi = hasil edit (null = disembunyikan)
// Format lama (array biasa) dibaca sebagai daftar tambahan.
const isGuru = g => !!g && typeof g.nama === 'string' && typeof g.mapel === 'string' && RE_KELAS.test(g.kelas);
const pickGuru = g => ({ nama: g.nama, mapel: g.mapel, kelas: g.kelas });
const sameGuru = (a, b) => a.nama === b.nama && a.mapel === b.mapel && a.kelas === b.kelas;

function readGuru() {
  try {
    const d = JSON.parse(fs.readFileSync(guruFile(), 'utf8'));
    const tambahan = Array.isArray(d) ? d : (d && d.tambahan) || [];
    const koreksi = (!Array.isArray(d) && d && Array.isArray(d.koreksi)) ? d.koreksi : [];
    return {
      tambahan: tambahan.filter(isGuru).map(pickGuru),
      koreksi: koreksi.filter(k => k && isGuru(k.asal) && (k.jadi === null || isGuru(k.jadi)))
        .map(k => ({ asal: pickGuru(k.asal), jadi: k.jadi && pickGuru(k.jadi) })),
    };
  } catch (e) {
    return { tambahan: [], koreksi: [] };
  }
}

function writeGuru(data) {
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  const tmp = guruFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, guruFile());
}

// Ubah (jadi = baris baru) atau hapus (jadi = null) satu baris guru, tambahan ataupun bawaan.
function terapkanUbah(data, asal, jadi) {
  const i = data.tambahan.findIndex(x => sameGuru(x, asal));
  if (i >= 0) {
    if (jadi) data.tambahan[i] = jadi; else data.tambahan.splice(i, 1);
    return;
  }
  const k = data.koreksi.findIndex(x => sameGuru(x.asal, asal));
  if (jadi && sameGuru(jadi, asal)) { if (k >= 0) data.koreksi.splice(k, 1); return; } // kembali ke data asli
  if (k >= 0) data.koreksi[k].jadi = jadi; else data.koreksi.push({ asal, jadi });
}

const sandiCocok = s => {
  const a = Buffer.from(String(s || '')), b = Buffer.from(cfg.adminPass);
  return cfg.adminPass.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- SMTP (minimal: TLS langsung / STARTTLS, AUTH LOGIN) ----------
const SMTP_IDLE_MS = 120 * 1000;     // koneksi diam selama ini = gagal
const SMTP_MAX_MS = 15 * 60 * 1000;  // batas total satu pengiriman
function smtpSend({ from, to, data }) {
  return new Promise((resolve, reject) => {
    let sock = cfg.secure
      ? tls.connect(cfg.port, cfg.host, { servername: cfg.host })
      : net.connect(cfg.port, cfg.host);
    let buf = '';
    let waiter = null;
    // Batas waktu: putus bila koneksi DIAM 2 menit (tidak ada data masuk/keluar), atau total lebih dari 15 menit.
    // (Dulu batasnya 60 detik untuk seluruh pengiriman, sehingga lampiran besar - mis. soal dengan
    //  banyak gambar, ±20 MB - selalu gagal "SMTP timeout" di koneksi internet sekolah.)
    const timer = setTimeout(() => fail(new Error('SMTP timeout (lebih dari 15 menit)')), SMTP_MAX_MS);
    const fail = err => { clearTimeout(timer); try { sock.destroy(); } catch (e) { /* abaikan */ } reject(err); };
    const onIdle = () => fail(new Error('SMTP timeout (koneksi ke server email diam ' + SMTP_IDLE_MS / 1000 + ' detik)'));

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
    const attach = s => { s.on('data', onData); s.on('error', fail); s.setTimeout(SMTP_IDLE_MS); s.on('timeout', onIdle); };
    attach(sock);

    const expect = (code) => new Promise((res, rej) => {
      waiter = resp => (resp.startsWith(String(code)) ? res(resp) : rej(new Error('SMTP: ' + resp.split('\n').pop())));
    });
    const cmd = (line, code) => { const p = expect(code); sock.write(line + '\r\n'); return p; };
    // Isi email ditulis per potongan 64 KB (menunggu 'drain'), agar penghitung "koneksi diam"
    // terus diperbarui selama lampiran besar diunggah.
    const writeChunked = async text => {
      for (let i = 0; i < text.length; i += 65536) {
        if (!sock.write(text.slice(i, i + 65536))) await new Promise(r => sock.once('drain', r));
      }
    };

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
      const done = expect(250);
      await writeChunked(data.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..') + '\r\n.\r\n');
      await done;
      await cmd('QUIT', 221).catch(() => {});
      clearTimeout(timer);
      sock.end();
      resolve();
    })().catch(fail);
  });
}

// ---------- ZIP (satu file, deflate) untuk melampirkan file Word asli dari guru ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function makeZip(fileName, data) {
  const name = Buffer.from(fileName, 'utf8');
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const head = (sig, central) => {
    const b = Buffer.alloc(central ? 46 : 30);
    let p = 0;
    const u16 = v => { b.writeUInt16LE(v, p); p += 2; };
    const u32 = v => { b.writeUInt32LE(v >>> 0, p); p += 4; };
    u32(sig);
    if (central) u16(20);              // versi pembuat
    u16(20); u16(0x0800); u16(8);      // versi, flag UTF-8, deflate
    u16(time); u16(date); u32(crc); u32(comp.length); u32(data.length);
    u16(name.length); u16(0);
    if (central) { u16(0); u16(0); u16(0); u32(0); u32(0); } // komentar, disk, atribut, offset 0
    return Buffer.concat([b, name]);
  };
  const local = head(0x04034B50, false);
  const central = head(0x02014B50, true);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length + comp.length, 16);
  return Buffer.concat([local, comp, central, end]);
}

// ---------- Pesan MIME ----------
const encWord = s => '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
const wrap76 = s => s.replace(/(.{76})/g, '$1\r\n');
const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function buildMessage({ nama, mapel, kelas, semester, tahunAjaran, fileName, rtf, asli, jumlahSoal, perluDicek, namaFileAsli }) {
  const boundary = 'ks-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const altBoundary = boundary + '-alt';
  const subject = 'Soal ' + mapel + ' - Kelas ' + kelas +
    (semester ? ' - Semester ' + semester : '') + (tahunAjaran ? ' ' + tahunAjaran : '') + ' - ' + nama;
  // Singkat: "24/10/2026 14.34" (tanpa detik).
  const waktu = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Makassar', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).replace(',', '');
  const rows = [
    ['Nama guru', nama],
    ['Mata pelajaran', mapel],
    ['Kelas', kelas],
    ['Semester', semester || '-'],
    ['Tahun ajaran', tahunAjaran || '-'],
    ['Jumlah soal', jumlahSoal != null ? jumlahSoal : '-'],
    ['Perlu dicek', perluDicek != null ? perluDicek : '-'],
    ['File asli', namaFileAsli || '-'],
    ['Waktu kirim', waktu + ' WITA'],
  ];
  // Lampiran: file RTF apa adanya + file Word asli dari guru di dalam .zip (bila ikut dikirim).
  const atts = [{ name: fileName, type: 'application/rtf', data: rtf }];
  if (asli && asli.length) {
    const namaAsli = safeName(namaFileAsli || 'file-asli.docx');
    atts.push({ name: namaAsli.replace(/\.[^.]*$/, '') + '.zip', type: 'application/zip', data: makeZip(namaAsli, asli) });
  }
  const catatan = atts.length > 1
    ? 'Terlampir: file RTF dan file asli dari guru (dalam .zip).'
    : 'File RTF terlampir.';
  // Teks biasa: sejajar bila dibaca dengan huruf monospace.
  const width = Math.max(...rows.map(r => r[0].length));
  const text = ['Kiriman soal dari aplikasi Konver Soal.', '']
    .concat(rows.map(([k, v]) => k.padEnd(width) + ' : ' + v), ['', catatan])
    .join('\r\n');
  // HTML: tabel, sehingga titik dua tetap sejajar di Gmail/Outlook (huruf proporsional).
  const td = 'padding:3px 0;vertical-align:top;';
  const html = '<!doctype html><html><body style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1b2430">' +
    '<p style="margin:0 0 12px">Kiriman soal dari aplikasi Konver Soal.</p>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse">' +
    rows.map(([k, v]) => '<tr><td style="' + td + 'white-space:nowrap;color:#5a6576">' + escHtml(k) + '</td>' +
      '<td style="' + td + 'padding:3px 8px;">:</td><td style="' + td + 'font-weight:bold">' + escHtml(v) + '</td></tr>').join('') +
    '</table><p style="margin:12px 0 0">' + escHtml(catatan) + '</p></body></html>';
  return [
    'From: ' + encWord(cfg.fromName) + ' <' + cfg.user + '>',
    'To: <' + cfg.to + '>',
    'Subject: ' + encWord(subject),
    'Date: ' + new Date().toUTCString().replace('GMT', '+0000'),
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: multipart/alternative; boundary="' + altBoundary + '"',
    '',
    '--' + altBoundary,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(text, 'utf8').toString('base64')),
    '--' + altBoundary,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(html, 'utf8').toString('base64')),
    '--' + altBoundary + '--',
    ...[].concat(...atts.map(att => [
      '--' + boundary,
      'Content-Type: ' + att.type + '; name="' + att.name + '"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="' + att.name + '"',
      '',
      wrap76(att.data.toString('base64')),
    ])),
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

// Salah sandi admin: maks 5 kali per 15 menit per IP.
const gagalAdmin = new Map();
function adminDiblokir(ip) {
  const now = Date.now();
  const list = (gagalAdmin.get(ip) || []).filter(t => now - t < 15 * 60e3);
  gagalAdmin.set(ip, list);
  return list.length >= 5;
}

// POST admin: baca body JSON kecil, cek kata sandi, lalu panggil handle(body).
function adminPost(req, res, ip, handle, maxBytes = 4096) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, pesan: 'Metode tidak didukung' });
  if (!cfg.adminPass) return reply(res, 503, { ok: false, pesan: 'Kata sandi admin belum diatur di server (sudo bash deploy/install.sh --update --admin).' });
  if (adminDiblokir(ip)) return reply(res, 429, { ok: false, pesan: 'Terlalu banyak percobaan sandi. Coba lagi 15 menit lagi.' });
  const chunks = [];
  let size = 0;
  req.on('data', c => { size += c.length; if (size > maxBytes) req.destroy(); else chunks.push(c); });
  req.on('end', () => {
    let b;
    try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return reply(res, 400, { ok: false, pesan: 'Data tidak valid.' }); }
    if (!b || !sandiCocok(b.sandi)) {
      gagalAdmin.get(ip).push(Date.now());
      log('sandi admin salah', ip);
      return reply(res, 403, { ok: false, pesan: 'Kata sandi admin salah.' });
    }
    handle(b);
  });
}

// GET /api/guru  -> { ok, guru: [tambahan], koreksi: [{ asal, jadi }] }
// POST /api/guru { sandi, aksi, ... }
//   aksi 'tambah' : { nama, mapel, kelas }
//   aksi 'hapus'  : { asal }                       (atau { nama, mapel, kelas } dari versi lama)
//   aksi 'ubah'   : { perubahan: [{ asal, jadi }] } (mis. ganti nama guru di semua mapelnya sekaligus)
function guru(req, res, ip) {
  const balas = data => reply(res, 200, { ok: true, guru: data.tambahan, koreksi: data.koreksi });
  if (req.method === 'GET') return balas(readGuru());
  adminPost(req, res, ip, b => {
    const rapikan = x => x && ({ nama: clean(x.nama, 80), mapel: clean(x.mapel, 80), kelas: clean(x.kelas, 10) });
    const salah = () => reply(res, 400, { ok: false, pesan: 'Isi nama guru, mata pelajaran, dan kelas (X, XI, atau XII).' });
    const valid = g => !!g && !!g.nama && !!g.mapel && RE_KELAS.test(g.kelas);
    const data = readGuru();
    let catatan;
    if (b.aksi === 'tambah') {
      const g = rapikan(b);
      if (!valid(g)) return salah();
      if (data.tambahan.some(x => sameGuru(x, g))) return reply(res, 409, { ok: false, pesan: 'Guru dengan mapel dan kelas ini sudah ada.' });
      if (data.tambahan.length >= MAX_GURU) return reply(res, 400, { ok: false, pesan: 'Daftar guru tambahan sudah penuh.' });
      data.tambahan.push(g);
      catatan = [g.nama, g.mapel, g.kelas];
    } else if (b.aksi === 'hapus') {
      const asal = rapikan(b.asal || b);
      if (!valid(asal)) return salah();
      terapkanUbah(data, asal, null);
      catatan = [asal.nama, asal.mapel, asal.kelas];
    } else if (b.aksi === 'ubah') {
      const list = Array.isArray(b.perubahan) ? b.perubahan.slice(0, 50) : [];
      const ubah = list.map(p => ({ asal: rapikan(p && p.asal), jadi: rapikan(p && p.jadi) }));
      if (!ubah.length || !ubah.every(p => valid(p.asal) && valid(p.jadi))) return salah();
      ubah.forEach(p => terapkanUbah(data, p.asal, p.jadi));
      if (data.koreksi.length > MAX_GURU) return reply(res, 400, { ok: false, pesan: 'Terlalu banyak perubahan tersimpan.' });
      catatan = ubah.map(p => p.asal.nama + ' / ' + p.asal.mapel + ' ' + p.asal.kelas + ' -> ' + p.jadi.nama + ' / ' + p.jadi.mapel + ' ' + p.jadi.kelas);
    } else {
      return reply(res, 400, { ok: false, pesan: 'Aksi tidak dikenal.' });
    }
    try { writeGuru(data); } catch (e) {
      log('gagal simpan guru', e.message);
      return reply(res, 500, { ok: false, pesan: 'Gagal menyimpan daftar guru di server.' });
    }
    log('guru ' + b.aksi, ip, ...catatan);
    balas(data);
  }, 64 * 1024);
}

function pengaturan(req, res, ip) {
  if (req.method === 'GET') return reply(res, 200, Object.assign({ ok: true, adminAktif: !!cfg.adminPass }, readSettings()));
  adminPost(req, res, ip, b => {
    if (b.cekSandi) return reply(res, 200, Object.assign({ ok: true }, readSettings()));
    const kunci = !!b.kunci;
    if (kunci && (!RE_SEMESTER.test(b.semester) || !RE_TA.test(b.tahunAjaran || ''))) {
      return reply(res, 400, { ok: false, pesan: 'Pilih semester dan tahun ajaran.' });
    }
    const s = kunci
      ? { kunci: true, semester: b.semester, tahunAjaran: b.tahunAjaran, diubah: new Date().toISOString() }
      : { kunci: false, diubah: new Date().toISOString() };
    try { writeSettings(s); } catch (e) {
      log('gagal simpan pengaturan', e.message);
      return reply(res, 500, { ok: false, pesan: 'Gagal menyimpan pengaturan di server.' });
    }
    log('pengaturan diubah', ip, JSON.stringify(s));
    reply(res, 200, Object.assign({ ok: true }, readSettings()));
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/kirim/status') {
    return reply(res, 200, { ok: true, siap: !!(cfg.user && cfg.pass), tujuan: cfg.to });
  }
  if (req.url === '/api/pengaturan') {
    return pengaturan(req, res, (req.headers['x-real-ip'] || req.socket.remoteAddress || '').toString());
  }
  if (req.url === '/api/guru') {
    return guru(req, res, (req.headers['x-real-ip'] || req.socket.remoteAddress || '').toString());
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
    try {
      let raw = Buffer.concat(chunks);
      // Aplikasi mengompres body dengan gzip (±10x lebih kecil, unggah jauh lebih cepat).
      if (/gzip/i.test(req.headers['content-encoding'] || '')) {
        raw = await new Promise((ok, no) => zlib.gunzip(raw, { maxOutputLength: cfg.maxBytes * 2 }, (e, out) => (e ? no(e) : ok(out))));
        if (raw.length > cfg.maxBytes * 2) return reply(res, 413, { ok: false, pesan: 'File terlalu besar.' });
      }
      body = JSON.parse(raw.toString('utf8'));
    } catch (e) { return reply(res, 400, { ok: false, pesan: 'Data tidak valid.' }); }
    const nama = clean(body.nama, 80), mapel = clean(body.mapel, 80), kelas = clean(body.kelas, 40);
    if (!nama || !mapel || !kelas) return reply(res, 400, { ok: false, pesan: 'Nama guru, mata pelajaran, dan kelas wajib diisi.' });
    // RTF dikirim sebagai teks (rtf) atau, dari versi lama aplikasi, base64 (rtfBase64).
    const rtf = typeof body.rtf === 'string'
      ? Buffer.from(body.rtf, 'latin1')
      : Buffer.from(String(body.rtfBase64 || ''), 'base64');
    if (rtf.length < 10 || rtf.length > cfg.maxBytes || !rtf.slice(0, 6).toString('latin1').startsWith('{\\rtf')) {
      return reply(res, 400, { ok: false, pesan: 'Lampiran bukan file RTF yang valid.' });
    }
    let fileName = safeName(body.fileName);
    let semester = RE_SEMESTER.test(body.semester) ? body.semester : '';
    let tahunAjaran = RE_TA.test(body.tahunAjaran || '') ? body.tahunAjaran : '';
    // Semester & tahun ajaran yang dikunci admin selalu menang (juga untuk aplikasi versi lama di browser).
    const lock = readSettings();
    if (lock.kunci && (semester !== lock.semester || tahunAjaran !== lock.tahunAjaran)) {
      semester = lock.semester;
      tahunAjaran = lock.tahunAjaran;
      fileName = safeName([mapel, kelas, semester, tahunAjaran.replace('/', '-')].join('-'));
    }
    if (!/\.rtf$/i.test(fileName)) fileName += '.rtf';
    const t0 = Date.now();
    const lama = () => Math.round((Date.now() - t0) / 1000) + ' dtk';
    try {
      // File Word asli dari guru (opsional, maks. 15 MB) -> dilampirkan dalam .zip.
      const asli = typeof body.asliBase64 === 'string' ? Buffer.from(body.asliBase64, 'base64') : null;
      if (asli && asli.length > 15 * 1024 * 1024) return reply(res, 413, { ok: false, pesan: 'File asli terlalu besar (maks. 15 MB).' });
      const data = buildMessage({
        nama, mapel, kelas, fileName, rtf, asli, semester, tahunAjaran,
        jumlahSoal: Number.isFinite(body.jumlahSoal) ? body.jumlahSoal : null,
        perluDicek: Number.isFinite(body.perluDicek) ? body.perluDicek : null,
        namaFileAsli: clean(body.namaFileAsli, 160),
      });
      await smtpSend({ from: cfg.user, to: cfg.to, data });
      log('terkirim', ip, mapel, kelas, nama, fileName, rtf.length + ' B', lama());
      reply(res, 200, { ok: true, pesan: 'Soal terkirim ke ' + cfg.to });
    } catch (e) {
      log('gagal', ip, mapel, kelas, nama, rtf.length + ' B', lama(), e.message);
      reply(res, 502, { ok: false, pesan: 'Gagal mengirim email: ' + e.message });
    }
  });
});

// ---------- Mode cek: node kirim.js --cek  (uji login SMTP tanpa mengirim email) ----------
if (process.argv.includes('--cek')) {
  const show = s => (s ? s.length + ' karakter' : '(kosong)');
  console.log('Server SMTP   : ' + cfg.host + ':' + cfg.port + (cfg.secure ? ' (TLS)' : ''));
  console.log('Pengirim      : "' + cfg.user + '"');
  console.log('Sandi         : ' + show(cfg.pass) + (cfg.pass && !/^[a-z]{16}$/.test(cfg.pass)
    ? '  <- App Password Google biasanya tepat 16 huruf kecil a-z' : (cfg.pass ? '  (format App Password OK)' : '')));
  console.log('Penerima      : ' + cfg.to);
  const sock = tls.connect(cfg.port, cfg.host, { servername: cfg.host });
  let buf = '', step = 0;
  const send = l => sock.write(l + '\r\n');
  sock.on('data', d => {
    buf += d.toString();
    if (!/\r\n$/.test(buf) || !/^\d{3} /m.test(buf.split('\r\n').slice(-2)[0] || '')) return;
    const resp = buf.trim(); buf = '';
    const code = resp.split('\n').pop().slice(0, 3);
    if (step === 0) { step = 1; send('EHLO cek'); }
    else if (step === 1) { step = 2; send('AUTH LOGIN'); }
    else if (step === 2) { step = 3; send(Buffer.from(cfg.user).toString('base64')); }
    else if (step === 3) { step = 4; send(Buffer.from(cfg.pass).toString('base64')); }
    else if (step === 4) {
      console.log(code === '235' ? '\nHASIL: LOGIN BERHASIL - tombol Kirim siap dipakai.'
        : '\nHASIL: LOGIN DITOLAK Google: ' + resp.split('\n').pop() +
          '\n  -> Pastikan memakai App Password (bukan sandi akun) yang dibuat SETELAH sandi akun terakhir diganti,' +
          '\n     Verifikasi 2 Langkah aktif, dan alamat pengirim benar.');
      send('QUIT'); sock.end(); process.exitCode = code === '235' ? 0 : 1;
    }
  });
  sock.on('error', e => { console.log('\nHASIL: tidak bisa terhubung ke ' + cfg.host + ': ' + e.message); process.exitCode = 1; });
  return;
}

// Node.js 12 memutus koneksi HTTP yang diam 2 menit (server.timeout bawaan). Pengiriman lampiran besar
// ke Gmail bisa lebih lama dari itu, jadi batasnya dinaikkan melebihi batas total SMTP.
server.setTimeout(SMTP_MAX_MS + 60 * 1000);

server.listen(cfg.listenPort, cfg.listenHost, () => {
  log('Layanan kirim soal aktif di http://' + cfg.listenHost + ':' + cfg.listenPort + ' -> ' + cfg.to +
    (cfg.user ? '' : ' (SMTP belum diatur)'));
});
