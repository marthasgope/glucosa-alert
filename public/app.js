var API = 'https://glucosa-alert-production.up.railway.app';
var VAPID_PUBLIC = 'BOW3pg7qMyKYEdzJv0-zLCOIed44Xg9INih64SIG-u9jHcukQM9ygC_OmpWbRtKxEv3aA6KQ_Zx-xUE_2dicEMs';

var S = {
  glucose: null, trend: 'stable', timeLow: 0,
  alarmActive: false, alarm1Active: false, alarm2Active: false,
  mathAnswer: 0, mathDone: false, currentQ: null,
  mathTimer: null, qTimer: null, a1Interval: null, waTimer: null, escTimer: null,
  responseReceived: false,
  contacts: [],
  cfg: { thresh: 60, dur: 30, trendAlarm: true, gap: 15, timeout: 60, waWindow: 5, attempts: 2 },
  questions: [
    { q: 'Capital of Spain?', opts: ['Madrid','Barcelona','Sevilla','Valencia'], c: 0 },
    { q: 'Days in a week?', opts: ['5','6','7','8'], c: 2 },
    { q: 'Sky color on a clear day?', opts: ['Green','Blue','Red','Yellow'], c: 1 },
    { q: 'Day after Wednesday?', opts: ['Tuesday','Friday','Thursday','Monday'], c: 2 },
    { q: 'Months in a year?', opts: ['10','11','12','13'], c: 2 },
    { q: 'Planet closest to the Sun?', opts: ['Venus','Earth','Mercury','Mars'], c: 2 },
    { q: 'Sides of a triangle?', opts: ['3','4','5','6'], c: 0 },
    { q: 'How many hours in a day?', opts: ['12','24','48','36'], c: 1 },
  ]
};

var WA_MSG = 'This is an automated message from MS: I am running low on sugar and need aid. Please call me to try and wake me up.';

// ── SCREENS ──
function go(id) {
  document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); });
  document.getElementById(id).classList.add('active');
}

function showTab(tab) {
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.getElementById('tab-' + tab).classList.add('active');
  if (tab === 'monitor') go('s-monitor');
  if (tab === 'settings') go('s-settings');
}

// ── SERVER HEALTH POLLING ──
function pollServer() {
  fetch(API + '/api/health')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      document.getElementById('server-status').textContent = 'Connected';
      document.getElementById('server-status').style.color = 'var(--green)';
      document.getElementById('last-poll').textContent = new Date().toLocaleTimeString();
      if (data.lastGlucose) {
        S.glucose = data.lastGlucose;
        S.trend = data.lastTrend || 'stable';
        S.timeLow = data.timeLow || 0;
        updateGlucoseDisplay();
      }
    })
    .catch(function() {
      document.getElementById('server-status').textContent = 'Offline';
      document.getElementById('server-status').style.color = 'var(--red)';
    });
}

function updateGlucoseDisplay() {
  var g = S.glucose;
  if (!g) return;
  var el = document.getElementById('g-num');
  el.textContent = g;
  el.style.color = g < 60 ? 'var(--red)' : g < 70 ? 'var(--yellow)' : g > 180 ? 'var(--yellow)' : 'var(--green)';
  document.getElementById('g-trend').textContent = S.trend === 'up' ? '↑' : S.trend === 'down' ? '↓' : '→';
  document.getElementById('g-time').textContent = 'Updated ' + new Date().toLocaleTimeString();
  document.getElementById('stat-timelow').textContent = S.timeLow + ' min';
  var phase = S.alarm2Active ? 'Alarm 2' : S.alarm1Active ? 'Alarm 1' : '—';
  document.getElementById('stat-phase').textContent = phase;
  var pill = document.getElementById('monitor-status-pill');
  if (g < 60) pill.innerHTML = '<span class="pill pill-red">Low</span>';
  else if (g < 70) pill.innerHTML = '<span class="pill pill-yellow">Borderline</span>';
  else pill.innerHTML = '<span class="pill pill-green">Normal</span>';
}

