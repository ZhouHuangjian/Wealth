import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { codexCompletion, inspectCodex } from '../server/codex-provider.js';
import type { Settings } from '../shared/types.js';

const settings: Settings = {
  provider: 'codex', modelName: '', modelUrl: 'https://unused.example/v1', apiKey: 'APPLICATION-SECRET', allowRemoteModel: true,
  autoReplyEnabled: false, autoReplyMode: 'draft', replyDelaySeconds: 0, cooldownSeconds: 0, dailyLimit: 20,
  quietHoursEnabled: false, quietStart: '23:00', quietEnd: '07:00',
};
const synthetic = [{role: 'system', content: '只生成三条候选回复。'}, {role: 'user', content: '虚构测试上下文：今天想吃面。'}];
const reply = JSON.stringify({replies: Array.from({length: 3}, (_, i) => ({text: `测试回复 ${i}`, label: '简短', reason: '合成测试'}))});

async function withFake(action: (fake: {
  directory: string; capture: () => Promise<Record<string, any>>; configure: (mode: string) => Promise<void>;
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'xiangzhi-fake-codex-'));
  const executable = join(directory, 'fake-codex.mjs');
  const envKeys = ['XIANZHI_CODEX_BIN', 'XIANZHI_CODEX_TIMEOUT_MS', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
    'CODEX_API_KEY', 'HTTP_PROXY', 'NODE_OPTIONS', 'UNRELATED_TEST_SECRET'];
  const previous = new Map(envKeys.map(key => [key, process.env[key]]));
  const capturePath = join(directory, 'capture.json');
  await writeFile(join(directory, 'scenario.json'), JSON.stringify({mode: 'success'}));
  await writeFile(executable, `#!${process.execPath}
import {readFileSync,writeFileSync,readdirSync,statSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const directory=dirname(fileURLToPath(import.meta.url));
const mode=JSON.parse(readFileSync(join(directory,'scenario.json'),'utf8')).mode;
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{
 const args=process.argv.slice(2), schemaIndex=args.indexOf('--output-schema');
 const capture={args,input,cwd:process.cwd(),pid:process.pid,env:process.env,
   files:readdirSync(process.cwd()),directoryMode:statSync(process.cwd()).mode & 0o777,
   schema:schemaIndex<0?null:JSON.parse(readFileSync(args[schemaIndex+1],'utf8'))};
 if(mode.startsWith('descendant-')){
   const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},100)"],{stdio:'ignore'});
   capture.childPid=child.pid;child.unref();
 }
 writeFileSync(join(directory,'capture.json'),JSON.stringify(capture));
 const event=value=>process.stdout.write(JSON.stringify(value)+'\\n');
 if(args.includes('--version')){process.stdout.write(mode==='bad-version'?'secret-invalid-version':'codex-cli 0.162.0-alpha.17.2\\n');return;}
 if(mode==='hang'){process.on('SIGTERM',()=>{});setInterval(()=>{},100);return;}
 if(mode==='descendant-abort'){setInterval(()=>{},100);return;}
 if(mode==='nonzero'){process.stderr.write('PRIVATE-PROMPT APPLICATION-SECRET');process.exitCode=7;return;}
 if(mode==='stderr-large'){process.stderr.write('x'.repeat(70_000));return;}
 if(mode==='stdout-large'){process.stdout.write('x'.repeat(600_000));return;}
 if(mode==='malformed'){process.stdout.write('PRIVATE-PROMPT invalid json\\n');return;}
 event({type:'thread.started',thread_id:'synthetic-thread'});
 const startupNotice='Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable '+String.fromCharCode(96)+'features.code_mode_host'+String.fromCharCode(96)+' and install '+String.fromCharCode(96)+'codex-code-mode-host'+String.fromCharCode(96)+'.';
 if(mode==='startup-notices'){
   event({type:'item.completed',item:{id:'notice-a',type:'error',message:'Under-development features enabled: skip_host_skill_discovery. Under-development features may be unstable.'}});
   event({type:'item.completed',item:{id:'notice-b',type:'error',message:startupNotice}});
 }
 if(mode==='unknown-startup-error')event({type:'item.completed',item:{id:'unknown-error',type:'error',message:'PRIVATE-PROMPT unexpected startup error'}});
 event({type:'turn.started'});
 if(mode==='late-notice')event({type:'item.completed',item:{id:'late-notice',type:'error',message:startupNotice}});
 if(mode==='tool'){event({type:'item.started',item:{id:'tool',type:'command_execution',command:'DO NOT EXECUTE'}});setInterval(()=>{},100);return;}
 if(mode==='failure'){event({type:'turn.failed',error:{message:'PRIVATE-PROMPT APPLICATION-SECRET'}});return;}
 event({type:'item.completed',item:{id:'reason',type:'reasoning',text:'PRIVATE-REASONING'}});
 event({type:'item.completed',item:{id:'old',type:'agent_message',text:'earlier commentary'}});
 event({type:'item.completed',item:{id:'final',type:'agent_message',text:${JSON.stringify(reply)}}});
 if(mode==='incomplete')return;
 event({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
 if(mode==='extra')event({type:'turn.started'});
});
`, {mode: 0o700});
  process.env.XIANZHI_CODEX_BIN = executable;
  delete process.env.XIANZHI_CODEX_TIMEOUT_MS;
  for (const key of envKeys.slice(2)) process.env[key] = `EXCLUDED-${key}`;
  try {
    await action({directory, capture: async () => JSON.parse(await readFile(capturePath, 'utf8')),
      configure: async mode => { await writeFile(join(directory, 'scenario.json'), JSON.stringify({mode})); }});
  } finally {
    for (const key of envKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, {recursive: true, force: true});
  }
}

