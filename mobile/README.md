# Fieldcast Employee App

This is the native iOS and Android employee app. It uses the existing
`/api/login`, `/api/me`, `/api/location/consent`, `/api/location`, and
`/api/my/notifications` routes in `backend/server.py`.
The API URL must point to that main backend, which requires its PostgreSQL
`DATABASE_URL`; the standalone `backend/mobile_api.py` endpoint is read-only and
does not provide these app routes.

## Quick iPhone preview (no Apple Developer membership)

1. Install **Expo Go** from the iPhone App Store.
2. From this directory run `npm install`, then `npm run start:go`.
3. Put the iPhone and development computer on the same Wi-Fi network, open
   Expo Go, and scan the QR code shown in the terminal.
4. Sign in with a six-digit employee ID, then tap **Share my location**.

In Expo Go, the app checks location and can show local alerts while it is open.
It cannot run the app's location watcher in the background. Keep the app open
for location checks.

## Install a development build for background location

You can create the iPhone development build from Windows using Expo's cloud
builder; Xcode is not required locally. This requires an Expo account and an
Apple Developer Program membership to register and install an ad hoc build on
a physical iPhone.

1. Install Node.js and npm.
2. From this directory run `npm install`.
3. Sign in to Expo with `npm run eas:login`, then link this app to the Expo
   account with `npm run eas:init`.
4. Register the iPhone for internal installation with `npm run eas:register:ios`.
   Follow the link on the phone, install the requested device profile, and
   return to the terminal to finish registration.
5. Start the cloud build with `npm run build:ios:development`. On the first
   build, let EAS create or configure the iOS signing credentials when asked.
6. When the build completes, open its EAS install link on the registered
   iPhone and install Fieldcast Employee.
7. On the computer, run `npm start` in this folder. Open the development
   build on the iPhone while it is on the same network, or run
   `npm run start:tunnel` if your network blocks local device connections.

The app defaults to `https://hack-midwest-2026.onrender.com`. To use a
different backend, copy `.env.example` to `.env` and set
`EXPO_PUBLIC_API_URL` to its reachable URL. A phone cannot use `localhost` to
reach a server running on the development computer; use the computer's LAN
address for local testing, or an HTTPS deployment.

## Safe location demo

After signing in, tap **Start demo route** to preview a four-stop Kansas City
route. The displayed sample location advances every five seconds; tap **Stop
demo route** to pause it. This is an app-only preview: it does not use GPS,
change the emulator's location, or send coordinates to the backend. Demo mode
and real location sharing cannot run at the same time.

To test the app's actual GPS location watcher, use the Android Emulator's
**Extended controls > Location** to set a point or play a route, then use
**Share my location** in the app. That sends coordinates to the configured
backend, so use a test backend rather than production.

For Android, install Android Studio and an emulator or connect an Android
device, then run `npm run android`. Use a development build rather than Expo
Go to test background location.

## Location and alert behavior

Employees sign in with a six-digit ID. This is intentionally ID-only demo
authentication because that is all the current backend supports. It is not
safe for production employee accounts.

When an employee turns on sharing, the app requests location permission,
enables location consent on the server, and sends device coordinates to
`/api/location`. In Expo Go, updates run only while the app stays open. In a
development build, the app also requests background permission and starts a
native background location task. The backend checks the National Weather
Service for severe alerts near each reported location. Newly returned alerts
are shown in the app and scheduled as local device notifications. Turning
sharing off stops location updates and asks the server to delete the saved
location.

Background location is controlled by iOS and Android, and can be affected by
battery optimization, permission changes, connectivity, and device settings.
Force-quitting the app stops background monitoring; Android may not restart
the task until the employee opens the app again. The current backend's external
notification delivery is simulated unless `NOTIFY_WEBHOOK_URL` is configured,
so this app does not yet receive remote push alerts while its location task is
stopped.
