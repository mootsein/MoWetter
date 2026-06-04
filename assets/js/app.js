// ── State ─────────────────────────────────────────────────────────────────────
let loc       = null;
let data      = null;
let chartData = null; // zeigt auf data (Forecast) oder _lastAnalysisData (Archiv)
let rng       = { start: null, end: null, sel: false };
let chartMode = 'temp';
let loadedPastDays = 0;
let CHS       = {};
let stileCharts = [];

function getToday() { return new Date().toISOString().split('T')[0]; }
let today = getToday();

// ── MoWetter API / Geräte-ID ─────────────────────────────────────────────────
function makeClientId() {
  const bytes = new Uint8Array(16);
  if (window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(bytes);
    return 'mw_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
  return 'mw_' + Math.random().toString(16).slice(2).padEnd(16, '0');
}

function getClientId() {
  let id = localStorage.getItem('mowetter_client_id');
  if (!id) {
    id = makeClientId();
    localStorage.setItem('mowetter_client_id', id);
  }
  return id;
}

const CLIENT_ID = getClientId();

async function apiJson(path, options = {}) {
  const r = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!r.ok) throw new Error(`API ${r.status}`);
  return r.json();
}

apiJson(`/api/clients/${CLIENT_ID}`, { method: 'POST' }).catch(() => {});

async function hydrateList(kind, storageKey, renderFn) {
  try {
    const d = await apiJson(`/api/clients/${CLIENT_ID}/locations?kind=${kind}`);
    if (Array.isArray(d.items) && d.items.length) {
      localStorage.setItem(storageKey, JSON.stringify(d.items));
      renderFn();
    }
  } catch {}
}

function syncList(kind, items) {
  apiJson(`/api/clients/${CLIENT_ID}/locations`, {
    method: 'PUT',
    body: JSON.stringify({ kind, items })
  }).catch(() => {});
}

async function fetchHistoricalFromDb(startDate, endDate) {
  const u = new URL('/api/history', window.location.origin);
  u.searchParams.set('lat', loc.lat);
  u.searchParams.set('lon', loc.lon);
  u.searchParams.set('start_date', startDate);
  u.searchParams.set('end_date', endDate);
  const r = await fetch(u);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function relativeAgeText(isoDate) {
  if (!isoDate) return 'unbekannt';
  const then = new Date(isoDate).getTime();
  if (!Number.isFinite(then)) return 'unbekannt';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return 'gerade eben';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `vor ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `vor ${hours} h`;
}

function updateFreshnessStatus(cacheInfo = null, loading = false) {
  const el = $('data-freshness');
  if (!el) return;
  el.className = '';
  if (loading) {
    el.textContent = 'Serverdaten: aktualisiert…';
    el.classList.add('refresh');
    return;
  }
  if (!cacheInfo) {
    el.textContent = 'Serverdaten: unbekannt';
    return;
  }
  const ageText = relativeAgeText(cacheInfo.fetched_at);
  const label = cacheInfo.status === 'hit' ? 'Cache' : 'frisch';
  el.textContent = `Serverdaten: ${label}, ${ageText}`;
  el.classList.add(cacheInfo.status === 'hit' ? 'good' : 'refresh');
}

async function fetchForecastFromDb(pastDays = 0, forecastDays = 14, force = false) {
  const u = new URL('/api/forecast', window.location.origin);
  u.searchParams.set('lat', loc.lat);
  u.searchParams.set('lon', loc.lon);
  u.searchParams.set('past_days', String(Math.max(pastDays, 2)));
  u.searchParams.set('forecast_days', String(forecastDays));
  if (force) u.searchParams.set('force', 'true');
  const r = await fetch(u);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// ── WMO ───────────────────────────────────────────────────────────────────────
const WI = {0:'☀️',1:'🌤️',2:'⛅',3:'☁️',45:'🌫️',48:'🌫️',51:'🌦️',53:'🌦️',55:'🌦️',
            61:'🌧️',63:'🌧️',65:'🌧️',71:'❄️',73:'❄️',75:'❄️',77:'🌨️',
            80:'🌦️',81:'🌦️',82:'⛈️',85:'❄️',86:'❄️',95:'⛈️',96:'⛈️',99:'⛈️'};
const wmoI = c => WI[c] ?? WI[Math.floor(c/10)*10] ?? '🌡️';
const wmoL = c => {
  if(c===0)return'Klar'; if(c<=3)return'Bewölkt'; if(c<=48)return'Nebel';
  if(c<=67)return'Regen'; if(c<=77)return'Schnee'; if(c<=82)return'Schauer';
  if(c<=99)return'Gewitter'; return'—';
};

// ── Wind direction helper ─────────────────────────────────────────────────────
function windDir(deg) {
  if (deg == null) return '';
  const dirs   = ['N','NO','O','SO','S','SW','W','NW'];
  const arrows = ['↑','↗','→','↘','↓','↙','←','↖'];
  const i = Math.round(deg / 45) % 8;
  return `${arrows[i]} ${dirs[i]}`;
}

// ── UV label ──────────────────────────────────────────────────────────────────
function uvLabel(v) {
  if (v == null) return '';
  if (v <= 2)  return '🟢 Niedrig';
  if (v <= 5)  return '🟡 Mittel';
  if (v <= 7)  return '🟠 Hoch';
  if (v <= 10) return '🔴 Sehr hoch';
  return '🟣 Extrem';
}

// ── DOM ───────────────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const sh = (id, mode='flex') => $(id).style.display = mode;
const hd = id => $(id).style.display = 'none';

// ── Geocoding ─────────────────────────────────────────────────────────────────
const cityIn = $('city-input');
const sugBox = $('suggestions');
let sugTimer;

cityIn.addEventListener('input', () => { clearTimeout(sugTimer); sugTimer = setTimeout(() => fetchSugs(cityIn.value), 320); });
cityIn.addEventListener('blur',  () => setTimeout(() => hd('suggestions'), 180));
cityIn.addEventListener('focus', () => { if(sugBox.children.length) sh('suggestions','block'); });

async function fetchSugs(q) {
  if (q.length < 2) { hd('suggestions'); return; }
  try {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=de`);
    const d = await r.json();
    sugBox.innerHTML = '';
    (d.results||[]).forEach(s => {
      const div = document.createElement('div');
      div.className = 'sug-item';
      div.textContent = `${s.name}${s.admin1?', '+s.admin1:''}, ${s.country}`;
      div.addEventListener('mousedown', () => {
        loc = { name: s.name, lat: s.latitude, lon: s.longitude };
        cityIn.value = div.textContent;
        hd('suggestions');
        loadWeather(7);
      });
      sugBox.appendChild(div);
    });
    sugBox.children.length ? sh('suggestions','block') : hd('suggestions');
  } catch { hd('suggestions'); }
}

// ── Datum-Hilfsfunktionen ──────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

// ── Fetch weather ─────────────────────────────────────────────────────────────
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00');
  d.setDate(d.getDate() + n);
  const p = x => String(x).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

// ── Filter-Buttons synchron halten ───────────────────────────────────────────
// Liest den aktuellen rng-State und aktualisiert alle Buttons entsprechend.
// Wird nach jeder Range-Änderung aufgerufen.
function syncFilterButtons() {
  const isHeute = rng.start === today && rng.end === today;
  const is5T    = rng.start === today && rng.end === addDays(today, 4);
  const is10T   = rng.start === today && rng.end === addDays(today, 9);
  const is14T   = rng.start === today && rng.end === addDays(today, 13);

  $('heute-btn').classList.toggle('active', isHeute);
  document.querySelectorAll('.preset-btn').forEach(btn => {
    const d = parseInt(btn.dataset.days);
    btn.classList.toggle('active',
      (d === 5 && is5T) || (d === 10 && is10T) || (d === 14 && is14T)
    );
  });
}

// ── Tile Popup ────────────────────────────────────────────────────────────────
let tilePopupChart = null;
let _activePopupKey = null;

function openTilePopup(title, subtitle, labels, datasets, chartType) {
  $('tile-popup-title').textContent    = title;
  $('tile-popup-subtitle').textContent = subtitle;
  $('tile-popup-compare-grid').classList.remove('visible');
  $('tile-popup-compare-grid').innerHTML = '';
  _newWindowData = { title, subtitle, type: chartType, labels, datasets, isSollIst: false };
  if (tilePopupChart) { tilePopupChart.destroy(); tilePopupChart = null; }
  const tc = window._chartTextColor  || '#8fa3b8';
  const gc = window._chartGridColor  || '#22263a';
  const tb = window._chartTooltipBg  || '#23262e';
  const tbc= window._chartTooltipBorder || '#22263a';
  const bodyCol = isDark ? '#f1f5f9' : '#1e2533';
  tilePopupChart = new Chart($('tile-popup-canvas'), {
    type: chartType,
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: datasets.length > 1, position: 'top', labels: { boxWidth: 12, font: { size: 11 }, color: tc } },
        tooltip: { backgroundColor: tb, borderColor: tbc, borderWidth: 1, titleColor: tc, bodyColor: bodyCol, padding: 9 }
      },
      scales: {
        x: { grid: { color: gc }, ticks: {
          color: tc,
          font: { size: 10 },
          maxRotation: 45,
          autoSkip: false,
          callback: function(value, index) {
            const label = this.getLabelForValue(value);
            const last = this.chart.data.labels.length - 1;
            if (index === 0 || index === last) return label;
            // "HH:MM" → 2h-Raster; "DD.MM HH:MM" (Mehrtages) → 6h-Raster
            const timePart = label.includes(' ') ? label.split(' ')[1] : label;
            const hour = parseInt(timePart.slice(0, 2), 10);
            const step  = label.includes(' ') ? 6 : 2;
            return Number.isFinite(hour) && hour % step === 0 ? label : '';
          }
        } },
        y: { grid: { color: gc }, ticks: { color: tc, font: { size: 11 } } }
      }
    }
  });
  $('tile-popup-overlay').classList.add('open');
}

function closeTilePopup() {
  $('tile-popup-overlay').classList.remove('open');
  if (tilePopupChart) { tilePopupChart.destroy(); tilePopupChart = null; }
  _activePopupKey = null;
}
$('tile-popup-close').addEventListener('click', closeTilePopup);
$('tile-popup-overlay').addEventListener('click', e => { if (e.target === $('tile-popup-overlay')) closeTilePopup(); });

// Swipe-down zum Schließen (Mobile)
let _swipeY0 = 0;
$('tile-popup').addEventListener('touchstart', e => { _swipeY0 = e.touches[0].clientY; }, { passive: true });
$('tile-popup').addEventListener('touchend',   e => { if (e.changedTouches[0].clientY - _swipeY0 > 60) closeTilePopup(); }, { passive: true });

// Neues Fenster
let _newWindowData = null; // { title, subtitle, type, labels, datasets, isSollIst, metrics }

