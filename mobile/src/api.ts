import Constants from "expo-constants";

export const SESSION_TOKEN_KEY = "fieldcast.employee.session";

export type EmployeeProfile = {
  userId: string;
  name: string;
  locationSharing: boolean;
};

export type EmployeeNotification = {
  id: number;
  created_at: string;
  kind: string;
  message: string;
  status: string;
};

export type LocationAlert = {
  event?: string;
  message: string;
};

export type LocationUpdateResult = {
  nwsOk: boolean;
  checkedAt: string;
  newNotifications: LocationAlert[];
};

export function getApiBaseUrl(): string {
  const extra = Constants.expoConfig?.extra as { apiUrl?: string } | undefined;
  return (extra?.apiUrl ?? "").trim().replace(/\/+$/, "");
}

export async function apiRequest<T>(
  path: string,
  token?: string,
  init: RequestInit = {},
): Promise<T> {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) {
    throw new Error("Set EXPO_PUBLIC_API_URL in mobile/.env before starting the app.");
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new Error("Could not reach the Fieldcast server. Check its address and your network.");
  }

  const body = await response.text();
  let result: unknown;
  try {
    result = body ? JSON.parse(body) : {};
  } catch {
    throw new Error(`The Fieldcast server returned an invalid response (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const message =
      typeof result === "object" && result !== null && "error" in result
        ? String(result.error)
        : `Request failed with HTTP ${response.status}.`;
    throw new Error(message);
  }
  return result as T;
}
