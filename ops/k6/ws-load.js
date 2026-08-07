/**
 * Faz 4 — WebSocket yük testi.
 *
 * Amaç "çok kullanıcı bağlandı" demek değil; KIRILMA NOKTASINI bulmak.
 * Kademeli olarak bağlantı sayısını artırıp p99 yayın gecikmesinin nerede
 * bozulduğunu ölçüyoruz.
 *
 * Ölçülen asıl metrik `broadcast_latency`: bir istemci PLAY gönderdiğinde,
 * sunucunun yayınladığı STATE'in AYNI istemciye dönmesi ne kadar sürüyor.
 * Bu, "komut → Redis Lua → PUBLISH → abone instance → soket" yolunun tamamını
 * kapsar; sadece HTTP gecikmesi değil, gerçek fan-out maliyeti.
 *
 * Çalıştırma (host'a k6 kurmadan):
 *   docker compose --profile load run --rm k6 run /scripts/ws-load.js
 *
 * Ayarlar (ortam değişkeni):
 *   TARGET_VUS   zirve sanal kullanıcı sayısı (varsayılan 600)
 *   ROOM_COUNT   kaç odaya dağıtılsın (varsayılan 60 → oda başına ~10 kişi)
 *   WS_URLS      virgülle ayrılmış realtime adresleri (birden fazlaysa dağıtılır)
 *   API_URL      API adresi
 */
import ws from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';
import exec from 'k6/execution';

const API_URL = __ENV.API_URL || 'http://api:8090';
const WS_URLS = (__ENV.WS_URLS || 'ws://realtime:8091/ws').split(',');
const TARGET_VUS = Number(__ENV.TARGET_VUS || 600);
const ROOM_COUNT = Number(__ENV.ROOM_COUNT || 60);

// --------------------------------------------------------------- Metrikler
const broadcastLatency = new Trend('broadcast_latency', true);
const helloLatency = new Trend('hello_latency', true);
const clockRtt = new Trend('clock_rtt', true);
const wsConnectErrors = new Counter('ws_connect_errors');
const wsMessages = new Counter('ws_messages_received');
const commandDelivered = new Rate('command_delivered');

/** QUICK=1 → script'i doğrulamak için 40 saniyelik kısa koşu. */
const QUICK = __ENV.QUICK === '1';

const STAGES = QUICK
  ? [
      { duration: '15s', target: TARGET_VUS },
      { duration: '15s', target: TARGET_VUS },
      { duration: '10s', target: 0 },
    ]
  : [
      { duration: '30s', target: Math.round(TARGET_VUS * 0.15) },
      { duration: '45s', target: Math.round(TARGET_VUS * 0.35) },
      { duration: '45s', target: Math.round(TARGET_VUS * 0.6) },
      { duration: '60s', target: TARGET_VUS },
      { duration: '45s', target: TARGET_VUS }, // zirvede tut
      { duration: '20s', target: 0 },
    ];

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: STAGES,
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    // Bunlar HEDEF, garanti değil. Aşılırsa k6 çıkış kodu 99 döner ve
    // kırılma noktasını bulmuş oluruz — testin amacı da bu.
    'broadcast_latency': ['p(95)<250', 'p(99)<500'],
    'command_delivered': ['rate>0.98'],
    'ws_connect_errors': ['count<10'],
  },
  // k6'nın varsayılan trend istatistikleri p(99) ve count İÇERMEZ. Kırılma
  // noktası aramanın tamamı p99'da olduğu için açıkça istiyoruz.
  summaryTrendStats: ['min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  noConnectionReuse: false,
  discardResponseBodies: false,
};

/**
 * setup() bir kez çalışır: test kullanıcılarını ve odaları hazırlar.
 * Bunu VU içinde yapsaydık ölçtüğümüz şeyin yarısı kayıt/oda oluşturma olurdu.
 */
