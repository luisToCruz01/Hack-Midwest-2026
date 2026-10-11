// Command center overview: KPIs, charts, county map and insights.
// Reads `employees`, `locations`, `getEmployeeStatus` and `setPage` from app.js
// (classic scripts share one global scope) and live alerts straight from api.weather.gov.

const SVG_NS = "http://www.w3.org/2000/svg";
const NWS_ALERTS = "https://api.weather.gov/alerts/active";
const COUNTIES_URL = "https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json";
const STATE_FIPS = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09", DE: "10", DC: "11", FL: "12",
  GA: "13", HI: "15", ID: "16", IL: "17", IN: "18", IA: "19", KS: "20", KY: "21", LA: "22", ME: "23",
  MD: "24", MA: "25", MI: "26", MN: "27", MS: "28", MO: "29", MT: "30", NE: "31", NV: "32", NH: "33",
  NJ: "34", NM: "35", NY: "36", NC: "37", ND: "38", OH: "39", OK: "40", OR: "41", PA: "42", RI: "44",
  SC: "45", SD: "46", TN: "47", TX: "48", UT: "49", VT: "50", VA: "51", WA: "53", WV: "54", WI: "55", WY: "56",
};
// Service centers whose name is a town, not a county.
const CENTER_COUNTY_OVERRIDES = { "Valentine USDA Service Center (NE)": "Cherry" };
const SEVERITY_RANK = { Unknown: 0, Minor: 1, Moderate: 2, Severe: 3, Extreme: 4 };
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const C = { violet: "#8b7cf6", violetDeep: "#5b4bd6", orange: "#e8915a", ink: "#e9e7f5", muted: "#8d8aa6", line: "rgb(255 255 255 / 9%)" };

const cc = {
  alerts: [],
  alertsLoaded: false,
  alertsError: "",
  alertsCheckedAt: null,
  topo: null,
  mapMode: "county",
  insightIndex: 0,
  search: "",
};

// ---------- helpers ----------

function svgEl(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (parent) parent.append(node);
  return node;
}

function svgText(parent, x, y, text, attrs = {}) {
  const node = svgEl("text", { x, y, ...attrs }, parent);
  node.textContent = text;
  return node;
}

function fmt(n) {
  return Number(n).toLocaleString("en-US");
}

function minutesOf(time) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function normalizeCounty(name) {
  return name.toLowerCase().replace(/\bsaint\b/g, "st").replace(/[^a-z]/g, "");
}

function rosterReady() {
  return typeof employees !== "undefined" && employees.length > 0;
}

// Parse "Adair County USDA Service Center (MO)" into its county and state.
function centerInfo(location) {
  const state = (location.name.match(/\((\w\w)\)\s*$/) || [])[1] || "";
  const county = CENTER_COUNTY_OVERRIDES[location.name]
    || (location.name.match(/^(.+?) County\b/) || [])[1]
    || "";
  return { state, county };
}

function coverageStates() {
  if (typeof locations === "undefined") return [];
  return [...new Set(locations.map((location) => centerInfo(location).state).filter(Boolean))].sort();
}

// ---------- data model ----------

function buildModel() {
  const now = new Date();
  const statusOf = new Map(employees.map((employee) => [employee.id, getEmployeeStatus(employee, now)]));
  const working = [...statusOf.values()].filter((status) => status === "Working").length;

  const todayIndex = (now.getDay() + 6) % 7; // Mon = 0
  const today = DAY_NAMES[todayIndex];
  const byLocation = new Map();
  let scheduled = 0;
  for (const employee of employees) {
    const entry = byLocation.get(employee.locationId) || { total: 0, working: 0, today: 0 };
    entry.total += 1;
    if (statusOf.get(employee.id) === "Working") entry.working += 1;
    if (employee.schedule.days.includes(today)) {
      entry.today += 1;
      scheduled += 1;
    }
    byLocation.set(employee.locationId, entry);
  }
  return { now, statusOf, working, scheduled, byLocation, today, todayIndex };
}

