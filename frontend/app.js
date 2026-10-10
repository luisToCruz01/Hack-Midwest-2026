const connectionStatus = document.querySelector("#connection-status");
const entriesList = document.querySelector("#entries");
const entryForm = document.querySelector("#entry-form");
const formMessage = document.querySelector("#form-message");

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();

  if (!response.ok) {
    throw new Error(body.error ?? `Request failed with status ${response.status}.`);
  }

  return body;
}

function renderEntries(entries) {
  entriesList.replaceChildren();

  if (entries.length === 0) {
    const emptyState = document.createElement("li");
    emptyState.className = "empty-state";
    emptyState.textContent = "No entries yet. Add one above to get started.";
    entriesList.append(emptyState);
    return;
  }

  for (const entry of entries) {
    const item = document.createElement("li");
    const title = document.createElement("h3");
    const description = document.createElement("p");

    item.className = "entry";
    title.textContent = entry.title;
    description.textContent = entry.description || "No description provided.";
    item.append(title, description);
    entriesList.append(item);
  }
}

async function loadEntries() {
  const entries = await requestJson("/api/entries");
  renderEntries(entries);
}

async function initialize() {
  try {
    const health = await requestJson("/api/health");
    connectionStatus.textContent = `API and database: ${health.database}`;
    await loadEntries();
  } catch (error) {
    connectionStatus.textContent = `Could not connect: ${error.message}`;
  }
}

entryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  formMessage.textContent = "";

  const formData = new FormData(entryForm);

  try {
    await requestJson("/api/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: formData.get("title"),
        description: formData.get("description"),
      }),
    });
    entryForm.reset();
    await loadEntries();
  } catch (error) {
    formMessage.textContent = error.message;
  }
});

initialize();
