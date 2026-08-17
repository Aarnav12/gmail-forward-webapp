# Gmail Forward Agent — Smooth Version

## The experience

1. You fill the form → click "Generate link" → get a link, no email sent.
2. You send that link to the source account owner (WhatsApp, etc.).
3. They open it — one page, no download, no terminal. They see the filter
   summary and a "Confirm and sign in" button.
4. Clicking it shows a **live view of Google's real sign-in page**,
   streamed right there in their browser tab. They type their password
   directly into it.
5. Once logged in, the agent automatically finishes the rest — creating
   the filter, enabling forwarding.

No installs, no npm, no terminal for the second user — everything happens
in that one browser tab.

## The trade-off (read this)

This runs the actual browser **on your server**, not on the second user's
computer. That's what makes it smooth (no downloads) but it does mean:

- It's a **live streamed view**, not a literal separate native Chrome
  window popping up on their desktop. Functionally identical for typing
  a password safely (it's still Google's real page, their real password,
  never seen by this server) — just visually it's inside a browser tab
  instead of its own window.
- Your server needs to stay running and needs enough memory per
  concurrent session (~150-300MB each) — same requirement as before.

If a literal separate native window matters more than a zero-install
experience, use the `gmail-forward-final` version instead (downloads a
script the second user runs locally). You can't fully have both at once —
that's a real browser-security boundary, not a missing feature.

## Setup

```bash
npm install
npx playwright install chromium
npm start
```

## Deploying

Push these 4 files to GitHub:
```
your-repo/
├── server.js
├── package.json
└── public/
    ├── index.html
    └── confirm.html
```
Connect to Render → build command `npm install` → start command
`npm start`. No environment variables required.