export function setup() {
  const stamp = Date.now();
  const password = 'CokGizliParola123';

  const owner = http.post(
    `${API_URL}/api/auth/register`,
    JSON.stringify({
      email: `k6-owner-${stamp}@example.com`,
      password,
      displayName: 'k6 Owner',
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  if (owner.status !== 201) throw new Error(`kullanıcı oluşturulamadı: ${owner.status} ${owner.body}`);
  const token = owner.json('accessToken');

  const rooms = [];
  for (let i = 0; i < ROOM_COUNT; i++) {
    const res = http.post(
      `${API_URL}/api/rooms`,
      JSON.stringify({ name: `k6 oda ${i}`, youtubeVideoId: 'aqz-KE-bpKQ' }),
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } },
    );
    if (res.status !== 201) throw new Error(`oda oluşturulamadı: ${res.status} ${res.body}`);
    rooms.push(res.json('room.slug'));
  }

  console.log(`setup: ${ROOM_COUNT} oda hazır, hedef ${TARGET_VUS} VU, ${WS_URLS.length} realtime instance`);
  return { token, rooms };
}

export default function (data) {
  const vu = exec.vu.idInTest;
  const slug = data.rooms[vu % data.rooms.length];
  // VU'ları instance'lara eşit dağıt — tek instance'ı boğup diğerini boş
  // bırakmak ölçümü anlamsız kılar.
  const wsUrl = WS_URLS[vu % WS_URLS.length];

  // Bilet al. Bu aynı zamanda API'nin yük altındaki davranışını da ölçer.
  const ticketRes = http.post(
    `${API_URL}/api/rooms/${slug}/ticket`,
    null,
    { headers: { Authorization: `Bearer ${data.token}` }, tags: { endpoint: 'ticket' } },
  );
  if (ticketRes.status !== 200) {
    wsConnectErrors.add(1);
    sleep(1);
    return;
  }
  const ticket = ticketRes.json('ticket');

  const url = `${wsUrl}?room=${encodeURIComponent(slug)}&ticket=${encodeURIComponent(ticket)}`;
  const openedAt = Date.now();

  const res = ws.connect(url, {}, function (socket) {
    let helloSeen = false;
    /** Gönderdiğimiz komutların zaman damgaları: version yerine sıra ile eşleştiriyoruz. */
    let pendingCommandAt = null;
    let pingSentAt = null;

    socket.on('open', function () {
      // Saat senkronu — gerçek istemci de bunu yapar, yükü temsil etmeli.
      // Periyodik gönderiyoruz: tek seferlik ölçüm zirvedeki gecikmeyi kaçırır.
      socket.setInterval(function () {
        pingSentAt = Date.now();
        socket.send(JSON.stringify({ type: 'PING', t0: pingSentAt }));
      }, 6000);
      pingSentAt = Date.now();
      socket.send(JSON.stringify({ type: 'PING', t0: pingSentAt }));

      // Her VU periyodik olarak komut gönderir. Hepsi aynı anda göndermesin
      // diye rastgele bir faz kaydırması veriyoruz.
      socket.setTimeout(function () {
        socket.setInterval(function () {
          pendingCommandAt = Date.now();
          // Oda içindeki herkese fan-out üretecek gerçek bir komut
          socket.send(JSON.stringify({
            type: 'SEEK',
            positionMs: Math.floor(Math.random() * 600000),
          }));
        }, 5000);
      }, Math.random() * 5000);

      // Gerçek istemci gibi kalp atışı gönder (drift metriğini de besler)
      socket.setInterval(function () {
        socket.send(JSON.stringify({
          type: 'HEARTBEAT',
          positionMs: 1000,
          driftMs: Math.round((Math.random() - 0.5) * 200),
        }));
      }, 4000);
    });

    socket.on('message', function (raw) {
      wsMessages.add(1);
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === 'HELLO' && !helloSeen) {
        helloSeen = true;
        helloLatency.add(Date.now() - openedAt);
        return;
      }

      if (msg.type === 'PONG') {
        const t3 = Date.now();
        // RTT = toplam gidiş-dönüş − sunucunun işlem süresi
        clockRtt.add(t3 - msg.t0 - (msg.t2 - msg.t1));
        return;
      }

      if (msg.type === 'STATE' && pendingCommandAt !== null) {
        broadcastLatency.add(Date.now() - pendingCommandAt);
        commandDelivered.add(true);
        pendingCommandAt = null;
      }
    });

    socket.on('error', function (e) {
      if (e.error() !== 'websocket: close sent') wsConnectErrors.add(1);
    });

    // Her VU 60 saniye bağlı kalır; ramp sırasında bağlantılar birikir.
    socket.setTimeout(function () {
      socket.close();
    }, 60000);
  });

  check(res, { 'ws bağlantısı kuruldu (101)': (r) => r && r.status === 101 });
  if (!res || res.status !== 101) wsConnectErrors.add(1);
}

