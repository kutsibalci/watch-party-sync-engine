/**
 * Faz 3 testi — İKİ realtime instance'ı arasında tutarlılık.
 *
 * Kurulum: A istemcisi 8091'e (realtime-1), B istemcisi 8092'ye (realtime-2)
 * bağlanır. İkisi AYNI odadadır ama FARKLI süreçlerdedir.
 *
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │ Bu test, Faz 3'ün Redis Pub/Sub adımından ÖNCE BAŞARISIZ OLUR.         │
 * │ Öyle olması gerekir: oda state'i süreç belleğindeyken A'nın komutu     │
 * │ B'ye ulaşmaz. Kırılmayı görmeden çözümün ne işe yaradığı anlaşılmaz.   │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Kullanım:  npm run scale-test
 */
import { WebSocket } from 'ws';

import type { Member, PlaybackState, ServerMessage } from '../src/shared/protocol.ts';
import { effectivePositionMs } from '../src/shared/protocol.ts';

const API = process.env.SMOKE_API_URL ?? 'http://127.0.0.1:8090';
const WS_A = process.env.WS_A ?? 'ws://127.0.0.1:8091/ws';
const WS_B = process.env.WS_B ?? 'ws://127.0.0.1:8092/ws';

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
  timer: NodeJS.Timeout;
};

class Client {
  readonly label: string;
  private socket!: WebSocket;
  readonly received: ServerMessage[] = [];
  private waiters: Waiter[] = [];

  constructor(label: string) {
    this.label = label;
  }

  async connect(url: string, slug: string, token: string): Promise<void> {
    this.socket = new WebSocket(
      `${url}?room=${encodeURIComponent(slug)}&token=${encodeURIComponent(token)}`,
    );

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

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label}: bağlantı zaman aşımı`)), 8000);
      this.socket.once('open', () => { clearTimeout(timer); resolve(); });
      this.socket.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }

  send(msg: unknown): void {
    this.socket.send(JSON.stringify(msg));
  }

  waitFor<T extends ServerMessage>(
    predicate: (m: ServerMessage) => boolean,
    label: string,
    timeoutMs = 5000,
  ): Promise<T> {
    const existing = this.received.find(predicate);
    if (existing) return Promise.resolve(existing as T);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`${this.label}: "${label}" ${timeoutMs}ms içinde gelmedi`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve: resolve as (m: ServerMessage) => void, timer });
    });
  }

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

  close(): void {
    this.socket.close();
  }
}

// ================================================================== Akış
process.stdout.write(
  `\n  Faz 3 ölçekleme testi\n  ${DIM}A → ${WS_A}   B → ${WS_B}${RESET}\n\n`,
);

const stamp = Date.now();
const pass = 'CokGizliParola123';

const alice = await api('POST', '/api/auth/register', {
  email: `scale-a-${stamp}@example.com`, password: pass, displayName: 'Alice',
});
const bob = await api('POST', '/api/auth/register', {
  email: `scale-b-${stamp}@example.com`, password: pass, displayName: 'Bob',
});

const { room } = await api(
  'POST', '/api/rooms',
  { name: 'Ölçekleme Testi', youtubeVideoId: 'aqz-KE-bpKQ' },
  alice.accessToken,
);
process.stdout.write(`  ${DIM}oda: ${room.slug}${RESET}\n\n`);

const A = new Client('Alice@realtime-1');
const B = new Client('Bob@realtime-2');

await A.connect(WS_A, room.slug, alice.accessToken);
await sleep(200);
await B.connect(WS_B, room.slug, bob.accessToken);
await sleep(500);

await check('İki instance da bağlantıyı kabul etti', async () => {
  const ha = await A.waitFor((m) => m.type === 'HELLO', 'HELLO@A');
  const hb = await B.waitFor((m) => m.type === 'HELLO', 'HELLO@B');
  assert(ha.type === 'HELLO' && hb.type === 'HELLO', 'HELLO gelmedi');
  assert(ha.room.slug === room.slug && hb.room.slug === room.slug, 'oda eşleşmiyor');
  return 'iki HELLO alındı';
});

await check('Presence instance sınırını AŞIYOR (2 üye görünüyor)', async () => {
  await A.waitFor((m) => m.type === 'PRESENCE' && m.members.length === 2, 'PRESENCE(2)@A', 6000);
  await B.waitFor((m) => m.type === 'PRESENCE' && m.members.length === 2, 'PRESENCE(2)@B', 6000);

  const ma = A.lastMembers();
  const mb = B.lastMembers();
  assert(ma.length === 2, `A ${ma.length} üye görüyor (2 olmalı)`);
  assert(mb.length === 2, `B ${mb.length} üye görüyor (2 olmalı)`);

  const names = ma.map((m) => m.displayName).sort().join(',');
  assert(names === 'Alice,Bob', `A'nın gördüğü üyeler: ${names}`);
  return 'her iki taraf da 2 üye görüyor';
});

