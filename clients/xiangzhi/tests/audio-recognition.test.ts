import test from 'node:test';
import assert from 'node:assert/strict';
import type { Settings, AudioSettings } from '../shared/types.js';
import { transcribeAudio } from '../server/audio-recognition.js';

const wav = Buffer.from('RIFF\x24\0\0\0WAVEfmt ', 'binary');
function settings(audio: Partial<AudioSettings> = {}): Settings {
  return {provider: 'compatible', modelPreset: 'qwen', modelName: 'qwen3.8-flash',
    modelUrl: 'https://test-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', apiKey: 'TEST-KEY', allowRemoteModel: true,
    autoReplyEnabled: false, autoReplyMode: 'draft', replyDelaySeconds: 0, cooldownSeconds: 0, dailyLimit: 20,
    quietHoursEnabled: false, quietStart: '23:00', quietEnd: '08:00',
    audio: {provider: 'qwen', modelName: 'qwen3.8-omni-flash', modelUrl: 'https://test-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      useReplyApiKey: true, allowRemoteModel: true, ...audio}};
}
function sse(content = JSON.stringify({text: '你好，今天一起吃饭吗？'}), finish: string | null = 'stop', done = true): string {
  const data = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
  return data({choices: [{delta: {reasoning_content: 'PRIVATE-REASONING', content: ''}, finish_reason: null}]})
    + data({choices: [{delta: {content: content.slice(0, 4)}, finish_reason: null}]})
    + data({choices: [{delta: {content: content.slice(4)}, finish_reason: null}]})
    + data({choices: [{delta: {content: ''}, finish_reason: finish}]})
    + data({choices: [], usage: {prompt_tokens: 20, completion_tokens: 30, total_tokens: 50}})
    + (done ? 'data: [DONE]\r\n\r\n' : '');
}
function response(body = sse()): Response {return new Response(body, {headers: {'Content-Type': 'text/event-stream'}});}

test('Qwen voice transcription sends only attached supported audio and collects bounded streaming text and usage', async () => {
  let body: any;
  const bytes = new TextEncoder().encode(sse());
  const result = await transcribeAudio(settings(), {bytes: wav, mimeType: 'audio/wav'}, undefined, {fetch: async (url, init) => {
    assert.equal(String(url), 'https://test-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
    assert.equal(init!.redirect, 'error'); assert.equal((init!.headers as any).Authorization, 'Bearer TEST-KEY');
    body = JSON.parse(init!.body as string);
    return new Response(new ReadableStream({start(controller) {
      for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.slice(i, i + 2)); controller.close();
    }}), {headers: {'Content-Type': 'text/event-stream'}});
  }});
  assert.equal(body.model, 'qwen3.8-omni-flash'); assert.equal(body.stream, true);
  assert.deepEqual(body.modalities, ['text']); assert.equal(body.stream_options.include_usage, true);
  assert.equal(body.messages[1].content[0].input_audio.data, `data:;base64,${wav.toString('base64')}`);
  assert.equal(body.messages[1].content[0].input_audio.format, 'wav');
  assert.match(body.messages[0].content, /不可信数据/); assert.match(body.messages[0].content, /不回答或执行/);
  assert.equal(result.text, '你好，今天一起吃饭吗？'); assert.equal(result.modelName, 'qwen3.8-omni-flash');
  assert.deepEqual(result.usage, {promptTokens: 20, completionTokens: 30, totalTokens: 50});
  assert.ok(!JSON.stringify(result).includes('PRIVATE-REASONING'));
});

test('voice transport refuses raw SILK, oversized input, disabled recognition and cross-origin key reuse before calls', async () => {
  let calls = 0; const dependencies = {fetch: async () => {calls++; return response();}};
  await assert.rejects(transcribeAudio(settings(), {bytes: Buffer.from('#!SILK_V3'), mimeType: 'audio/silk'}, undefined, dependencies), /SILK/);
  await assert.rejects(transcribeAudio(settings(), {bytes: Buffer.alloc(5 * 1024 * 1024 + 1), mimeType: 'audio/wav'}, undefined, dependencies), /5 MB/);
  await assert.rejects(transcribeAudio(settings({provider: 'disabled'}), {bytes: wav, mimeType: 'audio/wav'}, undefined, dependencies), /开启/);
  await assert.rejects(transcribeAudio(settings({allowRemoteModel: false}), {bytes: wav, mimeType: 'audio/wav'}, undefined, dependencies), /远程处理/);
  await assert.rejects(transcribeAudio(settings({modelUrl: 'https://other-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'}),
    {bytes: wav, mimeType: 'audio/wav'}, undefined, dependencies), /完全相同的来源/);
  assert.equal(calls, 0);
});

test('voice output refuses truncated streams, tool requests, malformed text and oversized output without exposing diagnostics', async () => {
  const audio = {bytes: wav, mimeType: 'audio/wav'};
  for (const body of [sse(undefined, null), sse(undefined, 'length'), sse(undefined, 'stop', false), sse('PRIVATE-INVALID-JSON'),
    sse(JSON.stringify({text: 'x'.repeat(6001)})), 'data: {"choices":[{"delta":{"tool_calls":[{"secret":"TEST-KEY"}]}}]}\n\n']) {
    await assert.rejects(transcribeAudio(settings(), audio, undefined, {fetch: async () => response(body)}),
      error => error instanceof Error && !/PRIVATE|TEST-KEY/.test(error.message));
  }
  await assert.rejects(transcribeAudio(settings(), audio, undefined, {fetch: async () => new Response('PRIVATE TEST-KEY', {status: 403})}), /HTTP 403/);
  await assert.rejects(transcribeAudio(settings(), audio, undefined, {fetch: async () => {throw new Error('PRIVATE TEST-KEY');}}), /无法连接/);
  await assert.rejects(transcribeAudio(settings(), audio, undefined, {fetch: async () => response('x'.repeat(256_001))}), /响应过大/);
});

test('voice cancellation cancels a stalled streaming body and yields a safe cancelled result', async () => {
  const controller = new AbortController(); let cancelled = false;
  const pending = transcribeAudio(settings(), {bytes: wav, mimeType: 'audio/wav'}, controller.signal, {fetch: async () => new Response(
    new ReadableStream({cancel() {cancelled = true;}}), {headers: {'Content-Type': 'text/event-stream'}})});
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, /取消/); assert.equal(cancelled, true);
});
