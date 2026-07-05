import express from 'express';
import webpush from 'web-push';
import twilio from 'twilio';
import cron from 'node-cron';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const CONFIG = {
  LIBRE_EMAIL: process.env.LIBRE_EMAIL,
  LIBRE_PASSWORD: process.env.LIBRE_PASSWORD,
  LIBRE_REGION: process.env.LIBRE_REGION || 'la',
  TWILIO_SID: process.env.TWILIO_SID,
  TWILIO_TOKEN: process.env.TWILIO_TOKEN,
  TWILIO_WHATSAPP_FROM: process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886',
  TWILIO_PHONE_FROM: process.env.TWILIO_PHONE_FROM,
  VAPID_PUBLIC: process.env.VAPID_PUBLIC,
  VAPID_PRIVATE: process.env.VAPID_PRIVATE,
  VAPID_EMAIL: process.env.VAPID_EMAIL || 'mailto:you@example.com',
  GLUCOSE_THRESHOLD: parseInt(process.env.GLUCOSE_THRESHOLD) || 60,
  LOW_DURATION_MINS: parseInt(process.env.LOW_DURATION_MINS) || 30,
  ALARM_GAP_MINS: parseInt(process.env.ALARM_GAP_MINS) || 15,
  WA_WINDOW_MINS: parseInt(process.env.WA_WINDOW_MINS) || 5,
  CALL_ATTEMPTS: parseInt(process.env.CALL_ATTEMPTS) || 2,
  CALL_GAP_SECS: parseInt(process.env.CALL_GAP_SECS) || 30,
};

const LIBRE_BASE_URLS = {
  la: 'https://api-la.libreview.io',
  EU: 'https://api-eu.libreview.io',
  US: 'https://api.libreview.io',
  ap: 'https://api-ap.libreview.io',
  au: 'https://api-au.libreview.io',
  de: 'https://api-de.libreview.io',
};

const LIBRE_HEADERS = {
  'Content-Type': 'application/json',
  'product': 'llu.android',
  'version': '4.16.0',
  'Accept-Encoding': 'gzip',
  'Cache-Control': 'no-cache',
  'Connection': 'Keep-Alive',
};

let libre = {
  token: null,
  expires: null,
  accountId: null,
  patientId: null,
};

let state = {
  alarm1FiredAt: null,
  alarm2FiredAt: null,
  escalationStartedAt: null,
  responseReceived: false,
  timeLow: 0,
  lastGlucose: null,
  lastTrend: null,
  contacts: [],
  pushSubscriptions: [],
};

const SETTINGS_FILE = path.join(__dirname, '../settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (s.contacts) state.contacts = s.contacts;
      if (s.pushSubscriptions) state.pushSubscriptions = s.pushSubscriptions;
      if (s.threshold) CONFIG.GLUCOSE_THRESHOLD = s.threshold;
      if (s.lowDuration) CONFIG.LOW_DURATION_MINS = s.lowDuration;
      if (s.alarmGap) CONFIG.ALARM_GAP_MINS = s.alarmGap;
      if (s.waWindow) CONFIG.WA_WINDOW_MINS = s.waWindow;
      if (s.callAttempts) CONFIG.CALL_ATTEMPTS = s.callAttempts;
    }
  } catch (e) { console.log('No settings file, using defaults'); }
}

function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
    contacts: state.contacts,
    pushSubscriptions: state.pushSubscriptions,
    threshold: CONFIG.GLUCOSE_THRESHOLD,
    lowDuration: CONFIG.LOW_DURATION_MINS,
    alarmGap: CONFIG.ALARM_GAP_MINS,
    waWindow: CONFIG.WA_WINDOW_MINS,
    callAttempts: CONFIG.CALL_ATTEMPTS,
  }, null, 2));
}

let webPushReady = false;

