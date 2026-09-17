# Microsoft Graph Email Transport

The backend email transport migrated from SMTP/Nodemailer to **Microsoft Graph v1.0** (`POST /users/{sender}/sendMail`). Only the transport changed — templates, EmailLog, queue, retry, preferences and idempotency are untouched.

## Flow

```
Event → email.service.enqueueEmail → EmailLog (PENDING, idempotencyKey)
      → deliverQueuedRow → transport/index.js
            ├── MICROSOFT_GRAPH_ENABLED=true  → microsoftGraph.client  → Graph v1.0 → 202 Accepted → SENT
            └── otherwise                     → smtp.transport (legacy) → SMTP
```

## Environment variables

| Variable | Purpose |
|---|---|
| `MICROSOFT_GRAPH_TENANT_ID` | Entra ID tenant (GUID or domain) |
| `MICROSOFT_GRAPH_CLIENT_ID` | App registration client ID |
| `MICROSOFT_GRAPH_CLIENT_SECRET` | Client secret (backend-only, never logged) |
| `MICROSOFT_GRAPH_SENDER_EMAIL` | M365 mailbox the app sends from (e.g. `notifications@yourdomain.com`) |
| `MICROSOFT_GRAPH_ENABLED` | `true` = Graph transport; `false` = legacy SMTP (local dev) |
| `MICROSOFT_GRAPH_TEST_RECIPIENT` | Recipient for `scripts/test-microsoft-graph-email.js` |

Secrets live only in `.env` (git-ignored). Never expose them via API responses, logs, or frontend `VITE_*` variables.

## Microsoft Entra setup checklist

1. **App registration** — Entra admin center → Microsoft Entra ID → App registrations → New registration (single tenant).
2. **API permissions** → Microsoft Graph → **Application permissions** → `Mail.Send`.
   - Do NOT add `Mail.Read`, `Mail.ReadWrite`, or `Mail.Send.Shared` — this integration is send-only.
3. **Grant admin consent** for `Mail.Send` (required for application permissions).
4. **Certificates & secrets** → New client secret → copy the value into `MICROSOFT_GRAPH_CLIENT_SECRET`.
5. **Sender mailbox** — ensure `MICROSOFT_GRAPH_SENDER_EMAIL` exists as a real mailbox in Exchange Online. An SMTP alias or a distribution group is not sufficient for `/users/{sender}/sendMail`.
6. **Restrict the app to the sender mailbox (recommended production hardening)** —
   Application `Mail.Send` can send as ANY mailbox in the tenant. Limit it with an
   **Exchange Online application access policy** (Exchange Online PowerShell):

   ```powershell
   New-ApplicationAccessPolicy -AppId <CLIENT_ID> `
     -PolicyScopeGroupId <mail-enabled security group containing ONLY the sender mailbox> `
     -AccessRight RestrictAccess -Description "POS notifications — sender mailbox only"
   ```

   This restriction is an **Exchange/Entra tenant configuration**, not enforced by application code.

## Behavior notes

- **Token caching** — one app token per process, refreshed ~5 min before expiry; no per-email auth flow.
- **202 Accepted** — treated as transport-accepted (EmailLog `SENT`); it is NOT a final delivery guarantee.
- **No silent fallback** — when the flag is on but config is incomplete, sends FAIL loudly; SMTP never fires implicitly.
- **Errors** — normalized to stable codes (`AUTH_FAILURE`, `PERMISSION_DENIED`, `INVALID_REQUEST`, `THROTTLED`, `GRAPH_SERVER_ERROR`, `NETWORK_ERROR`) and sanitized before logging (never tokens/secrets). The existing queue retry (bounded attempts, 60s backoff, 5-min cron) handles retryable failures.
- **Diagnostics** — the existing Super Admin "verify connection" action runs `verifyGraphConnection()` in Graph mode (config + token acquisition only; never sends mail).
- **Manual test** — `MICROSOFT_GRAPH_TEST_RECIPIENT=you@yourdomain.com node scripts/test-microsoft-graph-email.js` sends exactly one email and exits non-zero on failure.
