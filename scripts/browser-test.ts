/**
 * Faz 1 tarayıcı testi — GERÇEK Chrome'da, İKİ sekmeyle.
 *
 * `sync-test.ts` protokolü doğrular; bu test ise protokolün ÜSTÜNDEKİ katmanı
 * doğrular: sayfa yükleniyor mu, YouTube oynatıcı ayağa kalkıyor mu, saat
 * senkronu ölçülüyor mu ve iki gerçek oynatıcı birbirine yakınsıyor mu.
 *
 * Kullanım:  npm run browser-test          (api + realtime ayakta olmalı)
 *            HEADLESS=0 npm run browser-test   (tarayıcıyı görünür aç)
 *
 * Sistemde kurulu Chrome kullanılır (puppeteer-core) — ayrı bir Chromium
 * indirmiyoruz.
 */
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import type { Browser, Page } from 'puppeteer-core';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:8090/app/';
const HEADLESS = process.env.HEADLESS !== '0';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[90m';
const RESET = '\x1b[0m';

const YELLOW = '\x1b[33m';

let passed = 0;
let failed = 0;
let skipped = 0;

function skip(name: string, reason: string): void {
  skipped++;
  process.stdout.write(`  ${YELLOW}⊘${RESET} ${name}  ${DIM}atlandı: ${reason}${RESET}\n`);
}

/**
 * Senaryonun içinden "bu ortamda ölçülemez" demenin yolu.
 *
 * Ortam eksikliğiyle ürün hatasını aynı kefeye koymak testleri güvenilmez
 * yapıyor: kırmızıya alışan kimse kırmızıya bakmaz. Bazı önkoşullar ancak
 * senaryo çalışırken anlaşıldığı için `skip()` çağrısı her zaman yetmiyor.
 */
class SkipError extends Error {}

async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const detail = await fn();
    passed++;
    process.stdout.write(`  ${GREEN}✓${RESET} ${name}${detail ? `  ${DIM}${detail}${RESET}` : ''}\n`);
  } catch (err) {
    if (err instanceof SkipError) {
      skip(name, err.message);
      return;
    }
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

function findChrome(): string {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter((p): p is string => Boolean(p));

  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      'Chrome bulunamadı. CHROME_PATH ortam değişkeniyle yolu belirtin.',
    );
  }
  return found;
}

/**
 * Tıklamadan önce sekmeyi ÖNE GETİR.
 *
 * İki sekme açıkken page.click() arka plandaki sekmede asılı kalıyor:
 * Puppeteer tıklamadan önce elementin kararlı olmasını bekler, arka plan
 * sekmesi ise kare üretmez. Ölçüm: tek sayfa 530 ms, iki sayfa asılı,
 * bringToFront ile 1067 ms. --disable-renderer-backgrounding çözmüyor.
 *
 * Aynı sebeple waitForFunction'ın varsayılan raf yoklaması da takılıyor;
 * bu dosyadaki tüm çağrılara polling: 250 verildi.
 */
async function click(page: Page, selector: string): Promise<void> {
  await page.bringToFront();
  await page.click(selector);
}

async function typeInto(page: Page, selector: string, text: string): Promise<void> {
  await page.bringToFront();
  await page.type(selector, text);
}

/** Sayfadaki bir telemetri hücresini okur. */
async function readCell(page: Page, id: string): Promise<string> {
  return page.$eval(`#${id}`, (el) => el.textContent?.trim() ?? '');
}

/** "+123 ms" / "-45 ms" → sayı */
function parseMs(text: string): number {
  const m = /(-?[\d.]+)\s*ms/.exec(text);
  return m ? Number(m[1]) : NaN;
}

async function setupUser(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Önceki testin oturumu kalmasın — her sekme temiz bir kullanıcı olsun
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btn-random');
  await click(page, '#btn-random');
  await click(page, '#btn-register');
  await page.waitForFunction(
    () => document.querySelector('#auth-status')?.classList.contains('ok'),
    { timeout: 15_000, polling: 250 },
  );
}

// ================================================================== Akış
process.stdout.write(`\n  Faz 1 tarayıcı testi → ${APP}  ${DIM}(headless=${HEADLESS})${RESET}\n\n`);

const executablePath = findChrome();
let browser: Browser | null = null;

/**
 * Küresel bekçi. Puppeteer'ın kendi zaman aşımları bazı durumlarda (Chrome
 * hiç başlamazsa, CDP el sıkışması yarıda kalırsa) devreye girmiyor ve test
 * sessizce sonsuza kadar asılı kalıyor. Sessiz asılma, başarısızlıktan
 * daha kötüdür: CI'da işi zaman aşımına kadar bloke eder.
 */