// Which counties (5-digit FIPS) are under an active alert, with the worst one per county.
function alertCounties() {
  const counties = new Map();
  for (const alert of cc.alerts) {
    for (const same of alert.geocode?.SAME || []) {
      const fips = same.slice(1);
      const current = counties.get(fips);
      if (!current || SEVERITY_RANK[alert.severity] > SEVERITY_RANK[current.severity]) counties.set(fips, alert);
    }
  }
  return counties;
}

function centersByCounty() {
  const map = new Map();
  if (typeof locations === "undefined" || !cc.topo) return map;
  for (const location of locations) {
    const { state, county } = centerInfo(location);
    const fips = cc.topo.countyIndex.get(`${STATE_FIPS[state]}|${normalizeCounty(county)}`);
    if (!fips) continue;
    if (!map.has(fips)) map.set(fips, []);
    map.get(fips).push(location);
  }
  return map;
}

// ---------- KPIs ----------

function renderKpis(model) {
  const total = employees.length;
  const pct = total ? Math.round((model.working / total) * 100) : 0;
  document.querySelector("#cc-onshift-pct").textContent = `${pct}%`;
  document.querySelector("#cc-onshift-note").textContent = `${fmt(model.working)} of ${fmt(total)} working right now`;
  document.querySelector("#employee-count").textContent = fmt(total);
  document.querySelector("#cc-donut-badge").textContent = `${total ? Math.round((model.scheduled / total) * 100) : 0}%`;

  const avg = locations.length ? Math.round((model.scheduled / locations.length) * 10) / 10 : 0;
  document.querySelector("#cc-avg-onshift").textContent = `${avg}`;
}

function renderAlertKpi() {
  const value = document.querySelector("#cc-alert-count");
  const note = document.querySelector("#cc-alert-note");
  if (!cc.alertsLoaded) {
    value.textContent = "–";
    note.textContent = cc.alertsError || "Checking the National Weather Service…";
    return;
  }
  value.textContent = fmt(cc.alerts.length);
  const affected = affectedCenters();
  const people = affected.reduce((sum, location) => sum + (employees.filter((e) => e.locationId === location.id).length), 0);
  note.textContent = cc.alerts.length
    ? `${affected.length} center${affected.length === 1 ? "" : "s"} · ${fmt(people)} employees in alert areas`
    : `None in ${coverageStates().join(", ") || "the coverage area"}`;
}

function affectedCenters() {
  const counties = alertCounties();
  const centers = centersByCounty();
  const affected = [];
  for (const [fips, list] of centers) if (counties.has(fips)) affected.push(...list);
  return affected;
}

// ---------- charts ----------

// Two half-discs whose areas are proportional to who works today and who is off today.
function renderDonut(model) {
  const svg = document.querySelector("#cc-donut");
  svg.replaceChildren();
  const total = employees.length || 1;
  const off = total - model.scheduled;
  const cx = 180, cy = 120, maxR = 92;
  const rOn = Math.max(14, maxR * Math.sqrt(model.scheduled / total));
  const rOff = Math.max(14, maxR * Math.sqrt(off / total));

  for (const r of [maxR + 14, maxR - 4, maxR * 0.62]) {
    svgEl("circle", { cx, cy, r, fill: "none", stroke: C.line }, svg);
  }
  const half = (r, side) => `M${cx},${cy - r} A${r},${r} 0 0 ${side === "right" ? 1 : 0} ${cx},${cy + r} Z`;
  svgEl("path", { d: half(rOff, "left"), fill: C.orange }, svg);
  svgEl("path", { d: half(rOn, "right"), fill: "#a99cf8" }, svg);
  svgEl("line", { x1: cx, y1: cy - maxR - 16, x2: cx, y2: cy + maxR + 16, stroke: "rgb(255 255 255 / 55%)", "stroke-width": 1.2 }, svg);
  svgEl("circle", { cx, cy: cy - maxR - 16, r: 3, fill: C.ink }, svg);
  svgEl("circle", { cx, cy: cy + maxR + 16, r: 3, fill: C.ink }, svg);

  svgText(svg, 42, cy - 4, "Off today", { class: "cc-svg-label", "text-anchor": "middle" });
  svgText(svg, 42, cy + 16, fmt(off), { class: "cc-svg-value", "text-anchor": "middle" });
  svgText(svg, 318, cy - 4, "Works today", { class: "cc-svg-label", "text-anchor": "middle" });
  svgText(svg, 318, cy + 16, fmt(model.scheduled), { class: "cc-svg-value", "text-anchor": "middle" });
  svgText(svg, 318, cy + 34, `${fmt(model.working)} on shift now`, { class: "cc-svg-axis", "text-anchor": "middle" });
}

