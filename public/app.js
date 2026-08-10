// @ts-check
import {
  effectivePositionMs,
  computeClockSample,
  bestSample,
  decideDriftAction,
  MAX_MEDIA_PEERS,
  CLOCK_SAMPLE_MAX_AGE_MS,
} from '/app/protocol.js';
import { createMesh } from '/app/rtc.js';
import { createSharedBrowser } from '/app/shared-browser.js';

const API = location.origin;
// Geliştirmede iki realtime instance ayrı portlarda. ?rt=8092 ile ikincisine
// bağlanmak, oda durumunun süreçler arası paylaşıldığını göstermeyi sağlıyor.
const RT_PORT = new URLSearchParams(location.search).get('rt') || '8091';
const WS_SCHEME = location.protocol === 'https:' ? 'wss' : 'ws';
const WS_BASE = `${WS_SCHEME}://${location.hostname}:${RT_PORT}/ws`;
const BW_PORT = new URLSearchParams(location.search).get('bw') || '8094';
const BW_BASE = `${WS_SCHEME}://${location.hostname}:${BW_PORT}/browser`;

// esbuild IIFE paketinde sınıf .default altına düşer; CDN UMD'sinde doğrudan gelir.
const HlsLib = globalThis.Hls?.isSupported ? globalThis.Hls : globalThis.Hls?.default;

const $ = (id) => document.getElementById(id);

// ─────────────────────────────────────────────────────────────── Durum
let token = localStorage.getItem('token') || '';
let me = null;
let selfConnectionId = '';
let slug = '';
let roomName = '';
let ws = null;
let state = null;
let seenVersion = 0;

let clockOffsetMs = 0;
let clockSamples = [];
let reconnectAttempt = 0;

let ytPlayer = null;
let ytReady = false;
let hls = null;
let activeKind = null;
let player = null;
let supportsFineRate = null;
let nudgeActive = false;

const progressWatchers = new Map();

// ──────────────────────────────────────────────────────────── Yardımcılar
async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
  return json;
}

function setStatus(id, text, kind = '') {
  const el = $(id);
  el.textContent = text;
  el.className = `status ${kind}`;
}