function setupWebPush() {
  if (CONFIG.VAPID_PUBLIC && CONFIG.VAPID_PRIVATE && CONFIG.VAPID_PUBLIC !== 'placeholder') {
    try {
      webpush.setVapidDetails(CONFIG.VAPID_EMAIL, CONFIG.VAPID_PUBLIC, CONFIG.VAPID_PRIVATE);
      webPushReady = true;
      console.log('Web Push configured');
    } catch (e) { console.warn('VAPID error:', e.message); }
  } else { console.warn('VAPID keys not set'); }
}

async function sendPush(title, body, data) {
  if (!webPushReady || !state.pushSubscriptions.length) return;
  const payload = JSON.stringify(Object.assign({ title, body }, data || {}));
  const results = await Promise.allSettled(
    state.pushSubscriptions.map(sub => webpush.sendNotification(sub, payload))
  );
  state.pushSubscriptions = state.pushSubscriptions.filter((_, i) => results[i].status !== 'rejected');
  saveSettings();
}

async function libreLogin() {
  const base = LIBRE_BASE_URLS[CONFIG.LIBRE_REGION] || LIBRE_BASE_URLS.la;
  console.log('Logging into LibreLinkUp, region:', CONFIG.LIBRE_REGION, 'base:', base);
  const res = await fetch(base + '/llu/auth/login', {
    method: 'POST',
    headers: LIBRE_HEADERS,
    body: JSON.stringify({ email: CONFIG.LIBRE_EMAIL, password: CONFIG.LIBRE_PASSWORD }),
  });
  const data = await res.json();
  if (data && data.data && data.data.redirect && data.data.region) {
    CONFIG.LIBRE_REGION = data.data.region;
    console.log('Redirected to region:', CONFIG.LIBRE_REGION);
    return libreLogin();
  }
  if (data && data.data && data.data.authTicket && data.data.authTicket.token) {
    libre.token = data.data.authTicket.token;
    libre.expires = Date.now() + (data.data.authTicket.duration * 1000);
    libre.accountId = data.data.user && data.data.user.id;
    // account-id must be SHA256 of user id
    if (libre.accountId) {
      const { createHash } = await import("crypto");
      libre.accountIdHash = createHash("sha256").update(libre.accountId).digest("hex");
    }
    // Extract jti from JWT as alternative account-id
    try {
      const jwt = libre.token.split('.')[1];
      const decoded = JSON.parse(Buffer.from(jwt, 'base64').toString());
      libre.jti = decoded.jti;
      libre.sid = decoded.sid;
    } catch (e) {}
    console.log('Login successful, accountId:', libre.accountId);
    return true;
  }
  console.error('Login failed:', JSON.stringify(data));
  return false;
}

async function fetchConnections() {
  const base = LIBRE_BASE_URLS[CONFIG.LIBRE_REGION] || LIBRE_BASE_URLS.la;
  // Try different account-id candidates
  const candidates = [libre.accountIdHash, libre.accountId].filter(Boolean);
  for (const accountId of candidates) {
    const headers = Object.assign({}, LIBRE_HEADERS, {
      'Authorization': 'Bearer ' + libre.token,
      'account-id': accountId,
    });
    const res = await fetch(base + '/llu/connections', { headers });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) {
      console.error('Non-JSON response:', text.substring(0, 100));
      continue;
    }
    if (data.message === 'AccountIdMismatch') {
      console.log('AccountIdMismatch with:', accountId, '- trying next');
      continue;
    }
    if (data.data && Array.isArray(data.data)) {
      console.log('Connections success with account-id:', accountId);
      return data;
    }
    console.log('Unexpected response with', accountId, ':', JSON.stringify(data).substring(0, 100));
  }
  return null;
}