await check('Host seçimi instance\'lar arasında TUTARLI', async () => {
  const hostA = A.lastMembers().find((m) => m.isHost)?.displayName;
  const hostB = B.lastMembers().find((m) => m.isHost)?.displayName;
  assert(hostA, 'A host görmüyor');
  assert(hostA === hostB, `host ayrıştı: A="${hostA}" B="${hostB}"`);
  assert(hostA === 'Alice', `host Alice olmalıydı, ${hostA} çıktı`);
  return `host = ${hostA} (iki instance da aynı)`;
});

await check('A\'nın PLAY komutu B\'ye ULAŞIYOR (instance sınırını aşan yayın)', async () => {
  A.send({ type: 'PLAY', positionMs: 0 });
  const sb = await B.waitFor(
    (m) => m.type === 'STATE' && m.reason === 'PLAY',
    'STATE(PLAY)@B',
    6000,
  );
  assert(sb.type === 'STATE', 'tip hatası');
  assert(sb.state.isPlaying, 'B: isPlaying false');
  return `B v${sb.state.version} aldı`;
});

await check('Versiyonlar iki instance\'ta AYNI', async () => {
  await sleep(400);
  const sa = A.lastState()!;
  const sb = B.lastState()!;
  assert(sa.version === sb.version, `versiyon ayrıştı: A=v${sa.version} B=v${sb.version}`);
  assert(sa.isPlaying === sb.isPlaying, 'isPlaying ayrıştı');
  return `iki taraf da v${sa.version}`;
});

await check('Pozisyonlar yakınsıyor (2 sn oynatma sonrası)', async () => {
  await sleep(2000);
  const now = Date.now();
  const pa = effectivePositionMs(A.lastState()!, now);
  const pb = effectivePositionMs(B.lastState()!, now);
  const delta = Math.abs(pa - pb);
  assert(delta < 100, `pozisyon farkı ${delta.toFixed(1)}ms (100ms altı olmalı)`);
  return `A=${pa.toFixed(0)}ms B=${pb.toFixed(0)}ms Δ=${delta.toFixed(1)}ms`;
});

await check('B\'nin SEEK komutu A\'ya ulaşıyor (ters yön)', async () => {
  B.send({ type: 'SEEK', positionMs: 55_000 });
  const sa = await A.waitFor(
    (m) => m.type === 'STATE' && m.reason === 'SEEK',
    'STATE(SEEK)@A',
    6000,
  );
  assert(sa.type === 'STATE', 'tip hatası');
  assert(Math.abs(sa.state.positionMs - 55_000) < 50, `pozisyon ${sa.state.positionMs}`);
  return `A pozisyonu ${Math.round(sa.state.positionMs)}ms olarak aldı`;
});

await check('Sohbet instance sınırını aşıyor', async () => {
  const text = `olcekleme-${stamp}`;
  A.send({ type: 'CHAT', text });
  const cb = await B.waitFor((m) => m.type === 'CHAT' && m.text === text, 'CHAT@B', 6000);
  assert(cb.type === 'CHAT' && cb.displayName === 'Alice', 'gönderen yanlış');
  return 'A → B teslim edildi';
});

