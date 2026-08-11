/**
 * Oda başına bir sunucu tarayıcısı.
 *
 * Bilgisayarında bir şey açılmıyor: Chrome BURADA, sunucuda çalışıyor.
 * Görüntüyü CDP'nin `Page.startScreencast` akışından JPEG kare olarak alıp
 * odadaki herkese yolluyoruz; fare ve klavye olayları da ters yönde aynı
 * sayfaya basılıyor. Yani herkes aynı sekmeyi görüyor ve kullanabiliyor.
 *
 * Neden WebRTC değil: sunucudan WebRTC yayını için bir medya sunucusu
 * (Pion/GStreamer) gerekirdi. Screencast yaklaşımı saf Node ile çalışıyor ve
 * mevcut WebSocket altyapımıza oturuyor. Bedeli: ses YOK ve kare hızı sınırlı.
 * Sesli birlikte izleme için YouTube modu zaten var ve senkron motoruyla
 * çalışıyor; bu mod gezinmek, birlikte bir siteye bakmak için.
 */
import { existsSync } from 'node:fs';
import puppeteer, { type Browser, type Page, type CDPSession } from 'puppeteer-core';

import { createLogger } from '../shared/logger.ts';
import { loadBrowserConfig } from '../shared/config.ts';

const log = createLogger('browser');
const cfg = loadBrowserConfig();

/**
 * Sayfa hangi boyutta render ediliyorsa tele o boyutta gider.
 *
 * Önceki sürüm 1280x720 render edip 960x540 gönderiyordu; istemci bunu geri
 * büyütünce metin bulanıklaşıyordu. Bant genişliğini ölçekle değil, kalite ve
 * GERİ BASINÇLA yönetiyoruz: yavaş izleyici kare atlar, hızlı izleyici tam
 * çözünürlük görür.
 */
const VIEWPORT = { width: cfg.BROWSER_WIDTH, height: cfg.BROWSER_HEIGHT };

/**
 * Screencast'ten her kareyi iste (`everyNthFrame: 1`).
 *
 * Sabit bir bölme (2 ≈ 15 fps) yanlış yeri kısıtlıyordu: kaydırma ve video
 * takılıyor, buna karşılık durgun sayfada hiçbir kazanç olmuyordu. Screencast
 * zaten yalnızca ekran DEĞİŞTİĞİNDE kare üretir; hızı asıl sınırlayan şey
 * aşağıdaki geri basınç kontrolü.
 */
const EVERY_NTH_FRAME = 1;

/**
 * Sayfa içinde çalışır: her açılışı AYNI sekmeye çeker.
 *
 * Sunucudaki sekmeyi odadaki herkes izliyor; yeni bir pencere açılırsa onu
 * kimse göremez. Kullanıcı bağlantıya tıklıyor ve ekranda hiçbir şey
 * değişmiyordu — "tarayıcıyı kullanamıyoruz" şikâyetinin bir parçası buydu.
 */
const SAME_TAB_SCRIPT = `
  window.open = function (url) { if (url) location.href = String(url); return null; };
  addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[target]');
    if (a && a.target && a.target !== '_self') a.target = '_self';
  }, true);
`;

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
];

function findChrome(): string {
  if (cfg.CHROME_PATH) return cfg.CHROME_PATH;
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      'Chrome bulunamadı. CHROME_PATH ortam değişkeniyle yolu verin.',
    );
  }
  return found;
}

/**
 * İstemci soketinin bu modülün ihtiyaç duyduğu kadarı. `ws` tipini buraya
 * taşımamak için yapısal tip kullanıyoruz — oturum mantığı taşımadan bağımsız.
 */
export type Viewer = {
  readyState: number;
  /** Soketin henüz ağa verilmemiş bayt sayısı — geri basıncın ölçüsü. */
  readonly bufferedAmount: number;
  /** Buffer verildiğinde ws zaten ikili çerçeve gönderir; ayrıca işaretlemeye gerek yok. */
  send(data: string | Buffer): void;
};

export type MouseButton = 'none' | 'left' | 'middle' | 'right';

let browserPromise: Promise<Browser> | null = null;

