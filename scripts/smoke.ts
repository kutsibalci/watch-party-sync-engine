/**
 * Faz 0 duman testi (smoke test) — API'nin uçtan uca çalıştığını doğrular.
 *
 * Kullanım:  npm run smoke        (API ayakta olmalı)
 *
 * Bu bir birim testi değil; "her şey doğru bağlanmış mı?" kontrolüdür.
 * Gerçek test altyapısı Faz 1'de eklenecek.
 */
// 127.0.0.1 — 'localhost' Windows'ta önce ::1'e çözülür ve o portta başka bir
// servis varsa istek sessizce oraya gider. Açık IPv4 adresi bu belirsizliği kaldırır.
const API = process.env.SMOKE_API_URL ?? 'http://127.0.0.1:8090';

let passed = 0;
let failed = 0;

function ok(name: string, detail = ''): void {
  passed++;
  process.stdout.write(`  [32m✓[0m ${name}${detail ? `  [90m${detail}[0m` : ''}\n`);
}

function fail(name: string, detail: string): void {
  failed++;
  process.stdout.write(`  [31m✗[0m ${name}\n    [31m${detail}[0m\n`);
}

async function check(
  name: string,
  fn: () => Promise<string | void>,
): Promise<void> {
  try {
    const detail = await fn();
    ok(name, detail ?? '');
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Json = Record<string, any>;

async function req(
  method: string,
  path: string,
  options: { body?: unknown; token?: string } = {},
): Promise<{ status: number; json: Json; text: string }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* metin yanıt (örn. /metrics) — json boş kalır */
  }
  return { status: res.status, json, text };
}

// -------------------------------------------------------------------- Testler
process.stdout.write(`\n  Duman testi → ${API}\n\n`);

// Rastgele e-posta: test tekrar tekrar çalıştırılabilsin
const email = `smoke-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
const password = 'CokGizliParola123';
let token = '';

await check('GET /healthz → 200', async () => {
  const { status, json } = await req('GET', '/healthz');
  assert(status === 200, `beklenen 200, gelen ${status}`);
  assert(json.status === 'ok', `beklenen status="ok", gelen ${JSON.stringify(json)}`);
  return `uptime ${json.uptimeSeconds}s`;
});

await check('GET /readyz → 200, postgres + redis erişilebilir', async () => {
  const { status, json } = await req('GET', '/readyz');
  assert(status === 200, `beklenen 200, gelen ${status} — ${JSON.stringify(json)}`);
  assert(json.checks?.database === true, 'postgres erişilemiyor');
  assert(json.checks?.redis === true, 'redis erişilemiyor');
});

await check('GET /metrics → Prometheus formatı', async () => {
  const { status, text } = await req('GET', '/metrics');
  assert(status === 200, `beklenen 200, gelen ${status}`);
  assert(text.includes('http_requests_total'), 'http_requests_total metriği yok');
  assert(text.includes('sync_drift_ms'), 'sync_drift_ms metriği yok');
  return `${text.split('\n').length} satır`;
});

await check('POST /api/auth/register → 201', async () => {
  const { status, json } = await req('POST', '/api/auth/register', {
    body: { email, password, displayName: 'Duman Testi' },
  });
  assert(status === 201, `beklenen 201, gelen ${status} — ${JSON.stringify(json)}`);
  assert(typeof json.accessToken === 'string' && json.accessToken.length > 20, 'accessToken yok');
  assert(json.user?.email === email, 'dönen e-posta eşleşmiyor');
  assert(json.user?.passwordHash === undefined, 'parola özeti sızdırılmış!');
  token = json.accessToken;
  return `userId ${String(json.user.id).slice(0, 8)}…`;
});

await check('POST /api/auth/register (aynı e-posta) → 409', async () => {
  const { status, json } = await req('POST', '/api/auth/register', {
    body: { email, password, displayName: 'Kopya' },
  });
  assert(status === 409, `beklenen 409, gelen ${status}`);
  assert(json.error?.code === 'CONFLICT', `beklenen CONFLICT, gelen ${json.error?.code}`);
});

await check('POST /api/auth/register (kısa parola) → 400', async () => {
  const { status, json } = await req('POST', '/api/auth/register', {
    body: { email: `x-${email}`, password: '123', displayName: 'Kisa' },
  });
  assert(status === 400, `beklenen 400, gelen ${status}`);
  assert(Array.isArray(json.error?.details), 'doğrulama detayları dönmemiş');
});

await check('POST /api/auth/login (doğru parola) → 200', async () => {
  const { status, json } = await req('POST', '/api/auth/login', {
    body: { email, password },
  });
  assert(status === 200, `beklenen 200, gelen ${status} — ${JSON.stringify(json)}`);
  assert(typeof json.accessToken === 'string', 'accessToken yok');
});

await check('POST /api/auth/login (yanlış parola) → 401', async () => {
  const { status, json } = await req('POST', '/api/auth/login', {
    body: { email, password: 'YanlisParola999' },
  });
  assert(status === 401, `beklenen 401, gelen ${status}`);
  assert(
    json.error?.message === 'E-posta veya parola hatalı',
    'hata mesajı hangi alanın yanlış olduğunu sızdırıyor',
  );
});

await check('POST /api/auth/login (olmayan kullanıcı) → 401, aynı mesaj', async () => {
  const { status, json } = await req('POST', '/api/auth/login', {
    body: { email: `yok-${Date.now()}@example.com`, password },
  });
  assert(status === 401, `beklenen 401, gelen ${status}`);
  assert(
    json.error?.message === 'E-posta veya parola hatalı',
    'kullanıcı numaralandırma açığı: mesaj farklı',
  );
});

await check('GET /api/auth/me (token ile) → 200', async () => {
  const { status, json } = await req('GET', '/api/auth/me', { token });
  assert(status === 200, `beklenen 200, gelen ${status} — ${JSON.stringify(json)}`);
  assert(json.user?.email === email, 'dönen kullanıcı yanlış');
});

await check('GET /api/auth/me (token yok) → 401', async () => {
  const { status } = await req('GET', '/api/auth/me');
  assert(status === 401, `beklenen 401, gelen ${status}`);
});

await check('GET /api/auth/me (bozuk token) → 401', async () => {
  const { status } = await req('GET', '/api/auth/me', { token: 'bu.bir.sahte-token' });
  assert(status === 401, `beklenen 401, gelen ${status}`);
});

await check('GET /olmayan-yol → 404', async () => {
  const { status, json } = await req('GET', '/olmayan-yol');
  assert(status === 404, `beklenen 404, gelen ${status}`);
  assert(json.error?.code === 'NOT_FOUND', 'hata kodu yanlış');
});

// --------------------------------------------------------------------- Özet
process.stdout.write(
  `\n  ${passed} başarılı, ${failed} başarısız\n\n`,
);

process.exit(failed > 0 ? 1 : 0);
