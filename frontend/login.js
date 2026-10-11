const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const loginSubmit = document.querySelector("#login-submit");

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.hidden = true;
  loginSubmit.disabled = true;

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: loginForm.elements.userId.value.trim() }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Login failed (HTTP ${response.status}).`);

    sessionStorage.setItem("fieldcastToken", result.token);
    sessionStorage.setItem("fieldcastUser", JSON.stringify({ name: result.name, isManager: result.isManager }));
    window.location.replace(result.isManager ? "./index.html" : "./employee.html");
  } catch (error) {
    loginError.textContent = error.message;
    loginError.hidden = false;
  } finally {
    loginSubmit.disabled = false;
  }
});