function openPopupInNewWindow() {
  if (!_newWindowData) return;
  const d = _newWindowData;
  const isDarkMode = !document.body.classList.contains('light');
  const bg    = isDarkMode ? '#0f1117' : '#f0f4f8';
  const panel = isDarkMode ? '#1a1d27' : '#ffffff';
  const text  = isDarkMode ? '#f1f5f9' : '#1e2533';
  const muted = isDarkMode ? '#8fa3b8' : '#5a6a82';
  const border= isDarkMode ? '#22263a' : '#dde3ec';
  const grid  = isDarkMode ? '#22263a' : '#dde3ec';
  const ttbg  = isDarkMode ? '#23262e' : '#ffffff';

  const chartJs = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';

  const baseOpt = (yUnit) => JSON.stringify({
    responsive:true, maintainAspectRatio:false, animation:false,
    interaction:{mode:'index',intersect:false},
    plugins:{
      legend:{display:true,position:'top',labels:{boxWidth:12,font:{size:12},color:muted}},
      tooltip:{backgroundColor:ttbg,borderColor:border,borderWidth:1,titleColor:muted,bodyColor:text,padding:9}
    },
    scales:{
      x:{grid:{color:grid},ticks:{color:muted,font:{size:11},maxRotation:45,maxTicksLimit:14}},
      y:{grid:{color:grid},ticks:{color:muted,font:{size:12},callback:'__CB__'+yUnit+'__CB__'}}
    }
  }).replace(/"'__CB__(.+?)__CB__'"/g, `function(v){return v+' $1'}`);

  const btnStyle = `background:transparent;border:1px solid ${border};border-radius:6px;color:${muted};padding:7px 14px;cursor:pointer;font-size:12px;font-weight:600;transition:border-color .15s,color .15s`;

  let body = '';
  if (d.isSollIst) {
    const gridCards = d.metrics.map((m,i) => `
      <div class="gc" data-idx="${i}" style="background:${panel};border:1px solid ${border};border-radius:8px;padding:16px;cursor:pointer">
        <div style="font-size:12px;font-weight:700;margin-bottom:10px;pointer-events:none">${m.label} <span style="font-size:10px;color:${muted};font-weight:400">${m.unit}</span></div>
        <div style="position:relative;height:190px;pointer-events:none"><canvas id="gc${i}"></canvas></div>
      </div>`).join('');

    body = `
    <div id="grid-view" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(400px,1fr));gap:12px">${gridCards}</div>

    <div id="detail-view" style="display:none;flex-direction:column;height:calc(100vh - 112px)">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
        <button style="${btnStyle}" onclick="backToGrid()">← Übersicht</button>
        <span id="det-title" style="font-size:15px;font-weight:700;flex:1"></span>
        <span id="det-pos" style="color:${muted};font-size:12px"></span>
        <button style="${btnStyle}" onclick="nav(-1)">‹ Zurück</button>
        <button style="${btnStyle}" onclick="nav(+1)">Weiter ›</button>
      </div>
      <div style="flex:1;position:relative;min-height:0"><canvas id="det-canvas"></canvas></div>
    </div>

    <script>
    const M=${JSON.stringify(d.metrics)}, L=${JSON.stringify(d.labels)};
    const C={bg:'${bg}',panel:'${panel}',text:'${text}',muted:'${muted}',border:'${border}',grid:'${grid}',ttbg:'${ttbg}'};
    const gridCharts=[], ds=m=>[
      {label:'Ist (Archiv)', data:m.ist, borderColor:'#00d4ff',backgroundColor:'rgba(0,212,255,.1)',borderWidth:2,pointRadius:3,tension:.3,fill:false},
      {label:'Soll (Modell)',data:m.soll,borderColor:'#facc15',backgroundColor:'rgba(250,204,21,.1)',borderWidth:2,pointRadius:3,tension:.3,fill:false,borderDash:[5,4]}
    ];
    const opts=(unit,big)=>({responsive:true,maintainAspectRatio:false,animation:{duration:big?300:0},
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:true,position:'top',labels:{boxWidth:10,font:{size:big?12:10},color:C.muted}},
               tooltip:{backgroundColor:C.ttbg,borderColor:C.border,borderWidth:1,titleColor:C.muted,bodyColor:C.text,padding:8}},
      scales:{x:{grid:{color:C.grid},ticks:{color:C.muted,font:{size:big?11:9},maxRotation:45,maxTicksLimit:big?14:8}},
              y:{grid:{color:C.grid},ticks:{color:C.muted,font:{size:big?11:10},callback:v=>v+(unit?' '+unit:'')}}}});

    M.forEach((m,i)=>{
      gridCharts.push(new Chart(document.getElementById('gc'+i),{type:'line',data:{labels:L,datasets:ds(m)},options:opts(m.unit,false)}));
      document.querySelectorAll('.gc')[i].addEventListener('click',()=>showDetail(i));
      document.querySelectorAll('.gc')[i].addEventListener('mouseenter',function(){this.style.borderColor='#00d4ff';});
      document.querySelectorAll('.gc')[i].addEventListener('mouseleave',function(){this.style.borderColor='${border}';});
    });

    let cur=0, detChart=null;
    function showDetail(idx){
      cur=idx; const m=M[idx];
      document.getElementById('grid-view').style.display='none';
      document.getElementById('detail-view').style.display='flex';
      document.getElementById('det-title').textContent=m.label+' · '+m.unit;
      document.getElementById('det-pos').textContent=(idx+1)+' / '+M.length;
      if(detChart){detChart.destroy();detChart=null;}
      detChart=new Chart(document.getElementById('det-canvas'),{type:'line',data:{labels:L,datasets:ds(m)},options:opts(m.unit,true)});
    }
    function backToGrid(){
      document.getElementById('detail-view').style.display='none';
      document.getElementById('grid-view').style.display='grid';
      if(detChart){detChart.destroy();detChart=null;}
    }
    function nav(dir){showDetail((cur+dir+M.length)%M.length);}
    document.addEventListener('keydown',e=>{
      if(document.getElementById('detail-view').style.display==='none')return;
      if(e.key==='ArrowLeft')nav(-1);
      else if(e.key==='ArrowRight')nav(+1);
      else if(e.key==='Escape')backToGrid();
    });
    <\/script>`;
  } else {
    body = `<div style="position:relative;height:calc(100vh - 110px)"><canvas id="c0"></canvas></div>
            <script>new Chart(document.getElementById('c0'),{type:${JSON.stringify(d.type)},data:{labels:${JSON.stringify(d.labels)},datasets:${JSON.stringify(d.datasets)}},options:${baseOpt('')}});<\/script>`;
  }

  const win = window.open('', '_blank', 'width=1100,height=750');
  if (!win) { alert('Popup-Blocker aktiv — bitte erlauben.'); return; }
  win.document.write(`<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"/>
    <title>${d.title}</title>
    <script src="${chartJs}"><\/script>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{background:${bg};color:${text};font-family:'Inter',Arial,sans-serif;font-size:13px;padding:20px}
      #win-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;gap:16px}
      #win-header-text h1{font-size:18px;font-weight:700;margin-bottom:4px}
      #win-header-text p{color:${muted};font-size:12px}
      #close-btn{background:transparent;border:1px solid ${border};border-radius:6px;color:${muted};padding:8px 16px;cursor:pointer;font-size:13px;white-space:nowrap;flex-shrink:0}
      #close-btn:hover{border-color:${text};color:${text}}
    </style>
    </head><body>
    <div id="win-header">
      <div id="win-header-text"><h1>${d.title}</h1><p>${d.subtitle}</p></div>
      <button id="close-btn" onclick="window.close()">✕ Fenster schließen</button>
    </div>
    ${body}</body></html>`);
  win.document.close();
}
$('tile-popup-newwin').addEventListener('click', openPopupInNewWindow);

// ── Tagesübersicht ────────────────────────────────────────────────────────────
function openDayOverview() {
  if (!data) return;
  // today wird von loadWeather/renderCalendar gesetzt — hier NICHT überschreiben,
  // sonst desynchronisiert sich today von data (z.B. kurz nach Mitternacht).

  const ti    = data.daily.time.indexOf(today);
  let   fullR = getNext24hRange();
  // Fallback: wenn today nicht in data (edge case), erste 24h der Daten nehmen
  if (!fullR && data.hourly.time.length > 0) {
    fullR = { start: 0, end: Math.min(24, data.hourly.time.length) };
  }
  const nowH  = new Date().getHours();

  const labels = fullR ? data.hourly.time.slice(fullR.start, fullR.end).map(t =>
    `${fmtDate(t.split('T')[0]).slice(0,5)} ${t.slice(11,16)}`
  ) : [];
  const temp   = fullR ? (data.hourly.temperature_2m?.slice(fullR.start, fullR.end)       ?? []) : [];
  const appT   = fullR ? (data.hourly.apparent_temperature?.slice(fullR.start, fullR.end) ?? []) : [];
  const rain   = fullR ? (data.hourly.precipitation?.slice(fullR.start, fullR.end)        ?? []) : [];
  const uvH    = fullR ? (data.hourly.uv_index?.slice(fullR.start, fullR.end)             ?? []) : [];

  const tmax    = ti >= 0 ? data.daily.temperature_2m_max?.[ti]        : null;
  const tmin    = ti >= 0 ? data.daily.temperature_2m_min?.[ti]        : null;
  const rainD   = ti >= 0 ? data.daily.precipitation_sum?.[ti]         : null;
  const wmo     = ti >= 0 ? data.daily.weathercode?.[ti]               : null;
  const sunrise = ti >= 0 ? data.daily.sunrise?.[ti]?.slice(11,16)     : null;
  const sunset  = ti >= 0 ? data.daily.sunset?.[ti]?.slice(11,16)      : null;
  const windMax = ti >= 0 ? data.daily.windspeed_10m_max?.[ti]         : null;
  const uvMax   = uvH.filter(v => v != null).length
    ? Math.max(...uvH.filter(v => v != null)) : null;

  const tc   = window._chartTextColor    || '#8fa3b8';
  const gc   = window._chartGridColor    || '#22263a';
  const tb   = window._chartTooltipBg    || '#23262e';
  const tbc  = window._chartTooltipBorder || '#22263a';
  const body = isDark ? '#f1f5f9' : '#1e2533';
  const f1   = (v, d = 1) => v != null ? (+v).toFixed(d) : '—';

  const dateStr = new Date(today + 'T12:00').toLocaleDateString('de-DE', {
    weekday: 'long', day: 'numeric', month: 'long'
  });
  $('tile-popup-title').textContent    = `☀️  ${dateStr}`;
  $('tile-popup-subtitle').textContent =
    `${loc.name}${sunrise ? `   ·   ▲ ${sunrise}   ▼ ${sunset}` : ''}`;

  // Stündliche Daten für alle Metriken vorberechnen
  const windH  = fullR ? (data.hourly.windspeed_10m?.slice(fullR.start, fullR.end) ?? []) : [];
  const cloudH = fullR ? (data.hourly.cloudcover?.slice(fullR.start, fullR.end)    ?? []) : [];

  // Summary-Chips (key = Chart-Metrik beim Klick; sunrise = nur Info, kein Chart)
  const chips = [
    { key:'temp',  icon:'🌡', label:'Max / Min',   val:`${f1(tmax,0)}° / ${f1(tmin,0)}°`,                      col:'var(--orange)' },
    { key:'rain',  icon:'💧', label:'Regen heute', val:`${f1(rainD)} mm`,                                        col:'var(--teal)'   },
    { key:'uv',    icon:'🔆', label:'UV-Max',      val:uvMax != null ? `${f1(uvMax)} – ${uvLabel(uvMax)}` : '—', col:'var(--yellow)' },
    { key:'wind',  icon:'💨', label:'Wind-Max',    val:`${f1(windMax,0)} km/h`,                                  col:'var(--green)'  },
  ];
  const grid = $('tile-popup-compare-grid');
  grid.innerHTML = chips.map(c => `
    <div class="cmp-tile" data-key="${c.key}" style="cursor:${c.key === 'sunrise' ? 'default' : 'pointer'}">
      <div class="cmp-tile-label">${c.icon} ${c.label}</div>
      <div class="cmp-row"><span style="color:${c.col};font-size:14px;font-weight:700">${c.val}</span></div>
    </div>`).join('');
  grid.classList.add('visible');

  // Plugin: Sonnenauf/-untergang + aktuelle Stunde
  const srH = sunrise ? parseInt(sunrise.slice(0,2), 10) : -1;
  const ssH = sunset  ? parseInt(sunset.slice(0,2),  10) : -1;
  const sunPlugin = {
    id: 'dayLines',
    afterDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!scales.x || !chart.data.labels?.length) return;
      const draw = (h, color, dash, glyph, top) => {
        const getH = l => parseInt((l.includes(' ') ? l.split(' ')[1] : l).slice(0,2), 10);
        const idx = chart.data.labels.findIndex(l => getH(l) === h);
        if (idx < 0) return;
        const x = scales.x.getPixelForValue(idx);
        ctx.save();
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
        ctx.setLineDash([]); ctx.fillStyle = color;
        ctx.font = 'bold 11px Inter,sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(glyph, x, top ? chartArea.top + 13 : chartArea.bottom - 5);
        ctx.restore();
      };
      if (srH >= 0) draw(srH, 'rgba(251,146,60,.85)',  [4,3], '▲', true);
      if (ssH >= 0) draw(ssH, 'rgba(167,139,250,.85)', [4,3], '▼', true);
      draw(nowH, 'rgba(0,212,255,.75)', [], '◆', false);
    }
  };

  // Chart-Definitionen pro Metrik
  const metricDefs = {
    temp: {
      ctype:'bar',
      ds:[
        { type:'line', label:'Temperatur (°C)', data:temp,
          borderColor:'#fb923c', backgroundColor:'rgba(251,146,60,.1)',
          borderWidth:2.5, pointRadius:0, tension:.35, fill:true, yAxisID:'y', order:1 },
        { type:'line', label:'Gefühlt (°C)', data:appT,
          borderColor:'rgba(250,204,21,.65)', backgroundColor:'transparent',
          borderWidth:1.5, pointRadius:0, tension:.35, fill:false, borderDash:[4,3], yAxisID:'y', order:1 },
        { type:'bar', label:'Niederschlag (mm)', data:rain,
          backgroundColor:'rgba(0,212,255,.35)', borderColor:'transparent',
          borderWidth:0, yAxisID:'y1', barPercentage:0.9, categoryPercentage:1.0, order:2 }
      ],
      yColor:'#fb923c', yUnit:'°',
      y1:{ position:'right', grid:{drawOnChartArea:false},
           ticks:{ color:'#00d4ff', font:{size:11}, callback: v => v+' mm' }, min:0 }
    },
    rain: {
      ctype:'bar',
      ds:[{ label:'Niederschlag (mm)', data:rain,
            backgroundColor:'rgba(0,212,255,.6)', borderColor:'transparent',
            borderWidth:0, barPercentage:0.9, categoryPercentage:1.0 }],
      yColor:'#00d4ff', yUnit:' mm'
    },
    uv: {
      ctype:'line',
      ds:[{ label:'UV-Index', data:uvH,
            borderColor:'#facc15', backgroundColor:'rgba(250,204,21,.1)',
            borderWidth:2, pointRadius:0, tension:.3, fill:true }],
      yColor:'#facc15', yUnit:''
    },
    wind: {
      ctype:'line',
      ds:[{ label:'Wind (km/h)', data:windH,
            borderColor:'#34d399', backgroundColor:'rgba(52,211,153,.1)',
            borderWidth:2, pointRadius:0, tension:.3, fill:true }],
      yColor:'#34d399', yUnit:' km/h'
    },
    cloud: {
      ctype:'bar',
      ds:[{ label:'Bewölkung (%)', data:cloudH,
            backgroundColor:'rgba(143,163,184,.4)', borderColor:'transparent',
            borderWidth:0, barPercentage:0.9, categoryPercentage:1.0 }],
      yColor:'#8fa3b8', yUnit:'%'
    },
  };

  const xTickCb = function(value, index) {
    const lbl  = this.getLabelForValue(value);
    const last = this.chart.data.labels.length - 1;
    if (index === 0 || index === last) return lbl;
    const tp = lbl.includes(' ') ? lbl.split(' ')[1] : lbl;
    const h  = parseInt(tp.slice(0,2), 10);
    return Number.isFinite(h) && h % 4 === 0 ? lbl : '';
  };

  function drawDayMetric(key) {
    const def = metricDefs[key];
    if (!def) return;
    if (tilePopupChart) { tilePopupChart.destroy(); tilePopupChart = null; }
    const scales = {
      x: { grid:{color:gc}, ticks:{ color:tc, font:{size:11}, maxRotation:0, autoSkip:false, callback:xTickCb }},
      y: { position:'left', grid:{color:gc}, ticks:{ color:def.yColor, font:{size:11}, callback: v => v + def.yUnit }}
    };
    if (def.y1) scales.y1 = def.y1;
    tilePopupChart = new Chart($('tile-popup-canvas'), {
      type: def.ctype,
      data: { labels, datasets: def.ds },
      options: {
        responsive:true, maintainAspectRatio:false, animation:{ duration:200 },
        interaction:{ mode:'index', intersect:false },
        plugins:{
          legend:{ display: def.ds.length > 1, position:'top', labels:{ boxWidth:12, font:{size:11}, color:tc }},
          tooltip:{ backgroundColor:tb, borderColor:tbc, borderWidth:1, titleColor:tc, bodyColor:body, padding:9 }
        },
        scales
      },
      plugins: [sunPlugin]
    });
  }

  _newWindowData = {
    title: `☀️ ${dateStr}`, subtitle: $('tile-popup-subtitle').textContent,
    type:'line', labels,
    datasets:[{ label:'Temperatur (°C)', data:temp, borderColor:'#fb923c',
      backgroundColor:'rgba(251,146,60,.12)', borderWidth:2, pointRadius:0, tension:.3, fill:true }],
    isSollIst: false
  };

  // Standard-Ansicht + Chip-Klick-Handler
  drawDayMetric('temp');
  grid.querySelector('[data-key="temp"]')?.classList.add('active');

  grid.querySelectorAll('.cmp-tile[data-key]').forEach(el => {
    if (el.dataset.key === 'sunrise') return;
    el.addEventListener('click', () => {
      grid.querySelectorAll('.cmp-tile').forEach(t => t.classList.remove('active'));
      el.classList.add('active');
      drawDayMetric(el.dataset.key);
    });
  });

  _activePopupKey = 'dayoverview';
  $('tile-popup-overlay').classList.add('open');
}

