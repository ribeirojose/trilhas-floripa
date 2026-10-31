"use strict";

// Data comes from trails.geojson (committed to the repo), NOT a live OSM query.
// Refresh it with: python3 scripts/refresh.py
const DATA_URL = "trails.geojson";

const DIFFICULTY_LABEL = { easy: "Fácil", medium: "Moderada", difficult: "Difícil" };
const KIND_LABEL = { trilha: "Trilha", caminho: "Caminho" };
const COLOR_UNKNOWN = "#7c3aed";
const COLORS = {
  easy: "#16a34a",
  medium: "#ea580c",
  difficult: "#dc2626",
};

// Sidebar grouping. "Ilha" first because the project started there, then the
// mainland coast and the serra.
const GROUPS = [
  { key: "ilha", label: "Ilha de Santa Catarina" },
  { key: "litoral", label: "Litoral" },
  { key: "serra", label: "Serra e Vale" },
  { key: "interior", label: "Interior" },
];

const state = {
  trails: [],
  active: null,
  map: null,
  layers: new Map(),
  group: "",
  municipio: "",
};

// --- Load -------------------------------------------------------------------
async function loadTrails() {
  const res = await fetch(DATA_URL, { cache: "no-cache" });
  if (!res.ok) throw new Error(`trails.geojson ${res.status}`);
  const json = await res.json();
  return {
    meta: json.metadata || {},
    trails: (json.features || []).map((f) => ({
      ...f.properties,
      // Which sidebar group this trail belongs to.
      group: f.properties.municipio === "Florianópolis" ? "ilha" : f.properties.landscape,
      line: f.geometry.coordinates.map((seg) => seg.map(([lon, lat]) => [lat, lon])),
    })),
  };
}

const colorOf = (t) => COLORS[t.difficulty] || COLOR_UNKNOWN;

// --- Filtering --------------------------------------------------------------
function filterTrails(trails, search, difficulty, kind, group, municipio) {
  const q = search.trim().toLowerCase();
  return trails.filter((t) => {
    if (q && !t.name.toLowerCase().includes(q)) return false;
    if (difficulty && t.difficulty !== difficulty) return false;
    if (kind && t.kind !== kind) return false;
    if (group && t.group !== group) return false;
    if (municipio && t.municipio !== municipio) return false;
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
  if (t.municipio && t.group !== "ilha") {
    meta.appendChild(chip(t.municipio, "kind"));
  } else {
    meta.appendChild(chip(KIND_LABEL[t.kind] || t.kind, "kind"));
  }
  if (t.difficulty) meta.appendChild(chip(DIFFICULTY_LABEL[t.difficulty], t.difficulty));
  if (t.distanceKm) meta.appendChild(chip(t.distanceKm.toFixed(1) + " km"));
  li.appendChild(meta);

  li.addEventListener("click", () => selectTrail(t));
  return li;
}

function renderList(list) {
  const ul = document.getElementById("trail-list");
  ul.innerHTML = "";

  for (const group of GROUPS) {
    const trails = list.filter((t) => t.group === group.key);
    if (!trails.length) continue;

    const header = document.createElement("li");
    header.className = "region-header";

    const label = document.createElement("span");
    label.className = "region-name";
    label.textContent = group.label;
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
  if (t.municipio) rows.push(`<strong>Município:</strong> ${t.municipio}`);
  if (t.zoneLabel && t.group === "ilha") rows.push(`<strong>Região:</strong> ${t.zoneLabel}`);
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

// --- Group tabs --------------------------------------------------------------
function selectGroup(group) {
  state.group = group;
  state.municipio = ""; // a município from another group no longer applies
  syncMunicipioOptions();
  for (const btn of document.querySelectorAll(".region-btn")) {
    const on = btn.dataset.group === group;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", String(on));
  }
  state.active = null;
  renderAll();
  flyToVisible();
}

function flyToVisible() {
  const trails = filterTrails(
    state.trails,
    val("search"),
    val("difficulty-filter"),
    val("kind-filter"),
    state.group,
    state.municipio
  );
  if (!trails.length) return;
  const bounds = L.latLngBounds([]);
  for (const t of trails) {
    const entry = state.layers.get(t.name);
    if (entry) bounds.extend(entry.line.getBounds());
  }
  if (bounds.isValid()) {
    state.map.flyToBounds(bounds, { padding: [50, 50], duration: 0.7, maxZoom: 13 });
  }
}

function syncMunicipioOptions() {
  const select = document.getElementById("municipio-filter");
  const visible = state.trails.filter((t) => !state.group || t.group === state.group);
  const names = [...new Set(visible.map((t) => t.municipio).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "pt-BR")
  );

  const current = state.municipio;
  select.innerHTML = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "Todo município";
  select.appendChild(all);
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  select.value = names.includes(current) ? current : "";
  state.municipio = select.value;
}

function renderAll() {
  const list = filterTrails(
    state.trails,
    val("search"),
    val("difficulty-filter"),
    val("kind-filter"),
    state.group,
    state.municipio
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
  const map = L.map("map", { zoomControl: true }).setView([-27.64, -48.47], 11);
  // Terrain basemap: hills and water give trails context and contrast.
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

    state.layers.set(t.name, { casing, line: lines, all: [casing, lines] });
  }

  map.on("zoomend", renderAll);
}

// --- Bootstrap --------------------------------------------------------------
["search", "difficulty-filter", "kind-filter", "municipio-filter"].forEach((id) => {
  document.getElementById(id).addEventListener("input", renderAll);
  document.getElementById(id).addEventListener("change", renderAll);
});

for (const btn of document.querySelectorAll(".region-btn")) {
  btn.addEventListener("click", () => selectGroup(btn.dataset.group));
}

(async function main() {
  const loading = document.getElementById("loading");
  try {
    const { meta, trails } = await loadTrails();
    state.trails = trails;

    const count = document.getElementById("trail-count");
    count.textContent = `${trails.length} trilhas`;
    document.getElementById("scope").textContent =
      `${meta.municipios?.length || 0} municípios · ${meta.count || trails.length} trilhas`;

    initMap();
    syncMunicipioOptions();
    renderAll();
    loading.hidden = true;
  } catch (err) {
    loading.textContent = "Falha ao carregar trilhas: " + err.message;
    console.error(err);
  }
})();
