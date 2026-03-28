/* ──────────────────────────────────────────────
   Meetup Location Optimizer
   Stack: Leaflet + Nominatim + Overpass + Weiszfeld
   ────────────────────────────────────────────── */

// ── State ──────────────────────────────────────
const state = {
  participants: [],   // { id, name, address, lat, lng, marker, color }
  optimalMarker: null,
  venueMarkers: [],
  nextId: 1,
};

// Distinct colours for participant pins (cycles if >10)
const PIN_COLORS = [
  '#4f46e5','#059669','#dc2626','#d97706','#7c3aed',
  '#0891b2','#be185d','#16a34a','#ea580c','#1d4ed8',
];

// ── Map setup ──────────────────────────────────
const map = L.map('map').setView([20, 0], 2);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
}).addTo(map);

// ── DOM refs ───────────────────────────────────
const inputName      = document.getElementById('input-name');
const inputAddress   = document.getElementById('input-address');
const btnAdd         = document.getElementById('btn-add');
const btnFind        = document.getElementById('btn-find');
const geocodeStatus  = document.getElementById('geocode-status');
const participantList= document.getElementById('participant-list');
const participantCount=document.getElementById('participant-count');
const resultsSection = document.getElementById('results-section');
const venuesSection  = document.getElementById('venues-section');
const optimalAddress = document.getElementById('optimal-address');
const distanceSummary= document.getElementById('distance-summary');
const venuesList     = document.getElementById('venues-list');
const venuesCount    = document.getElementById('venues-count');
const mapOverlay     = document.getElementById('map-overlay');

// ── Geocoding (Nominatim) ──────────────────────
// Rate-limited: 1 req/s per Nominatim policy
let lastGeocode = 0;

async function geocode(address) {
  const now = Date.now();
  const wait = Math.max(0, 1100 - (now - lastGeocode));
  if (wait > 0) await delay(wait);
  lastGeocode = Date.now();

  const url = `https://nominatim.openstreetmap.org/search?` +
    `q=${encodeURIComponent(address)}&format=json&limit=1`;

  const res = await fetch(url, {
    headers: { 'Accept-Language': 'en', 'User-Agent': 'MeetupOptimizer/1.0' },
  });
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  const data = await res.json();
  if (!data.length) throw new Error(`Address not found: "${address}"`);
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), displayName: data[0].display_name };
}

