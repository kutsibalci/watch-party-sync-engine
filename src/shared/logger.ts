import { pino } from 'pino';
import type { LoggerOptions } from 'pino';
import { config, isDevelopment } from './config.ts';

const baseOptions: LoggerOptions = {
  level: config.LOG_LEVEL,

  // Üretimde zaman damgası ISO-8601 olsun; log toplayıcılar bunu bekler.
  timestamp: pino.stdTimeFunctions.isoTime,

  // Kazara log'a düşen sırları maskele. Bu listeyi büyütmeyi alışkanlık edinin.
  redact: {
    paths: [
      'password',
      'passwordHash',
      'password_hash',
      'token',
      'accessToken',
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
    ],
    censor: '[gizlendi]',
  },

  formatters: {
    // Varsayılan `level: 30` yerine `level: "info"` — insan ve Loki dostu
    level: (label) => ({ level: label }),
  },
};

export function createLogger(service: string) {
  return pino({
    ...baseOptions,
    base: { service, pid: process.pid },
    ...(isDevelopment
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss.l',
              ignore: 'pid,hostname,service',
              messageFormat: '[{service}] {msg}',
            },
          },
        }
      : {}),
  });
}

export type Logger = ReturnType<typeof createLogger>;
