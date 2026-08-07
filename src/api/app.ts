import path from 'node:path';
import Fastify from 'fastify';
import type { FastifyError, FastifyInstance, FastifyBaseLogger } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';

import { config, isDevelopment } from '../shared/config.ts';
import { createLogger } from '../shared/logger.ts';
import { isAppError } from '../shared/errors.ts';
import { httpRequestDuration, httpRequestsTotal } from '../shared/metrics.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerRoomRoutes } from './routes/rooms.ts';
import { registerVideoRoutes } from './routes/videos.ts';

// Logger'ı FastifyBaseLogger olarak tipliyoruz. Somut pino tipini doğrudan
// verirsek Fastify'ın Logger generic'i özelleşir ve bu instance varsayılan
// `FastifyInstance` bekleyen eklenti/rota fonksiyonlarıyla uyumsuz hâle gelir.
const logger: FastifyBaseLogger = createLogger('api');

export function buildApp(): FastifyInstance {
  const app = Fastify({
    loggerInstance: logger,
    // Ters proxy arkasında gerçek istemci IP'sini almak için (Faz 4: rate limit)
    trustProxy: true,
    // İstek gövdesi tavanı — yükleme akışı presigned URL ile storage'a gider,
    // API'den asla büyük dosya geçmez.
    bodyLimit: 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  app.register(cors, {
    origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(','),
    credentials: true,
  });

  // ------------------------------------------------------------- Metrikler
  app.addHook('onResponse', async (req, reply) => {
    // routeOptions.url şablonu ('/api/rooms/:id') kullanılır; ham URL kullanmak
    // her id için ayrı zaman serisi yaratıp Prometheus'u patlatır (kardinalite).
    const route = req.routeOptions?.url ?? 'unmatched';
    const labels = {
      method: req.method,
      route,
      status: String(reply.statusCode),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, reply.elapsedTime / 1000);
  });

  // ---------------------------------------------------------- Hata yönetimi
  app.setErrorHandler((err: FastifyError, req, reply) => {
    // 1) Şema doğrulama hataları
    if (err.validation) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'İstek doğrulanamadı', details: err.validation },
        requestId: req.id,
      });
    }

    // 2) Bizim fırlattığımız beklenen hatalar
    if (isAppError(err)) {
      if (err.statusCode >= 500) req.log.error({ err }, 'Uygulama hatası (5xx)');
      else req.log.info({ code: err.code, msg: err.message }, 'İstemci hatası');

      return reply.status(err.statusCode).send({
        error: {
          code: err.code,
          message: err.expose ? err.message : 'Beklenmeyen bir hata oluştu',
          ...(err.expose && err.details ? { details: err.details } : {}),
        },
        requestId: req.id,
      });
    }

    // 3) Beklenmeyen her şey. Detay ASLA istemciye sızmaz.
    req.log.error({ err }, 'Yakalanmamış hata');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Beklenmeyen bir hata oluştu',
        ...(isDevelopment ? { debug: err.message } : {}),
      },
      requestId: req.id,
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `${req.method} ${req.url} bulunamadı` },
      requestId: req.id,
    });
  });

  // ---------------------------------------------------------------- Rotalar
  app.register(registerHealthRoutes);
  app.register(registerAuthRoutes, { prefix: '/api/auth' });
  app.register(registerRoomRoutes, { prefix: '/api/rooms' });
  app.register(registerVideoRoutes, { prefix: '/api/videos' });

  // Test istemcisi. Ayrı bir frontend sunucusu kurmamak için API'den
  // servis ediliyor — Faz 1'in amacı senkronu göstermek, build zinciri kurmak değil.
  //
  // Prefix '/' DEĞİL '/app': kök prefix bir joker (wildcard) rota yaratır ve
  // eşleşmeyen her isteği yakalayarak JSON 404 davranışımızı gölgeler.
  app.register(fastifyStatic, {
    root: path.resolve(import.meta.dirname, '..', '..', 'public'),
    prefix: '/app/',
    index: 'index.html',
  });

  app.get('/', async (_req, reply) => reply.redirect('/app/', 302));

  return app;
}

export type ApiApp = ReturnType<typeof buildApp>;
