"use strict";

// Data comes from trails.geojson (committed to the repo), NOT a live OSM query.
// Refresh it with: python3 scripts/refresh.py
const DATA_URL = "trails.geojson";

const DIFFICULTY_LABEL = { easy: "Fácil", medium: "Moderada", difficult: "Difícil" };
const KIND_LABEL = { trilha: "Trilha", caminho: "Caminho" };
const COLORS = {
  easy: "#16a34a",
  medium: "#ea580c",
  difficult: "#dc2626",
  unknown: "#7c3aed",
};

const REGION_ORDER = ["norte", "leste", "centro-oeste", "sul", "continente"];

const state = { trails: [], active: null, map: null, layers: new Map(), region: "" };

// --- Load -------------------------------------------------------------------
async function loadTrails() {
  const res = await fetch(DATA_URL, { cache: "no-cache" });
  if (!res.ok) throw new Error(`trails.geojson ${res.status}`);
  const json = await res.json();
  return (json.features || []).map((f) => ({
    ...f.properties,
    line: f.geometry.coordinates.map((seg) => seg.map(([lon, lat]) => [lat, lon])),
  }));
}

const colorOf = (t) => COLORS[t.difficulty] || COLORS.unknown;

// --- Filtering --------------------------------------------------------------
function filterTrails(trails, search, difficulty, kind, region) {
  const q = search.trim().toLowerCase();
  return trails.filter((t) => {
    if (q && !t.name.toLowerCase().includes(q)) return false;
    if (difficulty && t.difficulty !== difficulty) return false;
    if (kind && t.kind !== kind) return false;
    if (region && t.region !== region) return false;
    return true;
  });
}

// --- Rendering --------------------------------------------------------------
function chip(text, cls) {
  const el = document.createElement("span");
  el.className = "chip" + (cls ? " " + cls : "");
  el.textContent = text;
  return el;
}

function trailItem(t) {
  const li = document.createElement("li");
  li.className = "trail-item" + (state.active === t ? " active" : "");
  li.dataset.name = t.name;

  const name = document.createElement("div");
  name.className = "trail-name";
  name.textContent = t.name;
  li.appendChild(name);

  const meta = document.createElement("div");
  meta.className = "trail-meta";
  meta.appendChild(chip(KIND_LABEL[t.kind] || t.kind, "kind"));
  if (t.difficulty) meta.appendChild(chip(DIFFICULTY_LABEL[t.difficulty], t.difficulty));
  if (t.distanceKm) meta.appendChild(chip(t.distanceKm.toFixed(1) + " km"));
  li.appendChild(meta);

  li.addEventListener("click", () => selectTrail(t));
  return li;
}

