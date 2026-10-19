/*
 * Mengubah gambar WMF/EMF (mis. persamaan Microsoft Equation 3.0 / MathType) menjadi PNG.
 * Memakai WMFJS/EMFJS (rtf.js, MIT) untuk menggambar metafile ke SVG, lalu SVG
 * dirasterisasi ke kanvas 2x agar tajam. Hitam-putih -> PNG abu-abu 4-bit (kecil).
 * Bila gagal, hasilnya null dan gambar asli dipakai apa adanya.
 */
(function (root) {
  'use strict';

  const SCALE = 2;
  const TW_PX = 15;
  const MM_ANISOTROPIC = 8;

  function b64ToBuffer(b64) {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }

  function svgToImage(svg) {
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
    return new Promise(res => {
      const el = new Image();
      el.onload = () => res(el);
      el.onerror = () => res(null);
      el.src = src;
    });
  }

  function isColored(ctx, w, h) {
    const d = ctx.getImageData(0, 0, w, h).data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (Math.abs(r - g) > 24 || Math.abs(g - b) > 24 || Math.abs(r - b) > 24) return true;
    }
    return false;
  }

  /** img: { type: 'wmf'|'emf', b64, w, h (twips) } -> gambar PNG baru, atau null. */
  async function toPng(img) {
    if (!img || (img.type !== 'wmf' && img.type !== 'emf')) return null;
    const lib = img.type === 'wmf' ? root.WMFJS : root.EMFJS;
    if (!lib) return null;
    if (lib.loggingEnabled) lib.loggingEnabled(false);
    const wPx = Math.max(1, Math.round((img.w || 1500) / TW_PX));
    const hPx = Math.max(1, Math.round((img.h || 600) / TW_PX));
    const W = wPx * SCALE, H = hPx * SCALE;
    let svg;
    try {
      const r = new lib.Renderer(b64ToBuffer(img.b64));
      svg = img.type === 'wmf'
        ? r.render({ width: W + 'px', height: H + 'px', xExt: W, yExt: H, mapMode: MM_ANISOTROPIC })
        : r.render({ width: W + 'px', height: H + 'px', wExt: W, hExt: H, xExt: W, yExt: H, mapMode: MM_ANISOTROPIC });
    } catch (e) {
      console.warn('Metafile tidak bisa dibaca:', e);
      return null;
    }
    const el = await svgToImage(svg);
    if (!el) return null;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(el, 0, 0, W, H);
    // Gambar kosong (semua putih) dianggap gagal.
    const d = ctx.getImageData(0, 0, W, H).data;
    let ink = false;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) { ink = true; break; }
    if (!ink) return null;
    let b64 = null;
    if (!isColored(ctx, W, H) && root.TableImage && root.TableImage.encodeGray4) {
      b64 = await root.TableImage.encodeGray4(c).catch(() => null);
    }
    if (!b64) b64 = c.toDataURL('image/png').split(',')[1];
    return { type: 'png', b64, pxW: W, pxH: H, w: img.w || wPx * TW_PX, h: img.h || hPx * TW_PX, fromMetafile: img.type };
  }

  root.MetafileImage = { toPng };
})(this);
