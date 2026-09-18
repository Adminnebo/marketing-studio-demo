const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizar, armar } = require('../server/lib/modelos');

const seedance25 = normalizar({
  id: 'seedance_2_5', name: 'Seedance 2.5', provider_name: 'Bytedance', output_type: 'video',
  parameters: [
    { name: 'mode', options: ['t2v', 'omni_reference', 'video_edit', 'video_extension'], default: 't2v' },
    { name: 'duration', min: 4, max: 30, default: 5 },
    { name: 'resolution', type: 'string', options: ['480p', '720p', '1080p'], default: '720p' },
    { name: 'generate_audio', type: 'bool', default: true },
    { name: 'extension_mode', options: ['backward', 'forward'] },
  ],
  medias: [{ roles: ['start_image', 'end_image', 'image_references', 'video_references'] }],
  aspect_ratios: ['auto', '16:9', '9:16', '1:1'],
});
const veo = normalizar({
  id: 'veo3_1', name: 'Veo 3.1', output_type: 'video',
  parameters: [{ name: 'duration', options: [4, 6, 8], default: 8 }, { name: 'quality', type: 'string', options: ['basic', 'high', 'ultra'], default: 'basic' }],
  medias: [{ roles: ['start_image'] }], aspect_ratios: ['16:9', '9:16'],
});
const nano = normalizar({ id: 'nano_banana_pro', name: 'Nano Banana Pro', output_type: 'image', parameters: [{ name: 'resolution', type: 'string', options: ['1k', '2k', '4k'], default: '2k' }], medias: [{ roles: ['image_references'] }], aspect_ratios: ['1:1', '9:16'] });
const zimg = normalizar({ id: 'z_image', name: 'Z Image', output_type: 'image', parameters: [], medias: [], aspect_ratios: ['1:1'] });

test('normaliza: duracion, parametros visibles, modo automatico y rol de imagen', () => {
  assert.deepEqual(seedance25.duracion, { min: 4, max: 30, def: 5 });
  assert.deepEqual(seedance25.params.map((p) => p.nombre), ['resolution', 'generate_audio']);
  assert.equal(seedance25.modoAuto, true);
  assert.equal(seedance25.rolImagen, 'start_image');
  assert.deepEqual(seedance25.aspectos, ['16:9', '9:16', '1:1']);
  assert.deepEqual(veo.duracion, { opciones: [4, 6, 8], def: 8 });
  assert.equal(nano.rolImagen, 'image_references');
  assert.equal(zimg.aceptaImagen, false);
});

test('armar: solo params declarados, duracion valida, modo segun imagen', () => {
  const sinImg = armar(seedance25, { prompt: 'p', aspecto: '9:16', duracion: 10, opciones: { resolution: '1080p', generate_audio: false, hack: 'x' } });
  assert.equal(sinImg.tool, 'generate_video');
  assert.deepEqual(sinImg.params, { model: 'seedance_2_5', prompt: 'p', use_unlim: false, aspect_ratio: '9:16', duration: 10, resolution: '1080p', generate_audio: false, mode: 't2v' });
  const conImg = armar(seedance25, { prompt: 'p', duracion: 99, mediaId: 'm1' });
  assert.equal(conImg.params.mode, 'omni_reference');
  assert.equal(conImg.params.duration, undefined); // fuera de rango: se deja el del modelo
  assert.deepEqual(conImg.params.medias, [{ value: 'm1', role: 'start_image' }]);
  assert.equal(armar(veo, { prompt: 'p', duracion: 5 }).params.duration, undefined);
  assert.equal(armar(veo, { prompt: 'p', duracion: 6 }).params.duration, 6);
  const img = armar(nano, { prompt: 'p', aspecto: '4:3', opciones: { resolution: '8k' }, mediaId: 'm2' });
  assert.equal(img.tool, 'generate_image');
  assert.equal(img.params.aspect_ratio, undefined);
  assert.equal(img.params.resolution, undefined);
  assert.deepEqual(img.params.medias, [{ value: 'm2', role: 'image_references' }]);
  assert.equal(armar(zimg, { prompt: 'p', mediaId: 'm3' }).params.medias, undefined);
});

test('nombres limpios y familia; alias fuera', () => {
  const k = normalizar({ id: 'kling3_0', name: 'Kling v3.0', provider_name: 'Kling', output_type: 'video', parameters: [], medias: [], aspect_ratios: [] });
  assert.equal(k.nombre, 'Kling 3.0');
  assert.equal(k.familia, 'Kling');
  const c1 = normalizar({ id: 'cinematic_studio_video', name: 'Cinema Studio Video', provider_name: 'Higgsfield', output_type: 'video', parameters: [], medias: [], aspect_ratios: [] });
  const c2 = normalizar({ id: 'cinematic_studio_video_v2', name: 'Cinema Studio Video', provider_name: 'Higgsfield', output_type: 'video', parameters: [], medias: [], aspect_ratios: [] });
  assert.notEqual(c1.nombre, c2.nombre);
  assert.equal(c1.proveedor, '');
  const nuevo = normalizar({ id: 'modelo_x', name: 'Higgsfield Nuevo X', provider_name: 'Higgsfield', output_type: 'image', parameters: [], medias: [], aspect_ratios: [] });
  assert.equal(nuevo.nombre, 'Nuevo X');
});
