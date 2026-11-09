// Shared Plate settings. Loaded by the app (index.html) and the service worker (sw.js).
// These values are safe to publish: your data is protected by firestore.rules, not by hiding this file.
(function () {
  // Firebase console → Project settings → Your apps → Web app → "firebaseConfig". Paste the values here.
  const FIREBASE = {
    apiKey: "AIzaSyDIXBlpfcQjpLwa_MV_MDFo6rWLXAeiuoc",
    authDomain: "shared-plate144.firebaseapp.com",
    projectId: "shared-plate144",
    storageBucket: "shared-plate144.firebasestorage.app",
    messagingSenderId: "700423968820",
    appId: "1:700423968820:web:32b393c28b998f82345261"
  };
  // Firebase console → Project settings → Cloud Messaging → Web Push certificates → "Key pair" (the public key).
  const VAPID_KEY = "";

  self.SP_CONFIG = {
    firebase: FIREBASE,
    vapidKey: VAPID_KEY,
    configured: !!FIREBASE.apiKey && !!FIREBASE.projectId,
    // Who may sign up. Keep the same list in firestore.rules (allowed()) and functions/index.js (ALLOWLIST).
    // To open sign-up to everyone later (Phase 3), set this to null and follow the notes in those two files.
    allowlist: [
      "office.teumim@gmail.com"
    ],
    // Unclaimed shared tasks older than this get a gentle nudge on the dashboard.
    nudgeAfterHours: 24
  };
})();
