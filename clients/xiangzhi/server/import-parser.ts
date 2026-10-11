import { createHash } from 'node:crypto';
import type { ImportInput, ImportPreview } from '../shared/types.js';

type RecordValue = Record<string, unknown>;
type ParsedMessage = ImportPreview['messages'][number] & { aiAssisted: boolean };
export interface ParsedImport extends Omit<ImportPreview, 'messages'> {
  messages: ParsedMessage[];
  conversationKey: string;
}
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_MESSAGES = 5000;
const MAX_TEXT = 10000;
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const isRecord = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
function record(value: unknown, where: string): RecordValue {
  if (!isRecord(value)) throw new Error(`${where}必须是对象。`);
  return value;
}
function identifier(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 300) throw new Error(`${where}须为非空字符串（最多 300 字符）。`);
  return value;
}
function content(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${where}缺少文字。`);
  if (value.length > MAX_TEXT) throw new Error(`${where}超过 ${MAX_TEXT} 字符。`);
  if (value.includes('\0')) throw new Error(`${where}含有不支持的空字符。`);
  return value;
}
function timestamp(value: unknown, where: string, seconds = false): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (seconds) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 32503680000) {
      throw new Error(`${where}必须使用 ChatLab 秒级时间戳，不能使用毫秒。`);
    }
    return new Date(value * 1000).toISOString();
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error(`${where}须使用带时区的 ISO 8601 时间，未知请留空。`);
  }
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${where}不是有效日期。`);
  }
  return new Date(value).toISOString();
}

function parseCSV(text: string): RecordValue[] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === '"') {
      if (field || closed) throw new Error('CSV 引号位置不正确。');
      quoted = true;
    } else if (char === ',' || char === '\n') {
      row.push(field); field = ''; closed = false;
      if (char === '\n') { if (row.some((cell) => cell !== '')) rows.push(row); row = []; }
    } else {
      if (closed) throw new Error('CSV 闭合引号后只能出现逗号或换行。');
      field += char;
    }
    if (rows.length > MAX_MESSAGES + 1) throw new Error(`单次最多导入 ${MAX_MESSAGES} 条消息。`);
  }
  if (quoted) throw new Error('CSV 存在未闭合引号。');
  if (field || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift()?.map((header) => header.trim()) ?? [];
  if (!headers.includes('role') || !headers.includes('text')) throw new Error('CSV 至少需要 role,text 列；时间列为 sentAt。');
  if (new Set(headers).size !== headers.length) throw new Error('CSV 表头存在重复字段。');
  return rows.map((cells, index) => {
    if (cells.length !== headers.length) throw new Error(`CSV 第 ${index + 2} 行列数不一致。`);
    return Object.fromEntries(headers.map((header, i) => [header, cells[i]]));
  });
}

function jsonDocument(text: string): unknown {
  try { return JSON.parse(text); }
  catch {
    const lines = text.split('\n').map((line, i) => ({ line: line.trim(), number: i + 1 }))
      .filter(({ line }) => line && !line.startsWith('#'));
    const values = lines.map(({ line, number }) => {
      try { return record(JSON.parse(line), `JSONL 第 ${number} 行`); }
      catch { throw new Error(`JSON / JSONL 解析失败，检查第 ${number} 行格式。`); }
    });
    const header = values.shift();
    if (!header || header._type !== 'header') throw new Error('ChatLab JSONL 第一条记录必须为 header。');
    const members: RecordValue[] = [], messages: RecordValue[] = [];
    let sawMessage = false;
    for (const value of values) {
      if (value._type === 'member' && !sawMessage) members.push(value);
      else if (value._type === 'message') { sawMessage = true; messages.push(value); }
      else throw new Error('JSONL 只支持按顺序排列的 header、member、message。');
    }
    return { ...header, members, messages };
  }
}

