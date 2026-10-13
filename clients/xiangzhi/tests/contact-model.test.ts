import test from 'node:test';
import assert from 'node:assert/strict';
import type { Settings, VisionSettings } from '../shared/types.js';
import { contactModelCompletion, contactModelIdentity } from '../server/contact-model.js';

const endpoint = 'https://synthetic-space.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
const settings: Settings = {provider: 'compatible', modelPreset: 'qwen', modelName: 'qwen-reply-test',
  modelUrl: endpoint, apiKey: 'TEST-REPLY-KEY', allowRemoteModel: true,
  autoReplyEnabled: false, autoReplyMode: 'draft', replyDelaySeconds: 0, cooldownSeconds: 0, dailyLimit: 20,
  quietHoursEnabled: false, quietStart: '23:00', quietEnd: '08:00'};
const config: VisionSettings = {provider: 'qwen', modelName: 'qwen-analysis-test', modelUrl: endpoint,
  useReplyApiKey: true, allowRemoteModel: true};
const messages = [{role: 'system', content: '只返回 JSON。'}, {role: 'user', content: '合成测试'}];
const schema = {type: 'object', additionalProperties: false, required: ['ok'], properties: {ok: {type: 'boolean'}}};
const response = () => Response.json({choices: [{message: {content: '{"ok":true}'}}],
  usage: {prompt_tokens: 1, completion_tokens: 2, total_tokens: 3}});

test('contact model uses independently selected Qwen model and does not place keys in prompts', async () => {
  const result = await contactModelCompletion(settings, config, messages, schema, '意图分析', undefined, {fetch: async (url, init) => {
    assert.equal(String(url), `${endpoint}/chat/completions`);
    const body = JSON.parse(String(init!.body));
    assert.equal(body.model, 'qwen-analysis-test'); assert.equal(body.stream, false); assert.equal(body.enable_thinking, false);
    assert.equal(init!.redirect, 'error'); assert.equal((init!.headers as any).Authorization, 'Bearer TEST-REPLY-KEY');
    assert.doesNotMatch(JSON.stringify(body), /TEST-REPLY-KEY/); return response();
  }});
  assert.equal(result.content, '{"ok":true}'); assert.deepEqual(result.usage, {promptTokens: 1, completionTokens: 2, totalTokens: 3});
  assert.equal(result.modelName, 'qwen-analysis-test'); assert.equal(settings.modelName, 'qwen-reply-test');
});

test('contact model permits independent credentials but never reuses keys across origins', async () => {
  let calls = 0;
  const dependencies = {fetch: async () => { calls++; return response(); }};
  await assert.rejects(contactModelCompletion(settings, {...config, modelUrl: 'https://another.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'},
    messages, schema, '分析', undefined, dependencies), /完全相同的来源/);
  assert.equal(calls, 0);
  await contactModelCompletion(settings, {...config, provider: 'compatible', modelUrl: 'https://custom.test/v1',
    useReplyApiKey: false, apiKey: 'TEST-INDEPENDENT-KEY'}, messages, schema, '分析', undefined, {fetch: async (_url, init) => {
    assert.equal((init!.headers as any).Authorization, 'Bearer TEST-INDEPENDENT-KEY'); return response();
  }});
});

test('contact model disabled, remote permission and unsafe endpoints are checked before transport', async () => {
  let calls = 0;
  const dependencies = {fetch: async () => {calls++; return response();}};
  await assert.rejects(contactModelCompletion(settings, undefined, messages, schema, '分析', undefined, dependencies), /配置并开启/);
  await assert.rejects(contactModelCompletion(settings, {...config, provider: 'disabled'}, messages, schema, '分析', undefined, dependencies), /配置并开启/);
  await assert.rejects(contactModelCompletion(settings, {...config, allowRemoteModel: false}, messages, schema, '分析', undefined, dependencies), /远程模型/);
  await assert.rejects(contactModelCompletion(settings, {...config, modelUrl: 'https://attacker.test/compatible-mode/v1'}, messages, schema, '分析', undefined, dependencies), /官方/);
  await assert.rejects(contactModelCompletion(settings, {...config, modelName: '\n'}, messages, schema, '分析', undefined, dependencies), /有效的模型/);
  assert.equal(calls, 0);
});

test('contact model keeps upstream secrets out of errors and rejects tool and oversized responses', async () => {
  for (const fetch of [async () => {throw new Error('PRIVATE-PROMPT TEST-REPLY-KEY');},
    async () => new Response('PRIVATE-PROMPT TEST-REPLY-KEY', {status: 401})]) {
    await assert.rejects(contactModelCompletion(settings, config, messages, schema, '分析', undefined, {fetch}), error => {
      assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /PRIVATE|TEST-REPLY-KEY/); return true;
    });
  }
  await assert.rejects(contactModelCompletion(settings, config, messages, schema, '分析', undefined,
    {fetch: async () => Response.json({choices: [{message: {content: '{"ok":true}', tool_calls: [{id: 'do-not-run'}]}}]})}), /纯文本/);
  await assert.rejects(contactModelCompletion(settings, config, messages, schema, '分析', undefined,
    {fetch: async () => new Response('x'.repeat(128_001))}), /响应过大/);
});

test('contact model Codex accepts fixed feature schema and independent model with remote permission', async () => {
  const result = await contactModelCompletion(settings, {...config, provider: 'codex', modelName: 'codex-analysis-test'},
    messages, schema, '分析', undefined, {codex: async (chosen, prompt, selected, signal) => {
      assert.equal(chosen.provider, 'codex'); assert.equal(chosen.modelName, 'codex-analysis-test');
      assert.equal(chosen.allowRemoteModel, true); assert.deepEqual(prompt, messages); assert.deepEqual(selected, schema);
      assert.doesNotMatch(JSON.stringify(prompt), /TEST-REPLY-KEY/); assert.equal(signal?.aborted, false); return '{"ok":true}';
    }});
  assert.equal(result.provider, 'codex');
  await assert.rejects(contactModelCompletion(settings, {...config, provider: 'codex', allowRemoteModel: false}, messages, schema, '分析'), /远程处理/);
});

test('contact model cancellation prevents an otherwise completed result and aborts requests', async () => {
  const controller = new AbortController();
  const pending = contactModelCompletion(settings, config, messages, schema, '分析', controller.signal, {fetch: async (_url, init) => {
    return new Promise<Response>((_resolve, reject) => (init!.signal as AbortSignal).addEventListener('abort', () => reject(new Error('PRIVATE-CANCEL')), {once: true}));
  }});
  controller.abort(); await assert.rejects(pending, /已取消/);
  await assert.rejects(contactModelCompletion(settings, config, messages, schema, '分析', AbortSignal.abort(), {fetch: async () => response()}), /已取消/);
});

test('contact model identity ignores keys but distinguishes normalized endpoint, name and thinking', () => {
  assert.equal(contactModelIdentity(config), contactModelIdentity({...config, apiKey: 'DIFFERENT-KEY'}));
  assert.notEqual(contactModelIdentity(config), contactModelIdentity({...config, modelName: 'other-model'}));
  assert.notEqual(contactModelIdentity(config), contactModelIdentity({...config, thinkingEnabled: true}));
  assert.equal(contactModelIdentity({...config, modelUrl: `${endpoint}/`}), contactModelIdentity(config));
});
