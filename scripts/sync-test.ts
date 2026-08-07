/**
 * Faz 1 senkron motoru testi.
 *
 * İki WebSocket istemcisi açar ve senkron motorunun sözleşmesini doğrular:
 * saat senkronu, versiyon monotonluğu, komut yayını, pozisyon yakınsaması,
 * yetki kontrolü ve host devri (leader election).
 *
 * Kullanım:  npm run sync-test     (api + realtime ayakta olmalı)
 *
 * Bunu iki tarayıcı sekmesi açmaya tercih ediyoruz: tekrarlanabilir,
 * ölçülebilir ve Faz 4'teki k6 yük testinin temelini oluşturuyor.
 */
import { WebSocket } from 'ws';

import {
  computeClockSample,
  effectivePositionMs,
  type ClockSample,
  type Member,
  type PlaybackState,
  type ServerMessage,
} from '../src/shared/protocol.ts';

const API = process.env.SMOKE_API_URL ?? 'http://127.0.0.1:8090';
const WS = process.env.SYNC_WS_URL ?? 'ws://127.0.0.1:8091/ws';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[90m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const detail = await fn();
    passed++;
    process.stdout.write(`  ${GREEN}✓${RESET} ${name}${detail ? `  ${DIM}${detail}${RESET}` : ''}\n`);
  } catch (err) {
    failed++;
    process.stdout.write(
      `  ${RED}✗${RESET} ${name}\n    ${RED}${err instanceof Error ? err.message : String(err)}${RESET}\n`,
    );
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- HTTP yardımcı
async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// --------------------------------------------------------- WS test istemcisi
type Waiter = {
  predicate: (m: ServerMessage) => boolean;
  resolve: (m: ServerMessage) => void;
  reject: (e: Error) => void;
  label: string;
  timer: NodeJS.Timeout;
};

class TestClient {
  readonly label: string;
  private socket!: WebSocket;
  readonly received: ServerMessage[] = [];
  private waiters: Waiter[] = [];
  closedCode: number | null = null;

  constructor(label: string) {
    this.label = label;
  }

  async connect(slug: string, token: string): Promise<void> {
    const url = `${WS}?room=${encodeURIComponent(slug)}&token=${encodeURIComponent(token)}`;
    this.socket = new WebSocket(url);

    this.socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      this.received.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (!w.predicate(msg)) return true;
        clearTimeout(w.timer);
        w.resolve(msg);
        return false;
      });
    });

    this.socket.on('close', (code) => {
      this.closedCode = code;
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label}: bağlantı zaman aşımı`)), 8000);
      this.socket.once('open', () => { clearTimeout(timer); resolve(); });
      this.socket.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }

  send(msg: unknown): void {
    this.socket.send(JSON.stringify(msg));
  }

  /** Belirtilen koşulu sağlayan İLK mesajı bekler. */
  waitFor<T extends ServerMessage>(
    predicate: (m: ServerMessage) => boolean,
    label: string,
    timeoutMs = 5000,
  ): Promise<T> {
    // Zaten gelmiş olabilir
    const existing = this.received.find(predicate);
    if (existing) return Promise.resolve(existing as T);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`${this.label}: "${label}" ${timeoutMs}ms içinde gelmedi`));
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: resolve as (m: ServerMessage) => void,
        reject,
        label,
        timer,
      });
    });
  }

  /** Bu istemcinin gördüğü son state. */
  lastState(): PlaybackState | null {
    for (let i = this.received.length - 1; i >= 0; i--) {
      const m = this.received[i]!;
      if (m.type === 'STATE') return m.state;
      if (m.type === 'HELLO') return m.state;
    }
    return null;
  }

  lastMembers(): Member[] {
    for (let i = this.received.length - 1; i >= 0; i--) {
      const m = this.received[i]!;
      if (m.type === 'PRESENCE') return m.members;
      if (m.type === 'HELLO') return m.members;
    }
    return [];
  }

  /** Gördüğü tüm STATE versiyonları — monotonluk kontrolü için. */
  stateVersions(): number[] {
    return this.received.filter((m) => m.type === 'STATE').map((m) => m.state.version);
  }

  /** NTP benzeri saat senkronu: n örnek al, en düşük RTT'liyi seç. */
  async measureClock(n = 8): Promise<ClockSample> {
    const samples: ClockSample[] = [];
    for (let i = 0; i < n; i++) {
      const t0 = Date.now();
      const pong = await new Promise<ServerMessage>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('PONG gelmedi')), 3000);
        this.waiters.push({
          predicate: (m) => m.type === 'PONG' && m.t0 === t0,
          resolve: (m) => { clearTimeout(timer); resolve(m); },
          reject,
          label: 'PONG',
          timer,
        });
        this.send({ type: 'PING', t0 });
      });
      if (pong.type !== 'PONG') continue;
      samples.push(computeClockSample(pong.t0, pong.t1, pong.t2, Date.now()));
      await sleep(30);
    }
    assert(samples.length > 0, 'hiç saat örneği alınamadı');
    return samples.reduce((best, s) => (s.rttMs < best.rttMs ? s : best));
  }

  close(): void {
    this.socket.close();
  }
}

// ============================================================== Test akışı
process.stdout.write(`\n  Faz 1 senkron testi → API ${API} · WS ${WS}\n\n`);

const stamp = Date.now();
const pass = 'CokGizliParola123';

const alice = await api('POST', '/api/auth/register', {
  email: `alice-${stamp}@example.com`, password: pass, displayName: 'Alice',
});
const bob = await api('POST', '/api/auth/register', {
  email: `bob-${stamp}@example.com`, password: pass, displayName: 'Bob',
});

const { room } = await api(
  'POST', '/api/rooms',
  { name: 'Senkron Testi', youtubeVideoId: 'aqz-KE-bpKQ' },
  alice.accessToken,
);
process.stdout.write(`  ${DIM}oda: ${room.slug}${RESET}\n\n`);

const A = new TestClient('Alice');
const B = new TestClient('Bob');

// Alice ÖNCE bağlanır — host olması beklenir
await A.connect(room.slug, alice.accessToken);
await sleep(150);
await B.connect(room.slug, bob.accessToken);

await check('İki istemci de HELLO aldı, kaynak doğru', async () => {
  const ha = await A.waitFor((m) => m.type === 'HELLO', 'HELLO(A)');
  const hb = await B.waitFor((m) => m.type === 'HELLO', 'HELLO(B)');
  assert(ha.type === 'HELLO' && hb.type === 'HELLO', 'HELLO tipi yanlış');
  assert(ha.state.source?.type === 'youtube', 'kaynak youtube değil');
  assert(ha.room.slug === room.slug, 'oda kodu eşleşmiyor');
  return `versiyon ${ha.state.version}`;
});

await check('Saat senkronu: offset ve RTT ölçülebiliyor', async () => {
  const sample = await A.measureClock(8);
  assert(Number.isFinite(sample.offsetMs), 'offset sayı değil');
  assert(sample.rttMs >= 0, `RTT negatif: ${sample.rttMs}`);
  assert(sample.rttMs < 2000, `RTT mantıksız yüksek: ${sample.rttMs}`);
  // Aynı makinede sunucu ve istemci → offset sıfıra çok yakın olmalı
  assert(Math.abs(sample.offsetMs) < 250, `offset beklenenden büyük: ${sample.offsetMs}`);
  return `offset ${sample.offsetMs.toFixed(1)}ms · rtt ${sample.rttMs.toFixed(1)}ms`;
});

await check('Alice host (ilk bağlanan), Bob değil', async () => {
  await B.waitFor((m) => m.type === 'PRESENCE' && m.members.length === 2, 'PRESENCE(2 üye)');
  const members = B.lastMembers();
  assert(members.length === 2, `üye sayısı ${members.length}`);
  const host = members.find((m) => m.isHost);
  assert(host?.displayName === 'Alice', `host Alice değil: ${host?.displayName}`);
  return 'host = Alice';
});

await check('PLAY yayınlanıyor, versiyon artıyor', async () => {
  const before = A.lastState()!.version;
  A.send({ type: 'PLAY', positionMs: 0 });

  const sa = await A.waitFor((m) => m.type === 'STATE' && m.reason === 'PLAY', 'STATE(PLAY)@A');
  const sb = await B.waitFor((m) => m.type === 'STATE' && m.reason === 'PLAY', 'STATE(PLAY)@B');
  assert(sa.type === 'STATE' && sb.type === 'STATE', 'tip hatası');

  assert(sa.state.isPlaying, 'A: isPlaying false');
  assert(sb.state.isPlaying, 'B: isPlaying false');
  assert(sa.state.version > before, `versiyon artmadı: ${before} → ${sa.state.version}`);
  assert(sa.state.version === sb.state.version, 'iki istemci farklı versiyon gördü');
  return `v${before} → v${sa.state.version}`;
});

await check('Oynarken pozisyonlar yakınsıyor (1,5 sn sonra)', async () => {
  await sleep(1500);
  const now = Date.now();
  const pa = effectivePositionMs(A.lastState()!, now);
  const pb = effectivePositionMs(B.lastState()!, now);
  const delta = Math.abs(pa - pb);
  // Aynı state'ten türetildikleri için fark sıfıra çok yakın olmalı
  assert(delta < 50, `pozisyon farkı çok büyük: ${delta.toFixed(1)}ms`);
  assert(pa > 1000, `pozisyon ilerlemedi: ${pa.toFixed(0)}ms`);
  return `A=${pa.toFixed(0)}ms B=${pb.toFixed(0)}ms Δ=${delta.toFixed(1)}ms`;
});

await check('Bob SEEK gönderebiliyor (oynatma kontrolü herkese açık)', async () => {
  B.send({ type: 'SEEK', positionMs: 42_000 });
  const sa = await A.waitFor((m) => m.type === 'STATE' && m.reason === 'SEEK', 'STATE(SEEK)@A');
  assert(sa.type === 'STATE', 'tip hatası');
  assert(Math.abs(sa.state.positionMs - 42_000) < 5, `pozisyon ${sa.state.positionMs}`);
  return `pozisyon ${sa.state.positionMs}ms`;
});

await check('PAUSE pozisyonu dondurdu', async () => {
  A.send({ type: 'PAUSE' });
  await A.waitFor((m) => m.type === 'STATE' && m.reason === 'PAUSE', 'STATE(PAUSE)');
  const s1 = A.lastState()!;
  assert(!s1.isPlaying, 'isPlaying hâlâ true');
  const p1 = effectivePositionMs(s1, Date.now());
  await sleep(600);
  const p2 = effectivePositionMs(s1, Date.now());
  assert(p1 === p2, `duraklatılmışken pozisyon ilerledi: ${p1} → ${p2}`);
  return `sabit ${p1.toFixed(0)}ms`;
});

await check('Versiyonlar kesinlikle monoton artıyor', async () => {
  for (const client of [A, B]) {
    const versions = client.stateVersions();
    assert(versions.length >= 3, `${client.label}: yeterli STATE yok (${versions.length})`);
    for (let i = 1; i < versions.length; i++) {
      assert(
        versions[i]! > versions[i - 1]!,
        `${client.label}: versiyon geriledi ${versions[i - 1]} → ${versions[i]}`,
      );
    }
  }
  return `A:${A.stateVersions().length} B:${B.stateVersions().length} STATE mesajı`;
});

await check('Eşzamanlı komutlar tutarlı tek sonuca varıyor', async () => {
  // İki istemci aynı anda zıt komut gönderiyor. Sunucu tek otorite olduğu
  // için ikisi de AYNI son state'i görmeli — hangisinin kazandığı değil,
  // AYNI sonuca varmaları önemli.
  A.send({ type: 'PLAY' });
  B.send({ type: 'PAUSE' });
  await sleep(400);
  const sa = A.lastState()!;
  const sb = B.lastState()!;
  assert(sa.version === sb.version, `versiyon ayrıştı: A=${sa.version} B=${sb.version}`);
  assert(sa.isPlaying === sb.isPlaying, 'isPlaying ayrıştı');
  return `iki taraf da v${sa.version}, isPlaying=${sa.isPlaying}`;
});

await check('Sohbet her iki istemciye ulaşıyor', async () => {
  const text = `merhaba-${stamp}`;
  A.send({ type: 'CHAT', text });
  const cb = await B.waitFor((m) => m.type === 'CHAT' && m.text === text, 'CHAT@B');
  assert(cb.type === 'CHAT' && cb.displayName === 'Alice', 'gönderen yanlış');
  return 'teslim edildi';
});

await check('HEARTBEAT sapması sync_drift_ms metriğine yazılıyor', async () => {
  const readCount = async (): Promise<number> => {
    const text = await (await fetch(`${WS.replace(/^ws/, 'http').replace('/ws', '')}/metrics`)).text();
    const line = text.split('\n').find((l) => l.startsWith('sync_drift_ms_count'));
    assert(line, 'sync_drift_ms_count metriği bulunamadı');
    return Number(line.split(' ')[1]);
  };

  const before = await readCount();
  A.send({ type: 'HEARTBEAT', positionMs: 1000, driftMs: 137 });
  B.send({ type: 'HEARTBEAT', positionMs: 1000, driftMs: -42 });
  await sleep(250);
  const after = await readCount();

  assert(after >= before + 2, `metrik artmadı: ${before} → ${after}`);
  return `${before} → ${after} gözlem`;
});

await check('Host olmayan SET_SOURCE gönderemiyor', async () => {
  B.send({ type: 'SET_SOURCE', source: { type: 'youtube', videoId: 'dQw4w9WgXcQ' } });
  const err = await B.waitFor((m) => m.type === 'ERROR' && m.code === 'FORBIDDEN', 'ERROR(FORBIDDEN)');
  assert(err.type === 'ERROR', 'tip hatası');
  return err.message;
});

await check('Host SET_SOURCE gönderebiliyor', async () => {
  A.send({ type: 'SET_SOURCE', source: { type: 'youtube', videoId: 'dQw4w9WgXcQ' } });
  const sb = await B.waitFor((m) => m.type === 'STATE' && m.reason === 'SET_SOURCE', 'STATE(SET_SOURCE)@B');
  assert(sb.type === 'STATE', 'tip hatası');
  assert(sb.state.source?.type === 'youtube', 'kaynak tipi yanlış');
  assert(
    sb.state.source.type === 'youtube' && sb.state.source.videoId === 'dQw4w9WgXcQ',
    'video kimliği güncellenmedi',
  );
  assert(sb.state.positionMs === 0 && !sb.state.isPlaying, 'kaynak değişince state sıfırlanmadı');
  return 'kaynak değişti, state sıfırlandı';
});

await check('Geçersiz mesaj reddediliyor, bağlantı düşmüyor', async () => {
  B.send({ type: 'SEEK', positionMs: -999 });          // şema ihlali
  const err = await B.waitFor((m) => m.type === 'ERROR' && m.code === 'BAD_MESSAGE', 'ERROR(BAD_MESSAGE)');
  assert(err.type === 'ERROR', 'tip hatası');
  // Bağlantı hâlâ çalışıyor mu?
  const t0 = Date.now();
  B.send({ type: 'PING', t0 });
  await B.waitFor((m) => m.type === 'PONG' && m.t0 === t0, 'PONG(bağlantı canlı)');
  return 'bağlantı ayakta kaldı';
});

await check('Host ayrılınca host devri oluyor (leader election)', async () => {
  A.close();
  const pb = await B.waitFor(
    (m) => m.type === 'PRESENCE' && m.members.length === 1,
    'PRESENCE(1 üye)',
  );
  assert(pb.type === 'PRESENCE', 'tip hatası');
  const remaining = pb.members[0];
  assert(remaining?.displayName === 'Bob', `kalan üye Bob değil: ${remaining?.displayName}`);
  assert(remaining.isHost, 'Bob host olmadı');
  return 'Bob → host';
});

await check('Yeni host artık SET_SOURCE gönderebiliyor', async () => {
  B.send({ type: 'SET_SOURCE', source: { type: 'youtube', videoId: 'aqz-KE-bpKQ' } });
  const sb = await B.waitFor(
    (m) => m.type === 'STATE' && m.reason === 'SET_SOURCE' &&
           m.state.source?.type === 'youtube' && m.state.source.videoId === 'aqz-KE-bpKQ',
    'STATE(SET_SOURCE)@B',
  );
  assert(sb.type === 'STATE', 'tip hatası');
  return 'yetki devredildi';
});

await check('Bilet ile bağlanılabiliyor (ham JWT query string\'de taşınmıyor)', async () => {
  const { ticket, expiresInSeconds } = await api(
    'POST', `/api/rooms/${room.slug}/ticket`, undefined, bob.accessToken,
  );
  assert(typeof ticket === 'string' && ticket.length > 30, 'bilet üretilmedi');
  assert(expiresInSeconds <= 60, `bilet ömrü çok uzun: ${expiresInSeconds}s`);

  const C = new TestClient('Ticket');
  const sock = new WebSocket(
    `${WS}?room=${encodeURIComponent(room.slug)}&ticket=${encodeURIComponent(ticket)}`,
  );
  const opened = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    sock.on('open', () => { clearTimeout(timer); resolve(true); });
    sock.on('close', () => { clearTimeout(timer); resolve(false); });
    sock.on('error', () => {});
  });
  void C;
  assert(opened, 'bilet ile bağlanılamadı');

  // Aynı bilet İKİNCİ kez kullanılamaz (atomik GETDEL)
  const second = new WebSocket(
    `${WS}?room=${encodeURIComponent(room.slug)}&ticket=${encodeURIComponent(ticket)}`,
  );
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ikinci bağlantı kapanmadı')), 5000);
    second.on('close', (c) => { clearTimeout(timer); resolve(c); });
    second.on('error', () => {});
  });
  assert(code === 1008, `tekrar kullanımda beklenen 1008, gelen ${code}`);

  sock.close();
  return `${expiresInSeconds}s ömür, tek kullanımlık doğrulandı`;
});

await check('Bilet BAŞKA odaya kullanılamıyor', async () => {
  const { room: other } = await api(
    'POST', '/api/rooms', { name: 'Başka Oda', youtubeVideoId: 'dQw4w9WgXcQ' }, bob.accessToken,
  );
  const { ticket } = await api(
    'POST', `/api/rooms/${room.slug}/ticket`, undefined, bob.accessToken,
  );

  const sock = new WebSocket(
    `${WS}?room=${encodeURIComponent(other.slug)}&ticket=${encodeURIComponent(ticket)}`,
  );
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('soket kapanmadı')), 5000);
    sock.on('close', (c) => { clearTimeout(timer); resolve(c); });
    sock.on('error', () => {});
  });
  assert(code === 1008, `beklenen 1008, gelen ${code}`);
  return 'oda kilidi çalışıyor';
});

await check('Geçersiz bilet reddediliyor', async () => {
  const sock = new WebSocket(`${WS}?room=${room.slug}&ticket=sahte-bilet-degeri-123456789`);
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('soket kapanmadı')), 5000);
    sock.on('close', (c) => { clearTimeout(timer); resolve(c); });
    sock.on('error', () => {});
  });
  assert(code === 1008, `beklenen 1008, gelen ${code}`);
  return 'kod 1008';
});

await check('Kimlik doğrulaması olmadan bağlanılamıyor', async () => {
  const bad = new WebSocket(`${WS}?room=${room.slug}&token=sahte.token.degeri`);
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('soket kapanmadı')), 5000);
    bad.on('close', (c) => { clearTimeout(timer); resolve(c); });
    bad.on('error', () => { /* kapanış kodunu bekliyoruz */ });
  });
  assert(code === 1008, `beklenen kapanış kodu 1008, gelen ${code}`);
  return 'kod 1008 (policy violation)';
});

await check('Var olmayan odaya bağlanılamıyor', async () => {
  const bad = new WebSocket(`${WS}?room=olmayanoda&token=${encodeURIComponent(bob.accessToken)}`);
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('soket kapanmadı')), 5000);
    bad.on('close', (c) => { clearTimeout(timer); resolve(c); });
    bad.on('error', () => {});
  });
  assert(code === 1008, `beklenen 1008, gelen ${code}`);
  return 'kod 1008';
});

B.close();
await sleep(200);

process.stdout.write(`\n  ${passed} başarılı, ${failed} başarısız\n\n`);
process.exit(failed > 0 ? 1 : 0);
