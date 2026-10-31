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
  unknown: "#2563eb",
};

const state = { trails: [], active: null, map: null, layers: new Map() };

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
function filterTrails(trails, search, difficulty, kind) {
  const q = search.trim().toLowerCase();
  return trails.filter((t) => {
    if (q && !t.name.toLowerCase().includes(q)) return false;
    if (difficulty && t.difficulty !== difficulty) return false;
    if (kind && t.kind !== kind) return false;
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

function renderList(list) {
  const ul = document.getElementById("trail-list");
  ul.innerHTML = "";
  for (const t of list) {
    const li = document.createElement("li");
    li.className = "trail-item" + (state.active === t ? " active" : "");
    li.dataset.name = t.name;

    const name = document.createElement("div");
    name.className = "trail-name";
    name.textContent = t.name;
    li.appendChild(name);

    const meta = document.createElement("div");
    meta.className = "trail-meta";
    meta.appendChild(chip(KIND_LABEL[t.kind] || t.kind));
    if (t.difficulty) meta.appendChild(chip(DIFFICULTY_LABEL[t.difficulty], t.difficulty));
    if (t.distanceKm) meta.appendChild(chip(t.distanceKm.toFixed(1) + " km"));
    li.appendChild(meta);

    li.addEventListener("click", () => selectTrail(t));
    ul.appendChild(li);
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
  if (t.difficulty) rows.push(`<strong>Dificuldade:</strong> ${DIFFICULTY_LABEL[t.difficulty]}`);
  if (t.distanceKm) rows.push(`<strong>Distância:</strong> ${t.distanceKm.toFixed(2)} km`);
  if (t.surface) rows.push(`<strong>Piso:</strong> ${t.surface}`);
  if (t.operator) rows.push(`<strong>Gestor:</strong> ${t.operator}`);
  rows.push(
    `<a href="https://www.openstreetmap.org/${t.osm}" target="_blank" rel="noopener">Ver / editar no OpenStreetMap</a>`
  );
  return `<strong>${t.name}</strong><br>` + rows.join("<br>");
}

const val = (id) => document.getElementById(id).value;

function renderAll() {
  const list = filterTrails(state.trails, val("search"), val("difficulty-filter"), val("kind-filter"));
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
    entry.line.setStyle({
      weight: isActive ? 7 : zoom >= 14 ? 5 : zoom >= 12 ? 4 : 3,
      opacity: 1,
      color: isActive ? "#facc15" : colorOf(trail),
    });
    entry.casing.setStyle({
      weight: isActive ? 12 : zoom >= 14 ? 10 : zoom >= 12 ? 9 : 8,
      opacity: 0.5,
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
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  state.map = map;

  for (const t of state.trails) {
    // Dark casing underneath: trails stay readable over busy OSM tiles.
    const casing = L.featureGroup(
      t.line.map((seg) =>
        L.polyline(seg, {
          color: "#000000",
          weight: 9,
          opacity: 0.35,
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
