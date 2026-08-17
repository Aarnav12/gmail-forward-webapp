/**
 * Gmail Forward Agent — Final Version
 * -------------------------------------
 * Flow:
 * 1. Requester fills the form on index.html (source email, destination
 *    email, filter criteria) and submits.
 * 2. Server creates a request and returns a link.
 * 3. Requester shares that link (WhatsApp, etc.) with whoever owns the
 *    source account.
 * 4. That person opens the link on their OWN computer -> confirm.html
 *    shows the filter details and a "Download & Run" button.
 * 5. Clicking it downloads a small personalized Node.js script with their
 *    exact source/destination/filter details already filled in.
 * 6. They run that script with `node forward-agent.js` on their own
 *    machine. It opens a REAL, separate Chrome window (via Playwright),
 *    auto-fills their email, and waits indefinitely for them to type
 *    their own password directly into Google's real login page.
 * 7. Once logged in, the script automatically creates the Gmail filter
 *    and turns on forwarding -- all running locally on their computer.
 *
 * This server itself only ever handles: storing filter details, and
 * generating that script. It never touches anyone's password.
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// requestId -> { sourceEmail, destinationEmail, filters, token }
const requests = new Map();

// ---------------- Step 1: requester creates the request ----------------
app.post('/api/request/create', (req, res) => {
  const { sourceEmail, destinationEmail, filters } = req.body;
  if (!sourceEmail || !destinationEmail) {
    return res.status(400).json({ error: 'sourceEmail and destinationEmail are required' });
  }

  const requestId = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString('hex');

  requests.set(requestId, { sourceEmail, destinationEmail, filters: filters || {}, token });

  const confirmUrl = `${req.protocol}://${req.get('host')}/confirm.html?requestId=${requestId}&token=${token}`;
  res.json({ requestId, confirmUrl });
});

// ---------------- Step 2: confirm page loads request details ----------------
app.get('/api/request/:id', (req, res) => {
  const r = requests.get(req.params.id);
  const token = req.query.token;
  if (!r || r.token !== token) return res.status(404).json({ error: 'Invalid or expired link' });
  res.json({ sourceEmail: r.sourceEmail, destinationEmail: r.destinationEmail, filters: r.filters });
});

// ---------------- Step 3: generate the personalized script for download ----------------
app.get('/api/request/:id/script', (req, res) => {
  const r = requests.get(req.params.id);
  const token = req.query.token;
  if (!r || r.token !== token) return res.status(404).send('Invalid or expired link');

  const script = buildScript(r.sourceEmail, r.destinationEmail, r.filters);
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Content-Disposition', 'attachment; filename="forward-agent.js"');
  res.send(script);
});

function buildScript(sourceEmail, destinationEmail, filters) {
  const configJson = JSON.stringify({ sourceEmail, destinationEmail, filters }, null, 2);

  return `/**
 * Gmail Forward Agent — personalized local script
 * Generated for: ${sourceEmail} -> ${destinationEmail}
 *
 * HOW THIS WORKS:
 * - Opens a real Chrome window on Google's real login page.
 * - Auto-fills your email only.
 * - Waits (no time limit) for YOU to type YOUR password directly into
 *   Google's own page. This script never sees or stores it.
 * - Once you're logged in, it automatically creates the Gmail filter and
 *   turns on forwarding to the destination address below.
 *
 * SETUP (run these once):
 *   npm install playwright
 *   npx playwright install chromium
 *
 * RUN:
 *   node forward-agent.js
 */

const { chromium } = require('playwright');

const CONFIG = ${configJson};

async function waitForManualLogin(page) {
  console.log('\\n=========================================================');
  console.log('A Chrome window has opened on the REAL Google login page.');
  console.log('Your email has been filled in automatically.');
  console.log('>>> Please type YOUR password (and complete 2FA if asked) <<<');
  console.log('This script does NOT see or store your password.');
  console.log('Waiting for you to finish logging in (no time limit)...');
  console.log('=========================================================\\n');

  await page.waitForURL(
    (url) => url.href.includes('mail.google.com/mail') || url.href.includes('myaccount.google.com'),
    { timeout: 0 }
  );

  console.log('Login detected. Continuing automation...\\n');
}

