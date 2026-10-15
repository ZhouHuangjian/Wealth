import {createHash} from 'node:crypto';
import type {Message} from '../shared/types.js';
import {messageEmojiRecognition} from '../shared/emoji.js';

/** A memory's evidence must still describe the source that the user reviewed. */
export function messageEvidenceHash(message:Message):string {
  const evidence:unknown[]=[message.id,message.conversationId,message.role,message.text,message.kind??'text',message.mediaStatus??null,message.sourceFingerprint??null,message.imageRecognition??null,message.audioRecognition??null];
  const emoji=messageEmojiRecognition(message);
  if(emoji)evidence.push({tokens:emoji.tokens,parserVersion:emoji.parserVersion});
  if(message.kind==='emoji'&&message.wechatEmoji?.md5)evidence.push({stickerMd5:message.wechatEmoji.md5});
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}
