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

// ── Token storage ─────────────────────────────────────────────────────────────
const tokensFile = path.join(cfg.dataDir, 'tokens.json');

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

async function connectEventSub(url = 'wss://eventsub.watcher.twitch.tv/ws') {
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
  }

  if (alert) {
    console.log('Alert fired:', alert);
    broadcast(alert);
  }
}

function tierLabel(tier) {
  return { '1000': 'Tier 1', '2000': 'Tier 2', '3000': 'Tier 3' }[tier] ?? 'Tier 1';
}

// ── OBS client WebSocket server ───────────────────────────────────────────────
const obsClients = new Set();

function broadcast(data) {
  const msg = JSON.stringify(data);
  obsClients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

// ── Token auto-refresh every 2 hours ─────────────────────────────────────────
setInterval(async () => {
  if (!loadTokens()) return;
  try { await refreshAccessToken(); }
  catch (err) { console.error('Scheduled token refresh failed:', err.message); }
}, 2 * 60 * 60 * 1000);

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

app.get('/status', (_req, res) => {
  res.json({
    configured:        !!(cfg.clientId && cfg.clientSecret && cfg.channel),
    authenticated:     !!loadTokens(),
    eventsub_connected: eventSubWs?.readyState === WebSocket.OPEN,
    obs_clients:       obsClients.size,
    channel:           cfg.channel,
  });
});

// ── HTML helpers ──────────────────────────────────────────────────────────────
function buildAuthUrl() {
  return 'https://id.twitch.tv/oauth2/authorize?' + new URLSearchParams({
    client_id:     cfg.clientId,
    redirect_uri:  cfg.redirectUri,
    response_type: 'code',
    scope:         'moderator:read:followers channel:read:subscriptions bits:read',
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
<meta charset="UTF-8"><title>Twitch Alerts — Setup</title>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d0015;color:#e0c3ff;font-family:'Share Tech Mono',monospace;padding:40px;min-height:100vh}
  h1{font-family:'Orbitron',sans-serif;color:#bf00ff;font-size:1.8rem;margin-bottom:6px;text-shadow:0 0 20px #bf00ff}
  .sub{color:#7b2fff;letter-spacing:2px;font-size:.8rem;margin-bottom:36px}
  .card{background:#1a0033;border:1px solid #3d0080;border-radius:8px;padding:24px;margin-bottom:20px;max-width:640px;position:relative}
  .card::before{content:'';position:absolute;top:6px;right:6px;width:10px;height:10px;border-top:2px solid #7b2fff;border-right:2px solid #7b2fff}
  h2{font-family:'Orbitron',sans-serif;color:#00f5ff;font-size:.75rem;letter-spacing:3px;text-transform:uppercase;margin-bottom:16px}
  p{color:#c9a0dc;line-height:1.7;margin-bottom:10px}
  .url{background:#080012;border:1px solid #3d0080;border-radius:4px;padding:10px 14px;font-size:.85rem;color:#00f5ff;margin:10px 0;word-break:break-all;user-select:all}
  .btn{display:inline-block;background:linear-gradient(135deg,#7b2fff,#bf00ff);color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-family:'Orbitron',sans-serif;font-size:.75rem;letter-spacing:2px;margin-top:8px;box-shadow:0 0 20px rgba(191,0,255,.3)}
  .btn:hover{opacity:.85}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;vertical-align:middle}
  .green{background:#00ff88;box-shadow:0 0 8px #00ff88}
  .red{background:#ff2d78;box-shadow:0 0 8px #ff2d78}
  a:not(.btn){color:#bf00ff}
  ol{padding-left:20px;color:#c9a0dc;line-height:2}
</style>
</head><body>

<h1>⚡ TWITCH ALERTS</h1>
<div class="sub">SETUP CONSOLE // EMENBLADE</div>

<div class="card">
  <h2>Status</h2>
  <p><span class="dot ${hasTokens ? 'green' : 'red'}"></span>${hasTokens ? 'Twitch connected' : 'Not connected — complete setup below'}</p>
  <p><span class="dot ${cfg.clientId ? 'green' : 'red'}"></span>Client ID ${cfg.clientId ? 'configured' : 'missing (set TWITCH_CLIENT_ID env var)'}</p>
  <p><span class="dot ${cfg.channel ? 'green' : 'red'}"></span>Channel: ${cfg.channel || 'missing (set TWITCH_CHANNEL env var)'}</p>
</div>

${hasTokens ? `
<div class="card">
  <h2>OBS Browser Source</h2>
  <p>Add a <strong>Browser Source</strong> in OBS with this URL:</p>
  <div class="url">${cfg.hostUrl}/alerts.html</div>
  <p>Recommended: <strong>1920 × 300</strong>, enable <strong>transparent background</strong>. Position it at the bottom of your scene.</p>
</div>

<div class="card">
  <h2>Re-authorize / Reconnect</h2>
  <p>Use this if you need to re-connect your Twitch account or changed your channel name.</p>
  <a class="btn" href="${authUrl}">Re-connect Twitch</a>
</div>
` : `
<div class="card">
  <h2>Step 1 — Twitch Developer App</h2>
  <p>Go to <a href="https://dev.twitch.tv/console/apps" target="_blank">dev.twitch.tv/console/apps</a> and open your app (or create one).</p>
  <p>Under <strong>OAuth Redirect URLs</strong>, add exactly this URL:</p>
  <div class="url">${cfg.redirectUri}</div>
  <p>Save the app. Make sure <strong>TWITCH_CLIENT_ID</strong> and <strong>TWITCH_CLIENT_SECRET</strong> in Unraid match your app's credentials.</p>
</div>

<div class="card">
  <h2>Step 2 — Connect Twitch</h2>
  <p>Click below and sign in as <strong>${cfg.channel || 'your channel'}</strong>. This grants the alerts server permission to read channel events.</p>
  <a class="btn" href="${authUrl}">Connect with Twitch</a>
</div>
`}

</body></html>`;
}

// ── Start ─────────────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  obsClients.add(ws);
  console.log(`OBS client connected (total: ${obsClients.size})`);
  ws.on('close',  () => { obsClients.delete(ws); console.log(`OBS client disconnected (total: ${obsClients.size})`); });
  ws.on('error',  () => obsClients.delete(ws));
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
  } else {
    console.log('No tokens found — visit /setup to connect Twitch');
  }
});