async function getGlucoseReading() {
  if (!libre.token || Date.now() > libre.expires) {
    const ok = await libreLogin();
    if (!ok) return null;
  }
  try {
    const data = await fetchConnections();
    if (!data) {
      console.log('No connection data, re-logging in');
      libre.token = null;
      return null;
    }
    const connection = data.data[0];
    if (!connection) { console.log('No connections found'); return null; }
    
    // Try glucoseMeasurement first, fall back to currentMeasurement
    const reading = connection.glucoseMeasurement || connection.currentMeasurement;
    if (!reading) { console.log('No reading in connection'); return null; }
    
    const trendMap = { 1: 'down', 2: 'down', 3: 'stable', 4: 'up', 5: 'up' };
    const glucose = reading.Value || reading.value;
    const trendRaw = reading.TrendArrow || reading.trendArrow;
    const trend = trendMap[trendRaw] || 'stable';
    console.log('Got glucose:', glucose, 'trend:', trend);
    return { glucose, trend };
  } catch (e) {
    console.error('Error fetching glucose:', e.message);
    return null;
  }
}

function getTwilio() {
  if (!CONFIG.TWILIO_SID || !CONFIG.TWILIO_TOKEN) return null;
  return twilio(CONFIG.TWILIO_SID, CONFIG.TWILIO_TOKEN);
}

const WA_MSG = 'This is an automated message from MS: I am running low on sugar and need aid. Please call me to try and wake me up.';

async function sendWhatsAppToTop3() {
  const client = getTwilio();
  if (!client) return;
  const top3 = state.contacts.slice(0, 3).filter(c => c.phone);
  for (const c of top3) {
    try {
      await client.messages.create({ from: CONFIG.TWILIO_WHATSAPP_FROM, to: 'whatsapp:' + c.phone, body: WA_MSG });
      console.log('WhatsApp sent to', c.name);
    } catch (e) { console.error('WhatsApp failed:', c.name, e.message); }
  }
}

async function callContact(contact, attempt) {
  const client = getTwilio();
  if (!client || !CONFIG.TWILIO_PHONE_FROM) return;
  try {
    const twiml = '<Response><Say voice="alice" language="es-ES">Hola. Mensaje automatico. La persona tiene el azucar muy baja y puede estar inconsciente. Por favor llamala inmediatamente.</Say></Response>';
    await client.calls.create({ from: CONFIG.TWILIO_PHONE_FROM, to: contact.phone, twiml });
    console.log('Called', contact.name, 'attempt', attempt);
  } catch (e) { console.error('Call failed:', contact.name, e.message); }
}

async function runCallEscalation() {
  const contacts = state.contacts.filter(c => c.phone);
  for (const c of contacts) {
    for (let i = 1; i <= CONFIG.CALL_ATTEMPTS; i++) {
      await callContact(c, i);
      if (i < CONFIG.CALL_ATTEMPTS) await sleep(CONFIG.CALL_GAP_SECS * 1000);
    }
    await sleep(5000);
  }
}

async function checkGlucoseAndAlarm() {
  const reading = await getGlucoseReading();
  if (!reading) return;
  const { glucose, trend } = reading;
  state.lastGlucose = glucose;
  state.lastTrend = trend;
  console.log('Glucose:', glucose, 'mg/dL Trend:', trend, 'TimeLow:', state.timeLow, 'min');
  if (glucose < CONFIG.GLUCOSE_THRESHOLD) {
    state.timeLow += 5;
  } else {
    if (state.alarm1FiredAt) resetAlarmState();
    return;
  }
  const shouldAlarm1 = !state.alarm1FiredAt && (
    state.timeLow >= CONFIG.LOW_DURATION_MINS ||
    (trend === 'down' && state.timeLow >= 5)
  );
  if (shouldAlarm1) {
    state.alarm1FiredAt = Date.now();
    await sendPush('Low glucose - eat something now', 'Glucose is ' + glucose + ' mg/dL. Drink juice or take glucose tablets.', { type: 'alarm1', glucose, trend });
    setTimeout(checkAlarm2, CONFIG.ALARM_GAP_MINS * 60 * 1000);
  }
}

