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
    this.db.exec(`CREATE TABLE IF NOT EXISTS remote_commands (
      scope TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL, result TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '', expires_at INTEGER NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(scope,id))`);
    this.db.exec('CREATE TABLE IF NOT EXISTS remote_control_meta (id INTEGER PRIMARY KEY CHECK(id=1), pause_pending INTEGER NOT NULL)');
    this.db.prepare("UPDATE remote_commands SET status='failed', error=? WHERE status='running'")
      .run('本机在执行期间重启，结果未确认；请核对当前配置后重新操作。');
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

  remoteClaim(scope: string, id: string, expiresAt: number): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO remote_commands(scope,id,status,expires_at) VALUES (?,?,'running',?)")
      .run(scope,id,expiresAt).changes === 1;
  }
  remoteFinish(scope: string, receipt: {id: string; status: 'succeeded' | 'failed'; result: Record<string, unknown>; error: string}): void {
    this.db.prepare('UPDATE remote_commands SET status=?,result=?,error=?,acknowledged=0 WHERE scope=? AND id=?')
      .run(receipt.status,JSON.stringify(receipt.result),receipt.error,scope,receipt.id);
  }
  remoteReceipts(scope: string, now=Date.now()): {id: string; status: 'succeeded' | 'failed'; result: Record<string, unknown>; error: string}[] {
    // Cloud command history expires after 30 days; never block new work on an obsolete acknowledgement.
    this.db.prepare('DELETE FROM remote_commands WHERE expires_at<?').run(now-29*86400_000);
    return (this.db.prepare("SELECT id,status,result,error FROM remote_commands WHERE scope=? AND status!='running' AND acknowledged=0 ORDER BY expires_at LIMIT 20")
      .all(scope) as {id:string;status:'succeeded'|'failed';result:string;error:string}[]).map(row=>({...row,result:JSON.parse(row.result)}));
  }
  remoteAcknowledge(scope: string, ids: string[], now: number): void {
    for(const id of ids) this.db.prepare('UPDATE remote_commands SET acknowledged=1 WHERE scope=? AND id=?').run(scope,id);
    this.db.prepare('DELETE FROM remote_commands WHERE acknowledged=1 AND expires_at<?').run(now-30*86400_000);
  }
  remoteReplay(scope: string, id: string): void {
    this.db.prepare("UPDATE remote_commands SET acknowledged=0 WHERE scope=? AND id=? AND status!='running'").run(scope,id);
  }
  remotePausePending(): boolean {return !!this.db.prepare('SELECT pause_pending FROM remote_control_meta WHERE id=1').get()?.pause_pending;}
  remoteRequestPause(): void {this.db.exec('INSERT INTO remote_control_meta(id,pause_pending) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET pause_pending=1');}
  remotePauseReported(): void {this.db.exec('UPDATE remote_control_meta SET pause_pending=0 WHERE id=1');}
}
