import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { modelCatalogFromCache, readModelCatalog } from '../server/model-catalog.js';
import { defaultModelName, modelNameForProviderChange, modelOptions, unavailableModelCatalog } from '../shared/model-catalog.js';
import { ProviderModelPicker } from '../src/model-picker.js';

const cache = {
  fetched_at: '2026-10-14T04:33:00Z',
  identity: { token: 'PRIVATE-IDENTITY' }, etag: 'PRIVATE-ETAG',
  models: [
    { slug: 'gpt-example-text', display_name: 'Example text', visibility: 'list', input_modalities: ['text'],
      model_messages: 'PRIVATE-SYSTEM-PROMPT', supported_in_api: false },
    { slug: 'gpt-example-vision', display_name: 'Example vision', visibility: 'list', input_modalities: ['text', 'image', 'audio'],
      available_access_programs: ['PRIVATE-ACCOUNT-INFO'] },
    { slug: 'reserved-model', display_name: 'Reserved', visibility: 'hide', input_modalities: ['text'] },
    { slug: 'audio-only', visibility: 'list', input_modalities: ['audio'] },
    { slug: 'gpt-example-text', visibility: 'list', input_modalities: ['image'] },
    { slug: 'sk-TESTSECRET', visibility: 'list', input_modalities: ['text'] },
    { slug: 'unsafe\nmodel', visibility: 'list', input_modalities: ['text'] },
  ],
};

test('Codex catalog uses visible cached model IDs and exposes no cache identity or prompt fields', () => {
  const catalog = modelCatalogFromCache(cache);
  assert.equal(catalog.codex.source, 'local-cache');
  assert.equal(catalog.codex.fetchedAt, '2026-10-14T04:33:00.000Z');
  assert.deepEqual(catalog.codex.models, [
    { id: 'gpt-example-text', label: 'Example text', inputModalities: ['text'] },
    { id: 'gpt-example-vision', label: 'Example vision', inputModalities: ['text', 'image'] },
  ]);
  assert.doesNotMatch(JSON.stringify(catalog), /PRIVATE-|reserved|audio-only|sk-TESTSECRET/);
  assert.equal(catalog.codex.audioSupported, false);
  assert.equal(catalog.audio.codexSupported, false);
});

test('Malformed or absent cache degrades to the CLI default, never a hardcoded OpenAI model list', async () => {
  for (const value of [null, [], { models: [] }, { models: [null, 'bad'] }, { models: Array.from({ length: 101 }, () => ({})) }]) {
    assert.deepEqual(modelCatalogFromCache(value), unavailableModelCatalog());
  }
  const directory = await mkdtemp(join(tmpdir(), 'xiangzhi-model-catalog-'));
  try {
    assert.deepEqual(await readModelCatalog({ codexHome: directory }), unavailableModelCatalog());
    await writeFile(join(directory, 'models_cache.json'), 'not-json PRIVATE-IDENTITY');
    assert.deepEqual(await readModelCatalog({ codexHome: directory }), unavailableModelCatalog());
    await writeFile(join(directory, 'models_cache.json'), JSON.stringify(cache));
    assert.deepEqual(await readModelCatalog({ codexHome: directory }), modelCatalogFromCache(cache));
    await writeFile(join(directory, 'models_cache.json'), 'x'.repeat(2 * 1024 * 1024 + 1));
    assert.deepEqual(await readModelCatalog({ codexHome: directory }), unavailableModelCatalog());
    assert.deepEqual(await readModelCatalog({ codexHome: 'relative-home' }), unavailableModelCatalog());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Provider and task determine suggestions; Codex audio and custom API never inherit Qwen presets', () => {
  const catalog = modelCatalogFromCache(cache);
  for (const role of ['reply', 'analysis', 'memory'] as const) {
    assert.deepEqual(modelOptions('codex', role, catalog).map(model => model.id), ['gpt-example-text', 'gpt-example-vision']);
    assert.ok(modelOptions('qwen', role, catalog).every(model => model.id.startsWith('qwen')));
    assert.deepEqual(modelOptions('compatible', role, catalog), []);
  }
  assert.deepEqual(modelOptions('codex', 'vision', catalog).map(model => model.id), ['gpt-example-vision']);
  assert.deepEqual(modelOptions('codex', 'audio', catalog), []);
  assert.deepEqual(modelOptions('qwen', 'audio', catalog).map(model => model.id), ['qwen3.8-omni-flash']);
  assert.deepEqual(modelOptions('compatible', 'audio', catalog), []);
  assert.deepEqual(modelOptions('codex', 'reply'), []);
});

test('Provider switching restores its own saved choice and clears the previous service model', () => {
  assert.equal(modelNameForProviderChange('qwen', 'codex', 'qwen3.8-max', 'analysis'), '');
  assert.equal(modelNameForProviderChange('codex', 'qwen', 'gpt-example-text', 'memory'), 'qwen3.8-flash');
  assert.equal(modelNameForProviderChange('qwen', 'compatible', 'qwen3.8-max', 'reply'), '');
  assert.equal(modelNameForProviderChange('compatible', 'qwen', 'custom-speech', 'audio'), 'qwen3.8-omni-flash');
  const remembered = { qwen: 'qwen3.8-max', codex: 'gpt-example-vision', compatible: 'my-custom-model' };
  assert.equal(modelNameForProviderChange('qwen', 'codex', 'qwen3.8-max', 'reply', remembered), 'gpt-example-vision');
  assert.equal(modelNameForProviderChange('codex', 'qwen', 'gpt-example-vision', 'vision', remembered), 'qwen3.8-max');
  assert.equal(modelNameForProviderChange('qwen', 'compatible', 'qwen3.8-max', 'reply', remembered), 'my-custom-model');
  assert.equal(modelNameForProviderChange('qwen', 'codex', 'qwen3.8-max', 'reply', { codex: 'qwen3.8-flash' }), '');
  assert.equal(modelNameForProviderChange('codex', 'qwen', 'gpt-example-text', 'reply', { qwen: 'gpt-example-text' }), 'qwen3.8-flash');
  assert.equal(modelNameForProviderChange('codex', 'codex', 'gpt-example-vision', 'reply'), 'gpt-example-vision');
  assert.equal(defaultModelName('codex', 'vision'), '');
});

test('The Codex picker renders an explicit default without Qwen options; compatible is a custom field', () => {
  const render = (provider: 'codex' | 'qwen' | 'compatible') => renderToStaticMarkup(createElement(ProviderModelPicker,
    { provider, role: 'analysis', label: '分析模型', value: '', onChange: () => {} }));
  const codex = render('codex');
  assert.match(codex, /Codex 默认模型/);
  assert.doesNotMatch(codex, /qwen|datalist/);
  assert.match(render('qwen'), /qwen3\.8-flash/);
  assert.doesNotMatch(render('compatible'), /qwen|datalist/);
});
