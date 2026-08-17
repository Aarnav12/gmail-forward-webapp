/**
 * Gmail Forward Agent — Server v2
 * ---------------------------------
 * Flow:
 * 1. Requester fills source/destination email + filters on index.html.
 * 2. Server creates a pending request with a secure token and emails the
 *    DESTINATION user a confirmation link (via Nodemailer/SMTP).
 * 3. Requester's page just shows "waiting for confirmation" — nothing
 *    happens on their device beyond that.
 * 4. The DESTINATION user opens the link on THEIR OWN device — that opens
 *    confirm.html, which shows the filter summary and a live remote-browser
 *    view of Google's real login page, streamed to THEIR screen only.
 * 5. They type their password into that real Google page themselves.
 * 6. Once logged in, the agent (running on the server, driving that same
 *    browser session) creates the filter and turns on forwarding.
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { chromium } = require('playwright');
const nodemailer = require('nodemailer');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/agent-stream' });

// requestId -> { sourceEmail, destinationEmail, filters, token, status, browser, context, page }
const requests = new Map();

// ---------------- Email transport ----------------
// Fill these via environment variables when you deploy.
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

const APP_URL = process.env.APP_URL || 'http://localhost:3000';

function filterSummaryHtml(filters) {
  const rows = Object.entries(filters || {})
    .filter(([, v]) => v !== '' && v !== false && v !== undefined)
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#64748B">${k}</td><td style="padding:4px 0">${v}</td></tr>`)
    .join('');
  return rows || '<tr><td style="color:#64748B">No specific filters — all mail will be forwarded</td></tr>';
}

// ---------------- Step 1: requester creates the request ----------------
app.post('/api/request/create', async (req, res) => {
  const { sourceEmail, destinationEmail, filters } = req.body;
  if (!sourceEmail || !destinationEmail) {
    return res.status(400).json({ error: 'sourceEmail and destinationEmail are required' });
  }

  const requestId = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString('hex');

  requests.set(requestId, {
    sourceEmail, destinationEmail, filters: filters || {}, token,
    status: 'pending', browser: null, context: null, page: null
  });

  const confirmUrl = `${APP_URL}/confirm.html?requestId=${requestId}&token=${token}`;

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || 'no-reply@example.com',
      to: destinationEmail,
      subject: 'Confirm your mail forwarding setup',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
          <h2>Confirm mail forwarding</h2>
          <p>${sourceEmail} wants to set up forwarding of matching emails to your inbox (${destinationEmail}).</p>
          <table style="border-collapse:collapse;margin:16px 0">${filterSummaryHtml(filters)}</table>
          <a href="${confirmUrl}" style="display:inline-block;background:#3B82F6;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Confirm and activate forwarding</a>
          <p style="color:#94A3B8;font-size:13px;margin-top:20px">If you weren't expecting this, you can ignore this email — nothing happens until you click confirm.</p>
        </div>`
    });
  } catch (err) {
    console.error('Email send failed:', err.message);
    return res.status(500).json({ error: 'Could not send confirmation email. Check SMTP settings.' });
  }

  res.json({ requestId });
});

// ---------------- Step 2: requester polls for status ----------------
app.get('/api/request/:id/status', (req, res) => {
  const r = requests.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json({ status: r.status });
});

// ---------------- Step 3: destination user loads confirm page details ----------------
app.get('/api/request/:id', (req, res) => {
  const r = requests.get(req.params.id);
  const token = req.query.token;
  if (!r || r.token !== token) return res.status(404).json({ error: 'Invalid or expired link' });
  res.json({
    sourceEmail: r.sourceEmail,
    destinationEmail: r.destinationEmail,
    filters: r.filters,
    status: r.status
  });
});

// ---------------- Step 4: WebSocket — only opened from the destination user's device ----------------
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestId = url.searchParams.get('requestId');
  const token = url.searchParams.get('token');
  const r = requests.get(requestId);

  if (!r || r.token !== token) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid or expired link' }));
    ws.close();
    return;
  }

  r.status = 'in-progress';
  ws.send(JSON.stringify({ type: 'status', message: 'Launching secure browser session...' }));

  launchBrowserForRequest(r, ws).catch((err) => {
    ws.send(JSON.stringify({ type: 'error', message: 'Failed to launch browser: ' + err.message }));
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!r.page) return;

    try {
      if (msg.type === 'mousemove') await r.page.mouse.move(msg.x, msg.y);
      else if (msg.type === 'click') await r.page.mouse.click(msg.x, msg.y);
      else if (msg.type === 'keydown') await r.page.keyboard.down(msg.key);
      else if (msg.type === 'keyup') await r.page.keyboard.up(msg.key);
      else if (msg.type === 'scroll') await r.page.mouse.wheel(msg.deltaX || 0, msg.deltaY || 0);
      else if (msg.type === 'run-automation') {
        runFilterAutomation(r, ws).catch((err) => {
          ws.send(JSON.stringify({ type: 'error', message: 'Automation failed: ' + err.message }));
        });
      }
    } catch (err) {
      console.error('Input error:', err.message);
    }
  });

  ws.on('close', async () => {
    if (r.browser) await r.browser.close().catch(() => {});
  });
});

async function launchBrowserForRequest(r, ws) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  r.browser = browser; r.context = context; r.page = page;

  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 });
  cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
    ws.send(JSON.stringify({ type: 'frame', data }));
    await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });

  await page.goto('https://accounts.google.com/signin/v2/identifier?service=mail');
  await page.waitForTimeout(1000);
  await page.fill('input[type="email"]', r.sourceEmail);
  await page.click('#identifierNext');

  ws.send(JSON.stringify({ type: 'status', message: 'Type your password directly into the page shown below.' }));

  page.waitForURL(
    (u) => u.href.includes('mail.google.com/mail') || u.href.includes('myaccount.google.com'),
    { timeout: 0 }
  ).then(() => ws.send(JSON.stringify({ type: 'login-detected' })));
}

async function runFilterAutomation(r, ws) {
  const { page, filters, destinationEmail } = r;
  const send = (message, step) => ws.send(JSON.stringify({ type: 'progress', message, step }));

  send('Adding forwarding address...', 1);
  await page.goto('https://mail.google.com/mail/u/0/#settings/fwdandpop');
  await page.waitForTimeout(1500);

  const addForwardBtn = page.locator('text=Add a forwarding address');
  if (await addForwardBtn.count() > 0) {
    await addForwardBtn.click();
    await page.waitForTimeout(800);
    await page.locator('input[type="email"], input[name*="fwd"]').first().fill(destinationEmail);
    const nextBtn = page.locator('button:has-text("Next")');
    if (await nextBtn.count() > 0) {
      await nextBtn.click();
      await page.waitForTimeout(800);
      const proceedBtn = page.locator('button:has-text("Proceed")');
      if (await proceedBtn.count() > 0) await proceedBtn.click();
      const okBtn = page.locator('button:has-text("OK")');
      if (await okBtn.count() > 0) await okBtn.click();
    }
    ws.send(JSON.stringify({
      type: 'awaiting-confirmation',
      message: `Google sent a confirmation code to ${destinationEmail}. Confirm it, then continue.`
    }));
    return;
  }

  await createFilter(r, ws);
}

async function createFilter(r, ws) {
  const { page, filters, destinationEmail } = r;
  const send = (message, step) => ws.send(JSON.stringify({ type: 'progress', message, step }));

  send('Opening filter creation...', 2);
  await page.goto('https://mail.google.com/mail/u/0/#settings/filters');
  await page.waitForTimeout(1200);

  const createFilterLink = page.locator('text=Create a new filter');
  if (await createFilterLink.count() > 0) await createFilterLink.click();
  else await page.click('[aria-label="Show search options"]');
  await page.waitForTimeout(800);

  send('Filling filter criteria...', 3);
  const f = filters || {};
  if (f.from) await page.fill('input[name="from"]', f.from);
  if (f.to) await page.fill('input[name="to"]', f.to);
  if (f.subject) await page.fill('input[name="subject"]', f.subject);
  if (f.hasWords) await page.fill('input[name="hasthewords"]', f.hasWords);
  if (f.doesntHave) await page.fill('input[name="doesnthave"]', f.doesntHave);
  if (f.sizeValue) {
    const sizeInput = page.locator('input[name="size"]');
    if (await sizeInput.count() > 0) await sizeInput.fill(String(f.sizeValue));
  }
  if (f.hasAttachment) {
    const cb = page.locator('input[name="hasattachment"]');
    if (await cb.count() > 0) await cb.check();
  }
  if (f.dontIncludeChats) {
    const cb = page.locator('input[name="excludechats"]');
    if (await cb.count() > 0) await cb.check();
  }

  send('Creating filter...', 4);
  await page.click('text=Create filter');
  await page.waitForTimeout(1200);

  send('Enabling forwarding action...', 5);
  const forwardOption = page.locator('text=Forward it to').first();
  if (await forwardOption.count() > 0) {
    await forwardOption.click();
    await page.waitForTimeout(500);
    const dropdown = page.locator('select').last();
    if (await dropdown.count() > 0) await dropdown.selectOption({ label: destinationEmail });
  }

  const finalCreateBtn = page.locator('button:has-text("Create filter")');
  if (await finalCreateBtn.count() > 0) await finalCreateBtn.click();

  r.status = 'complete';
  ws.send(JSON.stringify({ type: 'complete', message: 'Forwarding filter created successfully.' }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
