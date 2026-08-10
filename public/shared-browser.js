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

/** Sunucu tarafındaki sayfanın gerçek boyutu; koordinatları buna ölçekliyoruz. */
const PAGE_W = 1280;
const PAGE_H = 720;

export function createSharedBrowser({ canvas, wsBase, getTicket, onState, onUrl, onError }) {
  const ctx = canvas.getContext('2d', { alpha: false });
  canvas.width = PAGE_W;
  canvas.height = PAGE_H;

  let ws = null;
  let pending = null;   // çizilmeyi bekleyen son kare
  let drawing = false;

  function send(msg) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  /**
   * Kare çizimi.
   *
   * Gelen her kareyi sırayla decode etmeye kalkarsak ağ bizden hızlıysa kuyruk
   * büyür ve görüntü giderek geriye düşer. Bunun yerine yalnızca EN SON kareyi
   * tutuyoruz: bir decode sürerken gelenler birbirinin üstüne yazılır.
   */
  async function pump() {
    if (drawing) return;
    drawing = true;
    while (pending) {
      const blob = pending;
      pending = null;
      try {
        const bmp = await createImageBitmap(blob);
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
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
      else if (msg.type === 'BROWSER_ERROR') onError?.(msg.message);
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

  /** Ekrandaki tıklamayı sayfanın kendi koordinatına çevirir. */
  function toPage(ev) {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - r.left) / r.width) * PAGE_W,
      y: ((ev.clientY - r.top) / r.height) * PAGE_H,
    };
  }

  const BUTTONS = ['left', 'middle', 'right'];

  canvas.addEventListener('mousemove', (ev) => {
    const p = toPage(ev);
    send({ type: 'BROWSER_MOUSE', kind: 'mouseMoved', x: p.x, y: p.y });
  });

  canvas.addEventListener('mousedown', (ev) => {
    canvas.focus();
    const p = toPage(ev);
    send({ type: 'BROWSER_MOUSE', kind: 'mousePressed', x: p.x, y: p.y, button: BUTTONS[ev.button] ?? 'left' });
  });

  canvas.addEventListener('mouseup', (ev) => {
    const p = toPage(ev);
    send({ type: 'BROWSER_MOUSE', kind: 'mouseReleased', x: p.x, y: p.y, button: BUTTONS[ev.button] ?? 'left' });
  });

  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const p = toPage(ev);
    send({ type: 'BROWSER_MOUSE', kind: 'mouseWheel', x: p.x, y: p.y, deltaX: ev.deltaX, deltaY: ev.deltaY });
  }, { passive: false });

  // Tarayıcının kendi kısayollarını çalmayalım; yalnızca sayfaya ait tuşlar.
  const PASS_THROUGH = new Set(['F5', 'F11', 'F12']);

  canvas.addEventListener('keydown', (ev) => {
    if (PASS_THROUGH.has(ev.key) || ev.ctrlKey && ['r', 'R', 't', 'w'].includes(ev.key)) return;
    ev.preventDefault();
    send({
      type: 'BROWSER_KEY', kind: 'keyDown',
      key: ev.key, code: ev.code, keyCode: ev.keyCode,
      // Tek karakterlik tuşlarda metni de yollamak gerekiyor, yoksa harf yazılmaz.
      ...(ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey ? { text: ev.key } : {}),
    });
  });

  canvas.addEventListener('keyup', (ev) => {
    if (PASS_THROUGH.has(ev.key)) return;
    ev.preventDefault();
    send({ type: 'BROWSER_KEY', kind: 'keyUp', key: ev.key, code: ev.code, keyCode: ev.keyCode });
  });

  return {
    connect,
    disconnect,
    start: (url) => send({ type: 'BROWSER_START', url }),
    navigate: (url) => send({ type: 'BROWSER_NAV', url }),
    stop: () => send({ type: 'BROWSER_STOP' }),
    get connected() { return ws?.readyState === WebSocket.OPEN; },
  };
}
