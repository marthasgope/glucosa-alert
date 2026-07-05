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

// ── CONFIG (set these in Railway environment variables) ──
const CONFIG = {
  // LibreLinkUp
  LIBRE_EMAIL: process.env.LIBRE_EMAIL,
  LIBRE_PASSWORD: process.env.LIBRE_PASSWORD,
  LIBRE_REGION: process.env.LIBRE_REGION || 'EU', // EU or US

  // Twilio
  TWILIO_SID: process.env.TWILIO_SID,
  TWILIO_TOKEN: process.env.TWILIO_TOKEN,
  TWILIO_WHATSAPP_FROM: process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886',
  TWILIO_PHONE_FROM: process.env.TWILIO_PHONE_FROM,

  // Web Push
  VAPID_PUBLIC: process.env.VAPID_PUBLIC,
  VAPID_PRIVATE: process.env.VAPID_PRIVATE,
  VAPID_EMAIL: process.env.VAPID_EMAIL || 'mailto:you@example.com',

  // Alarm settings (can be overridden via /api/settings)
  GLUCOSE_THRESHOLD: parseInt(process.env.GLUCOSE_THRESHOLD) || 60,
  LOW_DURATION_MINS: parseInt(process.env.LOW_DURATION_MINS) || 30,
  ALARM_GAP_MINS: parseInt(process.env.ALARM_GAP_MINS) || 15,
  WA_WINDOW_MINS: parseInt(process.env.WA_WINDOW_MINS) || 5,
  CALL_ATTEMPTS: parseInt(process.env.CALL_ATTEMPTS) || 2,
  CALL_GAP_SECS: parseInt(process.env.CALL_GAP_SECS) || 30,
};

// ── STATE (in-memory, resets on server restart) ──
let state = {
  alarm1FiredAt: null,
  alarm2FiredAt: null,
  escalationStartedAt: null,
  responseReceived: false,
  timeLow: 0,           // consecutive minutes below threshold
  lastGlucose: null,
  lastTrend: null,
  contacts: [],         // loaded from settings.json
  pushSubscriptions: [], // registered iPhone subscriptions
  libreToken: null,
  libreTokenExpiry: null,
};

// ── SETTINGS persistence ──
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

// ── WEB PUSH SETUP ──
function setupWebPush() {
  if (CONFIG.VAPID_PUBLIC && CONFIG.VAPID_PRIVATE) {
    webpush.setVapidDetails(
      CONFIG.VAPID_EMAIL,
      CONFIG.VAPID_PUBLIC,
      CONFIG.VAPID_PRIVATE
    );
    console.log('✅ Web Push configured');
  } else {
    console.warn('⚠️  VAPID keys not set — push notifications disabled');
  }
}

async function sendPushNotification(title, body, data = {}) {
  if (!state.pushSubscriptions.length) {
    console.log('No push subscriptions registered');
    return;
  }
  const payload = JSON.stringify({ title, body, ...data });
  const results = await Promise.allSettled(
    state.pushSubscriptions.map(sub => webpush.sendNotification(sub, payload))
  );
  // Remove expired subscriptions
  state.pushSubscriptions = state.pushSubscriptions.filter((_, i) => {
    if (results[i].status === 'rejected') {
      console.log('Removing expired push subscription');
      return false;
    }
    return true;
  });
  saveSettings();
}

// ── LIBRE LINK UP ──
const LIBRE_URLS = {
  EU: 'https://api-eu.libreview.io',
  US: 'https://api.libreview.io',
};

