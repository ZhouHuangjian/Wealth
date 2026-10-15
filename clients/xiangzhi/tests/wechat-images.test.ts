import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseWechatImagePaths, readWechatImage, readWechatVoice, type WechatMediaInput} from '../server/wechat-images.js';

const md5 = 'a'.repeat(32);
const contactHash = createHash('md5').update('filehelper').digest('hex');
const name = 'wxid_synthetic_fixture';
const fingerprint = createHash('sha256').update(`wechat-account:${name}`).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhN0AAAAASUVORK5CYII=', 'base64');
const input: WechatMediaInput = {contact: 'filehelper', accountFingerprint: fingerprint, message: {
  id: 'synthetic-image', conversationId: 'fixture', source: 'wechat', role: 'peer', text: '[图片]', kind: 'image',
  sentAt: '2026-10-11T00:00:00Z', sequence: 1, aiAssisted: false, externalId: '1234567890123456789',
  sourceSequence: '999999999999999999', wechatImage: {md5},
}};

async function fixture(script: string, run: (root: string, data: string) => Promise<void>) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'xiangzhi-media-fixture-'));
  const data = join(root, 'data'); const cache = join(root, 'cache');
  const previous = {bin: process.env.XIANZHI_WECHAT_BIN, root: process.env.XIANZHI_WECHAT_DATA_ROOT};
  await mkdir(join(data, name, 'msg/attach', contactHash, '2026-10/Img'), {recursive: true});
  await mkdir(join(cache, name, 'db_storage/hardlink'), {recursive: true});
  await mkdir(join(cache, name, 'db_storage/message'), {recursive: true});
  await writeFile(join(cache, name, 'db_storage/hardlink/hardlink.db'), 'synthetic metadata');
  await writeFile(join(cache, name, 'db_storage/message/media_0.db'), 'synthetic metadata');
  const executable = join(root, 'wx-cli');
  await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);const root=${JSON.stringify(root)};if(args[0]==='paths'){process.stdout.write(JSON.stringify({cache_root:${JSON.stringify(cache)}}));process.exit(0);}fs.appendFileSync(root+'/calls',JSON.stringify(args)+'\\n');${script}`, {mode: 0o700});
  process.env.XIANZHI_WECHAT_BIN = executable; process.env.XIANZHI_WECHAT_DATA_ROOT = data;
  try {await run(root, data);} finally {
    if (previous.bin === undefined) delete process.env.XIANZHI_WECHAT_BIN; else process.env.XIANZHI_WECHAT_BIN = previous.bin;
    if (previous.root === undefined) delete process.env.XIANZHI_WECHAT_DATA_ROOT; else process.env.XIANZHI_WECHAT_DATA_ROOT = previous.root;
    await rm(root, {recursive: true, force: true});
  }
}

test('image resolver accepts scoped metadata and rejects traversal, wrong contacts, and unexpected file names', () => {
  const row = {media_type: 'image', md5, dir1: contactHash, dir2: '2026-10', file_name: md5 + '.dat'};
  assert.deepEqual(parseWechatImagePaths(JSON.stringify([row]), 'filehelper', md5), [join('msg/attach', contactHash, '2026-10/Img', md5 + '.dat')]);
  assert.deepEqual(parseWechatImagePaths(JSON.stringify([{...row, file_name: md5 + '_M.dat'}]), 'filehelper', md5),
    [join('msg/attach', contactHash, '2026-10/Img', md5 + '_M.dat')]);
  for (const change of [{dir1: '../elsewhere'}, {dir1: 'f'.repeat(32)}, {dir2: '2026-99'}, {dir2: '/private'},
    {file_name: '../key.dat'}, {file_name: '/private/key.dat'}, {file_name: md5 + '_unknown.dat'}, {md5: 'b'.repeat(32)}, {media_type: 'video'}]) {
    assert.throws(() => parseWechatImagePaths(JSON.stringify([{...row, ...change}]), 'filehelper', md5), /标识|账号/);
  }
});

test('downloaded custom stickers use one account and exact content MD5 without export or network access',async()=>{
  const stickerMd5=createHash('md5').update(png).digest('hex');
  const sticker={...input,message:{...input.message,kind:'emoji' as const,wechatImage:undefined,wechatEmoji:{md5:stickerMd5}}};
  await fixture('process.exit(9);',async(root,data)=>{
    const persist=join(data,name,'business/emoticon/Persist',stickerMd5.slice(0,2));await mkdir(persist,{recursive:true});
    await writeFile(join(persist,stickerMd5),png);
    const result=await readWechatImage(sticker);assert.deepEqual(result.bytes,png);assert.equal(result.mimeType,'image/png');
    assert.deepEqual(result.wechatEmoji,{md5:stickerMd5});assert.equal(result.filename,'wechat-emoji.png');
    await assert.rejects(readFile(join(root,'calls')),{code:'ENOENT'});
  });
});

test('legacy custom stickers backfill only their stored sequence and never retain CDN details',async()=>{
  const stickerMd5=createHash('md5').update(png).digest('hex');
  const row={sort_seq:input.message.sourceSequence,server_id:input.message.externalId,msg_type:'47',sub_type:'0',talker:'filehelper',direction:'incoming',create_time:'1791676800',content:{Emoji:{xml:`<emoji md5="${stickerMd5}" cdnurl="https://not-requested.invalid/secret"/>`}}};
  const page=JSON.stringify({items:[row],paging:{returned:1,has_more:false,limit:1},stats:{skipped:0}});
  await fixture(`if(args[0]==='query')process.stdout.write(${JSON.stringify(page)});else process.exit(3);`,async(root,data)=>{
    const persist=join(data,name,'business/emoticon/PersistStore',stickerMd5.slice(0,2));await mkdir(persist,{recursive:true});await writeFile(join(persist,stickerMd5),png);
    const result=await readWechatImage({...input,message:{...input.message,kind:'emoji',wechatImage:undefined}});
    assert.deepEqual(result.wechatEmoji,{md5:stickerMd5});assert.doesNotMatch(JSON.stringify(result),/not-requested|secret/);
    const calls=(await readFile(join(root,'calls'),'utf8')).trim().split('\n').map(row=>JSON.parse(row) as string[]);
    assert.equal(calls.length,1);assert.equal(calls[0][calls[0].indexOf('--type')+1],'emoji');assert.equal(calls[0][calls[0].indexOf('--after-sort-seq')+1],'999999999999999998');
  });
});

test('sticker reading refuses symlinks and wrong-content files, and marks exact thumbnail fallback',async()=>{
  const stickerMd5=createHash('md5').update(png).digest('hex');
  const sticker={...input,message:{...input.message,kind:'emoji' as const,wechatImage:undefined,wechatEmoji:{md5:stickerMd5}}};
  await fixture('process.exit(9);',async(root,data)=>{
    const persist=join(data,name,'business/emoticon/Persist',stickerMd5.slice(0,2));await mkdir(persist,{recursive:true});
    await writeFile(join(persist,stickerMd5),Buffer.concat([png,Buffer.from('wrong-content')]));
    await assert.rejects(readWechatImage(sticker),/尚未找到.*表情包/);
    await rm(join(persist,stickerMd5));await writeFile(join(root,'external.png'),png);await symlink(join(root,'external.png'),join(persist,stickerMd5));
    await assert.rejects(readWechatImage(sticker),/尚未找到.*表情包/);
    const thumbnail=join(data,name,'business/emoticon/Thumb',stickerMd5.slice(0,2));await mkdir(thumbnail,{recursive:true});await writeFile(join(thumbnail,stickerMd5+'.thumb'),png);
    const result=await readWechatImage(sticker);assert.equal(result.thumbnail,true);assert.equal(result.filename,'wechat-emoji-thumbnail.png');
    await assert.rejects(readWechatImage({...sticker,accountFingerprint:'b'.repeat(64)}),/账号已变化/);
  });
});

test('Mac _M.dat images remain readable when the stale hardlink index has no entry', async () => {
  await fixture(`if(args[1]==='resolve-path')process.exit(1);if(args[1]!=='decrypt-dat'||args.includes('--account'))process.exit(2);fs.writeFileSync(args[args.indexOf('--output')+1],Buffer.from(${JSON.stringify(png.toString('base64'))},'base64'));`, async (root, data) => {
    const img = join(data, name, 'msg/attach', contactHash, '2026-10/Img');
    await writeFile(join(img, md5 + '_M.dat'), 'synthetic downloaded Mac image');
    await writeFile(join(img, md5 + '_t.dat'), 'synthetic thumbnail');
    const result = await readWechatImage(input);
    assert.equal(result.mimeType, 'image/png'); assert.deepEqual(result.bytes, png);
    const calls = (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').map(row => JSON.parse(row) as string[]);
    const decode = calls.filter(args => args[1] === 'decrypt-dat');
    assert.equal(decode.length, 1); assert.ok(decode[0][2].endsWith(md5 + '_M.dat'));
  });
});

test('stale hardlink cache falls back to one original image and V2 derivation omits the account override', async () => {
  await fixture(`if(args[1]==='resolve-path')process.exit(1);if(args[1]!=='decrypt-dat'||args.includes('--account'))process.exit(2);fs.writeFileSync(args[args.indexOf('--output')+1],Buffer.from(${JSON.stringify(png.toString('base64'))},'base64'));`, async (root, data) => {
    const img = join(data, name, 'msg/attach', contactHash, '2026-10/Img');
    await writeFile(join(img, md5 + '_t.dat'), 'synthetic thumbnail');
    await writeFile(join(img, md5 + '.dat'), 'synthetic original');
    const result = await readWechatImage(input);
    assert.equal(result.mimeType, 'image/png'); assert.deepEqual(result.bytes, png);
    const calls = (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').map(row => JSON.parse(row) as string[]);
    const decode = calls.filter(args => args[1] === 'decrypt-dat');
    assert.equal(decode.length, 1); assert.ok(decode[0][2].endsWith(md5 + '.dat'));
    assert.ok(decode[0].includes('--data-dir')); assert.ok(!decode[0].includes('--account'));
    assert.ok(!calls.some(args => args[0] === 'export'));
  });
});

test('legacy images backfill MD5 by querying exactly their stored sequence in the pinned account', async () => {
  const row = {sort_seq: input.message.sourceSequence, server_id: input.message.externalId, msg_type: '3', sub_type: '0',
    talker: 'filehelper', direction: 'incoming', create_time: '1791676800', content: {Image: {md5}}};
  const page = JSON.stringify({items: [row], paging: {returned: 1, has_more: false, limit: 1}, stats: {skipped: 0}});
  await fixture(`if(args[0]==='query'){process.stdout.write(${JSON.stringify(page)});}else if(args[1]==='resolve-path')process.exit(1);else if(args[1]==='decrypt-dat'){fs.writeFileSync(args[args.indexOf('--output')+1],Buffer.from(${JSON.stringify(png.toString('base64'))},'base64'));}else process.exit(3);`, async (root, data) => {
    await writeFile(join(data, name, 'msg/attach', contactHash, '2026-10/Img', md5 + '.dat'), 'synthetic original');
    const result = await readWechatImage({...input, message: {...input.message, wechatImage: undefined}});
    assert.deepEqual(result.wechatImage, {md5}); assert.deepEqual(result.bytes, png);
    const calls = (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').map(row => JSON.parse(row) as string[]);
    const query = calls.find(args => args[0] === 'query')!;
    assert.deepEqual(query, ['query', 'filehelper', '--no-server', '--data-dir', join(data, name), '--account', name,
      '--type', 'image', '--after-sort-seq', '999999999999999998', '--order', 'asc', '--limit', '1', '--offset', '0', '--format', 'json']);
  });
});

test('legacy lookup refuses neighboring images, different IDs or conflicting account diagnostics', async () => {
  for (const mode of ['sequence', 'id', 'account'] as const) {
    const row = {sort_seq: mode === 'sequence' ? '1000000000000000000' : input.message.sourceSequence,
      server_id: mode === 'id' ? '2222222222222222222' : input.message.externalId, msg_type: '3', sub_type: '0',
      talker: 'filehelper', direction: 'incoming', create_time: '1791676800', content: {Image: {md5}}};
    const page = JSON.stringify({items: [row], paging: {returned: 1, has_more: false, limit: 1}, stats: {skipped: 0}});
    await fixture(`if(args[0]==='query'){process.stdout.write(${JSON.stringify(page)});${mode === 'account' ? 'process.stderr.write("Auto-detected account: wxid_other_fixture (source: test)\\n");' : ''}}else process.exit(3);`, async root => {
      await assert.rejects(readWechatImage({...input, message: {...input.message, wechatImage: undefined}}), /不匹配|格式/);
      assert.doesNotMatch(await readFile(join(root, 'calls'), 'utf8'), /decrypt-dat|resolve-path/);
    });
  }
});

test('single-image reads refuse account changes and do not follow symbolic links', async () => {
  await fixture('process.exit(1);', async (root, data) => {
    await assert.rejects(readWechatImage({...input, accountFingerprint: 'b'.repeat(64)}), /账号已变化/);
    await assert.rejects(readWechatImage({...input, accountFingerprint: undefined}), /不匹配/);
    await writeFile(join(root, 'outside.dat'), 'sensitive fixture');
    await symlink(join(root, 'outside.dat'), join(data, name, 'msg/attach', contactHash, '2026-10/Img', md5 + '.dat'));
    await assert.rejects(readWechatImage(input), /尚未找到/);
    const calls = await readFile(join(root, 'calls'), 'utf8');
    assert.doesNotMatch(calls, /decrypt-dat/);
  });
});

test('invalid or excessive decoded images fail without exposing raw CLI errors', async () => {
  for (const oversized of [false, true]) {
    await fixture(`if(args[1]==='resolve-path')process.exit(1);process.stderr.write('sensitive-key-and-path');fs.writeFileSync(args[args.indexOf('--output')+1],Buffer.alloc(${oversized ? 13 * 1024 * 1024 : 30}));`, async (_root, data) => {
      await writeFile(join(data, name, 'msg/attach', contactHash, '2026-10/Img', md5 + '.dat'), 'synthetic source');
      await assert.rejects(readWechatImage(input), error => error instanceof Error && /解码未完成/.test(error.message) && !/sensitive/.test(error.message));
    });
  }
});

test('voice extracts only its exact server ID and returns playable format metadata', async () => {
  await fixture(`if(args[1]!=='extract-voice'||args.includes('--raw'))process.exit(2);fs.writeFileSync(args[args.indexOf('--output')+1],Buffer.from('ID3synthetic-mp3'));`, async root => {
    const result = await readWechatVoice({...input, message: {...input.message, kind: 'voice', wechatImage: undefined}});
    assert.equal(result.mimeType, 'audio/mpeg'); assert.equal(result.filename, 'wechat-voice.mp3');
    const calls = (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').map(row => JSON.parse(row) as string[]);
    assert.equal(calls.length, 1); assert.equal(calls[0].at(-1), '1234567890123456789');
    await assert.rejects(readWechatVoice({...input, message: {...input.message, kind: 'voice', externalId: 'seq:3'}}), /不匹配/);
  });
});

test('a missing voice refreshes only one encrypted media database in a disposable directory', async () => {
  await fixture(`const path=require('node:path');if(args[0]==='decrypt'){const source=args[args.indexOf('--data-dir')+1];const rows=fs.readdirSync(source+'/db_storage/message');if(rows.length!==1||rows[0]!=='media_0.db'||args[args.indexOf('--account')+1]!==${JSON.stringify(name)})process.exit(2);const out=args[args.indexOf('--output')+1];fs.mkdirSync(out+'/db_storage/message',{recursive:true});fs.writeFileSync(out+'/db_storage/message/media_0.db','synthetic decrypted metadata');}else if(args[1]==='extract-voice'){const media=args[args.indexOf('--media-dir')+1];if(media.startsWith(root))process.exit(1);fs.writeFileSync(args[args.indexOf('--output')+1],Buffer.from('ID3synthetic-mp3'));}else process.exit(3);`, async (root, data) => {
    await mkdir(join(data, name, 'db_storage/message'), {recursive: true});
    await writeFile(join(data, name, 'db_storage/message/media_0.db'), 'synthetic encrypted metadata');
    const result = await readWechatVoice({...input, message: {...input.message, kind: 'voice', wechatImage: undefined}});
    assert.equal(result.mimeType, 'audio/mpeg');
    const calls = (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').map(row => JSON.parse(row) as string[]);
    const decrypt = calls.filter(args => args[0] === 'decrypt'); assert.equal(decrypt.length, 1);
    assert.ok(!calls.some(args => args[0] === 'export' || args.includes('--raw')));
    await assert.rejects(readFile(join(decrypt[0][decrypt[0].indexOf('--data-dir') + 1], 'db_storage/message/media_0.db')), /ENOENT/);
  });
});

test('cancelled single media requests never start a subprocess', async () => {
  await fixture('setInterval(()=>{},1000);', async root => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(readWechatImage(input, controller.signal), /取消/);
    await assert.rejects(readFile(join(root, 'calls')), /ENOENT/);
  });
});

test('filesystem errors and unsafe database sidecars never reveal local paths or open linked files', async () => {
  await fixture(`if(args[1]==='extract-voice')process.exit(2);process.exit(1);`, async root => {
    await writeFile(join(root, 'private-fixture'), 'sensitive fixture');
    await symlink(join(root, 'private-fixture'), join(root, 'cache', name, 'db_storage/message/media_0.db-wal'));
    await assert.rejects(readWechatVoice({...input, message: {...input.message, kind: 'voice'}}), error => error instanceof Error
      && !error.message.includes(root) && /数据库不可用/.test(error.message));
    await assert.rejects(readFile(join(root, 'calls')), /ENOENT/);
  });
});
