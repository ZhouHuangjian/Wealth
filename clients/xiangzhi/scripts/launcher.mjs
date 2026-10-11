import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const sleep = ms => new Promise(done => setTimeout(done, ms));
const canonical = path => existsSync(path) ? realpathSync(path) : resolve(path);
const localRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fail = message => { throw new Error(message); };
const privateDirectory = path => { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); };
const json = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

export function resolveConfiguration(root, inherited = process.env) {
  root = canonical(root);
  let dotenv = {};
  try { if (existsSync(join(root, '.env'))) dotenv = parseEnv(readFileSync(join(root, '.env'), 'utf8')); }
  catch { fail('无法读取本目录的 .env，请检查格式和文件权限。'); }
  const env = { ...dotenv, ...inherited };
  const port = Number(env.PORT ?? 4351);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('PORT 必须是 1024 至 65535 之间的端口。');
  const existingPilot = join(root, 'private', 'wechat-pilot', 'xiangzhi.sqlite');
  const dataDir = canonical(resolve(root, env.DATA_DIR?.trim() || (existsSync(existingPilot) ? 'private/wechat-pilot' : 'private')));
  const manifest = env.PROFILE_MANIFEST_PATH?.trim();
  const defaultManifest = join(root, 'private', 'learning', '2026-10-10-v1', 'current-profile.json');
  const profile = manifest ? resolve(root, manifest) : existsSync(defaultManifest) ? defaultManifest : '';
  const codex = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  const nodeDir = dirname(process.execPath);
  Object.assign(env, { PORT: String(port), DATA_DIR: dataDir, SEED_DEMO: 'false', NODE_ENV: 'production', PATH: `${nodeDir}:${env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}` });
  if (profile) env.PROFILE_MANIFEST_PATH = profile;
  if (!env.XIANZHI_CODEX_BIN && existsSync(codex)) env.XIANZHI_CODEX_BIN = codex;
  const runtimeDir = join(root, 'private', 'launcher');
  return { root, env, port, dataDir, databasePath: canonical(join(dataDir, 'xiangzhi.sqlite')), runtimeDir, recordPath: join(runtimeDir, `service-${port}.json`), logPath: join(runtimeDir, `service-${port}.log`), url: `http://127.0.0.1:${port}/` };
}

export function redact(message, env = {}) {
  let value = String(message);
  for (const [name, secret] of Object.entries(env)) if (/token|password|secret|api.?key/i.test(name) && secret && secret.length >= 4) value = value.split(secret).join('[hidden]');
  return value.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [hidden]').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[hidden]@');
}

function command(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) fail('无法检查本机进程；请确认系统自带的 lsof 和 ps 可用。');
  return result.status === 0 ? result.stdout.trim() : '';
}
function lsof(args) { return command(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof', args); }
function processBirth(pid) { return command('/bin/ps', ['-p', String(pid), '-o', 'lstart=']); }
function processArgs(pid) { return command('/bin/ps', ['-p', String(pid), '-o', 'args=']); }
function processExists(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

export function inspectListener(config) {
  const listing = lsof(['-nP', '-a', `-iTCP:${config.port}`, '-sTCP:LISTEN', '-Fpn']);
  const pids = [...new Set(listing.split('\n').filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1))))];
  if (!pids.length) return null;
  if (pids.length !== 1) return { owned: false };
  const pid = pids[0];
  const cwd = lsof(['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).split('\n').find(line => line.startsWith('n'))?.slice(1);
  const args = processArgs(pid);
  const node = command('/bin/ps', ['-p', String(pid), '-o', 'comm=']);
  const entry = args.endsWith(' server/index.ts') || args.endsWith(` ${join(config.root, 'server', 'index.ts')}`)
    || args.includes(`${join(config.root, 'scripts', 'local-service.mjs')} --id `);
  const files = lsof(['-a', '-p', String(pid), '-Fn']).split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
  const hasDatabase = files.some(path => path === config.databasePath || (existsSync(path) && canonical(path) === canonical(config.databasePath)));
  const loopbackOnly = listing.split('\n').filter(line => line.startsWith('n')).every(line => line === `n127.0.0.1:${config.port}` || line === `n[::1]:${config.port}`);
  return { pid, birth: processBirth(pid), args, owned: !!cwd && canonical(cwd) === config.root && /(?:^|\/)node(?:\s|$)/.test(node) && entry && hasDatabase && loopbackOnly };
}

async function healthy(url) {
  try {
    const response = await fetch(new URL('api/health', url), { redirect: 'error', signal: AbortSignal.timeout(1200) });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) return false;
    const reader = response.body.getReader();
    let size = 0, output = '';
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 1024) { await reader.cancel(); return false; } output += new TextDecoder().decode(value); }
    const body = JSON.parse(output);
    return body.ok === true && body.version === '0.1.0';
  } catch { return false; }
}

