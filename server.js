'use strict';

const express = require('express');
const http    = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

// ── Config (all from env vars — no secrets in code) ───────────────────────────
const cfg = {
  clientId:     process.env.TWITCH_CLIENT_ID     || '',
  clientSecret: process.env.TWITCH_CLIENT_SECRET || '',
  channel:     (process.env.TWITCH_CHANNEL       || '').toLowerCase(),
  hostUrl:      (process.env.HOST_URL             || 'http://192.168.1.10:3000').replace(/\/$/, ''),
  callbackUrl:  (process.env.CALLBACK_URL        || '').replace(/\/$/, ''),
  port:          parseInt(process.env.PORT       || '3000', 10),
  dataDir:       process.env.DATA_DIR            || '/app/data',
};
cfg.redirectUri = cfg.callbackUrl || `${cfg.hostUrl}/auth/callback`;

// ── Spotify config ────────────────────────────────────────────────────────────
const spotifyCfg = {
  clientId:     process.env.SPOTIFY_CLIENT_ID     || '',
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
  callbackUrl:  (process.env.SPOTIFY_CALLBACK_URL || '').replace(/\/$/, ''),
};

// ── Token storage ─────────────────────────────────────────────────────────────
const tokensFile  = path.join(cfg.dataDir, 'tokens.json');
const titlesFile  = path.join(cfg.dataDir, 'custom-titles.json');

function loadTitles() {
  try { return JSON.parse(fs.readFileSync(titlesFile, 'utf8')); }
  catch { return {}; }
}
function saveTitles(titles) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(titlesFile, JSON.stringify(titles, null, 2));
}

// ── Custom sounds ──────────────────────────────────────────────────────────────
const soundsDir   = path.join(cfg.dataDir, 'sounds');
const ALERT_TYPES = ['follow', 'sub', 'resub', 'giftsub', 'bits', 'raid'];
const MIME_TO_EXT = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',  'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/webm': 'webm', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/mp4': 'm4a',  'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
};
const EXT_TO_MIME = { mp3:'audio/mpeg', ogg:'audio/ogg', wav:'audio/wav', webm:'audio/webm', flac:'audio/flac', m4a:'audio/mp4', aac:'audio/aac' };
const SOUND_EXTS  = [...new Set(Object.values(MIME_TO_EXT))];

function findSoundFile(type) {
  for (const ext of SOUND_EXTS) {
    const fp = path.join(soundsDir, `${type}.${ext}`);
    if (fs.existsSync(fp)) return { fp, ext };
  }
  return null;
}

// ── Spotify token storage + polling ───────────────────────────────────────────
const spotifyTokensFile = path.join(cfg.dataDir, 'spotify-tokens.json');

function loadSpotifyTokens() {
  try { return JSON.parse(fs.readFileSync(spotifyTokensFile, 'utf8')); }
  catch { return null; }
}
function saveSpotifyTokens(t) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(spotifyTokensFile, JSON.stringify(t, null, 2));
}

async function refreshSpotifyToken() {
  const t = loadSpotifyTokens();
  if (!t?.refresh_token) throw new Error('No Spotify refresh token');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${spotifyCfg.clientId}:${spotifyCfg.clientSecret}`).toString('base64'),
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token }),
  });
  if (!res.ok) throw new Error(`Spotify refresh failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const updated = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || t.refresh_token,
    expires_at:    Date.now() + data.expires_in * 1000,
  };
  saveSpotifyTokens(updated);
  return updated.access_token;
}

async function getSpotifyToken() {
  const t = loadSpotifyTokens();
  if (!t) return null;
  if (Date.now() > t.expires_at - 60_000) return refreshSpotifyToken();
  return t.access_token;
}

let currentTrack = null;
const spotifyClients = new Set();
let spotifyMode = 'auto'; // 'auto' | 'hidden'

function broadcastSpotify(data) {
  const msg = JSON.stringify(data);
  spotifyClients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

// ── Chat commands ──────────────────────────────────────────────────────────────
const CHAT_COMMANDS = {
  '!song': {
    desc: 'Shows the current Spotify track for 10 seconds',
    action() { broadcastSpotify({ type: 'show_now', duration: 10000 }); },
  },
  '!hidespotify': {
    desc: 'Stops the Spotify overlay from auto-popping on track change',
    action() { spotifyMode = 'hidden'; broadcastSpotify({ type: 'set_mode', mode: 'hidden' }); },
  },
  '!showspotify': {
    desc: 'Re-enables the Spotify overlay 15-second auto-show on track change',
    action() { spotifyMode = 'auto'; broadcastSpotify({ type: 'set_mode', mode: 'auto' }); },
  },
};

function handleChatCommand(text) {
  const cmd = CHAT_COMMANDS[text.trim().toLowerCase()];
  if (cmd) { console.log('Chat command:', text.trim()); cmd.action(); }
}

function connectChatReader() {
  if (!cfg.channel) return;
  const ws = new WebSocket('wss://irc-ws.chat.twitch.tv');
  ws.on('open', () => {
    ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    ws.send('PASS SCHMOOPIIE');
    ws.send('NICK justinfan' + Math.floor(Math.random() * 99999));
    ws.send('JOIN #' + cfg.channel);
  });
  ws.on('message', (raw) => {
    for (const line of raw.toString().split('\r\n')) {
      if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
      const match = line.match(/^@\S+ :\S+ PRIVMSG #\S+ :(.*)$/);
      if (match) handleChatCommand(match[1]);
    }
  });
  ws.on('close', () => setTimeout(connectChatReader, 5000));
  ws.on('error', () => {});
}

async function pollSpotify() {
  if (!spotifyCfg.clientId) return;
  try {
    const token = await getSpotifyToken();
    if (!token) return;
    const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 204 || res.status === 404) {
      if (currentTrack !== null) { currentTrack = null; broadcastSpotify({ type: 'stopped' }); }
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    if (!data?.item) return;
    const track = {
      type:        'now_playing',
      title:       data.item.name,
      artist:      data.item.artists.map(a => a.name).join(', '),
      albumArt:    data.item.album.images[0]?.url ?? '',
      duration_ms: data.item.duration_ms,
      progress_ms: data.progress_ms,
      is_playing:  data.is_playing,
    };
    broadcastSpotify(track);
    currentTrack = track;
  } catch (err) {
    console.error('Spotify poll error:', err.message);
  }
}

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(tokensFile, 'utf8')); }
  catch { return null; }
}

