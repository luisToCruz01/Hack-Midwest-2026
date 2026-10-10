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

// ---------- odometer numbers (rolled into place by the reveal below) ----------

document.querySelectorAll(".odo").forEach((el) => {
  el.setAttribute("aria-label", el.dataset.value);
  el.innerHTML = [...el.dataset.value]
    .map((digit, i) => `<span class="odo-col" aria-hidden="true" style="--n: ${digit}; --delay: ${0.2 + i * 0.12}s">${
      "0123456789".split("").map((d) => `<span>${d}</span>`).join("")
    }</span>`)
    .join("");
});

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

// ---------- rain on glass ("How it works" background) ----------
// A blurred "mist" copy of the photo fills the canvas; each drop shows a sharper,
// flipped and shrunk patch of the photo, like a real lens of water on a window.

function rainOnGlass(canvas) {
  const ctx = canvas.getContext("2d");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const img = new Image();
  const mist = document.createElement("canvas");
  const sharp = document.createElement("canvas");
  // wipe: `wiped` is an alpha mask of where the fog was cleared; `clear` composites it
  const wiped = document.createElement("canvas");
  const clear = document.createElement("canvas");
  const wctx = wiped.getContext("2d");
  const cctx = clear.getContext("2d");
  let w = 0, h = 0, dpr = 1, drops = [], running = false, last = 0, pointer = null, fogClock = 0;

  function cover(target, filter, haze) {
    const c = target.getContext("2d");
    target.width = w * dpr;
    target.height = h * dpr;
    const s = Math.max(target.width / img.width, target.height / img.height) * 1.08;
    c.filter = filter;
    c.drawImage(img, (target.width - img.width * s) / 2, (target.height - img.height * s) / 2, img.width * s, img.height * s);
    c.filter = "none";
    if (haze) {
      c.fillStyle = haze;
      c.fillRect(0, 0, target.width, target.height);
    }
  }

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 1.5);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    cover(mist, `blur(${28 * dpr}px) saturate(0.7)`, "rgb(205 215 215 / 22%)");
    cover(sharp, `saturate(1.25) contrast(1.08)`);
    wiped.width = clear.width = canvas.width;
    wiped.height = clear.height = canvas.height;
    const count = Math.round((w * h) / 9000);
    drops = Array.from({ length: count }, () => spawn(Math.random() * h));
  }

  function spawn(y = -20) {
    const r = Math.random() < 0.7 ? 1.5 + Math.random() * 3 : 4 + Math.random() * 6;
    return { x: Math.random() * w, y, r, vy: 0, grow: Math.random() * 0.002 };
  }

  function drawDrop(d) {
    const x = d.x * dpr, y = d.y * dpr, r = d.r * dpr, ry = r * 1.12;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(x, y, r, ry, 0, 0, Math.PI * 2);
    ctx.clip();
    // refracted view: a wider patch of the sharp photo, flipped vertically
    const k = 4;
    ctx.translate(x, y);
    ctx.scale(1, -1);
    ctx.drawImage(sharp, x - r * k, y - r * k, r * k * 2, r * k * 2, -r, -ry, r * 2, ry * 2);
    ctx.restore();
    // rim shadow and highlight
    ctx.beginPath();
    ctx.ellipse(x, y, r, ry, 0, 0, Math.PI * 2);
    ctx.strokeStyle = r > 3 * dpr ? "rgb(0 0 0 / 28%)" : "rgb(255 255 255 / 18%)";
    ctx.lineWidth = Math.max(1, r * 0.12);
    ctx.stroke();
    if (r > 3 * dpr) {
      ctx.beginPath();
      ctx.arc(x - r * 0.3, y - ry * 0.4, r * 0.18, 0, Math.PI * 2);
      ctx.fillStyle = "rgb(255 255 255 / 55%)";
      ctx.fill();
    }
  }

  function step(dt) {
    const born = [];
    for (const d of drops) {
      d.r = Math.min(d.r + d.grow * dt, 12);
      if (d.r > 8) {
        d.vy = Math.min(d.vy + 0.0002 * d.r * dt, 0.08 + d.r * 0.015);
        d.x += (Math.random() - 0.5) * 0.4;
        // leave a trail of tiny droplets behind fast drops
        if (Math.random() < 0.15 * d.vy) born.push({ x: d.x, y: d.y - d.r, r: d.r * 0.22, vy: 0, grow: 0 });
        d.r -= 0.0008 * dt;
      }
      d.y += d.vy * dt;
    }
    // merge overlapping drops into the larger one
    drops.sort((a, b) => b.r - a.r);
    for (let i = 0; i < drops.length; i++) {
      const a = drops[i];
      if (a.dead) continue;
      for (let j = i + 1; j < drops.length; j++) {
        const b = drops[j];
        if (b.dead || Math.abs(a.x - b.x) > a.r + b.r || Math.abs(a.y - b.y) > a.r + b.r) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) < (a.r + b.r) * 0.8) {
          a.r = Math.min(Math.sqrt(a.r * a.r + b.r * b.r), 12);
          b.dead = true;
        }
      }
    }
    drops = drops.filter((d) => !d.dead && d.y - d.r < h && d.r > 0.6).concat(born.slice(0, 20));
    const target = Math.round((w * h) / 9000);
    while (drops.length < target) drops.push(spawn(Math.random() * h));
  }

  function wipe(x, y) {
    const r = 50 * dpr;
    const from = pointer ?? { x, y };
    const steps = Math.max(1, Math.ceil(Math.hypot(x - from.x, y - from.y) / (r / 4)));
    for (let i = 1; i <= steps; i++) {
      const px = from.x + ((x - from.x) * i) / steps;
      const py = from.y + ((y - from.y) * i) / steps;
      const g = wctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, "rgb(0 0 0 / 55%)");
      g.addColorStop(1, "rgb(0 0 0 / 0%)");
      wctx.fillStyle = g;
      wctx.fillRect(px - r, py - r, r * 2, r * 2);
    }
    pointer = { x, y };
  }

  function frame(t) {
    if (!running) return;
    const dt = Math.min(t - (last || t), 50);
    last = t;
    step(dt);
    // the fog creeps back over wiped glass; faded in chunks every 100ms because
    // tiny per-frame alphas round to zero on an 8-bit canvas and leave residue
    fogClock += dt;
    if (fogClock >= 100) {
      fogClock = 0;
      wctx.globalCompositeOperation = "destination-out";
      wctx.fillStyle = "rgb(0 0 0 / 5%)";
      wctx.fillRect(0, 0, wiped.width, wiped.height);
      wctx.globalCompositeOperation = "source-over";
    }
    ctx.drawImage(mist, 0, 0);
    // clear glass = sharp photo, kept only where the mask was wiped
    cctx.globalCompositeOperation = "copy";
    cctx.drawImage(sharp, 0, 0);
    cctx.globalCompositeOperation = "destination-in";
    cctx.drawImage(wiped, 0, 0);
    ctx.drawImage(clear, 0, 0);
    drops.forEach(drawDrop);
    requestAnimationFrame(frame);
  }

  img.onload = () => {
    resize();
    if (still) {
      ctx.drawImage(mist, 0, 0);
      drops.forEach(drawDrop);
      return;
    }
    // only animate while the section is on screen
    new IntersectionObserver(([entry]) => {
      running = entry.isIntersecting;
      last = 0;
      if (running) requestAnimationFrame(frame);
    }).observe(canvas);
    addEventListener("resize", resize);
    // listen on the section so wiping also works over the cards
    const area = canvas.parentElement;
    area.addEventListener("pointermove", (e) => {
      const box = canvas.getBoundingClientRect();
      wipe((e.clientX - box.left) * dpr, (e.clientY - box.top) * dpr);
    });
    area.addEventListener("pointerleave", () => (pointer = null));
  };
  img.src = canvas.dataset.src;
}

document.querySelectorAll("canvas.rain").forEach(rainOnGlass);

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
