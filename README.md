# Gmail Forward Agent v2

## What changed from v1

1. **Full filter set restored** — From, To, Subject, Has the words, Doesn't
   have, Size (greater/less than + MB/KB), Date within, Search scope, Has
   attachment, Don't include chats.
2. **Real two-device flow**:
   - The requester fills the form on `index.html` and clicks "Send
     confirmation request." That's all that happens on their device.
   - A real email is sent (via SMTP/Nodemailer) to the destination address
     with a summary and a confirm link.
   - The **destination user opens that link on their own device** —
     that loads `confirm.html`, which is the only place the live
     Google login stream appears. They type their password there,
     on their own screen.
   - The requester's page just polls for status and shows "waiting" until
     the recipient finishes.

## Environment variables (required)

Set these on your hosting platform:

```
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=587
SMTP_USER=your-smtp-username
SMTP_PASS=your-smtp-password
SMTP_FROM=no-reply@yourdomain.com
APP_URL=https://your-deployed-domain.com
```

Any SMTP provider works — Gmail SMTP (with an app password), SendGrid,
Resend's SMTP relay, Mailgun, etc. `APP_URL` must be your real deployed
domain so the confirm link in the email works.

## Local setup

```bash
npm install
npx playwright install chromium
npm start
```

Set the env vars above in a `.env` file or your shell before running, or
the email step will fail (everything else still works up to that point).

## Files

- `server.js` — request creation, email sending, WebSocket streaming, Gmail
  automation
- `public/index.html` — requester's form (no browser session ever opens
  here)
- `public/confirm.html` — destination user's confirmation + live login page
  (opened only via the emailed link)
- `package.json` — dependencies including `nodemailer`

## Deploying

Same as before — Render/Railway/Fly.io/VPS, since it needs a persistent
Node server (not static/serverless hosting). See the original deployment
notes: build command `npm install`, start command `npm start`.
