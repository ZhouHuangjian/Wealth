import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, symlinkSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaFiles, inspectImage, parseImageUpload, parseAudioUpload } from '../server/media-files.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXv0AAAAASUVORK5CYII=','base64');
test('upload validation checks byte signatures, canonical base64, size and pixel bounds rather than file labels',()=>{
  assert.equal(parseImageUpload({dataUrl:`data:image/png;base64,${png.toString('base64')}`}).mimeType,'image/png');
  assert.throws(()=>parseImageUpload({dataUrl:`data:image/jpeg;base64,${png.toString('base64')}`}),/格式无效/);
  assert.throws(()=>parseImageUpload({dataUrl:'data:image/png;base64,Zm9v==='}),/格式无效/);
  const dimensions=Buffer.from(png);dimensions.writeUInt32BE(16000,16);dimensions.writeUInt32BE(16000,20);
  assert.throws(()=>inspectImage(dimensions),/格式无效/);
  assert.throws(()=>inspectImage(Buffer.alloc(6*1024*1024)),/格式无效/);
  const audio=Buffer.from('0000ftyp3gp60000');assert.equal(parseAudioUpload({dataUrl:`data:audio/3gpp;base64,${audio.toString('base64')}`}).mimeType,'audio/3gpp');
});
test('private media cache uses opaque IDs, restrictive permissions and rejects traversal and symbolic links',()=>{
  const dir=mkdtempSync(join(tmpdir(),'xiangzhi-media-cache-')),cache=new MediaFiles(join(dir,'app.sqlite'));
  try{
    const a=cache.save({bytes:png,mimeType:'image/png',filename:'../../display.png'},'upload');
    assert.equal(a.filename,'display.png');assert.deepEqual(cache.read(a).bytes,png);
    assert.equal(statSync(cache.directory!).mode&0o777,0o700);
    const file=join(cache.directory!,readdirSync(cache.directory!)[0]);assert.equal(statSync(file).mode&0o777,0o600);
    assert.throws(()=>cache.read({...a,id:'../../another-file'}),/不存在/);
    unlinkSync(file);symlinkSync(join(dir,'other.png'),file);assert.throws(()=>cache.read(a),/格式无效|不存在/);
    cache.delete(a);assert.equal(readdirSync(cache.directory!).length,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('memory media attachments are copied and become inaccessible on deletion',()=>{
  const cache=new MediaFiles(':memory:'),data=Buffer.from(png),a=cache.save({bytes:data,mimeType:'image/png',filename:'x.png'},'upload');
  data.fill(0);assert.deepEqual(cache.read(a).bytes,png);cache.delete(a);assert.throws(()=>cache.read(a),/不存在/);
});
