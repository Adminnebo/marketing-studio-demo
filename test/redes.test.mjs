import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { validarPublicacion, tipoMedio, limiteDe } from '../shared/redes.mjs';

const require = createRequire(import.meta.url);
const { cuerpoZernio } = require('../server/redes.js');

const ig = { id: 'a1', plataforma: 'instagram' };
const yt = { id: 'a2', plataforma: 'youtube' };
const tk = { id: 'a3', plataforma: 'tiktok' };
const x = { id: 'a4', plataforma: 'twitter' };

test('tipo de medio por extension', () => {
  assert.equal(tipoMedio('https://cdn/x/video.mp4'), 'video');
  assert.equal(tipoMedio('https://cdn/x/foto.png'), 'image');
  assert.equal(limiteDe('tiktok', 'image'), 4000);
  assert.equal(limiteDe('tiktok', 'video'), 2200);
});

test('YouTube no acepta imagenes y exige titulo', () => {
  const e = validarPublicacion({ texto: 'hola', tipo: 'image', cuentas: [yt], opciones: {} , modo: 'ahora' });
  assert.ok(e.some((m) => /solo acepta videos/.test(m)));
  assert.ok(e.some((m) => /título/.test(m)));
  assert.deepEqual(validarPublicacion({ texto: '', tipo: 'video', cuentas: [yt], opciones: { youtube: { titulo: 'Valvula' } }, modo: 'ahora' }), []);
});

test('TikTok exige privacidad y consentimiento', () => {
  const e = validarPublicacion({ texto: '', tipo: 'video', cuentas: [tk], opciones: { tiktok: {} }, modo: 'ahora' });
  assert.equal(e.length, 2);
  assert.deepEqual(validarPublicacion({ texto: '', tipo: 'video', cuentas: [tk], opciones: { tiktok: { privacidad: 'PUBLIC_TO_EVERYONE', consentimiento: true } }, modo: 'ahora' }), []);
});

test('limite de caracteres por red y fecha futura', () => {
  const largo = 'a'.repeat(300);
  assert.ok(validarPublicacion({ texto: largo, tipo: 'image', cuentas: [ig, x], modo: 'ahora' }).some((m) => /^X:/.test(m)));
  assert.ok(validarPublicacion({ texto: 'hola', tipo: 'image', cuentas: [ig], modo: 'programar', fecha: new Date(Date.now() - 1000).toISOString() }).length);
  assert.deepEqual(validarPublicacion({ texto: 'hola', tipo: 'image', cuentas: [ig], modo: 'programar', fecha: new Date(Date.now() + 3600e3).toISOString() }), []);
  assert.ok(validarPublicacion({ texto: 'hola', tipo: 'image', cuentas: [], modo: 'ahora' }).length);
});

test('cuerpo para Zernio: publicar ahora con TikTok y YouTube', () => {
  const c = cuerpoZernio({
    texto: 'Nuevo', medio: { url: 'https://cdn/v.mp4', tipo: 'video' }, cuentas: [tk, yt, ig],
    opciones: { tiktok: { privacidad: 'SELF_ONLY', comentarios: true, duo: false, stitch: false }, youtube: { titulo: ' Valvula ' }, instagram: { formato: 'story' } },
    modo: 'ahora',
  });
  assert.equal(c.publishNow, true);
  assert.deepEqual(c.mediaItems, [{ url: 'https://cdn/v.mp4', type: 'video' }]);
  assert.equal(c.tiktokSettings.privacy_level, 'SELF_ONLY');
  assert.equal(c.tiktokSettings.content_preview_confirmed, true);
  assert.equal(c.tiktokSettings.allow_duet, false);
  assert.equal(c.platforms.find((p) => p.platform === 'youtube').platformSpecificData.title, 'Valvula');
  assert.equal(c.platforms.find((p) => p.platform === 'instagram').platformSpecificData.contentType, 'story');
});

test('cuerpo para Zernio: programada con hora local y zona; foto de TikTok sin duo/stitch', () => {
  const c = cuerpoZernio({
    texto: '', medio: { url: 'https://cdn/f.png', tipo: 'image' }, cuentas: [tk],
    opciones: { tiktok: { privacidad: 'PUBLIC_TO_EVERYONE', comentarios: false } }, modo: 'programar',
    fechaLocal: '2026-10-01T09:30:00', zona: 'America/Santo_Domingo',
  });
  assert.equal(c.scheduledFor, '2026-10-01T09:30:00');
  assert.equal(c.timezone, 'America/Santo_Domingo');
  assert.equal(c.publishNow, undefined);
  assert.equal('allow_duet' in c.tiktokSettings, false);
});