// Scheduled headcount per weekday, split by shifts that start before / from 8:00.
function renderRadar() {
  const svg = document.querySelector("#cc-radar");
  svg.replaceChildren();
  const early = DAY_NAMES.map(() => 0);
  const late = DAY_NAMES.map(() => 0);
  for (const employee of employees) {
    const isEarly = minutesOf(employee.schedule.startTime) < 8 * 60;
    for (const day of employee.schedule.days) {
      const i = DAY_NAMES.indexOf(day);
      if (i >= 0) (isEarly ? early : late)[i] += 1;
    }
  }
  const max = Math.max(...early, ...late, 1);
  const cx = 150, cy = 130, R = 96, n = DAY_NAMES.length;
  const point = (i, value) => {
    const angle = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const r = (value / max) * R;
    return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
  };

  for (let ring = 1; ring <= 5; ring++) {
    const pts = DAY_NAMES.map((_, i) => point(i, (max * ring) / 5).join(",")).join(" ");
    svgEl("polygon", { points: pts, fill: "none", stroke: C.line }, svg);
  }
  DAY_NAMES.forEach((day, i) => {
    const [x, y] = point(i, max);
    svgEl("line", { x1: cx, y1: cy, x2: x, y2: y, stroke: C.line }, svg);
    const [lx, ly] = point(i, max * 1.17);
    svgText(svg, lx, ly + 4, day, { class: "cc-svg-axis", "text-anchor": "middle" });
  });

  for (const [values, color] of [[late, C.orange], [early, C.violet]]) {
    const pts = values.map((value, i) => point(i, value));
    svgEl("polygon", { points: pts.map((p) => p.join(",")).join(" "), fill: color, "fill-opacity": 0.16, stroke: color, "stroke-width": 2, "stroke-linejoin": "round" }, svg);
    for (const [x, y] of pts) svgEl("circle", { cx: x, cy: y, r: 3.2, fill: "#14131f", stroke: color, "stroke-width": 1.6 }, svg);
  }

  const legend = [[C.violet, "Start before 8 AM", early], [C.orange, "Start 8 AM or later", late]];
  legend.forEach(([color, label, values], i) => {
    const y = 100 + i * 46;
    svgEl("circle", { cx: 290, cy: y - 4, r: 5, fill: color }, svg);
    svgText(svg, 302, y, label, { class: "cc-svg-label" });
    svgText(svg, 302, y + 17, `peak ${fmt(Math.max(...values))}`, { class: "cc-svg-axis" });
  });
}