function saveTokens(tokens) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(tokensFile, JSON.stringify(tokens, null, 2));
}

async function refreshAccessToken() {
  const tokens = loadTokens();
  if (!tokens?.refresh_token) throw new Error('No refresh token stored');

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token:  tokens.refresh_token,
      client_id:      cfg.clientId,
      client_secret:  cfg.clientSecret,
    }),
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  saveTokens({ access_token: data.access_token, refresh_token: data.refresh_token });
  console.log('Access token refreshed');
  return data.access_token;
}

// ── Twitch API helpers ────────────────────────────────────────────────────────
function twitchHeaders() {
  return {
    'Client-Id':    cfg.clientId,
    'Authorization': `Bearer ${loadTokens()?.access_token}`,
    'Content-Type': 'application/json',
  };
}

async function getUserId(login) {
  const res  = await fetch(`https://api.twitch.tv/helix/users?login=${login}`, { headers: twitchHeaders() });
  const data = await res.json();
  return data.data?.[0]?.id;
}

async function createSubscription(type, version, condition) {
  if (!sessionId) return;
  const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
    method:  'POST',
    headers: twitchHeaders(),
    body:    JSON.stringify({ type, version, condition, transport: { method: 'websocket', session_id: sessionId } }),
  });
  if (res.ok) {
    console.log(`  ✓ Subscribed to ${type}`);
  } else {
    const err = await res.text();
    console.error(`  ✗ Failed ${type}: ${err}`);
  }
}

// ── EventSub WebSocket ────────────────────────────────────────────────────────
let sessionId      = null;
let eventSubWs     = null;
let broadcasterId  = null;
let reconnectTimer = null;

async function connectEventSub(url = 'wss://eventsub.wss.twitch.tv/ws') {
  if (!loadTokens()) {
    console.log('No auth tokens — skipping EventSub. Visit /setup to connect Twitch.');
    return;
  }

  clearTimeout(reconnectTimer);
  if (eventSubWs) { eventSubWs.removeAllListeners(); eventSubWs.terminate(); }

  console.log('Connecting to Twitch EventSub...');
  eventSubWs = new WebSocket(url);

  eventSubWs.on('open', () => console.log('EventSub connected'));

  eventSubWs.on('message', async (raw) => {
    const msg  = JSON.parse(raw.toString());
    const type = msg.metadata?.message_type;

    if (type === 'session_welcome') {
      sessionId = msg.payload.session.id;
      console.log(`EventSub session: ${sessionId}`);
      await setupSubscriptions();

    } else if (type === 'session_reconnect') {
      console.log('EventSub requesting reconnect...');
      connectEventSub(msg.payload.session.reconnect_url);

    } else if (type === 'notification') {
      handleEvent(msg.payload);

    } else if (type === 'revocation') {
      console.warn(`Subscription revoked: ${msg.payload.subscription.type}`);
    }
    // session_keepalive — no action needed
  });

  eventSubWs.on('close', (code) => {
    console.log(`EventSub closed (${code}), reconnecting in 5s...`);
    reconnectTimer = setTimeout(() => connectEventSub(), 5000);
  });

  eventSubWs.on('error', (err) => console.error('EventSub error:', err.message));
}

async function setupSubscriptions() {
  try {
    broadcasterId = await getUserId(cfg.channel);
    if (!broadcasterId) throw new Error(`Channel not found: ${cfg.channel}`);
    console.log(`Setting up subscriptions for ${cfg.channel} (${broadcasterId})...`);

    const id = broadcasterId;
    await createSubscription('channel.follow',               '2', { broadcaster_user_id: id, moderator_user_id: id });
    await createSubscription('channel.subscribe',            '1', { broadcaster_user_id: id });
    await createSubscription('channel.subscription.gift',    '1', { broadcaster_user_id: id });
    await createSubscription('channel.subscription.message', '1', { broadcaster_user_id: id });
    await createSubscription('channel.cheer',                '1', { broadcaster_user_id: id });
    await createSubscription('channel.raid',                 '1', { to_broadcaster_user_id: id });
    await createSubscription('channel.channel_points_custom_reward_redemption.add', '1', { broadcaster_user_id: id });
  } catch (err) {
    console.error('Subscription setup failed:', err.message);
  }
}

