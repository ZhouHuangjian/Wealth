import {constants} from 'node:fs';
import {copyFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {homedir, tmpdir} from 'node:os';
import {isAbsolute, join, relative, sep} from 'node:path';
import type {Message} from '../shared/types.js';
import {parseWechatPage, runWechat} from './wechat-cli.js';

export interface WechatMediaInput {contact: string; message: Message; accountFingerprint?: string}
export interface WechatMediaFile {bytes: Buffer; mimeType: string; filename: string; wechatImage?: Message['wechatImage']}
const INVALID = '微信媒体标识或账号不匹配，请重新读取该会话。';
const MISSING = '尚未找到这条微信图片的本地文件，请先在微信中打开或下载图片后重试。';
const DECODE = '微信图片解码未完成，请检查本地图片文件与微信图片密钥后重试。';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_DATABASE_BYTES = 256 * 1024 * 1024;
const contactPattern = /^(?!-)[A-Za-z0-9_@.-]{1,200}$/;
const md5Pattern = /^[a-f0-9]{32}$/;
// macOS also keeps downloaded images as <md5>_M.dat. Keep this allowlist
// explicit so supporting that variant does not permit arbitrary file names.
const imageSuffixes = ['_h.dat', '.dat', '_hd.dat', '_M.dat', '_t.dat'] as const;
const within = (root: string, path: string) => {const part = relative(root, path); return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);};

async function safePath(path: string, root: string, file: boolean, maximum = MAX_SOURCE_BYTES): Promise<string> {
  if (!isAbsolute(path) || !within(root, path)) throw new Error(INVALID);
  // Reject symbolic links on every component, including the selected account.
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root) throw new Error(INVALID);
  let current = root;
  for (const component of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, component);
    if ((await lstat(current)).isSymbolicLink()) throw new Error(INVALID);
  }
  const stat = await lstat(path);
  if (file ? !stat.isFile() || stat.size <= 0 || stat.size > maximum : !stat.isDirectory()) throw new Error(INVALID);
  if (!within(canonicalRoot, await realpath(path))) throw new Error(INVALID);
  return path;
}

async function readBounded(path: string, root: string, maximum: number): Promise<Buffer> {
  await safePath(path, root, true, maximum);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > maximum) throw new Error(INVALID);
    const bytes = await handle.readFile();
    if (bytes.length <= 0 || bytes.length > maximum) throw new Error(INVALID);
    return bytes;
  } finally {await handle.close();}
}

async function safeDatabase(path: string, root: string): Promise<string> {
  await safePath(path, root, true, MAX_DATABASE_BYTES);
  for (const suffix of ['-wal', '-shm']) {
    try {
      const sidecar = path + suffix; const stat = await lstat(sidecar);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_DATABASE_BYTES) throw new Error(INVALID);
      if (stat.size > 0) await safePath(sidecar, root, true, MAX_DATABASE_BYTES);
    } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  }
  return path;
}

async function account(input: WechatMediaInput, signal?: AbortSignal) {
  if (!contactPattern.test(input.contact) || input.message.source !== 'wechat'
    || !input.message.sourceSequence || !/^[1-9][0-9]{0,29}$/.test(input.message.sourceSequence)
    || !input.accountFingerprint || !/^[a-f0-9]{64}$/.test(input.accountFingerprint)) throw new Error(INVALID);
  const {stdout} = await runWechat(['paths', '--json'], signal);
  let paths: {cache_root?: unknown};
  try {paths = JSON.parse(stdout);} catch {throw new Error(INVALID);}
  if (typeof paths.cache_root !== 'string' || !isAbsolute(paths.cache_root) || paths.cache_root.includes('\0')) throw new Error(INVALID);
  const dataRoot = process.env.XIANZHI_WECHAT_DATA_ROOT
    ?? join(homedir(), 'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files');
  if (!isAbsolute(dataRoot) || dataRoot.includes('\0')) throw new Error(INVALID);
  await safePath(dataRoot, dataRoot, false);
  const names = (await readdir(dataRoot, {withFileTypes: true})).filter(entry => entry.isDirectory() && contactPattern.test(entry.name));
  const selected = names.filter(entry => createHash('sha256').update(`wechat-account:${entry.name}`).digest('hex') === input.accountFingerprint);
  if (selected.length !== 1) throw new Error('微信账号已变化或原账号目录不可用，未读取其他账号的媒体。');
  const data = await safePath(join(dataRoot, selected[0].name), dataRoot, false);
  const cacheRoot = await realpath(paths.cache_root);
  const cache = join(cacheRoot, selected[0].name);
  return {name: selected[0].name, data, dataRoot, cache, cacheRoot};
}

