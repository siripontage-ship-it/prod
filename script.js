// ---------------------------------------------------------
// Air Watch — bathroom air-quality dashboard
// Two connection modes:
//   1) USB   — reads the MQ-135 raw value straight from the ESP32's
//              Serial output over a USB cable (Web Serial API).
//   2) Blynk — polls Blynk Cloud's "external API" for the latest
//              virtual-pin value, for when the ESP32 is on WiFi and
//              already pushing values with Blynk.virtualWrite(...).
// ---------------------------------------------------------

const GAUGE_CIRCUMFERENCE = 578; // 2 * PI * r(92), matches the SVG in index.html
const MAX_RAW = 4095;            // ESP32 analogReadResolution(12) => 0-4095
const MAX_SUMMARY_READINGS = 2000; // cap on in-memory readings kept for the summary/AI stats
const ALERT_COOLDOWN_MS = 60_000;  // don't re-notify for the same Poor episode more than once a minute
const AI_COOLDOWN_MS = 15 * 60_000; // safety backstop between auto AI calls (the real throttle is "once per poor episode" below)
const AI_DAILY_LIMIT = 15;          // stay safely under Gemini's free-tier daily cap (often as low as 20 req/day on flash models)
const BAUD_RATE = 115200;          // must match Serial.begin(115200) in the Arduino sketch

// 🔄 อัปเดต Model เป็นรุ่นที่รองรับใช้งานได้ในปัจจุบัน
const GEMINI_MODEL = 'gemini-3.6-flash';

// 🔑 ใส่ Gemini API Key ของคุณ
const GEMINI_API_KEY = "AQ.Ab8RN6LCvVUeaDeYSexvtEZRvQBU-nhVwknx3SgWfbc4FMUDWA";

// Matches a line like: "MQ-135 Analog Value : 1234"
const VALUE_LINE = /Analog Value\s*:\s*(\d+)/i;
// Fallback: a line that is just a bare number, in case the sketch is simplified later
const BARE_NUMBER_LINE = /^\s*(\d{1,5})\s*$/;

const els = {
  connDot: document.getElementById('connDot'),
  connLabel: document.getElementById('connLabel'),
  clock: document.getElementById('clock'),
  gaugeFill: document.getElementById('gaugeFill'),
  rawValue: document.getElementById('rawValue'),
  statusText: document.getElementById('statusText'),
  statusDetail: document.getElementById('statusDetail'),
  notifBtn: document.getElementById('notifBtn'),

  modeUsbBtn: document.getElementById('modeUsbBtn'),
  modeBlynkBtn: document.getElementById('modeBlynkBtn'),
  usbPanel: document.getElementById('usbPanel'),
  blynkPanel: document.getElementById('blynkPanel'),

  connectSerialBtn: document.getElementById('connectSerialBtn'),
  disconnectSerialBtn: document.getElementById('disconnectSerialBtn'),

  blynkTokenInput: document.getElementById('blynkTokenInput'),
  blynkPinInput: document.getElementById('blynkPinInput'),
  blynkIntervalInput: document.getElementById('blynkIntervalInput'),
  connectBlynkBtn: document.getElementById('connectBlynkBtn'),
  disconnectBlynkBtn: document.getElementById('disconnectBlynkBtn'),

  freshInput: document.getElementById('freshInput'),
  moderateInput: document.getElementById('moderateInput'),
  saveThresholdBtn: document.getElementById('saveThresholdBtn'),
  logList: document.getElementById('logList'),
  clearLogBtn: document.getElementById('clearLogBtn'),
  alertSound: document.getElementById('alertSound'),
  summaryAvg: document.getElementById('summaryAvg'),
  summaryMin: document.getElementById('summaryMin'),
  summaryMax: document.getElementById('summaryMax'),
  summaryCount: document.getElementById('summaryCount'),
  barFresh: document.getElementById('barFresh'),
  barModerate: document.getElementById('barModerate'),
  barPoor: document.getElementById('barPoor'),
  pctFresh: document.getElementById('pctFresh'),
  pctModerate: document.getElementById('pctModerate'),
  pctPoor: document.getElementById('pctPoor'),
  summaryText: document.getElementById('summaryText'),
  resetSummaryBtn: document.getElementById('resetSummaryBtn'),
  aiAnalyzeBtn: document.getElementById('aiAnalyzeBtn'),
  aiResultText: document.getElementById('aiResultText'),
  aiQuotaHint: document.getElementById('aiQuotaHint'),
};

