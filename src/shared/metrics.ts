import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

/** HTTP istek süresi. Faz 4'te p50/p95/p99 buradan okunacak. */
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP istek süresi (saniye)',
  labelNames: ['method', 'route', 'status'] as const,
  // Web API için anlamlı kova sınırları: 5ms'ten 5sn'ye
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Toplam HTTP istek sayısı',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

/**
 * Faz 1/3'te doldurulacak realtime metrikleri.
 * Şimdiden tanımlıyoruz ki Grafana panoları baştan kurulabilsin.
 */
export const wsActiveConnections = new Gauge({
  name: 'ws_active_connections',
  help: 'Açık WebSocket bağlantısı sayısı',
  registers: [registry],
});

export const wsActiveRooms = new Gauge({
  name: 'ws_active_rooms',
  help: 'Bu instance üzerinde en az bir üyesi olan oda sayısı',
  registers: [registry],
});

/**
 * Bağlantı kurulumunun SUNUCU TARAFINDAKİ maliyeti: bilet doğrulama, oda
 * yükleme, Redis'e katılım ve üye listesini okuma.
 *
 * Bu metrik bir ayrım aracıdır: HELLO gecikmesi yüksekken bu düşükse gecikme
 * bizim kodumuzda DEĞİL, ondan önceki katmandadır (TCP/WS el sıkışma, accept
 * kuyruğu, istemci). Yüksekse darboğaz Redis çağrılarımızdadır.
 */
export const wsJoinDuration = new Histogram({
  name: 'ws_join_duration_ms',
  help: 'WebSocket katılımının sunucu tarafındaki süresi (ms)',
  labelNames: ['phase'] as const,
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 5000],
  registers: [registry],
});

export const wsBroadcastLatency = new Histogram({
  name: 'ws_broadcast_latency_ms',
  help: 'Komut alımından odaya yayına kadar geçen süre (ms)',
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [registry],
});

/**
 * Projeye özgü en değerli metrik: istemcinin hedef pozisyondan sapması.
 * Faz 1'de üretilmeye başlanacak, README'deki grafiğin kaynağı bu olacak.
 */
export const syncDriftMs = new Histogram({
  name: 'sync_drift_ms',
  help: 'İstemcinin hedef oynatma pozisyonundan mutlak sapması (ms)',
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [registry],
});

/** Faz 2'de doldurulacak kuyruk/transkod metrikleri. */
export const jobsProcessedTotal = new Counter({
  name: 'jobs_processed_total',
  help: 'İşlenen iş sayısı',
  labelNames: ['type', 'outcome'] as const, // outcome: succeeded | failed | dead
  registers: [registry],
});

export const jobRetriesTotal = new Counter({
  name: 'job_retries_total',
  help: 'Yeniden denenen iş sayısı',
  labelNames: ['type'] as const,
  registers: [registry],
});

export const transcodeDuration = new Histogram({
  name: 'transcode_duration_seconds',
  help: 'Transkod süresi (saniye)',
  buckets: [1, 5, 15, 30, 60, 120, 300, 600],
  registers: [registry],
});

export async function metricsText(): Promise<string> {
  return registry.metrics();
}

export const metricsContentType = registry.contentType;
