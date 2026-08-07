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
  await page.click('#btn-random');
  await page.click('#btn-register');
  await page.waitForFunction(
    () => document.querySelector('#auth-status')?.classList.contains('ok'),
    { timeout: 15_000 },
  );
}

// ================================================================== Akış
process.stdout.write(`\n  Faz 1 tarayıcı testi → ${APP}  ${DIM}(headless=${HEADLESS})${RESET}\n\n`);

const executablePath = findChrome();
let browser: Browser | null = null;

try {
  browser = await puppeteer.launch({
    executablePath,
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // Otomasyonda medya otomatik oynatma engelini kaldır
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--window-size=1280,900',
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
    assert(status.includes('Giriş yapıldı'), `beklenmeyen durum: ${status}`);
    return status;
  });

  let slug = '';
  await check('Sekme A: oda oluşturuluyor', async () => {
    await pageA.click('#btn-create');
    await pageA.waitForFunction(
      () => (document.querySelector('#room-slug') as HTMLInputElement)?.value.length > 0,
      { timeout: 15_000 },
    );
    slug = await pageA.$eval('#room-slug', (el) => (el as HTMLInputElement).value);
    assert(/^[a-z0-9-]{6,32}$/.test(slug), `slug biçimi hatalı: ${slug}`);
    return slug;
  });

  await check('Sekme A: WebSocket bağlandı', async () => {
    await pageA.waitForFunction(
      () => document.querySelector('#conn-state')?.textContent === 'bağlı',
      { timeout: 15_000 },
    );
    return 'bağlı';
  });

  await check('Sekme A: saat senkronu ölçüldü (offset + RTT)', async () => {
    await pageA.waitForFunction(
      () => !document.querySelector('#t-offset')?.textContent?.includes('—'),
      { timeout: 15_000 },
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
    await pageB.click('#btn-join');
    await pageB.waitForFunction(
      () => document.querySelector('#conn-state')?.textContent === 'bağlı',
      { timeout: 15_000 },
    );
    return 'bağlandı';
  });

  await check('İki sekme de 2 katılımcı görüyor, host = A', async () => {
    for (const [label, p] of [['A', pageA], ['B', pageB]] as const) {
      await p.waitForFunction(
        () => document.querySelectorAll('#members li').length === 2,
        { timeout: 10_000 },
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
  await check('YouTube oynatıcı iki sekmede de hazır', async () => {
    for (const [label, p] of [['A', pageA], ['B', pageB]] as const) {
      const ok = await p
        .waitForFunction(
          () => {
            const w = window as any;
            return typeof w.YT?.Player === 'function' &&
                   document.querySelector('#player iframe') !== null;
          },
          { timeout: 25_000 },
        )
        .then(() => true)
        .catch(() => false);
      assert(ok, `${label}: YouTube IFrame API yüklenmedi (ağ engeli olabilir)`);
    }
    return 'iframe yerleşti';
  });

  // ------------------------------------------------------------- Senkron
  await check('A oynat dedi → B de oynatmaya geçti', async () => {
    await pageA.click('#btn-play');
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

  await check('Drift düzeltmesi çalışıyor ve sapma sınırlı', async () => {
    await sleep(3000);
    const rows: { label: string; drift: number; action: string }[] = [];
    for (const [label, p] of [['A', pageA], ['B', pageB]] as const) {
      const drift = parseMs(await readCell(p, 't-drift'));
      const action = await readCell(p, 't-action');
      assert(Number.isFinite(drift), `${label}: sapma okunamadı`);
      rows.push({ label, drift, action });
    }
    // Gerçek bir oynatıcıyla küçük sapma normaldir; 2 saniyeyi aşmamalı.
    for (const r of rows) {
      assert(Math.abs(r.drift) < 2000, `${r.label}: sapma çok yüksek ${r.drift}ms`);
      assert(r.action.length > 0, `${r.label}: düzeltme kararı yazılmamış`);
    }
    return rows.map((r) => `${r.label}:${r.drift}ms "${r.action}"`).join(' · ');
  });

  await check('B duraklattı → A da duraklattı, versiyon eşit', async () => {
    const vBefore = Number(await readCell(pageA, 't-version'));
    await pageB.click('#btn-pause');
    await sleep(800);
    const [va, vb] = await Promise.all([readCell(pageA, 't-version'), readCell(pageB, 't-version')]);
    assert(va === vb, `versiyon ayrıştı: A=${va} B=${vb}`);
    assert(Number(va) > vBefore, `versiyon artmadı: ${vBefore} → ${va}`);
    // Duraklatıldığında hedef pozisyon donmalı
    const t1 = await readCell(pageA, 't-target');
    await sleep(1000);
    const t2 = await readCell(pageA, 't-target');
    assert(t1 === t2, `duraklatılmışken hedef ilerledi: ${t1} → ${t2}`);
    return `v${vBefore} → v${va}, pozisyon donmuş`;
  });

  await check('Sohbet A → B ulaşıyor', async () => {
    const text = `tarayici-testi-${Date.now()}`;
    await pageA.type('#chat-input', text);
    await pageA.click('#btn-chat');
    await pageB.waitForFunction(
      (t: string) => document.querySelector('#chat-log')?.textContent?.includes(t) ?? false,
      { timeout: 8000 },
      text,
    );
    return 'teslim edildi';
  });

  await check('A kapanınca B host oluyor (leader election)', async () => {
    await pageA.close();
    await pageB.waitForFunction(
      () => document.querySelectorAll('#members li').length === 1,
      { timeout: 10_000 },
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
  await browser?.close();
}

process.stdout.write(`\n  ${passed} başarılı, ${failed} başarısız\n\n`);
process.exit(failed > 0 ? 1 : 0);