let thresholds = loadJSON('airwatch_thresholds', { fresh: 1200, moderate: 2500 });
let history = loadJSON('airwatch_log', []);
let blynkSettings = loadJSON('airwatch_blynk', { token: '', pin: 'V0', interval: 3 });

let port = null;
let reader = null;
let keepReading = false;
let lastStatus = null;
let lastAlertAt = 0;
let lastAiTriggerAt = 0;

// Blynk polling state
let blynkTimerId = null;
let blynkBusy = false; // avoid overlapping requests if a poll is slow

// All readings collected since the page loaded (or since "รีเซ็ตข้อมูลสรุป"),
// used only for the average/min/max/percentage summary and the AI prompt.
let readingsBuffer = [];

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

// ---------------- Clock ----------------

function tickClock() {
  els.clock.textContent = new Date().toLocaleTimeString('th-TH', { hour12: false });
}
setInterval(tickClock, 1000);
tickClock();

// ---------------- Connection mode toggle (USB / Blynk) ----------------

function setMode(mode) {
  const isUsb = mode === 'usb';
  els.modeUsbBtn.classList.toggle('active', isUsb);
  els.modeBlynkBtn.classList.toggle('active', !isUsb);
  els.modeUsbBtn.setAttribute('aria-selected', String(isUsb));
  els.modeBlynkBtn.setAttribute('aria-selected', String(!isUsb));
  els.usbPanel.style.display = isUsb ? 'block' : 'none';
  els.blynkPanel.style.display = isUsb ? 'none' : 'block';
}

els.modeUsbBtn.addEventListener('click', () => {
  // Switching away from Blynk stops its polling so the two sources never fight.
  if (blynkTimerId) disconnectBlynk();
  setMode('usb');
});

els.modeBlynkBtn.addEventListener('click', () => {
  if (keepReading) disconnectSerial();
  setMode('blynk');
});

// ---------------- Threshold form ----------------

els.freshInput.value = thresholds.fresh;
els.moderateInput.value = thresholds.moderate;

els.saveThresholdBtn.addEventListener('click', () => {
  const fresh = Number(els.freshInput.value);
  const moderate = Number(els.moderateInput.value);
  if (!(fresh > 0 && moderate > fresh)) {
    alert('กรุณาตรวจสอบตัวเลข: ค่าปานกลางต้องมากกว่าค่าอากาศดี');
    return;
  }
  thresholds = { fresh, moderate };
  saveJSON('airwatch_thresholds', thresholds);
});

els.clearLogBtn.addEventListener('click', () => {
  history = [];
  saveJSON('airwatch_log', history);
  renderLog();
});

// ---------------- Notifications ----------------

els.notifBtn.addEventListener('click', async () => {
  if (!('Notification' in window)) {
    alert('เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน');
    return;
  }
  const permission = await Notification.requestPermission();
  els.notifBtn.textContent = permission === 'granted'
    ? 'เปิดการแจ้งเตือนแล้ว'
    : 'ยังไม่ได้อนุญาตการแจ้งเตือน';
});

