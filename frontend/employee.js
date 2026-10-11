const authToken = sessionStorage.getItem("fieldcastToken");
const currentUser = JSON.parse(sessionStorage.getItem("fieldcastUser") || "{}");
if (!authToken) window.location.replace("./login.html");
if (currentUser.isManager === true) window.location.replace("./index.html");

const locationButton = document.querySelector("#location-sharing-button");
const locationState = document.querySelector("#location-sharing-state");
const locationFeedback = document.querySelector("#location-sharing-feedback");
const emailCheckbox = document.querySelector("#email-alerts-checkbox");
const emailAddress = document.querySelector("#employee-email-address");
const emailFeedback = document.querySelector("#email-alerts-feedback");
const notificationsList = document.querySelector("#personal-notification-list");
const notificationsStatus = document.querySelector("#personal-notifications-status");
const notificationsEmpty = document.querySelector("#personal-notifications-empty");

let locationSharing = false;
let locationTimer = null;
let locationRequestInProgress = false;

function authHeaders(json = false) {
  const headers = { Authorization: `Bearer ${authToken}` };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...authHeaders(Boolean(options.body)), ...options.headers },
  });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) {
    sessionStorage.removeItem("fieldcastToken");
    sessionStorage.removeItem("fieldcastUser");
    window.location.replace("./login.html");
    throw new Error("Your session has expired. Please sign in again.");
  }
  if (!response.ok) throw new Error(result.error || `Request failed (HTTP ${response.status}).`);
  return result;
}

function showLocationSharingState(enabled) {
  locationSharing = enabled;
  locationButton.textContent = enabled ? "Turn off location alerts" : "Turn on location alerts";
  locationState.textContent = enabled ? "Location on" : "Location off";
  locationState.className = `status-pill ${enabled ? "status-working" : "status-off-shift"}`;
}

function requestCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("This browser does not support location sharing."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      resolve,
      (error) => {
        const message = error.code === error.PERMISSION_DENIED
          ? "Location permission was denied. Allow it in your browser settings to use location alerts."
          : error.code === error.POSITION_UNAVAILABLE
            ? "Your current location is unavailable."
            : "The location request timed out. Please try again.";
        reject(new Error(message));
      },
      { enableHighAccuracy: false, maximumAge: 15000, timeout: 20000 },
    );
  });
}

async function checkCurrentLocation() {
  if (!locationSharing || document.visibilityState !== "visible" || locationRequestInProgress) return;
  locationRequestInProgress = true;
  try {
    const position = await requestCurrentPosition();
    const result = await apiRequest("/api/location", {
      method: "POST",
      body: JSON.stringify({
        lat: position.coords.latitude,
        lon: position.coords.longitude,
      }),
    });
    if (!result.nwsOk) {
      locationFeedback.textContent = "Location saved, but the NWS alert check could not complete. It will retry shortly.";
    } else {
      const checkTime = result.checkedAt
        ? new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(result.checkedAt))
        : "now";
      locationFeedback.textContent = `Location checked with NWS at ${checkTime}.`;
    }
    await loadNotifications();
  } catch (error) {
    locationFeedback.textContent = error instanceof Error ? error.message : "Unable to check your current location.";
  } finally {
    locationRequestInProgress = false;
  }
}

function startForegroundLocationChecks() {
  window.clearInterval(locationTimer);
  locationTimer = window.setInterval(checkCurrentLocation, 60_000);
  checkCurrentLocation();
}

async function setLocationSharing(enabled) {
  locationButton.disabled = true;
  locationFeedback.textContent = enabled ? "Requesting browser location permission..." : "Turning off location sharing...";
  try {
    if (enabled) await requestCurrentPosition();
    await apiRequest("/api/location/consent", {
      method: "POST",
      body: JSON.stringify({ consent: enabled }),
    });
    showLocationSharingState(enabled);
    if (enabled) {
      locationFeedback.textContent = "Location alerts are on while this page stays open.";
      startForegroundLocationChecks();
    } else {
      window.clearInterval(locationTimer);
      locationTimer = null;
      locationFeedback.textContent = "Location sharing is off and your saved location was deleted.";
    }
  } catch (error) {
    locationFeedback.textContent = error instanceof Error ? error.message : "Unable to update location sharing.";
  } finally {
    locationButton.disabled = false;
  }
}

function formatNotificationTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function renderNotifications(records) {
  notificationsList.replaceChildren();
  notificationsEmpty.hidden = records.length > 0;
  for (const record of records) {
    const item = document.createElement("article");
    const heading = document.createElement("div");
    const title = document.createElement("strong");
    const status = document.createElement("span");
    const message = document.createElement("p");
    const meta = document.createElement("span");
    item.className = "employee-notification";
    heading.className = "employee-notification-heading";
    title.textContent = record.kind.replaceAll("_", " ");
    status.className = `status-pill status-delivery-${record.status}`;
    status.textContent = record.status;
    heading.append(title, status);
    message.textContent = record.message;
    meta.className = "employee-notification-meta";
    meta.textContent = `${formatNotificationTime(record.created_at)} · ${record.channel.split(",").join(", ")}`;
    item.append(heading, message, meta);
    if (record.delivery_error) {
      const error = document.createElement("p");
      error.className = "delivery-error";
      error.textContent = record.delivery_error;
      item.append(error);
    }
    notificationsList.append(item);
  }
}

async function loadNotifications() {
  try {
    const records = await apiRequest("/api/my/notifications");
    renderNotifications(records);
    notificationsStatus.textContent = records.length
      ? `Showing ${records.length} recent notification${records.length === 1 ? "" : "s"}.`
      : "No recent notification activity.";
  } catch (error) {
    notificationsStatus.textContent = error instanceof Error ? error.message : "Unable to load notifications.";
    notificationsEmpty.hidden = true;
  }
}

async function loadProfile() {
  try {
    const profile = await apiRequest("/api/me");
    if (profile.isManager) {
      window.location.replace("./index.html");
      return;
    }
    document.querySelector("#employee-greeting").textContent = `Hello, ${profile.name}`;
    emailAddress.textContent = profile.email
      ? `Email on file: ${profile.email}`
      : "No email address is on file. Ask your manager to add one to your employee profile.";
    emailCheckbox.disabled = !profile.email && !profile.emailAlerts;
    emailCheckbox.checked = profile.emailAlerts;
    if (!profile.email) {
      emailFeedback.textContent = "Add an email address to your employee profile to enable email alerts.";
    }
    showLocationSharingState(profile.locationSharing);
    if (profile.locationSharing) {
      locationFeedback.textContent = "Location sharing is on. Checks run while this page is open.";
      startForegroundLocationChecks();
    }
  } catch (error) {
    locationFeedback.textContent = error instanceof Error ? error.message : "Unable to load your profile.";
  }
}

locationButton.addEventListener("click", () => setLocationSharing(!locationSharing));

emailCheckbox.addEventListener("change", async () => {
  emailCheckbox.disabled = true;
  emailFeedback.textContent = "Saving your email preference...";
  try {
    const result = await apiRequest("/api/notifications/consent", {
      method: "POST",
      body: JSON.stringify({ emailAlerts: emailCheckbox.checked }),
    });
    emailCheckbox.checked = result.emailAlerts;
    emailFeedback.textContent = result.emailAlerts
      ? "Email alerts are on. Delivery requires the organization’s Gmail SMTP service to be configured."
      : "Email alerts are off.";
  } catch (error) {
    emailCheckbox.checked = !emailCheckbox.checked;
    emailFeedback.textContent = error instanceof Error ? error.message : "Unable to save your email preference.";
  } finally {
    emailCheckbox.disabled = !emailAddress.textContent.startsWith("Email on file:") && !emailCheckbox.checked;
  }
});

document.querySelector("#refresh-personal-notifications").addEventListener("click", loadNotifications);
document.querySelector("#employee-logout").addEventListener("click", () => {
  sessionStorage.removeItem("fieldcastToken");
  sessionStorage.removeItem("fieldcastUser");
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && locationSharing) checkCurrentLocation();
});
window.setInterval(loadNotifications, 30_000);

loadProfile();
loadNotifications();