function showFieldPopup() {
  if (!data) return;
  const nowH = new Date().getHours();
  const si = data.hourly.time.findIndex(
    t => t.startsWith(today) && parseInt(t.slice(11,13)) === nowH
  );
  if (si < 0) return;
  const ei = Math.min(data.hourly.time.length, si + 73);

  const labels = data.hourly.time.slice(si, ei).map(t =>
    `${fmtDate(t.split('T')[0]).slice(0,5)} ${t.slice(11,16)}`
  );
  const wind = data.hourly.windspeed_10m?.slice(si, ei)          ?? [];
  const rain = data.hourly.precipitation?.slice(si, ei)          ?? [];
  const sm0  = data.hourly.soil_moisture_0_to_1cm?.[si]          ?? null;
  const sm0txt = sm0 != null ? `  ·  Boden: ${(sm0 * 100).toFixed(0)} Vol.%` : '';

  const tc  = window._chartTextColor    || '#8fa3b8';
  const gc  = window._chartGridColor    || '#22263a';
  const tb  = window._chartTooltipBg    || '#23262e';
  const tbc = window._chartTooltipBorder || '#22263a';
  const bodyCol = isDark ? '#f1f5f9' : '#1e2533';

  $('tile-popup-title').textContent    = '🌿 Spritzen · 🚜 Fahren';
  $('tile-popup-subtitle').textContent = `Wind & Niederschlag · 3 Tage${sm0txt}`;
  $('tile-popup-compare-grid').classList.remove('visible');
  $('tile-popup-compare-grid').innerHTML = '';

  _newWindowData = {
    title: '🌿 Spritzen · 🚜 Fahren',
    subtitle: `Wind & Niederschlag · 3 Tage${sm0txt}`,
    type: 'line', labels,
    datasets: [
      { label: 'Wind (km/h)', data: wind, borderColor: '#34d399',
        backgroundColor: 'rgba(52,211,153,.12)', borderWidth: 2,
        pointRadius: 0, tension: .3, fill: true }
    ],
    isSollIst: false
  };

  if (tilePopupChart) { tilePopupChart.destroy(); tilePopupChart = null; }

  const xTick = function(value, index) {
    const lbl  = this.getLabelForValue(value);
    const last = this.chart.data.labels.length - 1;
    if (index === 0 || index === last) return lbl;
    const tp   = lbl.includes(' ') ? lbl.split(' ')[1] : lbl;
    const h    = parseInt(tp.slice(0, 2), 10);
    return Number.isFinite(h) && h % 6 === 0 ? lbl : '';
  };

  tilePopupChart = new Chart($('tile-popup-canvas'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { type: 'line', label: 'Wind (km/h)',  data: wind,
          borderColor: '#34d399', backgroundColor: 'rgba(52,211,153,.1)',
          borderWidth: 2, pointRadius: 0, tension: .3, fill: true, yAxisID: 'y', order: 1 },
        { type: 'line', label: '18 km/h Grenze', data: Array(wind.length).fill(18),
          borderColor: 'rgba(239,68,68,.5)', borderDash: [5,4], borderWidth: 1.5,
          pointRadius: 0, fill: false, yAxisID: 'y', order: 1 },
        { type: 'bar',  label: 'Niederschlag (mm)', data: rain,
          backgroundColor: 'rgba(0,212,255,.55)', borderColor: 'transparent',
          borderWidth: 0, yAxisID: 'y1',
          barPercentage: 0.9, categoryPercentage: 1.0, order: 2 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 250 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true, position: 'top',
          labels: { boxWidth: 12, font: { size: 11 }, color: tc,
            filter: item => item.text !== '18 km/h Grenze' }
        },
        tooltip: { backgroundColor: tb, borderColor: tbc, borderWidth: 1,
          titleColor: tc, bodyColor: bodyCol, padding: 9 }
      },
      scales: {
        x:  { grid: { color: gc },
              ticks: { color: tc, font: { size: 10 }, maxRotation: 45,
                       autoSkip: false, callback: xTick } },
        y:  { position: 'left',  grid: { color: gc },
              ticks: { color: '#34d399', font: { size: 11 }, callback: v => v + ' km/h' } },
        y1: { position: 'right', grid: { drawOnChartArea: false },
              ticks: { color: '#00d4ff',  font: { size: 11 }, callback: v => v + ' mm' },
              min: 0 }
      }
    }
  });

  _activePopupKey = 'field';
  $('tile-popup-overlay').classList.add('open');
}

function showTilePopup(key) {
  if (!data) return;
  if (key === 'field') { showFieldPopup(); return; }
  const h24 = getLast24hRange();
  const dayRest = getRestOfTodayRange();
  const sliceH = (field, r) => r ? (data.hourly[field]?.slice(r.start, r.end) ?? []) : [];
  const labH   = r => r ? data.hourly.time.slice(r.start, r.end).map(t => t.slice(11,16)) : [];
  const labTo2359 = r => {
    const labels = labH(r);
    if (labels.length && labels[labels.length - 1] !== '23:59') labels.push('23:59');
    return labels;
  };
  const sliceTo2359 = (field, r) => {
    const values = sliceH(field, r);
    if (values.length) values.push(values[values.length - 1]);
    return values;
  };

  const dsLine = (label, field, range, color, colorAlpha) => ({
    label, data: sliceH(field, range),
    borderColor: color, backgroundColor: colorAlpha,
    borderWidth: 2, pointRadius: 0, tension: .3, fill: true
  });
  const dsLineTo2359 = (label, field, range, color, colorAlpha) => ({
    label, data: sliceTo2359(field, range),
    borderColor: color, backgroundColor: colorAlpha,
    borderWidth: 2, pointRadius: 0, tension: .3, fill: true
  });
  const dsBar = (label, field, range, color, colorAlpha) => ({
    label, data: sliceH(field, range),
    backgroundColor: colorAlpha, borderColor: color, borderWidth: 1
  });

  const configs = {
    temp:     { title:'🌡️ Temperatur',         sub:'Stundenverlauf jetzt bis 23:59', labels:labTo2359(dayRest), ds:[dsLineTo2359('°C','temperature_2m',dayRest,'#fb923c','rgba(251,146,60,.15)')],       type:'line' },
    apparent: { title:'🌡 Gefühlte Temperatur', sub:'Stundenverlauf jetzt bis 23:59', labels:labTo2359(dayRest), ds:[dsLineTo2359('°C','apparent_temperature',dayRest,'#facc15','rgba(250,204,21,.15)')],  type:'line' },
    wind:     { title:'💨 Wind',                sub:'Stundenverlauf jetzt bis 23:59', labels:labTo2359(dayRest), ds:[dsLineTo2359('km/h','windspeed_10m',dayRest,'#34d399','rgba(52,211,153,.15)')],        type:'line' },
    hum:      { title:'💦 Luftfeuchte',         sub:'Stundenverlauf jetzt bis 23:59', labels:labTo2359(dayRest), ds:[dsLineTo2359('%','relativehumidity_2m',dayRest,'#a78bfa','rgba(167,139,250,.15)')],   type:'line' },
    cloud:    { title:'☁️ Bewölkung',           sub:'Stundenverlauf jetzt bis 23:59', labels:labTo2359(dayRest), ds:[dsLineTo2359('%','cloudcover',dayRest,'#8fa3b8','rgba(143,163,184,.15)')],             type:'line' },
    uv:       { title:'🔆 UV-Index',            sub:'Stundenverlauf jetzt bis 23:59', labels:labTo2359(dayRest), ds:[dsLineTo2359('','uv_index',dayRest,'#facc15','rgba(250,204,21,.15)')],                type:'line' },
    sm:       { title:'🟤 Bodenfeuchte 0–1cm',  sub:'Stundenverlauf jetzt bis 23:59', labels:labTo2359(dayRest),
      ds:[{ label:'Vol.%', data: sliceTo2359('soil_moisture_0_to_1cm',dayRest).map(v=>v!=null?+(v*100).toFixed(2):null),
            borderColor:'#fb923c', backgroundColor:'rgba(251,146,60,.15)', borderWidth:2, pointRadius:0, tension:.3, fill:true }], type:'line' },
    st:       { title:'🌡 Bodentemp. 0cm',      sub:'Stundenverlauf jetzt bis 23:59', labels:labTo2359(dayRest), ds:[dsLineTo2359('°C','soil_temperature_0cm',dayRest,'#a78bfa','rgba(167,139,250,.15)')], type:'line' },
    precip:   { title:'💧 Niederschlag',        sub:'Stündliche Mengen letzte 24h',   labels:labH(h24), ds:[dsBar('mm','precipitation',h24,'#00d4ff','rgba(0,212,255,.55)')],            type:'bar'  },
    rain24:   { title:'💧 Niederschlag heute', sub:'Stündliche Mengen jetzt bis 23:59',labels:labTo2359(dayRest), ds:[dsLineTo2359('mm','precipitation',dayRest,'#00d4ff','rgba(0,212,255,.15)')], type:'line' },
    frost:    {
      title:'🧊 Frostwarnung', sub:'Temperaturverlauf jetzt bis 23:59', labels:labTo2359(dayRest), type:'line',
      ds:[
        dsLineTo2359('Temp. °C','temperature_2m',dayRest,'#60a5fa','rgba(96,165,250,.15)'),
        { label:'0°C', data:Array(labTo2359(dayRest).length).fill(0),
          borderColor:'rgba(96,165,250,.45)', borderDash:[5,5], borderWidth:1, pointRadius:0, fill:false }
      ]
    }
  };

  const cfg = configs[key];
  if (!cfg) return;
  _activePopupKey = key;
  openTilePopup(cfg.title, cfg.sub, cfg.labels, cfg.ds, cfg.type);
}

document.querySelectorAll('[data-popup]').forEach(tile => {
  tile.addEventListener('click', () => showTilePopup(tile.dataset.popup));
});