async function libreLogin() {
  const base = LIBRE_URLS[CONFIG.LIBRE_REGION] || LIBRE_URLS.EU;
  try {
    const res = await fetch(`${base}/llu/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'product': 'llu.android',
        'version': '4.7.0',
      },
      body: JSON.stringify({ email: CONFIG.LIBRE_EMAIL, password: CONFIG.LIBRE_PASSWORD }),
    });
    const data = await res.json();
    if (data?.data?.authTicket?.token) {
      state.libreToken = data.data.authTicket.token;
      state.libreTokenExpiry = Date.now() + (data.data.authTicket.duration * 1000);
      console.log('✅ LibreLinkUp login successful');
      return true;
    }
    console.error('LibreLinkUp login failed:', data?.error || 'unknown error');
    return false;
  } catch (e) {
    console.error('LibreLinkUp login error:', e.message);
    return false;
  }
}

async function getGlucoseReading() {
  // Re-login if token expired or missing
  if (!state.libreToken || Date.now() > state.libreTokenExpiry) {
    const ok = await libreLogin();
    if (!ok) return null;
  }
  const base = LIBRE_URLS[CONFIG.LIBRE_REGION] || LIBRE_URLS.EU;
  try {
    const res = await fetch(`${base}/llu/connections`, {
      headers: {
        'Authorization': `Bearer ${state.libreToken}`,
        'product': 'llu.android',
        'version': '4.7.0',
      },
    });
    const data = await res.json();
    const connection = data?.data?.[0];
    if (!connection) return null;

    const reading = connection.glucoseMeasurement;
    const trendMap = { 1: 'down', 2: 'down', 3: 'stable', 4: 'up', 5: 'up' };
    return {
      glucose: reading.Value,
      trend: trendMap[reading.TrendArrow] || 'stable',
      timestamp: reading.FactoryTimestamp,
    };
  } catch (e) {
    console.error('Error fetching glucose:', e.message);
    return null;
  }
}

// ── TWILIO ──
function getTwilioClient() {
  if (!CONFIG.TWILIO_SID || !CONFIG.TWILIO_TOKEN) return null;
  return twilio(CONFIG.TWILIO_SID, CONFIG.TWILIO_TOKEN);
}

const WA_MESSAGE = "This is an automated message from MS: I am running low on sugar and need aid. Please call me to try and wake me up.";

async function sendWhatsAppToTop3() {
  const client = getTwilioClient();
  if (!client) { console.warn('Twilio not configured'); return; }
  const top3 = state.contacts.slice(0, 3).filter(c => c.phone);
  for (const contact of top3) {
    try {
      await client.messages.create({
        from: CONFIG.TWILIO_WHATSAPP_FROM,
        to: `whatsapp:${contact.phone}`,
        body: WA_MESSAGE,
      });
      console.log(`✅ WhatsApp sent to ${contact.name}`);
    } catch (e) {
      console.error(`WhatsApp to ${contact.name} failed:`, e.message);
    }
  }
}

async function callContact(contact, attempt) {
  const client = getTwilioClient();
  if (!client || !CONFIG.TWILIO_PHONE_FROM) { console.warn('Twilio calls not configured'); return false; }
  try {
    const twiml = `<Response><Say voice="alice" language="es-ES">Hola. Este es un mensaje automático. La persona a quien intentas contactar tiene el azúcar muy baja y puede estar inconsciente. Por favor llámala inmediatamente o ve a su ubicación.</Say><Pause length="2"/><Say voice="alice" language="es-ES">Repetimos. Azúcar baja. Por favor actúa de inmediato.</Say></Response>`;
    await client.calls.create({
      from: CONFIG.TWILIO_PHONE_FROM,
      to: contact.phone,
      twiml,
    });
    console.log(`📞 Called ${contact.name} (attempt ${attempt})`);
    return true;
  } catch (e) {
    console.error(`Call to ${contact.name} failed:`, e.message);
    return false;
  }
}

async function runCallEscalation() {
  const contacts = state.contacts.filter(c => c.phone);
  for (const contact of contacts) {
    for (let attempt = 1; attempt <= CONFIG.CALL_ATTEMPTS; attempt++) {
      await callContact(contact, attempt);
      if (attempt < CONFIG.CALL_ATTEMPTS) {
        await sleep(CONFIG.CALL_GAP_SECS * 1000);
      }
    }
    // Small gap between contacts
    await sleep(5000);
  }
}

// ── ALARM LOGIC ──
async function checkGlucoseAndAlarm() {
  const reading = await getGlucoseReading();
  if (!reading) {
    console.log('No reading available');
    return;
  }

  const { glucose, trend } = reading;
  state.lastGlucose = glucose;
  state.lastTrend = trend;
  const threshold = CONFIG.GLUCOSE_THRESHOLD;

  console.log(`📊 Glucose: ${glucose} mg/dL, Trend: ${trend}, TimeLow: ${state.timeLow}min`);

  if (glucose < threshold) {
    state.timeLow += 5;
  } else {
    // Glucose recovered — reset alarm state
    if (state.alarm1FiredAt) {
      console.log('✅ Glucose recovered, resetting alarm state');
      state.alarm1FiredAt = null;
      state.alarm2FiredAt = null;
      state.escalationStartedAt = null;
      state.responseReceived = false;
      state.timeLow = 0;
    }
    return;
  }

  const isFallingFast = trend === 'down';
  const lowLongEnough = state.timeLow >= CONFIG.LOW_DURATION_MINS;
  const shouldFireAlarm1 = !state.alarm1FiredAt && (lowLongEnough || (glucose < threshold && isFallingFast && state.timeLow >= 5));

  // ── ALARM 1 ──
  if (shouldFireAlarm1) {
    state.alarm1FiredAt = Date.now();
    console.log('🔔 ALARM 1 firing');
    await sendPushNotification(
      '🔔 Low glucose — eat something now',
      `Glucose is ${glucose} mg/dL and ${trend === 'down' ? 'falling' : 'has been low for ' + state.timeLow + ' min'}. Drink juice or take glucose tablets.`,
      { type: 'alarm1', glucose, trend }
    );
    // Schedule Alarm 2 check
    setTimeout(checkAlarm2, CONFIG.ALARM_GAP_MINS * 60 * 1000);
    return;
  }

  // Already in alarm flow — don't re-trigger
  if (state.alarm1FiredAt) {
    console.log('Already in alarm flow, waiting for Alarm 2 check');
  }
}

async function checkAlarm2() {
  const reading = await getGlucoseReading();
  const glucose = reading?.glucose || state.lastGlucose;
  const trend = reading?.trend || state.lastTrend;

  if (glucose >= CONFIG.GLUCOSE_THRESHOLD) {
    console.log('✅ Glucose recovered before Alarm 2 — skipping');
    resetAlarmState();
    await sendPushNotification(
      '✅ Glucose recovered',
      `Glucose is now ${glucose} mg/dL. Alarm cancelled.`,
      { type: 'recovered' }
    );
    return;
  }

  state.alarm2FiredAt = Date.now();
  console.log('⚠️ ALARM 2 firing — consciousness check');
  await sendPushNotification(
    '⚠️ Glucose still low — open app now',
    `Glucose is ${glucose} mg/dL. You must pass the consciousness check or your contacts will be called.`,
    { type: 'alarm2', glucose, trend, urgent: true }
  );

  // Give user time to pass consciousness check in the app (timeout = WA window)
  // Escalation is triggered manually from the app via /api/escalate
  // But if no response at all, auto-escalate after waWindow + 2min buffer
  setTimeout(async () => {
    if (!state.responseReceived && state.alarm2FiredAt) {
      console.log('⚠️ No consciousness check response — auto-escalating');
      await triggerEscalation();
    }
  }, (CONFIG.WA_WINDOW_MINS + 2) * 60 * 1000);
}

async function triggerEscalation() {
  if (state.escalationStartedAt) return; // already running
  state.escalationStartedAt = Date.now();
  state.responseReceived = false;
  console.log('🚨 ESCALATION starting');

  // Phase 3: WhatsApp to top 3
  await sendWhatsAppToTop3();

  // Wait for response window
  await sleep(CONFIG.WA_WINDOW_MINS * 60 * 1000);

  if (state.responseReceived) {
    console.log('✅ Response received — skipping calls');
    return;
  }

  // Phase 4: Calls in order
  console.log('📞 No reply — starting calls');
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

// ── API ROUTES ──

// Health check
app.get('/api/health', (req, res) => {
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

// Register push subscription from iPhone web app
app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  // Avoid duplicates
  const exists = state.pushSubscriptions.some(s => s.endpoint === sub.endpoint);
  if (!exists) {
    state.pushSubscriptions.push(sub);
    saveSettings();
  }
  res.json({ ok: true });
});

// App reports consciousness check passed — cancel alarm
app.post('/api/alarm/conscious', (req, res) => {
  console.log('✅ User confirmed conscious');
  state.responseReceived = true;
  resetAlarmState();
  res.json({ ok: true });
});

// App triggers escalation (failed consciousness check)
app.post('/api/escalate', async (req, res) => {
  res.json({ ok: true }); // respond immediately
  if (!state.escalationStartedAt) {
    await triggerEscalation();
  }
});

// Contact replied via WhatsApp — webhook from Twilio
app.post('/api/twilio/reply', (req, res) => {
  console.log('💬 WhatsApp reply received from contact');
  state.responseReceived = true;
  sendPushNotification(
    '💬 Contact replied',
    'A contact replied to your WhatsApp — help is on the way.',
    { type: 'reply' }
  );
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

// Save settings + contacts from the web app
app.post('/api/settings', (req, res) => {
  const { contacts, threshold, lowDuration, alarmGap, waWindow, callAttempts } = req.body;
  if (contacts) state.contacts = contacts;
  if (threshold) CONFIG.GLUCOSE_THRESHOLD = threshold;
  if (lowDuration) CONFIG.LOW_DURATION_MINS = lowDuration;
  if (alarmGap) CONFIG.ALARM_GAP_MINS = alarmGap;
  if (waWindow) CONFIG.WA_WINDOW_MINS = waWindow;
  if (callAttempts) CONFIG.CALL_ATTEMPTS = callAttempts;
  saveSettings();
  res.json({ ok: true });
});

// Get current settings
app.get('/api/settings', (req, res) => {
  res.json({
    contacts: state.contacts,
    threshold: CONFIG.GLUCOSE_THRESHOLD,
    lowDuration: CONFIG.LOW_DURATION_MINS,
    alarmGap: CONFIG.ALARM_GAP_MINS,
    waWindow: CONFIG.WA_WINDOW_MINS,
    callAttempts: CONFIG.CALL_ATTEMPTS,
  });
});

// Generate VAPID keys (run once to get your keys)
app.get('/api/push/vapid-keys', (req, res) => {
  const keys = webpush.generateVAPIDKeys();
  res.json(keys);
});

// ── CRON: poll glucose every 5 minutes ──
cron.schedule('*/5 * * * *', async () => {
  console.log('⏱  Polling LibreLinkUp...');
  await checkGlucoseAndAlarm();
});

// ── START ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Glucosa Alert server running on port ${PORT}`);
  setupWebPush();
  loadSettings();
  // Initial glucose check on startup
  await checkGlucoseAndAlarm();
});
