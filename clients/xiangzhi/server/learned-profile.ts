import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { LearnedProfile } from '../shared/types.js';

const MAX_PROFILE_BYTES = 1_000_000;
const MAX_SUMMARY_BYTES = 256_000;
const SUMMARY_PATHS = ['reply-tests/round01/round01-summary.json', 'reply-tests/round02/round02-summary.json'];
const INVALID_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('画像文件结构无效。');
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || INVALID_CONTROL.test(value)) {
    throw new Error('画像字段为空、过长或包含无效字符。');
  }
  return value.trim();
}

function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('画像列表格式无效或超出数量限制。');
  return value;
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function readJson(root: string, name: string, maxBytes: number): Record<string, unknown> {
  if (isAbsolute(name) || name.includes('\\') || name.split('/').some(part => part === '..' || part === '.') || !name.endsWith('.json')) {
    throw new Error('画像路径必须是学习目录内的 JSON 文件。');
  }
  const target = realpathSync(resolve(root, name));
  if (!isWithin(root, target)) throw new Error('画像文件路径越出学习目录。');
  const fd = openSync(target, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('画像文件不是普通文件或超过大小限制。');
    const content = readFileSync(fd);
    if (content.byteLength > maxBytes) throw new Error('画像文件超过大小限制。');
    return object(JSON.parse(content.toString('utf8')));
  } finally { closeSync(fd); }
}

/** Read only a bounded style projection; source reports and relationship tables never leave this loader. */
export function loadLearnedProfile(manifestPath: string): {profile: LearnedProfile | null; error: string | null} {
  try {
    const absolute = resolve(manifestPath);
    const root = realpathSync(dirname(absolute));
    const manifest = readJson(root, basename(absolute), 8_192);
    const profilePath = text(manifest.path, 240);
    const version = text(manifest.version, 32);
    if (!/^\d+(?:\.\d+){1,3}$/.test(version)) throw new Error('画像版本格式无效。');
    const source = readJson(root, profilePath, MAX_PROFILE_BYTES);
    if (source.schema_version !== version) throw new Error('画像版本与当前版本清单不一致。');
    const relations = object(source.relationship_annotations);
    const names = Object.keys(relations);
    if (names.length > 200 || names.some(name => !name || name.length > 80)) throw new Error('画像联系人标注格式无效。');
    names.sort((a, b) => b.length - a.length);
    const clean = (value: unknown, max: number): string => {
      let result = text(value, max);
      for (const name of names) result = result.split(name).join('[联系人]');
      return result
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已隐藏]')
        .replace(/(?<!\d)(?:\d{17}[\dXx]|\d{15})(?!\d)/g, '[证件号已隐藏]')
        .replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g, '[手机号已隐藏]')
        .replace(/(?:\/(?:Users|home|private|var)\/|[A-Z]:\\)[^\s，。；“”"']+/gi, '[路径已隐藏]');
    };
    const rules = array(source.calibrated_working_rules, 40).map(value => {
      const rule = object(value);
      const id = text(rule.id, 32);
      if (!/^[A-Z]\d+$/.test(id)) throw new Error('画像规则编号无效。');
      return {id, rule: clean(rule.rule, 1_200), limitation: clean(rule.status, 600),
        evidenceIds: array(rule.evidence, 32).map(value => {
          const evidence = text(value, 80);
          if (!/^T\d+(?::[A-Za-z0-9_=]+)?$/.test(evidence)) throw new Error('画像证据编号无效。');
          return evidence;
        })};
    });
    if (!rules.length || new Set(rules.map(rule => rule.id)).size !== rules.length) throw new Error('画像没有可用规则或规则编号重复。');

    const summaries = SUMMARY_PATHS.map(path => readJson(root, path, MAX_SUMMARY_BYTES));
    const unanswered = new Set<string>();
    for (const summary of summaries) {
      for (const key of ['unanswered', 'earlier_unanswered', 'pending_feedback_ids']) {
        if (summary[key] !== undefined) for (const id of array(summary[key], 100)) unanswered.add(text(id, 32));
      }
    }
    const examples: LearnedProfile['examples'] = [];
    for (let round = 0; round < summaries.length; round++) {
      for (const value of array(summaries[round].feedback_records, 100)) {
        const record = object(value);
        const id = text(record.test_id, 32);
        if (!/^T\d+$/.test(id)) throw new Error('画像示例编号无效。');
        if (unanswered.has(id)) continue;
        let feedbackType: LearnedProfile['examples'][number]['feedbackType'];
        let reply: unknown;
        if (round === 0 && record.feedback_type === 'pairwise_choice' && ['A', 'B'].includes(String(record.label))) {
          feedbackType = 'choice'; reply = record.preferred_reply;
        } else if (round === 0 && record.feedback_type === 'user_rewrite') {
          feedbackType = 'rewrite'; reply = record.preferred_reply;
        } else if (round === 0 && record.feedback_type === 'single_reply_style_check' && record.style_match === true) {
          feedbackType = 'retained'; reply = record.preferred_reply;
        } else if (round === 1 && record.feedback_type === 'rewritten') {
          feedbackType = 'rewrite'; reply = record.user_reply;
        } else if (round === 1 && record.feedback_type === 'kept_as_is') {
          feedbackType = 'retained'; reply = record.user_reply;
        } else continue;
        const parts = array(reply, 4).map(part => clean(part, 500));
        if (!parts.length || parts.join('\n').length > 1_000) throw new Error('画像示例回复为空或过长。');
        examples.push({id, situation: clean(record.category, 120), reply: parts.join('\n'), feedbackType});
      }
    }
    if (!examples.length || examples.length > 40 || new Set(examples.map(example => example.id)).size !== examples.length) {
      throw new Error('画像没有已确认示例，或示例数量、编号无效。');
    }
    const projected = {version, title: clean(source.title, 120), rules, examples, limitations: [
      '规则是有限场景下的表达偏好，不是人格诊断；先判断回应方向，再选择措辞。',
      '示例只用于理解语气和回应方式，不代表当前会话中的事实、共同经历或已作出的承诺；不能照搬情境。',
      '用户选择、原样认可和改写不等于发送许可；未训练模型参数，尚未证明独立泛化或关系效果。',
    ]};
    return {profile: {...projected, digest: createHash('sha256').update(JSON.stringify(projected)).digest('hex'), loadedAt: new Date().toISOString()}, error: null};
  } catch (error) {
    // Native file and JSON errors can contain private paths or text, so expose only a bounded diagnosis.
    const code = (error as NodeJS.ErrnoException).code;
    const detail = code === 'ENOENT' ? '当前画像或测试总结文件不存在。'
      : code === 'EACCES' || code === 'EPERM' ? '没有读取学习文件的权限。'
        : error instanceof SyntaxError ? '学习文件不是有效 JSON。'
          : error instanceof Error && /^画像/.test(error.message) ? error.message : '学习文件无法读取或结构无效。';
    return {profile: null, error: `个人习惯档案未加载：${detail}`};
  }
}