// Reverse geocode optimal point
async function reverseGeocode(lat, lng) {
  const now = Date.now();
  const wait = Math.max(0, 1100 - (now - lastGeocode));
  if (wait > 0) await delay(wait);
  lastGeocode = Date.now();

  const url = `https://nominatim.openstreetmap.org/reverse?` +
    `lat=${lat}&lon=${lng}&format=json`;
  const res = await fetch(url, {
    headers: { 'Accept-Language': 'en', 'User-Agent': 'MeetupOptimizer/1.0' },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.display_name || null;
}

// ── Weiszfeld Geometric Median ─────────────────
// Minimises sum of distances from all participant locations.
// Much better than centroid for travel-distance optimisation.
function geometricMedian(points, maxIter = 300, tol = 1e-7) {
  if (points.length === 1) return { lat: points[0].lat, lng: points[0].lng };
  if (points.length === 2) return {
    lat: (points[0].lat + points[1].lat) / 2,
    lng: (points[0].lng + points[1].lng) / 2,
  };

  // Start from centroid
  let lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  let lng = points.reduce((s, p) => s + p.lng, 0) / points.length;

  for (let i = 0; i < maxIter; i++) {
    let wLat = 0, wLng = 0, wSum = 0;
    for (const p of points) {
      const d = Math.sqrt((p.lat - lat) ** 2 + (p.lng - lng) ** 2);
      if (d < 1e-10) continue; // skip if coincident
      const w = 1 / d;
      wLat += w * p.lat;
      wLng += w * p.lng;
      wSum += w;
    }
    if (wSum === 0) break;
    const newLat = wLat / wSum;
    const newLng = wLng / wSum;
    if (Math.abs(newLat - lat) < tol && Math.abs(newLng - lng) < tol) break;
    lat = newLat;
    lng = newLng;
  }
  return { lat, lng };
}

// ── Haversine distance (km) ────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
const rad = d => d * Math.PI / 180;

// ── Overpass nearby venues ─────────────────────
async function fetchNearbyVenues(lat, lng, radiusM = 500) {
  const query = `
    [out:json][timeout:10];
    (
      node["amenity"~"cafe|restaurant|bar|pub|fast_food|food_court|bistro"](around:${radiusM},${lat},${lng});
      way["amenity"~"cafe|restaurant|bar|pub|fast_food|food_court|bistro"](around:${radiusM},${lat},${lng});
    );
    out center 30;
  `.trim();

  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: 'data=' + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error('Overpass request failed');
  const data = await res.json();

  return data.elements.map(el => {
    const elLat = el.lat ?? el.center?.lat;
    const elLng = el.lon ?? el.center?.lon;
    return {
      id: el.id,
      name: el.tags?.name || 'Unnamed venue',
      type: el.tags?.amenity || 'venue',
      lat: elLat,
      lng: elLng,
      dist: haversine(lat, lng, elLat, elLng),
    };
  }).filter(v => v.lat && v.lng)
    .sort((a, b) => a.dist - b.dist);
}

// ── Custom map icons ───────────────────────────
function makeParticipantIcon(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
    <path d="M14 0C6.27 0 0 6.27 0 14c0 9.6 14 22 14 22S28 23.6 28 14C28 6.27 21.73 0 14 0z"
      fill="${color}" stroke="white" stroke-width="2"/>
    <circle cx="14" cy="14" r="5" fill="white"/>
  </svg>`;
  return L.divIcon({
    html: svg,
    className: '',
    iconSize: [28, 36],
    iconAnchor: [14, 36],
    popupAnchor: [0, -36],
  });
}

const optimalIcon = (() => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="44" viewBox="0 0 36 44">
    <path d="M18 0C8.06 0 0 8.06 0 18c0 12 18 26 18 26S36 30 36 18C36 8.06 27.94 0 18 0z"
      fill="#f59e0b" stroke="white" stroke-width="2.5"/>
    <text x="18" y="24" text-anchor="middle" font-size="16" fill="white">★</text>
  </svg>`;
  return L.divIcon({
    html: svg,
    className: '',
    iconSize: [36, 44],
    iconAnchor: [18, 44],
    popupAnchor: [0, -44],
  });
})();

function makeVenueIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="28" viewBox="0 0 22 28">
    <path d="M11 0C4.92 0 0 4.92 0 11c0 7.5 11 17 11 17S22 18.5 22 11C22 4.92 17.08 0 11 0z"
      fill="#0891b2" stroke="white" stroke-width="1.5"/>
    <circle cx="11" cy="11" r="4" fill="white"/>
  </svg>`;
  return L.divIcon({
    html: svg,
    className: '',
    iconSize: [22, 28],
    iconAnchor: [11, 28],
    popupAnchor: [0, -28],
  });
}

// ── Render participants list ───────────────────
function renderParticipants() {
  participantCount.textContent = state.participants.length;
  btnFind.disabled = state.participants.length < 2;

  if (state.participants.length === 0) {
    participantList.innerHTML = '<li class="empty-state">No participants yet. Add someone above.</li>';
    return;
  }

  participantList.innerHTML = '';
  for (const p of state.participants) {
    const li = document.createElement('li');
    li.className = 'participant-item';
    li.dataset.id = p.id;
    li.innerHTML = `
      <div class="participant-dot" style="background:${p.color}"></div>
      <div class="participant-info">
        <div class="participant-name">${escHtml(p.name)}</div>
        <div class="participant-address">${escHtml(p.address)}</div>
        ${p.distToOptimal != null
          ? `<div class="participant-distance">${p.distToOptimal.toFixed(1)} km to meetup</div>`
          : ''}
      </div>
      <button class="btn-remove" title="Remove" data-id="${p.id}">×</button>
    `;
    participantList.appendChild(li);
  }
}

// ── Add participant ────────────────────────────
btnAdd.addEventListener('click', addParticipant);
inputAddress.addEventListener('keydown', e => { if (e.key === 'Enter') addParticipant(); });
inputName.addEventListener('keydown', e => { if (e.key === 'Enter') inputAddress.focus(); });

async function addParticipant() {
  const name = inputName.value.trim();
  const address = inputAddress.value.trim();
  if (!name || !address) {
    setStatus('Please enter both a name and an address.', 'error');
    return;
  }

  btnAdd.disabled = true;
  setStatus('Geocoding address…', 'loading');

  try {
    const geo = await geocode(address);
    const color = PIN_COLORS[state.participants.length % PIN_COLORS.length];
    const id = state.nextId++;

    const marker = L.marker([geo.lat, geo.lng], { icon: makeParticipantIcon(color) })
      .addTo(map)
      .bindPopup(`<strong>${escHtml(name)}</strong><br>${escHtml(address)}`);

    state.participants.push({ id, name, address, lat: geo.lat, lng: geo.lng, marker, color });

    inputName.value = '';
    inputAddress.value = '';
    setStatus(`${name} added.`, 'success');
    renderParticipants();
    fitMapToParticipants();

    // Auto-hide "add" message
    setTimeout(() => setStatus('', ''), 2500);
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    btnAdd.disabled = false;
    inputName.focus();
  }
}

// ── Remove participant ─────────────────────────
participantList.addEventListener('click', e => {
  const btn = e.target.closest('.btn-remove');
  if (!btn) return;
  const id = parseInt(btn.dataset.id, 10);
  const idx = state.participants.findIndex(p => p.id === id);
  if (idx === -1) return;
  state.participants[idx].marker.remove();
  state.participants.splice(idx, 1);
  renderParticipants();
  fitMapToParticipants();
  // Reset results if we go below 2
  if (state.participants.length < 2) {
    clearResults();
    mapOverlay.classList.remove('hidden');
  }
});

// ── Find optimal spot ──────────────────────────
btnFind.addEventListener('click', findOptimal);

async function findOptimal() {
  btnFind.disabled = true;
  btnFind.textContent = 'Calculating…';
  clearResults();
  mapOverlay.classList.add('hidden');

  try {
    const points = state.participants.map(p => ({ lat: p.lat, lng: p.lng }));
    const optimal = geometricMedian(points);

    // Compute distances
    const distances = state.participants.map(p => haversine(p.lat, p.lng, optimal.lat, optimal.lng));
    const totalDist = distances.reduce((s, d) => s + d, 0);
    const avgDist = totalDist / distances.length;
    const maxDist = Math.max(...distances);

    // Attach distance to each participant for display
    state.participants.forEach((p, i) => { p.distToOptimal = distances[i]; });
    renderParticipants();

    // Place optimal marker
    if (state.optimalMarker) state.optimalMarker.remove();
    state.optimalMarker = L.marker([optimal.lat, optimal.lng], { icon: optimalIcon, zIndexOffset: 1000 })
      .addTo(map)
      .bindPopup('<strong>★ Optimal Meetup Point</strong>')
      .openPopup();

    map.panTo([optimal.lat, optimal.lng]);

    // Show results section with spinner
    resultsSection.classList.remove('hidden');
    optimalAddress.innerHTML = '<div class="spinner"></div>';

    // Reverse geocode (async)
    const addr = await reverseGeocode(optimal.lat, optimal.lng);
    optimalAddress.textContent = addr ? formatAddress(addr) : `${optimal.lat.toFixed(5)}, ${optimal.lng.toFixed(5)}`;

    distanceSummary.innerHTML =
      `<strong>Avg distance:</strong> ${avgDist.toFixed(1)} km &nbsp;·&nbsp; ` +
      `<strong>Max:</strong> ${maxDist.toFixed(1)} km &nbsp;·&nbsp; ` +
      `<strong>Total:</strong> ${totalDist.toFixed(1)} km`;

    // Fetch nearby venues
    venuesSection.classList.remove('hidden');
    venuesList.innerHTML = '<li class="empty-state"><div class="spinner" style="display:inline-block"></div> Loading venues…</li>';

    try {
      const venues = await fetchNearbyVenues(optimal.lat, optimal.lng);
      clearVenueMarkers();

      if (venues.length === 0) {
        venuesList.innerHTML = '<li class="empty-state">No venues found nearby.</li>';
        venuesCount.textContent = '0';
      } else {
        venuesCount.textContent = venues.length;
        venuesList.innerHTML = '';
        for (const v of venues) {
          renderVenueItem(v);
          const vm = L.marker([v.lat, v.lng], { icon: makeVenueIcon() })
            .addTo(map)
            .bindPopup(`<strong>${escHtml(v.name)}</strong><br>${v.type} · ${(v.dist * 1000).toFixed(0)} m`);
          state.venueMarkers.push(vm);
        }
      }
    } catch {
      venuesList.innerHTML = '<li class="empty-state">Could not load venues.</li>';
    }

  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    btnFind.disabled = false;
    btnFind.textContent = 'Find Optimal Meetup Spot';
  }
}

function renderVenueItem(v) {
  const icons = { cafe: '☕', restaurant: '🍽️', bar: '🍺', pub: '🍻', fast_food: '🍔', bistro: '🥗' };
  const icon = icons[v.type] || '📍';
  const li = document.createElement('li');
  li.className = 'venue-item';
  li.innerHTML = `
    <span class="venue-icon">${icon}</span>
    <div class="venue-info">
      <div class="venue-name">${escHtml(v.name)}</div>
      <div class="venue-meta">${capitalise(v.type)}</div>
    </div>
    <span class="venue-dist">${(v.dist * 1000).toFixed(0)} m</span>
  `;
  li.addEventListener('click', () => {
    map.setView([v.lat, v.lng], 17);
    // Open the matching marker popup
    state.venueMarkers.forEach(m => {
      const ll = m.getLatLng();
      if (Math.abs(ll.lat - v.lat) < 1e-6 && Math.abs(ll.lng - v.lng) < 1e-6) m.openPopup();
    });
  });
  venuesList.appendChild(li);
}

// ── Helpers ────────────────────────────────────
function clearResults() {
  resultsSection.classList.add('hidden');
  venuesSection.classList.add('hidden');
  if (state.optimalMarker) { state.optimalMarker.remove(); state.optimalMarker = null; }
  clearVenueMarkers();
  state.participants.forEach(p => { p.distToOptimal = null; });
}

function clearVenueMarkers() {
  state.venueMarkers.forEach(m => m.remove());
  state.venueMarkers = [];
}

function fitMapToParticipants() {
  if (state.participants.length === 0) { map.setView([20, 0], 2); return; }
  const latlngs = state.participants.map(p => [p.lat, p.lng]);
  map.fitBounds(L.latLngBounds(latlngs), { padding: [60, 60], maxZoom: 13 });
}

function setStatus(msg, type) {
  geocodeStatus.textContent = msg;
  geocodeStatus.className = 'status-msg' + (type ? ' ' + type : '');
}

function formatAddress(full) {
  // Show first 2–3 meaningful parts of a Nominatim display_name
  const parts = full.split(',').map(s => s.trim());
  return parts.slice(0, 3).join(', ');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function capitalise(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g,' ') : ''; }

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Initial overlay ────────────────────────────
mapOverlay.classList.remove('hidden');