async function sharedBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        /**
         * Arka plandaki sekme kare ÜRETMEZ.
         *
         * Chrome görünmeyen sekmenin işleyicisini kısar; compositor durur ve
         * `Page.screencastFrame` hiç gelmez. Sunucuda oda başına bir sekme
         * tutuyoruz ve yalnızca biri ön planda olabiliyor — ikinci oda açılır
         * açılmaz birincisinin görüntüsü DONUYORDU.
         *
         * Ölçüm (iki oda açıkken, eski odada kaydırma): bu bayraklar ve
         * aşağıdaki odak taklidi olmadan 42 kaydırma olayına karşılık 0 kare;
         * ikisi açıkken aynı senaryoda 17 kare.
         */
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-background-timer-throttling',
        // Sunucudaki tarayıcının kullanıcının cihazlarına erişimi yok; istemesin.
        '--use-fake-device-for-media-stream',
        // Otomasyon bayrağı açıkken birçok site bozuk/kısıtlı sayfa döndürüyor.
        // Burada gerçek bir kullanıcı geziniyor; sayfa normal render edilsin.
        '--disable-blink-features=AutomationControlled',
        `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      ],
    });
    browserPromise.catch(() => { browserPromise = null; });
  }
  return browserPromise;
}

export class BrowserSession {
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;
  private loading = false;

  readonly viewers = new Set<Viewer>();
  currentUrl = '';
  readonly slug: string;

  /**
   * Son gönderilen kare.
   *
   * Screencast yalnızca ekran DEĞİŞTİĞİNDE kare üretir; durgun bir sayfada
   * dakikalarca hiç kare gelmez. Sonradan katılan biri bu yüzden bomboş bir
   * ekrana bakıyordu. Son kareyi saklayıp girişte hemen yolluyoruz.
   */
  private lastFrame: Buffer | null = null;

  constructor(slug: string) {
    this.slug = slug;
  }

  get active(): boolean {
    return this.page !== null;
  }

  /**
   * Kareler İKİLİ gider: base64 sarmalamak %33 fazladan bant genişliği demek.
   *
   * Yavaş bir izleyiciye kare yığmak görüntüyü hızlandırmaz, GECİKTİRİR: soket
   * kuyruğu büyür ve izleyici giderek geçmişi seyretmeye başlar. Kuyruğu dolu
   * olana kare atlıyoruz — atlanan kare kaybolmuş sayılmaz, bir sonraki kare
   * zaten daha güncelini taşıyor.
   */
  private sendFrame(jpeg: Buffer): void {
    this.lastFrame = jpeg;
    this.frames += 1;
    this.bytes += jpeg.byteLength;
    for (const v of this.viewers) {
      if (v.readyState !== 1) continue;
      if (v.bufferedAmount > cfg.BROWSER_MAX_BUFFERED_BYTES) {
        this.dropped += 1;
        continue;
      }
      v.send(jpeg);
    }
  }

  /**
   * Akış sayaçları.
   *
   * "Takılıyor" şikâyetini kodu okuyarak çözmek mümkün değil: kare hızı mı
   * düşük, kareler mi büyük, yoksa yavaş bir izleyici yüzünden mi atılıyor —
   * üçünün çaresi ayrı. /healthz bunları veriyor.
   */
  frames = 0;
  bytes = 0;
  dropped = 0;
  readonly since = Date.now();

  stats(): Record<string, number> {
    const seconds = Math.max(1, (Date.now() - this.since) / 1000);
    return {
      frames: this.frames,
      fps: Math.round((this.frames / seconds) * 10) / 10,
      avgFrameKb: this.frames ? Math.round(this.bytes / this.frames / 1024) : 0,
      droppedFrames: this.dropped,
      viewers: this.viewers.size,
    };
  }

  /** Yeni katılana o anki görüntüyü hemen ver. */
  primeViewer(v: Viewer): void {
    if (this.lastFrame && v.readyState === 1) v.send(this.lastFrame);
  }

  broadcast(message: unknown): void {
    const body = JSON.stringify(message);
    for (const v of this.viewers) {
      if (v.readyState === 1) v.send(body);
    }
  }

  /** Odadaki herkesin gördüğü tek gerçek: sayfa açık mı, hangi adreste. */
  broadcastState(by?: string): void {
    this.broadcast({ type: 'BROWSER_STATE', active: this.active, url: this.currentUrl, by });
  }

  /** Sayfayı açar (zaten açıksa hiçbir şey yapmaz) ve verilen adrese gider. */
  async start(url: string): Promise<void> {
    if (this.starting) await this.starting;
    if (!this.page) {
      this.starting = this.launch();
      try {
        await this.starting;
      } finally {
        this.starting = null;
      }
    }
    await this.navigate(url);
  }

  private async launch(): Promise<void> {
    const browser = await sharedBrowser();
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);

    // Varsayılan UA "HeadlessChrome" içeriyor ve bazı siteler buna sadeleşmiş
    // ya da hiç sayfa döndürmüyor. Sürüm numarası kurulu Chromium'un kendisi.
    await page.setUserAgent((await browser.version()).replace('HeadlessChrome', 'Chrome')
      .replace(/^/, 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ')
      .concat(' Safari/537.36'));
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8' });

    /**
     * Yeni sekme diye bir şey yok — herkes TEK sekmeyi izliyor.
     *
     * `target="_blank"` bağlantılar ve `window.open` sunucuda görünmez bir
     * sayfa açıyordu: kullanıcı tıklıyor, ekranda hiçbir şey değişmiyordu.
     * Açılışı aynı sekmeye çeviriyoruz.
     */
    // Metin olarak veriyoruz: sunucu tarafı tsconfig'inde DOM tipleri yok ve
    // olmasını da istemiyoruz (bkz. tsconfig.json'daki not).
    await page.evaluateOnNewDocument(SAME_TAB_SCRIPT);

    // Emniyet kemeri: yine de bir pencere açılırsa onu kapatıp adresi asıl
    // sekmede açıyoruz — yoksa görünmez bir sekmede kaybolur.
    page.on('popup', (popup) => {
      void (async () => {
        const url = popup?.url();
        await popup?.close().catch(() => {});
        if (url && url !== 'about:blank') await this.navigate(url);
      })();
    });

    /**
     * alert/confirm/prompt sayfayı KİLİTLER ve sunucuda kimse "Tamam"a
     * basamaz — screencast donar, oda çalışmaz hâle gelirdi. Kapatıp odaya
     * ne yazdığını söylüyoruz.
     */
    page.on('dialog', (dialog) => {
      void dialog.dismiss().catch(() => {});
      this.broadcast({ type: 'BROWSER_ERROR', message: `Sayfa bir uyarı gösterdi: ${dialog.message()}` });
    });

    const cdp = await page.createCDPSession();

    /**
     * Ack ŞART: göndermezsek Chrome yeni kare üretmeyi durdurur. Ama ack'i
     * GECİKTİRMEK kare hızını frenlemenin doğru yeri — Chrome bir sonraki
     * kareyi ancak ack'ten sonra üretir, yani ağ trafiği ve JPEG kodlama
     * maliyeti BİRLİKTE düşer. `everyNthFrame` yalnızca ikincisini düşürüyor,
     * üstelik kaba adımlarla (2 = yarısı, 3 = üçte biri).
     */
    const minGapMs = Math.round(1000 / cfg.BROWSER_MAX_FPS);
    let nextAckAt = 0;
    cdp.on('Page.screencastFrame', (evt: { data: string; sessionId: number }) => {
      this.sendFrame(Buffer.from(evt.data, 'base64'));
      const wait = Math.max(0, nextAckAt - Date.now());
      nextAckAt = Date.now() + wait + minGapMs;
      const ack = (): void => {
        void cdp.send('Page.screencastFrameAck', { sessionId: evt.sessionId }).catch(() => {});
      };
      if (wait === 0) ack();
      else setTimeout(ack, wait).unref();
    });

    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      this.currentUrl = frame.url();
      this.broadcast({ type: 'BROWSER_URL', url: this.currentUrl });
    });

    // Sayfa İÇİNDEN tıklanan bağlantılar goto'dan geçmez; yükleniyor
    // göstergesini onlar için de doğru tutmak gerekiyor.
    cdp.on('Page.frameStartedLoading', () => this.setLoading(true));
    cdp.on('Page.frameStoppedLoading', () => this.setLoading(false));

    await cdp.send('Page.enable');
    /**
     * Sekmeye "sen odaktasın" dedir.
     *
     * Komut satırı bayrakları işleyici kısmasını engelliyor ama görünürlük
     * ayrı bir mesele: yalnızca BİR sekme ön planda olabilir ve diğerlerinin
     * sayfa görünürlüğü `hidden` kalır. Bu bayrak olmadan ikinci odanın açılması
     * birincinin görüntüsünü donduruyordu. Odaklanmayı taklit etmek her sekmeyi
     * bağımsız olarak canlı tutar.
     */
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    // Sunucunun diskine dosya indirtmeyelim; kimse o dosyayı göremiyor zaten.
    await cdp.send('Page.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: cfg.BROWSER_QUALITY,
      maxWidth: VIEWPORT.width,
      maxHeight: VIEWPORT.height,
      everyNthFrame: EVERY_NTH_FRAME,
    });

    this.page = page;
    this.cdp = cdp;
    log.info({ slug: this.slug }, 'Ortak tarayıcı sayfası açıldı');
  }

  async navigate(rawUrl: string): Promise<void> {
    if (!this.page) return;
    const url = toTargetUrl(rawUrl);
    if (!url) {
      this.broadcast({ type: 'BROWSER_ERROR', message: `Geçersiz adres: ${rawUrl}` });
      return;
    }

    const previous = this.currentUrl;
    this.currentUrl = url;
    this.setLoading(true);

    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      // Sessizce başarısız olmak en kötüsüydü: adres çubuğu değişiyor, ekranda
      // eski sayfa duruyor ve kimse neden olmadığını bilmiyordu.
      const message = explainNavError((err as Error).message, url);
      log.warn({ slug: this.slug, url, err: (err as Error).message }, 'Sayfa açılamadı');
      this.currentUrl = previous;
      this.broadcast({ type: 'BROWSER_ERROR', message });
      this.broadcast({ type: 'BROWSER_URL', url: previous });
    } finally {
      this.setLoading(false);
    }
  }

  /** Sayfa yükleniyor mu — istemcide ince bir çubuk olarak görünüyor. */
  private setLoading(on: boolean): void {
    if (this.loading === on) return;
    this.loading = on;
    this.broadcast({ type: 'BROWSER_LOADING', loading: on });
  }

  /** Geri/ileri/yenile. Geçmişin ucundaysak puppeteer null döner, sorun değil. */
  async back(): Promise<void> {
    if (!this.page) return;
    this.setLoading(true);
    await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    this.setLoading(false);
  }

  async forward(): Promise<void> {
    if (!this.page) return;
    this.setLoading(true);
    await this.page.goForward({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    this.setLoading(false);
  }

  async reload(): Promise<void> {
    if (!this.page) return;
    this.setLoading(true);
    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    this.setLoading(false);
  }

  async mouse(evt: {
    kind: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
    x: number; y: number; button?: MouseButton; deltaX?: number; deltaY?: number;
    modifiers?: number; buttons?: number; clickCount?: number;
  }): Promise<void> {
    if (!this.cdp) return;
    const pressed = evt.kind === 'mousePressed' || evt.kind === 'mouseReleased';
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: evt.kind,
      x: clamp(evt.x, VIEWPORT.width),
      y: clamp(evt.y, VIEWPORT.height),
      button: evt.button ?? 'none',
      // `buttons` hareket sırasında hangi tuşun BASILI olduğunu söyler.
      // Olmadığında Chrome sürüklemeyi hiç görmüyordu: metin seçilemiyor,
      // kaydırma çubuğu taşınamıyor, harita kaydırılamıyordu.
      buttons: evt.buttons ?? 0,
      clickCount: pressed ? (evt.clickCount ?? 1) : 0,
      modifiers: evt.modifiers ?? 0,
      deltaX: evt.deltaX ?? 0,
      deltaY: evt.deltaY ?? 0,
    }).catch(() => {});
  }

  /**
   * Metin üreten tuşlarla üretmeyenler CDP'de AYRI olaylardır.
   *
   * Hepsini `keyDown` olarak yollarsak Chrome ok tuşlarını ve Escape'i de
   * metin sanıp yutuyor; `text` vermezsek harfler hiç yazılmıyor. Puppeteer'ın
   * kendi klavyesi de tam olarak bu ayrımı yapıyor.
   */
  async key(evt: {
    kind: 'keyDown' | 'keyUp' | 'char';
    key?: string; code?: string; text?: string; keyCode?: number; modifiers?: number;
  }): Promise<void> {
    if (!this.cdp) return;
    const text = evt.text ?? IMPLICIT_TEXT[evt.key ?? ''];
    const type = evt.kind === 'keyDown' && !text ? 'rawKeyDown' : evt.kind;
    await this.cdp.send('Input.dispatchKeyEvent', {
      type,
      key: evt.key,
      code: evt.code,
      text,
      // Ctrl+A / Ctrl+C gibi kısayollar `text` değil, DEĞİŞTİRİCİ ister.
      unmodifiedText: text,
      modifiers: evt.modifiers ?? 0,
      windowsVirtualKeyCode: evt.keyCode,
      nativeVirtualKeyCode: evt.keyCode,
    }).catch(() => {});
  }

  /** Son izleyici ayrıldı: hemen kapatmıyoruz, kısa süre bekliyoruz. */
  scheduleIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.close().then(() => {
        // Kaydı da düşür. Yalnızca sayfayı kapatmak yetmiyordu: kayıt haritada
        // kalıyor, kapasite sayacı doluyor ve servis bir süre sonra hiçbir yeni
        // odayı kabul etmiyordu.
        if (this.viewers.size === 0) sessions.delete(this.slug);
      });
    }, cfg.BROWSER_IDLE_MS);
    this.idleTimer.unref();
  }

  cancelIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  async close(): Promise<void> {
    this.cancelIdleClose();
    const page = this.page;
    this.page = null;
    this.cdp = null;
    this.currentUrl = '';
    this.lastFrame = null;
    if (page) {
      await page.close().catch(() => {});
      log.info({ slug: this.slug }, 'Ortak tarayıcı sayfası kapatıldı');
    }
  }
}

function clamp(v: number, max: number): number {
  return Math.max(0, Math.min(max, Math.round(v)));
}

/**
 * Tek karakterlik olmadıkları için istemcinin `text` yollamadığı, ama Chrome'un
 * metin bekledigi tuşlar. Enter'sız bir adres çubuğu işe yaramaz.
 */
const IMPLICIT_TEXT: Record<string, string | undefined> = {
  Enter: '\r',
  NumpadEnter: '\r',
  Tab: '\t',
};

/** Chrome'un ağ hatalarını kullanıcının anlayacağı cümleye çevirir. */
function explainNavError(raw: string, url: string): string {
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  if (raw.includes('ERR_NAME_NOT_RESOLVED')) {
    return `${host} çözümlenemedi — sunucunun DNS ayarlarını kontrol edin`;
  }
  if (raw.includes('ERR_INTERNET_DISCONNECTED') || raw.includes('ERR_NETWORK_CHANGED')) {
    return 'Sunucunun internet bağlantısı yok';
  }
  if (raw.includes('ERR_CONNECTION_REFUSED') || raw.includes('ERR_CONNECTION_TIMED_OUT')) {
    return `${host} bağlantıyı kabul etmedi`;
  }
  if (raw.includes('ERR_CERT') || raw.includes('SSL')) {
    return `${host} sertifikası doğrulanamadı`;
  }
  if (raw.toLowerCase().includes('timeout')) {
    return `${host} 30 saniyede yüklenmedi`;
  }
  return `${host} açılamadı`;
}

/**
 * Adresi güvenli hâle getirir.
 *
 * `file://` ve `chrome://` şemaları sunucunun kendi diskine ve iç sayfalarına
 * açılan kapıdır — sunucuda çalışan bir tarayıcıda bunlara izin vermek dosya
 * okutmak demektir.
 */
