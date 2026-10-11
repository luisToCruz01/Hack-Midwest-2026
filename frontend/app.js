const navigationButtons = document.querySelectorAll("[data-page]");
const pageViews = document.querySelectorAll("[data-view]");
const employeeRows = document.querySelector("#employee-rows");
const employeeSearch = document.querySelector("#employee-search");
const employeeFilter = document.querySelector("#employee-filter");
const employeeLocationFilter = document.querySelector("#employee-location-filter");
const overviewLocationSelect = document.querySelector("#overview-location-select");
const alertDialog = document.querySelector("#alert-dialog");
const alertForm = document.querySelector("#alert-form");
const employeeEditDialog = document.querySelector("#employee-edit-dialog");
const employeeEditForm = document.querySelector("#employee-edit-form");
const employeeEditFeedback = document.querySelector("#employee-edit-feedback");
const employeeAddDialog = document.querySelector("#employee-add-dialog");
const employeeAddForm = document.querySelector("#employee-add-form");
const employeeAddFeedback = document.querySelector("#employee-add-feedback");
const liveLocationRows = document.querySelector("#live-location-rows");
const sessionToken = localStorage.getItem("fieldcastSessionToken") || "";
const EMPLOYEE_PAGE_SIZE = 100;
const LIVE_LOCATION_REFRESH_MS = 30_000;

let employees = [];
let locations = [];
let liveLocations = [];
let selectedLocationId = "";
let employeePage = 1;
let employeesLoading = true;
let employeeLoadError = "";
let weatherMap;
let weatherMapLayers;
let weatherRequestId = 0;
let employeeLocationsMap;
let employeeLocationsLayer;
let liveLocationRequestId = 0;

function authenticatedFetch(url, options = {}) {
  const headers = new Headers(options.headers);
  if (sessionToken) headers.set("Authorization", `Bearer ${sessionToken}`);
  return fetch(url, { ...options, headers });
}

const loginLink = document.querySelector("#login-link");
if (sessionToken) {
  loginLink.textContent = "Sign out";
  loginLink.href = "#";
  loginLink.addEventListener("click", async (event) => {
    event.preventDefault();
    try {
      const response = await authenticatedFetch("/api/logout", { method: "POST" });
      if (!response.ok) throw new Error(`Sign out failed with HTTP ${response.status}.`);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Unable to sign out.");
      return;
    }
    localStorage.removeItem("fieldcastSessionToken");
    window.location.assign("/landing/");
  });
}

let alerts = [
  { id: 1, title: "Heat advisory in effect", message: "High temperatures are expected this afternoon. Ensure crews take scheduled water breaks and monitor for signs of heat stress.", severity: "High", status: "Open", time: "Today, 9:42 AM", location: "North work area" },
  { id: 2, title: "Equipment inspection due", message: "The weekly inspection for Lift 03 is due before the next shift.", severity: "Medium", status: "Acknowledged", time: "Today, 8:15 AM", location: "Equipment yard" },
  { id: 3, title: "Severe weather watch", message: "A severe weather watch has been issued for the area. Review the site safety plan with employees.", severity: "Medium", status: "Open", time: "Yesterday, 3:30 PM", location: "All work areas" },
];

let workSite = {
  name: "USDA Forest Service",
  address: "1400 Independence Ave., SW",
  city: "Washington, D.C.",
  state: "",
  postalCode: "20250-0003",
  timezone: "America/Chicago",
  latitude: "39.1141",
  longitude: "-94.5786",
};

let nextAlertId = 4;

function escapeClassName(value) {
  return value.toLowerCase().replaceAll(" ", "-");
}

function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

function formatScheduleTime(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" })
    .format(new Date(2020, 0, 1, hours, minutes));
}

function describeSchedule(schedule) {
  if (!schedule || schedule.days.length === 0) return "No days assigned";

  return `${schedule.days.join(", ")} · ${formatScheduleTime(schedule.startTime)}–${formatScheduleTime(schedule.endTime)}`;
}

function expandDaysOfWeek(range) {
  const week = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const [start, end] = range.split("-");
  let dayIndex = week.indexOf(start);
  const endIndex = week.indexOf(end);
  if (dayIndex < 0 || endIndex < 0) throw new Error(`Invalid workday range: ${range}`);

  const days = [];
  while (true) {
    days.push(week[dayIndex]);
    if (dayIndex === endIndex) return days;
    dayIndex = (dayIndex + 1) % week.length;
  }
}

function getWeatherMap() {
  const mapElement = document.querySelector("#weather-map");
  if (!window.L) {
    throw new Error("The weather map library could not be loaded. Check your internet connection.");
  }
  if (!weatherMap) {
    weatherMap = window.L.map(mapElement, {
      boxZoom: false,
      doubleClickZoom: false,
      dragging: false,
      keyboard: false,
      scrollWheelZoom: false,
      touchZoom: false,
      zoomControl: false,
    }).setView([39.8283, -98.5795], 4);
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    }).addTo(weatherMap);
    weatherMapLayers = window.L.layerGroup().addTo(weatherMap);
  }
  return weatherMap;
}

function setWeatherStatus(message, error = false) {
  const status = document.querySelector("#weather-map-status");
  status.textContent = message;
  status.classList.toggle("weather-map-status-error", error);
}

