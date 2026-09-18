const test = require('node:test');
const assert = require('node:assert/strict');
const { enriquecer, filtrar, ordenar, facetas } = require('../server/lib/catalogo');

const base = [
  { id: 'a', type: 'product_shots', name: 'Chilled Can', cover_image: { width: 1080, height: 1620 }, format_slugs: ['standalone'] },
  { id: 'b', type: 'hypermotion', name: 'Exploded View', cover_image: { width: 600, height: 1066, type: 'video' }, format_slugs: ['hypermotion'] },
  { id: 'c', type: 'ads', name: 'Cordless Drill', cover_image: { width: 1000, height: 1000 }, format_slugs: ['general'] },
].map((p, i) => ({ ...enriquecer(p, i) }));
// Clasificacion simulada (en produccion viene de shared/clasificacion.json).
Object.assign(base[0], { _prod: 'bebidas_alimentos', _estilos: ['lifestyle'], _persona: true, _jh: 2, _clasif: true, _sirve: [] });
Object.assign(base[1], { _prod: 'tecnologia', _estilos: ['tecnico', 'oscuro_lujo'], _persona: false, _jh: 9, _clasif: true, _sirve: ['electrico', 'iluminacion'] });
Object.assign(base[2], { _prod: 'herramientas', _estilos: ['tecnico'], _persona: false, _jh: 9, _clasif: true, _sirve: ['electrico', 'herramientas'] });

test('categoria, medio y orientacion derivados', () => {
  assert.equal(base[1]._cat, 'motion');
  assert.equal(base[1]._medio, 'video');
  assert.equal(base[0]._orient, 'vertical');
  assert.equal(base[2]._orient, 'cuadrada');
});

test('orden JH: mejor encaje primero, empate por orden original', () => {
  assert.deepEqual(ordenar(base, 'jh').map((p) => p.id), ['b', 'c', 'a']);
  assert.deepEqual(ordenar(base, 'original').map((p) => p.id), ['a', 'b', 'c']);
});

test('filtros combinados', () => {
  assert.deepEqual(filtrar(base, { sirve: 'herramientas' }).map((p) => p.id), ['c']);
  assert.deepEqual(filtrar(base, { estilo: 'tecnico,oscuro_lujo' }).map((p) => p.id), ['b']);
  assert.deepEqual(filtrar(base, { persona: 'si' }).map((p) => p.id), ['a']);
  assert.deepEqual(filtrar(base, { medio: 'video' }).map((p) => p.id), ['b']);
  assert.deepEqual(filtrar(base, { categoria: 'ads', q: 'drill' }).map((p) => p.id), ['c']);
});

test('facetas cuentan con los demas filtros aplicados', () => {
  const f = facetas(base, { medio: 'foto' });
  assert.deepEqual(f.sirve, { electrico: 1, herramientas: 1 });
  assert.equal(f.estilo.lifestyle, 1);
});