function handleEvent(payload) {
  const type  = payload.subscription.type;
  const event = payload.event;
  let alert   = null;

  switch (type) {
    case 'channel.follow':
      alert = { type: 'follow', user: event.user_name };
      break;
    case 'channel.subscribe':
      if (!event.is_gift)
        alert = { type: 'sub', user: event.user_name, tier: tierLabel(event.tier) };
      break;
    case 'channel.subscription.gift':
      alert = {
        type:  'giftsub',
        user:  event.is_anonymous ? 'Anonymous' : event.user_name,
        count: event.total,
        tier:  tierLabel(event.tier),
      };
      break;
    case 'channel.subscription.message':
      alert = {
        type:    'resub',
        user:    event.user_name,
        months:  event.cumulative_months,
        tier:    tierLabel(event.tier),
        message: event.message?.text || '',
      };
      break;
    case 'channel.cheer':
      alert = {
        type:    'bits',
        user:    event.is_anonymous ? 'Anonymous' : event.user_name,
        bits:    event.bits,
        message: event.message || '',
      };
      break;
    case 'channel.raid':
      alert = { type: 'raid', user: event.from_broadcaster_user_name, viewers: event.viewers };
      break;
    case 'channel.channel_points_custom_reward_redemption.add':
      broadcastChatEvent({
        type:   'redemption',
        user:   event.user_name,
        reward: event.reward.title,
        cost:   event.reward.cost,
        input:  event.user_input || '',
      });
      break;
  }

  if (alert) {
    console.log('Alert fired:', alert);
    broadcast(alert);
    broadcastChatEvent(alert);
  }
}

function tierLabel(tier) {
  return { '1000': 'Tier 1', '2000': 'Tier 2', '3000': 'Tier 3' }[tier] ?? 'Tier 1';
}

// ── OBS client WebSocket server ───────────────────────────────────────────────
const obsClients  = new Set();
const chatClients = new Set();