function setWeatherFeedStatus(label, note) {
  document.querySelector("#weather-feed-status").textContent = label;
  document.querySelector("#weather-feed-note").textContent = note;
}

function addWeatherMetric(label, value, className = "") {
  const card = document.createElement("div");
  const name = document.createElement("span");
  const reading = document.createElement("strong");
  card.className = `weather-metric${className ? ` ${className}` : ""}`;
  name.textContent = label;
  reading.textContent = value;
  card.append(name, reading);
  document.querySelector("#weather-summary").append(card);
}

function compassBearing(direction) {
  const directions = {
    N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
    S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
  };
  return Object.hasOwn(directions, direction) ? directions[direction] : null;
}

function makeAlertPopup(alert) {
  const content = document.createElement("div");
  const title = document.createElement("strong");
  const headline = document.createElement("p");
  const severity = document.createElement("span");
  title.textContent = alert.event || "NWS alert";
  headline.textContent = alert.headline || "Active alert for this area.";
  severity.textContent = `Severity: ${alert.severity || "Unknown"}`;
  content.className = "weather-popup";
  content.append(title, headline, severity);
  return content;
}

function renderWeatherMap(data) {
  const map = getWeatherMap();
  const { latitude, longitude } = data.coordinates;
  const forecast = data.forecast;
  const chance = typeof forecast.probabilityOfPrecipitation === "number"
    ? forecast.probabilityOfPrecipitation
    : Number.NaN;
  const windBearing = compassBearing(forecast.windDirection);
  const layers = window.L;
  weatherMapLayers.clearLayers();

  if (windBearing !== null) {
    const markerContent = document.createElement("div");
    const windArrow = document.createElement("span");
    const rainChance = document.createElement("span");
    markerContent.className = "weather-map-marker";
    windArrow.className = "weather-map-wind-arrow";
    windArrow.textContent = "↑";
    windArrow.style.transform = `rotate(${(windBearing + 180) % 360}deg)`;
    rainChance.className = "weather-map-rain";
    rainChance.textContent = Number.isFinite(chance) ? `☂ ${chance}%` : "☂ Rain n/a";
    markerContent.append(windArrow, rainChance);
    const icon = layers.divIcon({
      className: "weather-map-marker-wrap",
      html: markerContent,
      iconSize: [110, 54],
      iconAnchor: [55, 27],
    });
    const marker = layers.marker([latitude, longitude], { icon }).addTo(weatherMapLayers);
    const popup = document.createElement("div");
    const title = document.createElement("strong");
    const conditions = document.createElement("p");
    const wind = document.createElement("p");
    const rain = document.createElement("p");
    title.textContent = data.location.name;
    conditions.textContent = forecast.shortForecast || "NWS hourly forecast";
    wind.textContent = `Wind: ${forecast.windSpeed || "Not reported"}${forecast.windDirection ? ` from ${forecast.windDirection}` : ""}`;
    rain.textContent = `Precipitation chance: ${Number.isFinite(chance) ? `${chance}%` : "Not reported"}`;
    popup.className = "weather-popup";
    popup.append(title, conditions, wind, rain);
    marker.bindPopup(popup).openPopup();
  } else {
    layers.circleMarker([latitude, longitude], {
      radius: 9,
      color: "#fff",
      weight: 2,
      fillColor: "#42b6ff",
      fillOpacity: 1,
    }).addTo(weatherMapLayers).bindPopup(data.location.name);
  }

  for (const alert of data.alerts) {
    if (!alert.geometry) continue;
    const color = alert.severity === "Extreme" || alert.severity === "Severe"
      ? "#ef5961"
      : alert.severity === "Moderate" ? "#f5b94d" : "#58b6ff";
    layers.geoJSON(alert.geometry, {
      style: { color, weight: 2, fillColor: color, fillOpacity: 0.2 },
    }).addTo(weatherMapLayers).bindPopup(makeAlertPopup(alert));
  }

  map.setView([latitude, longitude], 11);
  window.requestAnimationFrame(() => map.invalidateSize());
}

function getEmployeeLocationsMap() {
  if (!window.L) {
    throw new Error("The map library could not be loaded. Shared coordinates are listed below.");
  }
  if (!employeeLocationsMap) {
    employeeLocationsMap = window.L.map(document.querySelector("#employee-locations-map"), {
      scrollWheelZoom: false,
    }).setView([39.8283, -98.5795], 4);
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    }).addTo(employeeLocationsMap);
    employeeLocationsLayer = window.L.layerGroup().addTo(employeeLocationsMap);
  }
  return employeeLocationsMap;
}

function formatLiveLocationTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Time unavailable"
    : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function renderLiveLocations() {
  const emptyMessage = document.querySelector("#live-locations-empty");
  liveLocationRows.replaceChildren();
  emptyMessage.hidden = liveLocations.length > 0;
  emptyMessage.textContent = liveLocations.length === 0
    ? "No employees have reported a location in the last five minutes. Employees can enable location sharing in the Fieldcast mobile app."
    : "";

  for (const location of liveLocations) {
    const row = document.createElement("tr");
    const employeeCell = document.createElement("td");
    const coordinatesCell = document.createElement("td");
    const updatedCell = document.createElement("td");
    employeeCell.textContent = `${location.fullName} · ID ${location.userId}`;
    coordinatesCell.textContent = `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`;
    updatedCell.textContent = formatLiveLocationTime(location.updatedAt);
    row.append(employeeCell, coordinatesCell, updatedCell);
    liveLocationRows.append(row);
  }

  const mapStatus = document.querySelector("#live-locations-status");
  let mapError = "";
  try {
    const map = getEmployeeLocationsMap();
    employeeLocationsLayer.clearLayers();
    const bounds = [];
    const renderer = window.L.canvas();
    for (const location of liveLocations) {
      const point = [location.latitude, location.longitude];
      const popup = document.createElement("div");
      const name = document.createElement("strong");
      const userId = document.createElement("span");
      const updated = document.createElement("span");
      popup.className = "live-location-popup";
      name.textContent = location.fullName;
      userId.textContent = `Employee ID ${location.userId}`;
      updated.textContent = `Last update: ${formatLiveLocationTime(location.updatedAt)}`;
      popup.append(name, userId, updated);
      window.L.circleMarker(point, {
        radius: 8,
        color: "#fff",
        weight: 2,
        fillColor: "#50d7a0",
        fillOpacity: 0.95,
        renderer,
      }).addTo(employeeLocationsLayer).bindPopup(popup);
      bounds.push(point);
    }
    if (bounds.length > 1) {
      map.fitBounds(bounds, { padding: [32, 32], maxZoom: 12 });
    } else if (bounds.length === 1) {
      map.setView(bounds[0], 12);
    } else {
      map.setView([39.8283, -98.5795], 4);
    }
    window.requestAnimationFrame(() => map.invalidateSize());
    mapStatus.classList.remove("weather-map-status-error");
  } catch (error) {
    mapStatus.classList.add("weather-map-status-error");
    mapError = error instanceof Error ? error.message : "Unable to render the location map.";
    console.error("Failed to render employee locations map.", error);
  }
  return mapError;
}