function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}
async function lock(config) {
  privateDirectory(config.runtimeDir);
  // Separate SQLite file: cross-process locking is released by the OS on exit.
  // It never opens the app_state database, nor stores credentials or chat content.
  privateDirectory(config.dataDir);
  const path = join(dirname(config.databasePath), '.xiangzhi-launch.sqlite');
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) fail('启动锁文件不是普通文件，请检查数据目录。');
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(path);
  chmodSync(path, 0o600);
  database.exec('PRAGMA busy_timeout = 0');
  const until = Date.now() + 180000;
  let waiting = false;
  try {
    for (;;) {
      try {
        database.exec('BEGIN IMMEDIATE');
        return () => { try { database.exec('ROLLBACK'); } finally { database.close(); } };
      } catch (e) { if (e.errcode !== 5 && e.code !== 'SQLITE_BUSY') throw e; }
      if (!waiting) { console.log('另一个启动操作正在进行，正在等待结果…'); waiting = true; }
      if (Date.now() > until) fail('另一启动操作仍在进行，请稍后重试；没有停止任何服务。');
      await sleep(250);
    }
  } catch (error) { database.close(); throw error; }
}

export function sourceFingerprint(root) {
  const hash = createHash('sha256');
  const visit = relative => {
    const path = join(root, relative);
    if (!existsSync(path)) return;
    const info = lstatSync(path);
    if (info.isSymbolicLink()) fail('构建输入中包含符号链接，请使用完整的源码目录。');
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(relative, name));
    else if (info.isFile()) { hash.update(relative); hash.update(readFileSync(path)); }
  };
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'src', 'shared', 'server', 'public']) visit(name);
  return hash.digest('hex');
}
function dependenciesReady(root) { return ['tsx/dist/loader.mjs', 'vite/bin/vite.js', 'typescript/bin/tsc', 'express/package.json', 'zod/package.json', 'react/package.json', 'react-dom/package.json', 'lucide-react/package.json'].every(name => existsSync(join(root, 'node_modules', name))); }

