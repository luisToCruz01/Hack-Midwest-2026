module.exports = {
  expo: {
    name: "Fieldcast Employee",
    slug: "fieldcast-employee",
    version: "1.0.0",
    orientation: "portrait",
    userInterfaceStyle: "light",
    newArchEnabled: true,
    ios: {
      bundleIdentifier: "com.fieldcast.employee",
      supportsTablet: true,
      infoPlist: {
        UIBackgroundModes: ["location"]
      }
    },
    android: {
      package: "com.fieldcast.employee",
      permissions: [
        "ACCESS_COARSE_LOCATION",
        "ACCESS_FINE_LOCATION",
        "ACCESS_BACKGROUND_LOCATION",
        "FOREGROUND_SERVICE",
        "FOREGROUND_SERVICE_LOCATION",
        "POST_NOTIFICATIONS"
      ]
    },
    plugins: [
      [
        "expo-location",
        {
          locationWhenInUsePermission: "Fieldcast uses your location to check for severe weather near you.",
          locationAlwaysAndWhenInUsePermission: "When sharing is on, Fieldcast checks your location in the background for severe weather alerts.",
          isIosBackgroundLocationEnabled: true,
          isAndroidBackgroundLocationEnabled: true,
          isAndroidForegroundServiceEnabled: true
        }
      ],
      [
        "expo-notifications",
        {
          defaultChannel: "weather-alerts",
          color: "#145b4b"
        }
      ],
      "expo-secure-store"
    ],
    extra: {
      apiUrl: process.env.EXPO_PUBLIC_API_URL || "https://hack-midwest-2026.onrender.com"
    }
  }
};