function fireAlert(rawValue) {
  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) return;
  lastAlertAt = now;

  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('ห้องน้ำเหม็นเกินไป', {
      body: `ค่าที่วัดได้ ${rawValue} เกินเกณฑ์ที่ตั้งไว้ (${thresholds.moderate})`,
    });
  }
  els.alertSound.play().catch(() => {});

  history.unshift({ time: new Date().toLocaleTimeString('th-TH', { hour12: false }), value: rawValue, level: 'poor' });
  history = history.slice(0, 30);
  saveJSON('airwatch_log', history);
  renderLog();
}

function renderLog() {
  if (history.length === 0) {
    els.logList.innerHTML = '<li class="log-empty">ยังไม่มีการแจ้งเตือน</li>';
    return;
  }
  els.logList.innerHTML = history.map(item => `
    <li>
      <span class="log-time">${item.time}</span>
      <span>ค่าที่วัดได้ ${item.value}</span>
      <span class="tag poor">เหม็นเกินไป</span>
    </li>
  `).join('');
}


// ---------------- Gauge + status ----------------

function classify(rawValue) {
  if (rawValue < thresholds.fresh) return 'fresh';
  if (rawValue < thresholds.moderate) return 'moderate';
  return 'poor';
}

const STATUS_COPY = {
  fresh: { label: 'อากาศดี', detail: 'คุณภาพอากาศในห้องน้ำอยู่ในเกณฑ์ปกติ', color: '#2F9E8F' },
  moderate: { label: 'เริ่มมีกลิ่น', detail: 'เริ่มมีกลิ่นสะสม ควรเปิดพัดลมระบายอากาศ', color: '#DB9A2C' },
  poor: { label: 'ห้องน้ำเหม็นเกินไป', detail: 'กลิ่นเกินเกณฑ์ที่ตั้งไว้ แนะนำให้เข้าไปตรวจสอบและระบายอากาศทันที', color: '#C74A4A' },
};

function updateReading(rawValue, sourceLabel) {
  const level = classify(rawValue);
  const copy = STATUS_COPY[level];

  els.rawValue.textContent = rawValue;
  els.statusText.textContent = copy.label;
  els.statusText.style.color = copy.color;
  els.statusDetail.textContent = copy.detail;

  const fraction = Math.min(rawValue / MAX_RAW, 1);
  els.gaugeFill.style.stroke = copy.color;
  els.gaugeFill.style.strokeDashoffset = String(GAUGE_CIRCUMFERENCE * (1 - fraction));

  recordForSummary(rawValue, level);

  if (level === 'poor') {
    fireAlert(rawValue);

    // Auto-call the AI once per "poor episode" (i.e. right when it turns poor),
    // not on every single reading while it stays poor — that's what was
    // burning through the daily quota. The cooldown below is just a backstop.
    const now = Date.now();
    const justEnteredPoor = lastStatus !== 'poor';
    if (justEnteredPoor && now - lastAiTriggerAt > AI_COOLDOWN_MS) {
      lastAiTriggerAt = now;
      analyzeWithGemini(true);
    }
  }

  if (level === 'moderate' && lastStatus !== 'moderate' && lastStatus !== 'poor') {
    history.unshift({ time: new Date().toLocaleTimeString('th-TH', { hour12: false }), value: rawValue, level: 'moderate' });
    history = history.slice(0, 30);
    saveJSON('airwatch_log', history);
    renderLog();
  }
  lastStatus = level;
}

// ---------------- Summary (average / min / max / time-in-zone) ----------------

function recordForSummary(rawValue, level) {
  readingsBuffer.push({ value: rawValue, level, t: Date.now() });
  if (readingsBuffer.length > MAX_SUMMARY_READINGS) {
    readingsBuffer.shift();
  }
  computeSummary();
}