// ── PUSH NOTIFICATIONS ──
function checkPushStatus() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
  if (Notification.permission === 'default') {
    document.getElementById('push-banner').style.display = 'block';
  }
}

function requestPush() {
  Notification.requestPermission().then(function(perm) {
    if (perm === 'granted') {
      document.getElementById('push-banner').style.display = 'none';
      registerPushSubscription();
    }
  });
}

function urlBase64ToUint8Array(base64String) {
  var padding = '='.repeat((4 - base64String.length % 4) % 4);
  var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  var rawData = window.atob(base64);
  var outputArray = new Uint8Array(rawData.length);
  for (var i = 0; i < rawData.length; ++i) { outputArray[i] = rawData.charCodeAt(i); }
  return outputArray;
}

function registerPushSubscription() {
  navigator.serviceWorker.ready.then(function(reg) {
    return reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC)
    });
  }).then(function(sub) {
    return fetch(API + '/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub)
    });
  }).then(function() {
    console.log('Push subscription registered');
  }).catch(function(e) {
    console.error('Push registration failed:', e);
  });
}

// ── ALARM 1 ──
function triggerAlarm1(reason) {
  S.alarmActive = true; S.alarm1Active = true;
  document.getElementById('a1-reason').textContent = reason || 'Glucose below 60 mg/dL';
  document.getElementById('a1-glucose').textContent = (S.glucose || '--') + ' mg/dL';
  go('s-alarm1');
  startAlarm1Countdown();
  vibrate();
}

function startAlarm1Countdown() {
  clearInterval(S.a1Interval);
  var remaining = S.cfg.gap * 60;
  function fmt(s) { var m = Math.floor(s/60), sec = s%60; return m + ':' + (sec < 10 ? '0' : '') + sec; }
  document.getElementById('a1-cd').textContent = fmt(remaining);
  S.a1Interval = setInterval(function() {
    remaining--;
    document.getElementById('a1-cd').textContent = fmt(remaining);
    if (remaining <= 0) { clearInterval(S.a1Interval); fireAlarm2(); }
  }, 1000);
}

function alarm1Resolved() {
  clearAllTimers();
  S.alarm1Active = false; S.alarmActive = false; S.timeLow = 0;
  fetch(API + '/api/alarm/conscious', { method: 'POST' });
  go('s-monitor'); updateGlucoseDisplay();
}

function updateMidAlarm() {
  var ng = parseInt(document.getElementById('a1-new-g').value);
  if (!ng) return;
  var nt = document.getElementById('a1-new-t').value;
  S.glucose = ng; S.trend = nt;
  document.getElementById('a1-glucose').textContent = ng + ' mg/dL';
  updateGlucoseDisplay();
}

function skipToAlarm2() { clearInterval(S.a1Interval); fireAlarm2(); }

// ── ALARM 2 ──
function fireAlarm2() {
  S.alarm1Active = false; S.alarm2Active = true;
  go('s-alarm2-math');
  showMathCheck();
  vibrate();
}

function showMathCheck() {
  var a = Math.floor(Math.random()*9)+2, b = Math.floor(Math.random()*9)+2;
  S.mathAnswer = a * b; S.mathDone = false;
  document.getElementById('math-q').textContent = a + ' × ' + b + ' = ?';
  document.getElementById('math-ans').value = '';
  document.getElementById('math-fb').style.display = 'none';
  clearInterval(S.mathTimer);
  var t = S.cfg.timeout;
  document.getElementById('math-cd').textContent = t;
  S.mathTimer = setInterval(function() {
    t--;
    document.getElementById('math-cd').textContent = t;
    if (t <= 0) { clearInterval(S.mathTimer); if (!S.mathDone) goEscalate(); }
  }, 1000);
}

