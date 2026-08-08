// ---------------------------------------------------------
// SUPABASE CONFIG — replace with your own Project URL and anon key
// (Settings → API sa imong Supabase project)
// ---------------------------------------------------------
const SUPABASE_URL = "https://kobfvfvhdcgvvraxlfth.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvYmZ2ZnZoZGNndnZyYXhsZnRoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwODEzNTYsImV4cCI6MjEwMTY1NzM1Nn0.6YUSJZmzSY_2Z42oVK_hNdVEe8kqFATCYfGNhVgCbBs";

let supabaseClient = null;
if (window.supabase && !SUPABASE_URL.includes("YOUR-PROJECT-REF")) {
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} else {
  console.warn("Supabase dili pa naka-configure — palitan una ang SUPABASE_URL/SUPABASE_ANON_KEY");
}

async function fetchLatestReading() {
  if (!supabaseClient) return null;
  const { data, error } = await supabaseClient
    .from('Var')
    .select('capacity, distance_cm, full, created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('Supabase fetch error:', error.message);
    return null;
  }
  return data;
}

const bin = { pct: 0, distanceCm: 0, full: false, readAt: new Date() };
const SEGMENT_COUNT = 16;
let lastNotifiedLabel = null; // avoid sending the same notification repeatedly
let hasData = false; // becomes true once a real reading from the ESP32-C3 arrives

function updateNotifyBtn() {
  const btn = document.getElementById('notifyBtn');
  if (!btn) return;
  if (!("Notification" in window)) {
    btn.textContent = "🔕 Not supported";
    btn.disabled = true;
    return;
  }
  if (Notification.permission === "granted") {
    btn.textContent = "🔔 Alerts on";
    btn.classList.add('on');
  } else if (Notification.permission === "denied") {
    btn.textContent = "🔕 Blocked in browser";
  } else {
    btn.textContent = "🔔 Enable alerts";
    btn.classList.remove('on');
  }
}

function requestNotificationPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    Notification.requestPermission().then(updateNotifyBtn);
  }
}

function maybeNotify(label, pct) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  // only fire once per status change, not every update
  if (label === lastNotifiedLabel) return;
  lastNotifiedLabel = label;

  if (label === "ALMOST FULL" || label === "FULL — PICKUP NOW") {
    new Notification("🗑️ Smart Bin Alert", {
      body: `Bin is at ${Math.round(pct)}% — needs pickup soon.`,
      tag: "smart-bin-status"
    });
  }
}

function colorFor(pct) {
  if (pct >= 80) return { color: 'var(--red)', hex: '#FF7A7A', soft: 'var(--red-soft)', label: 'ALMOST FULL' };
  if (pct >= 50) return { color: 'var(--amber)', hex: '#FFC864', soft: 'var(--amber-soft)', label: 'FILLING UP' };
  return { color: 'var(--blue)', hex: '#6FD3FF', soft: 'var(--blue-soft)', label: 'ROOM AVAILABLE' };
}

function timeString(d) {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function drawSegments(pct) {
  const filledCount = Math.round((pct / 100) * SEGMENT_COUNT);
  const { hex } = colorFor(pct);
  const wrap = document.getElementById('segments');
  wrap.innerHTML = '';
  for (let i = 0; i < SEGMENT_COUNT; i++) {
    const seg = document.createElement('div');
    seg.className = 'segment' + (i < filledCount ? ' filled' : '');
    if (i < filledCount) {
      seg.style.background = hex;
      seg.style.color = hex;
    }
    wrap.appendChild(seg);
  }
}

function render() {
  const capValEl = document.getElementById('capVal');
  const chip = document.getElementById('statusChip');

  // No reading from the ESP32-C3 yet — show a neutral "connecting" state
  // instead of a fake/hardcoded percentage, and keep the bar empty.
  if (!hasData) {
    capValEl.textContent = '--';
    document.getElementById('lastReading').textContent = '—';
    chip.textContent = 'CONNECTING…';
    chip.style.color = 'var(--gray)';
    chip.style.borderColor = 'var(--gray)';
    chip.style.background = 'var(--gray-soft)';
    drawSegments(0);
    return;
  }

  const { color, soft, label: baseLabel } = colorFor(bin.pct);
  const label = bin.full ? 'FULL — PICKUP NOW' : baseLabel;

  capValEl.textContent = Math.round(bin.pct);
  document.getElementById('lastReading').textContent = timeString(bin.readAt);

  chip.textContent = label;
  chip.style.color = color;
  chip.style.borderColor = color;
  chip.style.background = soft;

  // Segment bar fills up proportionally to the live capacity % reported
  // by the ESP32-C3 (via distance_cm -> capacity conversion on the device).
  drawSegments(bin.pct);
  maybeNotify(label, bin.pct);
}

async function loadInitialReading() {
  if (!supabaseClient) return;
  const latest = await fetchLatestReading();
  if (latest) {
    bin.pct = latest.capacity;
    bin.distanceCm = latest.distance_cm;
    bin.full = latest.full;
    bin.readAt = new Date(latest.created_at);
    hasData = true;
    render();
  }
}

function subscribeToRealtimeReadings() {
  if (!supabaseClient) {
    console.warn("Supabase wala pa naka-configure — dili ma-realtime ang data.");
    return;
  }

  supabaseClient
    .channel('var_readings_live')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'Var' },
      (payload) => {
        const row = payload.new;
        bin.pct = row.capacity;
        bin.distanceCm = row.distance_cm;
        bin.full = row.full;
        bin.readAt = new Date(row.created_at);
        hasData = true;
        render();
      }
    )
    .subscribe((status) => {
      console.log('Supabase realtime status:', status);
    });
}

loadInitialReading();
subscribeToRealtimeReadings();

const notifyBtn = document.getElementById('notifyBtn');
if (notifyBtn) {
  notifyBtn.addEventListener('click', requestNotificationPermission);
}
updateNotifyBtn();
render();
