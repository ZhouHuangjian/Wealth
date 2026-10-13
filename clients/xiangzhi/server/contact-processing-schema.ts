import { z } from 'zod';

const replyModelSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/),
  provider: z.enum(['demo', 'ollama', 'compatible', 'codex']),
  modelName: z.string().trim().max(200),
  modelPreset: z.enum(['custom', 'qwen']).optional(),
  label: z.string().trim().max(80).optional(),
}).strict();
export const replyModelsSchema = z.array(replyModelSchema).max(4).refine(items => new Set(items.map(item => item.id)).size === items.length);
const contactModelChoiceSchema=replyModelSchema.refine(choice=>['compatible','codex'].includes(choice.provider),'分析和记忆请选择千问、兼容接口或 Codex。');

export const contactProcessingPatchSchema = z.object({
  replyModels: replyModelsSchema.nullable().optional(),
  autoRecognizeImages: z.boolean().optional(),
  autoTranscribeVoice: z.boolean().optional(),
  intentEnabled:z.boolean().optional(),affinityEnabled:z.boolean().optional(),memoryEnabled:z.boolean().optional(),
  autoAnalyzeMessages:z.boolean().optional(),autoCompressMemory:z.boolean().optional(),
  analysisModel:contactModelChoiceSchema.nullable().optional(),memoryModel:contactModelChoiceSchema.nullable().optional(),
}).strict();
