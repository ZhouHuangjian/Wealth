import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import type { MessageKind } from '../shared/types.js';
import {parseEmojiText} from '../shared/emoji.js';
import {wechatEmojiMetadata} from './emoji-metadata.js';

export interface WechatRecord {
  id: string; sortSeq: string; sentAt: string | null; role: 'self' | 'peer' | 'system';
  kind: MessageKind; text: string; mediaStatus?: 'pending';
  wechatImage?: {localId?: string; md5?: string};
  wechatEmoji?: {localId?: string; md5?: string};
  emojiRecognition?: ReturnType<typeof parseEmojiText>;
}
export interface WechatPage { records: WechatRecord[]; hasMore: boolean; accountFingerprint: string }
export interface WechatContactsPage { contacts: {externalId: string; name: string}[]; hasMore: boolean }
export type WechatContactSearch = (query: string, signal?: AbortSignal) => Promise<WechatContactsPage>;
export type WechatQuery = (input: {
  contact: string; after?: string; since?: number; limit: number; offset?: number; order: 'asc' | 'desc';
}, signal?: AbortSignal) => Promise<WechatPage>;

const DEFAULT_BIN = '/Applications/WeChatExporter.app/Contents/Resources/wx-cli';
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const TIMEOUT_MS = 20_000;
const INVALID = '微信查询结果格式不完整或不匹配，未接收本批消息。';
const FAILED = '微信消息读取失败，请在本机检查微信、导出器与已有密钥状态。';
const contactPattern = /^(?!-)[A-Za-z0-9_@.-]{1,200}$/;
const positiveInteger = /^[1-9][0-9]{0,29}$/;
const unsignedInteger = /^(?:0|[1-9][0-9]{0,29})$/;

function executable(): string {
  const configured = process.env.XIANZHI_WECHAT_BIN;
  if (configured && (!isAbsolute(configured) || configured.includes('\0'))) {
    throw new Error('XIANZHI_WECHAT_BIN 必须是管理员配置的可执行文件绝对路径。');
  }
  return configured || DEFAULT_BIN;
}

export function inspectWechat(): {available: boolean; message: string} {
  try {
    const path = executable();
    if (!statSync(path).isFile()) throw new Error();
    accessSync(path, constants.X_OK);
    return {available: true, message: '已检测到微信查询工具；尚未验证已有密钥和当前会话读取。'};
  } catch {
    return {available: false, message: '未检测到可执行的微信查询工具，请检查本机 WeChatExporter 安装或管理员路径配置。'};
  }
}

// Quote integer tokens before JSON.parse: server_id and sort_seq can exceed
// Number.MAX_SAFE_INTEGER. This scanner never touches numbers inside strings.
function parseLosslessJson(source: string): unknown {
  let result = '';
  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (char === '"') {
      const start = index++;
      let closed = false;
      while (index < source.length) {
        if (source[index] === '\\') { index += 2; continue; }
        if (source[index++] === '"') { closed = true; break; }
      }
      if (!closed) throw new Error(INVALID);
      result += source.slice(start, index);
    } else if (char === '-' || /[0-9]/.test(char)) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(index));
      if (!match) throw new Error(INVALID);
      const next = source[index + match[0].length];
      if (next !== undefined && !/[\s,}\]]/.test(next)) throw new Error(INVALID);
      result += /^-?[0-9]+$/.test(match[0]) ? JSON.stringify(match[0]) : match[0];
      index += match[0].length;
    } else { result += char; index++; }
  }
  return JSON.parse(result);
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(INVALID);
  return value as Record<string, unknown>;
}

function decimal(value: unknown, positive = false): string {
  if (typeof value !== 'string' || !(positive ? positiveInteger : unsignedInteger).test(value)) throw new Error(INVALID);
  return value;
}

function timestamp(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const seconds = Number(decimal(value));
  if (!Number.isSafeInteger(seconds) || seconds > 253402300799) throw new Error(INVALID);
  return new Date(seconds * 1000).toISOString();
}