// ── Soll / Ist Vergleich ─────────────────────────────────────────────────────
async function loadSollIst() {
  if (!window._lastAnalysisData || !window._lastAnalysisRange) return;
  const { start, end } = window._lastAnalysisRange;
  const btn = $('soll-ist-btn');
  btn.textContent = '⏳'; btn.disabled = true;
  try {
    const daysBack = Math.ceil((new Date(today + 'T12:00') - new Date(start + 'T12:00')) / 864e5) + 1;
    const model = await fetchForecastFromDb(Math.min(daysBack, 92), 1);

    const arch = window._lastAnalysisData.daily;
    const labels = [];
    const iPrec=[], sPrec=[], iTmax=[], sTmax=[], iTmin=[], sTmin=[],
          iEt0=[],  sEt0=[],  iWind=[], sWind=[];

    arch.time.forEach((d, i) => {
      if (d < start || d > end) return;
      const mi = model.daily.time.indexOf(d);
      labels.push(fmtDate(d).slice(0, 5));
      const get = (arr, key) => arr[key]?.[i] ?? null;
      const mod = (key) => mi >= 0 ? (model.daily[key]?.[mi] ?? null) : null;
      iPrec.push(get(arch,'precipitation_sum'));       sPrec.push(mod('precipitation_sum'));
      iTmax.push(get(arch,'temperature_2m_max'));      sTmax.push(mod('temperature_2m_max'));
      iTmin.push(get(arch,'temperature_2m_min'));      sTmin.push(mod('temperature_2m_min'));
      iEt0.push(get(arch,'et0_fao_evapotranspiration'));sEt0.push(mod('et0_fao_evapotranspiration'));
      iWind.push(get(arch,'windspeed_10m_max'));       sWind.push(mod('windspeed_10m_max'));
    });

    const avg2 = (a,b) => a.map((v,i) => v!=null&&b[i]!=null ? +((v+b[i])/2).toFixed(1) : null);
    const wbArr = (p,e) => p.map((v,i) => v!=null&&e[i]!=null ? +(v-e[i]).toFixed(1) : null);
    const iAvgT = avg2(iTmax,iTmin), sAvgT = avg2(sTmax,sTmin);
    const iWb   = wbArr(iPrec,iEt0), sWb  = wbArr(sPrec,sEt0);

    const sumF  = a => a.filter(v=>v!=null).reduce((s,v)=>s+v,0);
    const avgF  = a => { const f=a.filter(v=>v!=null); return f.length?sumF(f)/f.length:null; };
    const maxF  = a => { const f=a.filter(v=>v!=null); return f.length?Math.max(...f):null; };
    const minF  = a => { const f=a.filter(v=>v!=null); return f.length?Math.min(...f):null; };
    const f1    = (v,d=1) => v!=null ? (+v).toFixed(d) : '—';

    const metrics = [
      { key:'prec', label:'🌧 Niederschlag', unit:'mm',   dec:1, iV:sumF(iPrec),  sV:sumF(sPrec),  ist:iPrec,  soll:sPrec  },
      { key:'avgT', label:'🌡 Ø Temperatur', unit:'°C',   dec:1, iV:avgF(iAvgT),  sV:avgF(sAvgT),  ist:iAvgT,  soll:sAvgT  },
      { key:'tmax', label:'↑ Temp Max',      unit:'°C',   dec:1, iV:maxF(iTmax),  sV:maxF(sTmax),  ist:iTmax,  soll:sTmax  },
      { key:'tmin', label:'↓ Temp Min',      unit:'°C',   dec:1, iV:minF(iTmin),  sV:minF(sTmin),  ist:iTmin,  soll:sTmin  },
      { key:'et0',  label:'🌿 ET₀',          unit:'mm',   dec:1, iV:sumF(iEt0),   sV:sumF(sEt0),   ist:iEt0,   soll:sEt0   },
      { key:'wb',   label:'⚖️ Wasserbilanz', unit:'mm',   dec:1, iV:sumF(iWb),    sV:sumF(sWb),    ist:iWb,    soll:sWb    },
      { key:'wind', label:'💨 Ø Wind',       unit:'km/h', dec:0, iV:avgF(iWind),  sV:avgF(sWind),  ist:iWind,  soll:sWind  },
    ];

    const grid = $('tile-popup-compare-grid');
    grid.innerHTML = metrics.map(m => {
      const delta = (m.iV != null && m.sV != null) ? +(m.iV - m.sV).toFixed(m.dec) : null;
      const dCol  = delta == null ? 'var(--muted)'
                  : Math.abs(delta) < (m.unit==='km/h'?2:.5) ? 'var(--green)'
                  : Math.abs(delta) < (m.unit==='km/h'?10:5) ? 'var(--yellow)' : 'var(--red)';
      return `<div class="cmp-tile" data-key="${m.key}">
        <div class="cmp-tile-label">${m.label}</div>
        <div class="cmp-row">
          <span class="cmp-ist">${f1(m.iV,m.dec)}<span class="cmp-unit"> ${m.unit}</span></span>
          <span class="cmp-soll">${f1(m.sV,m.dec)}<span class="cmp-unit"> ${m.unit}</span></span>
        </div>
        <div class="cmp-delta">Δ <span style="color:${dCol}">${delta!=null?(delta>0?'+':'')+delta+'':' —'}</span> ${delta!=null?m.unit:''}</div>
      </div>`;
    }).join('');
    grid.classList.add('visible');

    // Chart für gewählte Metrik rendern
    let activeChart = null;
    function drawMetric(key) {
      grid.querySelectorAll('.cmp-tile').forEach(el => el.classList.toggle('active', el.dataset.key === key));
      const m  = metrics.find(x => x.key === key);
      const tc = window._chartTextColor   || '#8fa3b8';
      const gc = window._chartGridColor   || '#22263a';
      const tb = window._chartTooltipBg   || '#23262e';
      const tbc= window._chartTooltipBorder || '#22263a';
      const bodyCol = isDark ? '#f1f5f9' : '#1e2533';
      if (tilePopupChart) { tilePopupChart.destroy(); tilePopupChart = null; }
      tilePopupChart = new Chart($('tile-popup-canvas'), {
        type: 'line',
        data: { labels, datasets: [
          { label:`Ist (Archiv)`,  data:m.ist,  borderColor:'#00d4ff', backgroundColor:'rgba(0,212,255,.1)',  borderWidth:2, pointRadius:3, tension:.3, fill:false },
          { label:`Soll (Modell)`, data:m.soll, borderColor:'#facc15', backgroundColor:'rgba(250,204,21,.1)', borderWidth:2, pointRadius:3, tension:.3, fill:false, borderDash:[5,4] }
        ]},
        options: {
          responsive:true, maintainAspectRatio:false, animation:{duration:200},
          interaction:{mode:'index',intersect:false},
          plugins:{
            legend:{display:true,position:'top',labels:{boxWidth:12,font:{size:11},color:tc}},
            tooltip:{backgroundColor:tb,borderColor:tbc,borderWidth:1,titleColor:tc,bodyColor:bodyCol,padding:9}
          },
          scales:{
            x:{grid:{color:gc},ticks:{color:tc,font:{size:10},maxRotation:45,maxTicksLimit:14}},
            y:{grid:{color:gc},ticks:{color:tc,font:{size:11},callback:v=>v+' '+m.unit}}
          }
        }
      });
    }

    grid.querySelectorAll('.cmp-tile').forEach(el =>
      el.addEventListener('click', () => drawMetric(el.dataset.key))
    );

    _newWindowData = {
      title: '⚖ Soll / Ist Vergleich',
      subtitle: `${fmtDate(start)} → ${fmtDate(end)}  ·  Ist = Archiv  ·  Soll = Modell`,
      isSollIst: true, labels,
      metrics: metrics.map(m => ({ label: m.label, unit: m.unit, ist: m.ist, soll: m.soll }))
    };
    $('tile-popup-title').textContent    = _newWindowData.title;
    $('tile-popup-subtitle').textContent = _newWindowData.subtitle;
    $('tile-popup-overlay').classList.add('open');
    drawMetric('prec');

  } catch(e) {
    alert('Fehler: ' + e.message);
  } finally {
    btn.textContent = '⚖ Soll / Ist'; btn.disabled = false;
  }
}
$('soll-ist-btn').addEventListener('click', loadSollIst);

async function loadWeather(pastDays = 0, targetRng = null, force = false) {
  today = getToday();
  hd('empty'); hd('dashboard'); hd('error-bar');
  sh('loading');
  $('load-btn').disabled = true;
  $('load-btn').textContent = '⏳ Lädt…';
  updateFreshnessStatus(null, true);

  try {
    data = await fetchForecastFromDb(pastDays, 14, force);
    updateFreshnessStatus(data._mowetter_cache);
    chartData = data; // Forecast ist Standard-Datenquelle für Charts
    loadedPastDays = pastDays;

    rng = targetRng
      ? { ...targetRng, sel: false }
      : { start: data.daily.time[0], end: data.daily.time[data.daily.time.length-1], sel: false };

    updateLocInfo();
    updateTiles();
    checkFrostAlarm();
    renderCalendar();
    renderChart();
    syncFilterButtons(); // Button-States an neuen rng anpassen

    hd('loading');
    sh('dashboard', 'block');

    // Analyse automatisch für geladenen Zeitraum aktualisieren
    triggerAnalysis(rng.start, rng.end);
  } catch(e) {
    $('error-bar').textContent = '⚠️ Fehler: ' + e.message;
    sh('error-bar', 'block');
    hd('loading');
    sh('empty');
  } finally {
    $('load-btn').disabled = false;
    $('load-btn').textContent = '↺ Aktualisieren';
  }
}

function updateLocInfo() {
  const t = new Date().toLocaleTimeString('de-DE', {hour:'2-digit',minute:'2-digit'});
  $('loc-info').textContent = `${loc.name} · ${(+loc.lat).toFixed(2)}°N ${(+loc.lon).toFixed(2)}°E · geladen: ${t}`;
  localStorage.setItem('mw_last_loc', JSON.stringify({ name: loc.name, lat: loc.lat, lon: loc.lon }));
  startAutoRefresh();
}

// ── Zeitbereich-Helfer ────────────────────────────────────────────────────────
function getLast24hRange() {
  const nowH = new Date().getHours();
  const hi = data.hourly.time.findIndex(t => t.startsWith(today) && parseInt(t.slice(11,13)) === nowH);
  if (hi < 0) return null;
  return { start: Math.max(0, hi - 23), end: hi + 1 };
}
function getNext24hRange() {
  const nowH = new Date().getHours();
  const hi = data.hourly.time.findIndex(t => t.startsWith(today) && parseInt(t.slice(11,13)) === nowH);
  if (hi < 0) return null;
  return { start: hi, end: Math.min(data.hourly.time.length, hi + 25) };
}
function getTodayRange() {
  const startIdx = data.hourly.time.findIndex(t => t.startsWith(today));
  const nowH = new Date().getHours();
  const endIdx = data.hourly.time.findIndex(t => t.startsWith(today) && parseInt(t.slice(11,13)) === nowH);
  if (startIdx < 0 || endIdx < 0) return null;
  return { start: startIdx, end: endIdx + 1 };
}
function getRestOfTodayRange() {
  const nowH = new Date().getHours();
  const startIdx = data.hourly.time.findIndex(t => t.startsWith(today) && parseInt(t.slice(11,13)) === nowH);
  if (startIdx < 0) return null;
  const tomorrow = addDays(today, 1);
  const tomorrowIdx = data.hourly.time.findIndex(t => t.startsWith(tomorrow));
  if (tomorrowIdx > startIdx) return { start: startIdx, end: tomorrowIdx };
  const endIdx = data.hourly.time.findLastIndex(t => t.startsWith(today));
  return endIdx >= startIdx ? { start: startIdx, end: endIdx + 1 } : null;
}
function getFullTodayRange() {
  const startIdx = data.hourly.time.findIndex(t => t.startsWith(today));
  if (startIdx < 0) return null;
  const tomorrow = addDays(today, 1);
  const tomorrowIdx = data.hourly.time.findIndex(t => t.startsWith(tomorrow));
  if (tomorrowIdx > startIdx) return { start: startIdx, end: tomorrowIdx };
  const endIdx = data.hourly.time.findLastIndex(t => t.startsWith(today));
  return endIdx >= startIdx ? { start: startIdx, end: endIdx + 1 } : null;
}

