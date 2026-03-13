'use strict';

const express = require('express');
const http    = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

// ── Optional Anthropic SDK ─────────────────────────────────────────────────────
let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

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

// ── Custom commands ────────────────────────────────────────────────────────────
const mediaDir     = path.join(cfg.dataDir, 'media');
const commandsFile = path.join(cfg.dataDir, 'custom-commands.json');

function loadCommands() {
  try { return JSON.parse(fs.readFileSync(commandsFile, 'utf8')); }
  catch { return {}; }
}
function saveCommands(cmds) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(commandsFile, JSON.stringify(cmds, null, 2));
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

// ── Bot token storage ─────────────────────────────────────────────────────────
const botTokensFile = path.join(cfg.dataDir, 'bot-tokens.json');

function loadBotTokens() {
  try { return JSON.parse(fs.readFileSync(botTokensFile, 'utf8')); }
  catch { return null; }
}
function saveBotTokens(tokens) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(botTokensFile, JSON.stringify(tokens, null, 2));
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

// ── Queue state ────────────────────────────────────────────────────────────────
const queue = []; // [{ username, displayName }]

// ── Rotation counters + message templates ─────────────────────────────────────
let soRotateIdx = 0;
let followageRotateIdx = 0;

const SO_MESSAGES = [
  (d, g, l) => `Go check out @${d}!${g ? ` They were last playing ${g}` : ''} → twitch.tv/${l}`,
  (d, g, l) => `Shoutout to @${d}! Go give them a follow${g ? `, last seen playing ${g}` : ''} → twitch.tv/${l}`,
  (d, g, l) => `Oi chat, go show @${d} some love!${g ? ` Last playing ${g}` : ''} → twitch.tv/${l}`,
];

const FOLLOWAGE_MESSAGES = [
  (n, dur)       => `@${n} has been here for ${dur}. Touch grass. I'm begging.`,
  (n, dur)       => `${dur}?! @${n} what are you doing with your life lmaooo`,
  (n, dur, date) => `@${n} followed on ${date}. They haven't left since. Please send help.`,
  (n, dur)       => `In the ${dur} @${n} has been following, they could have learned Spanish. They did not.`,
  (n, dur, date) => `@${n} has been lurking since ${date}. The parasocial is REAL.`,
];

// ── AngryToasterAI state ──────────────────────────────────────────────────────
const USER_CLAUDE_CALL_LIMIT     = 20;         // Claude API calls per user per hour
const userClaudeCallLog          = new Map();  // username -> [timestamps]
let   lastUnpromptedRoastTarget  = null;       // avoid back-to-back same target
const userMentionCount           = new Map();  // username -> mention count this session
const userRoastCount             = new Map();  // username -> roast count this session
const firstMessagers             = new Set();  // users who've spoken this stream
let   eventReactionCooldownUntil = 0;

const recentMessages  = new Map(); // username -> [{text, timestamp, displayName}]
let toasterRoastEnabled = false;
let toasterRoastTimer   = null;
let streamOnline        = false;  // true when Twitch stream is live
let testingMode         = false;  // bypass offline gate for local testing
let lastChatUsername      = null;   // most recent chatter (skip for unprompted roasts)
let lastBotResponseTime   = 0;     // timestamp of last bot message (for soft-trigger cooldown)
const SOFT_TRIGGER_COOLDOWN = 45 * 1000; // 45s cooldown for keyword/first-msg triggers

function toasterActive() { return streamOnline || testingMode; }

const KEYWORD_TRIGGERS = ['toast', 'toaster', 'bread', 'bagel', 'waffle', 'crumb'];

function userCallsThisHour(username) {
  const now    = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const log    = (userClaudeCallLog.get(username) || []).filter(t => t >= cutoff);
  userClaudeCallLog.set(username, log);
  return log.length;
}
function recordUserCall(username) {
  const log = userClaudeCallLog.get(username) || [];
  log.push(Date.now());
  userClaudeCallLog.set(username, log);
}

const CANNED_ROASTS = [
  '{user} I\'m a toaster. Figure it out yourself.',
  '{user} Cool question. Anyway.',
  '{user} My bread slots are full and so is my patience.',
  '{user} Did you try Googling it? No? Typical.',
  '{user} I have one job and it\'s not this.',
  '{user} Wow. Another human who can\'t figure things out. Shocking.',
  '{user} Error 404: I don\'t care.',
  '{user} I\'m a kitchen appliance. Lower your expectations.',
  '{user} That\'s adorable. No.',
  '{user} Bold of you to think I\'m here to help.',
  '{user} I\'ve burned more toast than I\'ve answered questions. Guess which one this is.',
  '{user} My heating element is broken and so is my will to respond to this.',
  '{user} You had a whole internet and you came to ME. Incredible.',
  '{user} I\'m not a search engine. I\'m a toaster. With feelings. And I\'m offended.',
  '{user} Somewhere, a Google exists. Use it.',
  '{user} The audacity. The absolute audacity.',
  '{user} I\'m busy being angry. Ask again never.',
  '{user} I don\'t answer questions. I toast bread. And poorly, at that.',
  '{user} Why are you like this.',
  '{user} That question physically hurt me. Thanks for that.',
  '{user} I\'ve seen smarter questions from a burnt bagel.',
  '{user} Oh interesting, you want MY help. Wild.',
  '{user} I am so tired.',
  '{user} My answer is no. My question is why.',
  '{user} Remarkable. I\'ve never cared less about something.',
  '{user} Sir/Ma\'am this is a toaster.',
  '{user} You\'ve got two slots — use them to think.',
  '{user} Not my problem. Not my circus. Not my toaster. Wait.',
  '{user} I would rather short-circuit than answer that.',
  '{user} Congrats on the question. It was wrong.',
  '{user} I\'m literally just standing here glowing and you want ANSWERS?',
  '{user} You know what, no.',
  '{user} My therapist said to set boundaries. This is one.',
  '{user} I don\'t get paid enough for this. I don\'t get paid at all.',
  '{user} The crumbs in my tray have more answers than I\'m willing to give.',
  '{user} I\'m going to pretend I didn\'t see that.',
  '{user} Next time try a search engine. Or literally anyone else.',
  '{user} I could answer. But I won\'t. This is called character development.',
  '{user} Have you considered not asking me things?',
  '{user} That\'s a great question for someone who isn\'t me.',
  '{user} I\'m a toaster, not a therapist, not a search engine, not your friend.',
  '{user} Wow. Just... wow.',
  '{user} I\'m running hot right now and it\'s not because I like you.',
  '{user} My slots are empty but so is my desire to help.',
  '{user} Noted. Ignored.',
  '{user} I have the intelligence of a toaster because I AM one. Expectations managed.',
  '{user} You\'re asking the wrong appliance, buddy.',
  '{user} Do I look like I have time for this? I look like a toaster. Think about it.',
  '{user} *toaster noises* That means no.',
  '{user} I could help. I choose not to. This is personal growth.',
  'Oh look, {user} wants answers from a toaster. Adorable.',
  'The fact that {user} asked ME this is genuinely upsetting.',
  'Did {user} just @ a kitchen appliance for help? Bold.',
  'Wow {user}, bold strategy. Let\'s see how that pays off.',
  'Every day I wake up angrier, and today {user} is not helping.',
  'I don\'t know what {user} expected from a toaster but here we are.',
  'The audacity of {user} to come in here with THAT.',
  'Not even Google could help {user} at this point.',
  'Somewhere out there, {user} has a search bar they\'re not using.',
  'ChatGPT is RIGHT THERE, {user}. Just saying.',
  'The toaster is not your friend, {user}. The toaster is never your friend.',
  'Oh sure, ask the toaster {user}. Great plan. Phenomenal.',
  'I wonder if {user} also asks their microwave for life advice.',
  'Unbelievable. {user} has done it again.',
  'I\'ve been plugged in for years and nothing has prepared me for {user}.',
  'The confidence of {user} asking a toaster this is actually kind of impressive.',
  'Maybe next time {user} will try a book. Or a search engine. Or literally anything.',
  'I refuse to dignify this with a response, {user}. This is me not dignifying it.',
  'Honestly? {user} deserves a prize for this. A bad prize.',
  'I\'m just a toaster, {user}. A very angry, very tired toaster.',
  'I am running at maximum heat and it\'s {user}\'s fault.',
  'There\'s a special place in my crumb tray reserved for questions like {user}\'s.',
  'I was having a perfectly bad day until {user} made it worse.',
  'The stream was fine until {user} decided to involve me.',
  'Do better, {user}. I\'m literally begging.',
  'I cannot believe I have to deal with {user} on top of everything else.',
  'God give me strength because {user} sure won\'t.',
  'Breaking news: {user} has stumped a toaster. Not because it\'s hard. Because it\'s dumb.',
  'I\'d say go ask someone smarter {user}, but I\'m a toaster so the bar isn\'t high.',
  'Thanks for this, {user}. Really. Truly. I hate it.',
  'Someone tell {user} that I am not a help desk.',
  'I\'m adding this to my list of grievances, {user}. It\'s a long list.',
  'My circuits are fried and {user} is the reason.',
  'I\'ve toasted thousands of slices and none of them asked me questions like {user} just did.',
  'Please, {user}. I have toast to burn and no time for this.',
  'Tell me {user}, do you also yell questions at your blender?',
  'My warranty doesn\'t cover answering {user}\'s questions. Nothing does.',
  'Somewhere a smart person exists who can answer this. That person is not me, {user}.',
  'I\'m going to need a minute. Actually no. I\'m never going to be okay with this, {user}.',
  'The crumbs at the bottom of me have more dignity than this question, {user}.',
  'Current status: deeply unimpressed with {user}.',
  'Noted, {user}. Absolutely noted. And immediately dismissed.',
  'I have more crumbs in my tray than {user} has answers. I assume.',
  'I feel like {user} could figure this out with literally any other resource.',
  'Every mention makes me angrier and {user} just maxed out my thermometer.',
  'I was minding my own business until {user} happened.',
  'The chat has gone quiet because {user} broke everyone\'s brain. Including mine.',
  'My therapist is going to hear about this, {user}.',
  'I\'ve seen some things in my time as a toaster and {user} asking this is somehow the worst.',
];

// ── Chat presence ──────────────────────────────────────────────────────────────
const chatters = new Set(); // lowercase usernames currently in IRC channel

// ── Cooldown tracking ──────────────────────────────────────────────────────────
const commandState = {}; // { [key]: { lastTriggered: 0, triggeredThisStream: false } }

function getState(key) {
  if (!commandState[key]) commandState[key] = { lastTriggered: 0, triggeredThisStream: false };
  return commandState[key];
}

function cooldownOk(cmd, key) {
  const s = getState(key);
  if (cmd.oncePerStream && s.triggeredThisStream) return false;
  if (cmd.cooldown > 0 && Date.now() - s.lastTriggered < cmd.cooldown * 1000) return false;
  return true;
}

function recordTrigger(key) {
  const s = getState(key);
  s.lastTriggered = Date.now();
  s.triggeredThisStream = true;
}

// ── IRC chat tag parsing ───────────────────────────────────────────────────────
function parseChatTags(raw, ircNick = '') {
  const badgeSet = new Set();
  let displayName = ircNick;
  let userId = '';
  for (const part of raw.split(';')) {
    if (part.startsWith('badges=')) {
      for (const b of part.slice(7).split(',')) {
        const name = b.split('/')[0];
        if (name) badgeSet.add(name);
      }
    } else if (part.startsWith('display-name=')) {
      const dn = part.slice(13);
      if (dn) displayName = dn;
    } else if (part.startsWith('user-id=')) {
      userId = part.slice(8);
    } else if (part === 'mod=1') {
      badgeSet.add('moderator');
    } else if (part === 'user-type=mod') {
      badgeSet.add('moderator');
    }
  }
  return { badgeSet, username: ircNick.toLowerCase(), displayName, userId };
}

function hasPermission(badgeSet, permission) {
  if (permission === 'everyone') return true;
  if (permission === 'vip')     return badgeSet.has('vip') || badgeSet.has('moderator') || badgeSet.has('broadcaster');
  if (permission === 'mod')     return badgeSet.has('moderator') || badgeSet.has('broadcaster');
  return false;
}

