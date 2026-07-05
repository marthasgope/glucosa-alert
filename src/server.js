import express from 'express';
import webpush from 'web-push';
import twilio from 'twilio';
import cron from 'node-cron';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

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
  MY_PHONE: process.env.MY_PHONE,
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

let libre = { token: null, expires: null, accountId: null, accountIdHash: null };

let state = {
  alarm1FiredAt: null,
  alarm2FiredAt: null,
  escalationStartedAt: null,
  responseReceived: false,
  selfCallAnswered: false,
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
  }
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
  console.log('Logging in, region:', CONFIG.LIBRE_REGION);
  const res = await fetch(base + '/llu/auth/login', {
    method: 'POST',
    headers: LIBRE_HEADERS,
    body: JSON.stringify({ email: CONFIG.LIBRE_EMAIL, password: CONFIG.LIBRE_PASSWORD }),
  });
  const data = await res.json();
  if (data && data.data && data.data.redirect && data.data.region) {
    CONFIG.LIBRE_REGION = data.data.region;
    return libreLogin();
  }
  if (data && data.data && data.data.authTicket && data.data.authTicket.token) {
    libre.token = data.data.authTicket.token;
    libre.expires = Date.now() + (data.data.authTicket.duration * 1000);
    libre.accountId = data.data.user && data.data.user.id;
    if (libre.accountId) {
      libre.accountIdHash = createHash('sha256').update(libre.accountId).digest('hex');
    }
    console.log('Login successful');
    return true;
  }
  console.error('Login failed:', JSON.stringify(data));
  return false;
}

async function fetchConnections() {
  const base = LIBRE_BASE_URLS[CONFIG.LIBRE_REGION] || LIBRE_BASE_URLS.la;
  const headers = Object.assign({}, LIBRE_HEADERS, {
    'Authorization': 'Bearer ' + libre.token,
    'account-id': libre.accountIdHash,
  });
  const res = await fetch(base + '/llu/connections', { headers });
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) {
    console.error('Non-JSON response:', text.substring(0, 100));
    return null;
  }
}