// ── Tiles ─────────────────────────────────────────────────────────────────────
function updateTiles() {
  const cur  = data.current_weather;
  const ti   = data.daily.time.indexOf(today);
  const nowH = new Date().getHours();
  const hi   = data.hourly.time.findIndex(t => t.startsWith(today) && parseInt(t.slice(11,13)) === nowH);

  const html = (id, h) => $(id).innerHTML = h;
  const u    = (v, unit) => v != null ? `${v}<span class="tile-unit">${unit}</span>` : `—<span class="tile-unit">${unit}</span>`;

  // Basis
  html('t-temp',     u(cur?.temperature?.toFixed(1), '°C'));
  const appTemp = hi>=0 ? data.hourly.apparent_temperature?.[hi] : null;
  html('t-apparent', u(appTemp?.toFixed(1), '°C'));
  html('t-maxmin',   ti>=0
    ? `<span style="color:var(--red)">${data.daily.temperature_2m_max[ti]?.toFixed(0)}°</span>&nbsp;/&nbsp;<span style="color:var(--blue)">${data.daily.temperature_2m_min[ti]?.toFixed(0)}°</span>`
    : '—');
  const h24r = getLast24hRange();
  const precip24h = h24r ? data.hourly.precipitation?.slice(h24r.start, h24r.end).reduce((s,v)=>s+(v??0),0) : null;
  html('t-precip', u(precip24h != null ? precip24h.toFixed(1) : null, ' mm'));

  // Wind mit Richtung
  const windDir_  = hi>=0 ? data.hourly.winddirection_10m?.[hi] : (cur?.winddirection ?? null);
  const windSpeed = cur?.windspeed;
  html('t-wind', windSpeed != null
    ? `${windSpeed.toFixed(0)}<span class="tile-unit"> km/h</span><br><span style="font-size:16px;color:var(--muted)">${windDir(windDir_)}</span>`
    : '—');

  html('t-hum',   u(hi>=0 ? data.hourly.relativehumidity_2m[hi] : null, ' %'));
  html('t-cloud', u(hi>=0 ? data.hourly.cloudcover[hi] : null, ' %'));
  html('t-wmo',   ti>=0 ? `${wmoI(data.daily.weathercode[ti])} ${wmoL(data.daily.weathercode[ti])}` : '—');

  // UV-Index
  const uv = hi>=0 ? data.hourly.uv_index?.[hi] : null;
  html('t-uv', uv != null
    ? `${uv.toFixed(1)}<br><span style="font-size:13px">${uvLabel(uv)}</span>`
    : '—');

  // Sonnenauf/-untergang
  if (ti>=0 && data.daily.sunrise?.[ti]) {
    const rise = data.daily.sunrise[ti].slice(11,16);
    const set_ = data.daily.sunset[ti].slice(11,16);
    html('t-sun', `▲ ${rise}<br>▼ ${set_}`);
  } else { html('t-sun', '—'); }

  // Agrar
  const et0    = ti>=0 ? data.daily.et0_fao_evapotranspiration?.[ti] : null;
  const precip = ti>=0 ? data.daily.precipitation_sum?.[ti] : null;
  const wb     = (et0 != null && precip != null) ? (precip - et0).toFixed(1) : null;
  const sm0    = hi>=0 ? data.hourly.soil_moisture_0_to_1cm?.[hi] : null;
  const st0    = hi>=0 ? data.hourly.soil_temperature_0cm?.[hi] : null;
  const wbCol  = wb != null ? (parseFloat(wb) >= 0 ? 'var(--green)' : parseFloat(wb) >= -10 ? 'var(--yellow)' : 'var(--red)') : 'var(--yellow)';

  html('t-et0', u(et0?.toFixed(1), ' mm'));
  html('t-wb',  wb != null ? `<span style="color:${wbCol}">${+wb > 0 ? '+'+wb : wb}</span><span class="tile-unit"> mm</span>` : '—');
  html('t-sm',  u(sm0 != null ? (sm0*100).toFixed(1) : null, ' Vol.%'));
  html('t-st',  u(st0?.toFixed(1), ' °C'));

  // Frostwarnung: nächste 24h Minimum
  const n24r = getNext24hRange();
  const next24temps = n24r ? (data.hourly.temperature_2m?.slice(n24r.start, n24r.end).filter(v => v != null) ?? []) : [];
  const minNext24 = next24temps.length ? Math.min(...next24temps) : null;
  const refTemp = minNext24 ?? st0;
  const tempStr = refTemp != null
    ? `<br><span style="font-size:13px;color:var(--muted)">min. ${refTemp.toFixed(1)}°C</span>`
    : '';
  const hardFrost = (minNext24 != null && minNext24 < -2) || (st0 != null && st0 < -2);
  const frostRisk = !hardFrost && ((minNext24 != null && minNext24 < 0) || (st0 != null && st0 < 0));
  const tileFrost = document.getElementById('tile-frost');
  if (hardFrost) {
    tileFrost.style.borderColor = 'var(--blue)';
    tileFrost.style.background  = 'rgba(96,165,250,.12)';
    html('t-frost', `<span style="color:var(--blue)">❄️ Frost!</span>${tempStr}`);
  } else if (frostRisk) {
    tileFrost.style.borderColor = 'var(--yellow)';
    tileFrost.style.background  = 'rgba(250,204,21,.08)';
    html('t-frost', `<span style="color:var(--yellow)">⚠️ Frostgefahr</span>${tempStr}`);
  } else {
    tileFrost.style.borderColor = '';
    tileFrost.style.background  = '';
    html('t-frost', `<span style="color:var(--green)">✅ Kein Frost</span>${tempStr}`);
  }

  // Trockenstreifen: Tage in Folge mit <1mm (rückwärts von heute)
  let dryDays = 0;
  const todayIdx = data.daily.time.indexOf(today);
  if (todayIdx >= 0) {
    for (let i = todayIdx; i >= 0; i--) {
      const p = data.daily.precipitation_sum[i] ?? 0;
      if (p >= 1) break;
      dryDays++;
    }
  }
  const dryCol = dryDays <= 3 ? 'var(--green)' : dryDays <= 7 ? 'var(--yellow)' : 'var(--red)';
  html('t-dry', `<span style="color:${dryCol}">${dryDays}</span><span class="tile-unit"> Tage</span>`);

  // Niederschlag heute (Open-Meteo-Summe; kann Regen, Schnee oder Schauer enthalten)
  const rain24 = ti >= 0 ? data.daily.precipitation_sum[ti] : null;
  html('t-rain24', u(rain24 != null ? rain24.toFixed(1) : null, ' mm'));

  // 7-Tage Regensumme
  const sevenAgo = addDays(today, -6);
  const r7start  = data.daily.time.indexOf(sevenAgo);
  const rain7    = r7start >= 0 && ti >= 0
    ? data.daily.precipitation_sum.slice(r7start, ti + 1).reduce((s, v) => s + (v ?? 0), 0)
    : null;
  html('t-rain7', u(rain7 != null ? rain7.toFixed(1) : null, ' mm'));

  // Spritzen · Fahren – reale Messwerte
  const windNow = hi >= 0 ? (data.hourly.windspeed_10m?.[hi]          ?? null) : null;
  const sm0Now  = hi >= 0 ? (data.hourly.soil_moisture_0_to_1cm?.[hi] ?? null) : null;

  const fRow = (label, valHtml, last = false) =>
    `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:3px 0` +
    `${last ? '' : ';border-bottom:1px solid var(--border)'}">` +
    `<span style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">${label}</span>` +
    `<span style="font-size:14px;font-weight:600">${valHtml}</span></div>`;
  const fVal = (v, mul, dec, unit) => v != null
    ? `${(v * mul).toFixed(dec)}<span style="font-size:10px;color:var(--muted);font-weight:400"> ${unit}</span>`
    : '—';

  html('t-field',
    fRow('Wind',      fVal(windNow,   1,   0, 'km/h'))       +
    fRow('Boden',     fVal(sm0Now,    100, 0, 'Vol.%'))      +
    fRow('Regen 24h', fVal(precip24h, 1,   1, 'mm'),  true)
  );
}

// ── Calendar ──────────────────────────────────────────────────────────────────
function renderCalendar() {
  today = getToday();
  const strip = $('cal-strip');
  strip.innerHTML = '';

  data.daily.time.forEach((date, i) => {
    const past    = date < today;
    const isToday = date === today;
    const future  = date > today;
    const inRange = date >= rng.start && date <= rng.end;
    const isSel   = rng.sel && date === rng.start;

    const lbl  = new Date(date+'T12:00').toLocaleDateString('de-DE',{weekday:'short',day:'2-digit',month:'2-digit'});
    const max  = data.daily.temperature_2m_max[i]?.toFixed(0);
    const min  = data.daily.temperature_2m_min[i]?.toFixed(0);
    const prec = data.daily.precipitation_sum[i];

    const div = document.createElement('div');
    div.className = 'day'
      + (isToday ? ' is-today' : inRange ? ' in-range' : '')
      + (past && !isToday ? ' past' : '')
      + (isSel ? ' selecting' : '');

    div.innerHTML = `
      <div class="d-icon">${wmoI(data.daily.weathercode[i])}</div>
      <div class="d-lbl">${lbl}</div>
      <div class="d-max">${max}°</div>
      <div class="d-min">${min}°</div>
      ${prec > 0 ? `<div class="d-rain">${prec.toFixed(1)} mm</div>` : ''}
      ${future   ? `<div class="d-tag">↗ prognose</div>` : ''}
    `;
    div.addEventListener('click', () => clickDay(date));
    strip.appendChild(div);
  });

  updateRngInfo();
}

function clickDay(date) {
  // Klick auf Kalender → tageweise, alle Schnell-Filter aufheben
  chartData = data; // zurück auf Forecast/geladene Daten
  $('heute-btn').classList.remove('active');
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));

  if (!rng.sel) {
    // Erster Klick: Von-Datum setzen
    rng = { start: date, end: date, sel: true };
    renderCalendar();
  } else {
    // Zweiter Klick: Bis-Datum setzen, Range fertig
    const s = rng.start;
    const [a, b] = date < s ? [date, s] : [s, date];
    rng = { start: a, end: b, sel: false };

    // Nachladebedarf prüfen: ist start-Datum älter als geladene Daten?
    if (a < data.daily.time[0]) {
      const daysNeeded = Math.ceil((new Date(today) - new Date(a)) / 864e5) + 2;
      loadWeather(Math.min(daysNeeded, 92), { start: a, end: b });
    } else {
      renderCalendar();
      renderChart();
      triggerAnalysis(a, b);
      syncFilterButtons(); // ggf. Preset-Button aktivieren wenn Range zufällig passt
    }
  }
}

function updateRngInfo() {
  $('cal-range').textContent = rng.sel
    ? `Von: ${fmtDate(rng.start)} → Enddatum wählen`
    : `${fmtDate(rng.start)}  →  ${fmtDate(rng.end)}`;
}

$('heute-btn').addEventListener('click', () => {
  if (!data) return;
  chartData = data;
  rng = { start: today, end: today, sel: false };
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  $('heute-btn').classList.add('active');
  renderCalendar();
  renderChart();
});

// Preset-Buttons (5T = heute → +4, 10T = heute → +9, nur Prognosedaten)
document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const days = parseInt(btn.dataset.days);
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    $('heute-btn').classList.remove('active');
    btn.classList.add('active');
    chartData = data; // zurück auf Forecast-Daten
    const tRng = { start: today, end: addDays(today, days - 1) };
    // Daten bereits geladen und reichen aus → nur Range setzen
    if (data && tRng.end <= data.daily.time[data.daily.time.length - 1] && data.daily.time[0] <= today) {
      rng = { ...tRng, sel: false };
      renderCalendar();
      renderChart();
      triggerAnalysis(tRng.start, tRng.end);
    } else {
      loadWeather(0, tRng);
    }
  });
});

// ── Filtered data ─────────────────────────────────────────────────────────────
function getHourly() {
  const src = chartData || data;
  const labels=[], temp=[], precip=[], wind=[], hum=[], sm0=[], sm1=[];

  if (src.hourly) {
    // Stundendaten verfügbar (Forecast)
    src.hourly.time.forEach((t,i) => {
      const d = t.split('T')[0];
      if (d >= rng.start && d <= rng.end) {
        labels.push(`${fmtDate(d).slice(0,5)} ${t.slice(11,16)}`);
        temp.push(src.hourly.temperature_2m[i]);
        precip.push(src.hourly.precipitation[i]);
        wind.push(src.hourly.windspeed_10m[i]);
        hum.push(src.hourly.relativehumidity_2m[i]);
        const s0 = src.hourly.soil_moisture_0_to_1cm?.[i];
        const s1 = src.hourly.soil_moisture_1_to_3cm?.[i];
        sm0.push(s0 != null ? +(s0*100).toFixed(2) : null);
        sm1.push(s1 != null ? +(s1*100).toFixed(2) : null);
      }
    });
  } else {
    // Nur Tagesdaten verfügbar (Archiv) → Tageswerte als Proxy
    src.daily.time.forEach((d,i) => {
      if (d < rng.start || d > rng.end) return;
      labels.push(new Date(d+'T12:00').toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit'}));
      temp.push(src.daily.temperature_2m_max?.[i] ?? null);
      precip.push(src.daily.precipitation_sum?.[i] ?? null);
      wind.push(src.daily.windspeed_10m_max?.[i] ?? null);
      hum.push(null);
      sm0.push(null);
      sm1.push(null);
    });
  }
  return { labels, temp, precip, wind, hum, sm0, sm1 };
}

function getDaily() {
  const src = chartData || data;
  const labels=[], et0=[], precipD=[];
  src.daily.time.forEach((d,i) => {
    if (d >= rng.start && d <= rng.end) {
      labels.push(fmtDate(d).slice(0,5)); // DD.MM
      et0.push(src.daily.et0_fao_evapotranspiration?.[i] ?? null);
      precipD.push(src.daily.precipitation_sum?.[i] ?? null);
    }
  });
  return { labels, et0, precipD };
}

// ── Heute-Linie Plugin ────────────────────────────────────────────────────────
const todayLine = {
  id: 'todayLine',
  afterDraw(chart) {
    const { ctx, chartArea, scales, data: cd } = chart;
    if (!scales.x || !cd.labels) return;
    const key = fmtDate(today).slice(0,5); // DD.MM
    const idx = cd.labels.findIndex(l => l.includes(key));
    if (idx < 0) return;
    const x = scales.x.getPixelForValue(cd.labels[idx]);
    ctx.save();
    ctx.strokeStyle = '#fb923c';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([4,3]);
    ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#fb923c';
    ctx.font = '11px Inter, sans-serif';
    ctx.fillText('Heute', x+4, chartArea.top+14);
    ctx.restore();
  }
};
Chart.register(todayLine);

Chart.defaults.font.family = "'Inter','Helvetica Neue',Arial,sans-serif";
Chart.defaults.font.size   = 12;

function baseOpts(yUnit, legend=false) {
  const tc = window._chartTextColor   || '#8fa3b8';
  const gc = window._chartGridColor   || '#22263a';
  const tb = window._chartTooltipBg   || '#23262e';
  const tbc= window._chartTooltipBorder || '#22263a';
  const bodyCol = isDark ? '#f1f5f9' : '#1e2533';
  return {
    responsive: true,
    maintainAspectRatio: true,
    aspectRatio: 3.2,
    animation: { duration: 300 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: legend, position:'top', labels:{ boxWidth:12, font:{size:12}, color:tc } },
      tooltip: { backgroundColor:tb, borderColor:tbc, borderWidth:1, titleColor:tc, bodyColor:bodyCol, padding:10 }
    },
    scales: {
      x: { grid:{ color:gc, drawBorder:false }, ticks:{ maxRotation:0, color:tc, font:{size:12},
        callback(val, idx) {
          const lbl   = this.getLabelForValue(val);
          const date  = lbl.split(' ')[0]; // DD.MM (oder DD.MM.YY bei Tages-Labels)
          const prev  = idx > 0 ? this.getLabelForValue(this.chart.data.labels[idx-1]) : null;
          return (!prev || prev.split(' ')[0] !== date) ? date : '';
        }
      } },
      y: { grid:{ color:gc, drawBorder:false }, ticks:{ color:tc, font:{size:12}, callback: v => v+yUnit } }
    }
  };
}

