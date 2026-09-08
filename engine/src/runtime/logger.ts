/**
 * Structured logging with mandatory redaction.
 *
 * Logs are an exfiltration path like any other, so the redactor is part of the
 * logger rather than a caller responsibility: content fields, original media
 * keys, raw transcripts and credentials can never be logged even by mistake.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly correlationId?: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly at: string;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/** Keys whose values must never appear in a log line, in any casing or shape. */
export const SENSITIVE_KEYS: readonly string[] = [
  'original_key',
  'originalkey',
  'original_url',
  'originalurl',
  'raw_text',
  'rawtext',
  'raw_transcript',
  'body_text',
  'bodytext',
  'body',
  'excerpt',
  'searchable_text',
  'transcript',
  'email',
  'password',
  'token',
  'upload_token',
  'playback_url',
  'playbackurl',
  'signed_url',
  'authorization',
  'alias_name',
  'aliasname',
];

export const REDACTED = '[redacted]';

const isSensitive = (key: string): boolean => SENSITIVE_KEYS.includes(key.toLowerCase());

export const redact = (value: unknown, depth = 0): unknown => {
  if (depth > 8) return REDACTED;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitive(key) ? REDACTED : redact(entry, depth + 1);
  }
  return out;
};

export interface MemoryLogger extends Logger {
  readonly records: readonly LogRecord[];
  clear(): void;
}

export const createMemoryLogger = (
  baseFields: Record<string, unknown> = {},
  sink: LogRecord[] = [],
): MemoryLogger => {
  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    const merged = { ...baseFields, ...(fields ?? {}) };
    const redacted = redact(merged) as Record<string, unknown>;
    const correlationId = typeof merged['correlationId'] === 'string' ? merged['correlationId'] : undefined;
    sink.push({
      level,
      message,
      ...(correlationId === undefined ? {} : { correlationId }),
      fields: redacted,
      at: new Date(0).toISOString(),
    });
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (fields) => createMemoryLogger({ ...baseFields, ...fields }, sink),
    get records() {
      return sink;
    },
    clear: () => {
      sink.length = 0;
    },
  };
};

export const createConsoleLogger = (baseFields: Record<string, unknown> = {}): Logger => {
  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    const payload = {
      level,
      message,
      at: new Date().toISOString(),
      ...(redact({ ...baseFields, ...(fields ?? {}) }) as Record<string, unknown>),
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (fields) => createConsoleLogger({ ...baseFields, ...fields }),
  };
};
