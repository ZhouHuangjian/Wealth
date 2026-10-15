import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { ImageAttachment } from '../shared/types.js';

export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
const extensions: Record<string,string> = {'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp',
  'audio/wav':'wav','audio/mpeg':'mp3','audio/mp4':'m4a','audio/3gpp':'3gp','audio/aac':'aac','audio/ogg':'ogg','audio/webm':'webm','audio/amr':'amr'};
const fail = () => {throw new Error('媒体文件格式无效，或文件超过 5 MiB。');};

export function inspectImage(bytes:Buffer): {mimeType:string; width:number; height:number} {
  if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) return fail();
  let mimeType='',width=0,height=0;
  if(bytes.length>=33 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii',12,16)==='IHDR') {
    mimeType='image/png';width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);
  } else if(bytes.length>=13 && /^GIF8[79]a$/.test(bytes.toString('ascii',0,6))) {
    mimeType='image/gif';width=bytes.readUInt16LE(6);height=bytes.readUInt16LE(8);
  } else if(bytes.length>=12 && bytes[0]===0xff && bytes[1]===0xd8) {
    mimeType='image/jpeg';let offset=2;
    while(offset+4<=bytes.length) {
      if(bytes[offset++]!==0xff) return fail();
      while(offset<bytes.length && bytes[offset]===0xff) offset++;
      const marker=bytes[offset++];
      if(marker===0xd9||marker===0xda) break;
      if(marker===0x01||(marker>=0xd0&&marker<=0xd7)) continue;
      if(offset+2>bytes.length) return fail();
      const length=bytes.readUInt16BE(offset);
      if(length<2||offset+length>bytes.length) return fail();
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if(length<8) return fail();height=bytes.readUInt16BE(offset+3);width=bytes.readUInt16BE(offset+5);break;
      }
      offset+=length;
    }
  } else if(bytes.length>=30 && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP') {
    mimeType='image/webp';const kind=bytes.toString('ascii',12,16);
    if(kind==='VP8X') {width=1+bytes.readUIntLE(24,3);height=1+bytes.readUIntLE(27,3);}
    else if(kind==='VP8 '&&bytes[23]===0x9d&&bytes[24]===0x01&&bytes[25]===0x2a) {width=bytes.readUInt16LE(26)&0x3fff;height=bytes.readUInt16LE(28)&0x3fff;}
    else if(kind==='VP8L'&&bytes[20]===0x2f) {width=1+(((bytes[22]&0x3f)<<8)|bytes[21]);height=1+(((bytes[24]&0x0f)<<10)|(bytes[23]<<2)|(bytes[22]>>6));}
  }
  if(!mimeType||!width||!height||width>16384||height>16384||width*height>25_000_000) return fail();
  return {mimeType,width,height};
}

export function inspectAudio(bytes:Buffer): {mimeType:string} {
  if(bytes.length<8||bytes.length>MAX_MEDIA_BYTES) return fail();
  const start=bytes.toString('ascii',0,12);
  let mimeType='';
  if(start.startsWith('RIFF')&&start.slice(8)==='WAVE') mimeType='audio/wav';
  else if(start.startsWith('ID3')||(bytes[0]===0xff&&(bytes[1]&0xe0)===0xe0&&(bytes[1]&0x06)!==0)) mimeType='audio/mpeg';
  else if(bytes.length>=12 && bytes.toString('ascii',4,8)==='ftyp') mimeType=/^3g[pe]/.test(bytes.toString('ascii',8,12))?'audio/3gpp':'audio/mp4';
  else if(bytes[0]===0xff&&(bytes[1]&0xf6)===0xf0) mimeType='audio/aac';
  else if(start.startsWith('OggS')) mimeType='audio/ogg';
  else if(bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))) mimeType='audio/webm';
  else if(start.startsWith('#!AMR\n')||start.startsWith('#!AMR-WB\n')) mimeType='audio/amr';
  if(!mimeType) return fail();
  return {mimeType};
}