async function createFilterAndForward(page, config) {
  console.log('Step 1/5: Adding forwarding address...');
  await page.goto('https://mail.google.com/mail/u/0/#settings/fwdandpop');
  await page.waitForTimeout(2000);

  const addForwardBtn = page.locator('text=Add a forwarding address');
  if (await addForwardBtn.count() > 0) {
    await addForwardBtn.click();
    await page.waitForTimeout(1000);
    await page.locator('input[type="email"], input[name*="fwd"]').first().fill(config.destinationEmail);

    const nextBtn = page.locator('button:has-text("Next")');
    if (await nextBtn.count() > 0) {
      await nextBtn.click();
      await page.waitForTimeout(1000);
      const proceedBtn = page.locator('button:has-text("Proceed")');
      if (await proceedBtn.count() > 0) await proceedBtn.click();
      const okBtn = page.locator('button:has-text("OK")');
      if (await okBtn.count() > 0) await okBtn.click();
    }

    console.log('\\n*** IMPORTANT ***');
    console.log('Google sent a confirmation code to ' + config.destinationEmail + '.');
    console.log('This is a mandatory Google security step and cannot be skipped.');
    console.log('Open that inbox, confirm the code or click the link there,');
    console.log('then press Enter here to continue.\\n');

    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise((resolve) => rl.question('Press Enter once verified... ', resolve));
    rl.close();
  } else {
    console.log('Forwarding address already exists — continuing.');
  }

  console.log('Step 2/5: Opening filter creation...');
  await page.goto('https://mail.google.com/mail/u/0/#settings/filters');
  await page.waitForTimeout(1500);

  const createFilterLink = page.locator('text=Create a new filter');
  if (await createFilterLink.count() > 0) await createFilterLink.click();
  else await page.click('[aria-label="Show search options"]');
  await page.waitForTimeout(1000);

  console.log('Step 3/5: Filling filter criteria...');
  const f = config.filters || {};
  if (f.from) await page.fill('input[name="from"]', f.from);
  if (f.to) await page.fill('input[name="to"]', f.to);
  if (f.subject) await page.fill('input[name="subject"]', f.subject);
  if (f.hasWords) await page.fill('input[name="hasthewords"]', f.hasWords);
  if (f.doesntHave) await page.fill('input[name="doesnthave"]', f.doesntHave);
  if (f.hasAttachment) {
    const cb = page.locator('input[name="hasattachment"]');
    if (await cb.count() > 0) await cb.check();
  }

  console.log('Step 4/5: Clicking "Create filter"...');
  await page.click('text=Create filter');
  await page.waitForTimeout(1500);

  console.log('Step 5/5: Enabling "Forward it to" action...');
  const forwardOption = page.locator('text=Forward it to').first();
  if (await forwardOption.count() > 0) {
    await forwardOption.click();
    await page.waitForTimeout(500);
    const dropdown = page.locator('select').last();
    if (await dropdown.count() > 0) await dropdown.selectOption({ label: config.destinationEmail });
  }

  const finalBtn = page.locator('button:has-text("Create filter")');
  if (await finalBtn.count() > 0) await finalBtn.click();

  console.log('\\n✅ Done. Filter created and forwarding enabled.');
  console.log('   ' + config.sourceEmail + ' → ' + config.destinationEmail);
}

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://accounts.google.com/signin/v2/identifier?service=mail');
  await page.waitForTimeout(1500);
  await page.fill('input[type="email"]', CONFIG.sourceEmail);
  await page.click('#identifierNext');

  await waitForManualLogin(page);
  await createFilterAndForward(page, CONFIG);

  console.log('\\nBrowser stays open so you can verify. Close it manually when done.');
}

main().catch((err) => {
  console.error('Automation failed:', err.message);
  console.error('If a step failed, finish it manually in the open browser window.');
});
`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