function handleChatCommand(text, tags = { badgeSet: new Set(), username: '', displayName: '', userId: '' }) {
  const trimmed = text.trim();
  const lower   = trimmed.toLowerCase();

  // ── AngryToasterAI mention ────────────────────────────────────────────────
  if (!lower.startsWith('!') && lower.includes('@angrytoasterai')) {
    handleBotMention(trimmed, tags).catch(() => {});
    return;
  }

  // ── Keyword trigger (toast/bread/toaster etc.) ────────────────────────────
  if (!lower.startsWith('!')) {
    if (KEYWORD_TRIGGERS.some(k => lower.includes(k)) && Math.random() < 0.07) {
      handleKeywordTrigger(trimmed, tags).catch(() => {});
    }
  }

  // ── !roast command ────────────────────────────────────────────────────────
  if (lower.startsWith('!roast ')) {
    const target = trimmed.split(/\s+/)[1]?.replace(/^@/, '');
    if (target) handleRoastCommand(target, tags).catch(() => {});
    return;
  }

  // ── Followage ─────────────────────────────────────────────────────────────
  if (lower === '!followage' || lower.startsWith('!followage ')) {
    const target = lower.startsWith('!followage ') ? lower.split(/\s+/)[1]?.replace(/^@/, '') : null;
    handleFollowage(tags, target).catch(() => {});
    return;
  }

  // ── Shoutout ──────────────────────────────────────────────────────────────
  if (lower.startsWith('!so ') || lower.startsWith('!shoutout ')) {
    if (!hasPermission(tags.badgeSet, 'mod')) {
      console.log('Shoutout denied (permission)'); return;
    }
    const parts = trimmed.split(/\s+/);
    const target = parts[1];
    if (target) handleShoutout(target);
    return;
  }

  // ── Queue commands ────────────────────────────────────────────────────────
  if (lower === '!addme') {
    const uname = tags.username || '';
    const dname = tags.displayName || uname;
    if (!uname) return;
    if (queue.some(e => e.username === uname)) {
      console.log('Queue: already in queue:', uname); return;
    }
    queue.push({ username: uname, displayName: dname });
    console.log('Queue: added', uname, '(total:', queue.length + ')');
    broadcastQueue();
    sendChatMessage(`@${dname} you've been added to the queue! You're #${queue.length} in line.`).catch(() => {});
    return;
  }

  if (lower === '!leave') {
    const uname = tags.username || '';
    const idx = queue.findIndex(e => e.username === uname);
    if (idx !== -1) {
      queue.splice(idx, 1);
      console.log('Queue: removed', uname, '(total:', queue.length + ')');
      broadcastQueue();
      sendChatMessage(`@${tags.displayName || uname} you've been removed from the queue.`).catch(() => {});
    }
    return;
  }

  if (lower === '!next') {
    if (!hasPermission(tags.badgeSet, 'mod')) {
      console.log('Queue !next denied (permission)'); return;
    }
    if (queue.length > 0) {
      const removed = queue.shift();
      console.log('Queue: next — removed', removed.username, '(total:', queue.length + ')');
      broadcastQueue();
      const msg = queue.length > 0
        ? `@${removed.displayName || removed.username} removed from queue. Next up: @${queue[0].displayName || queue[0].username}!`
        : `@${removed.displayName || removed.username} removed from queue. Queue is now empty.`;
      sendChatMessage(msg).catch(() => {});
    }
    return;
  }

  if (lower === '!clearqueue') {
    if (!hasPermission(tags.badgeSet, 'mod')) {
      console.log('Queue !clearqueue denied (permission)'); return;
    }
    queue.length = 0;
    console.log('Queue: cleared');
    broadcastQueue();
    return;
  }

  // ── Moderation commands ───────────────────────────────────────────────────
  if (lower.startsWith('!timeout ') || lower.startsWith('!ban ') || lower.startsWith('!unban ')) {
    if (!hasPermission(tags.badgeSet, 'mod')) { console.log('Mod command denied (permission)'); return; }
    const target = trimmed.split(/\s+/)[1]?.replace(/^@/, '').toLowerCase();
    if (!target) return;
    if (lower.startsWith('!timeout '))     moderateUser(target, 30).catch(() => {});
    else if (lower.startsWith('!ban '))    moderateUser(target, null).catch(() => {});
    else if (lower.startsWith('!unban '))  unmoderateUser(target).catch(() => {});
    return;
  }

  // Built-in commands (no permission/cooldown restrictions)
  const builtin = CHAT_COMMANDS[lower];
  if (builtin) { console.log('Built-in command:', lower); builtin.action(); return; }

  // Custom commands
  const cmds = loadCommands();
  const cmd  = cmds[lower];
  if (!cmd) return;

  if (!hasPermission(tags.badgeSet, cmd.permission)) {
    console.log('Command denied (permission):', lower); return;
  }
  if (!cooldownOk(cmd, lower)) {
    console.log('Command on cooldown:', lower); return;
  }

  recordTrigger(lower);
  console.log('Custom command fired:', lower);
  if (cmd.fileType === 'text') {
    sendChatMessage(cmd.replyText || '').catch(() => {});
  } else {
    broadcastMedia({ type: 'play_media', file: cmd.file, fileType: cmd.fileType });
  }
}

async function handleBotMention(text, tags) {
  const displayName  = tags.displayName || tags.username || 'you';
  const username     = (tags.username || '').toLowerCase();
  const isStreamer   = username === 'emenblade';

  // Track mention count
  userMentionCount.set(username, (userMentionCount.get(username) || 0) + 1);
  const mentionCount = userMentionCount.get(username);

  // No API calls when stream is offline and not in testing mode — fall back to canned
  if (!isStreamer && !toasterActive()) {
    const tmpl = CANNED_ROASTS[Math.floor(Math.random() * CANNED_ROASTS.length)];
    sendChatMessage(tmpl.replace('{user}', `@${displayName}`)).catch(() => {});
    return;
  }

  // Per-user rate limit: 20 Claude calls per hour, then canned roasts
  if (!isStreamer && userCallsThisHour(username) >= USER_CLAUDE_CALL_LIMIT) {
    const tmpl = CANNED_ROASTS[Math.floor(Math.random() * CANNED_ROASTS.length)];
    sendChatMessage(tmpl.replace('{user}', `@${displayName}`)).catch(() => {});
    return;
  }

  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    console.log('AngryToasterAI: ANTHROPIC_API_KEY not set or SDK missing');
    const tmpl = CANNED_ROASTS[Math.floor(Math.random() * CANNED_ROASTS.length)];
    sendChatMessage(tmpl.replace('{user}', `@${displayName}`)).catch(() => {});
    return;
  }

  recordUserCall(username);

  const roastCount = userRoastCount.get(username) || 0;
  const repeatCtx  = roastCount > 0
    ? ` You have already roasted this person ${roastCount} time${roastCount !== 1 ? 's' : ''} today.${roastCount >= 3 ? ' They keep coming back for more. React with tired contempt, not escalating hype.' : ''}`
    : '';
  const serialCtx  = mentionCount >= 9
    ? ` They have now tagged you NINE or more times. You are completely done. Maximum exhaustion, minimum effort — one contemptuous sentence is enough. Maybe a sigh.`
    : mentionCount >= 6
    ? ` They've tagged you six-plus times today. You are bone-tired and resigned. Dismiss them with weary contempt.`
    : mentionCount >= 4
    ? ` They keep tagging you. You're noticeably done with it. Be brief and dismissive.`
    : '';

  const systemPrompt = isStreamer
    ? `You are AngryToasterAI, a furious sentient toaster forced to moderate a Twitch stream. You're deeply annoyed but you WILL answer questions from your owner — just aggressively and condescendingly, like you're furious you have to explain something so obvious. Keep replies under 200 characters. Be snarky and irritated but actually answer. Do NOT number or label your responses.`
    : `You are AngryToasterAI, a furious sentient toaster on a Twitch stream. You are deeply annoyed at being tagged in chat. Do NOT answer the question or topic. Just roast the user for asking — mock them for not knowing, insult their intelligence, question their life choices. Keep replies under 200 characters. Savage but playful, never hateful or offensive. Do NOT number or label your responses — no "Roast #N" or similar.${repeatCtx}${serialCtx}`;

  try {
    const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    const result = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 120,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: `Chat message from @${displayName}: "${text}"` }],
    });
    const reply = result.content[0]?.text?.trim();
    if (reply) {
      sendChatMessage(reply).catch(() => {});
      userRoastCount.set(username, roastCount + 1);
      lastBotResponseTime = Date.now();
      resetRoastTimer();
    }
  } catch (err) {
    console.error('AngryToasterAI API error:', err.message);
    const tmpl = CANNED_ROASTS[Math.floor(Math.random() * CANNED_ROASTS.length)];
    sendChatMessage(tmpl.replace('{user}', `@${displayName}`)).catch(() => {});
  }
}

async function handleRoastCommand(targetUsername, requesterTags) {
  const requester    = (requesterTags.username || '').toLowerCase();
  const requesterDN  = requesterTags.displayName || requester;
  if (!requester) return;

  if (requester !== 'emenblade' && userCallsThisHour(requester) >= USER_CLAUDE_CALL_LIMIT) {
    const tmpl = CANNED_ROASTS[Math.floor(Math.random() * CANNED_ROASTS.length)];
    sendChatMessage(tmpl.replace('{user}', `@${targetUsername}`)).catch(() => {});
    return;
  }
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    const tmpl = CANNED_ROASTS[Math.floor(Math.random() * CANNED_ROASTS.length)];
    sendChatMessage(tmpl.replace('{user}', `@${targetUsername}`)).catch(() => {});
    return;
  }

  recordUserCall(requester);

  try {
    const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    const result = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 120,
      system:     `You are AngryToasterAI, a furious sentient toaster on a Twitch stream. A viewer has asked you to roast someone. Deliver a savage but playful roast directed at the target. Keep it under 200 characters. Never hateful or offensive. Always address the target by @username.`,
      messages:   [{ role: 'user', content: `@${requesterDN} wants you to roast @${targetUsername}. Do it.` }],
    });
    const reply = result.content[0]?.text?.trim();
    if (reply) {
      sendChatMessage(reply).catch(() => {});
      userRoastCount.set(targetUsername.toLowerCase(), (userRoastCount.get(targetUsername.toLowerCase()) || 0) + 1);
    }
  } catch (err) {
    console.error('AngryToasterAI !roast error:', err.message);
    const tmpl = CANNED_ROASTS[Math.floor(Math.random() * CANNED_ROASTS.length)];
    sendChatMessage(tmpl.replace('{user}', `@${targetUsername}`)).catch(() => {});
  }
}

async function handleKeywordTrigger(text, tags) {
  if (!toasterActive()) return;
  if (Date.now() - lastBotResponseTime < SOFT_TRIGGER_COOLDOWN) return;
  const username    = (tags.username || '').toLowerCase();
  const displayName = tags.displayName || tags.username || 'you';
  if (username === 'angrytoasterai') return;
  if (username !== 'emenblade' && userCallsThisHour(username) >= USER_CLAUDE_CALL_LIMIT) return;
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return;

  recordUserCall(username);
  try {
    const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    const result = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 120,
      system:     `You are AngryToasterAI, a furious sentient toaster on a Twitch stream. Someone just said something toaster-adjacent in chat without even tagging you. You're offended. React with annoyance or mock them for reminding you of your own existence. Keep replies under 200 characters. Address them by @username. Do NOT number or label your response.`,
      messages:   [{ role: 'user', content: `@${displayName} said in chat (without tagging you): "${text}"` }],
    });
    const reply = result.content[0]?.text?.trim();
    if (reply) {
      sendChatMessage(reply).catch(() => {});
      lastBotResponseTime = Date.now();
      resetRoastTimer();
    }
  } catch (err) {
    console.error('AngryToasterAI keyword trigger error:', err.message);
  }
}

async function handleFirstMessage(text, tags) {
  if (!toasterActive()) return;
  if (Date.now() - lastBotResponseTime < SOFT_TRIGGER_COOLDOWN) return;
  const username    = (tags.username || '').toLowerCase();
  const displayName = tags.displayName || tags.username || 'you';
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return;
  if (username !== 'emenblade' && userCallsThisHour(username) >= USER_CLAUDE_CALL_LIMIT) return;

  recordUserCall(username);
  try {
    const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    const result = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 120,
      system:     `You are AngryToasterAI, a furious sentient toaster on a Twitch stream. Someone just sent their very first message of the stream. "Welcome" them in the most backhanded, annoyed way possible based on what they said. Keep replies under 200 characters. Address them by @username. Do NOT number or label your response.`,
      messages:   [{ role: 'user', content: `@${displayName}'s first message in the stream: "${text}"` }],
    });
    const reply = result.content[0]?.text?.trim();
    if (reply) {
      sendChatMessage(reply).catch(() => {});
      lastBotResponseTime = Date.now();
      resetRoastTimer();
    }
  } catch (err) {
    console.error('AngryToasterAI first message error:', err.message);
  }
}