function checkMath() {
  var ans = parseInt(document.getElementById('math-ans').value);
  var fb = document.getElementById('math-fb');
  fb.style.display = 'block';
  if (ans === S.mathAnswer) {
    clearInterval(S.mathTimer); S.mathDone = true;
    fb.style.color = 'var(--green)'; fb.textContent = 'Correct! One more question...';
    setTimeout(showQuestionCheck, 1200);
  } else {
    fb.style.color = 'var(--red)'; fb.textContent = 'Wrong answer. Try again.';
  }
}

function showQuestionCheck() {
  go('s-alarm2-q');
  var idx = Math.floor(Math.random() * S.questions.length);
  S.currentQ = S.questions[idx];
  document.getElementById('q-text').textContent = S.currentQ.q;
  document.getElementById('q-opts').innerHTML = S.currentQ.opts.map(function(o, i) {
    return '<button class="q-opt" onclick="checkQ(' + i + ')">' + o + '</button>';
  }).join('');
  document.getElementById('q-fb').style.display = 'none';
  clearInterval(S.qTimer);
  var t = S.cfg.timeout;
  document.getElementById('q-cd').textContent = t;
  S.qTimer = setInterval(function() {
    t--; document.getElementById('q-cd').textContent = t;
    if (t <= 0) { clearInterval(S.qTimer); goEscalate(); }
  }, 1000);
}

function checkQ(idx) {
  clearInterval(S.qTimer);
  var btns = document.querySelectorAll('.q-opt');
  btns.forEach(function(b) { b.disabled = true; });
  var fb = document.getElementById('q-fb'); fb.style.display = 'block';
  if (idx === S.currentQ.c) {
    btns[idx].className = 'q-opt correct';
    fb.style.color = 'var(--green)'; fb.textContent = 'Correct! You are conscious and ok.';
    setTimeout(confirmConscious, 1500);
  } else {
    btns[idx].className = 'q-opt wrong';
    btns[S.currentQ.c].className = 'q-opt correct';
    fb.style.color = 'var(--red)'; fb.textContent = 'Wrong. Escalating to contacts...';
    setTimeout(goEscalate, 1500);
  }
}

function confirmConscious() {
  clearAllTimers();
  S.alarmActive = false; S.alarm1Active = false; S.alarm2Active = false; S.timeLow = 0;
  S.responseReceived = false;
  fetch(API + '/api/alarm/conscious', { method: 'POST' });
  document.getElementById('reply-banner').style.display = 'none';
  go('s-monitor'); updateGlucoseDisplay();
}

// ── ESCALATION ──
function goEscalate() {
  clearAllTimers();
  S.responseReceived = false;
  fetch(API + '/api/escalate', { method: 'POST' });
  document.getElementById('esc-wa-msg').textContent = WA_MSG;
  document.getElementById('pi-msg').className = 'phase-dot active';
  document.getElementById('pi-call').className = 'phase-dot';
  document.getElementById('esc-call-card').style.display = 'none';
  document.getElementById('esc-call-rows').innerHTML = '';
  document.getElementById('esc-call-log').innerHTML = '';
  var btn = document.querySelector('#esc-response-window button');
  if (btn) { btn.style.display = ''; btn.disabled = false; }
  var rw = document.getElementById('esc-response-window');
  rw.style.display = 'block';
  rw.querySelector('div:last-child') && (rw.innerHTML = rw.innerHTML);
  go('s-escalation');
  startWaCountdown();
  vibrate();
}

function startWaCountdown() {
  var remaining = S.cfg.waWindow * 60;
  function fmt(s) { var m = Math.floor(s/60), sec = s%60; return m + ':' + (sec < 10 ? '0' : '') + sec; }
  var cdEl = document.getElementById('esc-cd');
  if (cdEl) cdEl.textContent = fmt(remaining);
  clearInterval(S.waTimer);
  S.waTimer = setInterval(function() {
    if (S.responseReceived) { clearInterval(S.waTimer); return; }
    remaining--;
    var el = document.getElementById('esc-cd');
    if (el) el.textContent = fmt(remaining);
    if (remaining <= 0) { clearInterval(S.waTimer); if (!S.responseReceived) startCalls(); }
  }, 1000);
}