function renderList(list) {
  const ul = document.getElementById("trail-list");
  ul.innerHTML = "";

  // Group by region so the sidebar reads as a guidebook, not a flat dump.
  const groups = new Map();
  for (const t of list) {
    const key = t.region || "outros";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  for (const region of REGION_ORDER) {
    const trails = groups.get(region);
    if (!trails || !trails.length) continue;

    const header = document.createElement("li");
    header.className = "region-header";

    const label = document.createElement("span");
    label.className = "region-name";
    label.textContent = trails[0].regionLabel || region;
    header.appendChild(label);

    const count = document.createElement("span");
    count.className = "region-count";
    count.textContent = trails.length;
    header.appendChild(count);

    ul.appendChild(header);
    for (const t of trails) ul.appendChild(trailItem(t));
  }

  document.getElementById("list-empty").hidden = list.length > 0;
}

function selectTrail(t) {
  state.active = t;
  renderAll();
  const entry = state.layers.get(t.name);
  state.map.flyToBounds(entry.line.getBounds(), { padding: [60, 60], duration: 0.7 });
  entry.line.openPopup();
}

function popupHtml(t) {
  const rows = [];
  if (t.regionLabel) rows.push(`<strong>Região:</strong> ${t.regionLabel}`);
  if (t.difficulty) rows.push(`<strong>Dificuldade:</strong> ${DIFFICULTY_LABEL[t.difficulty]}`);
  if (t.distanceKm) rows.push(`<strong>Distância:</strong> ${t.distanceKm.toFixed(2)} km`);
  if (t.surface) rows.push(`<strong>Piso:</strong> ${t.surface}`);
  if (t.operator) rows.push(`<strong>Gestor:</strong> ${t.operator}`);
  rows.push(
    `<a href="https://www.openstreetmap.org/${t.osm}" target="_blank" rel="noopener">Ver / editar no OpenStreetMap ↗</a>`
  );
  return `<strong>${t.name}</strong><br>` + rows.join("<br>");
}

const val = (id) => document.getElementById(id).value;

// --- Region tabs -------------------------------------------------------------
function selectRegion(region) {
  state.region = region;
  for (const btn of document.querySelectorAll(".region-btn")) {
    const on = btn.dataset.region === region;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", String(on));
  }
  state.active = null;
  renderAll();

  // Frame the selected region on the map.
  const trails = filterTrails(state.trails, "", "", "", region);
  if (!trails.length) return;
  const bounds = L.latLngBounds([]);
  for (const t of trails) {
    const entry = state.layers.get(t.name);
    if (entry) bounds.extend(entry.line.getBounds());
  }
  if (bounds.isValid()) {
    state.map.flyToBounds(bounds, { padding: [50, 50], duration: 0.7, maxZoom: 14 });
  }
}

function renderAll() {
  const list = filterTrails(
    state.trails,
    val("search"),
    val("difficulty-filter"),
    val("kind-filter"),
    state.region
  );
  renderList(list);

  const visible = new Set(list.map((t) => t.name));
  const zoom = state.map.getZoom();
  for (const [name, entry] of state.layers) {
    const trail = state.trails.find((t) => t.name === name);
    const isActive = state.active && state.active.name === name;

    if (!visible.has(name)) {
      for (const layer of entry.all) {
        if (state.map.hasLayer(layer)) state.map.removeLayer(layer);
      }
      continue;
    }
    for (const layer of entry.all) {
      if (!state.map.hasLayer(layer)) layer.addTo(state.map);
    }

    // Style only the coloured line layer; the casing keeps its own colour.
    // With a selection active, other trails step back.
    const dimmed = state.active && !isActive;
    entry.line.setStyle({
      weight: isActive ? 6 : zoom >= 14 ? 4 : zoom >= 12 ? 3.5 : 2.5,
      opacity: isActive ? 1 : dimmed ? 0.25 : 1,
      color: colorOf(trail),
    });
    entry.casing.setStyle({
      weight: isActive ? 11 : zoom >= 14 ? 9 : zoom >= 12 ? 8 : 7,
      opacity: isActive ? 1 : dimmed ? 0.15 : 0.85,
    });
    if (isActive) {
      entry.casing.bringToFront();
      entry.line.bringToFront();
    }
  }
  document.getElementById("trail-count").textContent =
    `${list.length} de ${state.trails.length} trilhas`;
}

// --- Map --------------------------------------------------------------------
function initMap() {
  // Centre on the island itself. Falling back to fitBounds on every trail
  // zooms out to ~50 km, where 1 km trails are sub-pixel.
  const map = L.map("map", { zoomControl: true }).setView([-27.64, -48.47], 12);
  // Terrain basemap: hills and water give trails context and contrast.
  // Esri World Topo serves without an API key.
  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 17,
      maxNativeZoom: 17,
      attribution:
        'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ &middot; Dados &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }
  ).addTo(map);
  state.map = map;

  for (const t of state.trails) {
    // White casing keeps each trail legible over pale basemap detail.
    const casing = L.featureGroup(
      t.line.map((seg) =>
        L.polyline(seg, {
          color: "#ffffff",
          weight: 8,
          opacity: 0.9,
          lineCap: "round",
          lineJoin: "round",
          interactive: false,
        })
      )
    ).addTo(map);
    const lines = L.featureGroup(
      t.line.map((seg) =>
        L.polyline(seg, {
          color: colorOf(t),
          weight: 4,
          opacity: 1,
          lineCap: "round",
          lineJoin: "round",
          bubblingMouseEvents: false,
        })
      )
    );
    lines.bindPopup(popupHtml(t));
    lines.on("click", () => selectTrail(t));
    lines.addTo(map);

    // Casing and line stay separate so filtering can restyle only the line.
    state.layers.set(t.name, { casing, line: lines, all: [casing, lines] });
  }

  map.on("zoomend", renderAll);
}

// --- Bootstrap --------------------------------------------------------------
["search", "difficulty-filter", "kind-filter"].forEach((id) => {
  document.getElementById(id).addEventListener("input", renderAll);
  document.getElementById(id).addEventListener("change", renderAll);
});

for (const btn of document.querySelectorAll(".region-btn")) {
  btn.addEventListener("click", () => selectRegion(btn.dataset.region));
}

(async function main() {
  const loading = document.getElementById("loading");
  try {
    state.trails = await loadTrails();
    initMap();
    renderAll();
    loading.hidden = true;
  } catch (err) {
    loading.textContent = "Falha ao carregar trilhas: " + err.message;
    console.error(err);
  }
})();