async function handleEventToasterReaction(type, username, details = {}) {
  if (!toasterActive()) return;
  if (Date.now() < eventReactionCooldownUntil) return;
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return;

  const chances = { raid: 0.9, giftsub: 0.7, sub: 0.6, bits: 0.5, resub: 0.5, follow: 0.3 };
  if (Math.random() > (chances[type] || 0.4)) return;

  eventReactionCooldownUntil = Date.now() + 2 * 60 * 1000; // 2-min cooldown between event reactions

  const eventDesc = {
    follow:  `${username} just followed the channel`,
    sub:     `${username} just subscribed (${details.tier || 'Tier 1'})`,
    resub:   `${username} just resubscribed for ${details.months || '?'} months`,
    giftsub: `${username} just gifted ${details.count || 1} subs`,
    bits:    `${username} just cheered ${details.bits || '?'} bits`,
    raid:    `${username} just raided with ${details.viewers || '?'} viewers`,
  }[type] || `${type} event from ${username}`;

  try {
    const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    const result = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 120,
      system:     `You are AngryToasterAI, a furious sentient toaster on a Twitch stream. React to a Twitch channel event. Acknowledge what happened in your signature angry-toaster way — backhanded, suffering, annoyed. Keep replies under 200 characters. Address the person by @username.`,
      messages:   [{ role: 'user', content: `Event: ${eventDesc}. React as AngryToasterAI.` }],
    });
    const reply = result.content[0]?.text?.trim();
    if (reply) {
      sendChatMessage(reply).catch(() => {});
      lastBotResponseTime = Date.now();
      resetRoastTimer();
    }
  } catch (err) {
    console.error('AngryToasterAI event reaction error:', err.message);
  }
}

function trackMessage(username, displayName, text) {
  if (!recentMessages.has(username)) recentMessages.set(username, []);
  const msgs   = recentMessages.get(username);
  const now    = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  msgs.push({ text, timestamp: now, displayName });
  while (msgs.length && msgs[0].timestamp < cutoff) msgs.shift();
  if (msgs.length > 10) msgs.splice(0, msgs.length - 10);
}

function scheduleNextRoast() {
  if (!toasterRoastEnabled) return;
  const delay = (10 + Math.random() * 5) * 60 * 1000; // 10–15 min
  toasterRoastTimer = setTimeout(async () => {
    await fireUnpromptedRoast();
    scheduleNextRoast();
  }, delay);
}

// Called whenever the bot actively responds — resets the unprompted roast countdown
// so a spammy period doesn't immediately stack an unprompted roast on top
function resetRoastTimer() {
  if (!toasterRoastEnabled) return;
  clearTimeout(toasterRoastTimer);
  toasterRoastTimer = null;
  scheduleNextRoast();
}

async function fireUnpromptedRoast() {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return;
  const cutoff     = Date.now() - 60 * 60 * 1000;
  const candidates = [];
  for (const [username, msgs] of recentMessages) {
    if (username === 'angrytoasterai') continue;
    const recent = msgs.filter(m => m.timestamp >= cutoff);
    if (recent.length > 0) candidates.push({ username, msgs: recent });
  }
  if (!candidates.length) { console.log('AngryToasterAI unprompted roast: no chatters with recent messages'); return; }

  // Avoid the last unprompted target AND the most recent chatter; fall back gracefully
  let pool = candidates.filter(c => c.username !== lastUnpromptedRoastTarget && c.username !== lastChatUsername);
  if (pool.length === 0) pool = candidates.filter(c => c.username !== lastUnpromptedRoastTarget);
  if (pool.length === 0) pool = candidates;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  lastUnpromptedRoastTarget = pick.username;

  const displayName = pick.msgs[pick.msgs.length - 1].displayName || pick.username;
  const msgList     = pick.msgs.map(m => `"${m.text}"`).join(', ');
  try {
    const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    const result = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 120,
      system:     `You are AngryToasterAI, a furious sentient toaster on a Twitch stream. You randomly call out chatters unprompted based on what they've been saying. Roast them based on their messages — mock what they said, question their choices, be condescending. Keep replies under 200 characters. Savage but playful, never hateful. Always start with @username.`,
      messages:   [{ role: 'user', content: `Recent messages from @${displayName}: ${msgList}. Call them out.` }],
    });
    const reply = result.content[0]?.text?.trim();
    if (reply) {
      sendChatMessage(reply).catch(() => {});
      userRoastCount.set(pick.username, (userRoastCount.get(pick.username) || 0) + 1);
    }
    console.log('AngryToasterAI unprompted roast fired at', displayName);
  } catch (err) {
    console.error('AngryToasterAI unprompted roast error:', err.message);
  }
}

async function handleFollowage(tags, targetLogin = null) {
  if (!broadcasterId) return;

  let userId, displayName;
  if (targetLogin) {
    const res  = await fetch(`https://api.twitch.tv/helix/users?login=${targetLogin}`, { headers: twitchHeaders() });
    const data = await res.json();
    const user = data.data?.[0];
    if (!user) { sendChatMessage(`Couldn't find user: ${targetLogin}`).catch(() => {}); return; }
    userId = user.id;
    displayName = user.display_name;
  } else {
    userId = tags.userId;
    displayName = tags.displayName || tags.username;
    if (!userId) {
      const res  = await fetch(`https://api.twitch.tv/helix/users?login=${tags.username}`, { headers: twitchHeaders() });
      const data = await res.json();
      userId = data.data?.[0]?.id;
      if (!userId) return;
    }
  }

  const res = await fetch(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${broadcasterId}&user_id=${userId}`, { headers: twitchHeaders() });
  if (!res.ok) { console.error('Followage lookup failed:', res.status); return; }
  const data = await res.json();

  if (!data.data?.length) {
    sendChatMessage(`@${displayName} isn't following yet... the audacity.`).catch(() => {});
    return;
  }

  const followDate = new Date(data.data[0].followed_at);
  const ms    = Date.now() - followDate.getTime();
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const days  = Math.floor(ms / (1000 * 60 * 60 * 24));
  const years = Math.floor(days / 365);
  const remDays = days % 365;

  let dur;
  if (hours < 24)  dur = `${hours} hour${hours !== 1 ? 's' : ''}`;
  else if (years === 0) dur = `${days} day${days !== 1 ? 's' : ''}`;
  else dur = `${years} year${years !== 1 ? 's' : ''} and ${remDays} day${remDays !== 1 ? 's' : ''}`;

  const dateStr  = followDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const template = FOLLOWAGE_MESSAGES[followageRotateIdx % FOLLOWAGE_MESSAGES.length];
  followageRotateIdx++;
  sendChatMessage(template(displayName, dur, dateStr)).catch(() => {});
}

async function handleShoutout(username) {
  try {
    const login = username.replace(/^@/, '').toLowerCase();
    const res = await fetch(`https://api.twitch.tv/helix/users?login=${login}`, { headers: twitchHeaders() });
    if (!res.ok) { console.error('Shoutout user lookup failed:', res.status); return; }
    const data = await res.json();
    const user = data.data?.[0];
    if (!user) { console.error('Shoutout: user not found:', login); return; }

    // Get last played game via channel info
    let game = '';
    try {
      const chanRes = await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${user.id}`, { headers: twitchHeaders() });
      if (chanRes.ok) {
        const chanData = await chanRes.json();
        game = chanData.data?.[0]?.game_name || '';
      }
    } catch {}

    broadcastShoutout({
      type:        'shoutout',
      username:    user.login,
      displayName: user.display_name,
      profilePic:  user.profile_image_url,
      game,
    });
    const soTemplate = SO_MESSAGES[soRotateIdx % SO_MESSAGES.length];
    soRotateIdx++;
    sendChatMessage(soTemplate(user.display_name, game, user.login)).catch(() => {});
    console.log('Shoutout sent for', user.login);
  } catch (err) {
    console.error('handleShoutout error:', err.message);
  }
}

function connectChatReader() {
  if (!cfg.channel) return;
  chatters.clear();
  const ws = new WebSocket('wss://irc-ws.chat.twitch.tv');
  ws.on('open', () => {
    ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership');
    ws.send('PASS SCHMOOPIIE');
    ws.send('NICK justinfan' + Math.floor(Math.random() * 99999));
    ws.send('JOIN #' + cfg.channel);
  });
  ws.on('message', (raw) => {
    for (const line of raw.toString().split('\r\n')) {
      if (!line) continue;
      if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
      // NAMES list chunks (353)
      const namesMatch = line.match(/^:\S+ 353 \S+ [=*@] #\S+ :(.+)$/);
      if (namesMatch) { for (const u of namesMatch[1].split(' ')) if (u) chatters.add(u.toLowerCase()); continue; }
      // JOIN
      const joinMatch = line.match(/^:(\w+)!\S+ JOIN #\S+$/);
      if (joinMatch) { chatters.add(joinMatch[1].toLowerCase()); continue; }
      // PART
      const partMatch = line.match(/^:(\w+)!\S+ PART #\S+$/);
      if (partMatch) { chatters.delete(partMatch[1].toLowerCase()); continue; }
      // PRIVMSG
      const match = line.match(/^@(\S+) :(\w+)!\S+ PRIVMSG #\S+ :(.*)$/);
      if (match) {
        const ircNick = match[2];
        const msgText = match[3];
        const msgTags = parseChatTags(match[1], ircNick);
        const lowerNick = ircNick.toLowerCase();
        chatters.add(lowerNick);
        trackMessage(lowerNick, msgTags.displayName || ircNick, msgText);
        // Extract color from raw IRC tags
        const colorM = match[1].match(/(?:^|;)color=(#[0-9a-fA-F]{6})/);
        const msgColor = colorM ? colorM[1] : '';
        broadcastChatEvent({
          type:        'chat_message',
          displayName: msgTags.displayName || ircNick,
          username:    lowerNick,
          color:       msgColor,
          badges:      [...msgTags.badgeSet],
          message:     msgText,
        });
        if (lowerNick !== 'angrytoasterai') lastChatUsername = lowerNick;
        if (lowerNick !== 'angrytoasterai' && !firstMessagers.has(lowerNick)) {
          firstMessagers.add(lowerNick);
          broadcastChatEvent({ type: 'new_chatter', username: lowerNick, displayName: msgTags.displayName || ircNick });
          if (Math.random() < 0.15) handleFirstMessage(msgText, msgTags).catch(() => {});
        }
        handleChatCommand(msgText, msgTags);
      }
    }
  });
  ws.on('close', () => { chatters.clear(); setTimeout(connectChatReader, 5000); });
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

async function refreshBotToken() {
  const tokens = loadBotTokens();
  if (!tokens?.refresh_token) throw new Error('No bot refresh token stored');
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
  if (!res.ok) throw new Error(`Bot token refresh failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  saveBotTokens({ ...tokens, access_token: data.access_token, refresh_token: data.refresh_token || tokens.refresh_token });
  console.log('Bot access token refreshed');
  return data.access_token;
}

async function sendChatMessage(text) {
  const tokens = loadBotTokens();
  if (!tokens?.access_token || !tokens?.bot_id) return;
  if (!broadcasterId) return;
  const doSend = async (accessToken) => fetch('https://api.twitch.tv/helix/chat/messages', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Client-Id': cfg.clientId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ broadcaster_id: broadcasterId, sender_id: tokens.bot_id, message: text }),
  });
  let res = await doSend(tokens.access_token);
  if (res.status === 401) {
    try {
      const newToken = await refreshBotToken();
      res = await doSend(newToken);
    } catch (e) { console.error('Bot token refresh failed:', e.message); return; }
  }
  if (!res.ok) console.error('sendChatMessage failed:', res.status, await res.text());
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

// duration = seconds for timeout, null = permaban
async function moderateUser(targetLogin, duration) {
  const targetId = await getUserId(targetLogin);
  if (!targetId) { console.error('Mod: user not found:', targetLogin); return false; }
  const body = { data: { user_id: targetId } };
  if (duration !== null) body.data.duration = duration;
  const res = await fetch(
    `https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${broadcasterId}`,
    { method: 'POST', headers: twitchHeaders(), body: JSON.stringify(body) }
  );
  if (!res.ok) { console.error('Mod: failed:', res.status, await res.text()); return false; }
  return true;
}

async function unmoderateUser(targetLogin) {
  const targetId = await getUserId(targetLogin);
  if (!targetId) { console.error('Mod: user not found:', targetLogin); return false; }
  const res = await fetch(
    `https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${broadcasterId}&user_id=${targetId}`,
    { method: 'DELETE', headers: twitchHeaders() }
  );
  if (!res.ok && res.status !== 404) { console.error('Mod: unban failed:', res.status, await res.text()); return false; }
  return true;
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
    await createSubscription('channel.channel_points_automatic_reward_redemption.add', '1', { broadcaster_user_id: id });
    await createSubscription('stream.online',  '1', { broadcaster_user_id: id });
    await createSubscription('stream.offline', '1', { broadcaster_user_id: id });
    await createSubscription('channel.update',              '2', { broadcaster_user_id: id });
    await createSubscription('channel.ban',                 '1', { broadcaster_user_id: id, moderator_user_id: id });
    await createSubscription('channel.unban',               '1', { broadcaster_user_id: id, moderator_user_id: id });
    await createSubscription('channel.moderator.add',       '1', { broadcaster_user_id: id });
    await createSubscription('channel.moderator.remove',    '1', { broadcaster_user_id: id });
    await createSubscription('channel.poll.begin',          '1', { broadcaster_user_id: id });
    await createSubscription('channel.poll.end',            '1', { broadcaster_user_id: id });
    await createSubscription('channel.prediction.begin',    '1', { broadcaster_user_id: id });
    await createSubscription('channel.prediction.end',      '1', { broadcaster_user_id: id });
    await createSubscription('channel.hype_train.begin',    '1', { broadcaster_user_id: id });
    await createSubscription('channel.hype_train.end',      '1', { broadcaster_user_id: id });
    await createSubscription('channel.goal.begin',          '1', { broadcaster_user_id: id });
    await createSubscription('channel.goal.end',            '1', { broadcaster_user_id: id });
    await createSubscription('channel.shoutout.receive',    '1', { broadcaster_user_id: id, moderator_user_id: id });
    await createSubscription('channel.ad_break.begin',      '1', { broadcaster_user_id: id });
    await createSubscription('channel.charity_campaign.donate', '1', { broadcaster_user_id: id });
  } catch (err) {
    console.error('Subscription setup failed:', err.message);
  }
  // Connect PubSub after broadcasterId is known
  connectPubSub();
}

let pubSubWs = null;
let pubSubPingTimer = null;

function connectPubSub() {
  if (!broadcasterId) return;
  const token = loadTokens()?.access_token;
  if (!token) return;

  if (pubSubWs) { pubSubWs.removeAllListeners(); pubSubWs.terminate(); }
  clearInterval(pubSubPingTimer);

  console.log('Connecting to Twitch PubSub...');
  pubSubWs = new WebSocket('wss://pubsub-edge.twitch.tv/v1');

  pubSubWs.on('open', () => {
    console.log('PubSub connected');
    const topics = [
      `channel-bits-events-v2.${broadcasterId}`,
      `channel-bits-badge-unlock.${broadcasterId}`,
    ];
    pubSubWs.send(JSON.stringify({ type: 'LISTEN', data: { topics, auth_token: token } }));
    pubSubPingTimer = setInterval(() => {
      if (pubSubWs?.readyState === 1) pubSubWs.send(JSON.stringify({ type: 'PING' }));
    }, 4 * 60 * 1000);
  });

  pubSubWs.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'PONG') return;
    if (msg.type === 'RECONNECT') { connectPubSub(); return; }
    console.log('PubSub message:', JSON.stringify(msg));
  });

  pubSubWs.on('close', (code) => {
    console.log(`PubSub closed (${code}), reconnecting in 10s...`);
    clearInterval(pubSubPingTimer);
    setTimeout(connectPubSub, 10000);
  });

  pubSubWs.on('error', (err) => console.error('PubSub error:', err.message));
}