function computeSummary() {
  const n = readingsBuffer.length;
  if (n === 0) {
    els.summaryAvg.textContent = '--';
    els.summaryMin.textContent = '--';
    els.summaryMax.textContent = '--';
    els.summaryCount.textContent = '0';
    setBar(els.barFresh, els.pctFresh, 0);
    setBar(els.barModerate, els.pctModerate, 0);
    setBar(els.barPoor, els.pctPoor, 0);
    els.summaryText.textContent = 'ยังไม่มีข้อมูลเพียงพอสำหรับสรุปผล เริ่มเชื่อมต่อบอร์ดเพื่อเก็บค่า';
    return null;
  }

  let sum = 0, min = Infinity, max = -Infinity;
  let freshCount = 0, moderateCount = 0, poorCount = 0;

  for (const r of readingsBuffer) {
    sum += r.value;
    if (r.value < min) min = r.value;
    if (r.value > max) max = r.value;
    if (r.level === 'fresh') freshCount++;
    else if (r.level === 'moderate') moderateCount++;
    else poorCount++;
  }

  const avg = Math.round(sum / n);
  const pctFresh = Math.round((freshCount / n) * 100);
  const pctModerate = Math.round((moderateCount / n) * 100);
  const pctPoor = Math.max(0, 100 - pctFresh - pctModerate);

  els.summaryAvg.textContent = avg;
  els.summaryMin.textContent = min;
  els.summaryMax.textContent = max;
  els.summaryCount.textContent = n;
  setBar(els.barFresh, els.pctFresh, pctFresh);
  setBar(els.barModerate, els.pctModerate, pctModerate);
  setBar(els.barPoor, els.pctPoor, pctPoor);

  const avgLevel = classify(avg);
  const avgLabel = STATUS_COPY[avgLevel].label;
  els.summaryText.textContent =
    `จากค่าที่เก็บได้ ${n} ค่า เฉลี่ยอยู่ที่ ${avg} (${avgLabel}) ` +
    `อากาศดี ${pctFresh}% ของเวลา ปานกลาง ${pctModerate}% และเหม็นเกินไป ${pctPoor}%`;

  return { avg, min, max, n, pctFresh, pctModerate, pctPoor };
}

function setBar(barEl, pctEl, pct) {
  barEl.style.width = `${pct}%`;
  pctEl.textContent = `${pct}%`;
}

els.resetSummaryBtn.addEventListener('click', () => {
  readingsBuffer = [];
  computeSummary();
  els.aiResultText.textContent = 'ยังไม่ได้ขอให้ AI วิเคราะห์';
});

// ---------------- AI usage tracking (client-side daily cap, resets locally at midnight) ----------------

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function getAiUsageToday() {
  const usage = loadJSON('airwatch_ai_usage', { date: '', count: 0 });
  if (usage.date !== todayKey()) return { date: todayKey(), count: 0 };
  return usage;
}

function bumpAiUsage() {
  const usage = getAiUsageToday();
  usage.count += 1;
  saveJSON('airwatch_ai_usage', usage);
  renderAiQuotaHint(usage.count);
  return usage.count;
}

function markAiQuotaExhaustedToday() {
  saveJSON('airwatch_ai_usage', { date: todayKey(), count: AI_DAILY_LIMIT });
  renderAiQuotaHint(AI_DAILY_LIMIT);
}

function renderAiQuotaHint(count) {
  if (!els.aiQuotaHint) return;
  const remaining = Math.max(0, AI_DAILY_LIMIT - count);
  els.aiQuotaHint.textContent = `เหลือโควต้าการวิเคราะห์ AI วันนี้ ${remaining}/${AI_DAILY_LIMIT} ครั้ง (รีเซ็ตตามเวลาเครื่องนี้ตอนเที่ยงคืน)`;
}

// ---------------- AI summary (calls Gemini directly using your saved key) ----------------