// Rows: work-day patterns. Columns: shift start times. Bubble size: headcount.
// Violet bubbles work today, orange ones are off today; the label is the headcount.
function renderBubbles(model) {
  const svg = document.querySelector("#cc-bubbles");
  svg.replaceChildren();
  const patterns = [...new Set(employees.map((e) => e.daysOfWeek))].sort();
  const starts = [...new Set(employees.map((e) => e.schedule.startTime))].sort();
  const cells = new Map();
  for (const employee of employees) {
    const key = `${employee.daysOfWeek}|${employee.schedule.startTime}`;
    const cell = cells.get(key) || { today: 0, working: 0, total: 0 };
    cell.total += 1;
    if (employee.schedule.days.includes(model.today)) cell.today += 1;
    if (model.statusOf.get(employee.id) === "Working") cell.working += 1;
    cells.set(key, cell);
  }
  const totals = [...cells.values()].map((cell) => cell.total);
  const minTotal = Math.min(...totals), maxTotal = Math.max(...totals, 1);

  const left = 130, top = 44, right = 880, bottom = 384;
  const colW = (right - left) / starts.length;
  const rowH = (bottom - top) / patterns.length;
  const maxR = Math.min(colW, rowH) / 2 - 3;

  starts.forEach((start, c) => {
    const x = left + colW * (c + 0.5);
    svgText(svg, x, 24, formatScheduleTime(start).replace(":00", ""), { class: "cc-svg-axis", "text-anchor": "middle" });
    svgEl("line", { x1: x, y1: top - 6, x2: x, y2: bottom, stroke: C.line, "stroke-dasharray": "2 4" }, svg);
  });
  patterns.forEach((pattern, r) => {
    const y = top + rowH * (r + 0.5);
    svgText(svg, 12, y + 5, pattern.replace("-", "–"), { class: "cc-svg-label" });
    svgEl("line", { x1: left, y1: y, x2: right, y2: y, stroke: C.line, "stroke-dasharray": "2 4" }, svg);
    starts.forEach((start, c) => {
      const cell = cells.get(`${pattern}|${start}`) || { today: 0, working: 0, total: 0 };
      const x = left + colW * (c + 0.5);
      if (!cell.total) {
        svgEl("circle", { cx: x, cy: y, r: 3, fill: "rgb(255 255 255 / 18%)" }, svg);
        return;
      }
      const spread = maxTotal > minTotal ? (cell.total - minTotal) / (maxTotal - minTotal) : 1;
      const radius = maxR * (0.45 + 0.55 * spread);
      const on = cell.today > 0;
      const g = svgEl("g", { class: "cc-bubble" }, svg);
      svgEl("title", {}, g).textContent = `${pattern}, starts ${formatScheduleTime(start)}: ${cell.total} employees, ${on ? "work today" : "off today"}, ${cell.working} on shift now`;
      svgEl("circle", {
        cx: x, cy: y, r: radius,
        fill: on ? "rgb(91 75 214 / 45%)" : "rgb(232 145 90 / 38%)",
        stroke: on ? C.violet : C.orange, "stroke-width": 1.6,
      }, g);
      if (radius > 15) svgText(g, x, y + 4, String(cell.total), { class: "cc-svg-bubble", "text-anchor": "middle" });
    });
  });
}

function renderSeverity() {
  const svg = document.querySelector("#cc-severity");
  svg.replaceChildren();
  const levels = ["Minor", "Moderate", "Severe", "Extreme"];
  const counts = levels.map((level) => cc.alerts.filter((alert) => alert.severity === level).length);
  const max = Math.max(...counts, 1);
  levels.forEach((level, i) => {
    const x = 14 + i * 58, h = counts[i] ? 6 + (counts[i] / max) * 34 : 2;
    svgEl("rect", { x, y: 44 - h, width: 34, height: h, rx: 3, fill: i >= 2 ? "#b06cf2" : "#6d6bd9", opacity: counts[i] ? 1 : 0.35 }, svg);
    svgText(svg, x + 17, 40 - h, counts[i] ? String(counts[i]) : "", { class: "cc-svg-axis", "text-anchor": "middle" });
    svgText(svg, x + 17, 62, level, { class: "cc-svg-axis", "text-anchor": "middle" });
  });
}

// ---------- map ----------

async function loadCounties() {
  if (cc.topo || !window.d3 || !window.topojson) return;
  const topology = await (await fetch(COUNTIES_URL)).json();
  const counties = window.topojson.feature(topology, topology.objects.counties).features;
  const states = window.topojson.feature(topology, topology.objects.states).features;
  const countyIndex = new Map();
  for (const county of counties) {
    countyIndex.set(`${county.id.slice(0, 2)}|${normalizeCounty(county.properties.name)}`, county.id);
  }
  cc.topo = { counties, states, countyIndex };
}

function mapExtent(width, height) {
  // Wide layout: the cards cover the left of the stage, so fit the states into the space to their right.
  if (width >= 1180) {
    const cardsRight = document.querySelector(".cc-grid").getBoundingClientRect().width;
    return [[cardsRight + 10, 40], [width - 30, height - 330]];
  }
  return [[24, 24], [width - 24, height - 24]];
}