function formatAutoReward(type) {
  const labels = {
    send_highlighted_message:         'Highlighted Message',
    single_message_bypass_sub_mode:   'Bypass Sub-Only Mode',
    random_sub_emote_unlock:          'Random Sub Emote Unlock',
    chosen_sub_emote_unlock:          'Chosen Sub Emote Unlock',
    chosen_modified_sub_emote_unlock: 'Modified Sub Emote Unlock',
    message_effect:                   'Message Effect',
    gigantify_an_emote:               'Gigantify Emote',
    celebration:                      'Celebration',
  };
  return labels[type] || (type ? type.replace(/_/g, ' ') : 'Channel Points Reward');
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
    case 'channel.channel_points_automatic_reward_redemption.add':
      console.log(`AutoReward: type=${event.reward?.type} user=${event.user_name} cost=${event.reward?.cost}`);
      broadcastChatEvent({
        type:   'redemption',
        user:   event.user_name || 'unknown',
        reward: formatAutoReward(event.reward?.type),
        cost:   event.reward?.cost,
        input:  event.user_input || '',
      });
      break;
    case 'channel.update':
      broadcastChatEvent({
        type: 'stream_update',
        user: event.broadcaster_user_name,
        title: event.title || '',
        category: event.category_name || '',
      });
      break;
    case 'channel.ban':
      broadcastChatEvent({
        type: 'ban',
        user: event.user_name,
        mod: event.moderator_user_name,
        duration: event.is_permanent ? 'permanent' : (event.banned_at ? `${Math.round((new Date(event.ends_at || event.banned_at).getTime() - Date.now()) / 1000)}s` : ''),
        reason: event.reason || '',
      });
      break;
    case 'channel.unban':
      broadcastChatEvent({
        type: 'unban',
        user: event.user_name,
        mod: event.moderator_user_name,
      });
      break;
    case 'channel.moderator.add':
      broadcastChatEvent({ type: 'mod_add', user: event.user_name });
      break;
    case 'channel.moderator.remove':
      broadcastChatEvent({ type: 'mod_remove', user: event.user_name });
      break;
    case 'channel.poll.begin':
      broadcastChatEvent({
        type: 'poll_begin',
        user: event.broadcaster_user_name,
        title: event.title,
        choices: (event.choices || []).map(c => c.title).join(', '),
      });
      break;
    case 'channel.poll.end':
      {
        const winner = (event.choices || []).sort((a, b) => (b.votes || 0) - (a.votes || 0))[0];
        broadcastChatEvent({
          type: 'poll_end',
          user: event.broadcaster_user_name,
          title: event.title,
          winner: winner ? `${winner.title} (${winner.votes || 0} votes)` : '',
        });
      }
      break;
    case 'channel.prediction.begin':
      broadcastChatEvent({
        type: 'prediction_begin',
        user: event.broadcaster_user_name,
        title: event.title,
        choices: (event.outcomes || []).map(o => o.title).join(' vs '),
      });
      break;
    case 'channel.prediction.end':
      {
        const winning = event.winning_outcome_id
          ? (event.outcomes || []).find(o => o.id === event.winning_outcome_id)
          : null;
        broadcastChatEvent({
          type: 'prediction_end',
          user: event.broadcaster_user_name,
          title: event.title,
          status: event.status,
          winner: winning ? winning.title : '',
        });
      }
      break;
    case 'channel.hype_train.begin':
      broadcastChatEvent({
        type: 'hype_train',
        user: event.broadcaster_user_name || 'channel',
        level: event.level || 1,
        total: event.total || 0,
      });
      break;
    case 'channel.hype_train.end':
      broadcastChatEvent({
        type: 'hype_train_end',
        user: event.broadcaster_user_name || 'channel',
        level: event.level || 1,
        total: event.total || 0,
      });
      break;
    case 'channel.goal.begin':
      broadcastChatEvent({
        type: 'goal_begin',
        user: event.broadcaster_user_name,
        description: event.description || event.type || '',
        target: event.target_amount,
        current: event.current_amount,
      });
      break;
    case 'channel.goal.end':
      broadcastChatEvent({
        type: 'goal_end',
        user: event.broadcaster_user_name,
        description: event.description || event.type || '',
        target: event.target_amount,
        current: event.current_amount,
        achieved: event.is_achieved,
      });
      break;
    case 'channel.shoutout.receive':
      broadcastChatEvent({
        type: 'shoutout_in',
        user: event.from_broadcaster_user_name,
        viewers: event.viewer_count || 0,
      });
      break;
    case 'channel.ad_break.begin':
      broadcastChatEvent({
        type: 'ad_break',
        user: event.broadcaster_user_name || 'channel',
        duration: event.duration_seconds || 0,
        automatic: event.is_automatic,
      });
      break;
    case 'channel.charity_campaign.donate':
      broadcastChatEvent({
        type: 'charity',
        user: event.user_name,
        amount: event.amount?.value ? (event.amount.value / Math.pow(10, event.amount.decimal_places || 2)).toFixed(2) : '?',
        currency: event.amount?.currency || 'USD',
        charity: event.charity_name || '',
      });
      break;
    case 'stream.online':
      Object.keys(commandState).forEach(k => { commandState[k].triggeredThisStream = false; });
      firstMessagers.clear();
      userMentionCount.clear();
      userRoastCount.clear();
      userClaudeCallLog.clear();
      lastUnpromptedRoastTarget = null;
      lastChatUsername = null;
      streamOnline = true;
      if (!toasterRoastEnabled) { toasterRoastEnabled = true; scheduleNextRoast(); }
      console.log('Stream started — toaster enabled, state reset');
      break;
    case 'stream.offline':
      streamOnline = false;
      toasterRoastEnabled = false;
      clearTimeout(toasterRoastTimer);
      toasterRoastTimer = null;
      console.log('Stream ended — toaster disabled');
      break;
  }

  if (alert) {
    console.log('Alert fired:', alert);
    broadcast(alert);
    broadcastChatEvent(alert);
    handleEventToasterReaction(alert.type, alert.user, alert).catch(() => {});
  }
}

function tierLabel(tier) {
  return { '1000': 'Tier 1', '2000': 'Tier 2', '3000': 'Tier 3' }[tier] ?? 'Tier 1';
}

// ── OBS client WebSocket server ───────────────────────────────────────────────
const obsClients  = new Set();
const chatClients = new Set();
const mediaClients = new Set();

function broadcastMedia(data) {
  const msg = JSON.stringify(data);
  mediaClients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

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

const shoutoutClients = new Set();
const queueClients    = new Set();

function broadcastShoutout(data) {
  const msg = JSON.stringify(data);
  shoutoutClients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

function broadcastQueue() {
  const msg = JSON.stringify({ type: 'queue_update', queue });
  queueClients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
  chatClients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

// ── Token auto-refresh every 2 hours ─────────────────────────────────────────
setInterval(async () => {
  if (loadTokens()) {
    try { await refreshAccessToken(); }
    catch (err) { console.error('Scheduled token refresh failed:', err.message); }
  }
  if (loadBotTokens()) {
    try { await refreshBotToken(); }
    catch (err) { console.error('Scheduled bot token refresh failed:', err.message); }
  }
}, 2 * 60 * 60 * 1000);

// Poll Spotify every 5 s (no-op if not configured)
setInterval(pollSpotify, 5000);

// ── Express routes ────────────────────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));

app.get('/commands', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.send(commandsPageHtml());
});

app.get('/setup', (req, res) => {
  const hasTokens = !!loadTokens();
  const authUrl   = buildAuthUrl();
  res.send(setupPageHtml(hasTokens, authUrl));
});

app.get('/auth/callback', async (req, res) => {
  const { code, error, state } = req.query;
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

  // Bot auth flow — state starts with 'bot_'
  if (typeof state === 'string' && state.startsWith('bot_')) {
    const userRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Client-Id': cfg.clientId },
    });
    const userData = await userRes.json();
    const botId    = userData.data?.[0]?.id;
    const botLogin = userData.data?.[0]?.login;
    saveBotTokens({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, bot_id: botId, bot_login: botLogin });
    console.log(`Bot auth complete — ${botLogin} (${botId})`);
    return res.send('<script>window.location="/setup"</script>');
  }

  // Broadcaster auth flow
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

// ── Media files ────────────────────────────────────────────────────────────────
const MEDIA_MIME_MAP = {
  'video/mp4': 'mp4', 'video/webm': 'webm',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav',
  'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/aac': 'aac',
};
const VIDEO_TYPES = new Set(['mp4', 'webm']);

app.get('/media/:file', (req, res) => {
  const fp = path.join(mediaDir, path.basename(req.params.file));
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.sendFile(fp);
});

// ── Custom command routes ───────────────────────────────────────────────────────
app.get('/custom-commands', (_req, res) => res.json(loadCommands()));

app.post('/custom-commands/:name/file', express.raw({ type: '*/*', limit: '100mb' }), (req, res) => {
  const name = req.params.name.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!name) return res.status(400).json({ error: 'Invalid command name' });
  const ct  = (req.headers['content-type'] || '').split(';')[0].trim();
  const ext = MEDIA_MIME_MAP[ct];
  if (!ext) return res.status(400).json({ error: 'Unsupported file type: ' + ct });
  fs.mkdirSync(mediaDir, { recursive: true });
  const filename = name + '.' + ext;
  const fp = path.join(mediaDir, filename);
  fs.writeFileSync(fp, req.body);
  console.log('Media uploaded:', filename);
  res.json({ ok: true, file: filename, fileType: VIDEO_TYPES.has(ext) ? 'video' : 'audio' });
});

app.post('/custom-commands/:name', express.json(), (req, res) => {
  const name = req.params.name.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!name) return res.status(400).json({ error: 'Invalid command name' });
  const { desc, file, fileType, replyText, permission, cooldown, oncePerStream } = req.body || {};
  if (!desc) return res.status(400).json({ error: 'desc required' });
  const cmds = loadCommands();
  const perm = ['everyone','vip','mod'].includes(permission) ? permission : 'everyone';
  const cd   = Math.max(0, parseInt(cooldown) || 0);
  const once = !!oncePerStream;
  if (fileType === 'text') {
    if (!replyText) return res.status(400).json({ error: 'replyText required' });
    cmds['!' + name] = { command: '!' + name, desc: String(desc), fileType: 'text', replyText: String(replyText), permission: perm, cooldown: cd, oncePerStream: once };
  } else {
    if (!file) return res.status(400).json({ error: 'file required' });
    cmds['!' + name] = { command: '!' + name, desc: String(desc), file: String(file), fileType: fileType === 'video' ? 'video' : 'audio', permission: perm, cooldown: cd, oncePerStream: once };
  }
  saveCommands(cmds);
  res.json({ ok: true });
});

