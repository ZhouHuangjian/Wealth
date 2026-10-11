// Detached entry point. Configuration is resolved by launcher.mjs, not by sourcing .env.
import { format } from 'node:util';
import { register } from 'tsx/esm/api';
import { redact } from './launcher.mjs';

for (const name of ['log', 'warn', 'error', 'info']) {
  const output = console[name].bind(console);
  console[name] = (...values) => output(redact(format(...values), process.env));
}
process.on('uncaughtException', error => { console.error('本机服务意外退出：', error.message); process.exit(1); });
process.on('unhandledRejection', () => { console.error('本机服务遇到未完成的异步操作，已退出。'); process.exit(1); });
register();
try { await import('../server/index.ts'); }
catch (error) { console.error('本机服务无法启动：', error instanceof Error ? error.message : '请检查依赖与本机配置。'); process.exitCode = 1; }