/** Parse only relative image metadata produced by wx-cli, never arbitrary paths. */
export function parseWechatImagePaths(stdout: string, contact: string, md5: string): string[] {
  try {
    if (!contactPattern.test(contact) || !md5Pattern.test(md5)) throw new Error();
    const rows: unknown = JSON.parse(stdout);
    if (!Array.isArray(rows) || rows.length > 16) throw new Error();
    const directory = createHash('md5').update(contact).digest('hex');
    return rows.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
      const row = raw as Record<string, unknown>;
      if (row.media_type !== 'image' || row.md5 !== md5 || row.dir1 !== directory
        || typeof row.dir2 !== 'string' || !/^20[0-9]{2}-(?:0[1-9]|1[0-2])$/.test(row.dir2)
        || typeof row.file_name !== 'string' || !imageSuffixes.some(suffix => row.file_name === md5 + suffix)) throw new Error();
      return join('msg', 'attach', directory, row.dir2, 'Img', row.file_name);
    });
  } catch {throw new Error(INVALID);}
}

function imageMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

async function readImage(input: WechatMediaInput, signal?: AbortSignal): Promise<WechatMediaFile> {
  if (input.message.kind !== 'image') throw new Error(INVALID);
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]);
  const context = await account(input, bounded);
  let metadata = input.message.wechatImage;
  if (!metadata?.md5) {
    // Previously collected images have only sequence/server identifiers. Query
    // exactly this image from its pinned account without loading chat history.
    const {stdout, stderr} = await runWechat(['query', input.contact, '--no-server', '--data-dir', context.data,
      '--account', context.name, '--type', 'image', '--after-sort-seq', (BigInt(input.message.sourceSequence!) - 1n).toString(),
      '--order', 'asc', '--limit', '1', '--offset', '0', '--format', 'json'], bounded);
    // Explicit --account may omit the auto-detection diagnostic. The supplied
    // identity is derived from the account already matched to stored provenance;
    // any conflicting real diagnostic remains visible to the strict parser.
    const page = parseWechatPage(stdout, `Auto-detected account: ${context.name} (source: selected-account)\n${stderr}`, input.contact);
    const record = page.records[0];
    const provisional = input.message.externalId === `seq:${input.message.sourceSequence}`;
    if (page.accountFingerprint !== input.accountFingerprint || !record || page.records.length !== 1
      || record.sortSeq !== input.message.sourceSequence || record.kind !== 'image' || record.role !== input.message.role
      || (!provisional && record.id !== input.message.externalId) || !record.wechatImage?.md5) throw new Error(INVALID);
    metadata = record.wechatImage;
  }
  const md5 = metadata.md5;
  if (!md5 || !md5Pattern.test(md5)) throw new Error(INVALID);
  const candidates: string[] = [];
  try {
    const database = await safeDatabase(join(context.cache, 'db_storage/hardlink/hardlink.db'), context.cacheRoot);
    const {stdout} = await runWechat(['media', 'resolve-path', '--db', database, '--media-type', 'image', md5], bounded);
    candidates.push(...parseWechatImagePaths(stdout, input.contact, md5));
  } catch (error) {if (bounded.aborted) throw error; /* Old hardlink caches can miss recent images. */}
  // Exact filenames inside one selected contact/month avoid traversing the media
  // directory or relying on a stale decrypted hardlink database.
  const at = input.message.sentAt ? Date.parse(input.message.sentAt) : NaN;
  if (Number.isFinite(at)) {
    const date = new Date(at); const months = new Set<string>();
    for (const offset of [-1, 0, 1]) {
      const month = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));
      months.add(month.toISOString().slice(0, 7));
    }
    for (const month of months) for (const suffix of imageSuffixes) {
      candidates.push(join('msg', 'attach', createHash('md5').update(input.contact).digest('hex'), month, 'Img', md5 + suffix));
    }
  }
  const unique = [...new Set(candidates)].sort((a, b) => Number(a.endsWith('_t.dat')) - Number(b.endsWith('_t.dat')));
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'xiangzhi-wechat-image-'));
  let found = false;
  try {
    for (const candidate of unique) {
      if (bounded.aborted) throw new Error('微信图片读取已取消或超过时限。');
      let source: string;
      try {source = await safePath(join(context.data, candidate), context.dataRoot, true);} catch {continue;}
      found = true;
      const output = join(directory, 'decoded');
      try {
        await rm(output, {force: true});
        // --account wins over --data-dir in wx-cli and fails when no stored V2
        // image key exists. data-dir alone safely derives the matching key.
        await runWechat(['media', 'decrypt-dat', source, '--output', output, '--data-dir', context.data], bounded);
        const bytes = await readBounded(output, directory, MAX_IMAGE_BYTES);
        const mimeType = imageMime(bytes);
        if (!mimeType) continue;
        const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice(6);
        return {bytes, mimeType, filename: `wechat-image.${extension}`, wechatImage: metadata};
      } catch (error) {if (bounded.aborted) throw error;}
    }
    throw new Error(found ? DECODE : MISSING);
  } finally {await rm(directory, {recursive: true, force: true});}
}

