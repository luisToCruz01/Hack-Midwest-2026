import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import * as TaskManager from "expo-task-manager";
import Constants from "expo-constants";
import { apiRequest, LocationUpdateResult, SESSION_TOKEN_KEY } from "./api";

export const LOCATION_TASK_NAME = "fieldcast-background-location";
const isExpoGo = Constants.appOwnership === "expo";
let foregroundSubscription: Location.LocationSubscription | null = null;

export type LocationSharingResult = {
  notificationsEnabled: boolean;
  backgroundEnabled: boolean;
};

async function notifyForAlerts(alerts: LocationUpdateResult["newNotifications"]) {
  for (const alert of alerts) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: alert.event || "Weather alert near you",
        body: alert.message,
        sound: "default",
      },
      trigger: null,
    });
  }
}

async function submitLocation(
  token: string,
  coords: Pick<Location.LocationObjectCoords, "latitude" | "longitude">,
) {
  const result = await apiRequest<LocationUpdateResult>("/api/location", token, {
    method: "POST",
    body: JSON.stringify({ lat: coords.latitude, lon: coords.longitude }),
  });
  await notifyForAlerts(result.newNotifications ?? []);
}

TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.error("Background location task failed:", error.message);
    return;
  }

  const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations;
  const latest = locations?.[locations.length - 1];
  if (!latest) return;

  try {
    const token = await SecureStore.getItemAsync(SESSION_TOKEN_KEY);
    if (!token) return;
    await submitLocation(token, latest.coords);
  } catch (taskError) {
    console.error("Unable to check weather for the latest location:", taskError);
  }
});

export async function isLocationTaskRunning(): Promise<boolean> {
  return foregroundSubscription !== null || Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
}

export async function startLocationSharing(token: string): Promise<LocationSharingResult> {
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (!foreground.granted) {
    throw new Error("Allow location access while using the app to start weather monitoring.");
  }

  const background = isExpoGo
    ? { granted: false }
    : await Location.requestBackgroundPermissionsAsync();

  await Notifications.setNotificationChannelAsync("weather-alerts", {
    name: "Weather alerts",
    importance: Notifications.AndroidImportance.HIGH,
    sound: "default",
  });
  const notificationPermission = await Notifications.requestPermissionsAsync();
  if (!notificationPermission.granted) {
    console.warn("Weather notifications are disabled for this device.");
  }

  await apiRequest("/api/location/consent", token, {
    method: "POST",
    body: JSON.stringify({ consent: true }),
  });

  try {
    const current = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });
    await submitLocation(token, current.coords);

    if (background.granted) {
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: Location.Accuracy.High,
        timeInterval: 30_000,
        distanceInterval: 0,
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
        activityType: Location.ActivityType.Other,
        foregroundService: {
          notificationTitle: "Fieldcast weather monitoring is on",
          notificationBody: "Your location is checked for severe weather while sharing is enabled.",
          killServiceOnDestroy: false,
        },
      });
    } else {
      foregroundSubscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          timeInterval: 30_000,
          distanceInterval: 0,
        },
        (location) => {
          void submitLocation(token, location.coords).catch((error: unknown) => {
            console.error("Unable to check weather for the latest location:", error);
          });
        },
      );
    }
    return {
      notificationsEnabled: notificationPermission.granted,
      backgroundEnabled: background.granted,
    };
  } catch (error) {
    const cleanupErrors: string[] = [];
    try {
      foregroundSubscription?.remove();
      foregroundSubscription = null;
      if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)) {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      }
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
    }
    try {
      await apiRequest("/api/location/consent", token, {
        method: "POST",
        body: JSON.stringify({ consent: false }),
      });
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
    }
    if (cleanupErrors.length > 0) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Cleanup also failed: ${cleanupErrors.join("; ")}`,
      );
    }
    throw error;
  }
}

export async function stopLocationSharing(token: string): Promise<void> {
  foregroundSubscription?.remove();
  foregroundSubscription = null;
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
  }
  await apiRequest("/api/location/consent", token, {
    method: "POST",
    body: JSON.stringify({ consent: false }),
  });
}