await check('Eşzamanlı zıt komutlar TEK sonuca varıyor (yarış testi)', async () => {
  // İki FARKLI instance'a aynı anda zıt komut. State Redis'te tek yerde
  // tutulduğu ve versiyon atomik arttığı için ikisi de aynı sonucu görmeli.
  // Hangisinin kazandığı önemli değil — AYRIŞMAMALARI önemli.
  for (let round = 0; round < 5; round++) {
    A.send({ type: 'PLAY' });
    B.send({ type: 'PAUSE' });
    await sleep(300);
  }
  await sleep(700);

  const sa = A.lastState()!;
  const sb = B.lastState()!;
  assert(sa.version === sb.version, `versiyon ayrıştı: A=v${sa.version} B=v${sb.version}`);
  assert(sa.isPlaying === sb.isPlaying,
    `isPlaying ayrıştı: A=${sa.isPlaying} B=${sb.isPlaying}`);
  assert(Math.abs(sa.positionMs - sb.positionMs) < 5, 'pozisyon ayrıştı');
  return `10 komut sonrası iki taraf da v${sa.version}, isPlaying=${sa.isPlaying}`;
});

await check('Versiyonlar her iki istemcide de monoton', async () => {
  for (const c of [A, B]) {
    const versions = c.received.filter((m) => m.type === 'STATE').map((m) => m.state.version);
    assert(versions.length >= 5, `${c.label}: yalnızca ${versions.length} STATE`);
    for (let i = 1; i < versions.length; i++) {
      assert(versions[i]! > versions[i - 1]!,
        `${c.label}: versiyon geriledi ${versions[i - 1]} → ${versions[i]}`);
    }
  }
  return 'sırasızlık yok';
});

await check('Host DEVRİ instance sınırını aşıyor', async () => {
  // ÖN KOŞUL: bu test yanlış sebeple geçebilir. Kırık sürümde B yalnızca
  // kendini gördüğü için zaten host'tu ve test "geçiyordu". Devrin gerçekten
  // gerçekleştiğini kanıtlamak için önce B'nin Alice'i host GÖRDÜĞÜNÜ
  // doğruluyoruz.
  const before = B.lastMembers();
  assert(before.length === 2, `B ${before.length} üye görüyor — devir testi anlamsız`);
  assert(
    before.find((m) => m.isHost)?.displayName === 'Alice',
    'B, Alice\'i host görmüyor — devir testi anlamsız',
  );

  // Alice (realtime-1) ayrılıyor. Bob (realtime-2) host olmalı.
  A.close();
  const pb = await B.waitFor(
    (m) => m.type === 'PRESENCE' && m.members.length === 1,
    'PRESENCE(1)@B',
    10_000,
  );
  assert(pb.type === 'PRESENCE', 'tip hatası');
  const remaining = pb.members[0];
  assert(remaining?.displayName === 'Bob', `kalan üye ${remaining?.displayName}`);
  assert(remaining.isHost, 'Bob host olmadı — host devri instance sınırını aşmıyor');
  return 'Bob → host (farklı instance)';
});

await check('Yeni host SET_SOURCE gönderebiliyor', async () => {
  B.send({ type: 'SET_SOURCE', source: { type: 'youtube', videoId: 'dQw4w9WgXcQ' } });
  const sb = await B.waitFor(
    (m) => m.type === 'STATE' && m.reason === 'SET_SOURCE',
    'STATE(SET_SOURCE)@B',
    6000,
  );
  assert(sb.type === 'STATE', 'tip hatası');
  assert(sb.state.source?.type === 'youtube' && sb.state.source.videoId === 'dQw4w9WgXcQ',
    'kaynak güncellenmedi');
  return 'yetki devredildi';
});

B.close();
await sleep(300);

process.stdout.write(`\n  ${passed} başarılı, ${failed} başarısız\n\n`);
process.exit(failed > 0 ? 1 : 0);
