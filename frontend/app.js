const navigationButtons = document.querySelectorAll("[data-page]");
const pageViews = document.querySelectorAll("[data-view]");
const employeeRows = document.querySelector("#employee-rows");
const employeeSearch = document.querySelector("#employee-search");
const employeeFilter = document.querySelector("#employee-filter");
const employeeDialog = document.querySelector("#employee-dialog");
const employeeForm = document.querySelector("#employee-form");
const scheduleDialog = document.querySelector("#schedule-dialog");
const scheduleForm = document.querySelector("#schedule-form");
const alertDialog = document.querySelector("#alert-dialog");
const alertForm = document.querySelector("#alert-form");

let employees = [
  { id: 1, name: "Alex Morgan", email: "alex.morgan@example.com", role: "Site Supervisor", status: "Active", added: "Oct 02, 2026", schedule: { days: ["Mon", "Tue", "Wed", "Thu", "Fri"], startTime: "07:00", endTime: "15:30" } },
  { id: 2, name: "Jordan Lee", email: "jordan.lee@example.com", role: "Safety Coordinator", status: "Active", added: "Sep 28, 2026", schedule: { days: ["Mon", "Tue", "Wed", "Thu", "Fri"], startTime: "08:00", endTime: "16:30" } },
  { id: 3, name: "Casey Patel", email: "casey.patel@example.com", role: "Equipment Operator", status: "Active", added: "Sep 21, 2026", schedule: { days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], startTime: "06:00", endTime: "14:30" } },
  { id: 4, name: "Riley Chen", email: "riley.chen@example.com", role: "Field Technician", status: "Inactive", added: "Sep 14, 2026", schedule: { days: ["Tue", "Wed", "Thu", "Fri", "Sat"], startTime: "09:00", endTime: "17:30" } },
];

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

let editingEmployeeId = null;
let editingScheduleEmployeeId = null;
let nextEmployeeId = 5;
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
}

function renderOverview() {
  const activeEmployees = employees.filter((employee) => employee.status === "Active").length;
  const openAlerts = alerts.filter((alert) => alert.status !== "Resolved").length;
  const addressParts = [workSite.city, workSite.state, workSite.postalCode].filter(Boolean);
  const streetAddress = workSite.address || "Address not set";
  const fullAddress = [streetAddress, addressParts.join(" ")].filter(Boolean).join("\n");

  document.querySelector("#employee-count").textContent = String(employees.length);
  document.querySelector("#active-employee-note").textContent = `${activeEmployees} active team member${activeEmployees === 1 ? "" : "s"}`;
  document.querySelector("#open-alert-count").textContent = String(openAlerts);
  document.querySelector("#nav-alert-count").textContent = String(openAlerts);
  document.querySelector("#overview-site-name").textContent = workSite.name || "Work site not set";
  document.querySelector("#site-city-summary").textContent = workSite.name || "Work site not set";
  document.querySelector("#site-address-summary").textContent = fullAddress;

  const siteAddressSummary = document.querySelector("#overview-site-address");
  siteAddressSummary.replaceChildren();
  const siteName = document.createElement("strong");
  const siteAddress = document.createElement("p");
  siteName.textContent = workSite.name || "Work site not set";
  siteAddress.textContent = [
    workSite.address,
    [workSite.city, workSite.state, workSite.postalCode].filter(Boolean).join(" "),
  ].filter(Boolean).join("\n") || "Address not set";
  siteAddressSummary.append(siteName, siteAddress);

  const siteDetails = document.querySelector("#overview-site-details");
  siteDetails.replaceChildren();
  const details = [
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
  const search = employeeSearch.value.trim().toLowerCase();
  const selectedStatus = employeeFilter.value;
  const filteredEmployees = employees.filter((employee) => {
    const matchesSearch = [employee.name, employee.email, employee.role]
      .some((value) => value.toLowerCase().includes(search));
    const matchesStatus = selectedStatus === "all" || employee.status === selectedStatus;
    return matchesSearch && matchesStatus;
  });

  employeeRows.replaceChildren();
  document.querySelector("#employee-empty").hidden = filteredEmployees.length > 0;

  for (const employee of filteredEmployees) {
    const row = document.createElement("tr");
    const personCell = document.createElement("td");
    const person = document.createElement("div");
    const avatar = document.createElement("span");
    const personCopy = document.createElement("div");
    const name = document.createElement("span");
    const email = document.createElement("span");
    const role = document.createElement("td");
    const schedule = document.createElement("td");
    const status = document.createElement("td");
    const statusPill = document.createElement("span");
    const date = document.createElement("td");
    const actions = document.createElement("td");
    const actionGroup = document.createElement("div");
    const editButton = document.createElement("button");
    const scheduleButton = document.createElement("button");
    const statusButton = document.createElement("button");

    person.className = "employee-cell";
    avatar.className = "avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = initials(employee.name);
    personCopy.className = "employee-copy";
    name.className = "employee-name";
    name.textContent = employee.name;
    email.className = "employee-email";
    email.textContent = employee.email;
    personCopy.append(name, email);
    person.append(avatar, personCopy);
    personCell.append(person);
    role.textContent = employee.role;
    schedule.textContent = describeSchedule(employee.schedule);
    statusPill.className = `status-pill status-${escapeClassName(employee.status)}`;
    statusPill.textContent = employee.status;
    status.append(statusPill);
    date.textContent = employee.added;
    actionGroup.className = "row-actions";
    editButton.className = "small-action";
    editButton.type = "button";
    editButton.dataset.editEmployee = String(employee.id);
    editButton.textContent = "Edit";
    scheduleButton.className = "small-action";
    scheduleButton.type = "button";
    scheduleButton.dataset.editSchedule = String(employee.id);
    scheduleButton.textContent = "Schedule";
    statusButton.className = "small-action";
    statusButton.type = "button";
    statusButton.dataset.toggleEmployee = String(employee.id);
    statusButton.textContent = employee.status === "Active" ? "Deactivate" : "Activate";
    actionGroup.append(editButton, scheduleButton, statusButton);
    actions.append(actionGroup);
    row.append(personCell, role, schedule, status, date, actions);
    employeeRows.append(row);
  }
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
}

function openEmployeeDialog(employee = null) {
  editingEmployeeId = employee?.id ?? null;
  employeeForm.reset();
  document.querySelector("#employee-feedback").textContent = "";
  document.querySelector("#employee-dialog-title").textContent = employee ? "Edit employee" : "Add employee";

  if (employee) {
    employeeForm.elements.name.value = employee.name;
    employeeForm.elements.email.value = employee.email;
    employeeForm.elements.role.value = employee.role;
  }

  employeeDialog.showModal();
  employeeForm.elements.name.focus();
}

function openScheduleDialog(employee) {
  editingScheduleEmployeeId = employee.id;
  scheduleForm.reset();
  document.querySelector("#schedule-feedback").textContent = "";
  document.querySelector("#schedule-employee-name").textContent = `Set work days and shift hours for ${employee.name}.`;
  document.querySelector("#schedule-dialog-title").textContent = `Schedule · ${employee.name}`;

  for (const dayInput of scheduleForm.querySelectorAll('input[name="days"]')) {
    dayInput.checked = employee.schedule.days.includes(dayInput.value);
  }
  scheduleForm.elements.startTime.value = employee.schedule.startTime;
  scheduleForm.elements.endTime.value = employee.schedule.endTime;
  scheduleDialog.showModal();
}

function formatToday() {
  return new Intl.DateTimeFormat("en", { month: "short", day: "2-digit", year: "numeric" }).format(new Date());
}

for (const button of navigationButtons) {
  button.addEventListener("click", () => setPage(button.dataset.page));
}

for (const button of document.querySelectorAll("[data-open-page]")) {
  button.addEventListener("click", () => setPage(button.dataset.openPage));
}

document.querySelector("#add-employee-button").addEventListener("click", () => openEmployeeDialog());
document.querySelector("#add-alert-button").addEventListener("click", () => {
  alertForm.reset();
  alertDialog.showModal();
  alertForm.elements.title.focus();
});

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});

