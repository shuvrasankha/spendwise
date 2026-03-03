# SpendWise - Daily Expense Tracker

## Quick Setup

### 1. Firebase Setup
1. Go to https://console.firebase.google.com
2. Create a new project
3. Enable Authentication > Email/Password + Google
4. Enable Firestore Database
5. Go to Project Settings > Your apps > Add Web App > copy firebaseConfig

### 2. Add Your Config to app.js
Replace the placeholder at the top of app.js:
```
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
```

### 3. Firestore Security Rules
In Firebase Console > Firestore > Rules, paste:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /expenses/{doc} {
      allow read, write: if request.auth != null && request.auth.uid == resource.data.uid;
      allow create: if request.auth != null && request.auth.uid == request.resource.data.uid;
    }
  }
}
```

### 4. Deploy to Netlify
1. Push this folder to GitHub
2. Go to netlify.com > New site from Git
3. Connect your repo and deploy

## Features
- Email/Password + Google Sign In
- Add expenses (amount, category, date, payment method, notes)
- Dashboard with Daily / Weekly / Monthly / Yearly view
- Summary cards showing spending totals
- CSV export for any time period
- Dark / Light mode toggle
- Client-side XOR encryption on sensitive fields
- Fully responsive for mobile and desktop
