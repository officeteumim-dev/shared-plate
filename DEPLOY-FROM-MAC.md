# Publishing Shared Plate from your Mac

Use this while GitHub isn't available. It publishes the app, the database rules and the reminder job to Firebase project `shared-plate144`.

## Once

1. Install Node.js: go to https://nodejs.org, download the **LTS** installer for macOS, and run it.
2. Unzip `shared-plate.zip` into your Documents folder. You'll get a folder called `shared-plate`.
3. Open **Terminal** (press Cmd+Space, type Terminal, press Return).
4. Paste these lines one at a time and press Return after each:

   ```
   cd ~/Documents/shared-plate
   npm install --prefix functions
   npx firebase-tools login
   ```

   The last one opens your browser. Sign in with the Google account that owns the Firebase project and click **Allow**. If Terminal asks whether to install `firebase-tools` or to share usage information, answer `y` and then `n`.

## Every time you publish

In Terminal:

```
cd ~/Documents/shared-plate
npx firebase-tools deploy
```

It takes a few minutes. When it says **Deploy complete!**, the app is live at https://shared-plate144.web.app

## If something goes wrong

- **The first deploy fails, mentioning an API, Eventarc, Cloud Scheduler or permissions:** Google is still switching on services for the new project. Wait 5 minutes and run `npx firebase-tools deploy` again.
- **It mentions billing or the Blaze plan:** the project needs to be on Blaze (Firebase console → Upgrade).
- **Anything else:** copy the last 20 lines Terminal printed and send them to Claude.