export function parseImport(input: ImportInput): ParsedImport {
  if (!input || typeof input.text !== 'string') throw new Error('请选择聊天文件或输入文字。');
  if (Buffer.byteLength(input.text, 'utf8') > MAX_BYTES) throw new Error('单次文件不能超过 5 MiB，请拆分导出。');
  const text = input.text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!text) throw new Error('导入内容为空。');
  const chosen = input.format ?? 'auto';
  if (!['auto', 'chatlab', 'json', 'csv', 'text'].includes(chosen)) throw new Error('不支持的导入格式。');
  let format: string = chosen;
  if (format === 'auto') {
    const first = text.split('\n').find((line) => line.trim() && !line.trim().startsWith('#'))?.trim() ?? '';
    format = /^[{[]/.test(first) ? 'json' : (input.filename?.toLowerCase().endsWith('.csv') || /^role\s*,/.test(first)) ? 'csv' : 'text';
  }
  const warnings: string[] = [];
  let name = input.name?.trim() || input.filename?.replace(/\.[^.]+$/, '') || '导入的对话';
  if (name.length > 100) throw new Error('会话名称不能超过 100 字符。');
  let members: ImportPreview['members'] = [], messages: ParsedMessage[] = [], needsSelfId = false;
  const fingerprint = hash(text);
  let conversationKey = `file:${fingerprint}`;
  let rows: unknown[];

  if (format === 'json' || format === 'chatlab') {
    const document = jsonDocument(text);
    if (isRecord(document) && 'chatlab' in document) {
      format = 'chatlab';
      const header = record(document.chatlab, 'ChatLab 文件头');
      if (header.version !== '0.0.2') throw new Error('首版只支持 ChatLab 0.0.2。');
      const meta = record(document.meta, 'ChatLab meta');
      if (meta.type !== 'private') throw new Error('首版只支持私聊，不能把群聊当成两人会话导入。');
      const platform = identifier(meta.platform, 'ChatLab platform');
      name = input.name?.trim() || identifier(meta.name, 'ChatLab 会话名称');
      if (!Array.isArray(document.messages)) throw new Error('ChatLab 缺少 messages 数组。');
      rows = document.messages;
      if (rows.length > MAX_MESSAGES) throw new Error(`单次最多导入 ${MAX_MESSAGES} 条消息。`);
      if (document.members !== undefined && !Array.isArray(document.members)) throw new Error('ChatLab members 必须是数组。');
      const memberMap = new Map<string, string>();
      for (const item of (document.members ?? []) as unknown[]) {
        const member = record(item, 'ChatLab 成员');
        const id = identifier(member.platformId, '成员 platformId');
        if (memberMap.has(id)) throw new Error('ChatLab 成员 ID 重复。');
        memberMap.set(id, identifier(member.accountName, '成员 accountName'));
      }
      for (const [i, item] of rows.entries()) {
        const row = record(item, `消息 ${i + 1}`);
        const id = identifier(row.sender, `消息 ${i + 1} sender`);
        if (!memberMap.has(id)) {
          if ((document.members as unknown[] | undefined)?.length) throw new Error(`消息 ${i + 1} 的发送者未在 members 中声明。`);
          memberMap.set(id, identifier(row.accountName, `消息 ${i + 1} accountName`));
        }
      }
      members = [...memberMap].map(([id, memberName]) => ({ id, name: memberName }));
      if (members.length > 2) throw new Error('检测到超过两名参与者，首版只支持私聊。');
      if (input.selfId && !memberMap.has(input.selfId)) throw new Error('选择的本人 ID 不在参与者列表中。');
      needsSelfId = !input.selfId;
      if (needsSelfId) warnings.push('请明确选择哪位参与者是本人；确认前不会导入。');
      let nonText = 0;
      messages = rows.map((item, i) => {
        const row = record(item, `消息 ${i + 1}`);
        const senderId = row.sender as string;
        const isText = row.type === 0;
        if (typeof row.type !== 'number') throw new Error(`消息 ${i + 1} 缺少有效 type。`);
        if (!isText) nonText++;
        const role = isText && !needsSelfId ? senderId === input.selfId ? 'self' : 'peer' : 'system';
        return {
          role, senderId, text: isText ? content(row.content, `消息 ${i + 1}`) : `[非文字消息，类型 ${row.type}；首版不分析附件、引用或转发]`,
          sentAt: timestamp(row.timestamp, `消息 ${i + 1} timestamp`, true),
          externalId: row.platformMessageId == null ? null : identifier(row.platformMessageId, 'platformMessageId'),
          aiAssisted: row.aiAssisted === true,
        };
      });
      if (nonText) warnings.push(`${nonText} 条非文字、引用或转发仅保留占位，不参与个人档案提取。`);
      conversationKey = JSON.stringify(['chatlab', platform, input.selfId ?? 'unselected', [...memberMap.keys()].sort()]);
      warnings.push('首版不导入头像、成员别名和回复关系；原文件请自行保存。导入不会触发自动回复。');
    } else {
      if (chosen === 'chatlab') throw new Error('未发现 ChatLab 0.0.2 文件头。');
      rows = Array.isArray(document) ? document : isRecord(document) && Array.isArray(document.messages) ? document.messages : [];
      if (!Array.isArray(document) && !(isRecord(document) && Array.isArray(document.messages))) throw new Error('简易 JSON 须是消息数组或含 messages 的对象。');
      messages = simpleMessages(rows);
      if (isRecord(document) && typeof document.name === 'string' && !input.name) name = document.name;
    }
  } else if (format === 'csv') {
    rows = parseCSV(text);
    messages = simpleMessages(rows);
    warnings.push('CSV 使用明确的 self / peer / system 角色；不读取附件或额外字段。');
  } else {
    rows = text.split('\n').filter((line) => line.trim()).map((line, index) => {
      const match = /^(我|对方)\s*[:：]\s*(.*)$/.exec(line.trim());
      if (!match) throw new Error(`文本第 ${index + 1} 条须以“我：”或“对方：”开头。`);
      return { role: match[1] === '我' ? 'self' : 'peer', text: match[2] };
    });
    messages = simpleMessages(rows);
  }
  if (!messages.length) throw new Error('没有可以导入的消息。');
  if (messages.length > MAX_MESSAGES) throw new Error(`单次最多导入 ${MAX_MESSAGES} 条消息。`);
  if (name.length > 100) throw new Error('会话名称不能超过 100 字符。');
  const missingTime = messages.filter((message) => !message.sentAt).length;
  if (missingTime) warnings.push(`${missingTime} 条消息没有时间，保留原文件顺序，不猜测发送时间。`);
  if (format !== 'chatlab') {
    warnings.push('简易格式按同一文件识别重复导入；不同文件不会按昵称合并会话。历史导入不会触发自动回复。');
    if (format !== 'text') warnings.push('仅导入 role、text、sentAt、externalId 与 aiAssisted 字段；其他字段不保存在首版数据中。');
  }
  warnings.push('每次最多 5 MiB / 5000 条消息；预览与实际导入使用同一校验，异常批次不会部分入库。');
  return { format, name, members, messages, warnings, fingerprint, needsSelfId, conversationKey };
}

function simpleMessages(rows: unknown[]): ParsedMessage[] {
  if (rows.length > MAX_MESSAGES) throw new Error(`单次最多导入 ${MAX_MESSAGES} 条消息。`);
  return rows.map((item, index) => {
    const row = record(item, `消息 ${index + 1}`);
    if (!['self', 'peer', 'system'].includes(row.role as string)) throw new Error(`消息 ${index + 1} 的 role 必须是 self、peer 或 system，不能猜测身份。`);
    if (row.aiAssisted !== undefined && row.aiAssisted !== '' && ![true, false, 'true', 'false'].includes(row.aiAssisted as boolean)) throw new Error(`消息 ${index + 1} 的 aiAssisted 须为布尔值。`);
    return {
      role: row.role as ParsedMessage['role'], text: content(row.text, `消息 ${index + 1}`),
      sentAt: timestamp(row.sentAt, `消息 ${index + 1} sentAt`),
      externalId: row.externalId == null || row.externalId === '' ? null : identifier(row.externalId, 'externalId'),
      aiAssisted: row.aiAssisted === true || row.aiAssisted === 'true',
    };
  });
}