async function loadLiveLocations() {
  const requestId = ++liveLocationRequestId;
  const status = document.querySelector("#live-locations-status");
  status.textContent = "Loading opted-in employee locations…";
  status.classList.remove("weather-map-status-error");
  try {
    const response = await authenticatedFetch("/api/admin/employee-locations");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Location API returned HTTP ${response.status}.`);
    if (!Array.isArray(result)) throw new Error("Location API response must be an array.");
    if (requestId !== liveLocationRequestId) return;
    liveLocations = result.map((location) => ({
      userId: String(location.userId),
      fullName: String(location.fullName),
      latitude: Number(location.latitude),
      longitude: Number(location.longitude),
      updatedAt: String(location.updatedAt),
    }));
    if (liveLocations.some((location) =>
      !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)
      || Math.abs(location.latitude) > 90 || Math.abs(location.longitude) > 180
    )) {
      throw new Error("Location API returned invalid coordinates.");
    }
    const mapError = renderLiveLocations();
    const checkedAt = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date());
    status.textContent = `${liveLocations.length} live location${liveLocations.length === 1 ? "" : "s"} · checked at ${checkedAt}. Refreshes every 30 seconds.${mapError ? ` ${mapError}` : ""}`;
    status.classList.toggle("weather-map-status-error", Boolean(mapError));
  } catch (error) {
    if (requestId !== liveLocationRequestId) return;
    const message = error instanceof Error ? error.message : "Unable to load shared employee locations.";
    liveLocations = [];
    renderLiveLocations();
    status.textContent = /HTTP (401|403)/.test(message)
      ? "Manager sign-in is required to view shared employee locations."
      : message;
    status.classList.add("weather-map-status-error");
    console.error("Failed to load shared employee locations.", error);
  }
}

async function loadSelectedLocationWeather(keepMapView = false) {
  const requestId = ++weatherRequestId;
  const selectedLocation = locations.find((location) => location.id === selectedLocationId);
  const summary = document.querySelector("#weather-summary");
  summary.replaceChildren();
  if (!selectedLocation) {
    document.querySelector("#weather-map-location").textContent = "Choose a work site to view its local weather.";
    setWeatherStatus("Waiting for a selected location.");
    setWeatherFeedStatus("Waiting", "Choose a work site to load its weather.");
    return;
  }

  document.querySelector("#weather-map-location").textContent =
    [selectedLocation.name, selectedLocation.address].filter(Boolean).join(" · ");
  setWeatherStatus("Loading the selected site's location and live NWS conditions...");
  setWeatherFeedStatus("Loading…", "Fetching National Weather Service conditions.");

  try {
    const response = await fetch(`/api/weather?locationId=${encodeURIComponent(selectedLocation.id)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Weather API returned HTTP ${response.status}.`);
    if (requestId !== weatherRequestId) return;

    const forecast = result.forecast;
    addWeatherMetric("NWS hourly forecast", forecast.shortForecast || "Not reported");
    addWeatherMetric(
      "Temperature",
      forecast.temperature === null || forecast.temperature === undefined
        ? "Not reported"
        : `${forecast.temperature}°${forecast.temperatureUnit || "F"}`,
    );
    addWeatherMetric(
      "Wind",
      `${forecast.windSpeed || "Not reported"}${forecast.windDirection ? ` from ${forecast.windDirection}` : ""}`,
    );
    const precipitationChance = typeof forecast.probabilityOfPrecipitation === "number"
      ? forecast.probabilityOfPrecipitation
      : Number.NaN;
    addWeatherMetric(
      "Precipitation chance",
      Number.isFinite(precipitationChance) ? `${precipitationChance}%` : "Not reported",
      "weather-metric-rain",
    );
    addWeatherMetric(
      "Humidity",
      forecast.relativeHumidity === null || forecast.relativeHumidity === undefined
        ? "Not reported"
        : `${forecast.relativeHumidity}%`,
    );
    let mapError = "";
    try {
      const map = getWeatherMap();
      if (!keepMapView) map.setView([39.8283, -98.5795], 4);
      renderWeatherMap(result);
    } catch (error) {
      mapError = error instanceof Error ? error.message : "Unable to render the weather map.";
      console.error("Failed to render the weather map.", error);
    }

    const forecastStart = forecast.startTime
      ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(forecast.startTime))
      : "the next forecast period";
    const alertCount = result.alerts.length;
    const alertStatus = result.alertsError
      ? result.alertsError
      : alertCount ? `${alertCount} active alert${alertCount === 1 ? "" : "s"} shown on the map.` : "No active NWS alerts for this point.";
    const checkedAt = result.updatedAt
      ? new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(result.updatedAt))
      : null;
    const feedTemperature = forecast.temperature === null || forecast.temperature === undefined
      ? ""
      : `${forecast.temperature}°${forecast.temperatureUnit || "F"}`;
    const feedCondition = forecast.shortForecast || "Current conditions";
    const feedStatus = [feedCondition, feedTemperature].filter(Boolean).join(" · ");
    const feedWind = `${forecast.windSpeed || "Wind n/a"}${forecast.windDirection ? ` ${forecast.windDirection}` : ""}`;
    const feedRain = Number.isFinite(precipitationChance) ? `${precipitationChance}%` : "n/a";
    const feedHumidity = forecast.relativeHumidity === null || forecast.relativeHumidity === undefined
      ? "n/a"
      : `${forecast.relativeHumidity}%`;
    const feedNote = [
      `Wind ${feedWind} · Rain ${feedRain} · Humidity ${feedHumidity}`,
      checkedAt ? `Updated ${checkedAt}` : "",
      result.alertsError ? "Active alerts unavailable." : "",
      mapError ? `Map unavailable: ${mapError}` : "",
    ].filter(Boolean).join(" ");
    setWeatherFeedStatus(feedStatus, feedNote);
    const locationPrecision = result.location.geocodePrecision === "locality"
      ? "Exact street address was not found; weather is for the nearby locality."
      : result.location.geocodePrecision === "configured-site" && selectedLocation.address
        ? "The address could not be geocoded; weather is using the stored work-site coordinates."
      : null;
    setWeatherStatus(
      `NWS hourly forecast for ${forecastStart}${checkedAt ? ` · checked at ${checkedAt}` : ""}.${locationPrecision ? ` ${locationPrecision}` : ""} ${alertStatus}${mapError ? ` Weather map unavailable: ${mapError}` : ""}`,
      Boolean(result.alertsError || mapError),
    );
  } catch (error) {
    if (requestId !== weatherRequestId) return;
    const message = error instanceof Error ? error.message : "Unable to load weather for this work site.";
    setWeatherStatus(message, true);
    setWeatherFeedStatus("Unavailable", message);
    console.error("Failed to load NWS weather for the selected work site.", error);
  }
}

function mapDatabaseEmployee(employee) {
  return {
    id: String(employee.userId),
    name: String(employee.fullName),
    phoneNumber: String(employee.phoneNumber ?? employee.phone ?? ""),
    locationId: String(employee.locationId),
    locationName: String(employee.locationName ?? ""),
    locationAddress: String(employee.locationAddress ?? ""),
    daysOfWeek: employee.daysOfWeek,
    schedule: {
      days: expandDaysOfWeek(employee.daysOfWeek),
      startTime: employee.shiftStart,
      endTime: employee.shiftEnd,
    },
  };
}

function getWorkSiteClock(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: workSite.timezone || undefined,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    weekday: values.weekday,
    minutes: Number(values.hour) * 60 + Number(values.minute),
  };
}

function getEmployeeStatus(employee, now = new Date()) {
  const clock = getWorkSiteClock(now);

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const todayIndex = dayNames.indexOf(clock.weekday);
  const todayName = clock.weekday;
  const yesterdayName = dayNames[(todayIndex + 6) % 7];
  const [startHour, startMinute] = employee.schedule.startTime.split(":").map(Number);
  const [endHour, endMinute] = employee.schedule.endTime.split(":").map(Number);
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;
  const overnightShift = endMinutes <= startMinutes;
  const onTodayShift = employee.schedule.days.includes(todayName)
    && (overnightShift ? clock.minutes >= startMinutes : clock.minutes >= startMinutes && clock.minutes < endMinutes);
  const onOvernightRemainder = overnightShift
    && employee.schedule.days.includes(yesterdayName)
    && clock.minutes < endMinutes;

  return onTodayShift || onOvernightRemainder ? "Working" : "Off shift";
}

function setPage(selectedPage) {
  for (const button of navigationButtons) {
    if (button.dataset.page === selectedPage) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  }

  for (const pageView of pageViews) {
    pageView.hidden = pageView.dataset.view !== selectedPage;
  }

  if (selectedPage === "overview") renderOverview();
  if (selectedPage === "employees") renderEmployees();
  if (selectedPage === "live-locations") loadLiveLocations();
}

function renderOverview() {
  const workingEmployees = employees.filter((employee) => getEmployeeStatus(employee) === "Working").length;
  const openAlerts = alerts.filter((alert) => alert.status !== "Resolved").length;
  const selectedLocation = locations.find((location) => location.id === selectedLocationId);
  const siteName = selectedLocation?.name || workSite.name || "Work site not set";
  const siteAddress = selectedLocation
    ? selectedLocation.address
      || (selectedLocation.latitude !== null && selectedLocation.longitude !== null
        ? `Coordinates: ${selectedLocation.latitude}, ${selectedLocation.longitude}`
        : "Coordinates not configured")
    : workSite.address || "Address not set";

  document.querySelector("#employee-count").textContent =
    employeesLoading ? "…" : employeeLoadError ? "—" : String(employees.length);
  document.querySelector("#active-employee-note").textContent = employeesLoading
    ? "Loading employee roster…"
    : employeeLoadError || `${workingEmployees} working now · ${employees.length - workingEmployees} off shift`;
  document.querySelector("#open-alert-count").textContent = String(openAlerts);
  document.querySelector("#nav-alert-count").textContent = String(openAlerts);
  document.querySelector("#overview-site-name").textContent = siteName;
  overviewLocationSelect.value = selectedLocationId;

  const siteAddressSummary = document.querySelector("#overview-site-address");
  siteAddressSummary.replaceChildren();
  const selectedSiteName = document.createElement("strong");
  const selectedSiteAddress = document.createElement("p");
  selectedSiteName.textContent = siteName;
  selectedSiteAddress.textContent = siteAddress;
  siteAddressSummary.append(selectedSiteName, selectedSiteAddress);

  const siteDetails = document.querySelector("#overview-site-details");
  siteDetails.replaceChildren();
  const details = selectedLocation ? [] : [
    ["Time zone", workSite.timezone || "Not set"],
    ["Coordinates", workSite.latitude && workSite.longitude ? `${workSite.latitude}, ${workSite.longitude}` : "Not set"],
  ];

  for (const [label, value] of details) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    row.className = "site-detail-row";
    term.textContent = label;
    description.textContent = value;
    row.append(term, description);
    siteDetails.append(row);
  }

  const preview = document.querySelector("#overview-alerts");
  preview.replaceChildren();
  const latestAlerts = [...alerts].slice(0, 3);

  if (latestAlerts.length === 0) {
    const emptyMessage = document.createElement("p");
    emptyMessage.className = "table-empty";
    emptyMessage.textContent = "No alerts to review.";
    preview.append(emptyMessage);
    return;
  }

  for (const alert of latestAlerts) {
    const row = document.createElement("div");
    const marker = document.createElement("span");
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    row.className = "alert-preview";
    marker.className = `severity-marker severity-${escapeClassName(alert.severity)}`;
    marker.setAttribute("aria-hidden", "true");
    copy.className = "alert-preview-copy";
    title.textContent = alert.title;
    meta.textContent = `${alert.severity} · ${alert.status} · ${alert.time}`;
    copy.append(title, meta);
    row.append(marker, copy);
    preview.append(row);
  }
}

function renderEmployees() {
  document.querySelector("#add-employee-button").disabled =
    employeesLoading || Boolean(employeeLoadError) || locations.length === 0;
  const search = employeeSearch.value.trim().toLowerCase();
  const selectedStatus = employeeFilter.value;
  const selectedLocation = employeeLocationFilter.value;
  const filteredEmployees = employees.filter((employee) => {
    const employeeStatus = getEmployeeStatus(employee);
    const matchesSearch = [employee.name, employee.id, employee.phoneNumber, employeeStatus]
      .some((value) => value.toLowerCase().includes(search));
    const matchesStatus = selectedStatus === "all" || employeeStatus === selectedStatus;
    const matchesLocation = selectedLocation === "all" || employee.locationId === selectedLocation;
    return matchesSearch && matchesStatus && matchesLocation;
  });

  const pageCount = Math.max(1, Math.ceil(filteredEmployees.length / EMPLOYEE_PAGE_SIZE));
  employeePage = Math.min(employeePage, pageCount);
  const startIndex = (employeePage - 1) * EMPLOYEE_PAGE_SIZE;
  const pageEmployees = filteredEmployees.slice(startIndex, startIndex + EMPLOYEE_PAGE_SIZE);
  employeeRows.replaceChildren();
  const emptyMessage = document.querySelector("#employee-empty");
  emptyMessage.textContent = employeesLoading
    ? "Loading employees..."
    : employeeLoadError || "No employees match your search.";
  emptyMessage.hidden = filteredEmployees.length > 0;
  const pagination = document.querySelector("#employee-pagination");
  const pageStatus = document.querySelector("#employee-page-status");
  const previousPageButton = document.querySelector("#employee-previous-page");
  const nextPageButton = document.querySelector("#employee-next-page");
  pagination.hidden = employeesLoading || Boolean(employeeLoadError) || filteredEmployees.length === 0;
  pageStatus.textContent = `Showing ${startIndex + 1}–${Math.min(startIndex + EMPLOYEE_PAGE_SIZE, filteredEmployees.length)} of ${filteredEmployees.length} employees`;
  previousPageButton.disabled = employeePage <= 1;
  nextPageButton.disabled = employeePage >= pageCount;

  for (const employee of pageEmployees) {
    const row = document.createElement("tr");
    const personCell = document.createElement("td");
    const person = document.createElement("div");
    const avatar = document.createElement("span");
    const personCopy = document.createElement("div");
    const name = document.createElement("span");
    const userId = document.createElement("span");
    const phoneNumber = document.createElement("span");
    const schedule = document.createElement("td");
    const status = document.createElement("td");
    const statusPill = document.createElement("span");
    const location = document.createElement("td");
    const locationName = document.createElement("span");
    const locationAddress = document.createElement("span");
    const actions = document.createElement("td");
    const editButton = document.createElement("button");

    person.className = "employee-cell";
    avatar.className = "avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = initials(employee.name);
    personCopy.className = "employee-copy";
    name.className = "employee-name";
    name.textContent = employee.name;
    userId.className = "employee-id";
    userId.textContent = `ID ${employee.id}`;
    phoneNumber.className = "employee-id";
    phoneNumber.textContent = employee.phoneNumber;
    personCopy.append(name, userId, phoneNumber);
    person.append(avatar, personCopy);
    personCell.append(person);
    schedule.textContent = describeSchedule(employee.schedule);
    const currentStatus = getEmployeeStatus(employee);
    statusPill.className = `status-pill status-${escapeClassName(currentStatus)}`;
    statusPill.textContent = currentStatus;
    status.append(statusPill);
    location.className = "employee-location";
    locationName.textContent = employee.locationName;
    locationAddress.textContent = employee.locationAddress;
    location.append(locationName, locationAddress);
    actions.className = "row-actions-cell";
    editButton.className = "small-action";
    editButton.type = "button";
    editButton.dataset.editEmployee = employee.id;
    editButton.textContent = "Edit";
    editButton.disabled = locations.length === 0;
    editButton.setAttribute("aria-label", `Edit ${employee.name}`);
    actions.append(editButton);
    row.append(personCell, schedule, status, location, actions);
    employeeRows.append(row);
  }
}

function showEmployeeEditor(employee) {
  employeeEditForm.elements.userId.value = employee.id;
  employeeEditForm.elements.fullName.value = employee.name;
  employeeEditForm.elements.phoneNumber.value = employee.phoneNumber;
  employeeEditForm.elements.locationId.value = employee.locationId;
  employeeEditForm.elements.shiftStart.value = employee.schedule.startTime;
  employeeEditForm.elements.shiftEnd.value = employee.schedule.endTime;
  employeeEditForm.elements.daysOfWeek.value = employee.daysOfWeek;
  employeeEditFeedback.textContent = "";
  employeeEditFeedback.classList.remove("form-feedback-error");
  employeeEditDialog.showModal();
  employeeEditForm.elements.fullName.focus();
}

function showEmployeeAddDialog() {
  employeeAddForm.reset();
  const locationSelect = employeeAddForm.elements.locationId;
  locationSelect.replaceChildren(...locations.map((location) => {
    const option = document.createElement("option");
    option.value = location.id;
    option.textContent = [location.name, location.address].filter(Boolean).join(" — ");
    return option;
  }));
  locationSelect.value = selectedLocationId || locations[0]?.id || "";
  employeeAddFeedback.textContent = "";
  employeeAddFeedback.classList.remove("form-feedback-error");
  employeeAddDialog.showModal();
  employeeAddForm.elements.userId.focus();
}

function renderEmployeeLocationEditor() {
  const locationSelect = employeeEditForm.elements.locationId;
  const options = locations.map((location) => {
    const option = document.createElement("option");
    option.value = location.id;
    option.textContent = [location.name, location.address].filter(Boolean).join(" — ");
    return option;
  });
  locationSelect.replaceChildren(...options);
  locationSelect.disabled = options.length === 0;
}

function renderEmployeeLocationFilter() {
  const selectedLocation = employeeLocationFilter.value;
  const allLocations = document.createElement("option");
  allLocations.value = "all";
  allLocations.textContent = "All locations";
  employeeLocationFilter.replaceChildren(allLocations);

  for (const location of locations) {
    const option = document.createElement("option");
    option.value = location.id;
    option.textContent = location.name;
    employeeLocationFilter.append(option);
  }

  employeeLocationFilter.value = locations.some((location) => location.id === selectedLocation) ? selectedLocation : "all";
  renderEmployeeLocationEditor();
}

function renderOverviewLocationOptions() {
  const options = locations.map((location) => {
    const option = document.createElement("option");
    option.value = location.id;
    option.textContent = [location.name, location.address].filter(Boolean).join(" — ");
    return option;
  });
  overviewLocationSelect.replaceChildren(...options);
  overviewLocationSelect.disabled = options.length === 0;
  if (!locations.some((location) => location.id === selectedLocationId)) {
    selectedLocationId = locations[0]?.id || "";
  }
  overviewLocationSelect.value = selectedLocationId;
  loadSelectedLocationWeather();
}

function renderAlerts() {
  const selectedStatus = document.querySelector("#alert-filter").value;
  const filteredAlerts = alerts.filter((alert) => selectedStatus === "all" || alert.status === selectedStatus);
  const alertList = document.querySelector("#alert-list");
  alertList.replaceChildren();
  document.querySelector("#alert-empty").hidden = filteredAlerts.length > 0;

  for (const alert of filteredAlerts) {
    const item = document.createElement("article");
    const main = document.createElement("div");
    const titleRow = document.createElement("div");
    const title = document.createElement("h3");
    const severity = document.createElement("span");
    const status = document.createElement("span");
    const message = document.createElement("p");
    const meta = document.createElement("div");
    const actions = document.createElement("div");
    const location = document.createElement("span");

    item.className = "alert-item";
    titleRow.className = "alert-title-row";
    title.textContent = alert.title;
    severity.className = `severity-pill severity-${escapeClassName(alert.severity)}-pill`;
    severity.textContent = alert.severity;
    status.className = `status-pill status-${escapeClassName(alert.status)}`;
    status.textContent = alert.status;
    titleRow.append(title, severity, status);
    message.className = "alert-message";
    message.textContent = alert.message;
    meta.className = "alert-meta";
    meta.textContent = alert.time;
    location.textContent = ` · ${alert.location}`;
    meta.append(location);
    main.append(titleRow, message, meta);
    actions.className = "alert-actions";

    if (alert.status === "Open") {
      actions.append(createAlertAction(alert.id, "Acknowledge", "Acknowledged"));
    }
    if (alert.status !== "Resolved") {
      actions.append(createAlertAction(alert.id, "Resolve", "Resolved"));
    }
    if (actions.childElementCount === 0) {
      const resolvedLabel = document.createElement("span");
      resolvedLabel.className = "alert-meta";
      resolvedLabel.textContent = "Closed";
      actions.append(resolvedLabel);
    }

    item.append(main, actions);
    alertList.append(item);
  }
}

function createAlertAction(alertId, label, nextStatus) {
  const button = document.createElement("button");
  button.className = "small-action";
  button.type = "button";
  button.dataset.alertId = String(alertId);
  button.dataset.alertStatus = nextStatus;
  button.textContent = label;
  return button;
}

function renderAll() {
  renderOverview();
  renderEmployees();
  renderAlerts();
  window.renderCommandCenter?.(); // overview.js charts and map
}

for (const button of navigationButtons) {
  button.addEventListener("click", () => setPage(button.dataset.page));
}

document.querySelector("#refresh-live-locations").addEventListener("click", loadLiveLocations);

for (const button of document.querySelectorAll("[data-open-page]")) {
  button.addEventListener("click", () => setPage(button.dataset.openPage));
}

document.querySelector("#add-alert-button").addEventListener("click", () => {
  alertForm.reset();
  alertDialog.showModal();
  alertForm.elements.title.focus();
});

document.querySelector("#add-employee-button").addEventListener("click", showEmployeeAddDialog);

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});

employeeRows.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest("[data-edit-employee]");
  if (!(button instanceof HTMLButtonElement)) return;
  const employee = employees.find((item) => item.id === button.dataset.editEmployee);
  if (employee) showEmployeeEditor(employee);
});

employeeEditForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const userId = employeeEditForm.elements.userId.value;
  const submitButton = employeeEditForm.querySelector("button[type='submit']");
  const formData = new FormData(employeeEditForm);
  const payload = Object.fromEntries(formData.entries());
  delete payload.userId;
  submitButton.disabled = true;
  employeeEditFeedback.textContent = "Saving employee details...";
  employeeEditFeedback.classList.remove("form-feedback-error");

  try {
    const response = await authenticatedFetch(`/api/admin/employees/${encodeURIComponent(userId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Save failed with HTTP ${response.status}.`);

    const index = employees.findIndex((employee) => employee.id === userId);
    if (index !== -1) employees[index] = mapDatabaseEmployee(result);
    employeeEditDialog.close();
    renderAll();
  } catch (error) {
    employeeEditFeedback.textContent = error instanceof Error ? error.message : "Unable to save employee details.";
    employeeEditFeedback.classList.add("form-feedback-error");
  } finally {
    submitButton.disabled = false;
  }
});

employeeAddForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = employeeAddForm.querySelector("button[type='submit']");
  const formData = new FormData(employeeAddForm);
  const payload = Object.fromEntries(formData.entries());
  const userId = String(payload.userId).trim();
  if (employees.some((employee) => employee.id === userId)) {
    employeeAddFeedback.textContent = "That employee ID already exists. Edit the existing employee instead.";
    employeeAddFeedback.classList.add("form-feedback-error");
    return;
  }

  submitButton.disabled = true;
  employeeAddFeedback.textContent = "Adding employee...";
  employeeAddFeedback.classList.remove("form-feedback-error");
  try {
    const response = await authenticatedFetch("/api/admin/employees/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employees: [payload] }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Add failed with HTTP ${response.status}.`);
    if (result.added !== 1 || result.rejectedCount) {
      throw new Error(result.rejected?.join("; ") || "The employee could not be added.");
    }

    employeeAddDialog.close();
    employeeSearch.value = userId;
    employeePage = 1;
    await loadEmployees();
    setPage("employees");
  } catch (error) {
    employeeAddFeedback.textContent = error instanceof Error ? error.message : "Unable to add employee.";
    employeeAddFeedback.classList.add("form-feedback-error");
  } finally {
    submitButton.disabled = false;
  }
});

employeeSearch.addEventListener("input", () => {
  employeePage = 1;
  renderEmployees();
});
employeeFilter.addEventListener("change", () => {
  employeePage = 1;
  renderEmployees();
});
employeeLocationFilter.addEventListener("change", () => {
  employeePage = 1;
  renderEmployees();
});
document.querySelector("#employee-previous-page").addEventListener("click", () => {
  if (employeePage > 1) {
    employeePage -= 1;
    renderEmployees();
  }
});
document.querySelector("#employee-next-page").addEventListener("click", () => {
  employeePage += 1;
  renderEmployees();
});
overviewLocationSelect.addEventListener("change", () => {
  selectedLocationId = overviewLocationSelect.value;
  renderOverview();
  loadSelectedLocationWeather();
});
document.querySelector("#alert-filter").addEventListener("change", renderAlerts);

document.querySelector("#alert-list").addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement) || !target.dataset.alertId) return;

  const alert = alerts.find((item) => item.id === Number(target.dataset.alertId));
  if (alert) {
    alert.status = target.dataset.alertStatus;
    renderAll();
  }
});

alertForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(alertForm);
  alerts.unshift({
    id: nextAlertId++,
    title: String(formData.get("title")).trim(),
    message: String(formData.get("message")).trim(),
    severity: String(formData.get("severity")),
    status: "Open",
    time: `Today, ${new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date())}`,
    location: workSite.name || "Work site",
  });
  alertDialog.close();
  renderAll();
  window.setInterval(() => {
    renderOverview();
    renderEmployees();
  }, 60_000);
});

const worksiteForm = document.querySelector("#worksite-form");
for (const [name, value] of Object.entries(workSite)) {
  worksiteForm.elements[name].value = value;
}

worksiteForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(worksiteForm);
  const latitude = String(formData.get("latitude")).trim();
  const longitude = String(formData.get("longitude")).trim();
  const timezone = String(formData.get("timezone")).trim();
  const feedback = document.querySelector("#worksite-feedback");

  if (Boolean(latitude) !== Boolean(longitude)) {
    feedback.textContent = "Enter both coordinates, or leave both blank.";
    return;
  }

  if (timezone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    } catch {
      feedback.textContent = "Enter a valid time zone, such as America/Chicago.";
      return;
    }
  }

  workSite = Object.fromEntries(
    [...formData.entries()].map(([key, value]) => [key, String(value).trim()]),
  );
  feedback.textContent = "Work site details updated for this session.";
  renderOverview();
  renderEmployees();
});