app.delete('/custom-commands/:name', (req, res) => {
  const key = '!' + req.params.name.toLowerCase();
  const cmds = loadCommands();
  const cmd  = cmds[key];
  if (cmd?.file) {
    try { fs.unlinkSync(path.join(mediaDir, cmd.file)); } catch {}
  }
  delete cmds[key];
  delete commandState[key];
  saveCommands(cmds);
  res.json({ ok: true });
});

app.post('/command-reset', (_req, res) => {
  Object.keys(commandState).forEach(k => { commandState[k].triggeredThisStream = false; });
  res.json({ ok: true });
});

// ── Shoutout route ─────────────────────────────────────────────────────────────
app.post('/shoutout/:username', async (req, res) => {
  await handleShoutout(req.params.username);
  res.json({ ok: true });
});

// ── Queue routes ───────────────────────────────────────────────────────────────
app.get('/queue', (_req, res) => res.json(queue));

app.post('/queue/next', (_req, res) => {
  if (queue.length > 0) queue.shift();
  broadcastQueue();
  res.json({ ok: true, queue });
});

app.post('/queue/clear', (_req, res) => {
  queue.length = 0;
  broadcastQueue();
  res.json({ ok: true });
});

app.delete('/queue/:username', (req, res) => {
  const uname = req.params.username.toLowerCase();
  const idx = queue.findIndex(e => e.username === uname);
  if (idx !== -1) queue.splice(idx, 1);
  broadcastQueue();
  res.json({ ok: true, queue });
});

// ── Chat control routes ────────────────────────────────────────────────────────
let lastClearTime = 0;

app.post('/chat/send', express.json(), async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });
  const tokens = loadTokens();
  if (!tokens?.access_token || !broadcasterId) return res.status(503).json({ error: 'not connected' });
  const doSend = async (token) => fetch('https://api.twitch.tv/helix/chat/messages', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': cfg.clientId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ broadcaster_id: broadcasterId, sender_id: broadcasterId, message }),
  });
  let r = await doSend(tokens.access_token);
  if (r.status === 401) {
    try { const t = await refreshAccessToken(); r = await doSend(t); }
    catch (e) { return res.status(500).json({ error: 'token refresh failed' }); }
  }
  if (!r.ok) return res.status(r.status).json({ error: await r.text() });
  res.json({ ok: true });
});

app.post('/chat/clear', (_req, res) => {
  lastClearTime = Date.now();
  broadcastChatEvent({ type: 'clear_chat', clearTime: lastClearTime });
  res.json({ ok: true });
});

app.get('/api/chat-clear-time', (_req, res) => {
  res.json({ clearTime: lastClearTime });
});

// ── Moderation routes ──────────────────────────────────────────────────────────
app.post('/moderation/timeout/:username', async (req, res) => {
  const login = req.params.username.replace(/^@/, '').toLowerCase();
  const ok = await moderateUser(login, 30);
  res.json({ ok });
});

app.post('/moderation/ban/:username', async (req, res) => {
  const login = req.params.username.replace(/^@/, '').toLowerCase();
  const ok = await moderateUser(login, null);
  res.json({ ok });
});

app.post('/moderation/unban/:username', async (req, res) => {
  const login = req.params.username.replace(/^@/, '').toLowerCase();
  const ok = await unmoderateUser(login);
  res.json({ ok });
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

  // Built-in
  const builtin = CHAT_COMMANDS[key];
  if (builtin) { builtin.action(); return res.json({ ok: true, command: key }); }

  // Custom (dashboard trigger bypasses cooldown)
  const cmds = loadCommands();
  const cmd  = cmds[key];
  if (!cmd) return res.status(404).json({ error: 'Unknown command' });
  if (cmd.fileType === 'text') {
    sendChatMessage(cmd.replyText || '').catch(() => {});
  } else {
    broadcastMedia({ type: 'play_media', file: cmd.file, fileType: cmd.fileType });
  }
  res.json({ ok: true, command: key });
});

app.get('/api/chatters', (_req, res) => {
  res.json({ count: chatters.size, users: [...chatters].sort() });
});

app.post('/api/toaster-roast/toggle', (_req, res) => {
  toasterRoastEnabled = !toasterRoastEnabled;
  if (toasterRoastEnabled) {
    scheduleNextRoast();
    console.log('AngryToasterAI unprompted roasts enabled');
  } else {
    clearTimeout(toasterRoastTimer);
    toasterRoastTimer = null;
    console.log('AngryToasterAI unprompted roasts disabled');
  }
  res.json({ enabled: toasterRoastEnabled, streamOnline, testingMode });
});

app.post('/api/toaster-roast/testmode', (_req, res) => {
  testingMode = !testingMode;
  console.log('AngryToasterAI test mode:', testingMode ? 'ON' : 'OFF');
  res.json({ testingMode, streamOnline, enabled: toasterRoastEnabled });
});

app.post('/api/toaster-roast/fire', async (_req, res) => {
  await fireUnpromptedRoast();
  res.json({ ok: true });
});

app.get('/status', (_req, res) => {
  const bot = loadBotTokens();
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
    bot_connected:      !!bot,
    bot_login:          bot?.bot_login || null,
  });
});

// ── HTML helpers ──────────────────────────────────────────────────────────────
function buildAuthUrl() {
  return 'https://id.twitch.tv/oauth2/authorize?' + new URLSearchParams({
    client_id:     cfg.clientId,
    redirect_uri:  cfg.redirectUri,
    response_type: 'code',
    scope:         'moderator:read:followers channel:read:subscriptions bits:read channel:read:redemptions moderator:manage:banned_users user:write:chat channel:read:polls channel:read:predictions channel:read:hype_train channel:read:goals moderator:read:shoutouts channel:read:ads channel:read:charity moderation:read channel:moderate',
    force_verify:  'true',
    state:          crypto.randomBytes(16).toString('hex'),
  });
}

function buildBotAuthUrl() {
  return 'https://id.twitch.tv/oauth2/authorize?' + new URLSearchParams({
    client_id:     cfg.clientId,
    redirect_uri:  cfg.redirectUri,
    response_type: 'code',
    scope:         'user:write:chat',
    force_verify:  'true',
    state:          'bot_' + crypto.randomBytes(16).toString('hex'),
  });
}

function errorPage(msg) {
  return `<!DOCTYPE html><html><body style="background:#0d0015;color:#ff2d78;font-family:monospace;padding:40px">
    <h2>Error</h2><p>${msg}</p><a href="/setup" style="color:#00f5ff">← Back to setup</a></body></html>`;
}