function renderMap(model) {
  const container = document.querySelector("#cc-map");
  if (!cc.topo || !window.d3) return;
  const d3 = window.d3;
  const width = container.clientWidth, height = container.clientHeight;
  if (!width || !height) return;

  const fipsList = coverageStates().map((state) => STATE_FIPS[state]).filter(Boolean);
  const counties = cc.topo.counties.filter((county) => fipsList.includes(county.id.slice(0, 2)));
  const states = cc.topo.states.filter((state) => fipsList.includes(state.id));
  if (!counties.length) return;

  const projection = d3.geoAlbersUsa().fitExtent(mapExtent(width, height), { type: "FeatureCollection", features: states });
  const path = d3.geoPath(projection);
  const centers = centersByCounty();
  const alerts = alertCounties();
  const showStaff = document.querySelector("#cc-layer-staff").checked;
  const showAlerts = document.querySelector("#cc-layer-alerts").checked;
  const shares = [...centers.values()].map((list) => {
    const entry = list.reduce((acc, location) => {
      const e = model.byLocation.get(location.id) || { total: 0, today: 0 };
      return { total: acc.total + e.total, today: acc.today + e.today };
    }, { total: 0, today: 0 });
    return entry.total ? entry.today / entry.total : 0;
  });
  const lo = Math.min(...shares, 0), hi = Math.max(...shares, lo + 0.01);
  const staffColor = d3.scaleLinear().domain([lo, (lo + hi) / 2, hi]).range(["#1d4ed8", "#22a6d6", "#5eead4"]).clamp(true);
  const scale = document.querySelector(".cc-scale");
  scale.replaceChildren(...[0, 0.25, 0.5, 0.75, 1].map((f) => {
    const span = document.createElement("span");
    span.textContent = `${Math.round((lo + (hi - lo) * f) * 100)}%`;
    return span;
  }));
  const search = cc.search.toLowerCase();

  const share = (list) => {
    const totals = list.reduce((acc, location) => {
      const entry = model.byLocation.get(location.id) || { total: 0, today: 0 };
      return { total: acc.total + entry.total, today: acc.today + entry.today };
    }, { total: 0, today: 0 });
    return totals.total ? totals.today / totals.total : 0;
  };

  // State mode paints every county with its state's average.
  const stateShare = new Map();
  for (const fips of fipsList) {
    const list = [...centers].filter(([county]) => county.startsWith(fips)).flatMap(([, l]) => l);
    stateShare.set(fips, share(list));
  }

  const svg = d3.select(container).selectAll("svg").data([null]).join("svg")
    .attr("viewBox", `0 0 ${width} ${height}`).attr("width", width).attr("height", height);
  svg.selectAll("*").remove();

  const defs = svg.append("defs");
  const glow = defs.append("filter").attr("id", "cc-glow").attr("x", "-50%").attr("y", "-50%").attr("width", "200%").attr("height", "200%");
  glow.append("feGaussianBlur").attr("stdDeviation", 3);
  const peak = defs.append("linearGradient").attr("id", "cc-peak").attr("x1", 0).attr("x2", 0).attr("y1", 0).attr("y2", 1);
  peak.append("stop").attr("offset", "0%").attr("stop-color", "#fff").attr("stop-opacity", 0.95);
  peak.append("stop").attr("offset", "100%").attr("stop-color", "#fff").attr("stop-opacity", 0.05);
  const peakHot = defs.append("linearGradient").attr("id", "cc-peak-hot").attr("x1", 0).attr("x2", 0).attr("y1", 0).attr("y2", 1);
  peakHot.append("stop").attr("offset", "0%").attr("stop-color", C.orange).attr("stop-opacity", 1);
  peakHot.append("stop").attr("offset", "100%").attr("stop-color", C.orange).attr("stop-opacity", 0.08);

  const fillFor = (county) => {
    const alert = alerts.get(county.id);
    if (showAlerts && alert) return SEVERITY_RANK[alert.severity] >= 3 ? "#9d4edd" : "#6d4fd8";
    if (!showStaff) return "#1b2340";
    if (cc.mapMode === "state") return staffColor(stateShare.get(county.id.slice(0, 2)) || 0);
    const list = centers.get(county.id);
    return list ? staffColor(share(list)) : "#1f3a75";
  };

  const tooltip = document.querySelector("#cc-tooltip");
  svg.append("g").selectAll("path").data(counties).join("path")
    .attr("d", path)
    .attr("class", "cc-county")
    .attr("fill", fillFor)
    .attr("stroke", (county) => {
      const list = centers.get(county.id);
      return search && list?.some((location) => location.name.toLowerCase().includes(search)) ? "#fff" : "rgb(10 12 30 / 55%)";
    })
    .attr("stroke-width", (county) => {
      const list = centers.get(county.id);
      return search && list?.some((location) => location.name.toLowerCase().includes(search)) ? 2.2 : 0.6;
    })
    .on("mousemove", (event, county) => {
      const list = centers.get(county.id) || [];
      const alert = alerts.get(county.id);
      const lines = [`<strong>${county.properties.name} County</strong>`];
      for (const location of list) {
        const entry = model.byLocation.get(location.id) || { total: 0, working: 0, today: 0 };
        lines.push(`${location.name.replace(/ USDA Service Center/, "")}: ${entry.today}/${entry.total} work today, ${entry.working} on shift`);
      }
      if (!list.length) lines.push("No service center");
      if (alert) lines.push(`<em>${alert.event} · ${alert.severity}</em>`);
      tooltip.innerHTML = lines.join("<br>");
      tooltip.hidden = false;
      const box = container.getBoundingClientRect();
      tooltip.style.left = `${event.clientX - box.left + 14}px`;
      tooltip.style.top = `${event.clientY - box.top + 14}px`;
    })
    .on("mouseleave", () => (tooltip.hidden = true));

  svg.append("g").selectAll("path").data(states).join("path")
    .attr("d", path).attr("fill", "none").attr("stroke", "rgb(255 255 255 / 55%)").attr("stroke-width", 1.1)
    .attr("pointer-events", "none");

  // Peaks: one per service center, height = employees who work today.
  if (showStaff) {
    const peaks = [];
    for (const [fips, list] of centers) {
      const county = counties.find((c) => c.id === fips);
      if (!county) continue;
      const [x, y] = path.centroid(county);
      if (!Number.isFinite(x)) continue;
      const today = list.reduce((sum, location) => sum + (model.byLocation.get(location.id)?.today || 0), 0);
      peaks.push({ x, y, h: 3 + today * 0.7, hot: showAlerts && alerts.has(fips) });
    }
    peaks.sort((a, b) => a.y - b.y);
    svg.append("g").attr("pointer-events", "none").selectAll("path").data(peaks).join("path")
      .attr("d", (p) => `M${p.x - 3},${p.y} L${p.x},${p.y - p.h} L${p.x + 3},${p.y} Z`)
      .attr("fill", (p) => (p.hot ? "url(#cc-peak-hot)" : "url(#cc-peak)"));
  }
}

