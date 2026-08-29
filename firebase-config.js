// Paste the config object from Firebase Console → Project settings → Your apps → SDK setup.
// This file is safe to commit — these values are public identifiers, not secrets.
// Access control is enforced by Firestore security rules (see README.md), not by hiding this file.

export const firebaseConfig = {
    apiKey: "PASTE_ME",
    authDomain: "PASTE_ME.firebaseapp.com",
    projectId: "PASTE_ME",
    storageBucket: "PASTE_ME.appspot.com",
    messagingSenderId: "PASTE_ME",
    appId: "PASTE_ME",
};

// The Google account allowed to sign in. Anyone else who signs in will be
// signed back out immediately — this is a second lock on top of the
// Firestore rules, not a replacement for them.
export const ALLOWED_EMAIL = "msloskey@gmail.com"; // <-- change if needed