function projectRecord(value: unknown, contact: string): WechatRecord {
  const row = object(value);
  if (row.talker !== contact || !['incoming', 'outgoing'].includes(String(row.direction))) throw new Error(INVALID);
  const sortSeq = decimal(row.sort_seq, true);
  const serverId = row.server_id === undefined || row.server_id === null ? '0' : decimal(row.server_id);
  const type = decimal(row.msg_type);
  const subType = row.sub_type === undefined ? '0' : decimal(row.sub_type);
  const record: WechatRecord = {
    id: serverId === '0' ? `seq:${sortSeq}` : serverId, sortSeq,
    sentAt: timestamp(row.create_time), role: row.direction === 'outgoing' ? 'self' : 'peer',
    kind: 'unknown', text: '[未知消息，待人工查看]', mediaStatus: 'pending',
  };
  if (type === '1') {
    const content = object(row.content);
    if (typeof content.Text !== 'string' || !content.Text.length || content.Text.length > 10_000) throw new Error(INVALID);
    record.kind = 'text'; record.text = content.Text;
    record.emojiRecognition=parseEmojiText(record.text,record.sentAt??'');
    delete record.mediaStatus;
  } else if (type === '3') {
    record.kind = 'image'; record.text = '[图片，待人工查看]';
    // Query exposes Image.md5, but current wx-cli versions omit local_id.
    // Keep only bounded identifiers; never retain the image XML or a file path.
    const image = row.content && typeof row.content === 'object' && !Array.isArray(row.content)
      ? (row.content as Record<string, unknown>).Image : undefined;
    const md5 = image && typeof image === 'object' && !Array.isArray(image)
      ? (image as Record<string, unknown>).md5 : undefined;
    const localId = typeof row.local_id === 'string' && positiveInteger.test(row.local_id) ? row.local_id : undefined;
    if (typeof md5 === 'string' && /^[a-fA-F0-9]{32}$/.test(md5)) record.wechatImage = {md5: md5.toLowerCase(), ...(localId ? {localId} : {})};
    else if (localId) record.wechatImage = {localId};
  }
  else if (type === '34') { record.kind = 'voice'; record.text = '[语音，待人工查看]'; }
  else if (type === '43' || type === '62') { record.kind = 'video'; record.text = '[视频，待人工查看]'; }
  else if (type === '47') {
    record.kind = 'emoji'; record.text = '[表情，待人工查看]';
    const localId=typeof row.local_id==='string'&&positiveInteger.test(row.local_id)?row.local_id:undefined;
    record.wechatEmoji=wechatEmojiMetadata(row.content,localId);
  }
  else if (type === '49') {
    record.kind = subType === '6' ? 'file' : 'link';
    record.text = subType === '6' ? '[文件，待人工查看]' : '[分享内容，待人工查看]';
  } else if (type === '10000' || type === '10002') {
    record.kind = 'system'; record.role = 'system'; record.text = '[系统或撤回通知，待人工查看]';
  }
  return record;
}

export function parseWechatPage(stdout: string, stderr: string, contact: string): WechatPage {
  try {
    if (typeof contact !== 'string' || !contactPattern.test(contact) || Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES
      || Buffer.byteLength(stderr) > MAX_DIAGNOSTIC_BYTES) throw new Error(INVALID);
    const accounts = [...stderr.matchAll(/^Auto-detected account: ([A-Za-z0-9_@.-]{1,200}) \(source: [^\r\n()]{1,100}\)\r?$/gm)]
      .map(match => match[1]);
    if (!accounts.length || new Set(accounts).size !== 1) throw new Error(INVALID);
    const page = object(parseLosslessJson(stdout));
    if (!Array.isArray(page.items) || page.items.length > 200) throw new Error(INVALID);
    const paging = object(page.paging);
    if (typeof paging.has_more !== 'boolean') throw new Error(INVALID);
    if (Number(decimal(paging.returned)) !== page.items.length) throw new Error(INVALID);
    if (paging.limit !== undefined && (Number(decimal(paging.limit, true)) > 200 || page.items.length > Number(paging.limit))) throw new Error(INVALID);
    if (paging.has_more && !page.items.length) throw new Error(INVALID);
    // A skipped row could otherwise be permanently hidden behind an advanced
    // cursor. Stop the batch until the caller can inspect/retry that condition.
    const stats = object(page.stats);
    if (decimal(stats.skipped) !== '0') throw new Error(INVALID);
    return {
      records: page.items.map(item => projectRecord(item, contact)), hasMore: paging.has_more,
      accountFingerprint: createHash('sha256').update(`wechat-account:${accounts[0]}`).digest('hex'),
    };
  } catch { throw new Error(INVALID); }
}