function simReply() {
  if (S.responseReceived) return;
  S.responseReceived = true;
  clearInterval(S.waTimer);
  var btn = document.querySelector('#esc-response-window button');
  if (btn) btn.style.display = 'none';
  document.getElementById('esc-cd').textContent = '—';
  document.getElementById('pi-msg').className = 'phase-dot done';
  var rw = document.getElementById('esc-response-window');
  rw.querySelector('div').textContent = 'Response received';
  document.getElementById('esc-cd').style.color = 'var(--green)';
  document.getElementById('esc-cd').style.fontSize = '24px';
  document.getElementById('esc-cd').textContent = 'A contact replied — no calls needed.';
  setTimeout(function() {
    document.getElementById('reply-banner').style.display = 'block';
    S.alarmActive = false; S.alarm1Active = false; S.alarm2Active = false; S.timeLow = 0;
    go('s-monitor'); updateGlucoseDisplay();
  }, 2000);
}

function startCalls() {
  document.getElementById('pi-msg').className = 'phase-dot done';
  document.getElementById('pi-call').className = 'phase-dot danger';
  document.getElementById('esc-response-window').style.display = 'none';
  document.getElementById('esc-call-card').style.display = 'block';
  var contacts = S.contacts.filter(function(c) { return c.name && c.phone; });
  renderCallRows(contacts, -1);
  runCallLoop(contacts, 0, 1);
}

function renderCallRows(contacts, activeIdx) {
  document.getElementById('esc-call-rows').innerHTML = contacts.map(function(c, i) {
    var cls = i < activeIdx ? 'done-c' : i === activeIdx ? 'active-c' : '';
    var init = c.name.charAt(0).toUpperCase();
    return '<div class="contact-call-row"><div class="contact-avatar ' + cls + '">' + init + '</div><div><div style="font-size:15px;font-weight:500;">' + c.name + '</div><div style="font-size:13px;color:var(--text2);">' + c.phone + '</div></div></div>';
  }).join('');
}

function addCallLog(msg) {
  var el = document.getElementById('esc-call-log');
  var d = document.createElement('div');
  d.className = 'log-text'; d.textContent = '› ' + msg;
  el.appendChild(d);
}

function runCallLoop(contacts, idx, attempt) {
  if (idx >= contacts.length) {
    addCallLog('All contacts tried. Consider calling 112.');
    return;
  }
  var c = contacts[idx];
  renderCallRows(contacts, idx);
  addCallLog('Calling ' + c.name + ' — attempt ' + attempt + '/' + S.cfg.attempts + '...');
  S.escTimer = setTimeout(function() {
    addCallLog('No answer from ' + c.name + '.');
    if (attempt < S.cfg.attempts) {
      addCallLog('Retrying in 30s...');
      S.escTimer = setTimeout(function() { runCallLoop(contacts, idx, attempt + 1); }, 30000);
    } else {
      S.escTimer = setTimeout(function() { runCallLoop(contacts, idx + 1, 1); }, 2000);
    }
  }, 4000);
}

// ── TEST FLOW ──
function testAlarm() {
  S.glucose = 52; S.trend = 'down'; S.timeLow = 30;
  updateGlucoseDisplay();
  triggerAlarm1('Simulated hypo — glucose 52 mg/dL and falling');
}

