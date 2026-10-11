const loginForm = document.querySelector("#login-form");
const loginFeedback = document.querySelector("#login-feedback");

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = loginForm.querySelector("button[type='submit']");
  submitButton.disabled = true;
  loginFeedback.textContent = "Signing in...";

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: loginForm.elements.userId.value.trim() }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Login failed with HTTP ${response.status}.`);
    localStorage.setItem("fieldcastSessionToken", result.token);
    window.location.assign(result.isManager ? "./index.html" : "./employee.html");
  } catch (error) {
    loginFeedback.textContent = error instanceof Error ? error.message : "Unable to sign in.";
    submitButton.disabled = false;
  }
});