function decodeUpload(input:{dataUrl:string;filename?:string},kind:'image'|'audio') {
  const match=/^data:([a-z0-9/+.-]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(input.dataUrl);
  if(!match||input.dataUrl.length>Math.ceil(MAX_MEDIA_BYTES*4/3)+200||match[2].length%4!==0) return fail();
  const bytes=Buffer.from(match[2],'base64');
  if(bytes.toString('base64')!==match[2]) return fail();
  const {mimeType}=kind==='image'?inspectImage(bytes):inspectAudio(bytes);
  const supplied=match[1].toLowerCase();
  const aliases:Record<string,string>={'image/jpg':'image/jpeg','audio/x-wav':'audio/wav','audio/wave':'audio/wav','audio/mp3':'audio/mpeg','audio/x-m4a':'audio/mp4','audio/3gpp2':'audio/3gpp'};
  if((aliases[supplied]??supplied)!==mimeType && supplied!=='application/octet-stream') return fail();
  return {bytes,mimeType,filename:cleanFilename(input.filename??`${kind}.${extensions[mimeType]}`)};
}
export const parseImageUpload=(input:{dataUrl:string;filename?:string})=>decodeUpload(input,'image');
export const parseAudioUpload=(input:{dataUrl:string;filename?:string})=>decodeUpload(input,'audio');
const cleanFilename=(name:string)=>basename(name).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,120)||'媒体文件';

export class MediaFiles {
  private readonly memory=new Map<string,Buffer>();
  readonly directory:string|null;
  constructor(databasePath:string) {this.directory=databasePath===':memory:'?null:`${resolve(databasePath)}.media`;}
  private path(attachment:ImageAttachment) {
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(attachment.id)||!extensions[attachment.mimeType]) throw new Error('媒体附件不存在。');
    return this.directory?join(this.directory,`${attachment.id}.${extensions[attachment.mimeType]}`):null;
  }
  save(file:{bytes:Buffer;mimeType:string;filename:string},source:ImageAttachment['source']):ImageAttachment {
    const actual=file.mimeType.startsWith('image/')?inspectImage(file.bytes):inspectAudio(file.bytes);
    if(actual.mimeType!==file.mimeType) return fail();
    const attachment={id:randomUUID(),filename:cleanFilename(file.filename),mimeType:file.mimeType,source};
    const path=this.path(attachment);
    if(path) {
      mkdirSync(this.directory!,{recursive:true,mode:0o700});
      const directory=lstatSync(this.directory!);
      if(!directory.isDirectory()||directory.isSymbolicLink()) throw new Error('本机媒体目录不可用。');
      chmodSync(this.directory!,0o700);writeFileSync(path,file.bytes,{mode:0o600,flag:'wx'});
    } else this.memory.set(attachment.id,Buffer.from(file.bytes));
    return attachment;
  }
  read(attachment:ImageAttachment):{bytes:Buffer;mimeType:string;filename:string} {
    const path=this.path(attachment);
    let bytes:Buffer;
    if(path) {
      if(!existsSync(path)) throw new Error('本机媒体文件已不存在，请重新读取或上传。');
      const info=lstatSync(path);
      if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>MAX_MEDIA_BYTES) return fail();
      bytes=readFileSync(path);
    } else {
      const stored=this.memory.get(attachment.id);if(!stored) throw new Error('媒体附件不存在。');bytes=Buffer.from(stored);
    }
    const actual=attachment.mimeType.startsWith('image/')?inspectImage(bytes):inspectAudio(bytes);
    if(actual.mimeType!==attachment.mimeType) return fail();
    return {bytes,mimeType:actual.mimeType,filename:attachment.filename};
  }
  delete(attachment?:ImageAttachment) {
    if(!attachment) return;
    const path=this.path(attachment);
    if(path) {try{unlinkSync(path);}catch{/* Already removed. */}}
    this.memory.delete(attachment.id);
  }
  prune(attachments:(ImageAttachment|undefined)[]){
    const keep=new Set(attachments.filter((a):a is ImageAttachment=>!!a).map(a=>a.id));
    for(const key of this.memory.keys())if(!keep.has(key))this.memory.delete(key);
    if(!this.directory||!existsSync(this.directory))return;
    const info=lstatSync(this.directory);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('本机媒体目录不可用。');
    for(const name of readdirSync(this.directory)){
      const match=/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(?:png|jpg|gif|webp|wav|mp3|m4a|3gp|aac|ogg|webm|amr)$/.exec(name);
      if(match&&!keep.has(match[1])){try{unlinkSync(join(this.directory,name));}catch{/* Best effort; retained files stay private. */}}
    }
  }
}
