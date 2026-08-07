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
    p.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('youtube')) {
        consoleErrors.push(`${label}: ${m.text()}`);
      }
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
    assert(Math.abs(offset) < 500, `offset beklenenden büyük: ${offset}ms`);
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

  await check('İki sekmenin hedef pozisyonu birbirine yakın (< 250ms)', async () => {
    await sleep(2500);
    // Aynı anda oku ki ölçüm arası gecikme sonucu bozmasın
    const [ta, tb] = await Promise.all([
      pageA.evaluate(() => document.querySelector('#t-target')?.textContent ?? ''),
      pageB.evaluate(() => document.querySelector('#t-target')?.textContent ?? ''),
    ]);
    const toMs = (s: string) => {
      const m = /(\d+):(\d+)\.(\d+)/.exec(s);
      return m ? Number(m[1]) * 60000 + Number(m[2]) * 1000 + Number(m[3]) : NaN;
    };
    const a = toMs(ta);
    const b = toMs(tb);
    assert(Number.isFinite(a) && Number.isFinite(b), `okunamadı: "${ta}" / "${tb}"`);
    const delta = Math.abs(a - b);
    assert(delta < 250, `hedefler ayrışmış: Δ=${delta}ms (${ta} vs ${tb})`);
    return `A=${ta} B=${tb} Δ=${delta}ms`;
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

  if (youtubeReady) {
    await playerChecks();
  } else {
    skip('A oynat dedi → B de oynatmaya geçti', 'oynatıcı yok');
    skip('İki sekmenin hedef pozisyonu birbirine yakın (< 250ms)', 'oynatıcı yok');
    skip('Drift düzeltmesi çalışıyor ve sapma sınırlı', 'oynatıcı yok');
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
    const badge = await pageB.$eval('#members', (el) => el.textContent ?? '');
    assert(badge.includes('🎙'), 'mikrofon rozeti karşı tarafa yansımadı');
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