renderAll();
loadEmployees();
loadLocations();
window.setInterval(() => {
  if (selectedLocationId) loadSelectedLocationWeather(true);
}, 10 * 60 * 1000);
window.setInterval(() => {
  if (!document.querySelector('[data-view="live-locations"]').hidden) loadLiveLocations();
}, LIVE_LOCATION_REFRESH_MS);

async function loadEmployees() {
  try {
    const response = await authenticatedFetch("/api/employees");
    if (!response.ok) throw new Error(`Employee API returned HTTP ${response.status}.`);
    const records = await response.json();
    if (!Array.isArray(records)) throw new Error("Employee API response must be an array.");

    employees = records.map(mapDatabaseEmployee);
    employeesLoading = false;
    renderAll();
  } catch (error) {
    employeesLoading = false;
    employeeLoadError = error instanceof Error && /HTTP (401|403)/.test(error.message)
      ? "Sign in with an administrator account to view and edit employees."
      : "Unable to load employees from the database. Check that the dashboard server and database are available.";
    console.error("Failed to load employees from the database.", error);
    renderAll();
  }
}

async function loadLocations() {
  try {
    const response = await authenticatedFetch("/api/locations");
    if (!response.ok) throw new Error(`Location API returned HTTP ${response.status}.`);
    const records = await response.json();
    if (!Array.isArray(records)) throw new Error("Location API response must be an array.");

    locations = records.map((location) => ({
      id: String(location.locationId),
      name: location.name,
      address: location.address,
      latitude: location.latitude,
      longitude: location.longitude,
    }));
    renderOverviewLocationOptions();
    renderEmployeeLocationFilter();
    renderAll();
  } catch (error) {
    overviewLocationSelect.replaceChildren();
    const unavailableOption = document.createElement("option");
    unavailableOption.value = "";
    unavailableOption.textContent = "Unable to load locations";
    overviewLocationSelect.append(unavailableOption);
    overviewLocationSelect.disabled = true;
    console.error("Failed to load locations from the database.", error);
  }
}