/**
 * Adres çubuğu aynı zamanda arama kutusu.
 *
 * Arama motoru DuckDuckGo, çünkü Google sunucuda çalışan tarayıcıları
 * `google.com/sorry` bot kontrolüne yolluyor — ölçtük. DuckDuckGo, Bing,
 * Wikipedia ve YouTube araması sorunsuz açılıyor.
 */
const SEARCH_URL = 'https://duckduckgo.com/?q=';

/** Nokta içeren, boşluksuz bir şey adres sayılır; gerisi arama. */
function looksLikeAddress(s: string): boolean {
  if (/^https?:\/\//i.test(s)) return true;
  return /^[^\s/]+\.[^\s/]{2,}(\/\S*)?$/.test(s);
}

export function toTargetUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (looksLikeAddress(s)) return normalizeUrl(s);
  return SEARCH_URL + encodeURIComponent(s);
}

export function normalizeUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

export const sessions = new Map<string, BrowserSession>();

export function sessionFor(slug: string): BrowserSession {
  const existing = sessions.get(slug);
  if (existing) return existing;

  // Tavan AÇIK sekmeleri sınırlar, kayıt sayısını değil. Sayfası kapalı bir
  // kayıt Chrome kaynağı tüketmiyor; onu saymak kapasiteyi boş yere doldurur.
  const open = [...sessions.values()].filter((s) => s.active).length;
  if (open >= cfg.BROWSER_MAX_SESSIONS) {
    throw new Error(`Aynı anda en fazla ${cfg.BROWSER_MAX_SESSIONS} oda ortak tarayıcı kullanabilir`);
  }

  const s = new BrowserSession(slug);
  sessions.set(slug, s);
  return s;
}

export async function shutdownBrowser(): Promise<void> {
  for (const s of sessions.values()) await s.close();
  sessions.clear();
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    await b?.close().catch(() => {});
    browserPromise = null;
  }
}
