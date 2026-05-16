# Backend API Contract

NextJS backend. iOS app calls `EXPO_PUBLIC_API_URL`. All routes prefixed `/api/`.

---

## Prisma Schema

All tables use the `weight_` prefix. Current models:

```prisma
// ── Enums ───────────────────────────────────────────────────────────────────

enum AccountTier {
  free
  pro
  admin
}

enum SubscriptionStatus {
  none        // never started a trial
  trial       // within 7-day free trial
  active      // paying subscriber
  expired     // trial ended, not subscribed
  cancelled   // was active, cancelled (access until period end)
}

enum PaymentStatus {
  pending
  succeeded
  failed
  refunded
}

// ── weight_User ──────────────────────────────────────────────────────────────

model weight_User {
  id                 String             @id               // supabase auth.users id
  email              String?
  accountTier        AccountTier        @default(free)
  subscriptionStatus SubscriptionStatus @default(none)
  appleUserId        String?            @unique
  trialStartAt       DateTime?
  createdAt          DateTime           @default(now())
  updatedAt          DateTime           @updatedAt

  subscriptions      weight_Subscription[]
  payments           weight_Payment[]
}

// ── weight_Subscription ──────────────────────────────────────────────────────
// One row per billing period. Create a new row each renewal.

model weight_Subscription {
  id                  String             @id @default(uuid())
  userId              String
  user                weight_User        @relation(fields: [userId], references: [id])
  status              SubscriptionStatus
  priceAmountCents    Int                // 499 = $4.99
  currency            String             @default("USD")
  currentPeriodStart  DateTime
  currentPeriodEnd    DateTime
  cancelledAt         DateTime?
  providerName        String?            // "stripe" | "revenuecat" | "apple_iap"
  providerSubId       String?            @unique
  createdAt           DateTime           @default(now())
  updatedAt           DateTime           @updatedAt

  payments            weight_Payment[]
}

// ── weight_Payment ───────────────────────────────────────────────────────────
// One row per charge attempt (succeeded or failed).

model weight_Payment {
  id                String               @id @default(uuid())
  userId            String
  user              weight_User          @relation(fields: [userId], references: [id])
  subscriptionId    String?
  subscription      weight_Subscription? @relation(fields: [subscriptionId], references: [id])
  amountCents       Int                  // 499 = $4.99
  currency          String               @default("USD")
  status            PaymentStatus
  providerName      String?              // "stripe" | "revenuecat" | "apple_iap"
  providerPaymentId String?              @unique
  paidAt            DateTime?
  createdAt         DateTime             @default(now())
}
```

**Business logic for `accountTier`:**
- `subscriptionStatus = trial` or `active` → set `accountTier = pro`
- `subscriptionStatus = expired` or `cancelled` → set `accountTier = free`
- `accountTier = admin` is manual override, never auto-downgraded

**Prisma relation fields (`user`, `subscription`, `payments`, `subscriptions`):**
These are virtual — they don't create columns in the DB. They let you do `include: { user: true }` in Prisma queries to auto-join the related table. The actual FK column is the `userId`/`subscriptionId` string field beside them.

---

## Environment Variables (`.env`)

```
SUPABASE_DATABASE_URL=...
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
APPLE_BUNDLE_ID=com.anonymous.weight-tracker-ios
```

---

## Shared Helpers

### `src/lib/auth.ts`

- **`verifyToken(request)`** — extracts `Authorization: Bearer <token>`, calls `supabaseAdmin().auth.getUser(token)`, returns `{ userId }` or `{ error, status }`.
- **`deriveAccountTier(status, currentTier)`** — returns the correct `AccountTier` based on `SubscriptionStatus`. Respects the `admin` override.

---

## API Contract

### Auth header (all routes except `/api/auth/apple`)

```
Authorization: Bearer <supabase_access_token>
```

Verified server-side with `supabaseAdmin().auth.getUser(token)`.

---

### `POST /api/auth/apple`

Verify Apple identity token → find or create Supabase Auth user → upsert `weight_User` → return session tokens.

