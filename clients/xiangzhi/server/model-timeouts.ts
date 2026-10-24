// A single bounded model call can take longer than an ordinary short reply.
export const CONTACT_MODEL_TIMEOUT_MS = 180_000;
// Full-history jobs may need several calls. Leave a minute before the server's
// existing 15-minute command expiry for delivery and acknowledgement.
export const HISTORY_JOB_TIMEOUT_MS = 14 * 60_000;