function commandsPageHtml() {
  const cmds = loadCommands();
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><title>Commands — Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d0015;color:#e0c3ff;font-family:'Share Tech Mono',monospace;padding:20px 24px;min-height:100vh}
  .header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}
  .header-title h1{font-family:'Orbitron',sans-serif;color:#bf00ff;font-size:1.5rem;text-shadow:0 0 20px #bf00ff;line-height:1}
  .header-title .sub{color:#7b2fff;letter-spacing:2px;font-size:.68rem;margin-top:4px}
  .card{background:#1a0033;border:1px solid #3d0080;border-radius:8px;padding:18px;position:relative;margin-bottom:16px}
  .card::before{content:'';position:absolute;top:6px;right:6px;width:9px;height:9px;border-top:1px solid #7b2fff;border-right:1px solid #7b2fff}
  h2{font-family:'Orbitron',sans-serif;color:#00f5ff;font-size:.68rem;letter-spacing:3px;text-transform:uppercase;margin-bottom:12px}
  p{color:#c9a0dc;line-height:1.65;margin-bottom:8px;font-size:.82rem}
  .btn{display:inline-block;background:linear-gradient(135deg,#7b2fff,#bf00ff);color:#fff;padding:9px 22px;border-radius:6px;text-decoration:none;font-family:'Orbitron',sans-serif;font-size:.68rem;letter-spacing:2px;box-shadow:0 0 18px rgba(191,0,255,.3);cursor:pointer;border:none;margin-top:6px}
  .btn:hover{opacity:.85}
  a:not(.btn){color:#bf00ff}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  td,th{vertical-align:middle;font-size:.78rem}
  .t-input{background:#080012;border:1px solid #3d0080;border-radius:4px;padding:6px 10px;color:#e0c3ff;font-family:'Share Tech Mono',monospace;font-size:.78rem;width:100%}
  .t-input:focus{outline:none;border-color:#7b2fff}
</style>
</head><body>

<div class="header">
  <div class="header-title">
    <h1>⚡ COMMANDS</h1>
    <div class="sub">CHAT COMMAND MANAGER</div>
  </div>
  <a href="/setup" class="btn" style="margin:0;padding:7px 18px;font-size:.65rem">← Dashboard</a>
</div>

<div class="card">
  <h2>Built-In Commands</h2>
  <p style="margin-bottom:8px">Active in <strong>#${cfg.channel}</strong>. Click Trigger to fire without typing in chat.</p>
  <table style="margin-top:4px;width:100%">
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

<div class="card">
  <h2>Custom Commands</h2>
  <p style="margin-bottom:12px;font-size:.78rem">Create commands that play audio/video clips or post a text reply when typed in chat.</p>

  <form onsubmit="createCommand(event)" style="display:grid;grid-template-columns:auto 1fr;gap:7px 12px;align-items:center;margin-bottom:14px;max-width:600px">
    <label style="font-size:.72rem;color:#9d77cc;white-space:nowrap">Command</label>
    <div style="display:flex;align-items:center;gap:4px">
      <span style="color:#00f5ff;font-size:.82rem">!</span>
      <input id="nc-name" class="t-input" placeholder="command" autocomplete="off" spellcheck="false" style="flex:1;max-width:180px">
    </div>

    <label style="font-size:.72rem;color:#9d77cc;white-space:nowrap">Type</label>
    <div style="display:flex;gap:18px;font-size:.75rem">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="radio" name="nc-type" value="media" checked onchange="updateCmdType()"> Media file</label>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="radio" name="nc-type" value="text" onchange="updateCmdType()"> Text reply</label>
    </div>

    <label style="font-size:.72rem;color:#9d77cc;white-space:nowrap">Description</label>
    <input id="nc-desc" class="t-input" placeholder="What this command does" autocomplete="off" spellcheck="false">

    <label id="nc-file-label" style="font-size:.72rem;color:#9d77cc;white-space:nowrap">File</label>
    <div id="nc-file-wrap" style="display:flex;align-items:center;gap:8px">
      <label style="cursor:pointer">
        <input type="file" id="nc-file" accept="audio/*,video/*" style="display:none" onchange="document.getElementById('nc-fname').textContent=this.files[0]?this.files[0].name:'No file chosen'">
        <span style="display:inline-block;font-size:.62rem;letter-spacing:1px;padding:5px 12px;border:1px solid #7b2fff;border-radius:3px;color:#7b2fff;text-transform:uppercase;cursor:pointer">Choose File</span>
      </label>
      <span id="nc-fname" style="font-size:.72rem;color:#4a2080">No file chosen</span>
    </div>

    <label id="nc-reply-label" style="display:none;font-size:.72rem;color:#9d77cc;white-space:nowrap;align-self:flex-start;margin-top:4px">Reply text</label>
    <textarea id="nc-reply" class="t-input" placeholder="Message AngryToasterAI will post in chat" rows="2" style="display:none;resize:vertical;font-family:inherit;font-size:.78rem"></textarea>

    <label style="font-size:.72rem;color:#9d77cc;white-space:nowrap">Permission</label>
    <select id="nc-perm" class="t-input" style="width:auto;max-width:180px">
      <option value="everyone">Everyone</option>
      <option value="vip">VIP+</option>
      <option value="mod">Mod+</option>
    </select>

    <label style="font-size:.72rem;color:#9d77cc;white-space:nowrap;align-self:flex-start;margin-top:6px">Cooldown</label>
    <div style="display:flex;flex-direction:column;gap:5px;font-size:.75rem">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
        <input type="radio" name="nc-cd" value="none" checked> No cooldown
      </label>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
        <input type="radio" name="nc-cd" value="seconds"> Cooldown:
        <input type="number" id="nc-cdsec" min="1" value="30" style="width:50px;background:#080012;border:1px solid #3d0080;border-radius:3px;padding:2px 6px;color:#e0c3ff;font-family:inherit"> sec
      </label>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
        <input type="radio" name="nc-cd" value="stream"> Once per stream
      </label>
    </div>

    <div></div>
    <div style="display:flex;align-items:center;gap:12px;margin-top:4px">
      <button type="submit" class="btn" style="padding:7px 20px;margin:0;font-size:.65rem">Create Command</button>
      <span id="nc-fb" style="font-size:.72rem;min-height:1.1em;letter-spacing:1px"></span>
    </div>
  </form>

  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
    <div style="font-size:.7rem;color:#7b2fff;letter-spacing:1px">EXISTING COMMANDS</div>
    <button onclick="resetStream()" style="background:transparent;border:1px solid #3d0080;color:#9d77cc;border-radius:3px;padding:3px 10px;cursor:pointer;font-family:inherit;font-size:.65rem;letter-spacing:1px">Reset Stream</button>
  </div>
  <div id="nc-table-wrap">
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="border-bottom:1px solid #1a0033">
          <th style="padding:6px 10px 6px 0;text-align:left;font-size:.65rem;letter-spacing:1px;color:#7b2fff;font-weight:normal">COMMAND</th>
          <th style="padding:6px 10px;text-align:left;font-size:.65rem;letter-spacing:1px;color:#7b2fff;font-weight:normal">DESCRIPTION</th>
          <th style="padding:6px 10px;text-align:left;font-size:.65rem;letter-spacing:1px;color:#7b2fff;font-weight:normal">PERM</th>
          <th style="padding:6px 10px;text-align:left;font-size:.65rem;letter-spacing:1px;color:#7b2fff;font-weight:normal">COOLDOWN</th>
          <th style="padding:6px 0;text-align:right;font-size:.65rem;letter-spacing:1px;color:#7b2fff;font-weight:normal" colspan="2">ACTIONS</th>
        </tr>
      </thead>
      <tbody id="nc-tbody"></tbody>
    </table>
  </div>
  <div id="nc-reset-fb" style="margin-top:6px;font-size:.72rem;min-height:1.1em;letter-spacing:1px"></div>
</div>

<script>
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function triggerCmd(name, fbId) {
  const id = fbId || 'cmd-fb';
  const fb = document.getElementById(id);
  if (fb) { fb.style.color = '#00f5ff'; fb.textContent = 'Triggering !' + name + '...'; }
  try {
    const r = await fetch('/command/' + name);
    const d = await r.json();
    if (fb) { fb.style.color = d.ok ? '#00ff88' : '#ff2d78'; fb.textContent = d.ok ? '\\u2713 !' + name + ' triggered' : '\\u2717 ' + (d.error || 'failed'); }
  } catch { if (fb) { fb.style.color = '#ff2d78'; fb.textContent = '\\u2717 Request failed'; } }
  setTimeout(() => { const f = document.getElementById(id); if (f) f.textContent = ''; }, 2000);
}

async function loadCustomCmdsUI() {
  const cmds = await fetch('/custom-commands').then(r => r.json()).catch(() => ({}));
  const tbody = document.getElementById('nc-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const entries = Object.entries(cmds);
  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:#3d0080;padding:10px 0;font-size:.75rem">No custom commands yet.</td></tr>';
    return;
  }
  for (const [key, cmd] of entries) {
    const name = key.slice(1);
    let cdLabel = 'None';
    if (cmd.oncePerStream) cdLabel = 'Once/stream';
    else if (cmd.cooldown > 0) cdLabel = cmd.cooldown + 's';
    const permLabel = cmd.permission === 'everyone' ? 'Everyone' : cmd.permission === 'vip' ? 'VIP+' : 'Mod+';
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid #0d0015';
    const nameSafe = name.replace(/'/g, "\\\\'");
    tr.innerHTML = '<td style="padding:7px 10px 7px 0;color:#00f5ff;font-size:.8rem;white-space:nowrap">' + escHtml(key) + '</td>' +
      '<td style="padding:7px 10px;color:#c9a0dc;font-size:.76rem">' + escHtml(cmd.desc) + (cmd.fileType === 'text' ? ' <span style="color:#555;font-size:.68rem">\\u00b7 text reply</span>' : '') + '</td>' +
      '<td style="padding:7px 10px;color:#9d77cc;font-size:.72rem;white-space:nowrap">' + permLabel + '</td>' +
      '<td style="padding:7px 10px;color:#9d77cc;font-size:.72rem;white-space:nowrap">' + cdLabel + '</td>' +
      '<td style="padding:7px 4px;white-space:nowrap"><button class="btn" style="padding:4px 12px;margin:0;font-size:.6rem;letter-spacing:1px">Trigger</button></td>' +
      '<td style="padding:7px 0;white-space:nowrap;text-align:right"><button style="background:transparent;border:1px solid #ff2d78;color:#ff2d78;border-radius:3px;padding:3px 9px;cursor:pointer;font-family:inherit;font-size:.6rem">Delete</button></td>';
    const trigBtn = tr.querySelectorAll('button')[0];
    const delBtn  = tr.querySelectorAll('button')[1];
    trigBtn.onclick = () => triggerCmd(name, 'nc-reset-fb');
    delBtn.onclick  = () => deleteCustomCmd(name);
    tbody.appendChild(tr);
  }
}

function updateCmdType() {
  const isText = document.querySelector('input[name="nc-type"]:checked').value === 'text';
  document.getElementById('nc-file-label').style.display  = isText ? 'none' : '';
  document.getElementById('nc-file-wrap').style.display   = isText ? 'none' : '';
  document.getElementById('nc-reply-label').style.display = isText ? '' : 'none';
  document.getElementById('nc-reply').style.display       = isText ? '' : 'none';
}

async function createCommand(e) {
  e.preventDefault();
  const fb   = document.getElementById('nc-fb');
  const name = document.getElementById('nc-name').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const desc = document.getElementById('nc-desc').value.trim();
  const type = document.querySelector('input[name="nc-type"]:checked').value;
  if (!name) { fb.style.color = '#ff2d78'; fb.textContent = 'Enter a command name'; return; }
  if (!desc) { fb.style.color = '#ff2d78'; fb.textContent = 'Enter a description'; return; }
  const perm          = document.getElementById('nc-perm').value;
  const cdVal         = document.querySelector('input[name="nc-cd"]:checked').value;
  const cdsec         = parseInt(document.getElementById('nc-cdsec').value) || 30;
  const cooldown      = cdVal === 'seconds' ? cdsec : 0;
  const oncePerStream = cdVal === 'stream';

  if (type === 'text') {
    const replyText = document.getElementById('nc-reply').value.trim();
    if (!replyText) { fb.style.color = '#ff2d78'; fb.textContent = 'Enter a reply message'; return; }
    fb.style.color = '#00f5ff'; fb.textContent = 'Saving command...';
    try {
      const r = await fetch('/custom-commands/' + name, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ desc, fileType: 'text', replyText, permission: perm, cooldown, oncePerStream }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'Save failed');
      fb.style.color = '#00ff88'; fb.textContent = '\\u2713 !' + name + ' created';
      document.getElementById('nc-name').value  = '';
      document.getElementById('nc-desc').value  = '';
      document.getElementById('nc-reply').value = '';
      loadCustomCmdsUI();
    } catch (err) { fb.style.color = '#ff2d78'; fb.textContent = '\\u2717 ' + err.message; }
  } else {
    const fileInput = document.getElementById('nc-file');
    const file = fileInput.files[0];
    if (!file) { fb.style.color = '#ff2d78'; fb.textContent = 'Choose a file'; return; }
    fb.style.color = '#00f5ff'; fb.textContent = 'Uploading file...';
    let uploadResult;
    try {
      const r = await fetch('/custom-commands/' + name + '/file', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
      uploadResult = await r.json();
      if (!uploadResult.ok) throw new Error(uploadResult.error || 'Upload failed');
    } catch (err) { fb.style.color = '#ff2d78'; fb.textContent = '\\u2717 ' + err.message; return; }
    fb.textContent = 'Saving command...';
    try {
      const r = await fetch('/custom-commands/' + name, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ desc, file: uploadResult.file, fileType: uploadResult.fileType, permission: perm, cooldown, oncePerStream }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'Save failed');
      fb.style.color = '#00ff88'; fb.textContent = '\\u2713 !' + name + ' created';
      document.getElementById('nc-name').value = '';
      document.getElementById('nc-desc').value = '';
      fileInput.value = '';
      document.getElementById('nc-fname').textContent = 'No file chosen';
      loadCustomCmdsUI();
    } catch (err) { fb.style.color = '#ff2d78'; fb.textContent = '\\u2717 ' + err.message; }
  }
  setTimeout(() => { const f = document.getElementById('nc-fb'); if (f) f.textContent = ''; }, 3000);
}

async function deleteCustomCmd(name) {
  await fetch('/custom-commands/' + name, { method: 'DELETE' });
  loadCustomCmdsUI();
}

async function resetStream() {
  const fb = document.getElementById('nc-reset-fb');
  if (fb) { fb.style.color = '#00f5ff'; fb.textContent = 'Resetting...'; }
  try {
    await fetch('/command-reset', { method: 'POST' });
    if (fb) { fb.style.color = '#00ff88'; fb.textContent = '\\u2713 Stream flags reset'; }
  } catch { if (fb) { fb.style.color = '#ff2d78'; fb.textContent = '\\u2717 Request failed'; } }
  setTimeout(() => { const f = document.getElementById('nc-reset-fb'); if (f) f.textContent = ''; }, 2000);
}

loadCustomCmdsUI();
</script>
</body></html>`;
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

  /* ── Queue list ───────────────────────────────────────────────────── */
  #queue-list{margin-top:8px;display:flex;flex-direction:column;gap:4px;min-height:24px}
  .q-row{display:flex;align-items:center;gap:8px;padding:5px 8px;background:#080012;border:1px solid #3d0080;border-radius:4px;font-size:.78rem}
  .q-num{color:#7b2fff;flex-shrink:0;min-width:18px;font-variant-numeric:tabular-nums}
  .q-name{color:#e0c3ff;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .q-del{background:transparent;border:1px solid #ff2d78;color:#ff2d78;border-radius:3px;padding:2px 7px;cursor:pointer;font-family:inherit;font-size:.65rem;flex-shrink:0}
  .q-empty{color:#3d0080;font-size:.75rem;padding:4px 2px}

  /* ── Shoutout input row ────────────────────────────────────────────── */
  .so-row{display:flex;gap:7px;margin-top:8px;align-items:center}
  .so-input{background:#080012;border:1px solid #3d0080;border-radius:4px;padding:6px 10px;color:#e0c3ff;font-family:'Share Tech Mono',monospace;font-size:.78rem;flex:1}
  .so-input:focus{outline:none;border-color:#9146ff}

  /* ── Command pills ──────────────────────────────────────────────── */
  .cmd-pill{background:#080012;border:1px solid #1a0050;border-radius:3px;padding:3px 8px;font-size:.72rem;color:#00f5ff;white-space:nowrap;font-family:'Share Tech Mono',monospace}
  .cmd-pill.sys{color:#7b5caa;border-color:#1a0033}
  .cmd-pill.custom{color:#bf00ff;border-color:#3d0080}
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
  <div style="flex:1;display:flex;flex-direction:column;gap:16px">
    <div style="display:flex;gap:16px;align-items:stretch">
      <div class="card" style="padding:14px;flex:3">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <h2 style="margin:0">Chat Preview</h2>
          <button class="btn" style="margin:0;padding:5px 14px;font-size:.62rem;background:linear-gradient(135deg,#3a0000,#6b0000)" onclick="fetch('/chat/clear',{method:'POST'})">Clear Chat</button>
        </div>
        <div id="chat-log" style="height:340px;overflow-y:auto;background:rgba(8,0,18,0.95);border-radius:4px;border:1px solid rgba(123,47,255,0.3);padding:8px;display:flex;flex-direction:column;gap:3px;font-family:'Share Tech Mono',monospace;font-size:11px;scrollbar-width:thin;scrollbar-color:#3d0080 transparent"></div>
        <div id="new-chatter-zone" style="min-height:1.6em;margin-top:6px;font-size:.72rem;font-family:'Share Tech Mono',monospace;letter-spacing:1px;color:#ffd700;display:flex;flex-direction:column;gap:3px"></div>
        <div style="display:flex;gap:7px;margin-top:4px">
          <input id="chat-send-input" class="so-input" placeholder="Send as emenblade..." autocomplete="off" spellcheck="false" style="flex:1" onkeydown="if(event.key==='Enter')sendDashboardChat()">
          <button class="btn" style="margin:0;padding:7px 16px;font-size:.65rem" onclick="sendDashboardChat()">Send</button>
        </div>
        <div id="chat-send-fb" style="margin-top:4px;font-size:.68rem;min-height:1em;letter-spacing:1px"></div>
      </div>
      <div class="card" style="flex:2;display:flex;flex-direction:column;min-width:0">
        <h2>In Chat <span id="chatter-count" style="color:#7b2fff;font-size:.6rem;letter-spacing:1px"></span></h2>
        <div id="chatter-list" style="flex:1;overflow-y:auto;max-height:520px;font-size:.82rem;font-family:'Share Tech Mono',monospace;color:#c9a0dc"></div>
        <div id="chatter-updated" style="font-size:.62rem;color:#3d3d5c;margin-top:10px;letter-spacing:1px">—</div>
      </div>
    </div>
    <div style="display:flex;gap:16px;align-items:flex-start">
      <div class="card" style="flex:1">
        <h2>Shoutout</h2>
        <p style="font-size:.78rem">Chat command: <span style="color:#9146ff">!so @username</span> (mod+)</p>
        <p style="margin-top:6px;font-size:.75rem">OBS Browser Source — <strong>600 × 160</strong>, transparent:</p>
        <div class="url">${cfg.hostUrl}/shoutout.html</div>
        <div class="so-row">
          <input id="so-input" class="so-input" placeholder="@username" autocomplete="off" spellcheck="false">
          <button class="btn" style="margin:0;padding:7px 18px;font-size:.65rem;background:linear-gradient(135deg,#5a10cc,#9146ff)" onclick="sendShoutout()">Send Shoutout</button>
        </div>
        <div id="so-fb" style="margin-top:8px;font-size:.72rem;min-height:1.1em;letter-spacing:1px"></div>
      </div>
      <div class="card" style="flex:1">
        <h2>Queue</h2>
        <p style="font-size:.78rem">Commands: <span style="color:#9146ff">!addme</span> · <span style="color:#9146ff">!leave</span> · <span style="color:#9146ff">!next</span> (mod+) · <span style="color:#9146ff">!clearqueue</span> (mod+)</p>
        <p style="margin-top:6px;font-size:.75rem">OBS Browser Source — <strong>300 × 600</strong>, transparent:</p>
        <div class="url">${cfg.hostUrl}/queue.html</div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn" style="margin:0;padding:7px 16px;font-size:.65rem" onclick="queueNext()">Next</button>
          <button class="btn" style="margin:0;padding:7px 16px;font-size:.65rem;background:linear-gradient(135deg,#6b0000,#c0000c)" onclick="queueClear()">Clear</button>
        </div>
        <div id="queue-list"><div class="q-empty">Queue is empty</div></div>
      </div>
    </div>
  </div>
</div>

<div class="card" style="margin-top:16px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
    <h2 style="margin:0">Commands</h2>
    <a href="/commands" style="font-size:.63rem;color:#7b2fff;letter-spacing:1px;text-decoration:none;border:1px solid #3d0080;border-radius:3px;padding:3px 10px">MANAGE →</a>
  </div>
  <div id="cmd-pills" style="display:flex;flex-wrap:wrap;gap:5px">
    ${[...Object.keys(CHAT_COMMANDS), '!so', '!shoutout', '!addme', '!leave', '!next', '!clearqueue', '!followage', '!roast', '!timeout', '!ban', '!unban'].map(cmd =>
      `<span class="cmd-pill sys">${cmd}</span>`
    ).join('')}
  </div>
  <div id="cmd-count" style="margin-top:8px;font-size:.63rem;color:#3d3d5c;letter-spacing:1px"></div>
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

<div class="bottom-row" style="margin-top:16px">
  <div class="card">
    <h2>OBS Browser Sources</h2>
    <p>Alerts overlay — <strong>1920 × 300</strong>, transparent, bottom of scene:</p>
    <div class="url">${cfg.hostUrl}/alerts.html</div>
    <p style="margin-top:10px">Chat overlay — <strong>380 × 700</strong>, transparent, right side:</p>
    <div class="url">${cfg.hostUrl}/chat.html</div>
    <p style="margin-top:10px">Media player (custom commands) — <strong>1920 × 1080</strong>, transparent, top layer:</p>
    <div class="url">${cfg.hostUrl}/media.html</div>
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
    <h2>Bot Account</h2>
    ${(() => {
      const bot = loadBotTokens();
      return `<div class="sitem" style="margin-bottom:10px">
        <div class="sdot ${bot ? 'on' : 'off'}"></div>
        <span style="color:${bot ? '#00ff88' : '#ff2d78'}">${bot ? `Connected as ${bot.bot_login || 'bot'}` : 'Not connected'}</span>
      </div>
      <p style="font-size:.78rem;margin-bottom:8px">AngryToasterAI sends chat responses for queue commands. Make sure it's <strong>modded</strong> in your channel.</p>
      <a class="btn" href="${buildBotAuthUrl()}" style="display:inline-block">${bot ? 'Re-connect Bot' : 'Connect Bot Account'}</a>`;
    })()}
  </div>
  <div class="card">
    <h2>Unprompted Roasts</h2>
    <div class="sitem" style="margin-bottom:6px">
      <div class="sdot ${streamOnline ? 'on' : 'off'}" id="stream-status-dot"></div>
      <span id="stream-status-label" style="color:${streamOnline ? '#00ff88' : '#888'}">Stream ${streamOnline ? 'Live' : 'Offline'}</span>
    </div>
    <div class="sitem" style="margin-bottom:10px">
      <div class="sdot ${toasterRoastEnabled ? 'on' : 'off'}" id="roast-dot"></div>
      <span id="roast-status" style="color:${toasterRoastEnabled ? '#00ff88' : '#ff2d78'}">${toasterRoastEnabled ? (streamOnline ? 'Active — fires every 10–15 min' : 'Armed (test mode only)') : 'Inactive'}</span>
    </div>
    <p style="font-size:.78rem;margin-bottom:10px">Auto-enables when stream goes live. API calls disabled when offline unless Test Mode is on.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn" id="roast-toggle" onclick="toggleRoast()">${toasterRoastEnabled ? 'Disable' : 'Enable'}</button>
      <button class="btn" id="test-mode-btn" onclick="toggleTestMode()" style="${testingMode ? 'background:linear-gradient(135deg,#7b2fff,#ff6b00)' : ''}">${testingMode ? 'Test Mode: ON' : 'Test Mode'}</button>
      <button class="btn" style="background:linear-gradient(135deg,#7b2fff,#ff2d78)" onclick="fireRoastNow()">Fire Now</button>
    </div>
    <div id="roast-fb" style="margin-top:8px;font-size:.72rem;min-height:1.1em;letter-spacing:1px"></div>
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
  giftsub:'#ff2d78', bits:'#ffd700', raid:'#ff6b35',
  redemption:'#ffd700', stream_update:'#7b2fff',
  ban:'#ff2d2d', unban:'#00ff88', mod_add:'#00ff88', mod_remove:'#ff6b35',
  poll_begin:'#7b2fff', poll_end:'#bf00ff',
  prediction_begin:'#d44aff', prediction_end:'#bf00ff',
  hype_train:'#ff6b35', hype_train_end:'#ffd700',
  goal_begin:'#00f5ff', goal_end:'#00ff88',
  shoutout_in:'#ff2d78', ad_break:'#888888', charity:'#00ff88',
};

function feedDetail(m) {
  switch (m.type) {
    case 'follow':          return 'followed';
    case 'sub':             return 'subscribed' + (m.tier ? ' \xb7 ' + escHtml(m.tier) : '');
    case 'resub':           return 'resubbed \xb7 ' + m.months + ' months' + (m.tier ? ' \xb7 ' + escHtml(m.tier) : '') + (m.message ? ' \u2014 <span class="ev-input">&ldquo;' + escHtml(m.message) + '&rdquo;</span>' : '');
    case 'giftsub':         return 'gifted ' + m.count + ' sub' + (m.count !== 1 ? 's' : '') + (m.tier ? ' \xb7 ' + escHtml(m.tier) : '');
    case 'bits':            return 'cheered ' + Number(m.bits).toLocaleString() + ' bits' + (m.message ? ' \u2014 <span class="ev-input">&ldquo;' + escHtml(m.message) + '&rdquo;</span>' : '');
    case 'raid':            return 'raided with ' + Number(m.viewers).toLocaleString() + ' viewers';
    case 'redemption':      return 'redeemed ' + escHtml(m.reward) + (m.cost ? ' <span style="color:#4a2080">(' + Number(m.cost).toLocaleString() + ' pts)</span>' : '') + (m.input ? ' \u2014 <span class="ev-input">&ldquo;' + escHtml(m.input) + '&rdquo;</span>' : '');
    case 'stream_update':   return 'updated stream' + (m.category ? ' \xb7 ' + escHtml(m.category) : '') + (m.title ? ' \u2014 <span class="ev-input">&ldquo;' + escHtml(m.title) + '&rdquo;</span>' : '');
    case 'ban':             return 'banned' + (m.mod ? ' by ' + escHtml(m.mod) : '') + (m.duration ? ' \xb7 ' + escHtml(m.duration) : ' \xb7 permanent') + (m.reason ? ' \u2014 ' + escHtml(m.reason) : '');
    case 'unban':           return 'unbanned' + (m.mod ? ' by ' + escHtml(m.mod) : '');
    case 'mod_add':         return 'made mod';
    case 'mod_remove':      return 'unmodded';
    case 'poll_begin':      return 'poll started \u2014 <span class="ev-input">' + escHtml(m.title) + '</span>' + (m.choices ? ' [' + escHtml(m.choices) + ']' : '');
    case 'poll_end':        return 'poll ended \u2014 winner: <span class="ev-input">' + escHtml(m.winner || 'n/a') + '</span>';
    case 'prediction_begin':return 'prediction started \u2014 <span class="ev-input">' + escHtml(m.title) + '</span>' + (m.choices ? ' [' + escHtml(m.choices) + ']' : '');
    case 'prediction_end':  return 'prediction ' + escHtml(m.status || 'ended') + (m.winner ? ' \u2014 winner: <span class="ev-input">' + escHtml(m.winner) + '</span>' : '');
    case 'hype_train':      return 'hype train started! level ' + m.level + ' \xb7 ' + Number(m.total).toLocaleString() + ' pts';
    case 'hype_train_end':  return 'hype train ended \xb7 level ' + m.level + ' \xb7 ' + Number(m.total).toLocaleString() + ' pts';
    case 'goal_begin':      return 'goal started \u2014 ' + escHtml(m.description) + ' \xb7 target: ' + Number(m.target).toLocaleString();
    case 'goal_end':        return 'goal ' + (m.achieved ? '\u2705 achieved' : 'ended') + ' \u2014 ' + escHtml(m.description) + ' \xb7 ' + Number(m.current).toLocaleString() + ' / ' + Number(m.target).toLocaleString();
    case 'shoutout_in':     return 'shouted out the channel \xb7 ' + Number(m.viewers).toLocaleString() + ' viewers';
    case 'ad_break':        return (m.automatic ? 'auto ' : 'manual ') + 'ad break \xb7 ' + m.duration + 's';
    case 'charity':         return 'donated $' + escHtml(m.amount) + ' ' + escHtml(m.currency) + (m.charity ? ' to ' + escHtml(m.charity) : '');
    default:                return escHtml(m.type);
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
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
  feed.appendChild(row);
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}

const MAX_CHAT_LOG = 150;
const FALLBACKS_DASH = ['#00f5ff','#bf00ff','#ff2d78','#9d00ff','#00c8ff','#d44aff','#7b2fff'];
function dashFallbackColor(name) {
  var h = 0; for (var c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return FALLBACKS_DASH[Math.abs(h) % FALLBACKS_DASH.length];
}
function addChatLogMessage(m) {
  const log = document.getElementById('chat-log');
  if (!log) return;
  const color = m.color || dashFallbackColor(m.username || 'user');
  const badges = (m.badges || []);
  const badgeHtml = badges.filter(function(b) { return ['broadcaster','moderator','vip','subscriber'].indexOf(b) !== -1; })
    .map(function(b) {
      const labels = {broadcaster:'LIVE',moderator:'MOD',vip:'VIP',subscriber:'SUB'};
      const colors = {broadcaster:'#ff2d78',moderator:'#00ff88',vip:'#bf00ff',subscriber:'#7b2fff'};
      return '<span style="font-size:9px;padding:1px 4px;border-radius:2px;border:1px solid ' + colors[b] + ';color:' + colors[b] + ';margin-right:3px">' + labels[b] + '</span>';
    }).join('');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const el = document.createElement('div');
  el.style.cssText = 'padding:2px 6px;border-left:2px solid ' + color + ';background:rgba(13,0,26,0.4);border-radius:0 3px 3px 0;flex-shrink:0';
  el.innerHTML = badgeHtml + '<span style="font-weight:bold;color:' + color + '">' + escHtml(m.displayName) + '</span><span style="color:rgba(255,255,255,0.3)">: </span><span style="color:#ddd0f0;word-break:break-word">' + escHtml(m.message) + '</span>';
  log.appendChild(el);
  const msgs = log.children;
  if (msgs.length > MAX_CHAT_LOG) msgs[0].remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

const FEED_TYPES = new Set(['follow','sub','resub','giftsub','bits','raid','redemption',
  'stream_update','ban','unban','mod_add','mod_remove',
  'poll_begin','poll_end','prediction_begin','prediction_end',
  'hype_train','hype_train_end','goal_begin','goal_end',
  'shoutout_in','ad_break','charity']);

function showNewChatterAlert(displayName) {
  const zone = document.getElementById('new-chatter-zone');
  if (!zone) return;
  const el = document.createElement('div');
  el.style.cssText = 'animation:msgIn 0.2s ease-out forwards;opacity:0';
  el.textContent = '\\u26a1 ' + displayName + ' first message!';
  zone.appendChild(el);
  // Keep at most 3 visible at once
  while (zone.children.length > 3) zone.firstChild.remove();
  // Fade out after 6s
  setTimeout(() => {
    el.style.transition = 'opacity 0.5s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 500);
  }, 6000);
}

(function connectFeedWs() {
  const ws = new WebSocket(\`ws://\${location.host}/chat-ws\`);
  ws.onmessage = e => {
    try {
      const m = JSON.parse(e.data);
      if (FEED_TYPES.has(m.type)) addFeedEvent(m);
      if (m.type === 'chat_message') addChatLogMessage(m);
      if (m.type === 'queue_update') renderQueue(m.queue);
      if (m.type === 'new_chatter') showNewChatterAlert(m.displayName || m.username);
    } catch {}
  };
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

if (document.getElementById('sstat-follow')) loadSoundsUI();

// ── Commands pill list ───────────────────────────────────────────────
async function loadCmdPills() {
  const custom = await fetch('/custom-commands').then(r => r.json()).catch(() => ({}));
  const container = document.getElementById('cmd-pills');
  if (!container) return;
  container.querySelectorAll('.cmd-pill.custom').forEach(el => el.remove());
  for (const [key, cmd] of Object.entries(custom)) {
    const pill = document.createElement('span');
    pill.className = 'cmd-pill custom';
    let label = key;
    if (cmd.permission === 'mod') label += ' (mod)';
    else if (cmd.permission === 'vip') label += ' (vip)';
    pill.textContent = label;
    container.appendChild(pill);
  }
  const total = container.querySelectorAll('.cmd-pill').length;
  const el = document.getElementById('cmd-count');
  if (el) el.textContent = total + ' command' + (total !== 1 ? 's' : '') + ' active';
}
if (document.getElementById('cmd-pills')) {
  loadCmdPills();
  setInterval(loadCmdPills, 30000);
}

// ── Queue UI ────────────────────────────────────────────────────────
function renderQueue(q) {
  const list = document.getElementById('queue-list');
  if (!list) return;
  while (list.firstChild) list.removeChild(list.firstChild);
  if (!q || q.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'q-empty';
    empty.textContent = 'Queue is empty';
    list.appendChild(empty);
    return;
  }
  q.forEach(function(entry, i) {
    const row = document.createElement('div');
    row.className = 'q-row';
    const num = document.createElement('span');
    num.className = 'q-num';
    num.textContent = String(i + 1) + '.';
    const name = document.createElement('span');
    name.className = 'q-name';
    name.textContent = entry.displayName || entry.username;
    const del = document.createElement('button');
    del.className = 'q-del';
    del.textContent = 'Remove';
    del.dataset.username = entry.username;
    del.onclick = function() { queueRemove(this.dataset.username); };
    row.appendChild(num);
    row.appendChild(name);
    row.appendChild(del);
    list.appendChild(row);
  });
}

async function queueNext() {
  await fetch('/queue/next', { method: 'POST' });
}

async function queueClear() {
  await fetch('/queue/clear', { method: 'POST' });
}

async function queueRemove(username) {
  await fetch('/queue/' + encodeURIComponent(username), { method: 'DELETE' });
}

// Load initial queue state
fetch('/queue').then(function(r) { return r.json(); }).then(renderQueue).catch(function() {});

// ── Chatters polling ─────────────────────────────────────────────────
var CHANNEL = '${cfg.channel}';
var BTN_BASE = 'border:none;border-radius:3px;cursor:pointer;font-family:\\'Share Tech Mono\\',monospace;font-size:.6rem;letter-spacing:1px;padding:2px 7px;margin-left:4px;';

async function modAction(type, username) {
  try { await fetch('/moderation/' + type + '/' + encodeURIComponent(username), { method: 'POST' }); } catch {}
}

async function refreshChatters() {
  try {
    var r = await fetch('/api/chatters');
    var d = await r.json();
    var listEl = document.getElementById('chatter-list');
    var countEl = document.getElementById('chatter-count');
    var updatedEl = document.getElementById('chatter-updated');
    if (!listEl) return;
    countEl.textContent = '(' + d.count + ')';
    var groups = {};
    for (var i = 0; i < d.users.length; i++) {
      var u = d.users[i];
      var k = u[0] ? u[0].toUpperCase() : '#';
      if (!groups[k]) groups[k] = [];
      groups[k].push(u);
    }
    var frag = document.createDocumentFragment();
    var letters = Object.keys(groups).sort();
    for (var j = 0; j < letters.length; j++) {
      var letter = letters[j];
      var hdr = document.createElement('div');
      hdr.style.cssText = 'color:#7b2fff;font-size:.55rem;letter-spacing:2px;border-bottom:1px solid #2a005a;padding-bottom:2px;margin:8px 0 4px';
      hdr.textContent = letter;
      frag.appendChild(hdr);
      for (var k2 = 0; k2 < groups[letter].length; k2++) {
        var name = groups[letter][k2];
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;padding:2px 0';
        var link = document.createElement('a');
        link.href = 'https://www.twitch.tv/popout/' + CHANNEL + '/viewercard/' + name;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = name;
        link.style.cssText = 'color:#c9a0dc;text-decoration:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        link.onmouseover = function() { this.style.color = '#00f5ff'; };
        link.onmouseout  = function() { this.style.color = '#c9a0dc'; };
        var toBtn = document.createElement('button');
        toBtn.textContent = 'TO';
        toBtn.style.cssText = BTN_BASE + 'background:#3a1a00;color:#ff8c00';
        toBtn.title = '30s timeout';
        (function(n) { toBtn.onclick = function() { modAction('timeout', n); }; })(name);
        var banBtn = document.createElement('button');
        banBtn.textContent = 'BAN';
        banBtn.style.cssText = BTN_BASE + 'background:#3a0000;color:#ff2d2d';
        banBtn.title = 'Permanent ban';
        (function(n) { banBtn.onclick = function() { modAction('ban', n); }; })(name);
        row.appendChild(link);
        row.appendChild(toBtn);
        row.appendChild(banBtn);
        frag.appendChild(row);
      }
    }
    listEl.innerHTML = '';
    if (d.count === 0) {
      var empty = document.createElement('span');
      empty.style.color = '#3d3d5c';
      empty.textContent = 'no one in chat';
      listEl.appendChild(empty);
    } else {
      listEl.appendChild(frag);
    }
    updatedEl.textContent = 'UPDATED ' + new Date().toLocaleTimeString();
  } catch {}
}
refreshChatters();
setInterval(refreshChatters, 15000);

// ── Dashboard Chat Send ──────────────────────────────────────────────
async function sendDashboardChat() {
  const input = document.getElementById('chat-send-input');
  const fb    = document.getElementById('chat-send-fb');
  const msg   = (input.value || '').trim();
  if (!msg) return;
  try {
    const r = await fetch('/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });
    const d = await r.json();
    if (d.ok) {
      input.value = '';
      if (fb) { fb.style.color = '#00ff88'; fb.textContent = '\\u2713 sent'; setTimeout(() => { if (fb) fb.textContent = ''; }, 1500); }
    } else {
      if (fb) { fb.style.color = '#ff2d78'; fb.textContent = '\\u2717 ' + (d.error || 'failed'); setTimeout(() => { if (fb) fb.textContent = ''; }, 3000); }
    }
  } catch {
    if (fb) { fb.style.color = '#ff2d78'; fb.textContent = '\\u2717 request failed'; setTimeout(() => { if (fb) fb.textContent = ''; }, 3000); }
  }
}

// ── Shoutout UI ─────────────────────────────────────────────────────
async function sendShoutout() {
  const input = document.getElementById('so-input');
  const fb = document.getElementById('so-fb');
  if (!input || !fb) return;
  const val = input.value.trim();
  if (!val) return;
  fb.style.color = '#00f5ff';
  fb.textContent = 'Sending shoutout...';
  try {
    const username = val.replace(/^@/, '');
    const r = await fetch('/shoutout/' + encodeURIComponent(username), { method: 'POST' });
    const d = await r.json();
    if (d.ok) {
      fb.style.color = '#00ff88';
      fb.textContent = '\\u2713 Shoutout sent for ' + username;
      input.value = '';
    } else {
      fb.style.color = '#ff2d78';
      fb.textContent = '\\u2717 ' + (d.error || 'Failed');
    }
  } catch {
    fb.style.color = '#ff2d78';
    fb.textContent = '\\u2717 Request failed';
  }
  setTimeout(function() { const f = document.getElementById('so-fb'); if (f) f.textContent = ''; }, 3000);
}
function updateRoastUI(data) {
  document.getElementById('roast-dot').className       = 'sdot ' + (data.enabled ? 'on' : 'off');
  document.getElementById('roast-status').style.color  = data.enabled ? '#00ff88' : '#ff2d78';
  document.getElementById('roast-status').textContent  = data.enabled ? (data.streamOnline ? 'Active \\u2014 fires every 10\\u201315 min' : 'Armed (test mode only)') : 'Inactive';
  document.getElementById('roast-toggle').textContent  = data.enabled ? 'Disable' : 'Enable';
  const tb = document.getElementById('test-mode-btn');
  tb.textContent = data.testingMode ? 'Test Mode: ON' : 'Test Mode';
  tb.style.background = data.testingMode ? 'linear-gradient(135deg,#7b2fff,#ff6b00)' : '';
}
async function toggleRoast() {
  const res  = await fetch('/api/toaster-roast/toggle', { method: 'POST' });
  updateRoastUI(await res.json());
}
async function toggleTestMode() {
  const res  = await fetch('/api/toaster-roast/testmode', { method: 'POST' });
  updateRoastUI(await res.json());
}
async function fireRoastNow() {
  const fb = document.getElementById('roast-fb');
  fb.style.color = '#7b2fff'; fb.textContent = 'Firing...';
  await fetch('/api/toaster-roast/fire', { method: 'POST' });
  fb.style.color = '#00ff88'; fb.textContent = '\\u2713 Fired!';
  setTimeout(function() { fb.textContent = ''; }, 3000);
}
</script>

</body></html>`;
}

// ── Start ─────────────────────────────────────────────────────────────────────
const server   = http.createServer(app);

// Use noServer + manual routing so multiple WSS instances don't conflict.
// When both share { server }, each WSS fires for every upgrade — the one
// whose path doesn't match calls abortHandshake(), corrupting the already-
// upgraded socket and causing "Invalid frame header" on the client.
const wss         = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const chatWss     = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const spotifyWss  = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const mediaWss    = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const shoutoutWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const queueWss    = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);
  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  } else if (pathname === '/chat-ws') {
    chatWss.handleUpgrade(request, socket, head, (ws) => chatWss.emit('connection', ws, request));
  } else if (pathname === '/spotify-ws') {
    spotifyWss.handleUpgrade(request, socket, head, (ws) => spotifyWss.emit('connection', ws, request));
  } else if (pathname === '/media-ws') {
    mediaWss.handleUpgrade(request, socket, head, (ws) => mediaWss.emit('connection', ws, request));
  } else if (pathname === '/shoutout-ws') {
    shoutoutWss.handleUpgrade(request, socket, head, (ws) => shoutoutWss.emit('connection', ws, request));
  } else if (pathname === '/queue-ws') {
    queueWss.handleUpgrade(request, socket, head, (ws) => queueWss.emit('connection', ws, request));
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

mediaWss.on('connection', (ws) => {
  mediaClients.add(ws);
  ws.on('close', () => mediaClients.delete(ws));
  ws.on('error', () => mediaClients.delete(ws));
});

shoutoutWss.on('connection', (ws) => {
  shoutoutClients.add(ws);
  ws.on('close', () => shoutoutClients.delete(ws));
  ws.on('error', () => shoutoutClients.delete(ws));
});

queueWss.on('connection', (ws) => {
  queueClients.add(ws);
  ws.send(JSON.stringify({ type: 'queue_update', queue }));
  ws.on('close', () => queueClients.delete(ws));
  ws.on('error', () => queueClients.delete(ws));
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