async function runNpm(config, args) {
  const npm = join(dirname(process.execPath), 'npm');
  try { accessSync(npm, constants.X_OK); } catch { fail('此 Node.js 安装缺少 npm，请安装完整的 Node.js LTS 后重试。'); }
  const log = join(config.runtimeDir, 'setup.log');
  const stream = openSync(log, 'a', 0o600); chmodSync(log, 0o600);
  try {
    await new Promise((done, reject) => {
      const child = spawn(npm, args, { cwd: config.root, env: config.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      // Do not print installer environments or raw credentials into Terminal/logs.
      const buffers = new Map();
      for (const channel of [child.stdout, child.stderr]) {
        buffers.set(channel, '');
        let discard = false;
        channel.setEncoding('utf8');
        channel.on('data', data => {
          if (discard) {
            const newline = data.indexOf('\n');
            if (newline < 0) return;
            discard = false;
            data = data.slice(newline + 1);
          }
          const combined = buffers.get(channel) + data;
          const end = combined.lastIndexOf('\n');
          if (end >= 0) for (const line of combined.slice(0, end).split('\n')) if (line.length <= 65536) writeFileSync(stream, `${redact(line, config.env)}\n`);
          const pending = combined.slice(end + 1);
          // A huge unbroken installer line is omitted, never truncated through a secret.
          discard = pending.length > 65536;
          buffers.set(channel, discard ? '' : pending);
        });
      }
      child.once('error', () => reject(new Error('无法执行 npm，请检查 Node.js 安装。')));
      child.once('close', code => {
        for (const value of buffers.values()) if (value) writeFileSync(stream, redact(value, config.env));
        code === 0 ? done() : reject(new Error(`项目准备失败；请查看本机日志 ${log}。依赖安装需要可用网络。`));
      });
    });
  } finally { closeSync(stream); }
}

export async function prepareRuntime(config) {
  const packageHash = createHash('sha256').update(readFileSync(join(config.root, 'package.json'))).update(readFileSync(join(config.root, 'package-lock.json'))).digest('hex');
  const cachePath = join(config.runtimeDir, 'build.json');
  const previous = json(cachePath);
  let installed = false;
  if (!dependenciesReady(config.root) || (previous && previous.packageHash !== packageHash)) {
    console.log('正在安装本项目依赖，首次运行可能需要几分钟…');
    await runNpm(config, ['ci', '--include=dev', '--no-audit', '--no-fund']);
    installed = true;
  }
  const fingerprint = sourceFingerprint(config.root);
  if (installed || !existsSync(join(config.root, 'dist', 'index.html')) || previous?.fingerprint !== fingerprint || previous?.nodeMajor !== process.versions.node.split('.')[0]) {
    console.log('正在构建本地工作台，源码未变化时下次会跳过…');
    await runNpm(config, ['run', 'build']);
    atomicJson(cachePath, { fingerprint, packageHash, nodeMajor: process.versions.node.split('.')[0] });
  }
}

async function portAvailable(config) {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(config.port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}
function assertDatabaseAvailable(config) {
  if (!existsSync(config.databasePath)) return;
  const opened = lsof(['-Fpn', '--', config.databasePath]);
  if (opened.split('\n').some(line => /^p\d+$/.test(line))) fail('此数据目录已被另一个运行实例使用。请复用原服务，或设置独立 DATA_DIR；没有打开或更改数据库。');
}
function openBrowser(url) { const child = spawn('/usr/bin/open', [url], { detached: true, stdio: 'ignore' }); child.on('error', () => console.log(`浏览器未能打开，请手动访问 ${url}`)); child.unref(); }
function managed(config, listener, record) {
  return !!listener?.owned && record?.pid === listener.pid && record.birth === listener.birth && record.root === config.root && record.databasePath === config.databasePath && record.port === config.port && typeof record.id === 'string' && listener.args.endsWith(` --id ${record.id}`);
}

export async function launch(action, { root = localRoot, env = process.env, open = true, prepare = prepareRuntime } = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) fail('需要 Node.js 22.13 或更新版本。');
  if (!['start', 'stop', 'status'].includes(action)) fail('用法：node scripts/launcher.mjs start [--no-open] | status | stop');
  const config = resolveConfiguration(root, env);
  const release = await lock(config);
  try {
    const listener = inspectListener(config);
    if (listener && !listener.owned) fail(`端口 ${config.port} 已被其他程序或另一个数据实例占用。未打开页面，也未停止任何进程；请关闭对应程序，或在 .env 为本项目设置其它 PORT。`);
    if (action === 'status') {
      const ready = listener && await healthy(config.url);
      console.log(ready ? `本目录工作台正在运行：${config.url}（PID ${listener.pid}）` : listener ? '已找到本目录服务，但健康检查未通过；请查看本机日志。' : '本目录工作台尚未启动。');
      return { running: !!ready, pid: listener?.pid ?? null, config };
    }
    if (action === 'stop') {
      if (!listener) { console.log('本目录工作台已停止。'); return { running: false, config }; }
      if (!managed(config, listener, json(config.recordPath))) fail('此服务由原来的启动方式运行，本入口只会复用，不会代为停止。请通过原启动方式停止它。');
      process.kill(listener.pid, 'SIGTERM');
      const until = Date.now() + 8000;
      while (processExists(listener.pid) && processBirth(listener.pid) === listener.birth && Date.now() < until) await sleep(100);
      if (processExists(listener.pid) && processBirth(listener.pid) === listener.birth) fail('服务尚未退出，请稍后查看状态；没有强制结束进程。');
      rmSync(config.recordPath, { force: true });
      console.log('相知已停止，聊天记录和同步配置保留。');
      return { running: false, config };
    }
    if (listener) {
      if (!await healthy(config.url)) fail('已找到本目录服务，但健康检查未通过。没有自动重启；请先通过原启动方式检查服务。');
      console.log(`已复用本目录的工作台：${config.url}（PID ${listener.pid}）`);
      if (open) openBrowser(config.url);
      return { running: true, reused: true, pid: listener.pid, config };
    }
    if (!await portAvailable(config)) fail(`端口 ${config.port} 不可用；没有结束任何进程，请换用其它 PORT。`);
    assertDatabaseAvailable(config);
    await prepare(config);
    // Installing/building can take minutes: recheck before opening a database.
    if (inspectListener(config) || !await portAvailable(config)) fail(`准备期间端口 ${config.port} 已被占用。没有启动第二个服务，请再次运行以核对并复用现有实例。`);
    assertDatabaseAvailable(config);
    const log = openSync(config.logPath, 'a', 0o600); chmodSync(config.logPath, 0o600);
    const id = randomUUID();
    let child;
    try { child = spawn(process.execPath, [join(config.root, 'scripts', 'local-service.mjs'), '--id', id], { cwd: config.root, env: config.env, detached: true, stdio: ['ignore', log, log] }); }
    finally { closeSync(log); }
    let launchError = false;
    child.once('error', () => { launchError = true; });
    child.unref();
    let birth = '';
    try {
      birth = child.pid ? processBirth(child.pid) : '';
      const record = { id, pid: child.pid, birth, root: config.root, databasePath: config.databasePath, port: config.port };
      try { atomicJson(config.recordPath, record); }
      catch { fail('无法保存后台进程的启动记录，已取消此次启动。请检查本机运行目录权限。'); }
      const until = Date.now() + 30000;
      while (!launchError && child.pid && processExists(child.pid) && Date.now() < until) {
        const started = inspectListener(config);
        if (managed(config, started, record) && await healthy(config.url)) {
          console.log(`相知已在后台启动：${config.url}（PID ${child.pid}）\n可以关闭此终端窗口；微信读取和自动回复仍需手动开启。\n本机日志：${config.logPath}`);
          if (open) openBrowser(config.url);
          return { running: true, reused: false, pid: child.pid, config };
        }
        if (started && started.pid !== child.pid) break;
        await sleep(200);
      }
      fail(`工作台未完成启动。请查看本机日志 ${config.logPath}；没有停止其他程序。`);
    } catch (error) {
      // Covers record-write failures too. Never signal an unrelated port owner.
      if (child.pid && (!birth || processBirth(child.pid) === birth) && processArgs(child.pid).endsWith(` --id ${id}`)) try { child.kill('SIGTERM'); } catch { /* Already gone. */ }
      if (json(config.recordPath)?.id === id) rmSync(config.recordPath, { force: true });
      throw error;
    }
  } finally { release(); }
}

if (process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url))) {
  launch(process.argv[2] || 'start', { open: !process.argv.includes('--no-open') }).catch(error => {
    console.error(redact(error instanceof Error ? error.message : '启动操作未完成。', process.env));
    process.exitCode = 1;
  });
}
