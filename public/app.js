// @ts-check
import {
  effectivePositionMs,
  computeClockSample,
  bestSample,
  decideDriftAction,
} from '/app/protocol.js';

const API = location.origin;
// Geliştirmede iki realtime instance ayrı portlarda. ?rt=8092 ile ikincisine
// bağlanmak, oda durumunun süreçler arası paylaşıldığını göstermeyi sağlıyor.
const RT_PORT = new URLSearchParams(location.search).get('rt') || '8091';
const WS_BASE = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:${RT_PORT}/ws`;

// esbuild IIFE paketinde sınıf .default altına düşer; CDN UMD'sinde doğrudan gelir.
const HlsLib = globalThis.Hls?.isSupported ? globalThis.Hls : globalThis.Hls?.default;

const $ = (id) => document.getElementById(id);

// ─────────────────────────────────────────────────────────────── Durum
let token = localStorage.getItem('token') || '';
let me = null;
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

function mountSource(source, startAtMs, shouldPlay) {
  if (!source) return;
  $('stage-empty').classList.add('is-hidden');

  if (source.type === 'youtube') {
    if (activeKind !== 'youtube') {
      if (hls) { hls.destroy(); hls = null; }
      $('video').hidden = true;
      $('video').removeAttribute('src');
      activeKind = 'youtube';
      player = youtubeAdapter;
      supportsFineRate = null;
    }
    if (!ytReady) return;
    if (ytPlayer.getVideoData?.()?.video_id !== source.videoId) {
      ytPlayer.loadVideoById(source.videoId, startAtMs / 1000);
      if (!shouldPlay) ytPlayer.pauseVideo();
    }
    $('source-label').textContent = `youtube · ${source.videoId}`;
    return;
  }

  const video = $('video');
  if (activeKind !== 'hls' || video.dataset.src !== source.url) {
    const ytEl = $('player');
    if (ytEl) ytEl.hidden = true;
    video.hidden = false;
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

// ═══════════════════════════════════════════════════════════════ Oda aç
$('btn-create').onclick = async () => {
  try {
    const { room } = await api('POST', '/api/rooms', {
      name: $('room-name').value || 'Oda',
      youtubeVideoId: $('yt-id').value || undefined,
    });
    $('room-slug').value = room.slug;
    await connect(room.slug, room.name);
  } catch (e) { setStatus('room-status', e.message, 'err'); }
};

$('btn-join').onclick = async () => {
  const s = $('room-slug').value.trim();
  if (!s) return setStatus('room-status', 'Oda kodu gerekli', 'err');
  try {
    await api('POST', `/api/rooms/${s}/join`);
    const { room } = await api('GET', `/api/rooms/${s}`);
    await connect(s, room.name);
  } catch (e) { setStatus('room-status', e.message, 'err'); }
};

$('btn-leave').onclick = () => {
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  slug = ''; state = null; seenVersion = 0;
  showScreen('home');
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
      $('room-title').textContent = msg.room.name;
      applyState(msg.state);
      renderMembers(msg.members);
      addSystem(`"${msg.room.name}" odasına katıldın`);
      break;

    case 'PONG': {
      clockSamples.push(computeClockSample(msg.t0, msg.t1, msg.t2, Date.now()));
      const best = bestSample(clockSamples);
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
  if (ws?.readyState === WebSocket.OPEN) {
    if (clockSamples.length > 40) clockSamples = clockSamples.slice(-10);
    syncClock(3);
  }
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

// ════════════════════════════════════════════════════════════ Arayüz
function renderMembers(members) {
  $('people-count').textContent = String(members.length);
  $('members').innerHTML = members.map((m) => `
    <li>
      <span class="avatar">${escapeHtml(initials(m.displayName))}</span>
      <span>${escapeHtml(m.displayName)}</span>
      ${m.isHost ? '<span class="host-tag">HOST</span>' : ''}
    </li>`).join('');
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
