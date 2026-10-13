import {createHash} from 'node:crypto';
import type {Message} from '../shared/types.js';

/** A memory's evidence must still describe the source that the user reviewed. */
export function messageEvidenceHash(message:Message):string {
  return createHash('sha256').update(JSON.stringify([message.id,message.conversationId,message.role,message.text,message.kind??'text',message.mediaStatus??null,message.sourceFingerprint??null,message.imageRecognition??null,message.audioRecognition??null])).digest('hex');
}
