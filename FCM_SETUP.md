# Firebase Cloud Messaging setup

The backend sends an FCM push when an order's status changes. The Flutter app
must request notification permission, obtain an FCM device token, and register
it for its active table session:

```http
POST /api/v1/customer/sessions/{session_id}/fcm-token
Authorization: Bearer {session_token}
Content-Type: application/json

{"fcm_token":"{device_fcm_token}"}
```

Use the `session_token` returned by `/api/session/scan/{qr_token}`. Register
the token again when Firebase refreshes it or when a new table session starts.
Tokens are stored per session and removed automatically when that session is
closed or deleted.

Before deploying, run [`migrations/20261107_add_customer_fcm_tokens.sql`](./migrations/20261107_add_customer_fcm_tokens.sql)
against a fresh backend database. If the earlier FCM migration was already
applied with the `fcm_token` column, run
[`migrations/20261107_align_customer_fcm_tokens.sql`](./migrations/20261107_align_customer_fcm_tokens.sql)
instead. The same table definition is included in `schema.sql` for fresh
installations.

Configure Firebase Admin on the backend using either:

- `FIREBASE_SERVICE_ACCOUNT`: the service-account JSON as an environment
  variable; or
- `GOOGLE_APPLICATION_CREDENTIALS`: the path to a service-account JSON file.
  For application-default credentials without that path, set
  `FIREBASE_PROJECT_ID` as well.

Never commit a service-account key. If no Firebase credentials are configured,
the backend starts normally but logs that push notifications are disabled.
