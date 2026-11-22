const {
    applicationDefault,
    cert,
    getApps,
    initializeApp
} = require('firebase-admin/app');

const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
let firebaseApp = null;

if (serviceAccountJson) {
    let serviceAccount;
    let serviceAccountParseError = null;
    try {
        serviceAccount = JSON.parse(serviceAccountJson);
    } catch (error) {
        serviceAccountParseError = error;
        // Workaround: may mga env writers na nag-trim o nag-corrupt ng JSON at
        // nawawala ang huling closing brace. Subukan ng repair bago bumitaw.
        let repaired = String(serviceAccountJson).trim();
        if (repaired.startsWith('{') && !repaired.endsWith('}')) {
            repaired = repaired + '}';
        }
        try {
            serviceAccount = JSON.parse(repaired);
        } catch (repairError) {
            serviceAccount = null;
        }
    }

    if (serviceAccount) {
        firebaseApp = getApps().length
            ? getApps()[0]
            : initializeApp({ credential: cert(serviceAccount) });
    } else {
        console.warn('[FCM] FIREBASE_SERVICE_ACCOUNT is not a valid service-account JSON; push notifications are disabled.');
    }
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_PROJECT_ID) {
    const options = { credential: applicationDefault() };
    if (process.env.FIREBASE_PROJECT_ID) {
        options.projectId = process.env.FIREBASE_PROJECT_ID;
    }

    firebaseApp = getApps().length ? getApps()[0] : initializeApp(options);
} else {
    console.warn('[FCM] Firebase Admin is not configured; push notifications are disabled.');
}

module.exports = { firebaseApp };
