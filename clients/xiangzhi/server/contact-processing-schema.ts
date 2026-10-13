import { z } from 'zod';

export const replyModelsSchema = z.array(z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/),
  provider: z.enum(['demo', 'ollama', 'compatible', 'codex']),
  modelName: z.string().trim().max(200),
  modelPreset: z.enum(['custom', 'qwen']).optional(),
  label: z.string().trim().max(80).optional(),
}).strict()).max(4).refine(items => new Set(items.map(item => item.id)).size === items.length);

export const contactProcessingPatchSchema = z.object({
  replyModels: replyModelsSchema.nullable().optional(),
  autoRecognizeImages: z.boolean().optional(),
  autoTranscribeVoice: z.boolean().optional(),
}).strict();