async function getGlucoseReading() {
  if (!libre.token || Date.now() > libre.expires) {
    const ok = await libreLogin();
    if (!ok) return null;
  }
  try {
    const data = await fetchConnections();
    if (!data || !data.data || !Array.isArray(data.data)) {
      console.log('No connection data, re-logging in');
      libre.token = null;
      return null;
    }
    const connection = data.data[0];
    if (!connection) { console.log('No connections'); return null; }
    const reading = connection.glucoseMeasurement || connection.currentMeasurement;
    if (!reading) { console.log('No reading'); return null; }
    const trendMap = { 1: 'down', 2: 'down', 3: 'stable', 4: 'up', 5: 'up' };
    const glucose = reading.Value || reading.value;
    const trend = trendMap[reading.TrendArrow || reading.trendArrow] || 'stable';
    console.log('Glucose:', glucose, 'Trend:', trend);
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

// ── CALL SELF FIRST ──
// When Alarm 2 fires, call Martha's own phone with a loud alarm.
// TwiML says "Press 1 if you are ok. If you do not respond, your contacts will be called."
// If she presses 1 → /api/twilio/self-call-ok → cancel escalation
// If no response → escalate to contacts after timeout
async function callSelf(glucose) {
  const client = getTwilio();
  if (!client || !CONFIG.TWILIO_PHONE_FROM || !CONFIG.MY_PHONE) {
    console.warn('Self-call not configured - missing MY_PHONE or TWILIO_PHONE_FROM');
    return false;
  }
  try {
    const serverUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
      : 'https://glucosa-alert-production.up.railway.app';

    const twiml = `<Response>
      <Say voice="alice" language="es-ES">
        Alerta de glucosa baja. Tu nivel es ${glucose} miligramos. 
        Necesitas comer algo ahora. 
        Pulsa el uno si estas consciente y bien.
        Si no respondes en 30 segundos, se llamara a tus contactos de emergencia.
      </Say>
      <Gather numDigits="1" action="${serverUrl}/api/twilio/self-call-response" timeout="30">
        <Say voice="alice" language="es-ES">Pulsa el uno para confirmar que estas bien.</Say>
      </Gather>
      <Say voice="alice" language="es-ES">No se recibio respuesta. Llamando a tus contactos de emergencia.</Say>
      <Redirect>${serverUrl}/api/twilio/escalate-now</Redirect>
    </Response>`;

    await client.calls.create({
      from: CONFIG.TWILIO_PHONE_FROM,
      to: CONFIG.MY_PHONE,
      twiml,
    });
    console.log('Self-call initiated to', CONFIG.MY_PHONE);
    return true;
  } catch (e) {
    console.error('Self-call failed:', e.message);
    return false;
  }
}

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
  if (!contacts.length) { console.log('No contacts configured'); return; }
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
    console.log('ALARM 1 firing');
    await sendPush(
      'Low glucose - eat something now',
      'Glucose is ' + glucose + ' mg/dL. Drink juice or take glucose tablets.',
      { type: 'alarm1', glucose, trend }
    );
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
  state.selfCallAnswered = false;
  console.log('ALARM 2 firing - calling self first');

  // Send push notification AND call the phone simultaneously
  await sendPush(
    'Glucose still low - WAKE UP',
    'Glucose is ' + glucose + ' mg/dL. Your phone is ringing — answer and press 1 if you are ok.',
    { type: 'alarm2', glucose, trend, urgent: true }
  );

  // Call Martha's own phone
  const selfCallOk = await callSelf(glucose);

  // If self-call not configured, fall back to auto-escalate after timeout
  if (!selfCallOk) {
    setTimeout(async () => {
      if (!state.responseReceived && state.alarm2FiredAt) {
        console.log('No self-call configured, auto-escalating');
        await triggerEscalation();
      }
    }, (CONFIG.WA_WINDOW_MINS + 2) * 60 * 1000);
  }
  // If self-call IS configured, escalation is handled by the Twilio webhook responses
}

async function triggerEscalation() {
  if (state.escalationStartedAt) return;
  state.escalationStartedAt = Date.now();
  console.log('ESCALATION starting - sending WhatsApp then calling contacts');
  await sendWhatsAppToTop3();
  await sleep(CONFIG.WA_WINDOW_MINS * 60 * 1000);
  if (state.responseReceived) { console.log('Response received, skipping calls'); return; }
  await runCallEscalation();
}

function resetAlarmState() {
  state.alarm1FiredAt = null;
  state.alarm2FiredAt = null;
  state.escalationStartedAt = null;
  state.responseReceived = false;
  state.selfCallAnswered = false;
  state.timeLow = 0;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── API ROUTES ──

app.get('/api/health', (req, res) => res.json({
  ok: true, lastGlucose: state.lastGlucose, lastTrend: state.lastTrend,
  timeLow: state.timeLow, alarm1Active: !!state.alarm1FiredAt,
  alarm2Active: !!state.alarm2FiredAt, escalationActive: !!state.escalationStartedAt,
  responseReceived: state.responseReceived, contactCount: state.contacts.length,
  pushSubscriptions: state.pushSubscriptions.length, region: CONFIG.LIBRE_REGION,
  myPhoneConfigured: !!CONFIG.MY_PHONE,
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
  console.log('User confirmed conscious via app');
  state.responseReceived = true; resetAlarmState(); res.json({ ok: true });
});

// Twilio webhook: called when Martha presses 1 during self-call
app.post('/api/twilio/self-call-response', (req, res) => {
  const digit = req.body && req.body.Digits;
  console.log('Self-call response digit:', digit);
  if (digit === '1') {
    console.log('Martha confirmed conscious via phone call');
    state.responseReceived = true;
    state.selfCallAnswered = true;
    resetAlarmState();
    sendPush('You confirmed ok', 'Alarm cancelled. Stay safe!', { type: 'conscious' });
    res.set('Content-Type', 'text/xml');
    res.send('<Response><Say voice="alice" language="es-ES">Perfecto. Alarma cancelada. Cudate mucho.</Say></Response>');
  } else {
    res.set('Content-Type', 'text/xml');
    res.send('<Response><Say voice="alice" language="es-ES">No se recibio respuesta correcta. Llamando a tus contactos.</Say></Response>');
    // Trigger escalation
    setTimeout(() => triggerEscalation(), 2000);
  }
});

// Twilio webhook: called when self-call times out with no response
app.post('/api/twilio/escalate-now', async (req, res) => {
  console.log('Self-call timed out, escalating to contacts');
  res.set('Content-Type', 'text/xml');
  res.send('<Response><Say voice="alice" language="es-ES">Llamando a tus contactos de emergencia ahora.</Say></Response>');
  if (!state.responseReceived) await triggerEscalation();
});

app.post('/api/escalate', async (req, res) => {
  res.json({ ok: true });
  if (!state.escalationStartedAt) await triggerEscalation();
});

app.post('/api/twilio/reply', (req, res) => {
  console.log('WhatsApp reply received from contact');
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