export function handleSummary(data) {
  const m = data.metrics;
  const get = (name, stat) => {
    const v = m[name]?.values?.[stat];
    return v === undefined ? null : Math.round(v * 100) / 100;
  };

  const summary = {
    hedefVU: TARGET_VUS,
    odaSayisi: ROOM_COUNT,
    instanceSayisi: WS_URLS.length,
    maksEszamanliVU: get('vus_max', 'value'),
    yayinGecikmesiMs: {
      p50: get('broadcast_latency', 'med'),
      p95: get('broadcast_latency', 'p(95)'),
      p99: get('broadcast_latency', 'p(99)'),
      max: get('broadcast_latency', 'max'),
      ornekSayisi: get('broadcast_latency', 'count'),
    },
    helloGecikmesiMs: {
      p50: get('hello_latency', 'med'),
      p95: get('hello_latency', 'p(95)'),
      p99: get('hello_latency', 'p(99)'),
    },
    saatRttMs: {
      p50: get('clock_rtt', 'med'),
      p95: get('clock_rtt', 'p(95)'),
    },
    // TEŞHİS: bilet için yapılan basit HTTP çağrısı. Bu da saniyelere
    // çıkıyorsa darboğaz WebSocket yolunda değil, sistemin tamamındadır
    // (host CPU'su veya k6'nın kendisi) — ayrımı bu metrik yapar.
    httpIstekMs: {
      p50: get('http_req_duration', 'med'),
      p95: get('http_req_duration', 'p(95)'),
      p99: get('http_req_duration', 'p(99)'),
      max: get('http_req_duration', 'max'),
    },
    iterasyonMs: {
      p95: get('iteration_duration', 'p(95)'),
    },
    teslimOrani: get('command_delivered', 'rate'),
    baglantiHatasi: get('ws_connect_errors', 'count'),
    alinanMesaj: get('ws_messages_received', 'count'),
    esiklerGecti: Object.values(data.metrics).every(
      (metric) => !metric.thresholds || Object.values(metric.thresholds).every((t) => t.ok !== false),
    ),
  };

  const lines = [
    '',
    '  ═══ k6 WebSocket yük testi özeti ═══',
    '',
    `  Hedef VU              ${summary.hedefVU}   (maks eşzamanlı: ${summary.maksEszamanliVU})`,
    `  Oda / instance        ${summary.odaSayisi} oda · ${summary.instanceSayisi} realtime`,
    `  Alınan mesaj          ${summary.alinanMesaj}`,
    '',
    '  Yayın gecikmesi (komut → kendi soketine dönen STATE)',
    `    p50 ${summary.yayinGecikmesiMs.p50} ms`,
    `    p95 ${summary.yayinGecikmesiMs.p95} ms`,
    `    p99 ${summary.yayinGecikmesiMs.p99} ms`,
    `    max ${summary.yayinGecikmesiMs.max} ms   (${summary.yayinGecikmesiMs.ornekSayisi} örnek)`,
    '',
    `  HELLO gecikmesi       p50 ${summary.helloGecikmesiMs.p50} ms · p95 ${summary.helloGecikmesiMs.p95} ms · p99 ${summary.helloGecikmesiMs.p99} ms`,
    `  HTTP (bilet) [teşhis] p50 ${summary.httpIstekMs.p50} ms · p95 ${summary.httpIstekMs.p95} ms · max ${summary.httpIstekMs.max} ms`,
    `  Saat RTT              p50 ${summary.saatRttMs.p50} ms · p95 ${summary.saatRttMs.p95} ms`,
    `  Komut teslim oranı    ${(summary.teslimOrani * 100).toFixed(2)}%`,
    `  Bağlantı hatası       ${summary.baglantiHatasi}`,
    '',
    `  Eşikler: ${summary.esiklerGecti ? 'GEÇTİ' : 'AŞILDI — kırılma noktası bulundu'}`,
    '',
  ];

  const out = {};
  out.stdout = lines.join('\n');
  out[__ENV.OUT || '/results/summary.json'] = JSON.stringify(summary, null, 2);
  return out;
}