// ── Chart modes ───────────────────────────────────────────────────────────────
const MODES = {
  temp: {
    title: 'Temperaturverlauf (°C)',
    build: h => ({
      labels: h.labels,
      datasets: [{ label:'Temperatur (°C)', data:h.temp,
        borderColor:'#fb923c', backgroundColor:'rgba(251,146,60,.12)',
        borderWidth:2, pointRadius:0, tension:.3, fill:true }]
    }),
    opts: () => baseOpts('°')
  },
  rain: {
    title: 'Niederschlag (mm/h)',
    build: h => ({
      labels: h.labels,
      datasets: [{ label:'mm', data:h.precip,
        borderColor:'#00d4ff', backgroundColor:'rgba(0,212,255,.15)',
        borderWidth:2, pointRadius:0, tension:.3, fill:true }]
    }),
    opts: () => baseOpts(' mm')
  },
  wind: {
    title: 'Windgeschwindigkeit (km/h)',
    build: h => ({
      labels: h.labels,
      datasets: [{ label:'km/h', data:h.wind,
        borderColor:'#34d399', backgroundColor:'rgba(52,211,153,.15)',
        borderWidth:2, pointRadius:0, tension:.3, fill:true }]
    }),
    opts: () => baseOpts(' km/h')
  },
  hum: {
    title: 'Luftfeuchtigkeit (%)',
    build: h => ({
      labels: h.labels,
      datasets: [{ label:'%', data:h.hum,
        borderColor:'#a78bfa', backgroundColor:'rgba(167,139,250,.15)',
        borderWidth:2, pointRadius:0, tension:.3, fill:true }]
    }),
    opts: () => baseOpts('%')
  },
  et0: {
    title: 'ET₀ & Niederschlag täglich (mm)',
    build: (_h, dl) => ({
      labels: dl.labels,
      datasets: [
        { label:'ET₀ (mm)', data:dl.et0,
          borderColor:'#34d399', backgroundColor:'rgba(52,211,153,.15)',
          borderWidth:2, pointRadius:4, tension:.3, fill:true },
        { label:'Niederschlag (mm)', data:dl.precipD,
          borderColor:'#00d4ff', backgroundColor:'rgba(0,212,255,.12)',
          borderWidth:2, pointRadius:4, tension:.3, fill:true }
      ]
    }),
    opts: () => ({ ...baseOpts(' mm', true), aspectRatio: 3.2 })
  },
  soil: {
    title: 'Bodenfeuchte 0–3cm (Vol.%)',
    build: h => ({
      labels: h.labels,
      datasets: [
        { label:'0–1 cm', data:h.sm0,
          borderColor:'#fb923c', backgroundColor:'rgba(251,146,60,.15)',
          borderWidth:2, pointRadius:0, tension:.3, fill:true },
        { label:'1–3 cm', data:h.sm1,
          borderColor:'#a78bfa', backgroundColor:'rgba(167,139,250,.1)',
          borderWidth:1.5, pointRadius:0, tension:.3, fill:false, borderDash:[4,3] }
      ]
    }),
    opts: () => ({ ...baseOpts(' Vol.%', true), aspectRatio: 3.2 })
  }
};

// ── Render single chart ───────────────────────────────────────────────────────
function renderChart() {
  if (CHS.main) { CHS.main.destroy(); CHS.main = null; }
  const h  = getHourly();
  const dl = getDaily();
  const m  = MODES[chartMode];

  $('chart-title').textContent = m.title;
  CHS.main = new Chart($('c-main'), {
    type: 'line',
    data: m.build(h, dl),
    options: m.opts()
  });

  // sync button state
  document.querySelectorAll('.chart-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === chartMode)
  );
}

// ── Chart-Modus wechseln (von Buttons oder Analyse-Kacheln) ──────────────────
function switchChartMode(mode) {
  chartMode = mode;
  document.querySelectorAll('.chart-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  renderChart();
  $('chart-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Chart-Button clicks ───────────────────────────────────────────────────────
document.querySelectorAll('.chart-btn').forEach(btn => {
  btn.addEventListener('click', () => switchChartMode(btn.dataset.mode));
});

// ── Analyse-Kacheln: EIN delegierter Listener (nie doppelt) ──────────────────
// Statt pro renderSummary-Aufruf neue Listener zu registrieren, hört ein
// einziger Listener auf dem Container — kein Memory-Leak, kein Stacking.
$('summary-tiles').addEventListener('click', e => {
  const stile = e.target.closest('.stile');
  if (!stile) return;
  // Chart-Active-Highlight
  document.querySelectorAll('.stile').forEach(s => s.classList.remove('chart-active'));
  stile.classList.add('chart-active');
  // rng auf den Analyse-Zeitraum setzen, damit der Hauptchart denselben Zeitraum zeigt
  const from = $('analysis-from').value;
  const to   = $('analysis-to').value;
  if (from && to && data) {
    rng = { start: from, end: to, sel: false };
    // Wenn Archivdaten geladen → chartData darauf zeigen lassen
    if (window._lastAnalysisData) chartData = window._lastAnalysisData;
    syncFilterButtons();
    renderCalendar();
  }
  // Hauptchart schalten
  const mode = stile.dataset.mode;
  if (mode) switchChartMode(mode);
});

// ── Theme toggle ──────────────────────────────────────────────────────────────
const themeMedia = window.matchMedia?.('(prefers-color-scheme: dark)');
let themeMode = localStorage.getItem('theme-mode') || localStorage.getItem('theme') || 'auto';
let isDark = true;

function resolveTheme(mode = themeMode) {
  return mode === 'auto' ? !!themeMedia?.matches : mode === 'dark';
}

function setThemeMeta(dark) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0f1117' : '#f0f4f8');
}

function applyTheme() {
  isDark = resolveTheme();
  document.body.classList.toggle('light', !isDark);
  document.querySelectorAll('.theme-choice').forEach(btn => {
    const active = btn.dataset.theme === themeMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  setThemeMeta(isDark);

  const textColor = isDark ? '#8fa3b8' : '#5a6a82';
  const gridColor = isDark ? '#22263a' : '#dde3ec';
  const tooltipBg = isDark ? '#23262e' : '#ffffff';
  const tooltipBorder = isDark ? '#22263a' : '#dde3ec';

  Chart.defaults.color       = textColor;
  Chart.defaults.borderColor = gridColor;

  // Patch baseOpts to use current theme colors
  window._chartTextColor   = textColor;
  window._chartGridColor   = gridColor;
  window._chartTooltipBg   = tooltipBg;
  window._chartTooltipBorder = tooltipBorder;

  if (data) {
    if      (_activePopupKey === 'dayoverview') openDayOverview();
    else if (_activePopupKey === 'field')       showFieldPopup();
    else if (_activePopupKey)                   showTilePopup(_activePopupKey);
    else                                        renderChart();
  }
}

document.querySelectorAll('.theme-choice').forEach(btn => {
  btn.addEventListener('click', () => {
    themeMode = btn.dataset.theme;
    localStorage.setItem('theme-mode', themeMode);
    localStorage.removeItem('theme');
    applyTheme();
  });
});

themeMedia?.addEventListener?.('change', () => {
  if (themeMode === 'auto') applyTheme();
});

applyTheme();

// ── Favoriten ─────────────────────────────────────────────────────────────────
function getFavs()      { try { return JSON.parse(localStorage.getItem('favs') || '[]'); } catch { return []; } }
function saveFavs(favs) {
  localStorage.setItem('favs', JSON.stringify(favs));
  syncList('favorite', favs);
}

function renderFavs() {
  const chips = $('fav-chips');
  chips.innerHTML = '';
  getFavs().forEach(f => {
    const chip = document.createElement('button');
    chip.className = 'fav-chip';
    chip.title = 'Klick: laden';

    const label = document.createElement('span');
    label.textContent = f.name;
    label.addEventListener('click', () => {
      loc = { name: f.name, lat: f.lat, lon: f.lon };
      cityIn.value = f.name;
      loadWeather(loadedPastDays);
    });

    const del = document.createElement('span');
    del.className = 'chip-del';
    del.textContent = '×';
    del.title = 'Entfernen';
    del.addEventListener('click', e => {
      e.stopPropagation();
      saveFavs(getFavs().filter(x => !(x.lat === f.lat && x.lon === f.lon)));
      renderFavs();
    });

    chip.appendChild(label);
    chip.appendChild(del);
    chips.appendChild(chip);
  });
}

$('fav-save').addEventListener('click', () => {
  if (!loc) return;
  const favs = getFavs();
  if (!favs.find(f => f.lat === loc.lat && f.lon === loc.lon)) {
    favs.push({ name: loc.name, lat: loc.lat, lon: loc.lon });
    saveFavs(favs);
    renderFavs();
    $('fav-save').textContent = '✅ Gespeichert!';
    setTimeout(() => { $('fav-save').textContent = '+ Aktuellen Ort merken'; }, 1800);
  }
});

renderFavs();
hydrateList('favorite', 'favs', renderFavs);

// ── Schläge ───────────────────────────────────────────────────────────────────
function getSchlaege()       { try { return JSON.parse(localStorage.getItem('schlaege') || '[]'); } catch { return []; } }
function saveSchlaege(list)  {
  localStorage.setItem('schlaege', JSON.stringify(list));
  syncList('field', list);
}

function renderSchlaege() {
  const chips = $('schlag-chips');
  chips.innerHTML = '';
  getSchlaege().forEach(s => {
    const chip = document.createElement('button');
    chip.className = 'schlag-chip';
    chip.title = `${s.lat}, ${s.lon}`;

    const label = document.createElement('span');
    label.textContent = s.name;
    label.addEventListener('click', () => {
      loc = { name: s.name, lat: s.lat, lon: s.lon };
      cityIn.value = s.name;
      loadWeather(loadedPastDays);
    });

    const del = document.createElement('span');
    del.className = 'chip-del';
    del.textContent = '×';
    del.title = 'Entfernen';
    del.addEventListener('click', e => {
      e.stopPropagation();
      saveSchlaege(getSchlaege().filter(x => !(x.lat === s.lat && x.lon === s.lon)));
      renderSchlaege();
    });

    chip.appendChild(label);
    chip.appendChild(del);
    chips.appendChild(chip);
  });
}

// Formular anzeigen/ausblenden
$('schlag-add-btn').addEventListener('click', () => {
  const form = $('schlag-form');
  form.style.display = form.style.display === 'flex' ? 'none' : 'flex';
  $('schlag-name-in').focus();
});
$('schlag-cancel-btn').addEventListener('click', () => {
  $('schlag-form').style.display = 'none';
  $('schlag-name-in').value = '';
  $('schlag-lat-in').value  = '';
  $('schlag-lon-in').value  = '';
});

// GPS-Button
$('schlag-gps-btn').addEventListener('click', () => {
  if (!navigator.geolocation) { alert('GPS nicht verfügbar'); return; }
  $('schlag-gps-btn').textContent = '⏳';
  navigator.geolocation.getCurrentPosition(pos => {
    $('schlag-lat-in').value = pos.coords.latitude.toFixed(5);
    $('schlag-lon-in').value = pos.coords.longitude.toFixed(5);
    $('schlag-gps-btn').textContent = '📍 GPS';
    if (!$('schlag-name-in').value) $('schlag-name-in').focus();
  }, () => {
    $('schlag-gps-btn').textContent = '📍 GPS';
    alert('GPS-Zugriff verweigert oder nicht möglich.');
  });
});

// Speichern
$('schlag-save-btn').addEventListener('click', () => {
  const name = $('schlag-name-in').value.trim();
  const lat  = parseFloat($('schlag-lat-in').value);
  const lon  = parseFloat($('schlag-lon-in').value);
  if (!name || isNaN(lat) || isNaN(lon)) {
    alert('Bitte Name, Breitengrad und Längengrad angeben.');
    return;
  }
  const list = getSchlaege();
  if (!list.find(s => s.lat === lat && s.lon === lon)) {
    list.push({ name, lat, lon });
    saveSchlaege(list);
    renderSchlaege();
  }
  $('schlag-form').style.display = 'none';
  $('schlag-name-in').value = '';
  $('schlag-lat-in').value  = '';
  $('schlag-lon-in').value  = '';
});

renderSchlaege();
hydrateList('field', 'schlaege', renderSchlaege);

// ── Auto-Refresh (alle 30 min) ────────────────────────────────────────────────
let autoRefreshTimer = null;

function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    // Aktuellen Range erhalten
    const savedRng = { start: rng.start, end: rng.end };
    loadWeather(loadedPastDays, savedRng);
  }, 30 * 60 * 1000);
}

// ── Zeitraum-Analyse ──────────────────────────────────────────────────────────

function injectDailySoilTemp(srcData) {
  if (srcData.daily.soil_temperature_avg) return;
  const hourlyKey = srcData.hourly?.soil_temperature_0cm        ? 'soil_temperature_0cm'
                  : srcData.hourly?.soil_temperature_0_to_7cm   ? 'soil_temperature_0_to_7cm'
                  : null;
  if (!hourlyKey) return;
  srcData.daily.soil_temperature_avg = srcData.daily.time.map(date => {
    const vs = srcData.hourly.time
      .map((t, i) => t.startsWith(date) ? srcData.hourly[hourlyKey][i] : null)
      .filter(v => v != null);
    return vs.length ? +(vs.reduce((s, v) => s + v, 0) / vs.length).toFixed(1) : null;
  });
}

function calcSummary(srcData, startDate, endDate) {
  const d = srcData.daily;
  const idx = [];
  d.time.forEach((t, i) => { if (t >= startDate && t <= endDate) idx.push(i); });
  if (!idx.length) return null;

  const get  = (arr, i) => arr?.[i] ?? null;
  const vals = key => idx.map(i => get(d[key], i)).filter(v => v != null);
  const sum  = arr => arr.reduce((s, v) => s + v, 0);
  const avg  = arr => arr.length ? sum(arr) / arr.length : null;

  const maxArr   = vals('temperature_2m_max');
  const minArr   = vals('temperature_2m_min');
  const precips  = vals('precipitation_sum');
  const et0s     = vals('et0_fao_evapotranspiration');
  const winds    = vals('windspeed_10m_max');
  const soilTs   = vals('soil_temperature_avg');

  // Ø Temp = Mittel aus (max+min)/2 pro Tag
  const meanArr  = idx.map(i => {
    const mx = get(d['temperature_2m_max'], i);
    const mn = get(d['temperature_2m_min'], i);
    return (mx != null && mn != null) ? (mx + mn) / 2 : null;
  }).filter(v => v != null);

  const totalPrecip = sum(precips);
  const totalEt0    = et0s.length ? sum(et0s) : null;
  const wb          = totalEt0 != null ? totalPrecip - totalEt0 : null;

  return {
    days:         idx.length,
    totalPrecip,
    totalEt0,
    wb,
    avgTemp:      avg(meanArr),
    maxTemp:      maxArr.length ? Math.max(...maxArr) : null,
    minTemp:      minArr.length ? Math.min(...minArr) : null,
    avgWind:      avg(winds),
    rainDays:     precips.filter(p => p >= 1).length,
    frostDays:    minArr.filter(t => t < 0).length,
    avgSoilT:     avg(soilTs),
  };
}

function renderSummary(srcData, startDate, endDate) {
  // Destroy old sparkline charts
  stileCharts.forEach(c => { try { c.destroy(); } catch {} });
  stileCharts = [];

  // Datenquelle für Export + Soll/Ist merken
  window._lastAnalysisData  = srcData;
  window._lastAnalysisRange = { start: startDate, end: endDate };
  $('export-csv-btn').disabled  = false;
  $('export-xlsx-btn').disabled = false;
  // Soll/Ist nur für vergangene Zeiträume innerhalb 92 Tage
  const daysBackSI = Math.ceil((new Date(today + 'T12:00') - new Date(startDate + 'T12:00')) / 864e5) + 1;
  $('soll-ist-btn').disabled = !(endDate < today && daysBackSI <= 92);

  injectDailySoilTemp(srcData);
  const s = calcSummary(srcData, startDate, endDate);
  if (!s) { $('summary-tiles').innerHTML = '<span style="color:var(--muted);font-size:12px">Keine Daten für diesen Zeitraum.</span>'; return; }

  const fmt   = (v, d=1, prefix='') => v != null ? prefix + (+v).toFixed(d) : '—';
  const wbCol = s.wb == null ? 'var(--muted)' : s.wb >= 0 ? 'var(--green)' : s.wb >= -30 ? 'var(--yellow)' : 'var(--red)';

  $('analysis-info').textContent = `${fmtDate(startDate)}  →  ${fmtDate(endDate)}  ·  ${s.days} Tage`;
  $('analysis-info').style.display = 'block';

  // Build daily arrays for sparklines
  const days = [], precD = [], maxT = [], minT = [], et0D = [], windD = [], soilD = [];
  srcData.daily.time.forEach((d, i) => {
    if (d < startDate || d > endDate) return;
    days.push(fmtDate(d).slice(0,5)); // DD.MM
    precD.push(srcData.daily.precipitation_sum?.[i] ?? 0);
    maxT.push(srcData.daily.temperature_2m_max?.[i] ?? null);
    minT.push(srcData.daily.temperature_2m_min?.[i] ?? null);
    et0D.push(srcData.daily.et0_fao_evapotranspiration?.[i] ?? null);
    windD.push(srcData.daily.windspeed_10m_max?.[i] ?? null);
    soilD.push(srcData.daily.soil_temperature_avg?.[i] ?? null);
  });
  const avgT = maxT.map((mx, i) => mx != null && minT[i] != null ? +((mx + minT[i]) / 2).toFixed(1) : null);
  const wbD  = precD.map((p, i) => et0D[i] != null ? +(p - et0D[i]).toFixed(1) : null);

  const tiles = [
    { label: '🌧 NS gesamt',         val: fmt(s.totalPrecip,1),                          unit: 'mm',   col: 'var(--teal)',   series: precD, type:'bar',  color:'#00d4ff', mode:'rain' },
    { label: '🌡 Ø Temperatur',      val: fmt(s.avgTemp,1),                               unit: '°C',   col: 'var(--orange)', series: avgT,  type:'line', color:'#fb923c', mode:'temp' },
    { label: '↑ Temp Maximum',       val: fmt(s.maxTemp,1),                               unit: '°C',   col: 'var(--red)',    series: maxT,  type:'line', color:'#ef4444', mode:'temp' },
    { label: '↓ Temp Minimum',       val: fmt(s.minTemp,1),                               unit: '°C',   col: 'var(--blue)',   series: minT,  type:'line', color:'#60a5fa', mode:'temp' },
    { label: '🌿 ET₀ gesamt',        val: fmt(s.totalEt0,1),                              unit: 'mm',   col: 'var(--green)',  series: et0D,  type:'bar',  color:'#34d399', mode:'et0'  },
    { label: '⚖️ Wasserbilanz',      val: fmt(s.wb,1, s.wb!=null&&s.wb>0?'+':''),         unit: 'mm',   col: wbCol,           series: wbD,   type:'bar',  color:'#a78bfa', mode:'et0'  },
    { label: '💧 NS-Tage ≥1mm',      val: s.rainDays,                                     unit: 'T',    col: 'var(--teal)',   series: precD, type:'bar',  color:'#00d4ff', mode:'rain' },
    { label: '🧊 Frosttage <0°',     val: s.frostDays,                                    unit: 'T',    col: 'var(--blue)',   series: minT,  type:'line', color:'#60a5fa', mode:'temp' },
    { label: '💨 Ø Wind',            val: fmt(s.avgWind,0),                               unit: 'km/h', col: 'var(--green)',  series: windD, type:'line', color:'#34d399', mode:'wind' },
    { label: '🌡 Ø Bodentemp. 0cm', val: fmt(s.avgSoilT,1),                              unit: '°C',   col: 'var(--purple)', series: soilD, type:'line', color:'#a78bfa', mode:'temp' },
  ];

  $('summary-tiles').innerHTML = tiles.map((t, i) => `
    <div class="stile" data-mode="${t.mode || ''}" data-idx="${i}">
      <div class="stile-left">
        <div class="stile-label">${t.label}</div>
        <div class="stile-value" style="color:${t.col}">${t.val}<span class="stile-unit"> ${t.unit}</span></div>
      </div>
      <canvas class="stile-canvas" id="sc-${i}"></canvas>
    </div>`).join('');

  // Sparkline chart defaults
  const sparkOpts = (color, type) => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: { x: { display: false }, y: { display: false } },
    elements: type === 'line'
      ? { point: { radius: 0 }, line: { tension: 0.3, borderWidth: 1.5, fill: true } }
      : {}
  });

  tiles.forEach((t, i) => {
    const canvas = document.getElementById('sc-' + i);
    if (!canvas || !t.series?.length) return;
    const hexAlpha = t.type === 'bar' ? '99' : '22';
    const chart = new Chart(canvas, {
      type: t.type,
      data: {
        labels: days,
        datasets: [{
          data: t.series,
          borderColor: t.color,
          backgroundColor: t.color + hexAlpha,
          fill: t.type === 'line',
          borderWidth: t.type === 'bar' ? 0 : 1.5,
          barPercentage: 0.75,
          categoryPercentage: 0.9,
          pointRadius: 0,
        }]
      },
      options: sparkOpts(t.color, t.type)
    });
    stileCharts.push(chart);
  });

  // Kachel die zum aktuellen chartMode passt als aktiv markieren
  document.querySelectorAll('.stile').forEach(el => {
    el.classList.toggle('chart-active', el.dataset.mode === chartMode);
  });
}