// ---------- insights ----------

function buildInsights(model) {
  const insights = [];
  const affected = affectedCenters();

  if (cc.alertsLoaded && cc.alerts.length) {
    const worst = [...cc.alerts].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])[0];
    const people = employees.filter((e) => affected.some((location) => location.id === e.locationId));
    const onShift = people.filter((e) => model.statusOf.get(e.id) === "Working").length;
    insights.push({
      kind: "alert",
      title: worst.event,
      tag: worst.severity,
      body: affected.length
        ? `${affected.length} service center${affected.length === 1 ? " sits" : "s sit"} inside active alert areas: ${fmt(people.length)} employees, ${fmt(onShift)} on shift right now.`
        : `Active in the coverage states, but no service center county is inside the alert area.`,
      chips: affected.slice(0, 6).map((location) => location.name.replace(/ USDA Service Center/, "")),
      action: affected.length ? { label: "Show on map", run: () => highlight(affected[0].name.replace(/ USDA Service Center.*/, "")) } : null,
    });
  } else if (cc.alertsLoaded) {
    insights.push({
      kind: "calm",
      title: "No active NWS alerts",
      tag: "Normal",
      body: `Nothing is in effect for ${coverageStates().join(", ")}. Normal operations is the expected posture for every center.`,
      chips: [],
    });
  }

  // Next wave of shift starts within the coming three hours.
  const nowMinutes = getWorkSiteClock(model.now).minutes;
  const upcoming = new Map();
  for (const employee of employees) {
    if (!employee.schedule.days.includes(model.today)) continue;
    const start = minutesOf(employee.schedule.startTime);
    if (start > nowMinutes && start <= nowMinutes + 180) {
      upcoming.set(employee.schedule.startTime, (upcoming.get(employee.schedule.startTime) || 0) + 1);
    }
  }
  const upcomingTotal = [...upcoming.values()].reduce((a, b) => a + b, 0);
  insights.push({
    kind: "wave",
    title: "Next shift wave",
    tag: upcomingTotal ? `${fmt(upcomingTotal)}` : "Quiet",
    body: upcomingTotal
      ? `${fmt(upcomingTotal)} employees start in the next three hours. They are the first people to notify if conditions change.`
      : "No shifts start in the next three hours. The next notification window opens with tomorrow's first shift.",
    bars: [...upcoming].sort().map(([time, count]) => [formatScheduleTime(time), count]),
  });

  // Busiest scheduled weekday.
  const perDay = DAY_NAMES.map((day) => employees.filter((e) => e.schedule.days.includes(day)).length);
  const peakIndex = perDay.indexOf(Math.max(...perDay));
  insights.push({
    kind: "week",
    title: "Busiest day this week",
    tag: DAY_NAMES[peakIndex],
    body: `${fmt(perDay[peakIndex])} employees are scheduled on ${DAY_NAMES[peakIndex]}. A closure that day reaches the most people.`,
    bars: DAY_NAMES.map((day, i) => [day, perDay[i]]),
    highlight: peakIndex,
  });
  return insights;
}

