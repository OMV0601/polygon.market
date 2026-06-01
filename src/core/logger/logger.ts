import winston from 'winston';
import path from 'path';
import { env } from '../../config/env';

const { combine, timestamp, json, colorize, simple, errors } = winston.format;

const redactSecrets = winston.format((info) => {
  const sensitive = /token|key|secret|password|wallet|address|bearer/i;
  function scrub(obj: unknown, depth = 0): unknown {
    if (depth > 5 || obj === null || typeof obj !== 'object') return obj;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = sensitive.test(k) ? '[REDACTED]' : scrub(v, depth + 1);
    }
    return out;
  }
  return scrub(info) as winston.Logform.TransformableInfo;
})();

const fileTransport = new winston.transports.File({
  filename: path.resolve(process.cwd(), 'logs', 'system.log'),
  format: combine(errors({ stack: true }), timestamp(), redactSecrets, json()),
  maxsize: 10 * 1024 * 1024,   // 10 MB per file
  maxFiles: 5,
  tailable: true,
});

const consoleTransport = new winston.transports.Console({
  format: combine(
    colorize({ all: true }),
    timestamp({ format: 'HH:mm:ss' }),
    simple()
  ),
});

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  transports: [consoleTransport, fileTransport],
  exceptionHandlers: [fileTransport],
  rejectionHandlers: [fileTransport],
});

export type Logger = typeof logger;
