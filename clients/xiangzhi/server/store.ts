import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AppState } from '../shared/types.js';

function initialState(): AppState {
  return {
    version: 1,
    settings: {
      autoReplyEnabled: false, autoReplyMode: 'draft', syncDraftsEnabled: false, provider: 'demo', modelUrl: 'http://localhost:11434', modelName: '',
      apiKey: '', allowRemoteModel: false, replyDelaySeconds: 5, cooldownSeconds: 15,
      dailyLimit: 20, quietHoursEnabled: false, quietStart: '23:00', quietEnd: '08:00',
    },
    conversations: [], messages: [], claims: [], drafts: [], jobs: [], activity: [], feedback: [], cloudDrafts: [], draftUploads: [],
  };
}

/** A single synchronous transaction owns each read/modify/write operation. */
export class Store {
  private readonly db: DatabaseSync;
  private updating = false;

  constructor(path: string) {
    if (path !== ':memory:') {
      path = resolve(path);
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON; PRAGMA journal_mode = DELETE;');
    this.db.exec('CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL)');
    this.db.prepare('INSERT OR IGNORE INTO app_state (id, value) VALUES (1, ?)').run(JSON.stringify(initialState()));
    this.update((state) => {
      state.settings.autoReplyEnabled = false;
      for (const c of state.conversations) if (c.wechat) {
        c.wechat.enabled = false; c.wechat.status = 'paused';
        c.wechat.detail = '服务重新启动，采集已暂停；恢复后先补齐上下文，不自动回复补读消息。';
      }
      for (const upload of state.draftUploads ?? []) if (upload.status !== 'uploaded') {
        if (upload.status === 'uploading') upload.finishedAt = new Date().toISOString();
        upload.status = 'failed';
        upload.detail = '上次上传结果未确认。服务重启后旧草稿已失效，请先核对云端草稿箱；重新生成会建立新批次。';
      }
      const now = new Date().toISOString();
      for (const job of state.jobs) {
        if (job.status === 'queued') {
          job.status = 'cancelled';
          job.finishedAt = now;
          job.detail = '服务重新启动，旧的自动回复任务已取消。';
          job.replyText = null;
        } else if (job.status === 'generating') {
          job.status = 'failed';
          job.finishedAt = now;
          job.detail = '上次处理/发送结果未确认，不会自动重试。请先核对会话。';
        }
      }
    });
  }

  read(): AppState {
    const row = this.db.prepare('SELECT value FROM app_state WHERE id = 1').get() as { value: string } | undefined;
    if (!row) throw new Error('本地数据不存在。');
    const state = JSON.parse(row.value) as AppState;
    if (state.version !== 1) throw new Error('本地数据版本不受支持，请先备份并迁移。');
    // Older installations must explicitly select sending after this migration.
    state.settings.autoReplyMode ??= 'draft';
    state.feedback ??= [];
    state.settings.syncDraftsEnabled ??= false;
    state.cloudDrafts ??= [];
    state.draftUploads ??= [];
    return state;
  }

  update(fn: (state: AppState) => void): void {
    if (this.updating) throw new Error('不允许嵌套数据事务。');
    this.updating = true;
    let began = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      began = true;
      const state = this.read();
      const result: unknown = fn(state);
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        throw new Error('数据更新必须是同步操作。');
      }
      this.db.prepare('UPDATE app_state SET value = ? WHERE id = 1').run(JSON.stringify(state));
      this.db.exec('COMMIT');
    } catch (error) {
      if (began) this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.updating = false;
    }
  }

  close(): void { this.db.close(); }
}