test('Codex adapter pipes private input via stdin, isolates cwd, disables capabilities and cleans up', async () => {
  await withFake(async fake => {
    assert.equal(await codexCompletion({...settings, modelName: 'test-model'}, synthetic), reply);
    const capture = await fake.capture();
    assert.match(capture.input, /虚构测试上下文/);
    assert.doesNotMatch(JSON.stringify(capture.args), /虚构测试上下文|APPLICATION-SECRET|unused\.example/);
    assert.equal(capture.args.at(-1), '-');
    for (const flag of ['--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config', '--skip-git-repo-check']) {
      assert.ok(capture.args.includes(flag));
    }
    assert.equal(capture.args[capture.args.indexOf('--sandbox') + 1], 'read-only');
    for (const config of ['web_search="disabled"', 'mcp_servers={}', 'project_doc_max_bytes=0', 'history.persistence="none"',
      'memories.use_memories=false', 'agents.enabled=false']) assert.ok(capture.args.includes(config));
    for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'browser_use', 'computer_use', 'multi_agent', 'view_image']) {
      const index = capture.args.indexOf(feature); assert.equal(capture.args[index - 1], '--disable');
    }
    assert.equal(capture.args[capture.args.indexOf('--model') + 1], 'test-model');
    assert.equal(capture.schema.properties.replies.minItems, 3);
    assert.equal(capture.schema.properties.replies.maxItems, 3);
    assert.deepEqual(capture.files, ['reply.schema.json']);
    assert.equal(capture.directoryMode, 0o700);
    assert.notEqual(capture.cwd, process.cwd());
    assert.equal(existsSync(capture.cwd), false);
    assert.equal(capture.env.HOME, process.env.HOME);
    assert.equal(capture.env.CODEX_HOME, process.env.CODEX_HOME);
    for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'HTTP_PROXY', 'NODE_OPTIONS', 'UNRELATED_TEST_SECRET']) {
      assert.equal(capture.env[key], undefined);
    }
  });
});

test('Codex availability inspection checks only a bounded local version and omits default model override', async () => {
  await withFake(async fake => {
    const result = await inspectCodex();
    assert.equal(result.available, true); assert.equal(result.version, '0.162.0-alpha.17.2');
    assert.match(result.message, /未验证登录/);
    const capture = await fake.capture();
    assert.deepEqual(capture.args, ['--version']); assert.equal(capture.input, '');
    assert.equal(existsSync(capture.cwd), false);
    await codexCompletion(settings, synthetic);
    assert.equal((await fake.capture()).args.includes('--model'), false);
    await fake.configure('bad-version');
    const invalid = await inspectCodex(); assert.equal(invalid.available, false); assert.equal(invalid.version, null);
    assert.doesNotMatch(invalid.message, /secret-invalid/);
  });
});

test('Codex rejects absent remote consent, pre-cancellation and unsafe transport settings before spawning', async () => {
  await withFake(async fake => {
    await assert.rejects(codexCompletion({...settings, allowRemoteModel: false}, synthetic), /远程处理/);
    await assert.rejects(codexCompletion(settings, synthetic, AbortSignal.abort()), /取消/);
    await assert.rejects(codexCompletion({...settings, modelName: '--unsafe'}, synthetic), /模型名称/);
    await assert.rejects(codexCompletion(settings, [{role: 'user', content: 'x'.repeat(256_001)}]), /输入超过/);
    process.env.XIANZHI_CODEX_TIMEOUT_MS = '0';
    await assert.rejects(codexCompletion(settings, synthetic), /1000 至 180000/);
    assert.equal(existsSync(join(fake.directory, 'capture.json')), false);
  });
});