async function loadHistorical(startDate, endDate) {
  $('analysis-loading').style.display = 'inline';
  $('analysis-load-btn').disabled = true;
  try {
    // Archive-API liefert nur vergangene Daten — end_date darf nicht heute oder
    // in der Zukunft liegen. 2 Tage Puffer, da Archiv oft leicht verzögert ist.
    const archiveEnd = addDays(today, -2);
    const safeEnd = endDate < archiveEnd ? endDate : archiveEnd;
    if (safeEnd < startDate) {
      $('analysis-info').textContent = '⚠️ Archivdaten noch nicht verfügbar (max. 2 Tage Verzögerung)';
      $('analysis-info').style.display = 'block';
      return;
    }
    const hist = await fetchHistoricalFromDb(startDate, safeEnd);
    injectDailySoilTemp(hist);
    renderSummary(hist, startDate, safeEnd);
  } catch(e) {
    $('analysis-info').textContent = '⚠️ Fehler beim Laden: ' + e.message;
    $('analysis-info').style.display = 'block';
  } finally {
    $('analysis-loading').style.display = 'none';
    $('analysis-load-btn').disabled = false;
  }
}

function triggerAnalysis(startDate, endDate) {
  if (!startDate || !endDate || startDate > endDate) return;
  $('analysis-from').value = startDate;
  $('analysis-to').value   = endDate;

  const lastForecast = data ? data.daily.time[data.daily.time.length - 1] : null;

  // Fall 1: vollständig im geladenen Forecast-Cache
  if (data && startDate >= data.daily.time[0] && endDate <= lastForecast) {
    renderSummary(data, startDate, endDate);

  // Fall 2: Start liegt im Forecast, Ende geht darüber hinaus
  // → nur verfügbare Tage anzeigen, Hinweis ausgeben
  } else if (data && startDate >= data.daily.time[0] && startDate <= lastForecast && endDate > lastForecast) {
    $('analysis-info').textContent =
      `Prognose verfügbar bis ${fmtDate(lastForecast)} — Analyse zeigt nur diesen Zeitraum.`;
    $('analysis-info').style.display = 'block';
    renderSummary(data, startDate, lastForecast);

  // Fall 3: Zeitraum liegt vollständig in der Zukunft jenseits des Forecasts
  } else if (data && startDate > lastForecast) {
    $('summary-tiles').innerHTML = '';
    $('export-csv-btn').disabled = true;
    $('export-xlsx-btn').disabled = true;
    $('analysis-info').textContent =
      `Keine Daten verfügbar — Prognose endet am ${fmtDate(lastForecast)}.`;
    $('analysis-info').style.display = 'block';

  // Fall 4: Historische Daten nötig → Archive API (kapped auf gestern-2)
  } else {
    loadHistorical(startDate, endDate);
  }
}

$('analysis-load-btn').addEventListener('click', () => {
  const from = $('analysis-from').value;
  const to   = $('analysis-to').value;
  if (!from || !to) return;
  triggerAnalysis(from, to);
});

// ── Analyse Reset ──────────────────────────────────────────────────────────────
$('analysis-reset-btn').addEventListener('click', () => {
  $('analysis-from').value = '';
  $('analysis-to').value   = '';
  $('analysis-info').style.display = 'none';
  $('analysis-info').textContent = '';
  $('summary-tiles').innerHTML = '';
  $('export-csv-btn').disabled  = true;
  $('export-xlsx-btn').disabled = true;
  // stileCharts bereinigen
  stileCharts.forEach(c => { try { c.destroy(); } catch {} });
  stileCharts = [];
});

// ── Kalender-Filter Reset ──────────────────────────────────────────────────────
$('cal-reset-btn').addEventListener('click', () => {
  if (!data) return;
  chartData = data; // zurück auf Forecast-Daten
  // Zurück auf 5T-Preset (Standard)
  rng = { start: today, end: addDays(today, 4), sel: false };
  document.querySelectorAll('.preset-btn').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.days) === 5));
  $('heute-btn').classList.remove('active');
  renderCalendar();
  renderChart();
  triggerAnalysis(rng.start, rng.end);
});

// ── Export-Hilfsfunktionen ─────────────────────────────────────────────────────
// Liefert rohe Tageszeilen für den aktuellen Analysezeitraum
function getAnalysisRows() {
  const from = $('analysis-from').value;
  const to   = $('analysis-to').value;
  if (!from || !to || !data) return null;
  // Welche Datenquelle? Analyse verwendet entweder Forecast-Cache oder wird
  // nach fetchem in renderSummary gespeichert. Wir greifen auf window._lastAnalysisData.
  const src = window._lastAnalysisData;
  if (!src) return null;
  const rows = [['Datum','T-Max (°C)','T-Min (°C)','Niederschlag (mm)','Wind max (km/h)','ET₀ (mm)']];
  src.daily.time.forEach((d, i) => {
    if (d < from || d > to) return;
    rows.push([
      fmtDate(d),
      src.daily.temperature_2m_max?.[i]          ?? '',
      src.daily.temperature_2m_min?.[i]          ?? '',
      src.daily.precipitation_sum?.[i]           ?? '',
      src.daily.windspeed_10m_max?.[i]           ?? '',
      src.daily.et0_fao_evapotranspiration?.[i]  ?? ''
    ]);
  });
  return rows.length > 1 ? rows : null;
}

$('export-csv-btn').addEventListener('click', () => {
  const rows = getAnalysisRows();
  if (!rows) return;
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(';')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const from = $('analysis-from').value;
  const to   = $('analysis-to').value;
  a.download = `wetteranalyse_${from}_${to}.csv`;
  a.click();
});