function buildPrompt(stats) {
  const currentValue = Number(els.rawValue.textContent) || stats.avg;
  const currentStatus = els.statusText.textContent;
  return `
คุณคือระบบ AI ผู้เชี่ยวชาญด้านการวิเคราะห์คุณภาพอากาศและการสุขาภิบาลห้องน้ำ
สรุปข้อมูลจากเซนเซอร์ MQ-135 ในช่วงที่ผ่านมา (จากตัวอย่าง ${stats.n} ค่า):
- ค่าเฉลี่ย: ${stats.avg}
- ค่าต่ำสุด: ${stats.min}
- ค่าสูงสุด: ${stats.max}
- สัดส่วนเวลาที่อากาศดี: ${stats.pctFresh}%
- สัดส่วนเวลาที่ปานกลาง (เริ่มมีกลิ่น): ${stats.pctModerate}%
- สัดส่วนเวลาที่เหม็นเกินไป: ${stats.pctPoor}%
- ค่าล่าสุดตอนนี้: ${currentValue} (สถานะ: ${currentStatus})
- เกณฑ์ที่ตั้งไว้: อากาศดีต่ำกว่า ${thresholds.fresh}, ปานกลางต่ำกว่า ${thresholds.moderate}

โปรดวิเคราะห์และสรุปเป็นภาษาไทย ความยาวไม่เกิน 4-5 ประโยค:
1. ภาพรวมคุณภาพอากาศในช่วงเวลาที่ผ่านมา (ไม่ใช่แค่ค่าล่าสุด)
2. ประเมินความรุนแรงและชนิดของกลิ่นที่อาจเกิดขึ้นถ้าค่าสูง
3. คำแนะนำที่ควรทำ (ระบายอากาศ/ทำความสะอาด/ตรวจสอบเพิ่ม)
`.trim();
}

async function analyzeWithGemini(isAutoTrigger = false) {
  if (!els.aiResultText) return;

  if (!GEMINI_API_KEY || GEMINI_API_KEY.startsWith('ใส่คีย์')) {
    els.aiResultText.innerHTML = "<span style='color:#DB9A2C;'>⚠️ ยังไม่ได้ใส่ Gemini API Key ในไฟล์ script.js (ตัวแปร GEMINI_API_KEY ด้านบนไฟล์)</span>";
    return;
  }

  const stats = computeSummary();
  if (!stats) {
    els.aiResultText.innerHTML = "<span style='color:#DB9A2C;'>⚠️ ยังไม่มีข้อมูลพอให้ AI สรุป ต่อบอร์ดแล้วรอเก็บค่าสักครู่</span>";
    return;
  }

  const usage = getAiUsageToday();
  if (usage.count >= AI_DAILY_LIMIT) {
    els.aiResultText.innerHTML = `<span style='color:#DB9A2C;'>⚠️ วันนี้ใช้โควต้าฟรีของ AI ครบ ${AI_DAILY_LIMIT} ครั้งแล้ว (Gemini free tier จำกัดไม่กี่สิบครั้ง/วัน) กรุณาลองใหม่พรุ่งนี้ หรืออัปเกรดแผนการใช้งาน Gemini API</span>`;
    return;
  }

  els.aiResultText.innerHTML = `
    <div class="ai-loading">
      <span>⏳</span>
      <span>${isAutoTrigger ? 'ตรวจพบกลิ่นเหม็น! AI กำลังวิเคราะห์แนวโน้มอัตโนมัติ...' : 'AI กำลังประมวลผลข้อมูล...'}</span>
    </div>
  `;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: buildPrompt(stats) }] }] }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      if (response.status === 429) {
        // Quota/rate-limit hit — stop hammering it for the rest of the day
        // instead of surfacing Google's raw (long, technical) error text.
        markAiQuotaExhaustedToday();
        throw new Error(`โควต้าฟรีของ Gemini API หมดสำหรับวันนี้ ระบบจะไม่เรียก AI อัตโนมัติอีกจนกว่าจะถึงวันถัดไป`);
      }
      throw new Error(data.error?.message || `HTTP ${response.status}`);
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    els.aiResultText.innerHTML = (text || 'AI ไม่ได้ส่งข้อความกลับมา').replace(/\n/g, '<br>');
    bumpAiUsage();
  } catch (error) {
    console.error('Gemini API error:', error);
    els.aiResultText.innerHTML = `<span style='color:#C74A4A;'>❌ เรียก AI ไม่สำเร็จ: ${error.message}</span>`;
  }
}

