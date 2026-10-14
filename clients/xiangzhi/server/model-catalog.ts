import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { unavailableModelCatalog, type ModelCatalog, type ModelOption } from '../shared/model-catalog.js';

const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 100;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const unsafeText = /[\u0000-\u001f\u007f]|(?:sk-|Bearer\s)/i;

/** Project only public picker fields. Cache identity, prompts and tools stay private. */
export function modelCatalogFromCache(raw: unknown): ModelCatalog {
  const result = unavailableModelCatalog();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  const cache = raw as Record<string, unknown>;
  if (!Array.isArray(cache.models) || cache.models.length > MAX_MODELS) return result;
  const models: ModelOption[] = [];
  const seen = new Set<string>();
  for (const value of cache.models) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const model = value as Record<string, unknown>;
    if (model.visibility !== 'list' || typeof model.slug !== 'string' || !MODEL_ID.test(model.slug)
      || unsafeText.test(model.slug) || seen.has(model.slug)) continue;
    const inputModalities: ModelOption['inputModalities'] = [];
    if (Array.isArray(model.input_modalities)) {
      for (const modality of ['text', 'image'] as const) {
        if (model.input_modalities.includes(modality)) inputModalities.push(modality);
      }
    }
    if (!inputModalities.length) continue;
    const display = typeof model.display_name === 'string' ? model.display_name.trim() : '';
    const label = display && display.length <= 160 && !unsafeText.test(display) ? display : model.slug;
    models.push({ id: model.slug, label, inputModalities });
    seen.add(model.slug);
  }
  if (!models.length) return result;
  const fetched = typeof cache.fetched_at === 'string' ? Date.parse(cache.fetched_at) : NaN;
  return { ...result, codex: { source: 'local-cache', models,
    fetchedAt: Number.isFinite(fetched) ? new Date(fetched).toISOString() : null, audioSupported: false } };
}

/** Read the CLI's existing cache only; no login, provider call or token use. */
export async function readModelCatalog(options: { codexHome?: string } = {}): Promise<ModelCatalog> {
  const home = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  if (!isAbsolute(home) || home.includes('\0')) return unavailableModelCatalog();
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(join(home, 'models_cache.json'), 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_CACHE_BYTES) return unavailableModelCatalog();
    // A bounded read remains bounded if the cache grows after stat().
    const bytes = Buffer.alloc(MAX_CACHE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const part = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!part.bytesRead) break;
      offset += part.bytesRead;
    }
    if (offset > MAX_CACHE_BYTES) return unavailableModelCatalog();
    return modelCatalogFromCache(JSON.parse(bytes.subarray(0, offset).toString('utf8')));
  } catch { return unavailableModelCatalog(); }
  finally { await file?.close().catch(() => {}); }
}
