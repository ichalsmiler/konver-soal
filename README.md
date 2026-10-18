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