$('export-xlsx-btn').addEventListener('click', () => {
  const rows = getAnalysisRows();
  if (!rows || typeof XLSX === 'undefined') return;
  const ws = XLSX.utils.aoa_to_sheet(rows);
  // Spaltenbreiten
  ws['!cols'] = [10,12,12,18,16,10].map(w => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Wetteranalyse');
  const from = $('analysis-from').value;
  const to   = $('analysis-to').value;
  XLSX.writeFile(wb, `wetteranalyse_${from}_${to}.xlsx`);
});

// ── Vollständig frisch laden ─────────────────────────────────────────────────
async function hardReloadApp() {
  const btn = $('hard-reload-btn');
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.classList.add('busy');
  updateFreshnessStatus(null, true);
  try {
    const refreshed = await fetchForecastFromDb(loadedPastDays, 14, true);
    updateFreshnessStatus(refreshed._mowetter_cache);
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(key => caches.delete(key)));
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(reg => reg.unregister()));
    }
  } catch (e) {
    console.warn('Neu laden konnte nicht alle Caches leeren', e);
  } finally {
    const url = new URL(window.location.href);
    url.searchParams.set('reload', Date.now().toString());
    window.location.replace(url.toString());
    setTimeout(() => {
      btn.disabled = false;
      btn.setAttribute('aria-busy', 'false');
      btn.classList.remove('busy');
      btn.textContent = oldText;
    }, 1500);
  }
}

$('hard-reload-btn').addEventListener('click', hardReloadApp);

// ── PWA Installation ──────────────────────────────────────────────────────────
let installPrompt = null;
const INSTALL_KEY = 'mowetter-pwa-installed';
const installBtn = $('install-btn');
const installSheet = $('install-sheet');
const installCopy = $('install-copy');
const installSteps = $('install-steps');

function isIosDevice() {
  const ua = window.navigator.userAgent || '';
  return /iphone|ipad|ipod/i.test(ua) || (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
}

function isAndroidDevice() {
  return /android/i.test(window.navigator.userAgent || '');
}

function isStandaloneApp() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function installStepsForDevice() {
  if (isIosDevice()) {
    installCopy.textContent = 'iOS erlaubt keinen direkten Install-Button. So geht es trotzdem:';
    return [
      'In Safari das Teilen-Symbol antippen.',
      '"Zum Home-Bildschirm" auswählen.',
      'Mit "Hinzufügen" bestätigen.'
    ];
  }
  if (isAndroidDevice()) {
    installCopy.textContent = 'Falls kein Installationsfenster erscheint:';
    return [
      'Browser-Menü öffnen.',
      '"App installieren" oder "Zum Startbildschirm hinzufügen" auswählen.',
      'Bestätigen und MoWetter vom Startbildschirm öffnen.'
    ];
  }
  installCopy.textContent = 'Desktop-Browser zeigen den Install-Dialog je nach Browser unterschiedlich:';
  return [
    'Chrome/Edge: Install-Symbol in der Adressleiste oder Browser-Menü öffnen.',
    '"WetterBoard installieren" oder "App installieren" auswählen.',
    'Falls der Punkt fehlt: diese Seite einmal neu laden und kurz warten.'
  ];
}

function syncInstallButton() {
  const installed = isStandaloneApp() || localStorage.getItem(INSTALL_KEY) === '1';
  installBtn.classList.toggle('visible', !installed);
  installBtn.hidden = installed;
  if (isStandaloneApp()) localStorage.setItem(INSTALL_KEY, '1');
}

function openInstallSheet() {
  installSteps.innerHTML = installStepsForDevice().map((step, i) =>
    `<div class="install-step"><span>${i + 1}</span><span>${step}</span></div>`
  ).join('');
  installSheet.classList.add('open');
  installSheet.setAttribute('aria-hidden', 'false');
}

function closeInstallSheet() {
  installSheet.classList.remove('open');
  installSheet.setAttribute('aria-hidden', 'true');
}

installBtn.addEventListener('click', async () => {
  if (installPrompt && !isIosDevice()) {
    installPrompt.prompt();
    try { await installPrompt.userChoice; } catch {}
    installPrompt = null;
    syncInstallButton();
    return;
  }
  openInstallSheet();
});

$('install-close').addEventListener('click', closeInstallSheet);
installSheet.addEventListener('click', e => {
  if (e.target === installSheet) closeInstallSheet();
});

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  syncInstallButton();
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  localStorage.setItem(INSTALL_KEY, '1');
  syncInstallButton();
});

window.addEventListener('pageshow', syncInstallButton);
document.addEventListener('visibilitychange', syncInstallButton);
syncInstallButton();

// ── Agrar-Toggle ─────────────────────────────────────────────────────────────
const AGRAR_KEY = 'mw_agrar_mode';

function isAgrarMode() {
  const v = localStorage.getItem(AGRAR_KEY);
  if (v !== null) return v !== '0';
  // Neue Nutzer: einfacher Modus; bestehende Nutzer (haben Schläge/Favs) → Agrar
  return getSchlaege().length > 0 || getFavs().length > 0;
}

function applyAgrarMode() {
  const on = isAgrarMode();
  document.body.classList.toggle('no-agrar', !on);
  const btn = $('agrar-toggle');
  if (btn) {
    btn.classList.toggle('active', on);
    btn.title = on ? '🌾 Agrar-Modus aktiv (klicken zum Deaktivieren)' : '🌾 Agrar-Modus aktivieren';
  }
}

$('agrar-toggle').addEventListener('click', () => {
  localStorage.setItem(AGRAR_KEY, isAgrarMode() ? '0' : '1');
  applyAgrarMode();
});

// ── Frost-Alarm ───────────────────────────────────────────────────────────────
const FROST_ALARM_KEY  = 'mowetter_frost_alarm';
const FROST_LAST_KEY   = 'mowetter_frost_last_notify';
const FROST_COOLDOWN   = 6 * 3600 * 1000; // 6h zwischen zwei Alarmen

function isFrostAlarmEnabled() {
  return localStorage.getItem(FROST_ALARM_KEY) === '1';
}

function updateFrostAlarmBtn() {
  const btn = $('frost-alarm-btn');
  if (!btn) return;
  const on = isFrostAlarmEnabled();
  btn.classList.toggle('active', on);
  btn.title = on
    ? 'Frost-Alarm aktiv – klicken zum Deaktivieren'
    : 'Frost-Alarm aktivieren (Browser-Benachrichtigung bei Frost in 24h)';
}

async function toggleFrostAlarm() {
  if (!('Notification' in window)) { alert('Dein Browser unterstützt keine Benachrichtigungen.'); return; }
  if (isFrostAlarmEnabled()) {
    localStorage.removeItem(FROST_ALARM_KEY);
    localStorage.removeItem(FROST_LAST_KEY);
    await unregisterPush();
    updateFrostAlarmBtn();
    return;
  }
  if (Notification.permission === 'denied') {
    alert('Benachrichtigungen sind in diesem Browser blockiert.\nBitte in den Browser-Einstellungen freigeben.');
    return;
  }
  const perm = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission();
  if (perm !== 'granted') return;

  localStorage.setItem(FROST_ALARM_KEY, '1');
  updateFrostAlarmBtn();

  // Web Push registrieren (auch wenn App geschlossen)
  const sub = await registerPush();
  const body = sub
    ? 'Alarm kommt auch wenn die App geschlossen ist. ❄️'
    : 'Alarm erscheint solange die App geöffnet ist.';
  new Notification('✅ Frost-Alarm aktiviert – WetterBoard', {
    body,
    icon: './icon-192.png',
    tag: 'frost-alarm-confirm'
  });
}

function checkFrostAlarm() {
  if (!data || !isFrostAlarmEnabled()) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const last = parseInt(localStorage.getItem(FROST_LAST_KEY) || '0');
  if (Date.now() - last < FROST_COOLDOWN) return;

  const n24r = getNext24hRange();
  if (!n24r) return;
  const temps = data.hourly.temperature_2m?.slice(n24r.start, n24r.end).filter(v => v != null) ?? [];
  if (!temps.length) return;
  const minTemp = Math.min(...temps);
  if (minTemp >= 0) return;

  localStorage.setItem(FROST_LAST_KEY, String(Date.now()));
  const btn = $('frost-alarm-btn');
  btn?.classList.add('ring');
  setTimeout(() => btn?.classList.remove('ring'), 500);
  new Notification('❄️ Frostwarnung – WetterBoard', {
    body: `Temperatur fällt auf ${minTemp.toFixed(1)}°C in den nächsten 24 Stunden!`,
    icon: './icon-192.png',
    tag: 'frost-alarm',
    requireInteraction: true
  });
}

$('frost-alarm-btn').addEventListener('click', toggleFrostAlarm);
updateFrostAlarmBtn();
$('today-overview-btn').addEventListener('click', openDayOverview);
applyAgrarMode();

// ── Offline-Banner ────────────────────────────────────────────────────────────
function syncOfflineBanner() {
  const banner = $('offline-banner');
  if (!banner) return;
  if (navigator.onLine) {
    if (banner.classList.contains('visible')) {
      banner.classList.add('fading');
      setTimeout(() => banner.classList.remove('visible', 'fading'), 260);
    }
  } else {
    const cached = data?._mowetter_cache?.fetched_at;
    $('ob-age').textContent = cached ? `· Daten von ${relativeAgeText(cached)}` : '';
    banner.classList.remove('fading');
    banner.classList.add('visible');
  }
}

$('ob-retry').addEventListener('click', () => {
  if (navigator.onLine) {
    loadWeather(loadedPastDays, null, false);
  } else {
    $('ob-age').textContent = '· Noch offline…';
  }
});

window.addEventListener('offline', syncOfflineBanner);
window.addEventListener('online', () => {
  syncOfflineBanner();
  setTimeout(() => { if (navigator.onLine) loadWeather(loadedPastDays, null, false); }, 1500);
});

syncOfflineBanner();

// ── Start ─────────────────────────────────────────────────────────────────────
$('load-btn').addEventListener('click', () => { if (loc) loadWeather(loadedPastDays, null, true); });

// ── GPS-Button ────────────────────────────────────────────────────────────────
$('gps-btn').addEventListener('click', () => {
  if (!navigator.geolocation) { alert('GPS nicht verfügbar'); return; }
  $('gps-btn').textContent = '⏳ Ort wird erkannt…';
  $('gps-btn').disabled = true;
  navigator.geolocation.getCurrentPosition(
    pos => {
      const lat = +pos.coords.latitude.toFixed(5);
      const lon = +pos.coords.longitude.toFixed(5);
      loc = { name: `${lat.toFixed(2)}°N, ${lon.toFixed(2)}°E`, lat, lon };
      cityIn.value = loc.name;
      $('gps-btn').textContent = '📍 Meinen Standort nutzen';
      $('gps-btn').disabled = false;
      loadWeather(7, { start: today, end: addDays(today, 4) });
    },
    () => {
      $('gps-btn').textContent = '📍 Meinen Standort nutzen';
      $('gps-btn').disabled = false;
      alert('GPS-Zugriff verweigert. Bitte Ort suchen.');
    }
  );
});

$('empty-btn').addEventListener('click', () => { if (loc) loadWeather(7, { start: today, end: addDays(today, 4) }); });

// ── Web Push helpers ──────────────────────────────────────────────────────────
function urlBase64ToUint8Array(b64) {
  const pad  = '='.repeat((4 - b64.length % 4) % 4);
  const raw  = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out  = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registerPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  try {
    const { publicKey } = await apiJson('/api/push/vapid-public-key');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
    await apiJson('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ client_id: CLIENT_ID, subscription: sub.toJSON(), lat: loc?.lat ?? 0, lon: loc?.lon ?? 0 })
    });
    localStorage.setItem('mw_push_endpoint', sub.endpoint);
    return sub;
  } catch (e) {
    console.warn('Web Push Registrierung fehlgeschlagen:', e);
    return null;
  }
}

async function unregisterPush() {
  const endpoint = localStorage.getItem('mw_push_endpoint');
  if (!endpoint) return;
  try {
    await apiJson('/api/push/unsubscribe', { method: 'DELETE', body: JSON.stringify({ endpoint }) });
  } catch {}
  localStorage.removeItem('mw_push_endpoint');
  if ('serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  }
}

// ── Standort initialisieren ───────────────────────────────────────────────────
(function initLoc() {
  const saved = localStorage.getItem('mw_last_loc');
  if (saved) {
    try {
      const l = JSON.parse(saved);
      if (l?.lat && l?.lon && l?.name) {
        loc = l;
        cityIn.value = loc.name;
        $('empty-btn').style.display = 'inline-block';
        loadWeather(7, { start: today, end: addDays(today, 4) });
        return;
      }
    } catch {}
  }
  // Kein gespeicherter Standort → GPS versuchen
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        const lat = +pos.coords.latitude.toFixed(5);
        const lon = +pos.coords.longitude.toFixed(5);
        loc = { name: `${lat.toFixed(2)}°N, ${lon.toFixed(2)}°E`, lat, lon };
        cityIn.value = loc.name;
        loadWeather(7, { start: today, end: addDays(today, 4) });
      },
      () => {} // GPS abgelehnt → Empty State bleibt
    );
  }
})();

// Service Worker registrieren + Update-Banner
if ('serviceWorker' in navigator) {
  const banner   = $('update-banner');
  const reloadBtn = $('update-reload-btn');
  const dismissBtn = $('update-dismiss-btn');
  let newWorker = null;

  function showBanner(sw) {
    newWorker = sw;
    banner.classList.add('visible');
  }

  reloadBtn.addEventListener('click', () => {
    if (newWorker) newWorker.postMessage({ type: 'SKIP_WAITING' });
    hardReloadApp();
  });
  dismissBtn.addEventListener('click', () => {
    banner.classList.remove('visible');
  });

  // Wenn neuer SW die Kontrolle übernimmt → Seite neu laden
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();
  });

  navigator.serviceWorker.register('./sw.js?v=15', { scope: './' }).then(reg => {
    reg.update();

    // Bereits ein wartender SW beim Laden?
    if (reg.waiting) { showBanner(reg.waiting); return; }

    // Neuer SW wird gerade installiert
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          showBanner(sw);
        }
      });
    });
  }).catch(() => {});
}