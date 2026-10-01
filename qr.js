'use strict';

// Decodifica QR da immagine JPEG/PNG, interamente in locale (pure JS).
const jsQR = require('jsqr');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');

/**
 * Decodifica un'immagine (Buffer JPEG o PNG) in { data: Uint8ClampedArray, width, height }.
 * Prova prima PNG poi JPEG. Lancia se nessun formato va a buon fine.
 */
function decodeImage(buf) {
  // PNG: magic \x89PNG
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) {
    const png = PNG.sync.read(buf);
    return { data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), width: png.width, height: png.height };
  }
  // JPEG: magic \xFF\xD8
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    const raw = jpeg.decode(buf, { maxMemoryUsageInMB: 256 });
    if (!raw) throw new Error('JPEG non decodificabile');
    return { data: raw.data, width: raw.width, height: raw.height };
  }
  // fallback: tenta entrambi
  try {
    const png = PNG.sync.read(buf);
    return { data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), width: png.width, height: png.height };
  } catch {
    const raw = jpeg.decode(buf, { maxMemoryUsageInMB: 256 });
    if (!raw) throw new Error('Formato immagine non supportato (usa JPEG o PNG)');
    return { data: raw.data, width: raw.width, height: raw.height };
  }
}

/**
 * Trova e decodifica un QR code in un buffer immagine.
 * @returns {string|null} contenuto del QR, o null se non trovato
 */
function decodeQr(buf) {
  const img = decodeImage(buf);
  const res = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  return res ? res.data : null;
}

module.exports = { decodeQr, decodeImage };
