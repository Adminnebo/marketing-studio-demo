import test from 'node:test';
import assert from 'node:assert/strict';
import { entradasDe, faltantes, formatoDe, creditosDe } from '../shared/reglas.mjs';

const CATS = [
  { slug: 'all', formats: [] },
  { slug: 'product-shot', formats: [
    { slug: 'with-model', name: 'With model', type: 'product_shots_people' },
    { slug: 'standalone', name: 'Standalone', type: 'product_shots' }] },
  { slug: 'ugc', formats: [{ slug: 'talking-head', name: 'Talking head', type: 'ugc' }] },
  { slug: 'motion', formats: [{ slug: 'saas', name: 'SaaS', type: 'saas_motion' }] },
];
const COSTOS = {
  image: [
    { flow: 'product_shots', scenario: 'general', credits: 1.6 },
    { flow: 'product_shots', scenario: 'selected_style', credits: 1.5 },
    { flow: 'ads', scenario: 'all', credits: 7.5 }],
  video: [
    { flow: 'ugc_v2', scenario: '480p', fixed_credits: 0, credits_per_second: 3, selector: { resolution: '480p' } },
    { flow: 'ugc_v2', scenario: '720p', fixed_credits: 0, credits_per_second: 6.5, selector: { resolution: '720p' } },
    { flow: 'hypermotion', scenario: 'general_or_v2_style', fixed_credits: 0.95, credits_per_second: 5.94 }],
};

test('producto obligatorio y avatar opcional en product_shots_people', () => {
  const p = { id: '1', type: 'product_shots_people', name: 'Chilled Can', format_slugs: ['with-model'] };
  const f = formatoDe(p, CATS, 'product-shot');
  assert.equal(f.formatSlug, 'with-model');
  assert.equal(f.formato.name, 'With model');
  const e = entradasDe(p, f);
  assert.deepEqual([e.producto, e.productoObligatorio, e.avatar, e.avatarObligatorio], [true, true, true, false]);
  assert.equal(faltantes(e, {}).length, 1);
  assert.deepEqual(faltantes(e, { producto: { media_id: 'x' } }), []);
});

test('product_shots solo producto no pide avatar', () => {
  const p = { id: '2', type: 'product_shots', name: 'Ice Cube Hover', format_slugs: ['standalone'] };
  const e = entradasDe(p, formatoDe(p, CATS, 'all'));
  assert.equal(e.avatar, false);
  assert.equal(e.productoObligatorio, true);
});

test('saas_motion acepta URL y la valida', () => {
  const p = { id: '3', type: 'saas_motion', name: 'X', format_slugs: ['saas'], required_inputs: ['brand_url', 'product_image'] };
  const e = entradasDe(p, formatoDe(p, CATS, 'motion'));
  assert.equal(e.aceptaUrl, true);
  assert.equal(e.urlObligatoria, true);
  assert.match(faltantes(e, { producto: {}, url: 'http://mal.com' }).join(), /https/);
  assert.deepEqual(faltantes(e, { producto: {}, url: 'https://jh.com' }), []);
});

test('required_inputs con prompt lo vuelve obligatorio', () => {
  const p = { id: '4', type: 'poster', name: 'P', format_slugs: ['general'], required_inputs: { prompt: { required: true } } };
  const e = entradasDe(p, {});
  assert.equal(e.promptObligatorio, true);
  assert.equal(e.producto, false);
  assert.ok(faltantes(e, { prompt: '  ' }).length);
});

test('creditos: imagen fija, UGC a 720p por segundo, video sin duracion = null', () => {
  assert.equal(creditosDe('product_shots', COSTOS), 1.5);
  assert.equal(creditosDe('ads', COSTOS), 7.5);
  assert.equal(creditosDe('ugc', COSTOS, 10), 65);
  assert.equal(creditosDe('hypermotion', COSTOS, 5), Math.round(0.95 + 5.94 * 5));
  assert.equal(creditosDe('hypermotion', COSTOS, null), null);
  assert.equal(creditosDe('poster', null), null);
});
