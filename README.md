# Time Ledger

Punch-clock time tracker split across MFI, Genesis Diagnostics, and Milar Properties. Vanilla JS + Firebase Firestore (live sync across devices) + Google sign-in, deployed as a static PWA on GitHub Pages.

## Create the Firebase project

Go to https://console.firebase.google.com and add a project. Under Build, open Firestore Database and create a database in production mode. Under Build, open Authentication, Sign-in method, and enable Google. In Project settings, General, Your apps, add a Web app and copy the firebaseConfig object it gives you. Finally in Authentication, Settings, Authorized domains, add msloskey-i-want-that.github.io

## Fill in firebase-config.js

Paste the values from the previous step into firebase-config.js in this repo, and confirm ALLOWED_EMAIL is the Google account you will sign in with.

## Lock down Firestore

In Firestore Database, open Rules, and replace the contents with:

```
rules_version = '2';
service cloud.firestore {
match /databases/{database}/documents {
match /users/{userId}/{document=**} {
allow read, write: if request.auth != null && request.auth.uid == userId;
}
}
}
```

Click Publish.

## Turn on GitHub Pages

In Settings, Pages, set Source to Deploy from a branch, pick main and /(root), then Save. It goes live at https://msloskey-i-want-that.github.io/Time-Tracker-/

## What's inside

index.html and style.css hold the frosted-glass UI in the AI Ops Dashboard palette (lime and orange on near-black). app.js has all the logic: auth, Firestore listeners, timer, allocation, pay-period view, and tasks. firebase-config.js holds your project's public config plus the allowed sign-in email. manifest.json and sw.js make it installable and usable offline.
