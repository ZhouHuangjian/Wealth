import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { launch, redact, resolveConfiguration, sourceFingerprint } from '../scripts/launcher.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = () => realpathSync(mkdtempSync(join(tmpdir(), '相知 启动测试 ')));
const safeEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LANG: process.env.LANG, XIANZHI_CODEX_BIN: '/synthetic-unavailable/codex', XIANZHI_WECHAT_BIN: '/synthetic-unavailable/wx-cli' });
async function port() {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const value = (server.address() as { port: number }).port;
  await new Promise<void>(done => server.close(() => done()));
  return value;
}
function invoke(root: string, env: Record<string, string | undefined>, action: string) {
  return new Promise<{ code: number | null; output: string }>(done => {
    const child = spawn(process.execPath, [join(root, 'scripts/launcher.mjs'), action, '--no-open'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.once('exit', code => done({ code, output }));
  });
}

test('launcher preserves explicit dotenv/environment, prefers existing pilot data, and forces no demo', () => {
  const root = fixture();
  try {
    mkdirSync(join(root, 'private/wechat-pilot'), { recursive: true });
    writeFileSync(join(root, 'private/wechat-pilot/xiangzhi.sqlite'), 'synthetic');
    mkdirSync(join(root, 'private/learning/2026-10-10-v1'), { recursive: true });
    writeFileSync(join(root, 'private/learning/2026-10-10-v1/current-profile.json'), '{}');
    const fallback = resolveConfiguration(root, {});
    assert.equal(fallback.port, 4351);
    assert.equal(fallback.dataDir, join(root, 'private/wechat-pilot'));
    assert.equal(fallback.env.PROFILE_MANIFEST_PATH, join(root, 'private/learning/2026-10-10-v1/current-profile.json'));
    writeFileSync(join(root, '.env'), 'PORT=4567\nDATA_DIR="私有 数据"\nSEED_DEMO=true\nPROFILE_MANIFEST_PATH="学习 档案/current.json"\nXIANZHI_CODEX_BIN="/synthetic codex"\nDRAFT_SYNC_TOKEN="example-token-kept-private"\n');
    const configured = resolveConfiguration(root, { PORT: '4568' });
    assert.equal(configured.port, 4568);
    assert.equal(configured.dataDir, join(root, '私有 数据'));
    assert.equal(configured.env.SEED_DEMO, 'false');
    assert.equal(configured.env.NODE_ENV, 'production');
    assert.equal(configured.env.PROFILE_MANIFEST_PATH, join(root, '学习 档案/current.json'));
    assert.equal(configured.env.XIANZHI_CODEX_BIN, '/synthetic codex');
    assert.equal(configured.env.DRAFT_SYNC_TOKEN, 'example-token-kept-private');
    assert.match(redact('token=example-token-kept-private Bearer example-other-token https://user:pass@example.org', configured.env), /token=\[hidden\] Bearer \[hidden\] https:\/\/\[hidden\]@example.org/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('healthy unrelated service is never reused or stopped', async () => {
  const root = fixture();
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true,"version":"0.1.0"}'); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const env = { ...safeEnv(), PORT: String((server.address() as { port: number }).port) };
  try {
    for (const action of ['start', 'stop']) await assert.rejects(launch(action, { root, env, open: false, prepare: () => assert.fail('must not build') }), /已被其他程序或另一个数据实例占用/);
    assert.equal(server.listening, true);
  } finally { await new Promise<void>(done => server.close(() => done())); rmSync(root, { recursive: true, force: true }); }
});

test('a crashed lock holder releases the independent startup lock', { timeout: 10000 }, async () => {
  const root = fixture();
  mkdirSync(join(root, 'private'));
  const holder = spawn(process.execPath, ['--input-type=module', '-e', 'import {DatabaseSync} from "node:sqlite";const db=new DatabaseSync(process.argv[1]);db.exec("BEGIN IMMEDIATE");console.log("ready");setInterval(()=>{},1000);', join(root, 'private/.xiangzhi-launch.sqlite')], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await once(holder.stdout!, 'data');
    const pending = launch('status', { root, env: { ...safeEnv(), PORT: String(await port()) }, open: false });
    await new Promise(done => setTimeout(done, 100));
    holder.kill('SIGKILL');
    await once(holder, 'exit');
    assert.equal((await pending).running, false);
  } finally { holder.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); }
});

test('a port acquired during preparation does not open the application database', async () => {
  const root = fixture();
  const chosen = await port();
  const server = createServer();
  try {
    await assert.rejects(launch('start', { root, env: { ...safeEnv(), PORT: String(chosen) }, open: false, prepare: async () => { await new Promise<void>(done => server.listen(chosen, '127.0.0.1', done)); } }), /准备期间端口/);
    assert.equal(existsSync(join(root, 'private/xiangzhi.sqlite')), false);
    assert.equal(server.listening, true);
  } finally { if (server.listening) await new Promise<void>(done => server.close(() => done())); rmSync(root, { recursive: true, force: true }); }
});

test('detached actual app in Chinese/space path supports duplicate start, safe identity checks and stop', { timeout: 60000 }, async () => {
  const root = fixture();
  const env = { ...safeEnv(), PORT: String(await port()), DATA_DIR: '合成 数据', DRAFT_SYNC_URL: '', DRAFT_SYNC_TOKEN: '', DRAFT_INBOX_TOKEN: '', BRIDGE_TOKEN: '', OUTBOUND_WEBHOOK_URL: '', OUTBOUND_WEBHOOK_TOKEN: '' };
  let record: { pid: number } | undefined;
  try {
    for (const name of ['server', 'shared', 'scripts', 'src', 'public', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html']) cpSync(join(project, name), join(root, name), { recursive: true });
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist/index.html'), '<!doctype html><title>Synthetic launcher fixture</title>');
    symlinkSync(join(project, 'node_modules'), join(root, 'node_modules'));
    const config = resolveConfiguration(root, env);
    mkdirSync(config.runtimeDir, { recursive: true });
    const packageHash = createHash('sha256').update(readFileSync(join(root, 'package.json'))).update(readFileSync(join(root, 'package-lock.json'))).digest('hex');
    writeFileSync(join(config.runtimeDir, 'build.json'), JSON.stringify({ fingerprint: sourceFingerprint(root), packageHash, nodeMajor: process.versions.node.split('.')[0] }));
    const buildTime = statSync(join(config.runtimeDir, 'build.json')).mtimeMs;
    const starts = await Promise.all([invoke(root, env, 'start'), invoke(root, env, 'start')]);
    assert.deepEqual(starts.map(result => result.code), [0, 0], JSON.stringify(starts));
    assert.equal(starts.filter(result => result.output.includes('已在后台启动')).length, 1);
    assert.equal(starts.filter(result => result.output.includes('已复用')).length, 1);
    assert.equal(starts.some(result => result.output.includes('正在构建')), false);
    assert.equal(statSync(join(config.runtimeDir, 'build.json')).mtimeMs, buildTime);
    record = JSON.parse(readFileSync(config.recordPath, 'utf8'));
    assert.ok(record?.pid);
    const status = await invoke(root, env, 'status');
    assert.equal(status.code, 0, status.output);
    assert.match(status.output, /正在运行/);
    const sessionResponse = await fetch(new URL('api/session', config.url));
    const cookie = sessionResponse.headers.get('set-cookie')!.split(';')[0];
    const state = await (await fetch(new URL('api/state', config.url), { headers: { Cookie: cookie } })).json() as any;
    assert.equal(state.conversations.length, 0);
    assert.equal(state.settings.autoReplyEnabled, false);
    assert.equal(state.settings.syncDraftsEnabled, false);
    assert.equal(state.runtime.bridgeSendConfigured, false);
    assert.equal(state.runtime.draftSyncConfigured, false);
    assert.equal(state.runtime.codexAvailable, false);
    assert.equal(existsSync(config.databasePath), true);
    assert.equal(statSync(config.logPath).mode & 0o777, 0o600);
    assert.equal(statSync(config.runtimeDir).mode & 0o777, 0o700);
    const different = await invoke(root, { ...env, DATA_DIR: '另一个 数据库' }, 'start');
    assert.equal(different.code, 1);
    assert.match(different.output, /另一个数据实例占用/);
    const sameDatabase = await invoke(root, { ...env, PORT: String(await port()) }, 'start');
    assert.equal(sameDatabase.code, 1);
    assert.match(sameDatabase.output, /此数据目录已被另一个运行实例使用/);
    assert.equal((await fetch(new URL('api/health', config.url))).ok, true);
    const originalRecord = readFileSync(config.recordPath, 'utf8');
    writeFileSync(config.recordPath, JSON.stringify({ ...JSON.parse(originalRecord), id: 'wrong-identity' }));
    const refused = await invoke(root, env, 'stop');
    assert.equal(refused.code, 1);
    assert.match(refused.output, /不会代为停止/);
    assert.equal((await fetch(new URL('api/health', config.url))).ok, true);
    writeFileSync(config.recordPath, originalRecord);
    const stopped = await invoke(root, env, 'stop');
    assert.equal(stopped.code, 0, stopped.output);
    assert.match(stopped.output, /已停止/);
    const after = await invoke(root, env, 'status');
    assert.match(after.output, /尚未启动/);
    assert.equal(existsSync(config.databasePath), true);
    record = undefined;
  } finally {
    if (record?.pid) { try { process.kill(record.pid, 'SIGTERM'); } catch { /* Already exited. */ } }
    rmSync(root, { recursive: true, force: true });
  }
});