export async function readWechatImage(input: WechatMediaInput, signal?: AbortSignal): Promise<WechatMediaFile> {
  try {return await readImage(input, signal);}
  catch (error) {
    if (typeof (error as NodeJS.ErrnoException)?.code === 'string') throw new Error(MISSING);
    throw error;
  }
}

function audioMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav';
  return null;
}

/** Extract one server ID; prepare only individual media databases when needed. */
async function readVoice(input: WechatMediaInput, signal?: AbortSignal): Promise<WechatMediaFile> {
  if (input.message.kind !== 'voice' || !input.message.externalId || !/^[1-9][0-9]{0,29}$/.test(input.message.externalId)) throw new Error(INVALID);
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]);
  const context = await account(input, bounded);
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'xiangzhi-wechat-voice-'));
  const output = join(directory, 'voice.mp3');
  const extract = async (mediaDirectory: string): Promise<WechatMediaFile | null> => {
    try {
      await rm(output, {force: true});
      await runWechat(['media', 'extract-voice', '--media-dir', mediaDirectory, '--output', output, input.message.externalId!], bounded);
      const bytes = await readBounded(output, directory, 5 * 1024 * 1024);
      const mimeType = audioMime(bytes);
      return mimeType ? {bytes, mimeType, filename: mimeType === 'audio/wav' ? 'wechat-voice.wav' : 'wechat-voice.mp3'} : null;
    } catch (error) {if (bounded.aborted) throw error; return null;}
  };
  try {
    // Cached databases cover older messages without duplicating metadata work.
    try {
      const cache = await safePath(join(context.cache, 'db_storage/message'), context.cacheRoot, false);
      const entries = await readdir(cache);
      if (entries.some(name => /^media_.*\.db$/.test(name) && !/^media_[0-9]+\.db$/.test(name))) throw new Error(INVALID);
      const databases = entries.filter(name => /^media_[0-9]+\.db$/.test(name));
      if (databases.length > 16) throw new Error(INVALID);
      for (const database of databases) await safeDatabase(join(cache, database), context.cacheRoot);
      const result = await extract(cache); if (result) return result;
    } catch (error) {if (bounded.aborted) throw error;}
    const media = await safePath(join(context.data, 'db_storage/message'), context.dataRoot, false);
    const names = (await readdir(media)).filter(name => /^media_[0-9]+\.db$/.test(name)).sort();
    if (names.length > 16) throw new Error(INVALID);
    for (const name of names) {
      if (bounded.aborted) throw new Error('微信语音读取已取消或超过时限。');
      const source = join(directory, 'source'); const target = join(directory, 'cache');
      await rm(source, {recursive: true, force: true}); await rm(target, {recursive: true, force: true});
      const partial = join(source, 'db_storage/message'); await mkdir(partial, {recursive: true, mode: 0o700});
      for (const suffix of ['', '-wal']) {
        const path = join(media, name + suffix);
        try {await safePath(path, context.dataRoot, true, MAX_DATABASE_BYTES); await copyFile(path, join(partial, name + suffix));}
        catch (error) {if (!suffix) throw error;}
      }
      // The temporary input contains one metadata database, never the account's
      // message collection or media directory. KeyStore lookup stays in wx-cli.
      try {
        await runWechat(['decrypt', '--data-dir', source, '--account', context.name, '--output', target], bounded);
        const result = await extract(join(target, 'db_storage/message')); if (result) return result;
      } catch (error) {if (bounded.aborted) throw error;}
    }
    throw new Error('微信语音提取或 MP3 转换未完成，请先在微信中播放该语音，并检查本机 wx-cli 与 FFmpeg。');
  } finally {await rm(directory, {recursive: true, force: true});}
}

export async function readWechatVoice(input: WechatMediaInput, signal?: AbortSignal): Promise<WechatMediaFile> {
  try {return await readVoice(input, signal);}
  catch (error) {
    if (typeof (error as NodeJS.ErrnoException)?.code === 'string') throw new Error('本地微信语音数据库不可用，请在微信中播放该语音后重试。');
    throw error;
  }
}
