import test from 'node:test';
import assert from 'node:assert/strict';
import type { Settings, VisionSettings } from '../shared/types.js';
import { recognizeImage } from '../server/image-recognition.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+l8lsAAAAASUVORK5CYII=', 'base64');
const observation = {summary: '白底红色圆形', visibleText: '测试文字', facts: ['有一个圆形']};
function settings(vision: Partial<VisionSettings> = {}): Settings {
  return {provider: 'compatible', modelPreset: 'qwen', modelName: 'qwen3.8-max',
    modelUrl: 'https://test-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', apiKey: 'TEST-REPLY-KEY', allowRemoteModel: true,
    autoReplyEnabled: false, autoReplyMode: 'draft', replyDelaySeconds: 0, cooldownSeconds: 0, dailyLimit: 20,
    quietHoursEnabled: false, quietStart: '23:00', quietEnd: '08:00',
    vision: {provider: 'qwen', modelName: 'qwen3.8-flash', modelUrl: 'https://test-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      useReplyApiKey: true, allowRemoteModel: true, ...vision}};
}
function response(content = JSON.stringify(observation)): Response {
  return Response.json({choices: [{message: {content}}], usage: {prompt_tokens: 12, completion_tokens: 8, total_tokens: 20}});
}

test('Qwen image recognition uses its selected model, data URL and bounded structured observations', async () => {
  let request: {url: string; init: RequestInit; body: any} | undefined;
  const config = settings();
  const result = await recognizeImage(config, {bytes: png, mimeType: 'image/png'}, undefined, {fetch: async (url, init) => {
    request = {url: String(url), init: init!, body: JSON.parse(init!.body as string)}; return response();
  }});
  assert.equal(request!.body.model, 'qwen3.8-flash'); assert.equal(config.modelName, 'qwen3.8-max');
  assert.equal(request!.body.enable_thinking, false); assert.equal(request!.body.stream, false);
  assert.equal(request!.init.redirect, 'error');
  assert.equal((request!.init.headers as any).Authorization, 'Bearer TEST-REPLY-KEY');
  assert.equal(request!.body.messages[1].content[0].image_url.url, `data:image/png;base64,${png.toString('base64')}`);
  assert.match(request!.body.messages[0].content, /不可信数据/); assert.match(request!.body.messages[0].content, /不猜测/);
  assert.deepEqual(result.facts, ['有一个圆形']); assert.equal(result.provider, 'qwen'); assert.equal(result.modelName, 'qwen3.8-flash');
  assert.deepEqual(result.usage, {promptTokens: 12, completionTokens: 8, totalTokens: 20});
  assert.ok(!JSON.stringify(request!.body).includes('TEST-REPLY-KEY'));
});

test('image key reuse refuses any different validated origin before sending credentials', async () => {
  let calls = 0;
  const dependencies = {fetch: async () => {calls++; return response();}};
  for (const url of ['https://another.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'https://custom.example/v1',
    'https://test-workspace.cn-beijing.maas.aliyuncs.com:8443/compatible-mode/v1']) {
    await assert.rejects(recognizeImage(settings({provider: 'compatible', modelUrl: url}), {bytes: png, mimeType: 'image/png'}, undefined, dependencies), /完全相同的来源/);
  }
  const config = settings({provider: 'compatible', modelUrl: 'https://custom.example/v1', useReplyApiKey: false, apiKey: 'TEST-VISION-KEY'});
  await recognizeImage(config, {bytes: png, mimeType: 'image/png'}, undefined, {fetch: async (_url, init) => {
    assert.equal((init!.headers as any).Authorization, 'Bearer TEST-VISION-KEY'); return response();
  }});
  assert.equal(calls, 0);
});

test('image validation, disabled recognition and remote permission fail before transport', async () => {
  let calls = 0;
  const dependencies = {fetch: async () => {calls++; return response();}};
  await assert.rejects(recognizeImage(settings({provider: 'disabled'}), {bytes: png, mimeType: 'image/png'}, undefined, dependencies), /开启/);
  await assert.rejects(recognizeImage(settings({allowRemoteModel: false}), {bytes: png, mimeType: 'image/png'}, undefined, dependencies), /远程处理/);
  await assert.rejects(recognizeImage(settings(), {bytes: Buffer.from('not-png'), mimeType: 'image/png'}, undefined, dependencies), /内容与类型一致/);
  await assert.rejects(recognizeImage(settings(), {bytes: Buffer.alloc(5 * 1024 * 1024 + 1), mimeType: 'image/png'}, undefined, dependencies), /5 MB/);
  await assert.rejects(recognizeImage(settings(), {bytes: png, mimeType: 'image/png'}, AbortSignal.abort(), dependencies), /取消/);
  assert.equal(calls, 0);
});

test('image failures never expose upstream errors, prompt echo or credentials and reject malformed output', async () => {
  const image = {bytes: png, mimeType: 'image/png'};
  const invalid = ['private prompt echo', JSON.stringify({...observation, facts: 'invalid'}),
    JSON.stringify({...observation, visibleText: 'x'.repeat(4001)}), JSON.stringify({...observation, summary: ''})];
  for (const content of invalid) await assert.rejects(recognizeImage(settings(), image, undefined, {fetch: async () => response(content)}), /JSON|字段/);
  await assert.rejects(recognizeImage(settings(), image, undefined, {fetch: async () => new Response('TEST-REPLY-KEY private prompt', {status: 401})}),
    error => error instanceof Error && /HTTP 401/.test(error.message) && !/TEST|private/.test(error.message));
  await assert.rejects(recognizeImage(settings(), image, undefined, {fetch: async () => {throw new Error('TEST-REPLY-KEY private prompt');}}),
    error => error instanceof Error && /无法连接/.test(error.message) && !/TEST|private/.test(error.message));
  await assert.rejects(recognizeImage(settings(), image, undefined, {fetch: async () => new Response('x'.repeat(128_001))}), /响应过大/);
});

test('Codex image recognition uses independent permission and model without sending the HTTP API key in the prompt', async () => {
  const config = settings({provider: 'codex', modelName: 'selected-codex-model', useReplyApiKey: false});
  config.allowRemoteModel = false;
  let calls = 0;
  const result = await recognizeImage(config, {bytes: png, mimeType: 'image/png'}, undefined, {codex: async (chosen, messages, image) => {
    calls++; assert.equal(chosen.modelName, 'selected-codex-model'); assert.equal(chosen.allowRemoteModel, true);
    assert.deepEqual(image.bytes, png); assert.ok(!JSON.stringify(messages).includes('TEST-REPLY-KEY')); return JSON.stringify(observation);
  }});
  assert.equal(result.provider, 'codex'); assert.equal(result.modelName, 'selected-codex-model'); assert.equal(calls, 1);
  config.vision!.allowRemoteModel = false;
  await assert.rejects(recognizeImage(config, {bytes: png, mimeType: 'image/png'}), /允许图片远程处理/);
});

test('image cancellation aborts the provider response and rejects an otherwise valid delayed result', async () => {
  const controller = new AbortController();
  let observed: AbortSignal | undefined;
  const pending = recognizeImage(settings(), {bytes: png, mimeType: 'image/png'}, controller.signal, {fetch: async (_url, init) => {
    observed = init!.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => observed!.addEventListener('abort', () => reject(new Error('private abort reason')), {once: true}));
  }});
  controller.abort(); await assert.rejects(pending, /取消/); assert.equal(observed!.aborted, true);
});
