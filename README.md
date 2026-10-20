# Konver Soal

Aplikasi web untuk merapikan file soal ujian Word (.docx) yang formatnya tidak seragam, lalu mengekspornya ke RTF dengan format ujian:

```
Multiple choice
1.  Teks soal ....
    a.  opsi
    b.  opsi
    ...
    e.  opsi
  ANS: B
```

Nomor soal dan huruf opsi memakai numbering Word asli; opsi dimulai ulang dari "a" di setiap soal.

## Cara pakai

1. Buka `index.html` di browser (tidak perlu server atau internet).
2. Unggah file `.docx` atau tempel teks soal.
3. Periksa soal yang ditandai "Perlu dicek", edit teks/kunci bila perlu.
4. Klik **Ekspor RTF**.

File diproses sepenuhnya di browser, tidak diunggah ke server mana pun.

## Instalasi di Ubuntu Server

Skrip `deploy/install.sh` memasang nginx dan menayangkan aplikasi. Skrip ini sudah dicek sintaksnya, tetapi belum pernah dijalankan di server Ubuntu sungguhan.

### Cara cepat (satu perintah)

```bash
curl -fsSL https://raw.githubusercontent.com/ichalsmiler/konver-soal/main/deploy/install.sh | sudo bash
```

Kode diunduh ke `/opt/konver-soal`, lalu aplikasi bisa dibuka di `http://IP-SERVER/`. Opsi ditambahkan setelah `-s --`, misalnya:

```bash
curl -fsSL https://raw.githubusercontent.com/ichalsmiler/konver-soal/main/deploy/install.sh | sudo bash -s -- --port 8080
```

Update: `sudo bash /opt/konver-soal/deploy/install.sh --update`

### Cara manual

