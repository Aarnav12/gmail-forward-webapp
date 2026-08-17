# Gmail Forward Agent — Final Version

## How it works

1. **You** open the website, fill in source email, destination email, and
   filter criteria, and click "Generate link."
2. You get a link back. **Copy and send it** (WhatsApp, chat, however) to
   whoever owns the source Gmail account.
3. **They** open that link on their own computer. It shows the filter
   details and a "Download & Run" button.
4. They click it — this downloads a small `forward-agent.js` script with
   their exact details already filled in.
5. They run it with `node forward-agent.js` on their own machine.
6. This opens a **real, separate Chrome browser window** — not inside any
   website — on Google's actual sign-in page, with their email pre-filled.
7. They type their own password directly into that real Google page. The
   script waits indefinitely — there's no time limit.
8. Once logged in, it automatically creates the Gmail filter and turns on
   forwarding to the destination address, entirely on their own computer.

The web server never touches anyone's password — its only job is storing
the filter details and generating that personalized script file.

---

## Part 1 — deploy the website

```bash
npm install
npm start
```

Deploy the same way as before: push to GitHub, connect to Render/Railway,
build command `npm install`, start command `npm start`. No environment
variables are required this time — no SMTP, no Playwright on the server
itself (the server only writes a text file, it doesn't run a browser).

### Files for this part

- `server.js`
- `package.json`
- `public/index.html`
- `public/confirm.html`

Folder structure to push to GitHub:

```
your-repo/
├── server.js
├── package.json
└── public/
    ├── index.html
    └── confirm.html
```

---

## Part 2 — what the second user does (on their own computer)

1. Open the link you sent them.
2. Click **Download & Run** — saves `forward-agent.js`.
3. Open a terminal in the folder it downloaded to.
4. Run once:
   ```bash
   npm install playwright
   npx playwright install chromium
   ```
5. Run the script:
   ```bash
   node forward-agent.js
   ```
6. A real Chrome window opens with their email already filled in. They
   type their own password into it and complete any 2FA.
7. Everything else — adding the forwarding address, confirming the code
   Google sends, creating the filter, enabling forwarding — happens
   automatically after that.

## Notes

- Google will still require a one-time confirmation code sent to the
  destination address before forwarding can be enabled — this is a Google
  security requirement, not something this tool can or should skip.
- Gmail's settings page HTML changes periodically. If a step fails
  partway, the browser window stays open so the last step can be finished
  by hand.
- Each link is single-use in spirit — the server keeps the request in
  memory, so restarting the server clears all pending links.