async function checkAlarm2() {
  const reading = await getGlucoseReading();
  const glucose = reading ? reading.glucose : state.lastGlucose;
  const trend = reading ? reading.trend : state.lastTrend;
  if (glucose >= CONFIG.GLUCOSE_THRESHOLD) {
    resetAlarmState();
    await sendPush('Glucose recovered', 'Glucose is now ' + glucose + ' mg/dL.', { type: 'recovered' });
    return;
  }
  state.alarm2FiredAt = Date.now();
  await sendPush('Glucose still low - open app now', 'Glucose is ' + glucose + ' mg/dL. Consciousness check required.', { type: 'alarm2', glucose, trend, urgent: true });
  setTimeout(async () => {
    if (!state.responseReceived && state.alarm2FiredAt) await triggerEscalation();
  }, (CONFIG.WA_WINDOW_MINS + 2) * 60 * 1000);
}

async function triggerEscalation() {
  if (state.escalationStartedAt) return;
  state.escalationStartedAt = Date.now();
  await sendWhatsAppToTop3();
  await sleep(CONFIG.WA_WINDOW_MINS * 60 * 1000);
  if (state.responseReceived) return;
  await runCallEscalation();
}

function resetAlarmState() {
  state.alarm1FiredAt = null;
  state.alarm2FiredAt = null;
  state.escalationStartedAt = null;
  state.responseReceived = false;
  state.timeLow = 0;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.get('/api/health', (req, res) => res.json({
  ok: true, lastGlucose: state.lastGlucose, lastTrend: state.lastTrend,
  timeLow: state.timeLow, alarm1Active: !!state.alarm1FiredAt,
  alarm2Active: !!state.alarm2FiredAt, escalationActive: !!state.escalationStartedAt,
  responseReceived: state.responseReceived, contactCount: state.contacts.length,
  pushSubscriptions: state.pushSubscriptions.length, region: CONFIG.LIBRE_REGION,
}));

app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid' });
  if (!state.pushSubscriptions.some(s => s.endpoint === sub.endpoint)) {
    state.pushSubscriptions.push(sub); saveSettings();
  }
  res.json({ ok: true });
});

app.post('/api/alarm/conscious', (req, res) => {
  state.responseReceived = true; resetAlarmState(); res.json({ ok: true });
});

app.post('/api/escalate', async (req, res) => {
  res.json({ ok: true });
  if (!state.escalationStartedAt) await triggerEscalation();
});

app.post('/api/twilio/reply', (req, res) => {
  state.responseReceived = true;
  sendPush('Contact replied', 'Help is on the way.', { type: 'reply' });
  res.set('Content-Type', 'text/xml').send('<Response></Response>');
});

app.post('/api/settings', (req, res) => {
  const b = req.body;
  if (b.contacts) state.contacts = b.contacts;
  if (b.threshold) CONFIG.GLUCOSE_THRESHOLD = b.threshold;
  if (b.lowDuration) CONFIG.LOW_DURATION_MINS = b.lowDuration;
  if (b.alarmGap) CONFIG.ALARM_GAP_MINS = b.alarmGap;
  if (b.waWindow) CONFIG.WA_WINDOW_MINS = b.waWindow;
  if (b.callAttempts) CONFIG.CALL_ATTEMPTS = b.callAttempts;
  saveSettings(); res.json({ ok: true });
});

app.get('/api/settings', (req, res) => res.json({
  contacts: state.contacts, threshold: CONFIG.GLUCOSE_THRESHOLD,
  lowDuration: CONFIG.LOW_DURATION_MINS, alarmGap: CONFIG.ALARM_GAP_MINS,
  waWindow: CONFIG.WA_WINDOW_MINS, callAttempts: CONFIG.CALL_ATTEMPTS,
}));

app.get('/api/push/vapid-keys', (req, res) => res.json(webpush.generateVAPIDKeys()));

cron.schedule('*/5 * * * *', async () => {
  console.log('Polling LibreLinkUp...');
  await checkGlucoseAndAlarm();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('Glucosa Alert running on port', PORT);
  setupWebPush();
  loadSettings();
  await checkGlucoseAndAlarm();
});
