// @ts-check
/**
 * Ortak tarayıcı istemcisi.
 *
 * Sunucuda çalışan bir Chrome sekmesinin görüntüsünü JPEG kare akışı olarak
 * alıp canvas'a çizer; fare ve klavyeyi geri yollar. Sekme senin bilgisayarında
 * değil sunucuda olduğu için herkes aynı sayfayı görür ve kullanabilir.
 *
 * Ses YOK: CDP screencast yalnızca görüntü verir. Sesli birlikte izleme için
 * YouTube modu var, o senkron motoruyla çalışıyor.
 */

/**
 * Sunucudaki sayfanın boyutu. Başlangıç değeri yalnızca ilk kare gelene
 * kadar geçerli: kare geldiğinde canvas'ı GERÇEK boyutuna kuruyoruz ve
 * koordinatları oradan hesaplıyoruz. Böylece sunucu tarafındaki boyut ayarı
 * değişince istemciyi ayrıca güncellemek gerekmiyor.
 */
const DEFAULT_PAGE_W = 1280;
const DEFAULT_PAGE_H = 720;

export function createSharedBrowser({ canvas, wsBase, getTicket, onState, onUrl, onLoading, onError }) {
  const ctx = canvas.getContext('2d', { alpha: false });
  canvas.width = DEFAULT_PAGE_W;
  canvas.height = DEFAULT_PAGE_H;

  let ws = null;
  let pending = null;   // çizilmeyi bekleyen son kare
  let drawing = false;
  /** Sayfayı yalnızca oda kurucusu sürer; diğerleri izler. */
  let canDrive = false;

  function send(msg) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  /** Girdi olayları yalnızca sürücüden gider. Yetki asıl sunucuda denetleniyor. */
  function drive(msg) {
    if (canDrive) send(msg);
  }

  /**
   * Kare çizimi.
   *
   * Gelen her kareyi sırayla decode etmeye kalkarsak ağ bizden hızlıysa kuyruk
   * büyür ve görüntü giderek geriye düşer. Bunun yerine yalnızca EN SON kareyi
   * tutuyoruz: bir decode sürerken gelenler birbirinin üstüne yazılır.
   *
   * Canvas kareyle AYNI boyutta tutulur. Önceden canvas sabit 1280x720'di ama
   * kare 960x540 geliyordu; görüntü önce büyütülüp sonra ekrana küçültülüyordu
   * ve iki kez yeniden örneklenen metin bulanıklaşıyordu.
   */
  async function pump() {
    if (drawing) return;
    drawing = true;
    while (pending) {
      const blob = pending;
      pending = null;
      try {
        const bmp = await createImageBitmap(blob);
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
        }
        ctx.drawImage(bmp, 0, 0);
        bmp.close();
      } catch { /* bozuk kare - bir sonrakini bekle */ }
    }
    drawing = false;
  }

  /** Bağlandıysa true, servis yoksa/bilet alınamadıysa false döner. */
  async function connect(slug) {
    disconnect();
    let ticket;
    try {
      ticket = await getTicket(slug);
    } catch (e) {
      onError?.(`Ortak tarayıcı bileti alınamadı: ${e.message}`);
      return false;
    }

    const sock = new WebSocket(`${wsBase}?ticket=${encodeURIComponent(ticket)}`);
    ws = sock;
    ws.binaryType = 'blob';

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        pending = ev.data;
        void pump();
        return;
      }
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'BROWSER_STATE') onState?.(msg);
      else if (msg.type === 'BROWSER_URL') onUrl?.(msg.url);
      else if (msg.type === 'BROWSER_LOADING') onLoading?.(msg.loading);
      else if (msg.type === 'BROWSER_ERROR' || msg.type === 'BROWSER_DENIED') onError?.(msg.message);
    };

    return new Promise((resolve) => {
      sock.onopen = () => resolve(true);
      sock.onclose = () => {
        if (ws === sock) ws = null;
        onState?.({ active: false, url: '' });
        resolve(false);   // zaten çözülmüşse etkisiz
      };
      // Servis çalışmıyorsa sessiz kal: ortak tarayıcı isteğe bağlı bir servis.
      sock.onerror = () => resolve(false);
    });
  }

  function disconnect() {
    if (!ws) return;
    ws.onclose = null;
    ws.close();
    ws = null;
  }

  // ───────────────────────────────────────────────────── girdi yönlendirme

  /**
   * Ekrandaki noktayı sayfanın kendi koordinatına çevirir.
   *
   * Canvas `object-fit: contain` ile yerleşiyor: kutu 16:9 değilse görüntü
   * ortalanır ve kenarlarda boşluk kalır. Basit oran hesabı bu boşluğu
   * saymadığı için TAM EKRANDA tıklamalar kayıyordu — 16:10 bir ekranda
   * imleç düğmenin birkaç santim altına düşüyordu.
   */
  function toPage(ev) {
    const r = canvas.getBoundingClientRect();
    const pw = canvas.width || DEFAULT_PAGE_W;
    const ph = canvas.height || DEFAULT_PAGE_H;
    const scale = Math.min(r.width / pw, r.height / ph) || 1;
    const ox = r.left + (r.width - pw * scale) / 2;
    const oy = r.top + (r.height - ph * scale) / 2;
    return { x: (ev.clientX - ox) / scale, y: (ev.clientY - oy) / scale };
  }

  const BUTTONS = ['left', 'middle', 'right'];

  /** CDP değiştirici maskesi: Alt=1, Ctrl=2, Meta=4, Shift=8. */
  function modsOf(ev) {
    return (ev.altKey ? 1 : 0) | (ev.ctrlKey ? 2 : 0) | (ev.metaKey ? 4 : 0) | (ev.shiftKey ? 8 : 0);
  }

  /**
   * Hareket kısıtlaması iki hızlı.
   *
   * Boştaki imleci saniyede 25 kez yollamak yeter; ama SÜRÜKLERKEN aynı aralık
   * metin seçimini ve kaydırma çubuğunu tutuk gösteriyordu — sürüklemede her
   * kareye bir olay gönderiyoruz.
   */
  const HOVER_INTERVAL_MS = 40;
  const DRAG_INTERVAL_MS = 16;
  let lastMoveAt = 0;

  /** Basılı düğmelerin maskesi (sol=1, sağ=2, orta=4) — sürükleme bununla anlaşılıyor. */
  let heldButtons = 0;
  const BUTTON_BIT = [1, 4, 2];

  canvas.addEventListener('pointermove', (ev) => {
    const now = performance.now();
    const gap = heldButtons ? DRAG_INTERVAL_MS : HOVER_INTERVAL_MS;
    if (now - lastMoveAt < gap) return;
    lastMoveAt = now;
    const p = toPage(ev);
    drive({
      type: 'BROWSER_MOUSE', kind: 'mouseMoved', x: p.x, y: p.y,
      buttons: heldButtons, modifiers: modsOf(ev),
    });
  });

  /**
   * Tıklama sayısını kendimiz sayıyoruz.
   *
   * PointerEvent'te `detail` her zaman 0 — MouseEvent'in aksine tıklama sayısı
   * taşımıyor. Sürükleme için pointer olaylarına ihtiyacımız var (yakalama),
   * çift tıkla kelime seçimi için de sayaca; ikisini birlikte tutuyoruz.
   */
  const MULTI_CLICK_MS = 400;
  const MULTI_CLICK_SLOP = 6;
  let clickCount = 1;
  let lastClickAt = 0;
  let lastClick = { x: -99, y: -99 };

  canvas.addEventListener('pointerdown', (ev) => {
    canvas.focus();
    heldButtons |= BUTTON_BIT[ev.button] ?? 1;
    // İmleç canvas'tan çıksa da olayları almaya devam edelim; sürüklemeyi
    // kenarda bırakmak seçimi yarıda kesiyordu.
    canvas.setPointerCapture?.(ev.pointerId);
    const p = toPage(ev);

    const now = performance.now();
    const near = Math.abs(p.x - lastClick.x) < MULTI_CLICK_SLOP
      && Math.abs(p.y - lastClick.y) < MULTI_CLICK_SLOP;
    clickCount = now - lastClickAt < MULTI_CLICK_MS && near ? Math.min(clickCount + 1, 3) : 1;
    lastClickAt = now;
    lastClick = p;

    drive({
      type: 'BROWSER_MOUSE', kind: 'mousePressed', x: p.x, y: p.y,
      button: BUTTONS[ev.button] ?? 'left',
      buttons: heldButtons, modifiers: modsOf(ev), clickCount,
    });
  });

  canvas.addEventListener('pointerup', (ev) => {
    heldButtons &= ~(BUTTON_BIT[ev.button] ?? 1);
    canvas.releasePointerCapture?.(ev.pointerId);
    const p = toPage(ev);
    drive({
      type: 'BROWSER_MOUSE', kind: 'mouseReleased', x: p.x, y: p.y,
      button: BUTTONS[ev.button] ?? 'left',
      buttons: heldButtons, modifiers: modsOf(ev), clickCount,
    });
  });

  // Yakalama kaybolursa (sekme değişimi, dokunmatik iptali) tuş sonsuza kadar
  // basılı kalmasın — sayfa o andan sonra sürekli seçim yapıyor sanırdı.
  canvas.addEventListener('pointercancel', (ev) => {
    if (!heldButtons) return;
    heldButtons = 0;
    canvas.releasePointerCapture?.(ev.pointerId);
    const p = toPage(ev);
    drive({
      type: 'BROWSER_MOUSE', kind: 'mouseReleased', x: p.x, y: p.y,
      button: 'left', buttons: 0, modifiers: 0, clickCount: 1,
    });
  });

  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

  canvas.addEventListener('wheel', (ev) => {
    if (!canDrive) return;   // sürücü değilsek sayfanın kendi kaydırması kalsın
    ev.preventDefault();
    const p = toPage(ev);
    // deltaMode 1 = satır, 2 = sayfa. CDP piksel bekliyor.
    const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? canvas.height : 1;
    drive({
      type: 'BROWSER_MOUSE', kind: 'mouseWheel', x: p.x, y: p.y,
      deltaX: ev.deltaX * unit, deltaY: ev.deltaY * unit, modifiers: modsOf(ev),
    });
  }, { passive: false });

  // Tarayıcının kendi kısayollarını çalmayalım; yalnızca sayfaya ait tuşlar.
  const PASS_THROUGH = new Set(['F5', 'F11', 'F12']);
  /** Kendi sekmemizde kalması gereken Ctrl kısayolları. */
  const OWN_SHORTCUTS = new Set(['r', 'R', 't', 'T', 'w', 'W', 'n', 'N']);

  function ownsKey(ev) {
    if (PASS_THROUGH.has(ev.key)) return true;
    return (ev.ctrlKey || ev.metaKey) && OWN_SHORTCUTS.has(ev.key);
  }

  canvas.addEventListener('keydown', (ev) => {
    if (!canDrive || ownsKey(ev)) return;
    ev.preventDefault();
    drive({
      type: 'BROWSER_KEY', kind: 'keyDown',
      key: ev.key, code: ev.code, keyCode: ev.keyCode, modifiers: modsOf(ev),
      // Tek karakterlik tuşlarda metni de yollamak gerekiyor, yoksa harf
      // yazılmaz. Ctrl/Meta basılıysa metin DEĞİL kısayol üretilmeli.
      ...(ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey ? { text: ev.key } : {}),
    });
  });

  canvas.addEventListener('keyup', (ev) => {
    if (!canDrive || ownsKey(ev)) return;
    ev.preventDefault();
    drive({
      type: 'BROWSER_KEY', kind: 'keyUp',
      key: ev.key, code: ev.code, keyCode: ev.keyCode, modifiers: modsOf(ev),
    });
  });

  return {
    connect,
    disconnect,
    start: (url) => send({ type: 'BROWSER_START', url }),
    navigate: (url) => send({ type: 'BROWSER_NAV', url }),
    stop: () => send({ type: 'BROWSER_STOP' }),
    back: () => drive({ type: 'BROWSER_BACK' }),
    forward: () => drive({ type: 'BROWSER_FORWARD' }),
    reload: () => drive({ type: 'BROWSER_RELOAD' }),
    setDriver(yes) {
      canDrive = Boolean(yes);
      canvas.classList.toggle('is-readonly', !canDrive);
    },
    get canDrive() { return canDrive; },
    get connected() { return ws?.readyState === WebSocket.OPEN; },
  };
}
