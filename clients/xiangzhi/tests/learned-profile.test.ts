import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLearnedProfile } from '../server/learned-profile.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'xiangzhi-profile-test-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const put = (path: string, data: unknown) => writeFileSync(join(root, path), JSON.stringify(data), {mode: 0o600});
  mkdirSync(join(root, 'reply-tests/round01'), {recursive: true});
  mkdirSync(join(root, 'reply-tests/round02'), {recursive: true});
  const source = {
    schema_version: '1.8', title: '表达档案', relationship_annotations: {'甲同事': '同事', '乙朋友': '朋友'},
    calibrated_working_rules: [{id: 'C1', rule: '甲同事的例子只供表达参考', status: '乙朋友的单题反馈，待验证', evidence: ['T01:A']},
      {id: 'C17', rule: '事实不明时先确认，不把未提供当成未发生', status: '有限情境偏好', evidence: ['T30:user_rewrite', 'T30:explicit_clarification']}],
    raw_report: '绝不能发送的完整报告', evidence_files: ['/Users/private/raw-chat.json'],
  };
  const round01 = {unanswered: ['T06'], feedback_records: [
    {test_id: 'T01', category: '回应日常信息', feedback_type: 'pairwise_choice', label: 'A', preferred_reply: ['甲同事，我看看'], raw_context: '私人上下文'},
    {test_id: 'T06', category: '图片缺失', feedback_type: 'pairwise_choice', label: 'A', preferred_reply: ['未评分答案不应采纳']},
    {test_id: 'T14', category: '图书馆合成安排', feedback_type: 'user_rewrite', preferred_reply: ['那就去图书馆的二层阅览室吧']},
    {test_id: 'T18', category: '临时取消安排', feedback_type: 'single_reply_style_check', style_match: true, preferred_reply: ['行，那你先忙']},
    {test_id: 'T19', category: '没有认可的单句', feedback_type: 'single_reply_style_check', style_match: false, preferred_reply: ['不应使用']},
  ]};
  const round02 = {feedback_records: [
    {test_id: 'T25', category: '生活便利', feedback_type: 'kept_as_is', user_reply: ['那方便多了'], draft: ['那方便多了']},
    {test_id: 'T30', category: '核实图书馆预约', feedback_type: 'rewritten', user_reply: ['图书馆的预约已经确认了吗'], draft: ['我再预订一间阅览室'],
      clarification: {semantic_intent: 'confirmation_question', approval_fact_supplied: false}},
    {test_id: 'T31', category: '未反馈', feedback_type: 'pending', draft: ['不能将AI草稿视为偏好']},
  ]};
  put('current-profile.json', {path: 'profile-v1.8.json', version: '1.8'});
  put('profile-v1.8.json', source);
  put('reply-tests/round01/round01-summary.json', round01);
  put('reply-tests/round02/round02-summary.json', round02);
  return {root, put, source, round01, round02, manifest: join(root, 'current-profile.json')};
}

test('v1.8 loader projects only bounded rules and explicitly confirmed choices, rewrites and retained replies', t => {
  const {manifest} = fixture(t);
  const {profile, error} = loadLearnedProfile(manifest);
  assert.equal(error, null); assert.ok(profile);
  assert.equal(profile.version, '1.8'); assert.match(profile.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(profile.examples.map(example => [example.id, example.feedbackType]), [
    ['T01', 'choice'], ['T14', 'rewrite'], ['T18', 'retained'], ['T25', 'retained'], ['T30', 'rewrite'],
  ]);
  assert.equal(profile.examples.at(-1)?.reply, '图书馆的预约已经确认了吗');
  const serialized = JSON.stringify(profile);
  for (const excluded of ['甲同事', '乙朋友', 'raw_report', 'relationship_annotations', '私人上下文', '/Users/',
    '我再预订一间阅览室', '未评分答案不应采纳', '不应使用', '不能将AI草稿视为偏好']) assert.ok(!serialized.includes(excluded), excluded);
  assert.ok(serialized.includes('[联系人]'));
  assert.equal(loadLearnedProfile(manifest).profile?.digest, profile.digest, 'load timestamp does not alter content digest');
});

test('missing, malformed, inconsistent or incomplete files report failure without leaking file paths or contents', t => {
  const {manifest, root, put, source} = fixture(t);
  const missing = loadLearnedProfile(join(root, 'missing.json'));
  assert.equal(missing.profile, null); assert.match(missing.error!, /不存在/); assert.ok(!missing.error!.includes(root));
  writeFileSync(join(root, 'profile-v1.8.json'), '{"raw_private_message":');
  const malformed = loadLearnedProfile(manifest);
  assert.equal(malformed.profile, null); assert.match(malformed.error!, /JSON/); assert.ok(!malformed.error!.includes('raw_private_message'));
  put('profile-v1.8.json', {...source, schema_version: '1.7'});
  assert.match(loadLearnedProfile(manifest).error!, /版本.*不一致/);
  put('profile-v1.8.json', source);
  rmSync(join(root, 'reply-tests/round02/round02-summary.json'));
  assert.equal(loadLearnedProfile(manifest).profile, null, 'never claim full profile loaded with missing calibration summary');
});

test('path traversal, absolute profile paths and symlink escapes are rejected', t => {
  const {manifest, root, put} = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'xiangzhi-outside-test-'));
  t.after(() => rmSync(outside, {recursive: true, force: true}));
  const target = join(outside, 'private.json'); writeFileSync(target, '{}');
  for (const path of ['../private.json', target, 'folder/../../private.json']) {
    put('current-profile.json', {path, version: '1.8'});
    const result = loadLearnedProfile(manifest); assert.equal(result.profile, null); assert.match(result.error!, /路径/);
  }
  symlinkSync(target, join(root, 'escape.json'));
  put('current-profile.json', {path: 'escape.json', version: '1.8'});
  assert.match(loadLearnedProfile(manifest).error!, /越出/);
  put('current-profile.json', {path: 'profile-v1.8.json', version: '1.8'});
  rmSync(join(root, 'reply-tests/round01/round01-summary.json'));
  symlinkSync(target, join(root, 'reply-tests/round01/round01-summary.json'));
  assert.match(loadLearnedProfile(manifest).error!, /越出/);
});

test('file sizes, selected field lengths, evidence IDs and duplicate examples have finite validation', t => {
  const {manifest, root, put, source, round02} = fixture(t);
  writeFileSync(join(root, 'profile-v1.8.json'), ' '.repeat(1_000_001));
  assert.match(loadLearnedProfile(manifest).error!, /大小/);
  put('profile-v1.8.json', {...source, calibrated_working_rules: [{...source.calibrated_working_rules[0], rule: '长'.repeat(1201)}]});
  assert.match(loadLearnedProfile(manifest).error!, /过长/);
  put('profile-v1.8.json', {...source, calibrated_working_rules: [{...source.calibrated_working_rules[0], evidence: ['/Users/private']}]});
  assert.match(loadLearnedProfile(manifest).error!, /证据编号/);
  put('profile-v1.8.json', source);
  put('reply-tests/round02/round02-summary.json', {feedback_records: [...round02.feedback_records, round02.feedback_records[0]]});
  assert.match(loadLearnedProfile(manifest).error!, /编号无效/);
});
