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
    try {
        serviceAccount = JSON.parse(serviceAccountJson);
    } catch (error) {
        throw new Error('FIREBASE_SERVICE_ACCOUNT must contain valid service-account JSON.', { cause: error });
    }

    firebaseApp = getApps().length
        ? getApps()[0]
        : initializeApp({ credential: cert(serviceAccount) });
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
