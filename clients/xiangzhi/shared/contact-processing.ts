import type { Conversation, Settings } from './types.js';

/** Automatic media handling is opt-in for each contact, including older records. */
export function contactAutoMediaEnabled(conversation: Conversation | undefined, kind: 'image' | 'voice'): boolean {
  return (kind === 'image' ? conversation?.processing?.autoRecognizeImages : conversation?.processing?.autoTranscribeVoice) === true;
}

/** Credentials and endpoints stay global; only choices and automatic media are scoped. */
export function effectiveContactSettings<T extends Pick<Settings, 'replyModels' | 'autoRecognizeImages' | 'autoTranscribeVoice'>>(settings: T, conversation?: Conversation): T {
  return {...settings,
    replyModels: conversation?.processing?.replyModels ?? settings.replyModels,
    autoRecognizeImages: contactAutoMediaEnabled(conversation, 'image'),
    autoTranscribeVoice: contactAutoMediaEnabled(conversation, 'voice'),
  };
}

export function contactUsesDemo(settings: Pick<Settings, 'provider' | 'replyModels' | 'autoRecognizeImages' | 'autoTranscribeVoice'>, conversation?: Conversation): boolean {
  const selected = effectiveContactSettings(settings, conversation).replyModels;
  return selected?.length ? selected.some(choice => choice.provider === 'demo') : settings.provider === 'demo';
}