employeeSearch.addEventListener("input", renderEmployees);
employeeFilter.addEventListener("change", renderEmployees);
document.querySelector("#alert-filter").addEventListener("change", renderAlerts);

employeeRows.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;

  if (target.dataset.editEmployee) {
    const employee = employees.find((item) => item.id === Number(target.dataset.editEmployee));
    if (employee) openEmployeeDialog(employee);
  }

  if (target.dataset.editSchedule) {
    const employee = employees.find((item) => item.id === Number(target.dataset.editSchedule));
    if (employee) openScheduleDialog(employee);
  }

  if (target.dataset.toggleEmployee) {
    const employee = employees.find((item) => item.id === Number(target.dataset.toggleEmployee));
    if (employee) {
      employee.status = employee.status === "Active" ? "Inactive" : "Active";
      renderAll();
    }
  }
});

document.querySelector("#alert-list").addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement) || !target.dataset.alertId) return;

  const alert = alerts.find((item) => item.id === Number(target.dataset.alertId));
  if (alert) {
    alert.status = target.dataset.alertStatus;
    renderAll();
  }
});

employeeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(employeeForm);
  const name = String(formData.get("name")).trim();
  const email = String(formData.get("email")).trim();
  const role = String(formData.get("role")).trim();
  const duplicateEmail = employees.some(
    (employee) => employee.email.toLowerCase() === email.toLowerCase() && employee.id !== editingEmployeeId,
  );

  if (duplicateEmail) {
    document.querySelector("#employee-feedback").textContent = "That email is already in the employee list.";
    return;
  }

  if (editingEmployeeId !== null) {
    const employee = employees.find((item) => item.id === editingEmployeeId);
    if (employee) Object.assign(employee, { name, email, role });
  } else {
    employees.unshift({
      id: nextEmployeeId++,
      name,
      email,
      role,
      status: "Active",
      added: formatToday(),
      schedule: { days: ["Mon", "Tue", "Wed", "Thu", "Fri"], startTime: "08:00", endTime: "16:30" },
    });
  }

  employeeDialog.close();
  renderAll();
});

scheduleForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const employee = employees.find((item) => item.id === editingScheduleEmployeeId);
  if (!employee) {
    document.querySelector("#schedule-feedback").textContent = "Employee not found. Close and try again.";
    return;
  }

  const formData = new FormData(scheduleForm);
  const days = formData.getAll("days").map(String);
  if (days.length === 0) {
    document.querySelector("#schedule-feedback").textContent = "Select at least one work day.";
    return;
  }

  employee.schedule = {
    days,
    startTime: String(formData.get("startTime")),
    endTime: String(formData.get("endTime")),
  };
  scheduleDialog.close();
  renderAll();
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
  const feedback = document.querySelector("#worksite-feedback");

  if (Boolean(latitude) !== Boolean(longitude)) {
    feedback.textContent = "Enter both coordinates, or leave both blank.";
    return;
  }

  workSite = Object.fromEntries(
    [...formData.entries()].map(([key, value]) => [key, String(value).trim()]),
  );
  feedback.textContent = "Work site details updated for this session.";
  renderOverview();
});

renderAll();
