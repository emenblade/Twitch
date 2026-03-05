# CLAUDE.md — twitch-alerts

## What This Does

Real-time Twitch alerts overlay for OBS. Runs as a Docker container on the NAS. OBS adds `http://192.168.1.10:3000/alerts.html` as a Browser Source.

**Flow:** NAS container → Twitch EventSub WebSocket → broadcasts to OBS Browser Source via local WebSocket → cyberpunk animation plays

## Repo Structure

```
twitch-alerts/
├── server.js                        # All server logic (~230 lines)
├── public/
│   └── alerts.html                  # OBS browser source — HTML + CSS + JS in one file
├── package.json                     # express, ws
├── Dockerfile                       # node:20-alpine
├── docker-compose.yml               # for local dev
├── unraid-template.xml              # Unraid Community Apps template
├── Stream-assets.xml                # Unraid Community Apps install template
└── .github/workflows/
    └── docker-publish.yml           # pushes ghcr.io/emenblade/twitch:latest on main push
```

## Config (all env vars — no secrets in code)

| Var | Required | Description |
|-----|----------|-------------|
| `TWITCH_CLIENT_ID` | yes | From dev.twitch.tv |
| `TWITCH_CLIENT_SECRET` | yes | From dev.twitch.tv (masked in Unraid) |
| `TWITCH_CHANNEL` | yes | Channel name, lowercase (e.g. `emenblade`) |
| `HOST_URL` | yes | `http://192.168.1.10:3000` — used for OAuth redirect + OBS URL |
| `PORT` | no | Default `3000` |
| `DATA_DIR` | no | Default `/app/data` — where tokens.json is stored |

## Auth Flow (one-time setup)

1. Deploy container on Unraid (XML template pulls from GHCR)
2. Visit `http://192.168.1.10:3000/setup`
3. Add the shown redirect URI to Twitch Developer App
4. Click "Connect with Twitch" — authorize as the broadcaster account
5. Tokens saved to `/app/data/tokens.json` (persists across restarts)
6. Add `http://192.168.1.10:3000/alerts.html` as Browser Source in OBS

## Tokens

Stored in `/app/data/tokens.json` (volume-mounted, never in image). Auto-refreshed every 2 hours. If refresh fails, re-run the setup flow.

## Alert Events

`channel.follow` v2, `channel.subscribe` v1, `channel.subscription.gift` v1, `channel.subscription.message` v1, `channel.cheer` v1, `channel.raid` v1

OAuth scopes: `moderator:read:followers channel:read:subscriptions bits:read`

## server.js Architecture

- Express serves static `public/` folder and setup/callback routes
- `connectEventSub()` — opens WebSocket to Twitch, handles reconnect on close
- `setupSubscriptions()` — called after session_welcome, creates all subscriptions
- `handleEvent()` — maps Twitch event payload to alert object
- `broadcast()` — sends alert JSON to all connected OBS WebSocket clients
- WebSocket server on path `/ws` — OBS page connects here for real-time events

## GHCR Publishing

Push to `main` → GitHub Actions builds and pushes `ghcr.io/emenblade/twitch:latest` and `ghcr.io/emenblade/twitch:<sha>`. No secrets to configure — uses built-in `GITHUB_TOKEN`.

## OBS Setup

- Browser Source URL: `http://192.168.1.10:3000/alerts.html`
- Width: 1920, Height: 300
- Enable "transparent background"
- Position at bottom of scene

## Testing Alerts Without Going Live

Uncomment the test lines at the bottom of `alerts.html` to preview all alert types in the browser.

## Design

- Fonts: Orbitron (username), Share Tech Mono (labels/details)
- Colors by type: follow=cyan, sub=purple, resub=dark-purple, giftsub=pink, bits=gold, raid=orange
- Animations: slide-in with bounce, glitch on username, border neon pulse, scan-line overlay