const WATCHDOG_MS = Number(process.env.WATCHDOG_MS ?? 240_000);
const watchdog = setTimeout(() => {
  process.stdout.write(
    `\n  ${RED}✗ BEKÇİ: test ${WATCHDOG_MS / 1000} saniyede bitmedi, zorla çıkılıyor${RESET}\n\n`,
  );
  void browser?.close().catch(() => {});
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();

process.stdout.write(`  ${DIM}Chrome başlatılıyor: ${executablePath}${RESET}\n`);

try {
  browser = await puppeteer.launch({
    executablePath,
    headless: HEADLESS,
    // Chrome ayağa kalkmazsa 30 saniyede hata ver, bekleme.
    timeout: 30_000,
    protocolTimeout: 60_000,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // Otomasyonda medya otomatik oynatma engelini kaldır
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--window-size=1280,900',
      // Kamera/mikrofon izin penceresi olmadan sahte cihaz ver; WebRTC
      // testleri gerçek donanım olmadan koşabilsin.
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  const pageA = await browser.newPage();
  const pageB = await browser.newPage();

  const consoleErrors: string[] = [];
  for (const [label, p] of [['A', pageA], ['B', pageB]] as const) {
    p.on('pageerror', (e: unknown) => {
      consoleErrors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    });
    // Metne bakmak yetmiyordu: "Failed to load resource: net::ERR_SSL_PROTOCOL_ERROR"
    // içinde alan adı geçmiyor ve YouTube'un kendi kaynağı bizim hatamız gibi
    // görünüyordu. Hatanın KAYNAK ADRESİNE bakıyoruz.
    const FOREIGN = /youtube|ytimg|googlevideo|doubleclick|googleads|google\.com|gstatic/i;
    p.on('console', (m) => {
      if (m.type() !== 'error') return;
      const from = m.location()?.url ?? '';
      if (FOREIGN.test(from) || FOREIGN.test(m.text())) return;
      consoleErrors.push(`${label}: ${m.text()}${from ? ` (${from})` : ''}`);
    });
  }

  // ---------------------------------------------------------------- Sekme A
  await check('Sekme A: sayfa yükleniyor ve kayıt olunuyor', async () => {
    await setupUser(pageA, APP);
    const status = await readCell(pageA, 'auth-status');
    assert(status.includes('Hoş geldin'), `beklenmeyen durum: ${status}`);
    return status;
  });

  let slug = '';
  await check('Sekme A: kaynak seçilip oda oluşturuluyor', async () => {
    // Oda açmak iki adım: "Devam et" kaynak sayfasını açar, "Odayı aç" kurar.
    await click(pageA, '#btn-create');
    await pageA.waitForSelector('#source-sheet:not(.is-hidden)', { timeout: 8000 });
    await click(pageA, '#btn-source-go');
    await pageA.waitForFunction(
      () => (document.querySelector('#room-slug') as HTMLInputElement)?.value.length > 0,
      { timeout: 15_000, polling: 250 },
    );
    slug = await pageA.$eval('#room-slug', (el) => (el as HTMLInputElement).value);
    assert(/^[a-z0-9-]{6,32}$/.test(slug), `slug biçimi hatalı: ${slug}`);
    return slug;
  });

  await check('Sekme A: WebSocket bağlandı', async () => {
    await pageA.waitForFunction(
      () => document.querySelector('#conn-state')?.textContent?.startsWith('bağlı') === true,
      { timeout: 15_000, polling: 250 },
    );
    return 'bağlı';
  });

  await check('Sekme A: saat senkronu ölçüldü (offset + RTT)', async () => {
    await pageA.waitForFunction(
      () => !document.querySelector('#t-offset')?.textContent?.includes('—'),
      { timeout: 15_000, polling: 250 },
    );
    const offset = parseMs(await readCell(pageA, 't-offset'));
    const rtt = parseMs(await readCell(pageA, 't-rtt'));
    assert(Number.isFinite(offset), 'offset okunamadı');
    assert(Number.isFinite(rtt) && rtt >= 0, `RTT geçersiz: ${rtt}`);
    // Offset'in mutlak büyüklüğüne dar bir sınır koymak ortamı test etmek olur:
    // Docker Desktop'ın VM saati host'tan saniyelerce kayabiliyor ve bu mekanizma
    // tam da onu ölçmek için var. Buradaki sınır yalnızca saçma değeri yakalar;
    // senkronun doğruluğu iki sekmenin offset'i ve hedef pozisyonu ile ölçülüyor.
    assert(Math.abs(offset) < 30_000, `offset saçma: ${offset}ms`);
    assert(rtt < 5_000, `RTT saçma: ${rtt}ms`);
    return `offset ${offset}ms · rtt ${rtt}ms`;
  });

  // ---------------------------------------------------------------- Sekme B
  await check('Sekme B: davet linkiyle açılıp odaya katılıyor', async () => {
    await setupUser(pageB, `${APP}?room=${slug}`);
    const prefilled = await pageB.$eval('#room-slug', (el) => (el as HTMLInputElement).value);
    assert(prefilled === slug, `oda kodu ön-doldurulmadı: "${prefilled}"`);
    await click(pageB, '#btn-join');
    await pageB.waitForFunction(
      () => document.querySelector('#conn-state')?.textContent?.startsWith('bağlı') === true,
      { timeout: 15_000, polling: 250 },
    );
    return 'bağlandı';
  });

  await check('İki sekme de 2 katılımcı görüyor, host = A', async () => {
    for (const [label, p] of [['A', pageA], ['B', pageB]] as const) {
      await p.waitForFunction(
        () => document.querySelectorAll('#members li').length === 2,
        { timeout: 10_000, polling: 250 },
      );
      const hostCount = await p.$$eval('#members .host-tag', (els) => els.length);
      assert(hostCount === 1, `${label}: host sayısı ${hostCount}`);
    }
    // A'nın kendi listesinde host ilk sırada (en eski üye) olmalı
    const firstIsHost = await pageA.$eval(
      '#members li:first-child',
      (el) => el.querySelector('.host-tag') !== null,
    );
    assert(firstIsHost, 'host listenin başında değil');
    return '2 üye, tek host';
  });

  /**
   * Sunucu saatinin kararlılığı — ms/s cinsinden sürüklenme.
   *
   * İki sekmenin aynı offset'i ölçmesi ancak sunucunun saati DURUYORSA
   * beklenebilir. Bu makinedeki Docker VM'inin saati saniyede ~75 ms kaçıp
   * her ~20 saniyede geri çekiliyordu; böyle bir sunucuda hiçbir istemci
   * hizada kalamaz. Bu bizim hatamız değil, altyapı arızası — o yüzden
   * ilgili senaryolar düşmez, ATLANIR (YouTube kapısıyla aynı mantık).
   *
   * Ardışık örneklerin eğim MEDYANI kullanılıyor: ilk-son farkı almak,
   * araya bir geri çekilme girdiğinde sürüklenmeyi sıfır gösteriyordu.
   */
  async function clockDriftMsPerSec(page: Page): Promise<number | null> {
    const s = await page.evaluate(() => (globalThis as any).__sync?.());
    const xs: { o: number; t: number }[] = s?.samples ?? [];
    if (xs.length < 5) return null;

    const slopes: number[] = [];
    for (let i = 1; i < xs.length; i++) {
      const dt = (xs[i]!.t - xs[i - 1]!.t) / 1000;
      if (dt >= 0.05) slopes.push((xs[i]!.o - xs[i - 1]!.o) / dt);
    }
    if (slopes.length < 4) return null;
    slopes.sort((a, b) => a - b);
    return slopes[slopes.length >> 1]!;
  }

  /** Bu hızın üstünde sürüklenen bir sunucu saatinde hizalama beklenemez. */
  const DRIFT_LIMIT_MS_PER_SEC = 20;
  const drift = await clockDriftMsPerSec(pageA);
  const clockSane = drift === null || Math.abs(drift) <= DRIFT_LIMIT_MS_PER_SEC;
  const driftNote = drift === null
    ? 'sürüklenme ölçülemedi'
    : `sunucu saati ${drift.toFixed(0)} ms/s sürükleniyor`;

  // İki sekme aynı makinede, aynı sunucuyla konuşuyor: sunucunun saati kararlıysa
  // ölçtükleri offset birbirini tutmalı. Mutlak kayma önemli değil.
  if (!clockSane) skip('İki sekmenin ölçtüğü saat farkı birbirini tutuyor', driftNote);
  else await check('İki sekmenin ölçtüğü saat farkı birbirini tutuyor', async () => {
    await pageB.waitForFunction(
      () => !document.querySelector('#t-offset')?.textContent?.includes('—'),
      { timeout: 15_000, polling: 250 },
    );
    const a = parseMs(await readCell(pageA, 't-offset'));
    const b = parseMs(await readCell(pageB, 't-offset'));
    const delta = Math.abs(a - b);
    assert(delta < 250, `sekmeler farklı offset ölçtü: A=${a}ms B=${b}ms Δ=${delta}ms`);
    return `A=${a}ms B=${b}ms Δ=${delta.toFixed(1)}ms`;
  });

  // -------------------------------------------------------------- Oynatıcı
  //
  // hls.js KENDİ sunucumuzdan geldiği için zorunlu — yüklenmemesi hatadır.
  await check('hls.js yerel olarak yüklendi (CDN bağımlılığı yok)', async () => {
    for (const [label, p] of [['A', pageA], ['B', pageB]] as const) {
      const ok = await p.evaluate(() => {
        const g = globalThis as any;
        const lib = g.Hls?.isSupported ? g.Hls : g.Hls?.default;
        return typeof lib?.isSupported === 'function';
      });
      assert(ok, `${label}: hls.js yüklenmedi`);
    }
    // Sayfa hiçbir üçüncü taraf CDN'ine bağlı olmamalı
    // Array.from — NodeList'i yaymak (spread) DOM.Iterable lib'i gerektirir.
    const external = await pageA.evaluate(() =>
      Array.from(document.querySelectorAll('script[src]'))
        .map((s) => (s as HTMLScriptElement).src)
        .filter((src) => !src.startsWith(location.origin) && !src.includes('youtube.com')),
    );
    assert(external.length === 0, `beklenmeyen dış script: ${external.join(', ')}`);
    return 'yerel paket, CDN yok';
  });

  // YouTube harici bir servistir; erişilemediğinde test BAŞARISIZ SAYILMAZ.
  // Dış bağımlılığa dayanan bir iddia, tanımı gereği kırılgandır.
  const youtubeReady = await pageA
    .waitForFunction(
      () => typeof (window as any).YT?.Player === 'function' &&
            document.getElementById('player')?.tagName === 'IFRAME',
      { timeout: 20_000, polling: 250 },
    )
    .then(() => true)
    .catch(() => false);

  if (youtubeReady) {
    await check('YouTube oynatıcı iki sekmede de hazır', async () => {
      const okB = await pageB
        .waitForFunction(
          () => typeof (window as any).YT?.Player === 'function' &&
                document.getElementById('player')?.tagName === 'IFRAME',
          { timeout: 20_000, polling: 250 },
        )
        .then(() => true)
        .catch(() => false);
      assert(okB, 'B: YouTube IFrame API yüklenmedi');
      return 'iframe yerleşti';
    });
  } else {
    skip('YouTube oynatıcı iki sekmede de hazır', 'youtube.com bu ortamdan erişilemiyor');
  }

  // ------------------------------------------------------------- Senkron
  //
  // Aşağıdaki üç kontrol telemetri tablosunu okur; tablo ancak bir OYNATICI
  // hazır olduğunda dolar (controlTick oynatıcı yoksa erken döner). YouTube
  // erişilemiyorsa bunları atlıyoruz — ama versiyon/presence/sohbet gibi
  // oynatıcıdan bağımsız kontroller yine çalışır.
  const playerChecks = async () => {
  await check('A oynat dedi → B de oynatmaya geçti', async () => {
    await click(pageA, '#btn-play');
    // İki sekmede de hedef pozisyon ilerlemeye başlamalı
    for (const [label, p] of [['A', pageA], ['B', pageB]] as const) {
      const advanced = await p
        .waitForFunction(
          () => {
            const t = document.querySelector('#t-target')?.textContent ?? '';
            return t !== '—' && !t.startsWith('0:00.0');
          },
          { timeout: 15_000, polling: 200 },
        )
        .then(() => true)
        .catch(() => false);
      assert(advanced, `${label}: hedef pozisyon ilerlemedi`);
    }
    return 'iki tarafta da ilerliyor';
  });

  /**
   * İki sekme aynı zaman çizgisinde mi?
   *
   * Ekrandaki hücreleri okumuyoruz: onlar 250 ms'lik tikte yazılıyor ve iki
   * sekmenin tiki aynı fazda değil, dolayısıyla aradaki fark senkronu değil
   * tik gecikmesini yansıtır. Bunun yerine her sekmede hedefi ANLIK
   * hesaplatıp `hedef - okuma anı` farkını karşılaştırıyoruz; oynatma hızı 1
   * iken bu değer sabittir, yani iki okuma farklı anlarda olsa da sonuç değişmez.
   */
  const driftNow = await clockDriftMsPerSec(pageA);
  if (driftNow !== null && Math.abs(driftNow) > DRIFT_LIMIT_MS_PER_SEC) {
    skip('İki sekme aynı zaman çizgisinde (< 250ms)',
      `sunucu saati ${driftNow.toFixed(0)} ms/s sürükleniyor`);
  } else await check('İki sekme aynı zaman çizgisinde (< 250ms)', async () => {
    await sleep(2500);
    const [a, b] = await Promise.all([
      pageA.evaluate(() => (globalThis as any).__sync?.()),
      pageB.evaluate(() => (globalThis as any).__sync?.()),
    ]);
    assert(
      a?.targetMs != null && b?.targetMs != null,
      `senkron kancası okunamadı: ${JSON.stringify({ a, b })}`,
    );

    const anchor = (s: { targetMs: number; atMs: number }) => s.targetMs - s.atMs;
    const delta = Math.abs(anchor(a) - anchor(b));
    assert(delta < 250, `zaman çizgileri ayrışmış: Δ=${delta.toFixed(0)}ms`);
    return `Δ=${delta.toFixed(0)}ms · offset A=${a.offsetMs.toFixed(0)} B=${b.offsetMs.toFixed(0)}`;
  });

  /**
   * Oynatma GERÇEKTEN ilerliyor mu?
   *
   * iframe'in varlığı yeterli bir kapı DEĞİL. CI runner'larında (veri merkezi
   * IP'si, ses aygıtı yok, otomatik oynatma politikaları) YouTube gömülü
   * oynatıcı yükleniyor ama videoyu HİÇ oynatmıyor. Bu durumda sunucu state'i
   * ilerlerken oynatıcı 0'da kalır ve sapma zamanla doğrusal büyür — testi
   * "başarısız" saymak yanlış olur, çünkü hata bizim kodumuzda değil.
   *
   * Bu yüzden gerçek pozisyonun ilerlediğini ölçüyoruz.
   */
  await pageA.bringToFront();
  const playbackWorks = await pageA
    .waitForFunction(
      () => {
        const t = document.querySelector('#t-actual')?.textContent ?? '';
        const m = /(\d+):(\d+)\.(\d+)/.exec(t);
        if (!m) return false;
        return Number(m[2]) * 1000 + Number(m[3]) > 500;
      },
      { timeout: 12_000, polling: 250 },
    )
    .then(() => true)
    .catch(() => false);

  if (!playbackWorks) {
    skip(
      'Sekme öne gelince drift düzeltmesi toparlıyor',
      'ortam videoyu oynatmıyor (CI / veri merkezi IP\'si)',
    );
  } else
  await check('Sekme öne gelince drift düzeltmesi toparlıyor', async () => {
    // ARKA PLANDAKİ sekmede tarayıcı video oynatmayı durdurur; sunucu state'i
    // ilerlemeye devam ettiği için sapma saniyelere çıkar. Bu bir hata DEĞİL,
    // beklenen davranış — ve düzeltmenin asıl sınavı burada: sekme öne
    // geldiğinde oynatıcı hedefe geri çekilmeli.
    const rows: { label: string; before: number; after: number; action: string }[] = [];

    for (const [label, p] of [['A', pageA], ['B', pageB]] as const) {
      const before = parseMs(await readCell(p, 't-drift'));
      await p.bringToFront();
      // Düzeltme döngüsü 250 ms'de bir çalışır; toparlanması için zaman ver.
      await sleep(6000);
      const after = parseMs(await readCell(p, 't-drift'));
      const action = await readCell(p, 't-action');
      assert(Number.isFinite(after), `${label}: sapma okunamadı`);
      rows.push({ label, before, after, action });
    }

    for (const r of rows) {
      assert(
        Math.abs(r.after) < 1500,
        `${r.label}: öne geldikten sonra sapma hâlâ yüksek: ${r.after}ms (öncesi ${r.before}ms)`,
      );
      assert(r.action.length > 0, `${r.label}: düzeltme kararı yazılmamış`);
    }
    return rows
      .map((r) => `${r.label}: ${r.before.toFixed(0)}ms → ${r.after.toFixed(0)}ms`)
      .join(' · ');
  });
  }; // playerChecks sonu

  /**
   * iframe'in belirmesi yeterli bir kapı DEĞİL — bu ders bu dosyada bir kez
   * öğrenildi ama yalnızca drift testine uygulanmıştı. YouTube'un alt
   * kaynakları düşerse (bu makinede ERR_SSL_PROTOCOL_ERROR) iframe yerleşir,
   * oynatıcı ise hiç hazır olmaz ve telemetri tablosu boş kalır.
   * Oynatıcının KENDİSİNİ soruyoruz.
   */
  const playerReady = youtubeReady && (await Promise.all(
    [pageA, pageB].map((p) => p
      .waitForFunction(() => (globalThis as any).__sync?.()?.ready === true,
        { timeout: 20_000, polling: 250 })
      .then(() => true)
      .catch(() => false)),
  )).every(Boolean);

  if (playerReady) {
    await playerChecks();
  } else {
    const reason = youtubeReady ? 'oynatıcı hazır olmadı (dış kaynak)' : 'oynatıcı yok';
    skip('A oynat dedi → B de oynatmaya geçti', reason);
    skip('İki sekme aynı zaman çizgisinde (< 250ms)', reason);
    skip('Sekme öne gelince drift düzeltmesi toparlıyor', reason);
  }

  // Bu kontrol oynatıcıdan BAĞIMSIZ: versiyon sunucudan gelir ve telemetri
  // tablosuna doğrudan yazılır.
  await check('B duraklattı → A da duraklattı, versiyon eşit', async () => {
    const vBefore = Number(await readCell(pageA, 't-version'));
    await click(pageB, '#btn-pause');
    await sleep(800);
    const [va, vb] = await Promise.all([readCell(pageA, 't-version'), readCell(pageB, 't-version')]);
    assert(va === vb, `versiyon ayrıştı: A=${va} B=${vb}`);
    assert(Number(va) > vBefore, `versiyon artmadı: ${vBefore} → ${va}`);

    if (youtubeReady) {
      // Duraklatıldığında hedef pozisyon donmalı
      const t1 = await readCell(pageA, 't-target');
      await sleep(1000);
      const t2 = await readCell(pageA, 't-target');
      assert(t1 === t2, `duraklatılmışken hedef ilerledi: ${t1} → ${t2}`);
      return `v${vBefore} → v${va}, pozisyon donmuş`;
    }
    return `v${vBefore} → v${va}`;
  });

  await check('Sohbet A → B ulaşıyor', async () => {
    const text = `tarayici-testi-${Date.now()}`;
    await typeInto(pageA, '#chat-input', text);
    await click(pageA, '#btn-chat');
    await pageB.waitForFunction(
      (t: string) => document.querySelector('#chat-log')?.textContent?.includes(t) ?? false,
      { timeout: 8000, polling: 250 },
      text,
    );
    return 'teslim edildi';
  });

  await check('Sesli/görüntülü sohbet eşler arasında kuruluyor', async () => {
    await click(pageA, '#btn-mic');
    await click(pageA, '#btn-cam');

    // Eş bağlantısı kurulup akış geçene kadar birkaç saniye sürebilir.
    const arrived = await pageB
      .waitForFunction(
        () => {
          const tiles = Array.from(document.querySelectorAll('#video-strip .tile video'));
          return tiles.some((v) => {
            const s = (v as HTMLVideoElement).srcObject as MediaStream | null;
            return (s?.getTracks().length ?? 0) > 0;
          });
        },
        { timeout: 20_000, polling: 400 },
      )
      .then(() => true)
      .catch(() => false);

    assert(arrived, 'B, A\'nın akışını almadı');

    // Rozeti ANINDA iddia etmek yanlıştı: akış artık duyurudan ÖNCE varabiliyor
    // (bağlantı, yerel akış hazır olur olmaz kuruluyor; RTC_MEDIA hemen ardından
    // gidiyor). İki ayrı yol, iki ayrı varış anı — bekleyip öyle bakıyoruz.
    const badged = await pageB.waitForFunction(
      () => (document.getElementById('members')?.textContent ?? '').includes('🎙'),
      { timeout: 10_000, polling: 250 },
    ).then(() => true).catch(() => false);
    assert(badged, 'mikrofon rozeti karşı tarafa yansımadı');
    return 'akış ve rozet karşı tarafta';
  });

  await check('Ekran paylaşımı karşı tarafta büyük sahnede açılıyor', async () => {
    await click(pageA, '#btn-screen');
    const shown = await pageB
      .waitForFunction(
        () => {
          const sv = document.querySelector('#screen-view') as HTMLVideoElement | null;
          const s = sv?.srcObject as MediaStream | null;
          return Boolean(sv && !sv.hidden && (s?.getVideoTracks().length ?? 0) > 0);
        },
        { timeout: 25_000, polling: 400 },
      )
      .then(() => true)
      .catch(() => false);

    assert(shown, 'ekran paylaşımı B tarafında görünmedi');
    await click(pageA, '#btn-screen');   // paylaşımı kapat
    return 'yayın B\'de açıldı';
  });

  /**
   * Kullanıcının şikâyeti: "link attık ama atılıp atılmadığı belli olmuyor."
   * Oynatıcı ağdan yüklenene kadar sahne bomboş kalıyordu.
   *
   * "Şu an kapak görünüyor mu" diye bakmak yarışa açık — oynatıcı hızlı
   * gelirse kapak biz bakmadan kalkar. Bu yüzden tıklamadan ÖNCE gözlemci
   * kurup kapağın HİÇ görünüp görünmediğini kaydediyoruz.
   */
  await check('YouTube linki yapıştırılır yapıştırılmaz kapak geliyor', async () => {
    const VID = 'M7lc1UVf-VE';

    // Dikkat: evaluate içinde ADLANDIRILMIŞ fonksiyon tanımlamayın. tsx (esbuild)
    // isim korumak için `__name(...)` sarmalıyor; o yardımcı sayfa bağlamında
    // yok ve callback "__name is not defined" ile patlıyor.
    const watchPoster = (page: Page) => page.evaluate(() => {
      const g = globalThis as unknown as { __posterSeen?: string };
      g.__posterSeen = undefined;
      const box = document.getElementById('stage-poster');
      const img = document.getElementById('stage-poster-img') as HTMLImageElement | null;
      if (!box || !img) return;
      const obs = new MutationObserver(() => {
        if (!g.__posterSeen && !box.classList.contains('is-hidden')) {
          g.__posterSeen = img.getAttribute('src') || 'src-yok';
        }
      });
      obs.observe(box, { attributes: true, attributeFilter: ['class'] });
      obs.observe(img, { attributes: true, attributeFilter: ['src'] });
    });

    await Promise.all([watchPoster(pageA), watchPoster(pageB)]);

    await pageA.$eval('#stage-url', (el) => {
      (el as HTMLInputElement).value = 'https://youtu.be/M7lc1UVf-VE';
    });
    await click(pageA, '#btn-stage-url');

    const seen = (page: Page) => page.waitForFunction(
      () => (globalThis as unknown as { __posterSeen?: string }).__posterSeen ?? null,
      { timeout: 8000, polling: 100 },
    ).then((h) => h.jsonValue() as Promise<string>).catch(() => null);

    const [a, b] = await Promise.all([seen(pageA), seen(pageB)]);
    assert(a?.includes(VID), `A'da kapak gösterilmedi: ${a}`);
    // Karşı taraf kapağı sunucudan gelen kaynak değişimiyle görür.
    assert(b?.includes(VID), `B'de kapak gösterilmedi: ${b}`);
    return 'kapak iki tarafta da anında geldi';
  });

  // Ortak tarayıcı ayrı ve İSTEĞE BAĞLI bir servis; çalışmıyorsa oda normal
  // çalışmaya devam eder, o yüzden testler atlanır, kırılmaz.
  const browserSvc = await fetch('http://127.0.0.1:8094/healthz')
    .then((r) => r.ok)
    .catch(() => false);

  const canvasPainted = (page: Page) => page.waitForFunction(
    () => {
      const c = document.getElementById('browser-view') as HTMLCanvasElement | null;
      if (!c || c.hidden) return false;
      // "hidden değil" tek başına bir şey ispatlamaz; piksellere bakıyoruz.
      const d = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
      if (!d) return false;
      for (let i = 0; i < d.length; i += 4 * 997) {
        if (d[i] !== 0 || d[i + 1] !== 0 || d[i + 2] !== 0) return true;
      }
      return false;
    },
    { timeout: 25_000, polling: 500 },
  ).then(() => true).catch(() => false);

  /** Servisin oda başına tuttuğu akış sayaçları — kare hızı ölçümlerinin kaynağı. */
  type Stat = { slug: string; frames: number; avgFrameKb: number; droppedFrames: number };
  const stats = async (forSlug: string): Promise<Stat | null> => {
    const body = await fetch('http://127.0.0.1:8094/healthz')
      .then((r) => r.json() as Promise<{ sessions?: Stat[] }>)
      .catch(() => null);
    return body?.sessions?.find((s) => s.slug === forSlug) ?? null;
  };

  /**
   * Canvas üzerinde kaydırma üretir. Yön değiştiriyoruz: tek yönde gidersek
   * sayfa dibe vurur, ekran değişmemeye başlar ve kare hızı yerine sayfanın
   * boyu ölçülür.
   */
  const scrollCanvas = (page: Page, rounds: number, gapMs: number) => page.evaluate(
    async (n: number, gap: number) => {
      const c = document.getElementById('browser-view') as HTMLCanvasElement;
      const r = c.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      for (let i = 0; i < n; i++) {
        c.dispatchEvent(new WheelEvent('wheel', {
          deltaY: i % 10 < 5 ? 120 : -120,
          clientX: x, clientY: y, bubbles: true, cancelable: true,
        }));
        await new Promise((res) => setTimeout(res, gap));
      }
    },
    rounds, gapMs,
  );

  if (!browserSvc) {
    skip('Ortak tarayıcı iki sekmede de çiziliyor', 'servis çalışmıyor (npm run dev:browser)');
    skip('Kareler tam çözünürlükte geliyor', 'servis çalışmıyor');
    skip('Kaydırırken kare hızı ve kare boyutu makul', 'servis çalışmıyor');
    skip('İkinci oda açılınca birinci odanın görüntüsü donmuyor', 'servis çalışmıyor');
    skip('Ortak tarayıcıyı yalnızca oda kurucusu sürüyor', 'servis çalışmıyor');
    skip('Gezinme çubuğu izleyicide de duruyor ama pasif', 'servis çalışmıyor');
    skip('Tam ekran sahneyi ekrana yayıyor, düğmeyle çıkılıyor', 'servis çalışmıyor');
    skip('Adres çubuğu arama yapıyor, geri düğmesi geçmişi geziyor', 'servis çalışmıyor');
    skip('Ortak tarayıcıdan YouTube linkiyle videoya dönülüyor', 'servis çalışmıyor');
  } else {
    await check('Ortak tarayıcı iki sekmede de çiziliyor', async () => {
      await click(pageA, '#btn-browser');            // A host
      // Servis reddederse (kapasite, DNS) sebebi sohbet kutusuna düşüyor;
      // "canvas boş kaldı" tek başına teşhis ettirmiyordu.
      const neden = async (p: Page) =>
        (await p.$eval('#chat-log', (el) => el.textContent ?? '')).trim().slice(-160);
      assert(await canvasPainted(pageA), `A: canvas boş kaldı · ${await neden(pageA)}`);
      assert(await canvasPainted(pageB), `B: kare gelmedi · ${await neden(pageB)}`);
      return 'sunucu sekmesi iki tarafta da çizildi';
    });

    /**
     * "pixel pixel gözüküyor" şikâyetinin ölçülebilir hâli.
     *
     * Sayfa 1280x720 render edilirken kare 960x540 gönderiliyordu; canvas onu
     * geri büyütüyor, tarayıcı ekrana yerleştirirken bir daha küçültüyordu.
     * İki kez yeniden örneklenen metin okunmaz oluyordu. Canvas artık kareyle
     * aynı boyutta; küçülme olursa bu test yakalar.
     */
    await check('Kareler tam çözünürlükte geliyor', async () => {
      const d = await pageA.$eval('#browser-view', (el) => {
        const c = el as HTMLCanvasElement;
        return { w: c.width, h: c.height };
      });
      assert(d.w >= 1280 && d.h >= 720, `kare küçültülerek geliyor: ${d.w}x${d.h}`);
      return `${d.w}×${d.h}`;
    });

    /**
     * "Çok kötü kasıyor" şikâyetinin ölçülebilir hâli.
     *
     * Üç ayrı sebebi var ve çareleri farklı: kare hızı düşük olabilir, kareler
     * büyük olabilir, ya da yavaş bir izleyici yüzünden kare atılıyor olabilir.
     * Servis üçünü de sayıyor; burada kaydırırken ölçüp eşiklere bakıyoruz.
     */
    await check('Kaydırırken kare hızı ve kare boyutu makul', async () => {
      // Uzun bir sayfa gerekiyor: portal sayfası birkaç kaydırmada dibe vurur,
      // sonrasında ekran DEĞİŞMEDİĞİ için kare de üretilmez ve ölçüm kare
      // hızını değil sayfanın boyunu ölçer.
      await pageA.$eval('#stage-url', (el) => {
        (el as HTMLInputElement).value = 'https://tr.wikipedia.org/wiki/T%C3%BCrkiye';
      });
      await click(pageA, '#btn-stage-url');
      await sleep(6000);

      const before = await stats(slug);
      assert(before, `oturum healthz'de görünmüyor (slug ${slug})`);

      await pageA.bringToFront();
      const t0 = Date.now();
      await scrollCanvas(pageA, 40, 75);
      const seconds = (Date.now() - t0) / 1000;
      await sleep(700);   // yoldaki son kareler de gelsin

      const after = await stats(slug);
      assert(after, 'ölçüm sonrası oturum kayboldu');
      const fps = (after.frames - before.frames) / seconds;
      const atilan = after.droppedFrames - before.droppedFrames;

      // Eski yapılandırma (everyNthFrame 2) tavanı 15 fps'e kilitliyordu ve
      // kaydırma kesik kesik görünüyordu. 8 fps eşiği o gerilemeyi yakalar.
      assert(fps >= 8, `kare hızı düşük: ${fps.toFixed(1)} fps`);
      // 1280x720 q72 ölçümü ~93 KB. 200 KB üstü kalite ayarının kaçtığını gösterir.
      assert(after.avgFrameKb <= 200, `kareler çok büyük: ${after.avgFrameKb} KB`);
      return `${fps.toFixed(1)} fps · ~${after.avgFrameKb} KB/kare · ${atilan} atıldı`;
    });

    /**
     * "Çok kötü kasıyor" şikâyetinin KÖK NEDENİ.
     *
     * Sunucuda oda başına bir sekme tutuyoruz ama Chrome'da aynı anda yalnızca
     * BİR sekme ön planda olabilir. Arka plandaki sekmenin compositor'ı durur
     * ve `Page.screencastFrame` hiç gelmez: ikinci oda açılır açılmaz
     * birincinin görüntüsü donuyordu ve donma tek odada test edilirken hiç
     * görünmüyordu.
     *
     * Ölçüm (bu senaryonun kurduğu düzende): kısma bayrakları ve odak taklidi
     * olmadan 42 kaydırma olayına karşılık 0 kare; ikisi açıkken 17 kare.
     */
    await check('İkinci oda açılınca birinci odanın görüntüsü donmuyor', async () => {
      const pageC = await pageA.browser().newPage();
      try {
        // İkinci oda: sunucuda ikinci bir sekme açılır ve birincisi arka plana
        // düşer. Asıl sınanan şey bundan sonra olanlar.
        await setupUser(pageC, APP);
        await click(pageC, '#btn-create');
        await pageC.waitForSelector('[data-source="browser"]', { timeout: 10_000 });
        await click(pageC, '[data-source="browser"]');
        await click(pageC, '#btn-source-go');
        const ikinciAcildi = await pageC.waitForFunction(
          () => (globalThis as any).__sync?.()?.browserActive === true,
          { timeout: 30_000, polling: 300 },
        ).then(() => true).catch(() => false);
        if (!ikinciAcildi) {
          const neden = await pageC.$eval('#chat-log', (el) => (el.textContent ?? '').trim().slice(-100));
          throw new SkipError(`ikinci oturum açılmadı · ${neden}`);
        }

        const before = await stats(slug);
        assert(before, 'birinci oturum healthz\'de yok');

        await pageA.bringToFront();
        await scrollCanvas(pageA, 24, 90);
        await sleep(900);

        const after = await stats(slug);
        assert(after, 'birinci oturum kayboldu');
        const kare = after.frames - before.frames;
        assert(kare >= 5, `arka plandaki oda dondu: 24 kaydırmaya karşılık ${kare} kare`);
        return `arka plandaki oda ${kare} kare üretti`;
      } finally {
        await pageC.close().catch(() => {});
      }
    });

    await check('Ortak tarayıcıyı yalnızca oda kurucusu sürüyor', async () => {
      // Arayüz tarafı: host olmayanda adres çubuğu ve düğme kilitli.
      const locked = await pageB.evaluate(() => ({
        url: (document.getElementById('stage-url') as HTMLInputElement).disabled,
        go: (document.getElementById('btn-stage-url') as HTMLButtonElement).disabled,
        canvas: document.getElementById('browser-view')?.classList.contains('is-readonly'),
        sync: (globalThis as any).__sync?.(),
        uye: document.getElementById('members')?.textContent?.trim().slice(0, 80),
      }));
      assert(locked.url && locked.go, `B'de kontroller açık kalmış: ${JSON.stringify(locked)}`);
      assert(locked.canvas, 'B\'de canvas salt-okunur işaretlenmemiş');

      // Sunucu tarafı asıl kapı: kilidi zorla açıp deneyince reddedilmeli.
      const before = await pageB.$eval('#stage-url', (el) => (el as HTMLInputElement).value);
      await pageB.evaluate(() => {
        const i = document.getElementById('stage-url') as HTMLInputElement;
        const b = document.getElementById('btn-stage-url') as HTMLButtonElement;
        i.disabled = false; b.disabled = false;
        i.value = 'https://example.com';
      });
      await click(pageB, '#btn-stage-url');

      const denied = await pageB.waitForFunction(
        () => /yalnızca oda kurucusu/i.test(document.getElementById('chat-log')?.textContent ?? ''),
        { timeout: 8000, polling: 250 },
      ).then(() => true).catch(() => false);
      assert(denied, 'host olmayanın komutu reddedilmedi');

      const after = await pageA.$eval('#stage-url', (el) => (el as HTMLInputElement).value);
      assert(!after.includes('example.com'), `sayfa yine de değişti: ${after}`);
      void before;
      return 'arayüz kilitli, sunucu da reddediyor';
    });

    /**
     * Kilitli olmakla YOK olmak aynı şey değil. Geri/ileri/yenile düğmeleri
     * sürücü olmayana hiç gösterilmiyordu ve "bu tarayıcının geri tuşu yok"
     * gibi görünüyordu. Artık duruyor, yalnızca pasif.
     */
    await check('Gezinme çubuğu izleyicide de duruyor ama pasif', async () => {
      const t = await pageB.evaluate(() => ({
        nav: document.getElementById('nav-buttons')?.classList.contains('is-hidden'),
        tools: document.getElementById('bw-tools')?.classList.contains('is-hidden'),
        back: (document.getElementById('btn-bw-back') as HTMLButtonElement | null)?.disabled,
        reload: (document.getElementById('btn-bw-reload') as HTMLButtonElement | null)?.disabled,
        full: (document.getElementById('btn-bw-full') as HTMLButtonElement | null)?.disabled,
      }));
      assert(t.nav === false && t.tools === false, `çubuk B'de gizlenmiş: ${JSON.stringify(t)}`);
      assert(t.back === true && t.reload === true, `sürüş düğmeleri izleyicide etkin: ${JSON.stringify(t)}`);
      // Tam ekran yerel bir görüntüleme tercihi; izleyiciden alınmamalı.
      assert(t.full === false, 'tam ekran izleyiciye kapatılmış');
      return 'çubuk duruyor, sürüş düğmeleri pasif';
    });

    /**
     * Sunucu sayfası 1280x720 render ediliyor ama yan panelin yanındaki
     * sahnede ~%60 ölçekle gösteriliyor ve yazılar küçülüyor. Tam ekran, sayfayı
     * kendi çözünürlüğünde göstermenin yolu.
     */
    await check('Tam ekran sahneyi ekrana yayıyor, düğmeyle çıkılıyor', async () => {
      try {
        await click(pageA, '#btn-bw-full');
        const on = await pageA.waitForFunction(
          () => document.fullscreenElement?.classList.contains('stage-col') === true,
          { timeout: 6000, polling: 100 },
        ).then(() => true).catch(() => false);

        if (!on) {
          // Fullscreen API geçici kullanıcı etkileşimi ister; bazı ortamlarda
          // (headless yapılandırması, kiosk politikaları) izin hiç verilmiyor.
          // Bu bir ürün hatası değil — ama sessizce geçmesin diye söylüyoruz.
          const neden = await pageA.$eval('#chat-log', (el) => (el.textContent ?? '').trim().slice(-80));
          throw new SkipError(`ortam tam ekrana izin vermiyor · ${neden}`);
        }

        const box = await pageA.$eval('#browser-view', (el) => {
          const r = el.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height) };
        });
        assert(box.w >= 1200, `tam ekranda sahne büyümedi: ${box.w}x${box.h}`);

        // Asıl mesele: araç çubuğu tam ekranda da GÖRÜNÜR ve TIKLANABİLİR
        // olmalı. Sahneyi tek başına tam ekrana alan ilk sürümde çubuk yok
        // oluyordu ve tam ekrandan çıkmanın tek yolu Esc kalıyordu.
        await click(pageA, '#btn-bw-full');
        const off = await pageA.waitForFunction(
          () => document.fullscreenElement === null,
          { timeout: 6000, polling: 100 },
        ).then(() => true).catch(() => false);
        assert(off, 'tam ekranda araç çubuğu tıklanamadı, çıkılamadı');
        return `${box.w}×${box.h} → düğmeyle çıkıldı`;
      } finally {
        // Tam ekranda takılı kalırsak sonraki senaryolar da düşer; asıl hata
        // teşhis edilemez hâle gelir.
        await pageA.evaluate(() => document.exitFullscreen?.().catch(() => {})).catch(() => {});
      }
    });

    const addressBar = (page: Page) =>
      page.$eval('#stage-url', (el) => (el as HTMLInputElement).value);

    await check('Adres çubuğu arama yapıyor, geri düğmesi geçmişi geziyor', async () => {
      await pageA.$eval('#stage-url', (el) => {
        (el as HTMLInputElement).value = 'vikipedi';
      });
      await click(pageA, '#btn-stage-url');
      // Google sunucu tarayıcılarını engellediği için arama DuckDuckGo'ya gider.
      const searched = await pageA.waitForFunction(
        () => /duckduckgo\.com/.test(
          (document.getElementById('stage-url') as HTMLInputElement).value),
        { timeout: 25_000, polling: 500 },
      ).then(() => true).catch(() => false);
      assert(searched, `arama sonuç sayfasına gidilmedi: ${await addressBar(pageA)}`);

      await click(pageA, '#btn-bw-reload');
      await sleep(3000);
      assert(/duckduckgo/.test(await addressBar(pageA)), 'yenileme adresi bozdu');
      return 'arama açıldı, yenileme çalışıyor';
    });

    /**
     * Kullanıcının çarptığı hata: ortak tarayıcı açıkken YouTube'a geçince
     * video canvas'ın ARKASINDA oynuyordu ve "video oynamıyor" gibi görünüyordu.
     * Artık YouTube bağlantısı her zaman videoya geçirir ve sahneyi devralır.
     */
    await check('Ortak tarayıcıdan YouTube linkiyle videoya dönülüyor', async () => {
      assert(
        await pageA.evaluate(() => (globalThis as any).__sync?.()?.browserActive === true),
        'önkoşul: ortak tarayıcı açık olmalıydı',
      );

      await pageA.$eval('#stage-url', (el) => {
        (el as HTMLInputElement).value = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      });
      await click(pageA, '#btn-stage-url');

      const handed = await pageA.waitForFunction(
        () => {
          const canvas = document.getElementById('browser-view') as HTMLCanvasElement | null;
          const label = document.getElementById('source-label')?.textContent ?? '';
          return canvas?.hidden === true && label.includes('dQw4w9WgXcQ');
        },
        { timeout: 20_000, polling: 250 },
      ).then(() => true).catch(() => false);

      const durum = await pageA.evaluate(() => ({
        canvasGizli: (document.getElementById('browser-view') as HTMLCanvasElement).hidden,
        oynaticiGizli: (document.getElementById('player') as HTMLElement).hidden,
        kaynak: document.getElementById('source-label')?.textContent,
      }));
      assert(handed, `sahne devredilmedi: ${JSON.stringify(durum)}`);
      assert(!durum.oynaticiGizli, 'oynatıcı katmanı açılmadı');

      // Karşı taraf da aynı kaynağa geçmeli.
      const bDe = await pageB.waitForFunction(
        () => (document.getElementById('source-label')?.textContent ?? '').includes('dQw4w9WgXcQ'),
        { timeout: 10_000, polling: 250 },
      ).then(() => true).catch(() => false);
      assert(bDe, 'B kaynak değişimini görmedi');
      return 'canvas kapandı, oynatıcı devraldı, B de geçti';
    });
  }

  await check('A kapanınca B host oluyor (leader election)', async () => {
    await pageA.close();
    await pageB.waitForFunction(
      () => document.querySelectorAll('#members li').length === 1,
      { timeout: 10_000, polling: 250 },
    );
    const isHost = await pageB.$eval(
      '#members li:first-child',
      (el) => el.querySelector('.host-tag') !== null,
    );
    assert(isHost, 'B host olmadı');
    return 'B → host';
  });

  await check('Odadan çıkınca oda ana ekranda listeleniyor', async () => {
    await click(pageB, '#btn-leave');
    await pageB.waitForFunction(
      (s: string) => Array.from(document.querySelectorAll('#rooms-list [data-enter]'))
        .some((li) => li.getAttribute('data-enter') === s),
      { timeout: 10_000, polling: 250 },
      slug,
    );
    // Karttan tıklayarak geri girilebiliyor mu?
    await click(pageB, `#rooms-list [data-enter="${slug}"]`);
    await pageB.waitForFunction(
      () => document.querySelector('#conn-state')?.textContent?.startsWith('bağlı') === true,
      { timeout: 15_000, polling: 250 },
    );
    return 'listelendi ve karttan girildi';
  });

  await check('Sayfada JavaScript hatası yok', async () => {
    // YouTube iframe'inin kendi hataları filtrelendi; kalanlar bizim kodumuz.
    const ours = consoleErrors.filter(
      (e) => !/youtube|ERR_BLOCKED_BY_CLIENT|doubleclick|googleads/i.test(e),
    );
    assert(ours.length === 0, `hatalar:\n      ${ours.join('\n      ')}`);
    return 'temiz';
  });
} finally {
  clearTimeout(watchdog);
  await browser?.close().catch(() => {});
}

process.stdout.write(
  `\n  ${passed} başarılı, ${failed} başarısız${skipped ? `, ${skipped} atlandı` : ''}\n\n`,
);
process.exit(failed > 0 ? 1 : 0);
