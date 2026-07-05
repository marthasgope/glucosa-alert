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
  LIBRE_REGION: process.env.LIBRE_REGION || 'EU',
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
  libreToken: null,
  libreTokenExpiry: null,
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
  } catch (e) {
    console.log('No settings file yet, using defaults');
  }
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
  if (CONFIG.VAPID_PUBLIC && CONFIG.VAPID_PRIVATE) {
    try {
      webpush.setVapidDetails(CONFIG.VAPID_EMAIL, CONFIG.VAPID_PUBLIC, CONFIG.VAPID_PRIVATE);
      webPushReady = true;
      console.log('Web Push configured');
    } catch (e) {
      console.warn('VAPID key error - push disabled:', e.message);
    }
  } else {
    console.warn('VAPID keys not set - push disabled');
  }
}

async function sendPushNotification(title, body, data) {
  if (!webPushReady || !state.pushSubscriptions.length) return;
  const payload = JSON.stringify(Object.assign({ title, body }, data || {}));
  const results = await Promise.allSettled(
    state.pushSubscriptions.map(function(sub) { return webpush.sendNotification(sub, payload); })
  );
  state.pushSubscriptions = state.pushSubscriptions.filter(function(_, i) {
    return results[i].status !== 'rejected';
  });
  saveSettings();
}

const LIBRE_URLS = { EU: 'https://api-eu.libreview.io', US: 'https://api.libreview.io', la: 'https://api-la.libreview.io' };
async function libreLogin() {
  const base = LIBRE_URLS[CONFIG.LIBRE_REGION] || LIBRE_URLS.EU;
  try {
    const res = await fetch(base + '/llu/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'product': 'llu.android', 'version': '4.7.0' },
      body: JSON.stringify({ email: CONFIG.LIBRE_EMAIL, password: CONFIG.LIBRE_PASSWORD }),
    });
    const data = await res.json();
    if (data && data.data && data.data.authTicket && data.data.authTicket.token) {
      state.libreToken = data.data.authTicket.token;
      state.libreTokenExpiry = Date.now() + (data.data.authTicket.duration * 1000);
      console.log('LibreLinkUp login successful');
      return true;
    }
    console.error('LibreLinkUp login failed');
    return false;
  } catch (e) {
    console.error('LibreLinkUp login error:', e.message);
    return false;
  }
}

async function getGlucoseReading() {
  if (!state.libreToken || Date.now() > state.libreTokenExpiry) {
    const ok = await libreLogin();
    if (!ok) return null;
  }
  const base = LIBRE_URLS[CONFIG.LIBRE_REGION] || LIBRE_URLS.EU;
  try {
    const res = await fetch(base + '/llu/connections', {
      headers: { 'Authorization': 'Bearer ' + state.libreToken, 'product': 'llu.android', 'version': '4.7.0' },
    });
    const data = await res.json();
    const connection = data && data.data && data.data[0];
    if (!connection) return null;
    const reading = connection.glucoseMeasurement;
    const trendMap = { 1: 'down', 2: 'down', 3: 'stable', 4: 'up', 5: 'up' };
    return { glucose: reading.Value, trend: trendMap[reading.TrendArrow] || 'stable' };
  } catch (e) {
    console.error('Error fetching glucose:', e.message);
    return null;
  }
}

function getTwilioClient() {
  if (!CONFIG.TWILIO_SID || !CONFIG.TWILIO_TOKEN) return null;
  return twilio(CONFIG.TWILIO_SID, CONFIG.TWILIO_TOKEN);
}

const WA_MESSAGE = 'This is an automated message from MS: I am running low on sugar and need aid. Please call me to try and wake me up.';

async function sendWhatsAppToTop3() {
  const client = getTwilioClient();
  if (!client) return;
  const top3 = state.contacts.slice(0, 3).filter(function(c) { return c.phone; });
  for (const contact of top3) {
    try {
      await client.messages.create({
        from: CONFIG.TWILIO_WHATSAPP_FROM,
        to: 'whatsapp:' + contact.phone,
        body: WA_MESSAGE,
      });
      console.log('WhatsApp sent to ' + contact.name);
    } catch (e) {
      console.error('WhatsApp failed for ' + contact.name + ': ' + e.message);
    }
  }
}

async function callContact(contact, attempt) {
  const client = getTwilioClient();
  if (!client || !CONFIG.TWILIO_PHONE_FROM) return false;
  try {
    const twiml = '<Response><Say voice="alice" language="es-ES">Hola. Mensaje automatico. La persona tiene el azucar muy baja y puede estar inconsciente. Por favor llamala inmediatamente.</Say></Response>';
    await client.calls.create({ from: CONFIG.TWILIO_PHONE_FROM, to: contact.phone, twiml: twiml });
    console.log('Called ' + contact.name + ' attempt ' + attempt);
    return true;
  } catch (e) {
    console.error('Call failed for ' + contact.name + ': ' + e.message);
    return false;
  }
}

async function runCallEscalation() {
  const contacts = state.contacts.filter(function(c) { return c.phone; });
  for (const contact of contacts) {
    for (let attempt = 1; attempt <= CONFIG.CALL_ATTEMPTS; attempt++) {
      await callContact(contact, attempt);
      if (attempt < CONFIG.CALL_ATTEMPTS) await sleep(CONFIG.CALL_GAP_SECS * 1000);
    }
    await sleep(5000);
  }
}

