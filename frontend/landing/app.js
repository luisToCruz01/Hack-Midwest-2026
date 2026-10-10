document.documentElement.classList.add("js");

const NWS = "https://api.weather.gov";
const REFRESH_MS = 120_000;
// NWS "areas" also include marine zones; these are not states or territories.
const MARINE_AREAS = new Set(["AM", "AN", "GM", "LC", "LE", "LH", "LM", "LO", "LS", "PH", "PK", "PM", "PS", "PZ", "SL"]);
const SEVERITY_COLOR = { Extreme: "var(--red)", Severe: "var(--orange)" };

// ---------- live NWS feed ----------

function timeAgo(iso) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function escapeHtml(text = "") {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function getJson(path) {
  const response = await fetch(`${NWS}${path}`, { headers: { Accept: "application/geo+json" } });
  if (!response.ok) throw new Error(`NWS responded ${response.status}`);
  return response.json();
}

function renderAlerts(features) {
  const list = document.getElementById("live-list");
  const alerts = features
    .map((f) => f.properties)
    .sort((a, b) => (a.severity === b.severity ? new Date(b.sent) - new Date(a.sent) : a.severity === "Extreme" ? -1 : 1))
    .slice(0, 5);

  if (alerts.length === 0) {
    list.innerHTML = `<li class="live-error">No severe or extreme alerts are active right now. Quiet day.</li>`;
    return;
  }

  list.innerHTML = alerts
    .map(
      (a) => `
      <li class="live-item" style="--c: ${SEVERITY_COLOR[a.severity] ?? "var(--amber)"}">
        <div>
          <p class="live-event">${escapeHtml(a.event)}</p>
          <p class="live-area">${escapeHtml(a.areaDesc)}</p>
          <p class="live-meta">${escapeHtml(a.severity)} · ${escapeHtml(a.certainty)} · ${escapeHtml(a.urgency)}</p>
        </div>
        <span class="live-age">${timeAgo(a.sent)}</span>
      </li>`,
    )
    .join("");
}

function renderTicker(features) {
  const counts = {};
  for (const { properties: p } of features) counts[p.event] = (counts[p.event] ?? 0) + 1;
  const items = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([event, n]) => `<span><b>${escapeHtml(event)}</b><i>×${n}</i></span>`)
    .join("");
  // Content is duplicated so the -50% marquee loops seamlessly.
  document.getElementById("ticker-track").innerHTML = items + items;
}

async function loadLive() {
  const updated = document.getElementById("live-updated");
  try {
    const [count, severe] = await Promise.all([
      getJson("/alerts/active/count"),
      getJson("/alerts/active?status=actual&severity=Extreme,Severe"),
    ]);
    const states = Object.keys(count.areas ?? {}).filter((code) => !MARINE_AREAS.has(code));

    document.getElementById("stat-total").textContent = count.land.toLocaleString();
    document.getElementById("stat-severe").textContent = severe.features.length.toLocaleString();
    document.getElementById("stat-states").textContent = states.length;
    renderAlerts(severe.features);
    renderTicker(severe.features);
    updated.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } catch (error) {
    updated.textContent = "Feed unavailable";
    document.getElementById("live-list").innerHTML =
      `<li class="live-error">Couldn’t reach the National Weather Service just now. Retrying in two minutes.</li>`;
    console.error(error);
  }
}

loadLive();
setInterval(loadLive, REFRESH_MS);

// ---------- posture selector ----------

const POSTURES = {
  normal: {
    x: "10%",
    trigger: "No active warnings for the facility zone; roads clear; no supplementary signal above threshold.",
    who: "Nobody. Silence is the right message on a normal day.",
    urgency: "None. Logged for the record only.",
  },
  delay: {
    x: "30%",
    trigger: "Hazard expected to clear mid-morning, e.g. a winter weather advisory ending after the commute.",
    who: "Everyone scheduled for the opening shift at this building.",
    urgency: "High. Must arrive before people leave home.",
  },
  early: {
    x: "50%",
    trigger: "Conditions forecast to deteriorate during the workday, e.g. a warning that begins this afternoon.",
    who: "Everyone currently on site, plus supervisors of later shifts.",
    urgency: "High. Sent with a hard departure time.",
  },
  telework: {
    x: "70%",
    trigger: "Warning in effect during commute hours, or road conditions degraded on main corridors.",
    who: "All assigned staff; teleworkers informed by email only; essential personnel get separate instructions.",
    urgency: "Critical. Delivered before the earliest shift starts.",
  },
  closed: {
    x: "90%",
    trigger: "Extreme alert for the facility zone, facility damage or utility loss, or unsafe access.",
    who: "Every assigned employee, essential personnel with reporting instructions, and regional leadership.",
    urgency: "Critical. Every channel, immediately.",
  },
};

const tabs = document.querySelectorAll(".posture-tab");
const detail = document.getElementById("posture-detail");

function selectPosture(key) {
  const posture = POSTURES[key];
  tabs.forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.posture === key)));
  document.getElementById("pd-trigger").textContent = posture.trigger;
  document.getElementById("pd-who").textContent = posture.who;
  document.getElementById("pd-urgency").textContent = posture.urgency;
  document.getElementById("posture-fill").style.setProperty("--x", posture.x);
  detail.classList.remove("swap");
  void detail.offsetWidth; // restart the entry animation
  detail.classList.add("swap");
}

tabs.forEach((tab) => tab.addEventListener("click", () => selectPosture(tab.dataset.posture)));
selectPosture("telework");

// ---------- scroll reveal ----------

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    }
  },
  { threshold: 0.15, rootMargin: "0px 0px -5% 0px" },
);
document.querySelectorAll(".reveal").forEach((el) => observer.observe(el));

// ---------- hero parallax: the giant word drifts behind the mountains ----------

const heroWord = document.querySelector(".hero-word");
if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
  addEventListener(
    "scroll",
    () => (heroWord.style.transform = `translateY(${Math.min(scrollY, 1000) * 0.35}px)`),
    { passive: true },
  );
}

// ---------- mobile menu ----------

const burger = document.querySelector(".burger");
const menu = document.getElementById("menu");

function setMenu(open) {
  burger.setAttribute("aria-expanded", String(open));
  burger.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  if (open) {
    menu.hidden = false;
    requestAnimationFrame(() => menu.classList.add("open"));
  } else {
    menu.classList.remove("open");
    setTimeout(() => (menu.hidden = true), 500);
  }
}

burger.addEventListener("click", () => setMenu(burger.getAttribute("aria-expanded") !== "true"));
menu.addEventListener("click", (event) => event.target.closest("a") && setMenu(false));
document.addEventListener("keydown", (event) => event.key === "Escape" && setMenu(false));

// ---------- copy rationale ----------

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const text = document.getElementById(button.dataset.copy).textContent.replace(/\s+/g, " ").trim();
    const label = button.querySelector("span");
    try {
      await navigator.clipboard.writeText(text);
      label.textContent = "Copied";
    } catch {
      label.textContent = "Select and copy";
    }
    setTimeout(() => (label.textContent = "Copy for email"), 2000);
  });
});
