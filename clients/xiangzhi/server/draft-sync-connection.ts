import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { validateEndpoint } from './bridge.js';
import { isDraftSyncConfigured, type DraftSyncConfig } from './draft-sync.js';
import { draftConnectionCheckUrl, type DraftConnectionReceipt } from './draft-sync-check.js';
import type { DraftSyncConnectionStatus } from '../shared/types.js';

const credentials = z.object({uploadUrl: z.string().trim().min(1).max(2048), token: z.string().min(32).max(4096).regex(/^[\x21-\x7e]+$/)}).strict();
const savedConnection = z.discriminatedUnion('mode', [
  z.object({version: z.literal(1), mode: z.literal('saved'), bindingId: z.uuid(), ...credentials.shape}).strict(),
  z.object({version: z.literal(1), mode: z.literal('disabled')}).strict(),
  z.object({version: z.literal(1), mode: z.literal('environment')}).strict(),
]);
type SavedConnection = z.infer<typeof savedConnection>;

/** Credentials never enter SQLite, exports, activities, or public state. */
export class DraftSyncConnection {
  private saved: SavedConnection | null = null;
  private error = false;
  private environmentId = randomUUID();
  private verification: Omit<DraftSyncConnectionStatus['verification'], 'supported'> = {status: 'not_checked', checkedAt: null, device: null, error: null};
  readonly directory: string | null;
  readonly path: string | null;

  constructor(databasePath: string, private readonly environment: DraftSyncConfig) {
    this.directory = databasePath === ':memory:' ? null : `${resolve(databasePath)}.draft-sync`;
    this.path = this.directory ? join(this.directory, 'connection.json') : null;
    if (!this.path || !existsSync(this.path)) return;
    try {
      this.secureDirectory();
      const info = lstatSync(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16 * 1024) throw new Error();
      chmodSync(this.path, 0o600);
      const parsed = savedConnection.parse(JSON.parse(readFileSync(this.path, 'utf8')));
      if (parsed.mode === 'saved') validateEndpoint(parsed.uploadUrl);
      this.saved = parsed;
    } catch { this.error = true; }
  }

  private secureDirectory() {
    if (!this.directory) return;
    mkdirSync(this.directory, {recursive: true, mode: 0o700});
    const info = lstatSync(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
    chmodSync(this.directory, 0o700);
  }

  private persist(next: SavedConnection) {
    if (this.path) {
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      let fd: number | undefined;
      try {
        this.secureDirectory();
        fd = openSync(temporary, 'wx', 0o600);
        writeFileSync(fd, JSON.stringify(next), 'utf8');
        fsyncSync(fd); closeSync(fd); fd = undefined;
        renameSync(temporary, this.path);
      } catch {
        throw new Error('本机无法保存同步连接，请检查数据目录权限。');
      } finally {
        if (fd !== undefined) closeSync(fd);
        try { unlinkSync(temporary); } catch { /* No temporary credential file remains after a successful rename. */ }
      }
    }
    this.saved = next;
    this.error = false;
    this.verification = {status: 'not_checked', checkedAt: null, device: null, error: null};
  }

  save(input: unknown) {
    const parsed = credentials.safeParse(input);
    if (!parsed.success) throw new Error('配置包格式不正确，需要有效的 uploadUrl 和至少 32 位设备令牌。');
    const uploadUrl = validateEndpoint(parsed.data.uploadUrl).href;
    this.persist({version: 1, mode: 'saved', bindingId: randomUUID(), uploadUrl, token: parsed.data.token});
  }
  disable() { this.persist({version: 1, mode: 'disabled'}); }
  restoreEnvironment() { this.persist({version: 1, mode: 'environment'}); this.environmentId = randomUUID(); }
  checking() { this.verification = {status: 'checking', checkedAt: null, device: null, error: null}; }
  checked(receipt: DraftConnectionReceipt) { this.verification = {status: 'verified', checkedAt: receipt.checkedAt, device: receipt.device, error: null}; }
  checkFailed(message: string) { this.verification = {status: 'failed', checkedAt: new Date().toISOString(), device: null, error: message}; }

  config(): DraftSyncConfig {
    const inboxToken = this.environment.inboxToken;
    if (this.error || this.saved?.mode === 'disabled') return {url: '', token: '', inboxToken};
    if (this.saved?.mode === 'saved') return {url: this.saved.uploadUrl, token: this.saved.token, inboxToken};
    return {...this.environment};
  }
  status(): DraftSyncConnectionStatus {
    const config = this.config();
    let uploadUrl = '';
    // Malformed environment values may contain credentials; never display them.
    try { if (config.url) uploadUrl = validateEndpoint(config.url).href; } catch { /* Display only a validated URL. */ }
    return {configured: isDraftSyncConfigured(config), uploadUrl,
      source: this.error ? 'error' : this.saved?.mode ?? 'environment',
      bindingId: this.error || this.saved?.mode === 'disabled' ? null : this.saved?.mode === 'saved' ? this.saved.bindingId : this.environmentId,
      error: this.error ? '本机保存的连接无法读取，同步已停用。请重新粘贴配置，或明确恢复环境配置。' : null,
      verification: {...this.verification, supported: draftConnectionCheckUrl(config) !== null}};
  }
}
