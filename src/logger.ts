// Minimal leveled logger. Reads LOG_LEVEL itself so pure modules can log without loading config.
type Level = 'error' | 'warn' | 'info' | 'debug';

const LEVELS: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[(process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level] ?? LEVELS.info;

function emit(level: Level, args: unknown[]) {
  if (LEVELS[level] > threshold) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}]`;
  if (level === 'error') console.error(line, ...args);
  else if (level === 'warn') console.warn(line, ...args);
  else console.log(line, ...args);
}

export const logger = {
  error: (...args: unknown[]) => emit('error', args),
  warn: (...args: unknown[]) => emit('warn', args),
  info: (...args: unknown[]) => emit('info', args),
  debug: (...args: unknown[]) => emit('debug', args),
};
