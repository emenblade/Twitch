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
  res.json({ ok: true });
});

app.delete('/titles/:username', (req, res) => {
  const titles = loadTitles();
  delete titles[req.params.username.toLowerCase()];
  saveTitles(titles);
  res.json({ ok: true });
});

app.get('/status', (_req, res) => {
  res.json({
    configured:         !!(cfg.clientId && cfg.clientSecret && cfg.channel),
    authenticated:      !!loadTokens(),
    eventsub_connected: eventSubWs?.readyState === WebSocket.OPEN,
    obs_clients:        obsClients.size,
    channel:            cfg.channel,
    broadcaster_id:     broadcasterId || null,
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
<meta charset="UTF-8"><title>Stream Assets — Setup</title>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d0015;color:#e0c3ff;font-family:'Share Tech Mono',monospace;padding:32px;min-height:100vh}
  h1{font-family:'Orbitron',sans-serif;color:#bf00ff;font-size:1.8rem;margin-bottom:6px;text-shadow:0 0 20px #bf00ff}
  .sub{color:#7b2fff;letter-spacing:2px;font-size:.8rem;margin-bottom:32px}
  .layout{display:flex;gap:24px;align-items:flex-start}
  .col-left{flex:0 0 500px;min-width:0}
  .col-right{flex:1;min-width:280px}
  .card{background:#1a0033;border:1px solid #3d0080;border-radius:8px;padding:24px;margin-bottom:20px;position:relative}
  .card::before{content:'';position:absolute;top:6px;right:6px;width:10px;height:10px;border-top:2px solid #7b2fff;border-right:2px solid #7b2fff}
  h2{font-family:'Orbitron',sans-serif;color:#00f5ff;font-size:.75rem;letter-spacing:3px;text-transform:uppercase;margin-bottom:16px}
  p{color:#c9a0dc;line-height:1.7;margin-bottom:10px}
  .url{background:#080012;border:1px solid #3d0080;border-radius:4px;padding:10px 14px;font-size:.85rem;color:#00f5ff;margin:10px 0;word-break:break-all;user-select:all}
  .btn{display:inline-block;background:linear-gradient(135deg,#7b2fff,#bf00ff);color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-family:'Orbitron',sans-serif;font-size:.75rem;letter-spacing:2px;margin-top:8px;box-shadow:0 0 20px rgba(191,0,255,.3);cursor:pointer;border:none}
  .btn:hover{opacity:.85}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;vertical-align:middle}
  .green{background:#00ff88;box-shadow:0 0 8px #00ff88}
  .red{background:#ff2d78;box-shadow:0 0 8px #ff2d78}
  a:not(.btn){color:#bf00ff}
  ol{padding-left:20px;color:#c9a0dc;line-height:2}
  .test-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:4px}
  .tbtn{font-family:'Share Tech Mono',monospace;font-size:.75rem;letter-spacing:1px;padding:9px 6px;border-radius:4px;border:1px solid var(--c);background:transparent;color:var(--c);cursor:pointer;text-transform:uppercase;transition:background .15s,box-shadow .15s}
  .tbtn:hover{background:color-mix(in srgb,var(--c) 15%,transparent);box-shadow:0 0 10px -3px var(--c)}
  .tbtn:active{opacity:.6}
  .tbtn.follow{--c:#00f5ff}.tbtn.sub{--c:#bf00ff}.tbtn.resub{--c:#9d00ff}
  .tbtn.giftsub{--c:#ff2d78}.tbtn.bits{--c:#ffd700}.tbtn.raid{--c:#ff6b35}
  #test-fb{margin-top:12px;font-size:.78rem;color:#00ff88;min-height:1.2em;letter-spacing:1px}
  .chat-frame{width:100%;height:400px;border:1px solid #3d0080;border-radius:4px;background:#080012;display:block}
  .t-form{display:grid;grid-template-columns:1fr 1fr auto auto;gap:8px;align-items:center;margin-top:4px}
  .t-input{background:#080012;border:1px solid #3d0080;border-radius:4px;padding:7px 10px;color:#e0c3ff;font-family:'Share Tech Mono',monospace;font-size:.8rem;width:100%}
  .t-input:focus{outline:none;border-color:#7b2fff}
  .t-color{width:36px;height:32px;border:1px solid #3d0080;border-radius:4px;background:#080012;cursor:pointer;padding:2px}
  table{width:100%;border-collapse:collapse;margin-top:10px}
  td{vertical-align:middle}
</style>
</head><body>

<h1>⚡ STREAM ASSETS</h1>
<div class="sub">SETUP CONSOLE // EMENBLADE</div>

<div class="layout">
<div class="col-left">

<div class="card">
  <h2>Status</h2>
  <p><span class="dot ${hasTokens ? 'green' : 'red'}"></span>${hasTokens ? 'Twitch connected' : 'Not connected — complete setup below'}</p>
  <p><span class="dot ${cfg.clientId ? 'green' : 'red'}"></span>Client ID ${cfg.clientId ? 'configured' : 'missing (set TWITCH_CLIENT_ID env var)'}</p>
  <p><span class="dot ${cfg.channel ? 'green' : 'red'}"></span>Channel: ${cfg.channel || 'missing (set TWITCH_CHANNEL env var)'}</p>
</div>

${hasTokens ? `
<div class="card">
  <h2>OBS Browser Sources</h2>
  <p>Alerts overlay — <strong>1920 × 300</strong>, transparent background, bottom of scene:</p>
  <div class="url">${cfg.hostUrl}/alerts.html</div>
  <p style="margin-top:14px">Chat overlay — <strong>380 × 700</strong>, transparent background, right side:</p>
  <div class="url">${cfg.hostUrl}/chat.html</div>
</div>

<div class="card">
  <h2>Test Alerts</h2>
  <p>Fire a test alert to your OBS Browser Source. Make sure it's open first.</p>
  <div class="test-grid">
    <button class="tbtn follow" onclick="test('follow')">Follow</button>
    <button class="tbtn sub"    onclick="test('sub')">Sub</button>
    <button class="tbtn resub"  onclick="test('resub')">Resub</button>
    <button class="tbtn giftsub" onclick="test('giftsub')">Gift Sub</button>
    <button class="tbtn bits"   onclick="test('bits')">Bits</button>
    <button class="tbtn raid"   onclick="test('raid')">Raid</button>
  </div>
  <div id="test-fb"></div>
</div>

<div class="card">
  <h2>Re-authorize</h2>
  <p>Use this if you need to re-connect your Twitch account.</p>
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

</div><!-- col-left -->
<div class="col-right">
  <div class="card" style="padding:16px">
    <h2>Chat Preview</h2>
    <iframe id="chat-preview" src="/chat.html" class="chat-frame" frameborder="0"></iframe>
  </div>

  <div class="card">
    <h2>Custom User Titles</h2>
    <p>Give specific chatters a named badge next to their name.</p>
    <form class="t-form" onsubmit="addTitle(event)">
      <input id="t-user"  class="t-input" placeholder="username" autocomplete="off" spellcheck="false">
      <input id="t-label" class="t-input" placeholder="title" autocomplete="off" spellcheck="false">
      <input id="t-color" class="t-color" type="color" value="#bf00ff" title="Badge color">
      <button type="submit" class="btn" style="padding:7px 14px;margin:0;font-size:.7rem">Add</button>
    </form>
    <table><tbody id="titles-tbody"></tbody></table>
  </div>
</div><!-- col-right -->
</div><!-- layout -->

<script>
async function test(type) {
  const fb = document.getElementById('test-fb');
  fb.textContent = 'Sending ' + type + '...';
  try {
    const r = await fetch('/test/' + type);
    const d = await r.json();
    fb.textContent = d.ok ? '✓ ' + type + ' alert sent' : '✗ ' + (d.error || 'error');
  } catch(e) {
    fb.textContent = '✗ Request failed';
  }
  setTimeout(() => fb.textContent = '', 3000);
}

// ── Custom titles ──────────────────────────────────────────────────
async function loadTitlesUI() {
  const titles = await fetch('/titles').then(r => r.json()).catch(() => ({}));
  const tbody = document.getElementById('titles-tbody');
  tbody.innerHTML = '';
  const entries = Object.entries(titles);
  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="3" style="color:#7b2fff;opacity:.5;padding:10px 0;font-size:.8rem">No custom titles yet.</td></tr>';
    return;
  }
  for (const [username, {label, color}] of entries) {
    const tr = document.createElement('tr');
    tr.innerHTML = \`<td style="padding:5px 8px 5px 0;color:#e0c3ff">\${username}</td>
      <td style="padding:5px 8px"><span style="color:\${color};border:1px solid \${color};padding:1px 6px;border-radius:2px;font-size:10px">\${label}</span></td>
      <td style="padding:5px 0;text-align:right"><button onclick="removeTitle('\${username}')" style="background:transparent;border:1px solid #ff2d78;color:#ff2d78;border-radius:3px;padding:2px 8px;cursor:pointer;font-family:inherit;font-size:.7rem">Remove</button></td>\`;
    tbody.appendChild(tr);
  }
}

function reloadChatPreview() {
  const f = document.getElementById('chat-preview');
  f.src = f.src;
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
  reloadChatPreview();
}

async function removeTitle(username) {
  await fetch('/titles/' + encodeURIComponent(username), { method:'DELETE' });
  loadTitlesUI();
  reloadChatPreview();
}

loadTitlesUI();
</script>

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
