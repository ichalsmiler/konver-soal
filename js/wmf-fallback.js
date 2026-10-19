/*
 * Membuat WMF (Windows Metafile) berisi bitmap, persis seperti cadangan gambar yang
 * ditulis Microsoft Word di RTF ({\nonshppict{\pict\wmetafile8 ...}}).
 * Pembaca RTF lama (mis. ExamView) hanya mengenali gambar WMF ini, bukan PNG/JPEG.
 *
 * Isi: SETMAPMODE, SETWINDOWORG/EXT, SAVEDC, SETSTRETCHBLTMODE, DIBSTRETCHBLT, RESTOREDC, EOF.
 * Tanpa header "placeable" (tidak boleh ada di dalam RTF).
 * Gambar abu-abu memakai DIB 4-bit 16 tingkat abu-abu (seperti Word), selain itu DIB 24-bit.
 */
(function (root) {
  'use strict';

  /** true bila semua piksel (praktis) abu-abu. */
  function isGray(rgba) {
    for (let i = 0; i < rgba.length; i += 4) {
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      if (Math.abs(r - g) > 12 || Math.abs(g - b) > 12 || Math.abs(r - b) > 12) return false;
    }
    return true;
  }

  /**
   * @param w, h  ukuran piksel
   * @param rgba  Uint8(Clamped)Array w*h*4 (RGBA, baris dari atas); transparan dianggap putih
   * @returns Uint8Array berisi WMF
   */
  function fromRgba(w, h, rgba) {
    const gray = isGray(rgba);
    const bpp = gray ? 4 : 24;
    const rowLen = Math.ceil((w * bpp) / 32) * 4;
    const paletteSize = gray ? 16 * 4 : 0;
    const dibSize = 40 + paletteSize + rowLen * h;

    const out = new Uint8Array(18 + 10 + 10 + 14 + 6 + 8 + (26 + dibSize) + 8 + 6 + 64);
    let p = 0;
    const u16 = v => { out[p++] = v & 0xFF; out[p++] = (v >> 8) & 0xFF; };
    const u32 = v => { out[p++] = v & 0xFF; out[p++] = (v >>> 8) & 0xFF; out[p++] = (v >>> 16) & 0xFF; out[p++] = (v >>> 24) & 0xFF; };

    const recs = [
      [0x0103, [8]],          // SETMAPMODE MM_ANISOTROPIC
      [0x020B, [0, 0]],       // SETWINDOWORG (y, x)
      [0x020C, [h, w]],       // SETWINDOWEXT (y, x)
      [0x001E, []],           // SAVEDC
      [0x0107, [4]],          // SETSTRETCHBLTMODE HALFTONE
      [0x0B41, null],         // DIBSTRETCHBLT + DIB
      [0x0127, [0xFFFF]],     // RESTOREDC -1
      [0x0000, []],           // EOF
    ];
    const words = r => 3 + (r[1] ? r[1].length : 10 + dibSize / 2);
    const total = 9 + recs.reduce((n, r) => n + words(r), 0);

    // METAHEADER
    u16(1); u16(9); u16(0x0300); u32(total); u16(0); u32(Math.max(...recs.map(words))); u16(0);

    for (const r of recs) {
      u32(words(r)); u16(r[0]);
      if (r[1]) { r[1].forEach(u16); continue; }
      // DIBSTRETCHBLT: ROP SRCCOPY, srcH, srcW, ySrc, xSrc, destH, destW, yDst, xDst
      u32(0x00CC0020); u16(h); u16(w); u16(0); u16(0); u16(h); u16(w); u16(0); u16(0);
      // BITMAPINFOHEADER
      u32(40); u32(w); u32(h); u16(1); u16(bpp); u32(0); u32(rowLen * h); u32(0); u32(0);
      u32(gray ? 16 : 0); u32(0);
      if (gray) for (let k = 0; k < 16; k++) { const v = k * 17; out[p++] = v; out[p++] = v; out[p++] = v; out[p++] = 0; }
      const start = p;
      out.fill(255, start, start + rowLen * h);
      for (let y = 0; y < h; y++) {
        const row = start + (h - 1 - y) * rowLen; // baris dari bawah
        for (let x = 0; x < w; x++) {
          const s = (y * w + x) * 4, a = rgba[s + 3] / 255;
          const mix = c => c * a + 255 * (1 - a);
          if (gray) {
            const g = Math.round(mix((rgba[s] * 299 + rgba[s + 1] * 587 + rgba[s + 2] * 114) / 1000) / 17);
            const i = row + (x >> 1);
            out[i] = x & 1 ? (out[i] & 0xF0) | g : (out[i] & 0x0F) | (g << 4);
          } else {
            out[row + x * 3] = Math.round(mix(rgba[s + 2]));
            out[row + x * 3 + 1] = Math.round(mix(rgba[s + 1]));
            out[row + x * 3 + 2] = Math.round(mix(rgba[s]));
          }
        }
      }
      p = start + rowLen * h;
    }
    return out.subarray(0, p);
  }

  function toBase64(u8) {
    if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
    let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  const api = { fromRgba, toBase64, isGray };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WmfFallback = api;
})(this);
