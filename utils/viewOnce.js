// View-once media (gambar/video "sekali lihat").
//
// - Deteksi via flag isViewOnce di model WA Web (tipe pesan tetap image/video,
//   jadi cek msg.type saja tidak cukup).
// - Media sekali lihat hanya bisa diunduh SATU KALI — setelah diunduh WA
//   menandainya "dibuka" dan directPath hangus. Karena itu bot mengunduh
//   tepat sekali, menyimpan salinan ke ./downloads, lalu memakai buffer yang
//   sama untuk AI vision / transkripsi. Jangan panggil downloadMedia() dua
//   kali untuk pesan yang sama.

import fsp from 'fs/promises';
import path from 'path';
import { logger } from './logger.js';

const DOWNLOAD_DIR = './downloads';

export function isViewOnceMessage(msg) {
  try {
    if (!msg) return false;
    return Boolean(
      msg.isViewOnce ||
      msg._data?.isViewOnce ||
      msg.type === 'view_once' ||
      msg._data?.type === 'view_once'
    );
  } catch {
    return false;
  }
}

export async function saveViewOnceMedia(media, senderJid) {
  try {
    const dir = path.resolve(DOWNLOAD_DIR);
    await fsp.mkdir(dir, { recursive: true });
    const rawExt = (media.mimetype || '').split('/')[1] || 'bin';
    const ext = rawExt.split(';')[0].replace(/[^a-z0-9]/gi, '') || 'bin';
    const safe = String(senderJid || 'unknown').replace(/[^0-9a-z]/gi, '').slice(-16) || 'unknown';
    const file = path.join(dir, `viewonce-${safe}-${Date.now()}.${ext}`);
    await fsp.writeFile(file, Buffer.from(media.data, 'base64'));
    return file;
  } catch (e) {
    logger.error('ViewOnce', 'Save failed:', e.message?.slice(0, 100));
    return null;
  }
}
