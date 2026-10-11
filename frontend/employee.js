const token = localStorage.getItem("fieldcastSessionToken") || "";
const LOCATION_MIN_INTERVAL_MS = 12_000;
let profile;
let watchId = null;
let lastLocationSentAt = 0;

async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed with HTTP ${response.status}.`);
  return result;
}

function setLocationStatus(message, error = false) {
  const status = document.querySelector("#employee-location-status");
  status.textContent = message;
  status.classList.toggle("weather-map-status-error", error);
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Time unavailable"
    : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function renderAlerts(items) {
  const list = document.querySelector("#employee-alert-list");
  const empty = document.querySelector("#employee-alert-empty");
  list.replaceChildren();
  empty.hidden = items.length > 0;
  for (const item of items) {
    const article = document.createElement("article");
    const copy = document.createElement("div");
    const kind = document.createElement("p");
    const message = document.createElement("p");
    const time = document.createElement("p");
    article.className = "employee-alert-item";
    copy.className = "employee-alert-copy";
    kind.className = "eyebrow";
    kind.textContent = item.kind.replaceAll("_", " ");
    message.className = "employee-alert-message";
    message.textContent = item.message;
    time.className = "employee-alert-time";
    time.textContent = formatDate(item.created_at);
    copy.append(kind, message, time);
    article.append(copy);
    list.append(article);
  }
}

async function refreshAlerts() {
  const status = document.querySelector("#employee-alert-status");
  status.textContent = "Checking your alerts…";
  try {
    const items = await apiRequest("/api/my/notifications");
    renderAlerts(items);
    status.textContent = `Updated ${new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date())}.`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Unable to load your alerts.";
  }
}

async function loadProfile() {
  if (!token) {
    window.location.replace("/login.html");
    return;
  }

  try {
    profile = await apiRequest("/api/me");
    if (profile.isManager) {
      window.location.replace("/dashboard");
      return;
    }
    const locations = await apiRequest("/api/locations");
    const workSite = locations.find((location) => String(location.locationId) === String(profile.locationId));
    document.querySelector("#employee-name").textContent = profile.name;
    document.querySelector("#employee-user-id").textContent = profile.userId;
    document.querySelector("#employee-work-site").textContent =
      workSite ? [workSite.name, workSite.address].filter(Boolean).join(" · ") : "Work site unavailable";
    document.querySelector("#employee-work-days").textContent = profile.daysOfWeek;
    document.querySelector("#employee-shift").textContent =
      `${profile.shiftStart}–${profile.shiftEnd}`;
    document.querySelector("#employee-email").value = profile.email || "";
    document.querySelector("#employee-email-enabled").checked = profile.emailNotificationsEnabled;
    document.querySelector("#employee-email-enabled").addEventListener("change", () => {
      const checkbox = document.querySelector("#employee-email-enabled");
      if (checkbox.checked && !document.querySelector("#employee-email").value.trim()) {
        document.querySelector("#employee-email").focus();
      }
    });

    const button = document.querySelector("#employee-location-button");
    button.textContent = profile.locationSharing ? "Resume sharing on this device" : "Enable location sharing";
    setLocationStatus(profile.locationSharing
      ? "Location sharing is enabled for your account. Start browser sharing here to send this device’s current location."
      : "Location sharing is off.");
    await refreshAlerts();
  } catch (error) {
    setLocationStatus(error instanceof Error ? error.message : "Unable to load your employee profile.", true);
  }
}

async function sendCurrentLocation(position) {
  const now = Date.now();
  if (now - lastLocationSentAt < LOCATION_MIN_INTERVAL_MS) return;
  lastLocationSentAt = now;
  const { latitude, longitude } = position.coords;
  await apiRequest("/api/location", {
    method: "POST",
    body: JSON.stringify({ lat: latitude, lon: longitude }),
  });
  const currentLocation = document.querySelector("#employee-current-location");
  currentLocation.textContent = `This device: ${latitude.toFixed(4)}, ${longitude.toFixed(4)} · updated ${new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(position.timestamp))}`;
  currentLocation.hidden = false;
  setLocationStatus("Sharing your current location for personal weather monitoring.");
  await refreshAlerts();
}

function handleLocationError(error) {
  const message = error.code === error.PERMISSION_DENIED
    ? "Location permission was denied. Allow location access in your browser to share your position."
    : error.code === error.POSITION_UNAVAILABLE
      ? "Your device could not determine its location."
      : "Timed out waiting for your device location. Try again.";
  setLocationStatus(message, true);
}

async function startLocationSharing() {
  if (!navigator.geolocation) {
    throw new Error("This browser does not support location sharing.");
  }
  await apiRequest("/api/location/consent", {
    method: "POST",
    body: JSON.stringify({ consent: true }),
  });
  profile.locationSharing = true;
  setLocationStatus("Requesting browser location permission…");
  watchId = navigator.geolocation.watchPosition(
    (position) => {
      sendCurrentLocation(position).catch((error) => {
        setLocationStatus(error instanceof Error ? error.message : "Unable to send your location.", true);
      });
    },
    handleLocationError,
    { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
  );
  document.querySelector("#employee-location-button").textContent = "Stop location sharing";
  setLocationStatus("Waiting for your device’s location…");
}

async function stopLocationSharing() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  await apiRequest("/api/location/consent", {
    method: "POST",
    body: JSON.stringify({ consent: false }),
  });
  profile.locationSharing = false;
  lastLocationSentAt = 0;
  document.querySelector("#employee-current-location").hidden = true;
  document.querySelector("#employee-location-button").textContent = "Enable location sharing";
  setLocationStatus("Location sharing is off. Your saved location has been deleted.");
}

document.querySelector("#employee-location-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    if (watchId === null) await startLocationSharing();
    else await stopLocationSharing();
  } catch (error) {
    setLocationStatus(error instanceof Error ? error.message : "Unable to update location sharing.", true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#employee-refresh-alerts").addEventListener("click", refreshAlerts);
document.querySelector("#employee-email-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = document.querySelector("#employee-email-save");
  const status = document.querySelector("#employee-email-status");
  const email = form.elements.email.value.trim();
  const emailNotificationsEnabled = form.elements.emailNotificationsEnabled.checked;
  submitButton.disabled = true;
  status.classList.remove("weather-map-status-error");
  status.textContent = "Saving your email preferences…";
  try {
    const preferences = await apiRequest("/api/me/notification-preferences", {
      method: "PUT",
      body: JSON.stringify({ email, emailNotificationsEnabled }),
    });
    profile.email = preferences.email;
    profile.emailNotificationsEnabled = preferences.emailNotificationsEnabled;
    status.textContent = preferences.emailNotificationsEnabled
      ? "Email notifications are enabled for this address."
      : "Email preferences saved. Email notifications are off.";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Unable to save email preferences.";
    status.classList.add("weather-map-status-error");
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector("#employee-sign-out").addEventListener("click", async (event) => {
  event.preventDefault();
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    try {
      await apiRequest("/api/location/consent", {
        method: "POST",
        body: JSON.stringify({ consent: false }),
      });
    } catch (error) {
      setLocationStatus(error instanceof Error ? error.message : "Unable to turn off location sharing.", true);
      return;
    }
  }
  localStorage.removeItem("fieldcastSessionToken");
  window.location.assign("/landing/");
});

window.addEventListener("pagehide", () => {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
});
window.setInterval(() => {
  refreshAlerts().catch((error) => console.error("Unable to refresh employee alerts.", error));
}, 60_000);

loadProfile();
