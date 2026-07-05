# Glucosa Alert

Low glucose alarm backend for Freestyle Libre 3 / LibreLinkUp.

## Setup

1. Copy `.env.example` to `.env` and fill in your credentials
2. `npm install`
3. `npm start`

## Environment Variables

See `.env.example` for all required variables.

## API Endpoints

- `GET  /api/health` — server status + last glucose reading
- `POST /api/push/subscribe` — register iPhone push subscription
- `POST /api/alarm/conscious` — user confirmed conscious (cancels escalation)
- `POST /api/escalate` — trigger escalation manually
- `POST /api/twilio/reply` — Twilio webhook for WhatsApp replies
- `GET  /api/push/vapid-keys` — generate VAPID keys (run once)
- `GET  /api/settings` — get current settings
- `POST /api/settings` — update settings + contacts