test('Codex refuses malformed, incomplete, failed, nonzero or tool-using output without exposing details', async () => {
  await withFake(async fake => {
    for (const mode of ['malformed', 'incomplete', 'failure', 'nonzero', 'tool', 'extra', 'unknown-startup-error', 'late-notice']) {
      await fake.configure(mode);
      await assert.rejects(codexCompletion(settings, synthetic), error => {
        assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /PRIVATE|APPLICATION-SECRET|DO NOT EXECUTE/); return true;
      });
      assert.equal(existsSync((await fake.capture()).cwd), false);
    }
  });
});

test('Codex accepts only recognized pre-turn notices caused by restrictive CLI configuration', async () => {
  await withFake(async fake => {
    await fake.configure('startup-notices');
    assert.equal(await codexCompletion(settings, synthetic), reply);
    assert.equal(existsSync((await fake.capture()).cwd), false);
  });
});

test('Codex bounds stdout and stderr independently', async () => {
  await withFake(async fake => {
    for (const mode of ['stdout-large', 'stderr-large']) {
      await fake.configure(mode);
      await assert.rejects(codexCompletion(settings, synthetic), /大小限制/);
      assert.equal(existsSync((await fake.capture()).cwd), false);
    }
  });
});

test('Codex cancellation terminates a process that ignores SIGTERM and removes temporary files', async () => {
  await withFake(async fake => {
    await fake.configure('hang');
    const abort = new AbortController();
    const result = codexCompletion(settings, synthetic, abort.signal);
    const rejection = assert.rejects(result, /取消/);
    while (!existsSync(join(fake.directory, 'capture.json'))) await delay(10);
    const capture = await fake.capture();
    abort.abort(new Error('PRIVATE cancellation reason'));
    await rejection;
    assert.throws(() => process.kill(capture.pid, 0));
    assert.equal(existsSync(capture.cwd), false);
  });
});

test('Codex enforces bounded timeout and never retries the child', async () => {
  await withFake(async fake => {
    await fake.configure('hang'); process.env.XIANZHI_CODEX_TIMEOUT_MS = '1000';
    await assert.rejects(codexCompletion(settings, synthetic), /超时.*没有自动重试/);
    const capture = await fake.capture();
    assert.throws(() => process.kill(capture.pid, 0));
    assert.equal(existsSync(capture.cwd), false);
  });
});

test('Codex removes background descendants after the leader exits, on success and cancellation', {skip: process.platform === 'win32'}, async () => {
  await withFake(async fake => {
    for (const mode of ['descendant-success', 'descendant-abort']) {
      await fake.configure(mode);
      await rm(join(fake.directory, 'capture.json'), {force: true});
      const abort = new AbortController();
      const result = codexCompletion(settings, synthetic, abort.signal);
      const completion = mode === 'descendant-abort' ? assert.rejects(result, /取消/) : result;
      while (!existsSync(join(fake.directory, 'capture.json'))) await delay(10);
      const capture = await fake.capture();
      try {
        if (mode === 'descendant-abort') { await delay(100); abort.abort(); }
        await completion;
        const alive = () => { try { process.kill(capture.childPid, 0); return true; } catch { return false; } };
        for (let attempts = 0; alive() && attempts < 50; attempts++) await delay(20);
        assert.equal(alive(), false, 'background child should not survive its process group');
        assert.equal(existsSync(capture.cwd), false);
      } finally {
        try { process.kill(capture.childPid, 'SIGKILL'); } catch { /* Already gone. */ }
        abort.abort();
      }
    }
  });
});

test('Codex missing executable yields a safe unavailable status and safe generation error', async () => {
  await withFake(async fake => {
    process.env.XIANZHI_CODEX_BIN = join(fake.directory, 'missing');
    assert.equal((await inspectCodex()).available, false);
    await assert.rejects(codexCompletion(settings, synthetic), /无法启动 Codex/);
    process.env.XIANZHI_CODEX_BIN = 'relative-path';
    await assert.rejects(codexCompletion(settings, synthetic), /绝对路径/);
  });
});