function renderInsights(model) {
  const insights = buildInsights(model);
  const stack = document.querySelector("#cc-insight-stack");
  const pages = document.querySelector("#cc-pager-pages");
  cc.insightIndex = Math.min(cc.insightIndex, insights.length - 1);
  const insight = insights[cc.insightIndex];
  stack.replaceChildren();
  pages.replaceChildren();
  if (!insight) return;

  const card = document.createElement("article");
  card.className = `cc-insight cc-insight-${insight.kind}`;
  const head = document.createElement("div");
  head.className = "cc-insight-head";
  const title = document.createElement("h3");
  title.textContent = insight.title;
  const tag = document.createElement("span");
  tag.className = "cc-insight-tag";
  tag.textContent = insight.tag;
  head.append(title, tag);
  const body = document.createElement("p");
  body.textContent = insight.body;
  card.append(head, body);

  if (insight.bars?.length) {
    const max = Math.max(...insight.bars.map(([, value]) => value), 1);
    const chart = document.createElement("div");
    chart.className = "cc-mini-bars";
    insight.bars.forEach(([label, value], i) => {
      const bar = document.createElement("div");
      bar.className = `cc-mini-bar${i === insight.highlight ? " is-peak" : ""}`;
      bar.innerHTML = `<span style="height:${Math.max(6, (value / max) * 100)}%"></span><small>${label}</small>`;
      bar.title = `${label}: ${fmt(value)}`;
      chart.append(bar);
    });
    card.append(chart);
  }
  if (insight.chips?.length) {
    const chips = document.createElement("div");
    chips.className = "cc-insight-chips";
    for (const label of insight.chips) {
      const chip = document.createElement("span");
      chip.textContent = label;
      chips.append(chip);
    }
    card.append(chips);
  }
  if (insight.action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cc-use";
    button.textContent = `${insight.action.label} ✓`;
    button.addEventListener("click", insight.action.run);
    card.append(button);
  }
  stack.append(card);

  insights.forEach((_, i) => {
    const page = document.createElement("button");
    page.type = "button";
    page.textContent = String(i + 1);
    page.setAttribute("aria-current", i === cc.insightIndex ? "true" : "false");
    page.addEventListener("click", () => {
      cc.insightIndex = i;
      renderInsights(buildModel());
    });
    pages.append(page);
  });
}

function renderSummaryLine() {
  const states = coverageStates();
  document.querySelector("#cc-coverage").textContent = states.length ? `${locations.length} centers · ${states.join(" · ")}` : "Loading coverage…";
  document.querySelector("#cc-summary-line").textContent = cc.alertsLoaded
    ? `${cc.alerts.length} active NWS alert${cc.alerts.length === 1 ? "" : "s"} · ${states.join(", ")}`
    : cc.alertsError || "Live NWS · loading…";
  document.querySelector("#cc-summary-time").textContent = cc.alertsCheckedAt
    ? `Checked ${new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(cc.alertsCheckedAt)}`
    : "";
}