// ── SETTINGS ──
function renderContacts() {
  document.getElementById('contacts-list').innerHTML = S.contacts.map(function(c, i) {
    return '<div class="row" style="flex-direction:column;align-items:flex-start;gap:8px;padding:14px 16px;">' +
      '<div style="display:flex;width:100%;align-items:center;justify-content:space-between;">' +
      '<span style="font-size:13px;color:var(--text2);font-weight:600;">CONTACT ' + (i+1) + '</span>' +
      '<button onclick="removeContact(' + i + ')" style="background:none;border:none;color:var(--red);font-size:15px;cursor:pointer;">Remove</button>' +
      '</div>' +
      '<input type="text" value="' + (c.name||'') + '" placeholder="Name" onchange="S.contacts[' + i + '].name=this.value" style="width:100%;background:var(--bg3);border-radius:8px;padding:10px;border:none;color:var(--text);font-size:15px;font-family:inherit;"/>' +
      '<input type="tel" value="' + (c.phone||'') + '" placeholder="+34 600 000 000" onchange="S.contacts[' + i + '].phone=this.value" style="width:100%;background:var(--bg3);border-radius:8px;padding:10px;border:none;color:var(--text);font-size:15px;font-family:inherit;"/>' +
      '</div>';
  }).join('') || '<div class="row"><span class="row-label" style="color:var(--text2);">No contacts yet</span></div>';
}

function addContact() { S.contacts.push({ name: '', phone: '' }); renderContacts(); }
function removeContact(i) { S.contacts.splice(i, 1); renderContacts(); }

function saveSettings() {
  var rows = document.querySelectorAll('#contacts-list .row');
  rows.forEach(function(row, i) {
    var ins = row.querySelectorAll('input');
    if (S.contacts[i] && ins.length >= 2) {
      S.contacts[i].name = ins[0].value;
      S.contacts[i].phone = ins[1].value;
    }
  });
  S.cfg.thresh = parseInt(document.getElementById('cfg-thresh').value) || 60;
  S.cfg.dur = parseInt(document.getElementById('cfg-dur').value) || 30;
  S.cfg.gap = parseInt(document.getElementById('cfg-gap').value) || 15;
  S.cfg.waWindow = parseInt(document.getElementById('cfg-wa').value) || 5;
  S.cfg.attempts = parseInt(document.getElementById('cfg-attempts').value) || 2;
  S.cfg.trendAlarm = document.getElementById('cfg-trend').value === 'yes';
  fetch(API + '/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contacts: S.contacts, threshold: S.cfg.thresh, lowDuration: S.cfg.dur, alarmGap: S.cfg.gap, waWindow: S.cfg.waWindow, callAttempts: S.cfg.attempts })
  }).then(function() {
    showTab('monitor');
  });
}

function loadSettingsFromServer() {
  fetch(API + '/api/settings')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.contacts) { S.contacts = data.contacts; renderContacts(); }
      if (data.threshold) document.getElementById('cfg-thresh').value = data.threshold;
      if (data.lowDuration) document.getElementById('cfg-dur').value = data.lowDuration;
      if (data.alarmGap) document.getElementById('cfg-gap').value = data.alarmGap;
      if (data.waWindow) document.getElementById('cfg-wa').value = data.waWindow;
      if (data.callAttempts) document.getElementById('cfg-attempts').value = data.callAttempts;
    }).catch(function() {});
}

// ── SERVICE WORKER (for push notifications) ──
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(function(reg) {
      console.log('SW registered');
      if (Notification.permission === 'granted') registerPushSubscription();
    }).catch(function(e) { console.error('SW failed:', e); });

    navigator.serviceWorker.addEventListener('message', function(e) {
      var data = e.data;
      if (!data) return;
      if (data.type === 'alarm1') triggerAlarm1(data.body);
      if (data.type === 'alarm2') { S.alarm1Active = true; fireAlarm2(); }
      if (data.type === 'reply') {
        document.getElementById('reply-banner').style.display = 'block';
        go('s-monitor');
      }
    });
  }
}

// ── UTILS ──
function vibrate() {
  if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500]);
}

function clearAllTimers() {
  clearInterval(S.mathTimer); clearInterval(S.qTimer);
  clearInterval(S.a1Interval); clearInterval(S.waTimer);
  clearTimeout(S.escTimer);
}

// ── INIT ──
renderContacts();
pollServer();
setInterval(pollServer, 30000);
loadSettingsFromServer();
registerSW();
checkPushStatus();
