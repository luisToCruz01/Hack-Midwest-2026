import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { StatusBar } from "expo-status-bar";
import {
  apiRequest,
  EmployeeNotification,
  EmployeeProfile,
  SESSION_TOKEN_KEY,
} from "./src/api";
import {
  isLocationTaskRunning,
  startLocationSharing,
  stopLocationSharing,
} from "./src/tracking";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

const DEMO_ROUTE = [
  { name: "Downtown", latitude: 39.0997, longitude: -94.5786 },
  { name: "Crossroads", latitude: 39.0918, longitude: -94.5817 },
  { name: "Union Station", latitude: 39.0842, longitude: -94.585 },
  { name: "Crown Center", latitude: 39.0848, longitude: -94.5803 },
] as const;
const DEMO_INTERVAL_MS = 5_000;

export default function App() {
  const [employeeId, setEmployeeId] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [profile, setProfile] = useState<EmployeeProfile | null>(null);
  const [notifications, setNotifications] = useState<EmployeeNotification[]>([]);
  const [sharing, setSharing] = useState(false);
  const [demoActive, setDemoActive] = useState(false);
  const [demoLocationIndex, setDemoLocationIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(true);
  const [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [feedbackIsError, setFeedbackIsError] = useState(false);

  const refreshNotifications = useCallback(async (sessionToken: string) => {
    const items = await apiRequest<EmployeeNotification[]>("/api/my/notifications", sessionToken);
    setNotifications(items);
  }, []);

  const loadProfile = useCallback(async (sessionToken: string) => {
    const current = await apiRequest<EmployeeProfile>("/api/me", sessionToken);
    setProfile(current);
    const taskRunning = await isLocationTaskRunning();
    if (current.locationSharing && taskRunning) {
      setSharing(true);
    } else {
      setSharing(false);
      if (current.locationSharing) {
        await apiRequest("/api/location/consent", sessionToken, {
          method: "POST",
          body: JSON.stringify({ consent: false }),
        });
      }
    }
    await refreshNotifications(sessionToken);
  }, [refreshNotifications]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const savedToken = await SecureStore.getItemAsync(SESSION_TOKEN_KEY);
        if (savedToken) {
          await loadProfile(savedToken);
          if (alive) setToken(savedToken);
        }
      } catch (error) {
        await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
        if (alive) setFeedback(error instanceof Error ? error.message : "Unable to restore the session.");
        if (alive) setFeedbackIsError(true);
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [loadProfile]);

  useEffect(() => {
    if (!token || !sharing) return;
    const timer = setInterval(() => {
      refreshNotifications(token).catch((error: unknown) => {
        console.warn("Unable to refresh weather notifications:", error);
      });
    }, 60_000);
    return () => clearInterval(timer);
  }, [refreshNotifications, sharing, token]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && token) {
        refreshNotifications(token).catch((error: unknown) => {
          console.warn("Unable to refresh weather notifications:", error);
        });
      }
    });
    return () => subscription.remove();
  }, [refreshNotifications, token]);

  useEffect(() => {
    if (!demoActive) return;
    const timer = setInterval(() => {
      setDemoLocationIndex((currentIndex) => (
        currentIndex === null ? 0 : (currentIndex + 1) % DEMO_ROUTE.length
      ));
    }, DEMO_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [demoActive]);

  async function signIn() {
    const userId = employeeId.trim();
    if (!/^\d{6}$/.test(userId)) {
      setFeedback("Enter your six-digit employee ID.");
      setFeedbackIsError(true);
      return;
    }
    setWorking(true);
    setFeedback("");
    try {
      const result = await apiRequest<{ token: string }>("/api/login", undefined, {
        method: "POST",
        body: JSON.stringify({ userId }),
      });
      await SecureStore.setItemAsync(SESSION_TOKEN_KEY, result.token);
      await loadProfile(result.token);
      setToken(result.token);
      setFeedback("");
      setFeedbackIsError(false);
    } catch (error) {
      await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
      setFeedback(error instanceof Error ? error.message : "Unable to sign in.");
      setFeedbackIsError(true);
    } finally {
      setWorking(false);
    }
  }

  async function toggleSharing() {
    if (!token) return;
    if (!sharing && demoActive) {
      setFeedback("Stop the demo route before starting real location sharing.");
      setFeedbackIsError(true);
      return;
    }
    setWorking(true);
    setFeedback("");
    try {
      if (sharing) {
        await stopLocationSharing(token);
        setSharing(false);
        setProfile((current) => current ? { ...current, locationSharing: false } : current);
        setFeedback("Location sharing is off. Your last saved location was removed.");
        setFeedbackIsError(false);
      } else {
        const result = await startLocationSharing(token);
        setSharing(true);
        setProfile((current) => current ? { ...current, locationSharing: true } : current);
        const monitoringMessage = result.backgroundEnabled
          ? "Weather monitoring is on in the background."
          : "Weather checks will continue while this app stays open; background tracking needs an iOS development build.";
        const notificationMessage = result.notificationsEnabled
          ? "Alerts will appear in the app and as device notifications."
          : "Device notifications are disabled in system settings.";
        setFeedback(`${monitoringMessage} ${notificationMessage}`);
        setFeedbackIsError(false);
        await refreshNotifications(token);
      }
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Unable to change location sharing.");
      setFeedbackIsError(true);
      const taskRunning = await isLocationTaskRunning().catch(() => false);
      setSharing(taskRunning);
    } finally {
      setWorking(false);
    }
  }

  function toggleDemoRoute() {
    if (demoActive) {
      setDemoActive(false);
      setFeedback("Demo route stopped. No location was sent to the server.");
    } else if (sharing) {
      setFeedback("Stop real location sharing before starting the demo route.");
      setFeedbackIsError(true);
      return;
    } else {
      setDemoLocationIndex(0);
      setDemoActive(true);
      setFeedback("Demo route started. Sample locations stay on this screen and are not sent to the server.");
    }
    setFeedbackIsError(false);
  }

  async function signOut() {
    if (!token) return;
    setWorking(true);
    setFeedback("");
    try {
      await stopLocationSharing(token);
    } catch (error) {
      setFeedback(
        error instanceof Error
          ? `Sharing was stopped on this device, but the server could not confirm sign-out: ${error.message}`
          : "Sharing was stopped on this device, but the server could not confirm sign-out.",
      );
      setFeedbackIsError(true);
    } finally {
      await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
      setDemoActive(false);
      setDemoLocationIndex(null);
      setToken(null);
      setProfile(null);
      setNotifications([]);
      setSharing(false);
      setWorking(false);
    }
  }

  if (busy) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#145b4b" />
        <Text style={styles.loadingText}>Loading Fieldcast…</Text>
        <StatusBar style="dark" />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.brandRow}>
          <View style={styles.brandMark}><Text style={styles.brandMarkText}>F</Text></View>
          <View>
            <Text style={styles.brandName}>Fieldcast</Text>
            <Text style={styles.brandCaption}>EMPLOYEE WEATHER SAFETY</Text>
          </View>
        </View>

        {!token ? (
          <View style={styles.card}>
            <Text style={styles.eyebrow}>EMPLOYEE ACCESS</Text>
            <Text style={styles.heading}>Sign in</Text>
            <Text style={styles.body}>
              Use your six-digit employee ID to access location-based weather alerts.
            </Text>
            <TextInput
              accessibilityLabel="Six-digit employee ID"
              style={styles.input}
              value={employeeId}
              onChangeText={setEmployeeId}
              placeholder="Employee ID"
              keyboardType="number-pad"
              maxLength={6}
              autoComplete="off"
              textContentType="none"
            />
            <PrimaryButton label="Continue" onPress={signIn} busy={working} />
            <Text style={styles.demoNote}>
              Demo sign-in uses the employee ID only. Do not use this authentication method for real employee data.
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.welcome}>
              <Text style={styles.eyebrow}>YOUR SAFETY CHECK-IN</Text>
              <Text style={styles.heading}>Hello, {profile?.name || "employee"}</Text>
              <Text style={styles.body}>
                Share your location to check National Weather Service alerts for where you are.
              </Text>
            </View>

            <View style={[styles.statusCard, sharing ? styles.statusOn : styles.statusOff]}>
              <View style={styles.statusTop}>
                <View style={[styles.statusDot, sharing ? styles.dotOn : styles.dotOff]} />
                <Text style={styles.statusTitle}>
                  {sharing ? "Weather monitoring is on" : "Location sharing is off"}
                </Text>
              </View>
              <Text style={styles.statusDescription}>
                {sharing
                  ? "Your device checks your current area for severe weather, including while the app is in the background."
                  : "Turn sharing on when you want location-based weather checks and alerts."}
              </Text>
              <PrimaryButton
                label={sharing ? "Stop sharing location" : "Share my location"}
                onPress={toggleSharing}
                busy={working}
                disabled={!sharing && demoActive}
                danger={sharing}
              />
              <Text style={styles.permissionNote}>
                Background updates depend on your device permissions, battery settings, and operating system. Force-quitting the app can stop monitoring.
              </Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.eyebrow}>SAFE DEMO</Text>
              <Text style={styles.sectionTitle}>Moving location preview</Text>
              <Text style={styles.body}>
                Preview a sample Kansas City route. The location changes every 5 seconds and stays on this screen; it does not use GPS or send data to the server.
              </Text>
              {demoLocationIndex !== null ? (
                <View style={styles.demoLocation}>
                  <View style={styles.demoLocationHeader}>
                    <View style={styles.demoBadge}>
                      <Text style={styles.demoBadgeText}>DEMO ONLY</Text>
                    </View>
                    <Text style={styles.demoProgress}>
                      STOP {demoLocationIndex + 1} OF {DEMO_ROUTE.length}
                    </Text>
                  </View>
                  <Text style={styles.demoPlace}>{DEMO_ROUTE[demoLocationIndex].name}</Text>
                  <Text style={styles.demoCoordinates}>
                    {DEMO_ROUTE[demoLocationIndex].latitude.toFixed(4)}, {DEMO_ROUTE[demoLocationIndex].longitude.toFixed(4)}
                  </Text>
                  <View style={styles.routeRow}>
                    {DEMO_ROUTE.map((point, index) => (
                      <View
                        key={point.name}
                        style={[
                          styles.routeSegment,
                          index <= demoLocationIndex && styles.routeSegmentVisited,
                        ]}
                      />
                    ))}
                  </View>
                  <Text style={styles.routeLabels}>
                    {DEMO_ROUTE.map((point) => point.name).join("  ·  ")}
                  </Text>
                </View>
              ) : null}
              <PrimaryButton
                label={demoActive ? "Stop demo route" : "Start demo route"}
                onPress={toggleDemoRoute}
                busy={working}
                disabled={sharing}
                danger={demoActive}
              />
              <Text style={styles.permissionNote}>
                This preview is separate from real location sharing. To test actual GPS updates, use the Android emulator’s Extended controls → Location.
              </Text>
            </View>

            <View style={styles.card}>
              <View style={styles.sectionHeader}>
                <View>
                  <Text style={styles.eyebrow}>PERSONAL WEATHER</Text>
                  <Text style={styles.sectionTitle}>Recent alerts</Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => token && refreshNotifications(token).catch((error: unknown) => {
                    setFeedback(error instanceof Error ? error.message : "Unable to refresh alerts.");
                    setFeedbackIsError(true);
                  })}
                >
                  <Text style={styles.refresh}>Refresh</Text>
                </Pressable>
              </View>
              {notifications.length === 0 ? (
                <Text style={styles.empty}>No personal alerts yet. Keep sharing on to check your current area.</Text>
              ) : notifications.map((item) => (
                <View key={item.id} style={styles.alertItem}>
                  <View style={styles.alertIcon}><Text style={styles.alertIconText}>!</Text></View>
                  <View style={styles.alertCopy}>
                    <Text style={styles.alertKind}>{item.kind.replaceAll("_", " ").toUpperCase()}</Text>
                    <Text style={styles.alertMessage}>{item.message}</Text>
                    <Text style={styles.alertTime}>{formatDate(item.created_at)}</Text>
                  </View>
                </View>
              ))}
            </View>

            <Pressable
              accessibilityRole="button"
              disabled={working}
              onPress={signOut}
              style={styles.signOut}
            >
              <Text style={styles.signOutText}>Sign out</Text>
            </Pressable>
          </>
        )}

        {feedback ? (
          <Text style={[styles.feedback, feedbackIsError && styles.feedbackError]}>{feedback}</Text>
        ) : null}
        <Text style={styles.footer}>
          Location is used to check weather at your current area. Turn sharing off any time to stop updates and clear your saved location.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function PrimaryButton({
  label,
  onPress,
  busy,
  disabled = false,
  danger = false,
}: {
  label: string;
  onPress: () => void;
  busy: boolean;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={busy || disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        danger ? styles.buttonDanger : styles.buttonPrimary,
        pressed && styles.buttonPressed,
        (busy || disabled) && styles.buttonDisabled,
      ]}
    >
      {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{label}</Text>}
    </Pressable>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f3f7f5" },
  content: { flexGrow: 1, width: "100%", maxWidth: 560, alignSelf: "center", padding: 22, paddingTop: 56 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#f3f7f5", gap: 12 },
  loadingText: { color: "#5b6d66", fontSize: 15 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 34 },
  brandMark: { width: 46, height: 46, borderRadius: 15, backgroundColor: "#145b4b", alignItems: "center", justifyContent: "center" },
  brandMarkText: { color: "#fff", fontWeight: "800", fontSize: 24 },
  brandName: { color: "#163a31", fontWeight: "800", fontSize: 21, letterSpacing: -0.4 },
  brandCaption: { color: "#71817a", fontSize: 9, fontWeight: "800", letterSpacing: 1.4, marginTop: 3 },
  card: { backgroundColor: "#fff", borderColor: "#e2ebe6", borderWidth: 1, borderRadius: 22, padding: 22, marginBottom: 16 },
  eyebrow: { color: "#668078", fontSize: 10, fontWeight: "800", letterSpacing: 1.5, marginBottom: 8 },
  heading: { color: "#183a31", fontSize: 30, fontWeight: "800", letterSpacing: -0.8, marginBottom: 8 },
  body: { color: "#62746d", fontSize: 15, lineHeight: 22, marginBottom: 20 },
  input: { borderWidth: 1, borderColor: "#d6e2dc", borderRadius: 13, paddingVertical: 15, paddingHorizontal: 16, fontSize: 17, color: "#173b31", backgroundColor: "#fbfdfc", marginBottom: 13 },
  button: { borderRadius: 13, minHeight: 52, paddingVertical: 14, paddingHorizontal: 18, alignItems: "center", justifyContent: "center" },
  buttonPrimary: { backgroundColor: "#145b4b" },
  buttonDanger: { backgroundColor: "#9c3a36" },
  buttonText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  buttonPressed: { opacity: 0.86, transform: [{ scale: 0.99 }] },
  buttonDisabled: { opacity: 0.65 },
  demoNote: { color: "#936b28", backgroundColor: "#fff8e8", borderRadius: 10, padding: 12, marginTop: 15, fontSize: 12, lineHeight: 18 },
  welcome: { marginBottom: 8 },
  statusCard: { borderRadius: 22, borderWidth: 1, padding: 20, marginBottom: 16 },
  statusOn: { backgroundColor: "#e8f4ed", borderColor: "#c8e4d2" },
  statusOff: { backgroundColor: "#fff", borderColor: "#e2ebe6" },
  statusTop: { flexDirection: "row", alignItems: "center", gap: 9, marginBottom: 9 },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  dotOn: { backgroundColor: "#20845e" },
  dotOff: { backgroundColor: "#89958f" },
  statusTitle: { color: "#183a31", fontWeight: "800", fontSize: 16 },
  statusDescription: { color: "#62746d", fontSize: 14, lineHeight: 21, marginBottom: 16 },
  permissionNote: { color: "#71817a", fontSize: 11, lineHeight: 16, marginTop: 12 },
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 15 },
  sectionTitle: { color: "#183a31", fontWeight: "800", fontSize: 21 },
  demoLocation: { backgroundColor: "#f0f7f3", borderColor: "#d5e7dc", borderWidth: 1, borderRadius: 14, padding: 15, marginBottom: 14 },
  demoLocationHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  demoBadge: { backgroundColor: "#fff0d1", borderRadius: 8, paddingVertical: 5, paddingHorizontal: 8 },
  demoBadgeText: { color: "#8a5a14", fontSize: 9, fontWeight: "900", letterSpacing: 0.8 },
  demoProgress: { color: "#668078", fontSize: 10, fontWeight: "800", letterSpacing: 0.8 },
  demoPlace: { color: "#183a31", fontSize: 20, fontWeight: "800", marginBottom: 3 },
  demoCoordinates: { color: "#62746d", fontVariant: ["tabular-nums"], fontSize: 13 },
  routeRow: { flexDirection: "row", gap: 4, marginTop: 16, marginBottom: 7 },
  routeSegment: { flex: 1, height: 5, borderRadius: 3, backgroundColor: "#dce7e1" },
  routeSegmentVisited: { backgroundColor: "#20845e" },
  routeLabels: { color: "#71817a", fontSize: 10, lineHeight: 15 },
  refresh: { color: "#145b4b", fontWeight: "800", fontSize: 13, padding: 8 },
  empty: { color: "#71817a", fontSize: 14, lineHeight: 21, paddingVertical: 8 },
  alertItem: { flexDirection: "row", gap: 12, paddingVertical: 14, borderTopWidth: 1, borderTopColor: "#edf1ee" },
  alertIcon: { width: 30, height: 30, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: "#fff0e8" },
  alertIconText: { color: "#a64f27", fontWeight: "900", fontSize: 16 },
  alertCopy: { flex: 1 },
  alertKind: { color: "#a64f27", fontSize: 10, fontWeight: "800", letterSpacing: 1, marginBottom: 5 },
  alertMessage: { color: "#30473e", fontSize: 14, lineHeight: 20 },
  alertTime: { color: "#89958f", fontSize: 11, marginTop: 6 },
  signOut: { alignSelf: "center", padding: 14 },
  signOutText: { color: "#586c63", fontWeight: "700" },
  feedback: { backgroundColor: "#e8f4ed", color: "#20573f", borderRadius: 12, padding: 13, fontSize: 13, lineHeight: 19, marginBottom: 14 },
  feedbackError: { backgroundColor: "#fff0ee", color: "#923d37" },
  footer: { color: "#7e8c85", textAlign: "center", fontSize: 11, lineHeight: 17, marginTop: 14, marginBottom: 24 },
});
