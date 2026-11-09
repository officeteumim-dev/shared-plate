# Shared Plate

Household reminders for two (or a few). One dashboard with three lanes: **Mine**, **Theirs** and **Shared**. Every task has one owner; a shared task has a **Take it** button so it lands on exactly one plate.

It's an installable web app (PWA): open it on your phone, add it to the home screen, and turn on notifications.

| Part | What it does |
| --- | --- |
| **Firebase Hosting** | Serves the app from `public/`. |
| **Firebase Auth** | Google sign-in and email-link sign-in, limited to an allowlist. |
| **Firestore** | Households and tasks, live on both phones, with an offline copy. |
| **Cloud Functions** | `sendReminders` (every 5 minutes) and `joinGroup` (joining by invite code). |
| **Cloud Messaging** | Push notifications on Android, and on iPhone (iOS 16.4+) once the app is on the home screen. |
| **GitHub Actions** | Tests on every push and pull request; deploys when `main` changes. |

No build step: plain HTML, CSS and JavaScript with the Firebase compat SDK from Google's CDN, the same approach as `sfsp-wgroup`.

## First-time setup

1. **Firebase project:** in the Firebase console, create a project and switch it to the **Blaze** plan (needed for the scheduled reminders; a household this size stays within the free allowance). Add a $5/month budget alert under Google Cloud → Billing → Budgets.
2. **Web app:** Project settings → Your apps → add a Web app (tick Firebase Hosting). Copy the `firebaseConfig` values into `public/config.js`.
3. **Sign-in:** Authentication → Sign-in method → turn on **Google**, and **Email/Password** with **Email link (passwordless sign-in)**.
4. **Database:** Firestore Database → Create database → production mode, location `nam5`.
5. **Push key:** Project settings → Cloud Messaging → Web Push certificates → Generate key pair. Copy the public key into `vapidKey` in `public/config.js`.
6. **Deploy credential:** Google Cloud console → IAM & Admin → Service accounts → create `github-deploy` with the roles *Firebase Admin*, *Cloud Functions Admin* and *Service Account User*. Keys → Add key → JSON. In GitHub: repository → Settings → Secrets and variables → Actions → New secret named `FIREBASE_SERVICE_ACCOUNT`, paste the whole JSON file.

The next push to `main` deploys everything. The app is then at `https://PROJECT_ID.web.app`.

If the first deploy complains about a missing API or permission, the error names it; enable it in Google Cloud and re-run the *Deploy* workflow.

## Who can sign up

Sign-up is limited to an allowlist kept in three places. Keep them the same:

- `public/config.js` → `allowlist`
- `firestore.rules` → `allowed()`
- `functions/index.js` → `ALLOWLIST`

To open sign-up later (Phase 3): set `allowlist` and `ALLOWLIST` to `null`, and change `allowed()` to `return signedIn();`.

## Using it

- **Start a household** after signing in, then share the invite link or 8-character code from Settings. The other person signs in and joins with it.
- **Add** with the button at the bottom right. Pick whose it is: you, them, or Shared. Due date, repeat and a note are optional.
- **Done:** tap the circle or swipe a task to the right. Undo from the message that appears, or from **Completed**.
- **Snooze** from a task's edit sheet. It disappears until that date (8am) and comes back with a notification.
- **Repeats:** finishing a repeating task puts the next one on the plate automatically.
- **Quiet hours** are per person (Settings). Reminders that land in them arrive when they end.

### iPhone

Notifications on iPhone only work after **Share → Add to Home Screen** in Safari (iOS 16.4 or newer). Open the app from the home screen, then Settings → Turn on notifications.

Email sign-in links open in Safari, which keeps a separate sign-in from the home screen app. On iPhone, **Continue with Google** inside the home screen app is the smoothest way in.

## How reminders work

Each task stores `notifyAt`: its due time, or its snooze date. The app sets it on every save. Every 5 minutes `sendReminders` finds tasks whose `notifyAt` has passed and:

- sends to the task's owner, or the person who took a shared task, or everyone for an unclaimed shared task;
- holds it for anyone in quiet hours and sends it to them when their quiet hours end;
- turns a snoozed task back to open;
- removes phone tokens that no longer work.

The decisions live in `public/logic.js` (`planReminder`), shared by the app, the server and the tests.

## Data

- `groups/{groupId}`: `name`, `createdBy`, `createdAt`, `members` (uid → `owner` | `member`), `names` (uid → display name), `inviteCode`
- `groups/{groupId}/tasks/{taskId}`: `title`, `notes`, `owner` (uid or `"shared"`), `claimedBy`, `claimedAt`, `status` (`open` | `snoozed` | `done`), `dueAt`, `showAgainOn`, `repeat` (`none` | `daily` | `weekly` | `monthly` | `{ every, unit, weekdays }`), `createdBy`, `createdAt`, `updatedAt`, `completedAt`, `completedBy`, plus reminder bookkeeping (`notifyAt`, `notifyOnly`, `notifyKind`) and repeat links (`nextId`, `repeatOf`)
- `users/{uid}`: `displayName`, `email`, `groupIds`, `tokens` (FCM token → `{ platform, updatedAt }`), `prefs` (`due`, `back`), `quiet` (`enabled`, `start`, `end`), `tz`

`names` lives on the group so each person can see the other's name without reading their private user record. Security rules: you can only read and write the households you belong to; only the owner manages members; your user record is yours alone.

## Tests

- `tests/` (app and logic): opens the app in preview mode (`/?preview`, a sample household with no sign-in) on a phone-sized screen and checks lanes, Take it, quick add, swipe to done, undo, repeats, snooze, settings, layout and tap targets.
  Run locally: `cd tests && npm install && npx playwright install chromium && npm test`
- `tests/rules/` (security rules): runs against the Firestore emulator. Needs Java.
  Run locally: `npm install --prefix tests/rules && npx firebase-tools emulators:exec --only firestore --project demo-shared-plate "npm --prefix tests/rules test"`

## Files

| File | What it is |
| --- | --- |
| `public/index.html`, `app.js`, `app.css` | The app |
| `public/logic.js` | Lanes, repeats, quiet hours and reminder decisions |
| `public/config.js` | Firebase settings, push key and allowlist |
| `public/sw.js` | Offline shell and push notifications |
| `functions/index.js` | Reminders and joining by code |
| `firestore.rules`, `firestore.indexes.json` | Database security and indexes |

## Later

- **Phase 2:** WhatsApp reminders (WhatsApp Cloud API or Twilio; needs a dedicated number and approved templates) and adding tasks by WhatsApp message. `planReminder` already returns who to tell and why, so a WhatsApp sender slots in next to push.
- **Phase 3:** open sign-up, privacy policy, terms, rate limits, account deletion.
- **Optional:** a daily digest endpoint for the morning brief.
- iMessage isn't possible (Apple offers no API); SMS through Twilio is the fallback.
