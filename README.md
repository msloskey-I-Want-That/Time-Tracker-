# Time Ledger

Punch-clock time tracker split across MFI, Genesis Diagnostics, and Milar
Properties. Vanilla JS + Firebase Firestore (live sync across devices),
deployed as a static PWA on GitHub Pages. No login screen — this is a
personal single-user tool.

## Create the Firebase project

Go to https://console.firebase.google.com and add a project. Under Build,
open Firestore Database and create a database in production mode. In
Project settings, General, Your apps, add a Web app and copy the
firebaseConfig object it gives you — no Authentication setup needed;
this build has no login screen.

## Fill in firebase-config.js

Paste the values from the previous step into firebase-config.js in this repo.

## Firestore rules

There's no sign-in, so rules can't check "is this you" anymore. This app
writes everything under a fixed path (`ledger/mike/...`), so the simplest
rule scopes access to just that path rather than opening the whole database:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /ledger/mike/{document=**} {
      allow read, write: if true;
    }
  }
}
```

This means anyone who has this exact Firebase project's config AND knows
to look under `ledger/mike` could read or write your hours — there's no
password check. The real protection is that this URL and Firebase project
aren't linked from anywhere public. If that's not comfortable later, the
fix is adding Firebase Auth back (anonymous auth would even work, since
cross-device sync here doesn't depend on which account you're on — it's
the fixed path that makes it sync, not a login).

## GitHub Pages

Already live at https://msloskey-i-want-that.github.io/Time-Tracker-/
Settings, Pages, Source is set to "Deploy from a branch", main, /(root).

## What's inside

index.html and style.css hold the frosted-glass UI in the AI Ops Dashboard
palette (lime and orange on near-black). app.js has all the logic:
Firestore listeners, timer, allocation, pay-period view, and tasks.
firebase-config.js holds your project's public config. manifest.json and
sw.js make it installable and usable offline.

## How the sync works

Starting the clock writes `{running:true, startTs}` to a single Firestore
doc under the fixed path. Every device reading that doc updates live — so
you can start on desktop and the phone shows "Clocked in" within a second,
and stopping from either device works the same way. Stopping doesn't save
an entry yet — it opens the allocation panel (split hours across the
three companies) which is also stored in Firestore, so if you close the
tab mid-allocation it's still there when you reopen on any device.