**Request body:**
```json
{
  "identityToken": "<JWT from Apple>",
  "appleUserId":   "000000.abc123",
  "email":         "user@privaterelay.appleid.com",
  "fullName":      "Jane Smith"
}
```

**Steps:**
1. Verify `identityToken` with Apple JWKS (`https://appleid.apple.com/auth/keys`) using `jose`. Check `iss`, `aud` (bundle ID), expiry, and that `sub === appleUserId`.
2. Look up `weight_User` by `appleUserId`. If not found, look up by `email`. If still not found, create a Supabase Auth user via `supabase.auth.admin.createUser()`.
3. Upsert `weight_User` with `appleUserId` and `email`.
4. Generate a Supabase session via `supabase.auth.admin.generateLink({ type: 'magiclink' })` + `supabase.auth.verifyOtp({ token_hash, type: 'magiclink' })`.

**Response (200):**
```json
{
  "accessToken":        "<supabase_access_token>",
  "refreshToken":       "<supabase_refresh_token>",
  "userId":             "uuid",
  "subscriptionStatus": "none",
  "trialStartAt":       null,
  "isNew":              true
}
```

**Response (401):** `{ "error": "Invalid identity token" }`

---

### `POST /api/users/:appleUserId/trial`

Start the 7-day free trial. Idempotent — if trial already started, returns the existing `trialStartAt`.

**Response (200):**
```json
{
  "trialStartAt":       "2026-05-16T10:00:00.000Z",
  "subscriptionStatus": "trial"
}
```

**Side effects:** Sets `subscriptionStatus = trial`, `trialStartAt = now()`, `accountTier = pro`.

---

### `GET /api/users/:appleUserId`

Fetch current user subscription state. Called on reinstall to restore state.

**Response (200):**
```json
{
  "userId":             "uuid",
  "email":              "user@example.com",
  "accountTier":        "pro",
  "subscriptionStatus": "trial",
  "trialStartAt":       "2026-05-16T10:00:00.000Z"
}
```

**Server-side expiry check:** If `subscriptionStatus = trial` and `now > trialStartAt + 7 days`, flips to `expired`/`free` in the DB before responding.

**Response (404):** `{ "error": "User not found" }`

---

### `POST /api/users/:appleUserId/subscription`

Update subscription status. Used by the app to report trial expiry and by payment webhooks.

**Request body:**
```json
{ "subscriptionStatus": "expired" }
```

Accepted values: `"expired"` | `"active"` | `"cancelled"`

**Response (200):**
```json
{
  "subscriptionStatus": "expired",
  "accountTier":        "free"
}
```

---

### `POST /api/webhooks/payment`

Called by Stripe/RevenueCat — not by the iOS app.

**Request body:**
```json
{
  "event":               "payment.succeeded",
  "userId":              "uuid",
  "providerName":        "stripe",
  "providerSubId":       "sub_xxx",
  "providerPaymentId":   "pi_xxx",
  "amountCents":         499,
  "currency":            "USD",
  "currentPeriodStart":  "2026-05-16T00:00:00.000Z",
  "currentPeriodEnd":    "2026-06-16T00:00:00.000Z"
}
```

**Supported events:**

| Event | Behaviour |
|-------|-----------|
| `payment.succeeded` | Creates `weight_Subscription` + `weight_Payment` rows; sets `subscriptionStatus = active`, `accountTier = pro` |
| `subscription.cancelled` | Sets `weight_Subscription.cancelledAt`; keeps `accountTier = pro` until `currentPeriodEnd`. App/cron must call `POST /subscription` with `"expired"` after period ends. |

---

## Subscription Pricing

| Field | Value |
|-------|-------|
| Amount | $4.99/month |
| `priceAmountCents` | `499` |
| `currency` | `"USD"` |
| Trial | 7 days free |
| Payment provider | TBD (Stripe or RevenueCat recommended) |

---

## npm packages

```bash
npm install @supabase/supabase-js jose
```
