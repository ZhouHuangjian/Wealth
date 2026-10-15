import { createHash } from 'node:crypto';
import type { ImageRecognition, ImageRecognitionCacheEntry, Settings } from '../shared/types.js';
import { modelEndpoint } from './model-config.js';

// Bump when the observation prompt or its interpretation changes.
const PROMPT_VERSION = 'image-observation-v1';
export const MAX_IMAGE_RECOGNITION_HISTORY = 100;
type Identity = Pick<ImageRecognitionCacheEntry, 'imageSha256' | 'modelIdentity'>;

export const imageSha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Local reuse does not need a key or authorization for another remote call. */
export function imageRecognitionIdentity(settings: Settings, bytes: Buffer): Identity | null {
  const vision = settings.vision;
  if (!vision || vision.provider === 'disabled') return null;
  const endpoint = vision.provider === 'codex' ? 'local-codex'
    : modelEndpoint({provider:vision.provider,modelUrl:vision.modelUrl,allowRemoteModel:true}).href;
  const modelIdentity = createHash('sha256').update(JSON.stringify([
    PROMPT_VERSION, vision.provider, vision.modelName.trim(), endpoint,
  ])).digest('hex');
  return {imageSha256: imageSha256(bytes), modelIdentity};
}

export function findImageRecognition(history: ImageRecognitionCacheEntry[] | undefined, identity: Identity | null): ImageRecognition | undefined {
  if (!identity) return undefined;
  return history?.find(entry => entry.imageSha256 === identity.imageSha256 && entry.modelIdentity === identity.modelIdentity)?.recognition;
}

export function saveImageRecognition(history: ImageRecognitionCacheEntry[] | undefined, identity: Identity, recognition: ImageRecognition): ImageRecognitionCacheEntry[] {
  return [...(history ?? []).filter(entry => entry.imageSha256 !== identity.imageSha256 || entry.modelIdentity !== identity.modelIdentity),
    {...identity, recognition}].slice(-MAX_IMAGE_RECOGNITION_HISTORY);
}