function highlight(text) {
  const input = document.querySelector("#cc-search");
  input.value = text;
  cc.search = text;
  drawCommandCenter();
  document.querySelector("#cc-map").scrollIntoView({ behavior: "smooth", block: "center" });
}

// ---------- loading + orchestration ----------

async function loadAlerts() {
  const states = coverageStates();
  if (!states.length) return;
  try {
    const response = await fetch(`${NWS_ALERTS}?status=actual&area=${states.join(",")}`, { headers: { Accept: "application/geo+json" } });
    if (!response.ok) throw new Error(`NWS responded ${response.status}`);
    cc.alerts = (await response.json()).features.map((feature) => feature.properties);
    cc.alertsLoaded = true;
    cc.alertsError = "";
    cc.alertsCheckedAt = new Date();
  } catch (error) {
    cc.alertsError = "Could not reach the National Weather Service.";
    console.error(error);
  }
  drawCommandCenter();
}

function drawCommandCenter() {
  if (document.querySelector('[data-view="overview"]').hidden) return;
  renderSummaryLine();
  renderAlertKpi();
  renderSeverity();
  if (!rosterReady()) {
    document.querySelector("#active-employee-note").textContent ||= "Sign in as a manager to load the roster.";
    return;
  }
  const model = buildModel();
  renderKpis(model);
  renderDonut(model);
  renderRadar();
  renderBubbles(model);
  renderInsights(model);
  renderMap(model);
}

window.renderCommandCenter = () => {
  drawCommandCenter();
  if (!cc.alertsLoaded && !cc.alertsError && coverageStates().length && !cc.alertsPending) {
    cc.alertsPending = true;
    loadAlerts().finally(() => (cc.alertsPending = false));
  }
};

async function loadUser() {
  if (!sessionToken) return;
  try {
    const response = await authenticatedFetch("/api/me");
    if (!response.ok) return;
    const me = await response.json();
    document.querySelector("#user-name").textContent = me.name;
    document.querySelector("#user-id").textContent = `ID ${me.userId}${me.isManager ? " · Manager" : ""}`;
    document.querySelector("#user-avatar").textContent = initials(me.name);
  } catch (error) {
    console.error(error);
  }
}

document.querySelectorAll("[data-map-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    cc.mapMode = button.dataset.mapMode;
    document.querySelectorAll("[data-map-mode]").forEach((b) => b.setAttribute("aria-selected", String(b === button)));
    drawCommandCenter();
  });
});
document.querySelectorAll("#cc-layer-staff, #cc-layer-alerts").forEach((input) => input.addEventListener("change", drawCommandCenter));
document.querySelectorAll("[data-insight-step]").forEach((button) => {
  button.addEventListener("click", () => {
    const count = document.querySelectorAll("#cc-pager-pages button").length || 1;
    cc.insightIndex = (cc.insightIndex + Number(button.dataset.insightStep) + count) % count;
    renderInsights(buildModel());
  });
});
document.querySelector("#cc-refresh").addEventListener("click", () => {
  cc.alertsLoaded = false;
  loadAlerts();
});
document.querySelector("#cc-search").addEventListener("input", (event) => {
  cc.search = event.target.value.trim();
  const matches = cc.search && typeof locations !== "undefined"
    ? locations.filter((location) => location.name.toLowerCase().includes(cc.search.toLowerCase())).length
    : 0;
  document.querySelector("#cc-search-count").textContent = cc.search ? `${matches} match${matches === 1 ? "" : "es"}` : "";
  drawCommandCenter();
});
// Charts are skipped while another page is open; draw them when Overview comes back.
document.querySelectorAll('[data-page="overview"]').forEach((button) => button.addEventListener("click", () => requestAnimationFrame(drawCommandCenter)));
let resizeTimer;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawCommandCenter, 150);
});
setInterval(() => {
  drawCommandCenter();
}, 60_000);
setInterval(loadAlerts, 5 * 60_000);

loadUser();
loadCounties().then(drawCommandCenter).catch((error) => console.error("County map failed to load.", error));
window.renderCommandCenter();