if (els.aiAnalyzeBtn) {
  els.aiAnalyzeBtn.addEventListener('click', () => analyzeWithGemini(false));
}

// ---------------- Connection state (shared label/dot for both modes) ----------------

function setConnection(online, label) {
  els.connDot.classList.toggle('online', online);
  els.connDot.classList.toggle('offline', !online);
  els.connLabel.textContent = label;
}

// ---------------- Web Serial (USB mode) ----------------

function extractRawValue(line) {
  const m1 = line.match(VALUE_LINE);
  if (m1) return Number(m1[1]);
  const m2 = line.match(BARE_NUMBER_LINE);
  if (m2) return Number(m2[1]);
  return null;
}

async function connectSerial() {
  if (!('serial' in navigator)) {
    alert('เบราว์เซอร์นี้ไม่รองรับ Web Serial API กรุณาใช้ Chrome หรือ Edge เวอร์ชันล่าสุด');
    return;
  }

  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: BAUD_RATE });
  } catch (err) {
    setConnection(false, `เชื่อมต่อไม่สำเร็จ: ${err.message}`);
    return;
  }

  setConnection(true, 'เชื่อมต่อบอร์ดผ่าน USB สำเร็จ');
  els.connectSerialBtn.style.display = 'none';
  els.disconnectSerialBtn.style.display = 'block';

  keepReading = true;
  readLoop();
}

async function readLoop() {
  const textDecoder = new TextDecoderStream();
  const readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
  reader = textDecoder.readable.getReader();

  let buffer = '';

  try {
    while (keepReading) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;

      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const rawValue = extractRawValue(line);
        if (rawValue !== null && !Number.isNaN(rawValue)) {
          try {
            updateReading(rawValue, 'พอร์ต USB');
          } catch (uiErr) {
            console.error('เกิดข้อผิดพลาดตอนแสดงผลค่า:', uiErr);
          }
        }
      }
    }
  } catch (err) {
    setConnection(false, `การเชื่อมต่อขาดหาย: ${err.message}`);
  } finally {
    reader.releaseLock();
    try { await readableStreamClosed; } catch (e) { /* ignore */ }
  }
}

async function disconnectSerial() {
  keepReading = false;
  try {
    if (reader) await reader.cancel();
    if (port) await port.close();
  } catch (err) {
    // ignore errors on close
  }
  port = null;
  reader = null;
  setConnection(false, 'ตัดการเชื่อมต่อแล้ว');
  els.connectSerialBtn.style.display = 'block';
  els.disconnectSerialBtn.style.display = 'none';
}

els.connectSerialBtn.addEventListener('click', connectSerial);
els.disconnectSerialBtn.addEventListener('click', disconnectSerial);

if ('serial' in navigator) {
  navigator.serial.addEventListener('disconnect', () => {
    if (keepReading) {
      setConnection(false, 'บอร์ดถูกถอดออกจากพอร์ต USB');
      els.connectSerialBtn.style.display = 'block';
      els.disconnectSerialBtn.style.display = 'none';
      keepReading = false;
    }
  });
}

// ---------------- Blynk Cloud (online mode) ----------------
//
// Uses Blynk's "external API" (https://blynk.cloud/external/api/get)
// which is designed to be called from outside code like this, using
// only the device's Auth Token — no separate API key needed. It
// returns the current value of one virtual pin as plain text (or a
// one-item JSON array, depending on the pin's datastream type), so
// this code handles both shapes.
//
// Note: this reads whatever value the ESP32 last pushed with
// Blynk.virtualWrite(...) — it is not a live push, so results are as
// fresh as your board's own reporting interval.

