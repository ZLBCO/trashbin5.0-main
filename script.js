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

const bin = { pct: 0, distanceCm: 0, full: false, readAt: null };
const SEGMENT_COUNT = 16;
let lastNotifiedLabel = null; // avoid sending the same notification repeatedly

// Connection mode shown in the "Mode" field: 'realtime' (live push working),
// 'polling' (falling back to periodic fetch), or 'offline' (no data yet / no client)
let connectionMode = 'connecting';
const POLL_INTERVAL_MS = 5000; // fallback poll rate if realtime isn't delivering

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

function updateModeDisplay() {
  const el = document.getElementById('modeVal');
  if (!el) return;
  const labels = {
    connecting: 'connecting…',
    realtime: 'realtime',
    polling: 'polling',
    offline: 'no data yet'
  };
  el.textContent = labels[connectionMode] || connectionMode;
}

function setConnectionMode(mode) {
  if (connectionMode === mode) return;
  connectionMode = mode;
  updateModeDisplay();
}

function render() {
  if (!bin.readAt) return; // nothing received yet, keep placeholder UI

  const { color, soft, label: baseLabel } = colorFor(bin.pct);
  const label = bin.full ? 'FULL — PICKUP NOW' : baseLabel;

  document.getElementById('capVal').textContent = Math.round(bin.pct);
  document.getElementById('lastReading').textContent = timeString(bin.readAt);

  const distEl = document.getElementById('distVal');
  if (distEl) distEl.textContent = `${bin.distanceCm.toFixed(1)} cm`;

  const chip = document.getElementById('statusChip');
  chip.textContent = label;
  chip.style.color = color;
  chip.style.borderColor = color;
  chip.style.background = soft;

  drawSegments(bin.pct);
  maybeNotify(label, bin.pct);
}

function applyReading(row) {
  if (!row) return;
  bin.pct = row.capacity;
  bin.distanceCm = row.distance_cm;
  bin.full = row.full;
  bin.readAt = new Date(row.created_at);
  render();
}

async function loadInitialReading() {
  if (!supabaseClient) {
    setConnectionMode('offline');
    return;
  }
  const latest = await fetchLatestReading();
  if (latest) {
    applyReading(latest);
  } else {
    setConnectionMode('offline');
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
        applyReading(payload.new);
        setConnectionMode('realtime'); // an INSERT event actually arrived — realtime is working
      }
    )
    .subscribe((status) => {
      console.log('Supabase realtime status:', status);
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        // Realtime not reachable (e.g. replication not enabled on the "Var" table,
        // or RLS blocking anon SELECT) — polling below still keeps the UI live.
        if (connectionMode === 'realtime') setConnectionMode('polling');
      }
    });
}

// Belt-and-suspenders: poll on an interval regardless of realtime status.
// This guarantees the page updates even if Realtime replication hasn't been
// enabled for the "Var" table in the Supabase dashboard, or the WebSocket
// connection gets dropped by a flaky network.
function startPollingFallback() {
  if (!supabaseClient) return;
  setInterval(async () => {
    const latest = await fetchLatestReading();
    if (latest) {
      const isNewRow = !bin.readAt || new Date(latest.created_at).getTime() !== bin.readAt.getTime();
      applyReading(latest);
      if (connectionMode !== 'realtime') {
        setConnectionMode('polling');
      } else if (isNewRow) {
        // realtime already marked us live and polling agrees — leave mode as-is
      }
    }
  }, POLL_INTERVAL_MS);
}

updateModeDisplay();
loadInitialReading();
subscribeToRealtimeReadings();
startPollingFallback();

const notifyBtn = document.getElementById('notifyBtn');
if (notifyBtn) {
  notifyBtn.addEventListener('click', requestNotificationPermission);
}
updateNotifyBtn();
render();
