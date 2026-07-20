/* Steradian Land Prospector — app */
"use strict";

const C = {
  gold: "#c98500", goldBright: "#ffb52e", blue: "#4a8ce2", teal: "#12855d",
  tealBright: "#2fbf8a", magenta: "#da5c92", orange: "#b64a1f", orangeBright: "#e9722e",
  line500: "#cde2fb", line345: "#86b6ef", line230: "#4a8ce2", line138: "#2f5f9e",
};

const fmt = (n) => n == null ? "—" : n.toLocaleString("en-US");
const fmtMW = (n) => n == null ? "—" : n >= 1000 ? (n / 1000).toFixed(1) + " GW" : Math.round(n).toLocaleString() + " MW";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = {
  data: {}, markers: [], selected: null,
  minScore: 0, minKV: 138, kindFilter: "all", search: "", heatMetric: "heat",
  layers: { counties: true, lines: true, subs: true, fiber: true, queue: false, plants: false, pipelines: true },
};

let map = null;
let mapReady = Promise.resolve();
try {
  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        carto: {
          type: "raster",
          tiles: ["a", "b", "c", "d"].map((s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png`),
          tileSize: 256,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        },
      },
      layers: [{ id: "base", type: "raster", source: "carto" }],
    },
    center: [-99.3, 31.2], zoom: 5.4, minZoom: 4.5, maxZoom: 16,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-left");
  mapReady = new Promise((res) => {
    if (map.isStyleLoaded()) res();
    else map.on("load", res);
  });
} catch (err) {
  console.error("Map init failed (WebGL unavailable?) — panel still works.", err);
}

async function loadData() {
  const names = ["summary", "listings", "substations", "lines", "plants", "queue", "fiber", "counties", "pipelines"];
  const res = await Promise.all(names.map((n) => fetch(`data/${n}.${n === "summary" ? "json" : "geojson"}`).then((r) => r.json())));
  names.forEach((n, i) => (state.data[n] = res[i]));
}

/* ---------------- county heat ---------------- */
const HEAT_EXPR = {
  heat: ["interpolate", ["linear"], ["get", "heat"],
    0, "rgba(30,40,60,0)", 8, "rgba(24,79,149,0.16)", 25, "rgba(28,92,171,0.30)",
    55, "rgba(57,135,229,0.42)", 90, "rgba(134,182,239,0.55)"],
  queue_mw: ["interpolate", ["linear"], ["get", "queue_mw"],
    0, "rgba(30,40,60,0)", 500, "rgba(24,79,149,0.16)", 2000, "rgba(28,92,171,0.30)",
    6000, "rgba(57,135,229,0.42)", 15000, "rgba(134,182,239,0.55)"],
  plants_mw: ["interpolate", ["linear"], ["get", "plants_mw"],
    0, "rgba(30,40,60,0)", 200, "rgba(24,79,149,0.16)", 1000, "rgba(28,92,171,0.30)",
    4000, "rgba(57,135,229,0.42)", 10000, "rgba(134,182,239,0.55)"],
  hv_subs: ["interpolate", ["linear"], ["get", "hv_subs"],
    0, "rgba(30,40,60,0)", 4, "rgba(24,79,149,0.16)", 12, "rgba(28,92,171,0.30)",
    30, "rgba(57,135,229,0.42)", 70, "rgba(134,182,239,0.55)"],
};

/* ---------------- map layers ---------------- */
function addLayers() {
  const d = state.data;

  map.addSource("counties", { type: "geojson", data: d.counties });
  map.addLayer({
    id: "counties-fill", type: "fill", source: "counties",
    paint: {
      "fill-color": HEAT_EXPR[state.heatMetric],
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 6, 1, 8, 0.35, 10, 0.12],
    },
  });
  map.addLayer({
    id: "counties-line", type: "line", source: "counties",
    paint: { "line-color": "rgba(255,255,255,0.07)", "line-width": 0.6 },
  });

  map.addSource("pipelines", { type: "geojson", data: d.pipelines });
  map.addLayer({
    id: "pipelines", type: "line", source: "pipelines",
    paint: {
      "line-color": ["match", ["get", "t"], "Interstate", "#e9722e", "#a3653a"],
      "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.7, 10, 1.8],
      "line-opacity": ["match", ["get", "t"], "Interstate", 0.55, 0.35],
      "line-dasharray": [2.2, 1.8],
    },
  });

  map.addSource("lines", { type: "geojson", data: d.lines });
  map.addLayer({
    id: "lines-glow", type: "line", source: "lines",
    filter: [">=", ["get", "vc"], 345],
    paint: {
      "line-color": C.line345, "line-width": ["interpolate", ["linear"], ["zoom"], 5, 2.4, 10, 7],
      "line-blur": 5, "line-opacity": 0.5,
    },
    layout: { "line-cap": "round", "line-join": "round" },
  });
  map.addLayer({
    id: "lines-core", type: "line", source: "lines",
    paint: {
      "line-color": ["match", ["get", "vc"], 500, C.line500, 345, C.line345, 230, C.line230, C.line138],
      "line-width": ["interpolate", ["linear"], ["zoom"],
        5, ["match", ["get", "vc"], 500, 1.8, 345, 1.5, 230, 1.0, 0.5],
        10, ["match", ["get", "vc"], 500, 3.5, 345, 3.0, 230, 2.2, 1.4]],
      "line-opacity": ["match", ["get", "vc"], 500, 0.95, 345, 0.9, 230, 0.75, 0.5],
    },
    layout: { "line-cap": "round", "line-join": "round" },
  });

  map.addSource("subs", { type: "geojson", data: d.substations });
  map.addLayer({
    id: "subs", type: "circle", source: "subs",
    filter: [">=", ["coalesce", ["get", "kv"], 0], state.minKV],
    paint: {
      "circle-color": C.blue,
      "circle-radius": ["interpolate", ["linear"], ["zoom"],
        5, ["case", [">=", ["coalesce", ["get", "kv"], 0], 345], 3.4, [">=", ["coalesce", ["get", "kv"], 0], 230], 2.6, 1.8],
        10, ["case", [">=", ["coalesce", ["get", "kv"], 0], 345], 8, [">=", ["coalesce", ["get", "kv"], 0], 230], 6, 4.5]],
      "circle-opacity": 0.85,
      "circle-stroke-color": "rgba(255,255,255,0.75)",
      "circle-stroke-width": ["case", [">=", ["coalesce", ["get", "kv"], 0], 345], 1, 0],
    },
  });

  map.addSource("plants", { type: "geojson", data: d.plants });
  map.addLayer({
    id: "plants", type: "circle", source: "plants",
    layout: { visibility: "none" },
    paint: {
      "circle-color": C.orange,
      "circle-radius": ["interpolate", ["linear"], ["sqrt", ["get", "mw"]], 3, 2.5, 60, 11],
      "circle-opacity": 0.75, "circle-stroke-color": "rgba(255,255,255,0.4)", "circle-stroke-width": 0.5,
    },
  });

  map.addSource("queue", { type: "geojson", data: d.queue });
  map.addLayer({
    id: "queue", type: "circle", source: "queue",
    layout: { visibility: "none" },
    paint: {
      "circle-color": C.magenta,
      "circle-radius": ["interpolate", ["linear"], ["sqrt", ["get", "mw"]], 2, 2, 40, 9],
      "circle-opacity": 0.55,
      "circle-stroke-color": ["case", ["==", ["get", "new"], true], "#2fbf8a", "rgba(255,255,255,0.35)"],
      "circle-stroke-width": ["case", ["==", ["get", "new"], true], 1.6, 0.5],
    },
  });

  map.addSource("fiber", { type: "geojson", data: d.fiber });
  map.addLayer({
    id: "fiber", type: "circle", source: "fiber",
    paint: {
      "circle-color": C.teal,
      "circle-radius": ["interpolate", ["linear"], ["get", "net_count"], 0, 3.5, 170, 9],
      "circle-opacity": 0.9, "circle-stroke-color": C.tealBright, "circle-stroke-width": 1.2,
    },
  });

  hookPopups();
  buildMarkers();
}

/* ---------------- popups ---------------- */
const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 });

function hoverPopup(layer, html) {
  map.on("mousemove", layer, (e) => {
    map.getCanvas().style.cursor = "pointer";
    popup.setLngLat(e.lngLat).setHTML(html(e.features[0].properties)).addTo(map);
  });
  map.on("mouseleave", layer, () => {
    map.getCanvas().style.cursor = "";
    popup.remove();
  });
}

function hookPopups() {
  hoverPopup("subs", (p) => `
    <div class="pp-t">${esc(p.name || "Substation")}</div>
    <div class="pp-r"><b>${p.kv ? p.kv + " kV" : "kV unknown"}</b> · ${p.lines} line${p.lines == 1 ? "" : "s"} · ${esc((p.county || "").replace(/\b\w/g, c => c.toUpperCase()))} Co.</div>
    <div class="pp-r">Est. deliverable: <b>${esc(p.est_mw)}</b></div>
    <div class="pp-r">Nearest colo: <b>${p.fiber_mi} mi</b> · County queue: <b>${fmt(p.county_queue_mw)} MW</b></div>
    <div class="pp-r">Opportunity score: <b>${p.score}</b>/100 — click for dossier</div>`);
  hoverPopup("fiber", (p) => `
    <div class="pp-t">${esc(p.name)}</div>
    <div class="pp-r">${esc(p.org)} · ${esc(p.city)}</div>
    <div class="pp-r"><b>${p.net_count}</b> networks · <b>${p.carrier_count}</b> carriers · <b>${p.ix_count}</b> IXs</div>`);
  hoverPopup("queue", (p) => `
    <div class="pp-t">${esc(p.name)}</div>
    ${p.new ? `<div class="pp-r" style="color:#2fbf8a"><b>NEW</b> in latest GIS report</div>` : ""}
    <div class="pp-r"><b>${fmt(Math.round(p.mw))} MW ${esc(p.cat)}</b> · ${esc(p.zone)} zone</div>
    <div class="pp-r">COD ${esc(p.cod || "TBD")} · ${esc(p.county)} Co. (county-level position)</div>
    <div class="pp-r">POI: ${esc(p.poi || "—")}</div>
    <div class="pp-r">${esc(p.phase)}</div>`);
  hoverPopup("plants", (p) => `
    <div class="pp-t">${esc(p.name)}</div>
    <div class="pp-r"><b>${fmt(p.mw)} MW</b> · ${esc(p.fuel)}</div>
    <div class="pp-r">${esc(p.tech || "")}</div>`);
  hoverPopup("pipelines", (p) => `
    <div class="pp-t">${esc(p.op || "Gas pipeline")}</div>
    <div class="pp-r">${esc(p.t || "")} natural gas transmission</div>`);
  hoverPopup("counties-fill", (p) => `
    <div class="pp-t">${esc(p.name)} ${p.st === "LA" ? "Parish" : "County"}, ${esc(p.st)}</div>
    <div class="pp-r">Queue: <b>${fmtMW(p.queue_mw)}</b> across ${p.queue_n} projects</div>
    <div class="pp-r">☀ ${fmt(p.queue_solar)} · 🔋 batt ${fmt(p.queue_battery)} · 🔥 gas ${fmt(p.queue_gas)} · 🌀 ${fmt(p.queue_wind)} MW</div>
    <div class="pp-r">HV subs (≥138kV): <b>${p.hv_subs}</b> · Installed gen: <b>${fmtMW(p.plants_mw)}</b></div>`);

  map.on("click", "subs", (e) => {
    const p = e.features[0].properties;
    openSubDrawer(p, e.lngLat);
  });
}

/* ---------------- listing markers ---------------- */
function buildMarkers() {
  if (!map) return;
  const feats = state.data.listings.features;
  feats.sort((a, b) => (a.properties.kind === "listing" ? 1 : 0) - (b.properties.kind === "listing" ? 1 : 0));
  for (const f of feats) {
    const p = f.properties;
    const el = document.createElement("div");
    el.className = "mk" + (p.kind === "signal" ? " signal" : "") + (p.kind === "industrial" ? " industrial" : "") + (p.is_new ? " new" : "");
    el.innerHTML = `<div class="pin"></div>`;
    el.addEventListener("click", (ev) => { ev.stopPropagation(); selectSite(p.id, true); });
    el.addEventListener("mouseenter", () => {
      popup.setLngLat(f.geometry.coordinates)
        .setHTML(`<div class="pp-t">${esc(p.name)}</div>
          ${p.is_new ? `<div class="pp-r" style="color:#2fbf8a"><b>NEW</b> · added ${esc(p.added)}</div>` : ""}
          <div class="pp-r">${p.kind === "listing" ? "FOR SALE" : p.kind === "industrial" ? "DEAD INDUSTRY / IDLE ASSET" : "MARKET SIGNAL"} · score <b>${p.score}</b>/100</div>
          <div class="pp-r">${p.acres ? "<b>" + fmt(p.acres) + "</b> acres · " : ""}${p.power_mw ? "<b>" + fmtMW(p.power_mw) + "</b> · " : ""}${esc(p.county)} Co.</div>`)
        .addTo(map);
    });
    el.addEventListener("mouseleave", () => popup.remove());
    const mk = new maplibregl.Marker({ element: el, anchor: "center" })
      .setLngLat(f.geometry.coordinates).addTo(map);
    state.markers.push({ mk, el, p, f });
  }
}

/* ---------------- left panel ---------------- */
function statTiles() {
  const s = state.data.summary;
  document.getElementById("stats").innerHTML = [
    [Math.round(s.queue_mw / 1000) + "<small> GW</small>", "ERCOT queue"],
    [s.listings_total, "Sites for sale"],
    [fmt(s.listed_acres) + "<small> ac</small>", "Listed acreage"],
    [s.subs_345, "345 kV subs"],
    [fmt(s.subs_138), "138–230 kV subs"],
    [s.fiber_facilities, "Colo facilities"],
  ].map(([v, k]) => `<div class="tile"><div class="v">${v}</div><div class="k">${k}</div></div>`).join("");
}

function siteCard(p, sel) {
  const chips = [];
  if (p.is_new) chips.push(`<span class="chip newchip">NEW</span>`);
  if (p.kind === "listing") chips.push(`<span class="chip gold">FOR SALE</span>`);
  else if (p.kind === "industrial") chips.push(`<span class="chip steel">DEAD INDUSTRY</span>`);
  else chips.push(`<span class="chip violet">SIGNAL</span>`);
  if (p.state && p.state !== "TX") chips.push(`<span class="chip">${esc(p.state)}</span>`);
  if (p.acres) chips.push(`<span class="chip">${fmt(p.acres)} ac</span>`);
  if (p.power_mw) chips.push(`<span class="chip">${fmtMW(p.power_mw)}</span>`);
  if (p.nearest_sub_kv) chips.push(`<span class="chip">${p.nearest_sub_kv}kV @ ${p.nearest_sub_mi}mi</span>`);
  if (p.d345_mi != null && p.d345_mi <= 25) chips.push(`<span class="chip">345kV line ${p.d345_mi}mi</span>`);
  if (p.gas_mi != null && p.gas_mi <= 15) chips.push(`<span class="chip">gas ${p.gas_mi}mi</span>`);
  return `<div class="card ${sel ? "sel" : ""}" data-id="${p.id}">
    <div class="r1"><div class="nm">${esc(p.name)}</div><div class="sc">${p.score}</div></div>
    <div class="r2">${chips.join("")}</div></div>`;
}

function subCard(p) {
  return `<div class="card" data-sub="${p.name}|${p._lon}|${p._lat}">
    <div class="r1"><div class="nm">${esc(p.name || "Unnamed substation")} <span style="color:var(--ink-3)">· ${esc((p.county || "").replace(/\b\w/g, c => c.toUpperCase()))} Co.</span></div><div class="sc sub-sc">${p.score}</div></div>
    <div class="r2">
      <span class="chip">${p.kv} kV</span><span class="chip">${p.lines} lines</span>
      <span class="chip">${esc(p.est_mw)}</span><span class="chip">colo ${p.fiber_mi} mi</span>
    </div></div>`;
}

function renderList() {
  const q = state.search.toLowerCase();
  const el = document.getElementById("list");
  const feats = state.data.listings.features
    .map((f) => f.properties)
    .filter((p) => p.score >= state.minScore)
    .filter((p) => state.kindFilter === "all" || p.kind === state.kindFilter)
    .filter((p) => !q || (p.name + " " + p.county + " " + (p.city || "")).toLowerCase().includes(q))
    .sort((a, b) => b.score - a.score);

  const subs = state.data.substations.features
    .map((f) => { const p = { ...f.properties }; p._lon = f.geometry.coordinates[0]; p._lat = f.geometry.coordinates[1]; return p; })
    .filter((p) => (p.kv || 0) >= Math.max(state.minKV, 138) && p.score >= 55)
    .filter((p) => !q || (p.name + " " + p.county).toLowerCase().includes(q))
    .sort((a, b) => b.score - a.score).slice(0, 30);

  const fresh = feats.filter((p) => p.is_new);
  const rest = feats.filter((p) => !p.is_new);
  el.innerHTML =
    (fresh.length ? `<div class="section-h new-h">Newly added · ${fresh.length}</div>` +
      fresh.map((p) => siteCard(p, state.selected === p.id)).join("") : "") +
    `<div class="section-h">Marketed sites &amp; signals · ${rest.length}</div>` +
    rest.map((p) => siteCard(p, state.selected === p.id)).join("") +
    `<div class="section-h">Top substation opportunities · grid-derived</div>` +
    subs.map(subCard).join("");

  el.querySelectorAll(".card[data-id]").forEach((c) =>
    c.addEventListener("click", () => selectSite(c.dataset.id, true)));
  el.querySelectorAll(".card[data-sub]").forEach((c) =>
    c.addEventListener("click", () => {
      const [name, lon, lat] = c.dataset.sub.split("|");
      const f = state.data.substations.features.find((f) =>
        f.properties.name === name && Math.abs(f.geometry.coordinates[0] - lon) < 1e-6);
      if (f && map) {
        map.flyTo({ center: f.geometry.coordinates, zoom: 12, duration: 1400 });
        openSubDrawer(f.properties, { lng: +lon, lat: +lat });
      }
    }));

  // dim markers not passing filter
  const visible = new Set(feats.map((p) => p.id));
  state.markers.forEach(({ el, p }) => el.classList.toggle("dim", !visible.has(p.id)));
}

/* ---------------- analytics tab ---------------- */
function barChart(rows, { unit = "MW", click = null } = {}) {
  const max = Math.max(...rows.map((r) => r[1]));
  return rows.map(([label, v, extra]) => `
    <div class="bar-row ${click ? "click" : ""}" ${click ? `data-k="${esc(label)}"` : ""}>
      <div class="bl" title="${esc(label)}">${esc(label)}</div>
      <div><div class="bt" style="width:${Math.max(1.5, v / max * 100)}%"></div></div>
      <div class="bv">${v >= 10000 ? (v / 1000).toFixed(0) + " GW" : fmt(Math.round(v)) + (unit ? " " + unit : "")}</div>
    </div>`).join("");
}

function renderAnalytics() {
  const s = state.data.summary;
  const el = document.getElementById("analytics");
  const cats = Object.entries(s.queue_by_cat).sort((a, b) => b[1] - a[1]).filter(([, v]) => v > 500);
  const counties = s.top_counties.slice(0, 12);

  el.innerHTML = `
    <h3>ERCOT interconnection queue · ${s.gis_report.replace("GIS_Report_", "")}</h3>
    ${barChart(cats.map(([k, v]) => [k, v]))}
    <div class="note">${fmt(s.queue_projects)} active projects totaling <b style="color:var(--ink)">${fmtMW(s.queue_mw)}</b>; ${fmtMW(s.queue_near_term_mw)} with COD ≤ 2027. Generation queue signals where grid capacity and land deals are being made.</div>

    <h3>Top counties by queued capacity <span style="letter-spacing:0;text-transform:none">(click to zoom)</span></h3>
    ${barChart(counties.map((c) => [c.name, c.queue_mw]), { click: true })}

    <details class="tbl"><summary>Data table</summary><table>
      <tr><th>County</th><th>Queue MW</th><th>Solar</th><th>Battery</th><th>Gas</th><th>Wind</th><th>HV subs</th></tr>
      ${counties.map((c) => `<tr><td>${esc(c.name)}</td><td>${fmt(c.queue_mw)}</td><td>${fmt(c.queue_solar)}</td><td>${fmt(c.queue_battery)}</td><td>${fmt(c.queue_gas)}</td><td>${fmt(c.queue_wind)}</td><td>${c.hv_subs}</td></tr>`).join("")}
    </table></details>

    <h3>Grid snapshot</h3>
    <div class="note" style="margin-top:0">
      <b style="color:var(--ink)">${fmt(s.lines_mi_345)}</b> mi of 345kV+ transmission ·
      <b style="color:var(--ink)">${s.subs_345}</b> substations at 345kV ·
      <b style="color:var(--ink)">${fmt(s.subs_138)}</b> at 138–230kV ·
      <b style="color:var(--ink)">${fmtMW(s.plants_mw)}</b> installed generation ·
      <b style="color:var(--ink)">${s.fiber_facilities}</b> carrier hotels / colos across ${s.ix_total} IXs.
    </div>
    <div class="note">Sources: HIFLD Open (lines, substations 2025-01 snapshot), EIA-860 (plants), ERCOT GIS Report (queue), PeeringDB (fiber). Listings compiled from public broker pages &amp; press (Jul 2026). Generated ${s.generated}.</div>`;

  el.querySelectorAll(".bar-row.click").forEach((r) =>
    r.addEventListener("click", () => {
      const county = state.data.counties.features.find((f) => f.properties.name === r.dataset.k);
      if (county && map) {
        const c = countyBounds(county);
        map.fitBounds(c, { padding: 80, duration: 1400 });
      }
    }));
}

function countyBounds(f) {
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  const scan = (ring) => ring.forEach(([x, y]) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  });
  const g = f.geometry;
  if (g.type === "Polygon") g.coordinates.forEach(scan);
  else g.coordinates.forEach((p) => p.forEach(scan));
  return [[minX, minY], [maxX, maxY]];
}

/* ---------------- drawer ---------------- */
function ring(score, color) {
  const r = 26, c = 2 * Math.PI * r;
  return `<div class="score-ring"><svg width="64" height="64" viewBox="0 0 64 64">
    <circle cx="32" cy="32" r="${r}" fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="5"/>
    <circle cx="32" cy="32" r="${r}" fill="none" stroke="${color}" stroke-width="5"
      stroke-linecap="round" stroke-dasharray="${c * score / 100} ${c}"/>
  </svg><div class="val">${score}</div></div>`;
}

function scoreBars(rows) {
  return `<div class="score-bars">` + rows.map(([l, v]) => `
    <div class="sb-row"><div class="l">${l}</div>
      <div class="t"><i style="width:${v}%"></i></div>
      <div class="n">${v}</div></div>`).join("") + `</div>`;
}

function proxRow(sw, label, val) {
  return `<div class="pr"><div class="pl"><span class="sw" style="background:${sw}"></span>${label}</div><div class="pv">${val}</div></div>`;
}

function openSiteDrawer(p) {
  const isListing = p.kind === "listing";
  const head = document.getElementById("drawer-head");
  const kindLabel = isListing ? "For sale · powered land" : p.kind === "industrial" ? "Dead industry · idle powered asset" : "Market signal";
  head.querySelector(".kind").textContent = (p.is_new ? "NEW · " : "") + kindLabel;
  head.querySelector(".kind").style.color = p.is_new ? "var(--teal-bright)" : (isListing ? "var(--gold-bright)" : p.kind === "industrial" ? "#aebccd" : "#b9aef0");
  head.querySelector("h2").textContent = p.name;
  head.querySelector(".loc").textContent = `${p.city || ""} · ${p.county} County · location ${p.precision}-level` + (p.is_new ? ` · added ${p.added}` : "");

  document.getElementById("drawer-body").innerHTML = `
    <div class="score-hero">
      ${ring(p.score, isListing ? "var(--gold-bright)" : "#b9aef0")}
      ${scoreBars([["Power", p.score_power], ["Fiber", p.score_fiber], ["Scale", p.score_scale], ["Momentum", p.score_momentum]])}
    </div>
    <div class="kv">
      <div><div class="k">Acreage</div><div class="v">${p.acres ? fmt(p.acres) + " ac" : "—"}</div></div>
      <div><div class="k">Stated power</div><div class="v">${p.power_mw ? fmtMW(p.power_mw) : "See notes"}</div></div>
      <div><div class="k">Price</div><div class="v" style="font-size:11.5px">${esc(p.price || "—")}</div></div>
      <div><div class="k">Status</div><div class="v" style="font-size:11.5px">${esc(p.status || "—")}</div></div>
    </div>
    ${p.power_notes ? `<div class="dsec"><h4>Power</h4><p>${esc(p.power_notes)}</p></div>` : ""}
    ${p.fiber_notes ? `<div class="dsec"><h4>Fiber</h4><p>${esc(p.fiber_notes)}</p></div>` : ""}
    <div class="dsec"><h4>Computed proximity (from public grid data)</h4>
      <div class="prox">
        ${proxRow("var(--blue)", `Nearest HV substation ${p.nearest_sub ? "· " + esc(p.nearest_sub) : ""}`, p.nearest_sub_kv ? `${p.nearest_sub_kv} kV · ${p.nearest_sub_mi} mi` : "—")}
        ${proxRow(C.line345, "Nearest 345 kV line", p.d345_mi != null ? p.d345_mi + " mi" : "—")}
        ${proxRow(C.line138, "Nearest 100 kV+ line", p.dline_mi != null ? p.dline_mi + " mi" : "—")}
        ${proxRow("#e9722e", `Nearest gas pipeline ${p.gas_op ? "· " + esc(p.gas_op) : ""}`, p.gas_mi != null ? p.gas_mi + " mi" : "—")}
        ${proxRow("var(--teal-bright)", `Nearest colo ${p.fiber_fac ? "· " + esc(p.fiber_fac) : ""}`, p.fiber_mi != null ? `${p.fiber_mi} mi · ${p.fiber_nets} nets` : "—")}
        ${proxRow("var(--orange-bright)", `Nearest 100 MW+ plant ${p.plant100 ? "· " + esc(p.plant100) : ""}`, p.plant100_mi != null ? `${fmt(p.plant100_mw)} MW · ${p.plant100_mi} mi` : "—")}
        ${proxRow("var(--magenta)", "County ERCOT queue", fmtMW(p.county_queue_mw))}
      </div></div>
    ${p.broker ? `<div class="dsec"><h4>Broker / contact</h4><p>${esc(p.broker)}</p></div>` : ""}
    <a class="src-btn" href="${esc(p.source)}" target="_blank" rel="noopener">View source listing ↗</a>`;

  document.getElementById("drawer").classList.add("open");
}

function openSubDrawer(p, lngLat) {
  const head = document.getElementById("drawer-head");
  head.querySelector(".kind").textContent = "Grid-derived opportunity · substation";
  head.querySelector(".kind").style.color = "var(--blue)";
  head.querySelector("h2").textContent = p.name || "Unnamed substation";
  head.querySelector(".loc").textContent = `${(p.county || "").replace(/\b\w/g, (c) => c.toUpperCase())} County · ${p.status}`;

  document.getElementById("drawer-body").innerHTML = `
    <div class="score-hero">
      ${ring(p.score, "var(--blue)")}
      <div style="flex:1">
        <div style="font-size:12px;color:var(--ink-2);line-height:1.5">Composite of voltage class, line count, fiber proximity, nearby generation, and county queue activity. Land near this node is a candidate for powered-land assembly.</div>
      </div>
    </div>
    <div class="kv">
      <div><div class="k">Voltage</div><div class="v">${p.kv ? p.kv + " kV" : "Unknown"}${p.min_kv && p.min_kv !== p.kv ? ` <small>/ ${p.min_kv} kV</small>` : ""}</div></div>
      <div><div class="k">Transmission lines</div><div class="v">${p.lines}</div></div>
      <div><div class="k">Est. deliverable</div><div class="v">${esc(p.est_mw)}</div></div>
      <div><div class="k">Opportunity score</div><div class="v">${p.score}/100</div></div>
    </div>
    <div class="dsec"><h4>Context</h4>
      <div class="prox">
        ${proxRow("var(--teal-bright)", "Nearest colo facility", p.fiber_mi + " mi")}
        ${proxRow("var(--orange-bright)", "Generation within 10 mi", fmt(p.near_plant_mw) + " MW")}
        ${proxRow("var(--magenta)", "County ERCOT queue", fmtMW(p.county_queue_mw))}
      </div></div>
    <div class="dsec"><h4>Diligence path</h4>
      <p>1) Confirm capacity headroom with the TSP (Oncor/AEP/CenterPoint/LCRA per territory). 2) Identify parcel owners via the county appraisal district (CAD) GIS. 3) Screen for water, floodplain, and ETJ. 4) File an ERCOT screening study for loads ≥ 25 MW (LLI process).</p></div>
    <div class="note">Source: HIFLD substations snapshot (Jan 2025) — verify against TSP data before underwriting.</div>`;

  document.getElementById("drawer").classList.add("open");
  if (lngLat && map) map.flyTo({ center: [lngLat.lng, lngLat.lat], zoom: Math.max(map.getZoom(), 10), duration: 900 });
}

function selectSite(id, fly) {
  state.selected = id;
  const m = state.markers.find((m) => m.p.id === id);
  if (!m) return;
  if (fly && map) map.flyTo({ center: m.f.geometry.coordinates, zoom: 9.5, duration: 1500, essential: true });
  openSiteDrawer(m.p);
  renderList();
}

/* ---------------- controls ---------------- */
function initControls() {
  document.getElementById("drawer-close").addEventListener("click", () => {
    document.getElementById("drawer").classList.remove("open");
    state.selected = null; renderList();
  });

  // tabs
  const tabs = { sites: document.getElementById("list"), analytics: document.getElementById("analytics") };
  document.querySelectorAll("#tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
      const t = b.dataset.tab;
      tabs.sites.style.display = t === "sites" ? "block" : "none";
      document.getElementById("filters").classList.toggle("show", t === "sites");
      tabs.analytics.classList.toggle("show", t === "analytics");
    }));

  document.getElementById("search").addEventListener("input", (e) => {
    state.search = e.target.value; renderList();
  });
  const ms = document.getElementById("min-score");
  ms.addEventListener("input", () => {
    state.minScore = +ms.value;
    document.getElementById("min-score-out").value = ms.value;
    renderList();
  });
  document.querySelectorAll("#kind-seg button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#kind-seg button").forEach((x) => x.classList.toggle("on", x === b));
      state.kindFilter = b.dataset.kind; renderList();
    }));
  document.querySelectorAll("#heat-seg button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#heat-seg button").forEach((x) => x.classList.toggle("on", x === b));
      state.heatMetric = b.dataset.heat;
      if (map && map.getLayer("counties-fill"))
        map.setPaintProperty("counties-fill", "fill-color", HEAT_EXPR[state.heatMetric]);
    }));

  const mkv = document.getElementById("min-kv");
  mkv.addEventListener("input", () => {
    const kvs = [69, 115, 138, 230, 345];
    state.minKV = kvs[+mkv.value];
    document.getElementById("min-kv-out").value = state.minKV + " kV";
    if (map) map.setFilter("subs", [">=", ["coalesce", ["get", "kv"], 0], state.minKV]);
    renderList();
  });

  // layer chips
  const layerMap = {
    counties: ["counties-fill", "counties-line"], lines: ["lines-glow", "lines-core"],
    subs: ["subs"], fiber: ["fiber"], queue: ["queue"], plants: ["plants"],
    pipelines: ["pipelines"],
  };
  document.querySelectorAll(".lchip").forEach((chip) =>
    chip.addEventListener("click", () => {
      const key = chip.dataset.layer;
      state.layers[key] = !state.layers[key];
      chip.classList.toggle("on", state.layers[key]);
      if (map) layerMap[key].forEach((id) =>
        map.setLayoutProperty(id, "visibility", state.layers[key] ? "visible" : "none"));
    }));
}

/* ---------------- live updates ---------------- */
function updateStamp() {
  const s = state.data.summary;
  const el = document.getElementById("stamp");
  if (!el || !s) return;
  const fresh = s.new_sites ? ` · ${s.new_sites} new site${s.new_sites > 1 ? "s" : ""}` : "";
  el.textContent = `Data updated ${s.generated} · ${s.gis_report ? s.gis_report.replace("GIS_Report_", "ERCOT ") : ""} · auto-refreshing${fresh}`;
}

function watchForUpdates() {
  setInterval(async () => {
    try {
      const r = await fetch(`data/summary.json?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return;
      const s = await r.json();
      if (state.data.summary && s.generated !== state.data.summary.generated) {
        location.reload();
      }
    } catch { /* offline blip — retry next tick */ }
  }, 5 * 60 * 1000);
}

/* ---------------- intro ---------------- */
function initIntro() {
  const el = document.getElementById("intro");
  const show = () => el.classList.add("show");
  const hide = () => { el.classList.remove("show"); try { localStorage.setItem("steradian_intro_seen", "1"); } catch {} };
  document.getElementById("intro-close").addEventListener("click", hide);
  el.addEventListener("click", (e) => { if (e.target === el) hide(); });
  document.getElementById("help-btn").addEventListener("click", show);
  let seen = null;
  try { seen = localStorage.getItem("steradian_intro_seen"); } catch {}
  if (!seen) show();
}

/* ---------------- boot ---------------- */
(async function boot() {
  await loadData();
  statTiles();
  renderAnalytics();
  updateStamp();
  watchForUpdates();
  if (map) {
    await mapReady;
    addLayers();
    map.once("idle", () => { document.title = "Steradian Land Prospector"; });
  }
  renderList();
  initControls();
  initIntro();
})();
