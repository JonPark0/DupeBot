// Shared constants without side effects (config.ts reads the environment on import).
export const RESPONSE_MODES = ['forward', 'reply', 'react', 'sticker'] as const;
export type ResponseMode = (typeof RESPONSE_MODES)[number];