function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATHEXT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export const queryWechat: WechatQuery = async (input, signal) => {
  if (typeof input.contact !== 'string' || !contactPattern.test(input.contact) || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200
    || !['asc', 'desc'].includes(input.order) || (input.after !== undefined && (typeof input.after !== 'string' || !unsignedInteger.test(input.after)))
    || (input.since !== undefined && (!Number.isSafeInteger(input.since) || input.since < 0))
    || (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0))) {
    throw new Error('微信查询参数无效，请使用准确的会话 ID 和有效分页范围。');
  }
  if (signal?.aborted) throw new Error('微信消息读取已取消。');
  const args = ['query', input.contact, '--no-server', '--format', 'json', '--limit', String(input.limit),
    '--offset', String(input.offset ?? 0), '--order', input.order];
  if (input.after !== undefined) args.push('--after-sort-seq', input.after);
  if (input.since !== undefined) args.push('--since', String(input.since));
  const {stdout, stderr} = await runWechat(args, signal);
  return parseWechatPage(stdout, stderr, input.contact);
};

export function parseWechatContacts(stdout: string): WechatContactsPage {
  try {
    if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) throw new Error(INVALID);
    const page = object(parseLosslessJson(stdout));
    const paging = object(page.paging);
    if (!Array.isArray(page.items) || page.items.length > 50 || typeof paging.has_more !== 'boolean'
      || Number(decimal(paging.returned)) !== page.items.length) throw new Error(INVALID);
    if (decimal(object(page.stats).skipped) !== '0') throw new Error(INVALID);
    const contacts = page.items.map(item => {
      const row = object(item);
      if (typeof row.user_name !== 'string' || !contactPattern.test(row.user_name)) throw new Error(INVALID);
      const name = [row.remark, row.nick_name, row.alias, row.user_name]
        .find(value => typeof value === 'string' && value.trim()) as string;
      return {externalId: row.user_name, name: name.trim().slice(0, 80)};
    });
    return {contacts, hasMore: paging.has_more};
  } catch { throw new Error('微信联系人列表格式不完整，请稍后重试或手动填写会话 ID。'); }
}

export const searchWechatContacts: WechatContactSearch = async (query, signal) => {
  if (typeof query !== 'string' || !query.trim() || query.length > 100 || /[\u0000-\u001f]/.test(query)) {
    throw new Error('请输入 1 至 100 字的联系人搜索词。');
  }
  const {stdout} = await runWechat(['contacts', '--search', query.trim(), '--limit', '50', '--offset', '0', '--format', 'json', '--no-server'], signal);
  return parseWechatContacts(stdout);
};

/** Internal CLI transport shared with bounded, single-file media reads. */
export function runWechat(args: string[], signal?: AbortSignal): Promise<{stdout: string; stderr: string}> {
  if (signal?.aborted) return Promise.reject(new Error('微信消息读取已取消。'));
  const command = executable();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd: tmpdir(), env: childEnvironment(), shell: false,
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true});
    let stdout = ''; let stderr = ''; let bytes = 0; let diagnosticBytes = 0;
    let failure: Error | null = null; let finished = false; let escalation: NodeJS.Timeout | undefined;
    const kill = (termination: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, termination);
        else child.kill(termination);
      } catch { /* The process may have exited before cleanup. */ }
    };
    const fail = (error: Error) => {
      if (failure || finished) return;
      failure = error; kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), 250);
    };
    const abort = () => fail(new Error('微信消息读取已取消。'));
    const timer = setTimeout(() => fail(new Error('微信消息读取超过 20 秒，已终止；可稍后重试。')), TIMEOUT_MS);
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (failure) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) { fail(new Error('微信查询结果超过 2 MiB，已终止；请减少每批消息数。')); return; }
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (failure) return;
      diagnosticBytes += Buffer.byteLength(chunk);
      if (diagnosticBytes > MAX_DIAGNOSTIC_BYTES) { fail(new Error('微信查询诊断输出过多，已终止。')); return; }
      stderr += chunk;
    });
    child.on('error', () => fail(new Error('无法启动微信查询工具，请检查本机安装和可执行文件配置。')));
    child.on('close', code => {
      finished = true;
      if (process.platform !== 'win32') kill('SIGKILL');
      clearTimeout(timer); if (escalation) clearTimeout(escalation);
      signal?.removeEventListener('abort', abort);
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new Error(FAILED)); return; }
      resolve({stdout, stderr});
    });
  });
}