**1. Ambil kode:**

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/ichalsmiler/konver-soal.git
cd konver-soal
```

**2. Pasang** (pilih salah satu):

```bash
sudo bash deploy/install.sh                      # http://IP-SERVER/
sudo bash deploy/install.sh --port 8080          # http://IP-SERVER:8080/ (bila port 80 sudah dipakai)
sudo bash deploy/install.sh --domain soal.sekolah.sch.id
sudo bash deploy/install.sh --domain soal.sekolah.sch.id --email admin@sekolah.sch.id   # + HTTPS gratis
```

Untuk HTTPS, domain harus sudah diarahkan (DNS A record) ke IP server dan port 80/443 terbuka.

**Update ke versi terbaru:**

```bash
sudo bash deploy/install.sh --update
```

Perintah ini menjalankan `git pull`, lalu memasang ulang dengan pengaturan port/domain/HTTPS yang lama.

**Hapus:** `sudo bash deploy/install.sh --uninstall`

### Konfirmasi Ekspor & Kirim, nama file

Tombol **Ekspor RTF** dan **Kirim** sama-sama membuka konfirmasi *"Apakah soal yang Anda kirim sudah diperiksa
dengan baik dan benar?"* dengan isian:

- **Nama guru**: ketik sebagian nama lalu pilih dari daftar (mata pelajaran & kelas terisi otomatis)
- **Mata pelajaran**, **Kelas** (X / XI / XII), **Semester** (Ganjil / Genap), **Tahun ajaran** (2026/2027 – 2030/2031)

Nama file hasil: `Mapel-Kelas-Semester-TahunAjaran.rtf`, mis. `Ekonomi (Pilihan)-XII-Genap-2026-2027.rtf`.

Daftar guru ada di `js/data-guru.js` (diambil dari Lampiran 2 SK Penulis Soal Semester Ganjil & Genap TP 2025/2026).
Untuk menambah/mengubah guru, edit file itu: setiap baris `{ "nama": "...", "mapel": "...", "kelas": "X|XI|XII" }`.

### Tombol "Kirim" (kirim soal ke terimasoal@sman2makassar.sch.id)

Pengirim: akun **kirimsoal@sman2makassar.sch.id** (diisi saat `--smtp`), penerima: **terimasoal@sman2makassar.sch.id**.
Penerima bisa diganti saat pasang/update: `sudo MAIL_TO=alamat@sekolah.sch.id bash deploy/install.sh --update`.

Tombol **Kirim** menampilkan konfirmasi *"Apakah soal yang Anda kirim sudah diperiksa dengan baik dan benar?"*
beserta isian nama guru, mata pelajaran, dan kelas. Setelah **Ya, kirim**, file RTF dikirim lewat layanan kecil
di server (`server/kirim.js`, dipasang otomatis oleh `install.sh` sebagai service `konver-soal-kirim`).
Alamat tujuan dikunci di server, sehingga layanan tidak bisa dipakai mengirim ke alamat lain.
Setelah berhasil, muncul pop-up *"Soal berhasil dikirim"* berisi guru, mata pelajaran, kelas, semester,
nama file, alamat tujuan, jumlah soal, dan waktu kirim.

Soal pilihan ganda baru bisa ditambahkan dari tombol **Tambah soal** di atas atau di bawah daftar soal, atau ikon
**+** pada tiap soal (disisipkan tepat di bawah soal itu).

Layanan ini butuh satu **akun pengirim Google (Gmail / Google Workspace sekolah)** dengan **App Password**:

1. Masuk ke akun pengirim (kirimsoal@sman2makassar.sch.id), aktifkan **Verifikasi 2 Langkah** (Google Account → Keamanan).
2. Buka https://myaccount.google.com/apppasswords, buat App Password (mis. nama "Konver Soal"), salin 16 hurufnya.
3. Di server jalankan, lalu isi alamat Gmail dan App Password saat ditanya (tidak tampil di layar):

```bash
sudo bash /opt/konver-soal/deploy/install.sh --update --smtp
```

Pengaturan disimpan di `/etc/konver-soal/kirim.env` (hanya bisa dibaca root). Cek layanan:
`systemctl status konver-soal-kirim`, log: `journalctl -u konver-soal-kirim`.
Tombol Kirim hanya berfungsi bila aplikasi dibuka dari server (bukan dari file `index.html` di komputer).

Yang dilakukan skrip:

- memasang `nginx`, `git`, dan `rsync` (plus `certbot` bila HTTPS);
- menyalin aplikasi ke `/var/www/konver-soal`;
- membuat konfigurasi `/etc/nginx/sites-available/konver-soal`;
- membuka port di `ufw` bila firewall aktif.

## Yang dirapikan otomatis

- Nomor soal `1.`, `1)`, `2.Teks`, `Soal 3.`, atau numbering Word, lalu dinomori ulang berurutan.
- Opsi `A.`, `a)`, `(a)`, numbering huruf, atau beberapa opsi dalam satu baris.
- Kunci dari `Kunci: C` / `Jawaban: b` / `ANS: B`, huruf tunggal di bawah opsi, tanda `*` pada opsi,
  opsi yang ditebalkan atau distabilo (tebalnya dihapus di hasil), atau tabel *Kunci Jawaban* di akhir dokumen.
- Kop soal, petunjuk, dan catatan dibuang.
- Gambar (PNG/JPEG/GIF/BMP/WMF/EMF), tebal, miring, garis bawah, subscript, dan superscript dipertahankan.
- Tabel di dalam soal (mis. tabel data percobaan) tetap bisa diedit di preview, lalu saat ekspor diubah menjadi
  gambar PNG yang ringkas (grayscale, ±10–30 KB per tabel) namun tetap tajam dan terbaca. Bisa dimatikan
  lewat pengaturan "Tabel dalam soal dijadikan gambar" agar diekspor sebagai tabel Word biasa.
- Ilustrasi yang dibuat dari shape Word (kotak, garis/panah, kotak teks, grup, kanvas) beserta label teks
  di sekitarnya digambar ulang menjadi satu gambar PNG dengan ukuran sama seperti di Word.
  Shape lama format VML belum didukung dan akan ditandai.
- Foto besar dikompres otomatis saat ekspor: resolusi diturunkan ke ±2× ukuran tampilnya dan foto disimpan
  sebagai JPEG bila jauh lebih kecil (gambar garis/diagram tetap PNG). Ukuran di Word tidak berubah dan tetap
  tajam di zoom 100%; contoh: file RTF 6,1 MB menjadi ±0,9 MB. Bisa dimatikan lewat pengaturan "Kompres foto besar".
- Deretan gambar dengan label huruf/angka di atas atau bawahnya (mis. "A  B  C" di atas foto) digabung
  menjadi satu gambar agar label tetap sejajar dengan gambarnya.
- Gambar WMF/EMF (mis. persamaan Microsoft Equation 3.0 / MathType) diubah menjadi PNG yang tajam dan kecil,
  sehingga tampil di preview dan di aplikasi CBT. Persamaan sebaris diturunkan agar sejajar dengan teks.
- Persamaan bawaan Word (Equation/OMML) digambar menjadi PNG kecil (±1 KB, grayscale) dengan pecahan, akar,
  pangkat, indeks, matriks, kurung, integral/sigma, dan fungsi tetap utuh. Garis dasarnya disejajarkan dengan
  teks dan huruf opsi. Bila gambar gagal dibuat, persamaan menjadi teks biasa dan soalnya ditandai.
- Simbol yang tidak terbaca oleh pengimpor ujian (ExamView/Moodle mengubahnya menjadi "?"), mis. ⇌ ⅔ ≤ ≥ α π √ ℃
  atau tulisan Arab, digambar menjadi PNG kecil seukuran teks dan sejajar garis dasarnya. Subskrip/superskrip
  Unicode (H₂O, H₃O⁺) tetap teks berformat subscript/superscript.
- Opsi yang berupa gambar daftar "A. … E." (hasil screenshot) dipotong otomatis menjadi 5 gambar opsi,
  tanpa OCR sehingga simbol (√, pangkat, derajat) tetap persis. Bila soal dan opsi ada dalam satu gambar,
  bagian soal dan opsinya dipisah. Bila bentuknya tidak meyakinkan, gambar dibiarkan utuh.
- Daftar di dalam soal yang disejajarkan dengan tab (mis. "Kas<tab><tab>Rp.5.000.000,-") tetap rata:
  deretan tab digabung dan baris-baris itu diberi tab stop yang sama sesuai isi terpanjang.
- Opsi berbaris ganda seperti jurnal akuntansi (akun debit, lalu akun kredit yang menjorok, 2–4 baris)
  tetap satu opsi; baris baru dan tab dipertahankan sehingga susunan jurnalnya sama dengan aslinya.
- Tabel opsi berjudul kolom (mis. kertas kerja Akun | D | K) dengan baris a.–e.: tiap opsi menjadi
  gambar tabel kecil (judul + barisnya) dengan lebar kolom seragam.
- Tabel opsi (baris berlabel A–E, atau menyamping dengan A–E di baris atas) diubah menjadi opsi a–e.
- Daftar petunjuk bernomor sebelum judul "Soal Pilihan Ganda" tidak dianggap soal.
- Aplikasi khusus pilihan ganda: soal di bagian Essay/Uraian tidak diekspor, hanya ditampilkan di "Teks di luar soal".

## Batasan

- File `.doc` (Word 97–2003) dan `.rtf` belum didukung sebagai input. Simpan dulu sebagai `.docx`.
- Persamaan OMML digambar oleh browser (MathML, font Cambria Math), jadi butuh browser yang mendukung MathML
  (Chrome/Edge 109+, Firefox, Safari). Persamaan di dalam kotak teks shape tetap berupa teks.
- Tulisan Arab sebaiknya berupa gambar.

## Struktur

- `index.html`, `styles.css`: antarmuka
- `js/docx-reader.js`: membaca .docx (numbering, gambar, tabel, format)
- `js/parser.js`: mendeteksi soal, opsi, dan kunci
- `js/rtf-writer.js`: menulis RTF format ujian
- `js/table-image.js`: mengubah tabel soal menjadi gambar PNG
- `js/drawing-render.js`: menggambar ilustrasi shape Word menjadi PNG
- `js/app.js`: logika antarmuka dan editor
- `lib/jszip.min.js`: JSZip 3.10.1 (MIT)
- `lib/WMFJS.bundle.min.js`, `lib/EMFJS.bundle.min.js`: perender WMF/EMF dari rtf.js 3.0.9 (MIT, lihat `lib/rtf.js-LICENSE.txt`)
- `js/metafile-image.js`: mengubah WMF/EMF menjadi PNG
- `js/omml-image.js`: mengubah persamaan Word (OMML) ke MathML lalu ke PNG
- `js/option-split.js`: memotong gambar daftar opsi menjadi opsi a–e
- `contoh-berantakan.docx`: contoh file soal berantakan untuk dicoba
- `deploy/install.sh`: installer Ubuntu Server (nginx)