function broadcast(data) {
  const msg = JSON.stringify(data);
  obsClients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

function broadcastTitles(titles) {
  const msg = JSON.stringify({ type: 'titles_update', titles });
  chatClients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

function broadcastChatEvent(data) {
  const msg = JSON.stringify(data);
  chatClients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

// ── Token auto-refresh every 2 hours ─────────────────────────────────────────
setInterval(async () => {
  if (!loadTokens()) return;
  try { await refreshAccessToken(); }
  catch (err) { console.error('Scheduled token refresh failed:', err.message); }
}, 2 * 60 * 60 * 1000);

// Poll Spotify every 5 s (no-op if not configured)
setInterval(pollSpotify, 5000);

// ── Express routes ────────────────────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/setup', (req, res) => {
  const hasTokens = !!loadTokens();
  const authUrl   = buildAuthUrl();
  res.send(setupPageHtml(hasTokens, authUrl));
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.send(errorPage(`OAuth error: ${error ?? 'no code returned'}`));

  const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri:  cfg.redirectUri,
      client_id:     cfg.clientId,
      client_secret: cfg.clientSecret,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    return res.send(errorPage(`Token exchange failed: ${body}`));
  }

  const tokens = await tokenRes.json();
  saveTokens({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
  console.log('Twitch auth complete — starting EventSub');
  connectEventSub();

  res.send('<script>window.location="/setup"</script>');
});

app.get('/test/:type', (req, res) => {
  const samples = {
    follow:  { type: 'follow',  user: 'CyberPilot99' },
    sub:     { type: 'sub',     user: 'NeonRider',   tier: 'Tier 1' },
    resub:   { type: 'resub',   user: 'VoidWalker',  tier: 'Tier 2', months: 7, message: 'Love the stream!' },
    giftsub: { type: 'giftsub', user: 'DataGhost',   tier: 'Tier 1', count: 5 },
    bits:    { type: 'bits',    user: 'ChromeFox',   bits: 1000, message: 'PogChamp' },
    raid:    { type: 'raid',    user: 'PixelWarden', viewers: 47 },
  };
  const alert = samples[req.params.type];
  if (!alert) return res.status(404).json({ error: 'Unknown type. Use: follow, sub, resub, giftsub, bits, raid' });
  broadcast(alert);
  res.json({ ok: true, sent: alert });
});

app.get('/titles', (_req, res) => res.json(loadTitles()));

app.post('/titles', express.json(), (req, res) => {
  const { username, label, color } = req.body || {};
  if (!username || !label) return res.status(400).json({ error: 'username and label required' });
  const titles = loadTitles();
  titles[username.toLowerCase()] = { label, color: color || '#bf00ff' };
  saveTitles(titles);
  broadcastTitles(titles);
  res.json({ ok: true });
});

app.delete('/titles/:username', (req, res) => {
  const titles = loadTitles();
  delete titles[req.params.username.toLowerCase()];
  saveTitles(titles);
  broadcastTitles(titles);
  res.json({ ok: true });
});

// ── Sound management routes ────────────────────────────────────────────────────
app.get('/sounds', (_req, res) => {
  const map = {};
  for (const t of ALERT_TYPES) { const f = findSoundFile(t); map[t] = f ? f.ext : null; }
  res.json(map);
});

app.get('/sounds/:type', (req, res) => {
  const { type } = req.params;
  if (!ALERT_TYPES.includes(type)) return res.status(404).end();
  const found = findSoundFile(type);
  if (!found) return res.status(404).end();
  res.setHeader('Content-Type', EXT_TO_MIME[found.ext] || 'audio/mpeg');
  res.sendFile(found.fp);
});

app.post('/sounds/:type', express.raw({ type: '*/*', limit: '20mb' }), (req, res) => {
  const { type } = req.params;
  if (!ALERT_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid type' });
  const ct  = (req.headers['content-type'] || '').split(';')[0].trim();
  const ext = MIME_TO_EXT[ct];
  if (!ext) return res.status(400).json({ error: `Unsupported format: ${ct}` });
  fs.mkdirSync(soundsDir, { recursive: true });
  for (const e of SOUND_EXTS) { try { fs.unlinkSync(path.join(soundsDir, `${type}.${e}`)); } catch {} }
  fs.writeFileSync(path.join(soundsDir, `${type}.${ext}`), req.body);
  console.log(`Custom sound uploaded: ${type}.${ext}`);
  res.json({ ok: true });
});

app.delete('/sounds/:type', (req, res) => {
  const { type } = req.params;
  if (!ALERT_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid type' });
  for (const ext of SOUND_EXTS) { try { fs.unlinkSync(path.join(soundsDir, `${type}.${ext}`)); } catch {} }
  res.json({ ok: true });
});

// ── Spotify OAuth ──────────────────────────────────────────────────────────────
app.get('/auth/spotify', (_req, res) => {
  if (!spotifyCfg.clientId) return res.send(errorPage('SPOTIFY_CLIENT_ID not set'));
  const redirectUri = spotifyCfg.callbackUrl || `${cfg.hostUrl}/auth/spotify/callback`;
  res.redirect('https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id:     spotifyCfg.clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'user-read-currently-playing user-read-playback-state',
    state:          crypto.randomBytes(16).toString('hex'),
  }));
});

app.get('/auth/spotify/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.send(errorPage(`Spotify OAuth error: ${error ?? 'no code'}`));
  const redirectUri = spotifyCfg.callbackUrl || `${cfg.hostUrl}/auth/spotify/callback`;
  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${spotifyCfg.clientId}:${spotifyCfg.clientSecret}`).toString('base64'),
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
  });
  if (!tokenRes.ok) return res.send(errorPage(`Spotify token exchange failed: ${await tokenRes.text()}`));
  const tokens = await tokenRes.json();
  saveSpotifyTokens({
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    Date.now() + tokens.expires_in * 1000,
  });
  console.log('Spotify auth complete');
  pollSpotify();
  res.send('<script>window.location="/setup"</script>');
});

app.get('/command/:name', (req, res) => {
  const key = '!' + req.params.name.toLowerCase();
  const cmd = CHAT_COMMANDS[key];
  if (!cmd) return res.status(404).json({ error: 'Unknown command' });
  cmd.action();
  res.json({ ok: true, command: key });
});

app.get('/status', (_req, res) => {
  res.json({
    configured:         !!(cfg.clientId && cfg.clientSecret && cfg.channel),
    authenticated:      !!loadTokens(),
    eventsub_connected: eventSubWs?.readyState === WebSocket.OPEN,
    obs_clients:        obsClients.size,
    channel:            cfg.channel,
    broadcaster_id:     broadcasterId || null,
    spotify_configured: !!spotifyCfg.clientId,
    spotify_connected:  !!loadSpotifyTokens(),
    current_track:      currentTrack,
  });
});

// ── HTML helpers ──────────────────────────────────────────────────────────────
function buildAuthUrl() {
  return 'https://id.twitch.tv/oauth2/authorize?' + new URLSearchParams({
    client_id:     cfg.clientId,
    redirect_uri:  cfg.redirectUri,
    response_type: 'code',
    scope:         'moderator:read:followers channel:read:subscriptions bits:read channel:read:redemptions',
    force_verify:  'true',
    state:          crypto.randomBytes(16).toString('hex'),
  });
}

function errorPage(msg) {
  return `<!DOCTYPE html><html><body style="background:#0d0015;color:#ff2d78;font-family:monospace;padding:40px">
    <h2>Error</h2><p>${msg}</p><a href="/setup" style="color:#00f5ff">← Back to setup</a></body></html>`;
}

function setupPageHtml(hasTokens, authUrl) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><title>Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d0015;color:#e0c3ff;font-family:'Share Tech Mono',monospace;padding:20px 24px;min-height:100vh}

  /* ── Header ─────────────────────────────────────────────────────── */
  .header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}
  .header-title h1{font-family:'Orbitron',sans-serif;color:#bf00ff;font-size:1.5rem;text-shadow:0 0 20px #bf00ff;line-height:1}
  .header-title .sub{color:#7b2fff;letter-spacing:2px;font-size:.68rem;margin-top:4px}
  .header-status{display:flex;align-items:center;gap:14px;background:#1a0033;border:1px solid #3d0080;border-radius:6px;padding:7px 14px;flex-shrink:0}
  .sitem{display:flex;align-items:center;gap:5px;font-size:.68rem;letter-spacing:1px;color:#9d77cc;white-space:nowrap}
  .sdot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
  .sdot.on{background:#00ff88;box-shadow:0 0 5px #00ff88}
  .sdot.off{background:#ff2d78;box-shadow:0 0 5px #ff2d78}

  /* ── Cards ──────────────────────────────────────────────────────── */
  .card{background:#1a0033;border:1px solid #3d0080;border-radius:8px;padding:18px;position:relative}
  .card::before{content:'';position:absolute;top:6px;right:6px;width:9px;height:9px;border-top:1px solid #7b2fff;border-right:1px solid #7b2fff}
  h2{font-family:'Orbitron',sans-serif;color:#00f5ff;font-size:.68rem;letter-spacing:3px;text-transform:uppercase;margin-bottom:12px}
  p{color:#c9a0dc;line-height:1.65;margin-bottom:8px;font-size:.82rem}
  .url{background:#080012;border:1px solid #3d0080;border-radius:4px;padding:8px 12px;font-size:.78rem;color:#00f5ff;margin:6px 0;word-break:break-all;user-select:all}
  .btn{display:inline-block;background:linear-gradient(135deg,#7b2fff,#bf00ff);color:#fff;padding:9px 22px;border-radius:6px;text-decoration:none;font-family:'Orbitron',sans-serif;font-size:.68rem;letter-spacing:2px;box-shadow:0 0 18px rgba(191,0,255,.3);cursor:pointer;border:none;margin-top:6px}
  .btn:hover{opacity:.85}
  a:not(.btn){color:#bf00ff}
  ol{padding-left:18px;color:#c9a0dc;line-height:2;font-size:.82rem}

  /* ── Layout rows ─────────────────────────────────────────────────── */
  .main-row{display:flex;gap:16px;margin-bottom:16px;align-items:flex-start}
  .bottom-row{display:flex;gap:16px;align-items:flex-start}
  .col-left{flex:0 0 300px;display:flex;flex-direction:column;gap:16px;min-width:0}

  /* ── Chat iframe ─────────────────────────────────────────────────── */
  .chat-frame{width:100%;height:560px;border:1px solid #3d0080;border-radius:4px;background:#080012;display:block}

  /* ── Event feed ──────────────────────────────────────────────────── */
  #event-feed{height:340px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;background:#080012;border-radius:4px;padding:8px;scrollbar-width:thin;scrollbar-color:#3d0080 transparent}
  #event-feed::-webkit-scrollbar{width:4px}
  #event-feed::-webkit-scrollbar-thumb{background:#3d0080;border-radius:2px}
  .ev-empty{color:#3d0080;font-size:.75rem;padding:4px 2px}
  .ev-row{display:flex;align-items:baseline;gap:8px;padding:5px 8px;border-left:2px solid var(--ec,#ffd700);border-radius:0 3px 3px 0;font-size:.75rem;flex-shrink:0;background:rgba(0,0,0,0.15)}
  .ev-time{color:#4a2080;flex-shrink:0;font-size:.68rem;font-variant-numeric:tabular-nums}
  .ev-user{color:#ffd700;font-weight:bold;flex-shrink:0}
  .ev-detail{color:rgba(255,215,0,.65)}
  .ev-input{color:#ddd0f0;font-style:italic}

  /* ── Test buttons ────────────────────────────────────────────────── */
  .test-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:4px}
  .tbtn{font-family:'Share Tech Mono',monospace;font-size:.68rem;letter-spacing:1px;padding:8px 4px;border-radius:4px;border:1px solid var(--c);background:transparent;color:var(--c);cursor:pointer;text-transform:uppercase;transition:background .15s}
  .tbtn:hover{background:color-mix(in srgb,var(--c) 15%,transparent);box-shadow:0 0 10px -3px var(--c)}
  .tbtn:active{opacity:.6}
  .tbtn.follow{--c:#00f5ff}.tbtn.sub{--c:#bf00ff}.tbtn.resub{--c:#9d00ff}
  .tbtn.giftsub{--c:#ff2d78}.tbtn.bits{--c:#ffd700}.tbtn.raid{--c:#ff6b35}
  #test-fb{margin-top:10px;font-size:.72rem;color:#00ff88;min-height:1.1em;letter-spacing:1px}

  /* ── Titles form ─────────────────────────────────────────────────── */
  .t-form{display:grid;grid-template-columns:1fr 1fr auto auto;gap:7px;align-items:center;margin-top:4px}
  .t-input{background:#080012;border:1px solid #3d0080;border-radius:4px;padding:6px 10px;color:#e0c3ff;font-family:'Share Tech Mono',monospace;font-size:.78rem;width:100%}
  .t-input:focus{outline:none;border-color:#7b2fff}
  .t-color{width:34px;height:30px;border:1px solid #3d0080;border-radius:4px;background:#080012;cursor:pointer;padding:2px}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  td{vertical-align:middle;font-size:.78rem}
</style>
</head><body>

<div class="header">
  <div class="header-title">
    <h1>⚡ DASHBOARD</h1>
    <div class="sub">STREAM CONTROL // EMENBLADE</div>
  </div>
  <div class="header-status">
    <div class="sitem"><div class="sdot ${hasTokens ? 'on' : 'off'}"></div>${hasTokens ? 'Twitch connected' : 'Not connected'}</div>
    <div class="sitem"><div class="sdot ${cfg.clientId ? 'on' : 'off'}"></div>Client ID</div>
    <div class="sitem"><div class="sdot ${cfg.channel ? 'on' : 'off'}"></div>${cfg.channel || 'no channel'}</div>
  </div>
</div>

${hasTokens ? `
<div class="main-row">
  <div class="col-left">
    <div class="card" style="padding:14px">
      <h2>Event Feed</h2>
      <div id="event-feed"><div class="ev-empty">Waiting for events...</div></div>
    </div>
    <div class="card">
      <h2>Custom User Titles</h2>
      <p>Give specific chatters a named badge next to their name.</p>
      <form class="t-form" onsubmit="addTitle(event)">
        <input id="t-user"  class="t-input" placeholder="username" autocomplete="off" spellcheck="false">
        <input id="t-label" class="t-input" placeholder="title" autocomplete="off" spellcheck="false">
        <input id="t-color" class="t-color" type="color" value="#bf00ff" title="Badge color">
        <button type="submit" class="btn" style="padding:6px 14px;margin:0;font-size:.65rem">Add</button>
      </form>
      <table><tbody id="titles-tbody"></tbody></table>
    </div>
  </div>
  <div class="card" style="flex:1;padding:14px">
    <h2>Chat Preview</h2>
    <iframe id="chat-preview" src="/chat.html" class="chat-frame" frameborder="0"></iframe>
  </div>
</div>

<div class="bottom-row">
  <div class="card">
    <h2>OBS Browser Sources</h2>
    <p>Alerts overlay — <strong>1920 × 300</strong>, transparent, bottom of scene:</p>
    <div class="url">${cfg.hostUrl}/alerts.html</div>
    <p style="margin-top:10px">Chat overlay — <strong>380 × 700</strong>, transparent, right side:</p>
    <div class="url">${cfg.hostUrl}/chat.html</div>
  </div>
  <div class="card">
    <h2>Test Alerts</h2>
    <p>Fire a test alert to your OBS overlay. Make sure it's open first.</p>
    <div class="test-grid">
      <button class="tbtn follow"  onclick="test('follow')">Follow</button>
      <button class="tbtn sub"     onclick="test('sub')">Sub</button>
      <button class="tbtn resub"   onclick="test('resub')">Resub</button>
      <button class="tbtn giftsub" onclick="test('giftsub')">Gift Sub</button>
      <button class="tbtn bits"    onclick="test('bits')">Bits</button>
      <button class="tbtn raid"    onclick="test('raid')">Raid</button>
    </div>
    <div id="test-fb"></div>
  </div>
  <div class="card">
    <h2>Re-authorize</h2>
    <p>Use this if you need to re-connect your Twitch account.</p>
    <a class="btn" href="${authUrl}">Re-connect Twitch</a>
  </div>
  <div class="card">
    <h2>Spotify Now Playing</h2>
    <div class="sitem" style="margin-bottom:10px">
      <div class="sdot ${loadSpotifyTokens() ? 'on' : 'off'}"></div>
      <span style="color:${loadSpotifyTokens() ? '#00ff88' : '#ff2d78'}">${loadSpotifyTokens() ? 'Connected' : 'Not connected'}</span>
    </div>
    ${loadSpotifyTokens() ? `
    <p>Add this as a Browser Source in OBS:</p>
    <div class="url">${cfg.hostUrl}/spotify.html</div>
    <p style="margin-top:6px;font-size:.75rem;color:#7b2fff">500 × 140, transparent</p>
    ` : `
    <p>Set these env vars first, then connect:</p>
    <p style="font-size:.75rem;color:#7b2fff;line-height:1.8">SPOTIFY_CLIENT_ID<br>SPOTIFY_CLIENT_SECRET<br>SPOTIFY_CALLBACK_URL</p>
    <a class="btn" href="/auth/spotify" style="margin-top:8px;display:inline-block">Connect Spotify</a>
    `}
    <a class="btn" href="/auth/spotify" style="margin-top:8px;display:inline-block;background:linear-gradient(135deg,#0f7a3a,#1DB954)">Re-connect Spotify</a>
  </div>
</div>

<div class="card" style="margin-top:16px">
  <h2>Chat Commands</h2>
  <p>Active in <strong>#${cfg.channel}</strong>. Click Trigger to fire without typing in chat.</p>
  <table style="margin-top:10px;width:100%">
    <tbody>
      ${Object.entries(CHAT_COMMANDS).map(([cmd, { desc }], i, arr) => {
        const name = cmd.slice(1);
        const border = i < arr.length - 1 ? 'border-bottom:1px solid #0d0015' : '';
        return `<tr style="${border}">
          <td style="padding:8px 14px 8px 0;color:#00f5ff;font-size:.82rem;white-space:nowrap;font-family:'Share Tech Mono',monospace">${cmd}</td>
          <td style="padding:8px 14px;color:#c9a0dc;font-size:.78rem;width:100%">${desc}</td>
          <td style="padding:8px 0;white-space:nowrap"><button onclick="triggerCmd('${name}')" class="btn" style="padding:5px 14px;margin:0;font-size:.62rem;letter-spacing:1px">Trigger</button></td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
  <div id="cmd-fb" style="margin-top:8px;font-size:.72rem;min-height:1.1em;letter-spacing:1px"></div>
</div>

<div class="card" style="margin-top:16px">
  <h2>Custom Alert Sounds</h2>
  <p>Upload audio files (MP3, WAV, OGG, WEBM, FLAC — max 20 MB each) to replace the built-in synth sounds. Changes take effect immediately in the browser source.</p>
  <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-top:10px">
    ${['follow','sub','resub','giftsub','bits','raid'].map(t => {
      const clr = {follow:'#00f5ff',sub:'#bf00ff',resub:'#9d00ff',giftsub:'#ff2d78',bits:'#ffd700',raid:'#ff6b35'}[t];
      return `<div style="background:#080012;border:1px solid #3d0080;border-radius:4px;padding:10px;text-align:center">
        <div style="color:${clr};font-size:.68rem;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px">${t}</div>
        <div id="sstat-${t}" style="font-size:.65rem;color:#4a2080;margin-bottom:6px;min-height:1em">—</div>
        <label style="cursor:pointer;display:block">
          <input type="file" accept="audio/*" style="display:none" onchange="uploadSound('${t}',this)">
          <span style="display:block;font-size:.62rem;letter-spacing:1px;padding:4px 0;border:1px solid ${clr};border-radius:3px;color:${clr};text-transform:uppercase;cursor:pointer">Upload</span>
        </label>
        <button onclick="removeSound('${t}')" id="sdel-${t}" style="display:none;width:100%;margin-top:4px;background:transparent;border:1px solid #ff2d78;color:#ff2d78;border-radius:3px;padding:3px;cursor:pointer;font-family:inherit;font-size:.62rem">Remove</button>
      </div>`;
    }).join('')}
  </div>
  <div id="sound-fb" style="margin-top:10px;font-size:.72rem;min-height:1.1em;letter-spacing:1px"></div>
</div>
` : `
<div style="display:flex;flex-direction:column;gap:16px;max-width:600px">
  <div class="card">
    <h2>Step 1 — Twitch Developer App</h2>
    <p>Go to <a href="https://dev.twitch.tv/console/apps" target="_blank">dev.twitch.tv/console/apps</a> and open your app (or create one).</p>
    <p>Under <strong>OAuth Redirect URLs</strong>, add exactly this URL:</p>
    <div class="url">${cfg.redirectUri}</div>
    <p>Save the app. Make sure <strong>TWITCH_CLIENT_ID</strong> and <strong>TWITCH_CLIENT_SECRET</strong> match your app's credentials.</p>
  </div>
  <div class="card">
    <h2>Step 2 — Connect Twitch</h2>
    <p>Click below and sign in as <strong>${cfg.channel || 'your channel'}</strong>.</p>
    <a class="btn" href="${authUrl}">Connect with Twitch</a>
  </div>
</div>
`}

<script>
function escHtml(s) {
  return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Test alerts ────────────────────────────────────────────────────
async function test(type) {
  const fb = document.getElementById('test-fb');
  fb.textContent = 'Sending ' + type + '...';
  try {
    const r = await fetch('/test/' + type);
    const d = await r.json();
    fb.textContent = d.ok ? '\\u2713 ' + type + ' alert sent' : '\\u2717 ' + (d.error || 'error');
  } catch { fb.textContent = '\\u2717 Request failed'; }
  setTimeout(() => fb.textContent = '', 3000);
}

// ── Custom titles ──────────────────────────────────────────────────
async function loadTitlesUI() {
  const titles = await fetch('/titles').then(r => r.json()).catch(() => ({}));
  const tbody = document.getElementById('titles-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const entries = Object.entries(titles);
  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="3" style="color:#7b2fff;opacity:.5;padding:8px 0">No custom titles yet.</td></tr>';
    return;
  }
  for (const [username, {label, color}] of entries) {
    const tr = document.createElement('tr');
    tr.innerHTML = \`<td style="padding:4px 8px 4px 0;color:#e0c3ff">\${escHtml(username)}</td>
      <td style="padding:4px 8px"><span style="color:\${escHtml(color)};border:1px solid \${escHtml(color)};padding:1px 6px;border-radius:2px;font-size:10px">\${escHtml(label)}</span></td>
      <td style="padding:4px 0;text-align:right"><button onclick="removeTitle('\${escHtml(username)}')" style="background:transparent;border:1px solid #ff2d78;color:#ff2d78;border-radius:3px;padding:2px 8px;cursor:pointer;font-family:inherit;font-size:.68rem">Remove</button></td>\`;
    tbody.appendChild(tr);
  }
}

async function addTitle(e) {
  e.preventDefault();
  const username = document.getElementById('t-user').value.trim();
  const label    = document.getElementById('t-label').value.trim();
  const color    = document.getElementById('t-color').value;
  if (!username || !label) return;
  await fetch('/titles', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username, label, color}) });
  document.getElementById('t-user').value = '';
  document.getElementById('t-label').value = '';
  loadTitlesUI();
}

async function removeTitle(username) {
  await fetch('/titles/' + encodeURIComponent(username), { method:'DELETE' });
  loadTitlesUI();
}

// ── Event feed ─────────────────────────────────────────────────────
function ts() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2,'0')).join(':');
}

const FEED_COLORS = {
  follow:'#00f5ff', sub:'#bf00ff', resub:'#9d00ff',
  giftsub:'#ff2d78', bits:'#ffd700', raid:'#ff6b35', redemption:'#ffd700',
};

function feedDetail(m) {
  switch (m.type) {
    case 'follow':     return 'followed';
    case 'sub':        return 'subscribed' + (m.tier ? ' \xb7 ' + escHtml(m.tier) : '');
    case 'resub':      return 'resubbed \xb7 ' + m.months + ' months' + (m.tier ? ' \xb7 ' + escHtml(m.tier) : '') + (m.message ? ' \u2014 <span class="ev-input">&ldquo;' + escHtml(m.message) + '&rdquo;</span>' : '');
    case 'giftsub':    return 'gifted ' + m.count + ' sub' + (m.count !== 1 ? 's' : '') + (m.tier ? ' \xb7 ' + escHtml(m.tier) : '');
    case 'bits':       return 'cheered ' + Number(m.bits).toLocaleString() + ' bits' + (m.message ? ' \u2014 <span class="ev-input">&ldquo;' + escHtml(m.message) + '&rdquo;</span>' : '');
    case 'raid':       return 'raided with ' + Number(m.viewers).toLocaleString() + ' viewers';
    case 'redemption': return 'redeemed ' + escHtml(m.reward) + (m.cost ? ' <span style="color:#4a2080">(' + Number(m.cost).toLocaleString() + ' pts)</span>' : '') + (m.input ? ' \u2014 <span class="ev-input">&ldquo;' + escHtml(m.input) + '&rdquo;</span>' : '');
    default:           return escHtml(m.type);
  }
}

function addFeedEvent(data) {
  const feed = document.getElementById('event-feed');
  if (!feed) return;
  const empty = feed.querySelector('.ev-empty');
  if (empty) empty.remove();
  const color = FEED_COLORS[data.type] || '#e0c3ff';
  const row = document.createElement('div');
  row.className = 'ev-row';
  row.style.setProperty('--ec', color);
  row.innerHTML = \`<span class="ev-time">\${ts()}</span><span class="ev-user" style="color:\${color}">\${escHtml(data.user)}</span><span class="ev-detail">\${feedDetail(data)}</span>\`;
  feed.appendChild(row);
  feed.scrollTop = feed.scrollHeight;
}

const FEED_TYPES = new Set(['follow','sub','resub','giftsub','bits','raid','redemption']);

(function connectFeedWs() {
  const ws = new WebSocket(\`ws://\${location.host}/chat-ws\`);
  ws.onmessage = e => { try { const m = JSON.parse(e.data); if (FEED_TYPES.has(m.type)) addFeedEvent(m); } catch {} };
  ws.onclose = () => setTimeout(connectFeedWs, 3000);
  ws.onerror = () => ws.close();
})();

if (document.getElementById('titles-tbody')) loadTitlesUI();

// ── Custom sounds ──────────────────────────────────────────────────
async function loadSoundsUI() {
  const sounds = await fetch('/sounds').then(r => r.json()).catch(() => ({}));
  for (const [type, ext] of Object.entries(sounds)) {
    const stat = document.getElementById('sstat-' + type);
    const del  = document.getElementById('sdel-' + type);
    if (!stat) continue;
    stat.textContent  = ext ? type + '.' + ext : '—';
    stat.style.color  = ext ? '#00ff88' : '#4a2080';
    if (del) del.style.display = ext ? 'block' : 'none';
  }
}

async function uploadSound(type, input) {
  const file = input.files[0];
  if (!file) return;
  const fb = document.getElementById('sound-fb');
  fb.style.color = '#00f5ff';
  fb.textContent = 'Uploading ' + type + '...';
  try {
    const r = await fetch('/sounds/' + type, { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
    const d = await r.json();
    if (d.ok) { fb.style.color = '#00ff88'; fb.textContent = '\\u2713 ' + type + ' sound uploaded'; loadSoundsUI(); }
    else       { fb.style.color = '#ff2d78'; fb.textContent = '\\u2717 ' + (d.error || 'Upload failed'); }
  } catch { fb.style.color = '#ff2d78'; fb.textContent = '\\u2717 Request failed'; }
  setTimeout(() => { const f = document.getElementById('sound-fb'); if (f) f.textContent = ''; }, 3000);
  input.value = '';
}

async function removeSound(type) {
  await fetch('/sounds/' + type, { method: 'DELETE' });
  loadSoundsUI();
}

async function triggerCmd(name) {
  const fb = document.getElementById('cmd-fb');
  if (fb) { fb.style.color = '#00f5ff'; fb.textContent = 'Triggering !' + name + '...'; }
  try {
    const r = await fetch('/command/' + name);
    const d = await r.json();
    if (fb) { fb.style.color = d.ok ? '#00ff88' : '#ff2d78'; fb.textContent = d.ok ? '\u2713 !' + name + ' triggered' : '\u2717 ' + (d.error || 'failed'); }
  } catch { if (fb) { fb.style.color = '#ff2d78'; fb.textContent = '\u2717 Request failed'; } }
  setTimeout(() => { const f = document.getElementById('cmd-fb'); if (f) f.textContent = ''; }, 2000);
}

if (document.getElementById('sstat-follow')) loadSoundsUI();
</script>

</body></html>`;
}

// ── Start ─────────────────────────────────────────────────────────────────────
const server   = http.createServer(app);

// Use noServer + manual routing so multiple WSS instances don't conflict.
// When both share { server }, each WSS fires for every upgrade — the one
// whose path doesn't match calls abortHandshake(), corrupting the already-
// upgraded socket and causing "Invalid frame header" on the client.
const wss        = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const chatWss    = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const spotifyWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);
  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  } else if (pathname === '/chat-ws') {
    chatWss.handleUpgrade(request, socket, head, (ws) => chatWss.emit('connection', ws, request));
  } else if (pathname === '/spotify-ws') {
    spotifyWss.handleUpgrade(request, socket, head, (ws) => spotifyWss.emit('connection', ws, request));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  obsClients.add(ws);
  console.log(`OBS client connected (total: ${obsClients.size})`);
  ws.on('close',  () => { obsClients.delete(ws); console.log(`OBS client disconnected (total: ${obsClients.size})`); });
  ws.on('error',  () => obsClients.delete(ws));
});

chatWss.on('connection', (ws) => {
  chatClients.add(ws);
  // Send current titles immediately so the client is in sync on connect
  ws.send(JSON.stringify({ type: 'titles_update', titles: loadTitles() }));
  ws.on('close', () => chatClients.delete(ws));
  ws.on('error', () => chatClients.delete(ws));
});

spotifyWss.on('connection', (ws) => {
  spotifyClients.add(ws);
  if (currentTrack) ws.send(JSON.stringify(currentTrack));
  ws.send(JSON.stringify({ type: 'set_mode', mode: spotifyMode }));
  ws.on('close', () => spotifyClients.delete(ws));
  ws.on('error', () => spotifyClients.delete(ws));
});

server.listen(cfg.port, async () => {
  console.log(`Twitch Alerts running on port ${cfg.port}`);
  console.log(`  Setup:  ${cfg.hostUrl}/setup`);
  console.log(`  Alerts: ${cfg.hostUrl}/alerts.html`);
  console.log(`  Status: ${cfg.hostUrl}/status`);

  if (!cfg.clientId || !cfg.clientSecret || !cfg.channel) {
    console.warn('WARNING: Missing required env vars (TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_CHANNEL)');
    return;
  }

  if (loadTokens()) {
    await connectEventSub();
    connectChatReader();
  } else {
    console.log('No tokens found — visit /setup to connect Twitch');
    connectChatReader();
  }
});