function normalizeBlynkPin(pin) {
  const trimmed = (pin || '').trim();
  if (!trimmed) return '';
  return /^v/i.test(trimmed) ? trimmed.toUpperCase() : `V${trimmed}`;
}

function parseBlynkValue(rawText) {
  let text = rawText.trim();
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) text = String(parsed[0]);
    else text = String(parsed);
  } catch (e) {
    // not JSON — plain text value, use as-is
  }
  const num = Number(text);
  return Number.isNaN(num) ? null : num;
}

async function fetchBlynkValue() {
  if (blynkBusy) return; // previous request still in flight
  blynkBusy = true;

  const { token, pin } = blynkSettings;
  const url = `https://blynk.cloud/external/api/get?token=${encodeURIComponent(token)}&${encodeURIComponent(pin)}`;

  try {
    const response = await fetch(url);
    const text = await response.text();

    if (!response.ok) {
      throw new Error(text || `HTTP ${response.status}`);
    }

    const rawValue = parseBlynkValue(text);
    if (rawValue === null) {
      throw new Error(`อ่านค่าจาก Blynk ไม่ได้ (ได้รับ: ${text})`);
    }

    setConnection(true, `เชื่อมต่อ Blynk Cloud สำเร็จ · พิน ${pin}`);
    updateReading(rawValue, 'Blynk Cloud');
  } catch (err) {
    console.error('Blynk API error:', err);
    setConnection(false, `เชื่อมต่อ Blynk ไม่สำเร็จ: ${err.message}`);
  } finally {
    blynkBusy = false;
  }
}

function connectBlynk() {
  const token = els.blynkTokenInput.value.trim();
  const pin = normalizeBlynkPin(els.blynkPinInput.value);
  const interval = Number(els.blynkIntervalInput.value);

  if (!token) {
    alert('กรุณาใส่ Blynk Auth Token');
    return;
  }
  if (!pin) {
    alert('กรุณาใส่ Virtual Pin เช่น V0');
    return;
  }
  if (!(interval >= 1)) {
    alert('ความถี่ในการอ่านค่าต้องเป็นตัวเลขตั้งแต่ 1 วินาทีขึ้นไป');
    return;
  }

  blynkSettings = { token, pin, interval };
  saveJSON('airwatch_blynk', blynkSettings);

  if (blynkTimerId) clearInterval(blynkTimerId);
  setConnection(false, 'กำลังเชื่อมต่อ...');
  fetchBlynkValue(); // read immediately, then on the chosen interval
  blynkTimerId = setInterval(fetchBlynkValue, interval * 1000);

  els.connectBlynkBtn.style.display = 'none';
  els.disconnectBlynkBtn.style.display = 'block';
}

function disconnectBlynk() {
  if (blynkTimerId) {
    clearInterval(blynkTimerId);
    blynkTimerId = null;
  }
  setConnection(false, 'ตัดการเชื่อมต่อ Blynk แล้ว');
  els.connectBlynkBtn.style.display = 'block';
  els.disconnectBlynkBtn.style.display = 'none';
}

els.connectBlynkBtn.addEventListener('click', connectBlynk);
els.disconnectBlynkBtn.addEventListener('click', disconnectBlynk);

// Restore last-used Blynk settings into the form (but never auto-connect —
// the user has to press "บันทึกและเริ่มอ่านค่า" themselves each visit).
els.blynkTokenInput.value = blynkSettings.token || '';
els.blynkPinInput.value = blynkSettings.pin || 'V0';
els.blynkIntervalInput.value = blynkSettings.interval || 3;

// ---------------- Init ----------------

renderLog();
computeSummary();
renderAiQuotaHint(getAiUsageToday().count);
setMode('usb');
setConnection(false, 'กดปุ่ม "เชื่อมต่อบอร์ด (USB)" หรือสลับไปแท็บ "ออนไลน์ (Blynk)"');