async function checkGlucoseAndAlarm() {
  const reading = await getGlucoseReading();
  if (!reading) { console.log('No reading available'); return; }
  const glucose = reading.glucose;
  const trend = reading.trend;
  state.lastGlucose = glucose;
  state.lastTrend = trend;
  console.log('Glucose: ' + glucose + ' mg/dL, Trend: ' + trend + ', TimeLow: ' + state.timeLow + 'min');
  if (glucose < CONFIG.GLUCOSE_THRESHOLD) {
    state.timeLow += 5;
  } else {
    if (state.alarm1FiredAt) { console.log('Glucose recovered'); resetAlarmState(); }
    return;
  }
  const isFallingFast = trend === 'down';
  const lowLongEnough = state.timeLow >= CONFIG.LOW_DURATION_MINS;
  const shouldFireAlarm1 = !state.alarm1FiredAt && (lowLongEnough || (isFallingFast && state.timeLow >= 5));
  if (shouldFireAlarm1) {
    state.alarm1FiredAt = Date.now();
    console.log('ALARM 1 firing');
    await sendPushNotification(
      'Low glucose - eat something now',
      'Glucose is ' + glucose + ' mg/dL. Drink juice or take glucose tablets.',
      { type: 'alarm1', glucose: glucose, trend: trend }
    );
    setTimeout(checkAlarm2, CONFIG.ALARM_GAP_MINS * 60 * 1000);
  }
}

async function checkAlarm2() {
  const reading = await getGlucoseReading();
  const glucose = (reading && reading.glucose) || state.lastGlucose;
  const trend = (reading && reading.trend) || state.lastTrend;
  if (glucose >= CONFIG.GLUCOSE_THRESHOLD) {
    console.log('Glucose recovered before Alarm 2');
    resetAlarmState();
    await sendPushNotification('Glucose recovered', 'Glucose is now ' + glucose + ' mg/dL.', { type: 'recovered' });
    return;
  }
  state.alarm2FiredAt = Date.now();
  console.log('ALARM 2 firing');
  await sendPushNotification(
    'Glucose still low - open app now',
    'Glucose is ' + glucose + ' mg/dL. Consciousness check required.',
    { type: 'alarm2', glucose: glucose, trend: trend, urgent: true }
  );
  setTimeout(async function() {
    if (!state.responseReceived && state.alarm2FiredAt) {
      console.log('No response - auto-escalating');
      await triggerEscalation();
    }
  }, (CONFIG.WA_WINDOW_MINS + 2) * 60 * 1000);
}

async function triggerEscalation() {
  if (state.escalationStartedAt) return;
  state.escalationStartedAt = Date.now();
  state.responseReceived = false;
  console.log('ESCALATION starting');
  await sendWhatsAppToTop3();
  await sleep(CONFIG.WA_WINDOW_MINS * 60 * 1000);
  if (state.responseReceived) { console.log('Response received - skipping calls'); return; }
  console.log('No reply - starting calls');
  await runCallEscalation();
}

function resetAlarmState() {
  state.alarm1FiredAt = null;
  state.alarm2FiredAt = null;
  state.escalationStartedAt = null;
  state.responseReceived = false;
  state.timeLow = 0;
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

app.get('/api/health', function(req, res) {
  res.json({
    ok: true,
    lastGlucose: state.lastGlucose,
    lastTrend: state.lastTrend,
    timeLow: state.timeLow,
    alarm1Active: !!state.alarm1FiredAt,
    alarm2Active: !!state.alarm2FiredAt,
    escalationActive: !!state.escalationStartedAt,
    responseReceived: state.responseReceived,
    contactCount: state.contacts.length,
    pushSubscriptions: state.pushSubscriptions.length,
  });
});

app.post('/api/push/subscribe', function(req, res) {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  const exists = state.pushSubscriptions.some(function(s) { return s.endpoint === sub.endpoint; });
  if (!exists) { state.pushSubscriptions.push(sub); saveSettings(); }
  res.json({ ok: true });
});

app.post('/api/alarm/conscious', function(req, res) {
  console.log('User confirmed conscious');
  state.responseReceived = true;
  resetAlarmState();
  res.json({ ok: true });
});

app.post('/api/escalate', async function(req, res) {
  res.json({ ok: true });
  if (!state.escalationStartedAt) await triggerEscalation();
});

app.post('/api/twilio/reply', function(req, res) {
  console.log('WhatsApp reply received');
  state.responseReceived = true;
  sendPushNotification('Contact replied', 'A contact replied - help is on the way.', { type: 'reply' });
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

app.post('/api/settings', function(req, res) {
  const body = req.body;
  if (body.contacts) state.contacts = body.contacts;
  if (body.threshold) CONFIG.GLUCOSE_THRESHOLD = body.threshold;
  if (body.lowDuration) CONFIG.LOW_DURATION_MINS = body.lowDuration;
  if (body.alarmGap) CONFIG.ALARM_GAP_MINS = body.alarmGap;
  if (body.waWindow) CONFIG.WA_WINDOW_MINS = body.waWindow;
  if (body.callAttempts) CONFIG.CALL_ATTEMPTS = body.callAttempts;
  saveSettings();
  res.json({ ok: true });
});

app.get('/api/settings', function(req, res) {
  res.json({
    contacts: state.contacts,
    threshold: CONFIG.GLUCOSE_THRESHOLD,
    lowDuration: CONFIG.LOW_DURATION_MINS,
    alarmGap: CONFIG.ALARM_GAP_MINS,
    waWindow: CONFIG.WA_WINDOW_MINS,
    callAttempts: CONFIG.CALL_ATTEMPTS,
  });
});

app.get('/api/push/vapid-keys', function(req, res) {
  const keys = webpush.generateVAPIDKeys();
  res.json(keys);
});

cron.schedule('*/5 * * * *', async function() {
  console.log('Polling LibreLinkUp...');
  await checkGlucoseAndAlarm();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async function() {
  console.log('Glucosa Alert server running on port ' + PORT);
  setupWebPush();
  loadSettings();
  await checkGlucoseAndAlarm();
});
