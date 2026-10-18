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

**1. Ambil kode** (repo private, jadi butuh login GitHub):

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/ichalsmiler/konver-soal.git
cd konver-soal
```

Saat diminta *Username* isi `ichalsmiler`, dan *Password* isi **Personal Access Token**, bukan password GitHub.
Buat token di GitHub → Settings → Developer settings → Personal access tokens → *Fine-grained tokens*, lalu beri akses *Contents: Read-only* ke repo `konver-soal`.

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

Yang dilakukan skrip:

- memasang `nginx`, `git`, dan `rsync` (plus `certbot` bila HTTPS);
- menyalin aplikasi ke `/var/www/konver-soal`;
- membuat konfigurasi `/etc/nginx/sites-available/konver-soal`;
- membuka port di `ufw` bila firewall aktif.

**Alternatif tanpa clone manual:** skrip bisa mengunduh sendiri ke `/opt/konver-soal` memakai token:

```bash
curl -fsSL -H "Authorization: token TOKEN_ANDA" \
  https://raw.githubusercontent.com/ichalsmiler/konver-soal/main/deploy/install.sh -o install.sh
sudo GITHUB_TOKEN=TOKEN_ANDA bash install.sh
```

## Yang dirapikan otomatis

- Nomor soal `1.`, `1)`, `2.Teks`, `Soal 3.`, atau numbering Word, lalu dinomori ulang berurutan.
- Opsi `A.`, `a)`, `(a)`, numbering huruf, atau beberapa opsi dalam satu baris.
- Kunci dari `Kunci: C` / `Jawaban: b` / `ANS: B`, huruf tunggal di bawah opsi, tanda `*` pada opsi,
  opsi yang ditebalkan atau distabilo (tebalnya dihapus di hasil), atau tabel *Kunci Jawaban* di akhir dokumen.
- Kop soal, petunjuk, dan catatan dibuang.
- Gambar (PNG/JPEG/GIF/BMP/WMF/EMF), tebal, miring, garis bawah, subscript, dan superscript dipertahankan.
- Bagian Essay/Uraian juga dikenali.

## Batasan

- File `.doc` (Word 97–2003) dan `.rtf` belum didukung sebagai input. Simpan dulu sebagai `.docx`.
- Persamaan bawaan Word (Equation/OMML) diubah menjadi teks biasa. Sebaiknya rumus dan tulisan Arab berupa gambar.

## Struktur

- `index.html`, `styles.css`: antarmuka
- `js/docx-reader.js`: membaca .docx (numbering, gambar, tabel, format)
- `js/parser.js`: mendeteksi soal, opsi, dan kunci
- `js/rtf-writer.js`: menulis RTF format ujian
- `js/app.js`: logika antarmuka dan editor
- `lib/jszip.min.js`: JSZip 3.10.1 (MIT)
- `contoh-berantakan.docx`: contoh file soal berantakan untuk dicoba
- `deploy/install.sh`: installer Ubuntu Server (nginx)