function showScreen(name) {
  for (const s of ['auth', 'home', 'room']) {
    $(`screen-${s}`).classList.toggle('is-hidden', s !== name);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function initials(name) {
  return (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

function fmt(ms) {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(Math.floor(ms % 1000)).padStart(3, '0')}`;
}

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('is-hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('is-hidden'), 2200);
}

// ══════════════════════════════════════════════════════════════ Oynatıcı
const youtubeAdapter = {
  kind: 'youtube',
  ready: () => ytReady,
  positionMs: () => (ytPlayer?.getCurrentTime?.() ?? 0) * 1000,
  seek: (ms) => ytPlayer.seekTo(ms / 1000, true),
  play: () => ytPlayer.playVideo(),
  pause: () => ytPlayer.pauseVideo(),
  isPlaying: () => ytPlayer?.getPlayerState?.() === 1,
  isBuffering: () => ytPlayer?.getPlayerState?.() === 3,
  setRate: (r) => ytPlayer.setPlaybackRate(r),
  getRate: () => ytPlayer?.getPlaybackRate?.() ?? 1,
};

const hlsAdapter = {
  kind: 'hls',
  ready: () => $('video').readyState >= 1,
  positionMs: () => $('video').currentTime * 1000,
  seek: (ms) => { $('video').currentTime = ms / 1000; },
  play: () => { $('video').play().catch(() => {}); },
  pause: () => $('video').pause(),
  isPlaying: () => !$('video').paused && !$('video').ended,
  isBuffering: () => $('video').readyState < 3,
  setRate: (r) => { $('video').playbackRate = r; },
  getRate: () => $('video').playbackRate,
};

/**
 * Sahnede aynı anda TEK katman durur.
 *
 * Dört katman (YouTube iframe'i, HLS videosu, ekran paylaşımı, ortak tarayıcı)
 * beş ayrı yerden açılıp kapanıyordu ve birbirlerinden habersizdi. Sonuç:
 * ortak tarayıcı açıkken YouTube'a geçince video canvas'ın ARKASINDA
 * oynuyordu — "video oynamıyor" diye görünen şey buydu. Artık tek kapı var.
 */
const STAGE_LAYERS = {
  youtube: 'player',
  hls: 'video',
  screen: 'screen-view',
  browser: 'browser-view',
};
let stageLayer = 'empty';

function showStage(kind) {
  stageLayer = kind;
  for (const [name, id] of Object.entries(STAGE_LAYERS)) {
    const el = $(id);
    if (el) el.hidden = name !== kind;
  }
  $('stage-empty').classList.toggle('is-hidden', kind !== 'empty');
}

/**
 * YouTube gömülü oynatıcısı dış bir servistir; yüklenmeyebilir (ağ engeli,
 * SSL hatası, reklam engelleyici). Sessizce boş sahnede bırakmak en kötüsü —
 * bir kez uyarıp alternatifi söylüyoruz.
 */
let ytWarnTimer = null;
function warnIfYouTubeStalls() {
  if (ytWarnTimer) return;
  ytWarnTimer = setTimeout(() => {
    ytWarnTimer = null;
    if (ytReady) return;
    addSystem('YouTube oynatıcısı yüklenemedi. "Diğer kaynaklar" ile kendi videonu ya da ortak tarayıcıyı kullanabilirsin.');
  }, 8000);
}

function mountSource(source, startAtMs, shouldPlay) {
  if (!source) return;

  if (source.type === 'youtube') {
    showStage('youtube');
    if (activeKind !== 'youtube') {
      if (hls) { hls.destroy(); hls = null; }
      $('video').removeAttribute('src');
      activeKind = 'youtube';
      player = youtubeAdapter;
      supportsFineRate = null;
    }
    // Etiketi HER ZAMAN yaz: oynatıcı gelmese bile ne seçildiği görünsün.
    $('source-label').textContent = `youtube · ${source.videoId}`;
    if (!ytReady) { warnIfYouTubeStalls(); return; }
    if (ytPlayer.getVideoData?.()?.video_id !== source.videoId) {
      ytPlayer.loadVideoById(source.videoId, startAtMs / 1000);
      if (!shouldPlay) ytPlayer.pauseVideo();
    }
    return;
  }

  showStage('hls');
  const video = $('video');
  if (activeKind !== 'hls' || video.dataset.src !== source.url) {
    activeKind = 'hls';
    player = hlsAdapter;
    supportsFineRate = null;

    if (hls) { hls.destroy(); hls = null; }
    if (HlsLib?.isSupported()) {
      hls = new HlsLib({ enableWorker: true, lowLatencyMode: false });
      hls.loadSource(source.url);
      hls.attachMedia(video);
      hls.on(HlsLib.Events.ERROR, (_e, data) => {
        if (data.fatal) addSystem(`Oynatma hatası: ${data.details}`);
      });
    } else {
      video.src = source.url;  // Safari HLS'i yerel destekler
    }
    video.dataset.src = source.url;
    video.currentTime = startAtMs / 1000;
  }
  $('source-label').textContent = 'kendi videon';
}

window.onYouTubeIframeAPIReady = () => {
  ytPlayer = new YT.Player('player', {
    height: '100%',
    width: '100%',
    playerVars: { controls: 1, disablekb: 1, rel: 0, modestbranding: 1 },
    events: {
      onReady: () => {
        ytReady = true;
        if (state) { seenVersion -= 1; applyState(state); }
      },
    },
  });
};

// ══════════════════════════════════════════════════════════════════ Giriş
for (const tab of document.querySelectorAll('[data-auth-tab]')) {
  tab.onclick = () => {
    const mode = tab.getAttribute('data-auth-tab');
    for (const t of document.querySelectorAll('[data-auth-tab]')) t.classList.toggle('is-active', t === tab);
    for (const f of document.querySelectorAll('[data-only="register"]')) f.classList.toggle('is-hidden', mode !== 'register');
    $('btn-register').classList.toggle('is-hidden', mode !== 'register');
    $('btn-login').classList.toggle('is-hidden', mode !== 'login');
    setStatus('auth-status', '');
  };
}

$('btn-random').onclick = () => {
  const n = Math.floor(Math.random() * 100000);
  $('email').value = `kullanici${n}@ornek.com`;
  $('password').value = 'CokGizliParola123';
  $('display-name').value = `Kullanıcı ${n}`;
};

function afterAuth(result) {
  token = result.accessToken;
  me = result.user;
  localStorage.setItem('token', token);
  setStatus('auth-status', `Hoş geldin, ${me.displayName}`, 'ok');
  enterHome();
}

function enterHome() {
  $('who-name').textContent = me.displayName;
  $('who-avatar').textContent = initials(me.displayName);
  showScreen('home');
  void refreshVideos();
  void refreshRooms();
}

$('btn-register').onclick = async () => {
  try {
    afterAuth(await api('POST', '/api/auth/register', {
      email: $('email').value,
      password: $('password').value,
      displayName: $('display-name').value || 'Anonim',
    }));
  } catch (e) { setStatus('auth-status', e.message, 'err'); }
};

$('btn-login').onclick = async () => {
  try {
    afterAuth(await api('POST', '/api/auth/login', {
      email: $('email').value,
      password: $('password').value,
    }));
  } catch (e) { setStatus('auth-status', e.message, 'err'); }
};

$('btn-logout').onclick = () => {
  localStorage.removeItem('token');
  token = ''; me = null;
  showScreen('auth');
};

// ═══════════════════════════════════════════════════════════ Kaynak seçimi
let sourceMode = 'youtube';
/** Sayfa "oda aç" mı yoksa "mevcut odanın kaynağını değiştir" mi? */
let sourceIntent = 'create';
let pickedVideoId = null;

// youtube.com/watch?v=… , youtu.be/… ya da düz kimlik — hepsini kabul et.
function parseYouTubeId(raw) {
  const s = (raw || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = /(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/.exec(s);
  return m ? m[1] : null;
}

function openSourceSheet(intent) {
  sourceIntent = intent;
  $('btn-source-go').textContent = intent === 'create' ? 'Odayı aç' : 'Kaynağı değiştir';
  setStatus('source-status', '');
  void fillSourceLibrary();
  $('source-sheet').classList.remove('is-hidden');
}

for (const opt of document.querySelectorAll('[data-source]')) {
  opt.onclick = () => {
    sourceMode = opt.getAttribute('data-source');
    for (const o of document.querySelectorAll('[data-source]')) o.classList.toggle('is-active', o === opt);
    for (const name of ['youtube', 'library', 'screen']) {
      $(`source-${name}`).classList.toggle('is-hidden', name !== sourceMode);
    }
  };
}

// Sahnenin üstündeki bağlantı çubuğu: kaynak sayfasını açmadan YouTube geçir.
/**
 * Tek kutu, iki iş — ama karar kullanıcıya bırakılmıyor.
 *
 * YouTube bağlantısı HER ZAMAN "birlikte izleyelim" demektir: ortak tarayıcı
 * açıksa bile kapatıp videoya geçiyoruz. Önceden link sanal tarayıcıya
 * gidiyordu; kullanıcı video bekleyip YouTube'un web sayfasını buluyordu.
 *
 * YouTube olmayan her şey (adres ya da arama) ortak tarayıcıya gider; kapalıysa
 * açılır. "Bu YouTube değil" deyip kullanıcıyı geri çevirmenin anlamı yok.
 */
async function playPastedLink() {
  const raw = $('stage-url').value.trim();
  if (!raw) return;
  if (!slug) return toast('Önce bir odaya gir');

  const ytId = parseYouTubeId(raw);
  if (ytId) {
    if (browserActive) sharedBrowser.stop();
    sendMsg({ type: 'SET_SOURCE', source: { type: 'youtube', videoId: ytId } });
    $('stage-url').value = '';
    return;
  }

  if (browserActive) { sharedBrowser.navigate(raw); return; }
  await openSharedBrowser(raw);
}

$('btn-stage-url').onclick = () => void playPastedLink();
$('stage-url').onkeydown = (e) => { if (e.key === 'Enter') void playPastedLink(); };

$('btn-source-close').onclick = () => $('source-sheet').classList.add('is-hidden');
$('btn-create').onclick = () => openSourceSheet('create');
$('btn-source').onclick = () => openSourceSheet('change');

async function fillSourceLibrary() {
  try {
    const { videos } = await api('GET', '/api/videos');
    const ready = videos.filter((v) => v.status === 'ready');
    $('source-video-list').innerHTML = ready.length
      ? ready.map((v) => `<li><span class="v-title">${escapeHtml(v.title)}</span>
          <button class="btn btn-sm" data-pick="${v.id}">Seç</button></li>`).join('')
      : '<li class="empty">Hazır video yok — ana ekrandaki kitaplıktan yükleyebilirsin</li>';
    for (const b of $('source-video-list').querySelectorAll('[data-pick]')) {
      b.onclick = () => {
        pickedVideoId = b.getAttribute('data-pick');
        for (const x of $('source-video-list').querySelectorAll('[data-pick]')) x.textContent = 'Seç';
        b.textContent = 'Seçildi ✓';
      };
    }
  } catch { /* oturum yoksa sessiz geç */ }
}

$('btn-source-go').onclick = async () => {
  try {
    if (sourceIntent === 'create') {
      const ytId = sourceMode === 'youtube' ? parseYouTubeId($('yt-id').value) : null;
      if (sourceMode === 'youtube' && !ytId) {
        return setStatus('source-status', 'Geçerli bir YouTube bağlantısı ya da kimliği gir', 'err');
      }
      const { room } = await api('POST', '/api/rooms', {
        name: $('room-name').value || 'Oda',
        youtubeVideoId: ytId ?? undefined,
      });
      $('room-slug').value = room.slug;
      $('source-sheet').classList.add('is-hidden');
      await connect(room.slug, room.name);
      if (sourceMode === 'library' && pickedVideoId) await useVideoInRoom(pickedVideoId);
      if (sourceMode === 'screen') toast('Hazırsan "Ekran paylaş" düğmesine bas');
      if (sourceMode === 'browser') await openSharedBrowser($('bw-url').value);
      return;
    }

    // Mevcut odanın kaynağını değiştir
    if (sourceMode === 'youtube') {
      const ytId = parseYouTubeId($('yt-id').value);
      if (!ytId) return setStatus('source-status', 'Geçerli bir YouTube bağlantısı gir', 'err');
      sendMsg({ type: 'SET_SOURCE', source: { type: 'youtube', videoId: ytId } });
    } else if (sourceMode === 'library') {
      if (!pickedVideoId) return setStatus('source-status', 'Bir video seç', 'err');
      await useVideoInRoom(pickedVideoId);
    } else if (sourceMode === 'browser') {
      await openSharedBrowser($('bw-url').value);
    } else {
      toast('"Ekran paylaş" düğmesiyle başlatabilirsin');
    }
    $('source-sheet').classList.add('is-hidden');
  } catch (e) { setStatus('source-status', e.message, 'err'); }
};

async function enterRoom(s) {
  await api('POST', `/api/rooms/${s}/join`);   // üyeysen zaten geçiyor
  const { room } = await api('GET', `/api/rooms/${s}`);
  await connect(s, room.name);
}

$('btn-join').onclick = async () => {
  const s = $('room-slug').value.trim();
  if (!s) return setStatus('room-status', 'Oda kodu gerekli', 'err');
  try {
    await enterRoom(s);
  } catch (e) { setStatus('room-status', e.message, 'err'); }
};

$('btn-leave').onclick = () => {
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  mesh.closeAll();
  remotes.clear();
  media.mic = media.cam = media.screen = false;
  for (const k of ['mic', 'cam', 'screen']) $(`btn-${k}`).dataset.on = 'false';
  $('screen-view').hidden = true; $('screen-view').srcObject = null;
  $('video-strip').classList.add('is-hidden');
  sharedBrowser.disconnect();
  browserActive = false;
  $('btn-browser').dataset.on = 'false';
  $('screen-room').classList.remove('browser-mode');
  $('bw-progress').classList.add('is-hidden');
  showStage('empty');
  updateLinkbar();
  slug = ''; state = null; seenVersion = 0;
  showScreen('home');
  void refreshRooms();
};

// ═══════════════════════════════════════════════════════════ WebSocket
async function connect(roomSlug, name) {
  slug = roomSlug;
  roomName = name || roomSlug;
  seenVersion = 0;
  clockSamples = [];

  $('room-title').textContent = roomName;
  $('room-code').textContent = slug;
  $('chat-log').innerHTML = '';
  showScreen('room');

  // Ortak tarayıcı isteğe bağlı bir servis; yoksa oda normal çalışmaya devam
  // eder. Odaya girerken bağlanıyoruz ki biri açtığında herkes görsün.
  bwReady = sharedBrowser.connect(roomSlug);

  if (ws) { ws.onclose = null; ws.close(); }

  // Ham JWT'yi query string'de taşımıyoruz: API'den 30 saniyelik, tek
  // kullanımlık, tek odaya kilitli bir bilet alıyoruz.
  let ticket;
  try {
    ({ ticket } = await api('POST', `/api/rooms/${slug}/ticket`));
  } catch (e) {
    addSystem(`Bağlanılamadı: ${e.message}`);
    return;
  }

  ws = new WebSocket(`${WS_BASE}?room=${encodeURIComponent(slug)}&ticket=${encodeURIComponent(ticket)}`);

  ws.onopen = () => {
    reconnectAttempt = 0;
    $('conn-state').textContent = `bağlı · realtime :${RT_PORT}`;
    $('conn-state').className = 'pill pill-on';
    $('invite-link').value = `${location.origin}/app/?room=${slug}`;
    $('invite-link-2').value = `${location.origin}/app/?room=${slug}&rt=8092`;
    syncClock(10);
  };

  ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data));

  ws.onclose = (ev) => {
    $('conn-state').textContent = 'bağlantı koptu';
    $('conn-state').className = 'pill pill-off';
    // 1012 = sunucu bilinçli yeniden başlıyor: hemen dön. Diğer durumlarda
    // üstel geri çekilme, yoksa çöken sunucuya bağlantı fırtınası biner.
    const delay = ev.code === 1012 ? 500 : Math.min(1000 * 2 ** reconnectAttempt++, 15000);
    addSystem(`bağlantı koptu — ${Math.round(delay / 1000)} sn sonra yeniden denenecek`);
    setTimeout(() => { if (slug) void connect(slug, roomName); }, delay);
  };
}

function sendMsg(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'HELLO':
      me = msg.you;
      selfConnectionId = msg.you.connectionId;
      mesh.setSelf(selfConnectionId);
      $('room-title').textContent = msg.room.name;
      applyState(msg.state);
      renderMembers(msg.members);
      addSystem(`"${msg.room.name}" odasına katıldın`);
      break;

    case 'PONG': {
      const now = Date.now();
      clockSamples.push(computeClockSample(msg.t0, msg.t1, msg.t2, now));
      const best = bestSample(clockSamples, now);
      clockOffsetMs = best.offsetMs;
      $('t-offset').textContent = `${best.offsetMs.toFixed(1)} ms`;
      $('t-rtt').textContent = `${best.rttMs.toFixed(1)} ms`;
      break;
    }

    case 'STATE': applyState(msg.state); break;
    case 'PRESENCE': renderMembers(msg.members); break;
    case 'CHAT': addChat(msg.displayName, msg.text); break;
    case 'ERROR': addSystem(msg.message); break;
    case 'VIDEO_PROGRESS': onVideoProgress(msg); break;

    case 'RTC_SIGNAL':
      try { void mesh.handleSignal(msg.from, msg.fromName, JSON.parse(msg.payload)); }
      catch { /* bozuk sinyal */ }
      break;
  }
}

// Sunucudan gelen durumu uygula; kendi gördüğümüzden eski olanı at.
// Bu tek kontrol hem ağ sırasızlığını hem eşzamanlı komut yarışını çözer.
function applyState(next) {
  if (next.version <= seenVersion) return;
  seenVersion = next.version;
  state = next;
  $('t-version').textContent = String(next.version);
  mountSource(next.source, next.positionMs, next.isPlaying);
}

function syncClock(count) {
  for (let i = 0; i < count; i++) {
    setTimeout(() => sendMsg({ type: 'PING', t0: Date.now() }), i * 120);
  }
}
setInterval(() => {
  if (ws?.readyState !== WebSocket.OPEN) return;
  // Sayıya göre değil YAŞA göre buda: sayıya göre budamak, örnek akışı
  // yavaşsa çok eski örnekleri elde tutuyordu.
  const cutoff = Date.now() - CLOCK_SAMPLE_MAX_AGE_MS;
  clockSamples = clockSamples.filter((s) => s.atMs >= cutoff).slice(-40);
  syncClock(3);
}, 30000);

// ═══════════════════════════════════════════════════════════ Kontroller
// Komutlar yalnızca butonlardan gider. Oynatıcının kendi olaylarını dinleyip
// komuta çevirseydik "durum geldi → olay → komut → yayın" döngüsü oluşurdu.
const pos = () => (player?.ready() ? player.positionMs() : 0);

$('btn-play').onclick  = () => sendMsg({ type: 'PLAY', positionMs: pos() });
$('btn-pause').onclick = () => sendMsg({ type: 'PAUSE', positionMs: pos() });
$('btn-back').onclick  = () => sendMsg({ type: 'SEEK', positionMs: Math.max(0, pos() - 10000) });
$('btn-fwd').onclick   = () => sendMsg({ type: 'SEEK', positionMs: pos() + 10000 });

$('btn-chat').onclick = sendChat;
$('chat-input').onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };

function sendChat() {
  const text = $('chat-input').value.trim();
  if (!text) return;
  sendMsg({ type: 'CHAT', text });
  $('chat-input').value = '';
}

// ════════════════════════════════════════════════════ Senkron döngüsü
setInterval(controlTick, 250);

/**
 * Anlık senkron durumu — teşhis ve test için.
 *
 * Telemetri hücreleri 250 ms'lik tikte yazılıyor. İki sekmenin tik fazı farklı
 * olduğu için hücreleri karşılaştırmak senkronu değil tik gecikmesini ölçer;
 * testte tam olarak bu yanlış alarma yol açtı. Bu kanca hesabı çağrıldığı anda
 * yapar ve okuma anını da verir, böylece iki sekme farklı anlarda okunsa bile
 * karşılaştırma zamandan bağımsız kalır (target - atMs sabittir).
 */
globalThis.__sync = () => {
  const atMs = Date.now();
  // Oynatıcı hazır değilken null dönmek yanlıştı: oda durumu, yetki ve ortak
  // tarayıcı bilgisi oynatıcıdan bağımsız. Alanlar ayrı ayrı null olabiliyor.
  const ready = Boolean(state?.source && player?.ready?.());
  return {
    atMs,
    ready,
    targetMs: state ? effectivePositionMs(state, atMs + clockOffsetMs) : null,
    actualMs: ready ? player.positionMs() : null,
    offsetMs: clockOffsetMs,
    version: state?.version ?? null,
    isPlaying: state?.isPlaying ?? null,
    iAmHost,
    selfConnectionId,
    browserActive,
    // Ham örnekler: sunucu saatinin kararlı olup olmadığını buradan anlıyoruz.
    samples: clockSamples.map((s) => ({ o: s.offsetMs, t: s.atMs })),
  };
};

function controlTick() {
  if (!state || !state.source || !player || !player.ready()) return;

  const target = effectivePositionMs(state, Date.now() + clockOffsetMs);
  const actual = player.positionMs();

  $('t-player').textContent = `${player.kind}${supportsFineRate === false ? ' (ince hız yok)' : ''}`;
  $('t-target').textContent = fmt(target);
  $('t-actual').textContent = fmt(actual);

  if (state.isPlaying && !player.isPlaying() && !player.isBuffering()) player.play();
  if (!state.isPlaying && player.isPlaying()) player.pause();

  if (player.isBuffering()) { setAction('arabellek', ''); return; }

  const drift = target - actual;
  $('t-drift').textContent = `${drift >= 0 ? '+' : ''}${drift.toFixed(0)} ms`;
  sendMsg({ type: 'HEARTBEAT', positionMs: Math.max(0, actual), driftMs: drift });

  applyDrift(target, actual);
  updateSyncBadge(Math.abs(drift));
}

function applyDrift(target, actual) {
  const decision = decideDriftAction(target, actual, supportsFineRate !== false);

  if (decision.action === 'none') {
    if (nudgeActive) { player.setRate(1); nudgeActive = false; }
    setAction('gerek yok', 'drift-ok');
    return;
  }

  if (decision.action === 'seek') {
    if (nudgeActive) { player.setRate(1); nudgeActive = false; }
    player.seek(decision.toMs);
    setAction(`atlandı → ${fmt(decision.toMs)}`, 'drift-seek');
    return;
  }

  // İnce hız ayarı desteğini varsaymıyoruz: bir kez deneyip geri okuyoruz.
  const desired = decision.playbackRate;
  if (supportsFineRate === null) {
    player.setRate(desired);
    supportsFineRate = Math.abs(player.getRate() - desired) < 0.005;
    if (!supportsFineRate) { player.setRate(1); applyDrift(target, actual); return; }
  }

  player.setRate(desired);
  nudgeActive = true;
  setAction(`hız ${desired.toFixed(2)}×`, 'drift-nudge');
}

function setAction(text, cls) {
  const el = $('t-action');
  el.textContent = text;
  el.className = cls;
}

function updateSyncBadge(drift) {
  const b = $('sync-badge');
  if (drift < 250) { b.textContent = 'senkron'; b.className = 'chip chip-ok'; }
  else if (drift < 1500) { b.textContent = 'ayarlanıyor'; b.className = 'chip chip-warn'; }
  else { b.textContent = 'yakalanıyor'; b.className = 'chip chip-err'; }
}

// ═══════════════════════════════════════════════════ Sesli/görüntülü sohbet
const media = { mic: false, cam: false, screen: false };
/** connectionId → { name, stream, screen } */
const remotes = new Map();

/** Son PRESENCE listesi. Akış geldiğinde kimin ne paylaştığını buradan okuyoruz. */
let lastMembers = [];

const mesh = createMesh({
  send: (to, data) => sendMsg({ type: 'RTC_SIGNAL', to, payload: JSON.stringify(data) }),
  onRemote: (peerId, name, stream) => {
    const prev = remotes.get(peerId);
    remotes.set(peerId, { name, stream, screen: prev?.screen ?? false });
    // Akış çoğu zaman PRESENCE'tan SONRA gelir; yönlendirmeyi burada da
    // yapmazsak ekran paylaşımı karşı tarafta hiç görünmez.
    routeScreenShare(lastMembers);
    renderTiles();
  },
  onDrop: (peerId) => { remotes.delete(peerId); renderTiles(); },
  onError: (m) => addSystem(m),
});

function announceMedia() {
  sendMsg({ type: 'RTC_MEDIA', mic: media.mic, cam: media.cam, screen: media.screen });
  for (const k of ['mic', 'cam', 'screen']) {
    $(`btn-${k}`).dataset.on = String(media[k]);
  }
}

/**
 * Eş bağlantılarını son bilinen katılımcı listesine göre tazeler.
 *
 * Yalnızca PRESENCE geldiğinde çağırmak yetmiyordu: mesh.sync, iki taraftan
 * hiçbirinde medya yoksa bağlantı kurmaz. Yerel akış PRESENCE'tan SONRA
 * hazır olursa (getUserMedia yavaş kaldığında) sync bir daha çalışmıyor ve
 * bağlantı hiç kurulmuyordu. Yerel akış her değiştiğinde de çağırıyoruz.
 */
function syncPeers() {
  mesh.sync(lastMembers.filter((m) => m.connectionId !== selfConnectionId));
}

/** Mikrofon/kamera durumuna göre yerel akışı yeniden kurar. */
async function refreshLocalStream() {
  if (media.screen) return;  // ekran paylaşımı kendi akışını yönetiyor

  if (!media.mic && !media.cam) {
    await mesh.setLocalStream(null);
    syncPeers();
    renderTiles();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: media.mic,
      video: media.cam ? { width: 640, height: 480 } : false,
    });
    await mesh.setLocalStream(stream);
    syncPeers();
    renderTiles();
  } catch (e) {
    media.mic = false; media.cam = false;
    addSystem(`Cihaza erişilemedi: ${e.message}`);
  }
}

/**
 * Medya değişiklikleri SIRAYLA işlenir.
 *
 * Mikrofon ve kameraya arka arkaya basmak iki getUserMedia çağrısını
 * yarıştırıyordu; biri başarısız olunca ortak `media` bayraklarını sıfırlıyor
 * ve diğerinin başarısını da götürüyordu. Testte "akış geçti ama rozet
 * yansımadı" diye göründü.
 */
let mediaQueue = Promise.resolve();
function queueMedia(fn) {
  mediaQueue = mediaQueue.then(fn).catch((e) => addSystem(`Medya değiştirilemedi: ${e.message}`));
  return mediaQueue;
}

// Önce akışı al, SONRA duyur. Ters sırada duyuru odaya "bende kamera var"
// derken elimizde henüz akış olmuyor; dönen PRESENCE ile sync çalışıyor ama
// kuracak bir şey bulamıyordu. CI'da tam olarak bu oldu.
$('btn-mic').onclick = () => queueMedia(async () => {
  media.mic = !media.mic;
  await refreshLocalStream();
  announceMedia();
});
$('btn-cam').onclick = () => queueMedia(async () => {
  media.cam = !media.cam;
  await refreshLocalStream();
  announceMedia();
});

$('btn-screen').onclick = () => queueMedia(async () => {
  if (media.screen) {
    media.screen = false;
    $('screen-view').srcObject = null;
    restoreSourceStage();
    await refreshLocalStream();
    announceMedia();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: true,
    });
    // Kullanıcı tarayıcının kendi "paylaşımı durdur" düğmesine basabilir.
    stream.getVideoTracks()[0].onended = () => { if (media.screen) $('btn-screen').click(); };

    media.screen = true;
    await mesh.setLocalStream(stream);
    syncPeers();
    showScreenStage(stream);
    announceMedia();
  } catch (e) {
    if (e.name !== 'NotAllowedError') addSystem(`Ekran paylaşılamadı: ${e.message}`);
  }
});

/**
 * Canlı bir katman (ekran paylaşımı, ortak tarayıcı) kapanınca odanın asıl
 * kaynağına dönülür. Yoksa boş sahne.
 */
function restoreSourceStage() {
  if (!state?.source) { showStage('empty'); return; }
  showStage(state.source.type === 'youtube' ? 'youtube' : 'hls');
}

/** Canlı katmana geçerken video sesi arkadan gelmesin. */
function pauseUnderlyingPlayer() {
  if (player?.ready?.() && player.isPlaying?.()) player.pause();
}

function showScreenStage(stream) {
  pauseUnderlyingPlayer();
  showStage('screen');
  const el = $('screen-view');
  el.srcObject = stream;
  el.muted = true;   // kendi ekranını dinlemek yankı yapar
  void el.play().catch(() => {});
}

/**
 * Karoları yerinde günceller.
 *
 * Önceden her çağrıda strip.innerHTML baştan kuruluyordu: oynayan her video
 * elemanı yok edilip yeniden yaratılıyor, akış sıfırdan başlıyordu. Karo
 * sayısı değişmese bile bu oluyordu, çünkü her yeni track render tetikliyor.
 */
function renderTiles() {
  const strip = $('video-strip');
  const local = mesh.stream;

  const tiles = [];
  if (local && (media.cam || media.mic) && !media.screen) {
    tiles.push({ id: 'self', name: 'Sen', stream: local, muted: true });
  }
  for (const [id, r] of remotes) {
    if (!r.screen) tiles.push({ id, name: r.name, stream: r.stream, muted: false });
  }

  strip.classList.toggle('is-hidden', tiles.length === 0);

  const alive = new Set();
  for (const t of tiles) {
    alive.add(t.id);
    let el = strip.querySelector(`[data-tile="${CSS.escape(t.id)}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'tile';
      el.dataset.tile = t.id;
      el.innerHTML = '<span class="ring"></span><video autoplay playsinline></video><span class="tile-name"></span>';
      strip.append(el);
    }

    // "canlı ama sessize alınmış" = karşı taraf kamerayı kapatmış demek.
    const hasVideo = t.stream.getVideoTracks().some((tr) => tr.readyState === 'live' && !tr.muted);
    el.classList.toggle('audio-only', !hasVideo);
    el.querySelector('.ring').textContent = initials(t.name);
    el.querySelector('.tile-name').textContent = t.name;

    const v = el.querySelector('video');
    v.muted = t.muted;
    if (v.srcObject !== t.stream) v.srcObject = t.stream;
    void v.play().catch(() => {});
  }

  for (const el of [...strip.children]) if (!alive.has(el.dataset.tile)) el.remove();
}

// Bir eş ekranını paylaşıyorsa akışı karo yerine büyük sahnede göster.
function routeScreenShare(members) {
  const sharer = members.find((m) => m.media?.screen && m.connectionId !== selfConnectionId);
  if (!sharer) {
    if (!media.screen && stageLayer === 'screen') {
      $('screen-view').srcObject = null;
      restoreSourceStage();
    }
    return;
  }
  const r = remotes.get(sharer.connectionId);
  if (!r) return;
  r.screen = true;
  const el = $('screen-view');
  if (el.srcObject !== r.stream) {
    pauseUnderlyingPlayer();
    showStage('screen');
    el.srcObject = r.stream;
    el.muted = false;
    void el.play().catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════ Ortak tarayıcı
let browserActive = false;
/** Oda kurucusu muyuz? Ortak tarayıcıyı ve kaynağı yalnızca o sürer. */
let iAmHost = false;
/** Oda girişinde açılan ortak tarayıcı soketinin sonucu. */
let bwReady = Promise.resolve(false);

const sharedBrowser = createSharedBrowser({
  canvas: $('browser-view'),
  wsBase: BW_BASE,
  getTicket: async (s) => (await api('POST', `/api/rooms/${s}/ticket`)).ticket,
  onState: (st) => {
    const was = browserActive;
    browserActive = Boolean(st.active);
    $('btn-browser').dataset.on = String(browserActive);
    // Bu modda ortak bir zaman çizgisi yok; oynat/duraklat hiçbir işe yaramaz.
    $('screen-room').classList.toggle('browser-mode', browserActive);

    if (browserActive) {
      pauseUnderlyingPlayer();
      showStage('browser');
      $('browser-view').focus();
      if (st.url) $('stage-url').value = st.url;
      if (!was && st.by) addSystem(`${st.by} ortak tarayıcıyı açtı`);
    } else if (was) {
      // Kapanınca odanın asıl kaynağına dön; boş ekranda bırakma.
      restoreSourceStage();
      $('stage-url').value = '';
      addSystem('Ortak tarayıcı kapatıldı');
    }
    updateLinkbar();
  },
  onUrl: (u) => { if (browserActive && document.activeElement !== $('stage-url')) $('stage-url').value = u; },
  onLoading: (on) => $('bw-progress').classList.toggle('is-hidden', !on),
  onError: (m) => addSystem(m),
});

$('btn-bw-back').onclick = () => sharedBrowser.back();
$('btn-bw-fwd').onclick = () => sharedBrowser.forward();
$('btn-bw-reload').onclick = () => sharedBrowser.reload();

// Bağlantı çubuğu iki işe birden bakıyor; hangisinde olduğumuz belli olsun.
// Kaynağı ve ortak tarayıcıyı yalnızca kurucu sürebildiği için, sürücü
// değilsek bunu yazıyoruz — tıklayıp hiçbir şey olmamasından iyidir.
function updateLinkbar() {
  const bar = $('stage-url');
  if (!iAmHost) {
    bar.placeholder = 'Kaynağı yalnızca oda kurucusu değiştirebilir';
    bar.disabled = true;
    $('btn-stage-url').disabled = true;
    $('btn-browser').disabled = true;
  } else {
    bar.disabled = false;
    $('btn-stage-url').disabled = false;
    $('btn-browser').disabled = false;
    bar.placeholder = browserActive
      ? 'Adres ya da arama yaz, Enter\'a bas'
      : 'YouTube bağlantısı, adres ya da arama — Enter\'a bas';
  }
  $('btn-stage-url').textContent = browserActive ? 'Git' : 'Aç';
  $('linkbar-icon').textContent = browserActive ? '🌐' : '▶';
  $('nav-buttons').classList.toggle('is-hidden', !browserActive || !iAmHost);
  $('browser-hint').textContent = browserActive && !iAmHost
    ? 'Ortak tarayıcıyı oda kurucusu sürüyor'
    : '';
}

async function openSharedBrowser(url) {
  if (!await bwReady) {
    addSystem('Ortak tarayıcı servisi çalışmıyor (npm run dev:browser).');
    return;
  }
  sharedBrowser.start(url || 'https://www.wikipedia.org');
}

$('btn-browser').onclick = () => {
  if (browserActive) { sharedBrowser.stop(); return; }
  void openSharedBrowser($('stage-url').value.trim());
};

// ════════════════════════════════════════════════════════════ Arayüz
function renderMembers(members) {
  lastMembers = members;
  $('people-count').textContent = String(members.length);
  $('members').innerHTML = members.map((m) => {
    const badges = [
      m.media?.mic ? '🎙' : '', m.media?.cam ? '📷' : '', m.media?.screen ? '🖥' : '',
    ].filter(Boolean).join(' ');
    return `<li>
      <span class="avatar">${escapeHtml(initials(m.displayName))}</span>
      <span>${escapeHtml(m.displayName)}</span>
      ${badges ? `<span class="member-media">${badges}</span>` : ''}
      ${m.isHost ? '<span class="host-tag">HOST</span>' : ''}
    </li>`;
  }).join('');

  // Host değişebilir (kurucu çıkarsa sıradakine geçer); yetkiyi her
  // PRESENCE'ta tazeliyoruz.
  iAmHost = members.some((m) => m.isHost && m.connectionId === selfConnectionId);
  sharedBrowser.setDriver(iAmHost);
  updateLinkbar();

  const peers = members.filter((m) => m.connectionId !== selfConnectionId);
  syncPeers();
  routeScreenShare(members);
  renderTiles();

  $('media-note').textContent = peers.length >= MAX_MEDIA_PEERS - 1
    ? `Görüntülü sohbet ${MAX_MEDIA_PEERS} kişiyle sınırlı`
    : '';
}

function addChat(who, text) {
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `
    <span class="avatar">${escapeHtml(initials(who))}</span>
    <div class="msg-body">
      <div class="msg-who">${escapeHtml(who)}</div>
      <div class="msg-text">${escapeHtml(text)}</div>
    </div>`;
  appendChat(div);
}

function addSystem(text) {
  const div = document.createElement('div');
  div.className = 'msg-sys';
  div.textContent = text;
  appendChat(div);
}

function appendChat(node) {
  const log = $('chat-log');
  log.appendChild(node);
  log.scrollTop = log.scrollHeight;
}

for (const tab of document.querySelectorAll('[data-side-tab]')) {
  tab.onclick = () => {
    const which = tab.getAttribute('data-side-tab');
    for (const t of document.querySelectorAll('[data-side-tab]')) t.classList.toggle('is-active', t === tab);
    $('pane-chat').classList.toggle('is-hidden', which !== 'chat');
    $('pane-people').classList.toggle('is-hidden', which !== 'people');
  };
}

$('btn-invite').onclick = () => $('invite-sheet').classList.remove('is-hidden');
$('btn-invite-close').onclick = () => $('invite-sheet').classList.add('is-hidden');
$('invite-sheet').onclick = (e) => { if (e.target === $('invite-sheet')) $('invite-sheet').classList.add('is-hidden'); };

$('btn-debug').onclick = () => $('debug-drawer').classList.toggle('is-hidden');
$('btn-debug-close').onclick = () => $('debug-drawer').classList.add('is-hidden');

for (const b of document.querySelectorAll('[data-copy]')) {
  b.onclick = async () => {
    const input = $(b.getAttribute('data-copy'));
    try { await navigator.clipboard.writeText(input.value); toast('Bağlantı kopyalandı'); }
    catch { input.select(); toast('Kopyalamak için Ctrl+C'); }
  };
}

// ══════════════════════════════════════════════════════════════ Yükleme
$('file-input').onchange = () => {
  const f = $('file-input').files?.[0];
  $('file-name').textContent = f ? f.name : 'seçilmedi';
};

$('btn-upload').onclick = async () => {
  const file = $('file-input').files?.[0];
  if (!file) return setStatus('upload-status', 'Önce bir dosya seç', 'err');

  $('upload-progress').classList.remove('is-hidden');
  try {
    setStatus('upload-status', 'Hazırlanıyor…');
    const { video, upload } = await api('POST', '/api/videos', {
      title: file.name,
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
    });

    // Dosya doğrudan depoya gider, API sunucusundan geçmez.
    setStatus('upload-status', 'Yükleniyor…');
    await putWithProgress(upload.url, file, upload.headers, (pct) => setProgress(pct, 'yükleniyor'));

    setStatus('upload-status', 'İşleniyor…');
    await api('POST', `/api/videos/${video.id}/complete`);

    const ready = await waitUntilReady(video.id);
    setProgress(100, 'hazır');
    setStatus('upload-status', `${ready.title} hazır (${Math.round(ready.durationMs / 1000)} sn)`, 'ok');
    await refreshVideos();
  } catch (e) {
    setStatus('upload-status', e.message, 'err');
    setProgress(0, 'hata');
  }
};

function putWithProgress(url, file, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers || {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
      ? resolve(null)
      : reject(new Error(`Yükleme başarısız (HTTP ${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Yükleme sırasında ağ hatası'));
    xhr.send(file);
  });
}

// WebSocket bağlıysa ilerleme itilir; değilse yoklamaya düşeriz.
async function waitUntilReady(videoId, timeoutMs = 15 * 60_000) {
  const deadline = Date.now() + timeoutMs;

  const pushed = new Promise((resolve, reject) => {
    progressWatchers.set(videoId, (e) => {
      if (e.status === 'ready') resolve('anlık');
      if (e.status === 'failed') reject(new Error(e.errorMessage || 'işleme başarısız'));
    });
  });

  const polled = (async () => {
    while (Date.now() < deadline) {
      const { video } = await api('GET', `/api/videos/${videoId}`);
      if (video.status === 'ready') return 'yoklama';
      if (video.status === 'failed') throw new Error(video.errorMessage || 'işleme başarısız');
      if (ws?.readyState !== WebSocket.OPEN) setProgress(video.progress ?? 0, 'işleniyor');
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('İşleme zaman aşımına uğradı');
  })();

  try {
    await Promise.race([pushed, polled]);
    const { video } = await api('GET', `/api/videos/${videoId}`);
    return video;
  } finally {
    progressWatchers.delete(videoId);
  }
}

function onVideoProgress(msg) {
  setProgress(msg.percent ?? 0, msg.status === 'processing' ? 'işleniyor' : msg.status);
  progressWatchers.get(msg.videoId)?.(msg);
}

function setProgress(pct, label) {
  $('progress-fill').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  $('progress-label').textContent = `${label} · %${pct}`;
}

async function refreshVideos() {
  try {
    const { videos } = await api('GET', '/api/videos');
    $('video-list').innerHTML = videos.length === 0
      ? '<li class="empty">Henüz video yok — bir dosya yükleyip başla</li>'
      : videos.map((v) => `
          <li>
            <span class="v-title">${escapeHtml(v.title)}</span>
            <span class="v-status v-${v.status}">${v.status}</span>
            ${v.status === 'ready' ? `<button class="btn btn-sm" data-play="${v.id}">Odada oynat</button>` : ''}
          </li>`).join('');

    for (const btn of $('video-list').querySelectorAll('[data-play]')) {
      btn.onclick = () => useVideoInRoom(btn.getAttribute('data-play'));
    }
  } catch { /* oturum yoksa sessiz geç */ }
}

// ═══════════════════════════════════════════════════════════════ Odaların
const SOURCE_LABEL = { youtube: 'YouTube', hls: 'Video' };

function shortDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(+d) ? '' : d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}

async function refreshRooms() {
  try {
    const { rooms } = await api('GET', '/api/rooms');
    $('rooms-list').innerHTML = rooms.length === 0
      ? '<li class="empty">Henüz odan yok — yukarıdan bir tane aç</li>'
      : rooms.map((r) => `
          <li class="room-card" data-enter="${escapeHtml(r.slug)}">
            <strong>${escapeHtml(r.name)}</strong>
            <span class="mono muted">${escapeHtml(r.slug)}</span>
            <div class="room-meta">
              <span class="chip">${SOURCE_LABEL[r.sourceType] ?? r.sourceType}</span>
              <span class="muted small">${shortDate(r.createdAt)}</span>
            </div>
          </li>`).join('');

    for (const li of $('rooms-list').querySelectorAll('[data-enter]')) {
      li.onclick = async () => {
        try { await enterRoom(li.getAttribute('data-enter')); }
        catch (e) { setStatus('room-status', e.message, 'err'); }
      };
    }
  } catch { /* oturum yoksa sessiz geç */ }
}

$('btn-rooms-refresh').onclick = () => void refreshRooms();

async function useVideoInRoom(videoId) {
  if (!slug) return setStatus('upload-status', 'Önce bir odaya gir', 'err');
  try {
    await api('PATCH', `/api/rooms/${slug}/video`, { videoId });
    const { video } = await api('GET', `/api/videos/${videoId}`);
    sendMsg({ type: 'SET_SOURCE', source: { type: 'hls', url: video.hlsUrl } });
    toast(`${video.title} odaya kondu`);
  } catch (e) { setStatus('upload-status', e.message, 'err'); }
}

// ══════════════════════════════════════════════════════════════ Açılış
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('room-slug').value = urlRoom;

if (token) {
  api('GET', '/api/auth/me')
    .then(({ user }) => { me = user; enterHome(); })
    .catch(() => { token = ''; localStorage.removeItem('token'); });
}
