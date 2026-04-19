// ============================================================
//  7 Sage SMP — server.js
//  Single-file Express backend
// ============================================================
require('dotenv').config();

const express      = require('express');
const session      = require('express-session');
const passport     = require('passport');
const MicrosoftStrategy = require('passport-microsoft').Strategy;
const Razorpay     = require('razorpay');
const axios        = require('axios');
const crypto       = require('crypto');
const Rcon         = require('node-rcon');
const cron         = require('node-cron');
const path         = require('path');

const app = express();

// ============================================================
//  IN-MEMORY STORES  (replace with MongoDB in production)
// ============================================================
const users   = {};   // microsoftId → { id, displayName, email, minecraftName, minecraftUUID }
const orders  = {};   // orderId     → { userId, product, status, gateway, fulfilledAt }
const subs    = {};   // userId      → { product, lpGroup, expiresAt }

// ============================================================
//  PRODUCTS
// ============================================================
const PRODUCTS = {
  common_sage:   { name: 'Common Sage',   lpGroup: 'common_sage',   priceINR: 10000, priceUSD: '1.20', durationDays: 30, isUpgrade: false },
  elder_sage:    { name: 'Elder Sage',    lpGroup: 'elder_sage',    priceINR: 24900, priceUSD: '2.99', durationDays: 30, isUpgrade: true  },
  heavenly_sage: { name: 'Heavenly Sage', lpGroup: 'heavenly_sage', priceINR: 44900, priceUSD: '5.39', durationDays: 30, isUpgrade: true  },
  celestial_sage:{ name: 'Celestial Sage',lpGroup: 'celestial_sage',priceINR: 99900, priceUSD: '11.99',durationDays: 30, isUpgrade: true  },
};

// ============================================================
//  RAZORPAY CLIENT
// ============================================================
const rzp = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ============================================================
//  PAYPAL — helper to get Bearer token
// ============================================================
const PAYPAL_BASE = process.env.PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

async function getPayPalToken() {
  const res = await axios.post(
    `${PAYPAL_BASE}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      auth: { username: process.env.PAYPAL_CLIENT_ID, password: process.env.PAYPAL_CLIENT_SECRET },
    }
  );
  return res.data.access_token;
}

// ============================================================
//  RCON — execute a command on the Minecraft server
// ============================================================
function rconExec(command) {
  return new Promise((resolve, reject) => {
    const conn = new Rcon(
      process.env.RCON_HOST || '127.0.0.1',
      parseInt(process.env.RCON_PORT || '25575'),
      process.env.RCON_PASSWORD
    );
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      try { conn.disconnect(); } catch (_) {}
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('RCON timeout')), 10000);
    conn.on('auth',     ()    => { conn.send(command); });
    conn.on('response', (str) => { clearTimeout(timer); finish(null, str); });
    conn.on('error',    (err) => { clearTimeout(timer); finish(err); });
    conn.connect();
  });
}

// Convenience wrappers
const grantRole = (username, group) => rconExec(`lp user ${username} parent add ${group}`);
const setRole   = (username, group) => rconExec(`lp user ${username} parent set ${group}`);
const resetRole = (username)        => rconExec(`lp user ${username} parent set default`);

// ============================================================
//  FULFILLMENT  (only called after webhook verification)
// ============================================================
async function fulfillOrder(orderId) {
  const order = orders[orderId];
  if (!order)                      throw new Error('Order not found: ' + orderId);
  if (order.status === 'fulfilled') return console.log('[Fulfill] Already fulfilled:', orderId);
  if (!order.webhookVerified)       throw new Error('Webhook not verified for order: ' + orderId);

  const product  = PRODUCTS[order.product];
  const user     = users[order.userId];
  const username = user?.minecraftName;
  if (!username) throw new Error('No Minecraft username for user: ' + order.userId);

  if (product.isUpgrade) {
    await setRole(username, product.lpGroup);
    console.log(`[RCON] Upgraded ${username} → ${product.lpGroup}`);
  } else {
    await grantRole(username, product.lpGroup);
    console.log(`[RCON] Granted ${username} → ${product.lpGroup}`);
  }

  order.status      = 'fulfilled';
  order.fulfilledAt = new Date();

  // Upsert subscription
  subs[order.userId] = {
    product:    order.product,
    lpGroup:    product.lpGroup,
    username,
    expiresAt:  new Date(Date.now() + product.durationDays * 86400000),
  };
  console.log(`[Fulfill] Order ${orderId} fulfilled. Sub expires: ${subs[order.userId].expiresAt}`);
}

// ============================================================
//  CRON — daily subscription expiry check at midnight
// ============================================================
cron.schedule('0 0 * * *', async () => {
  console.log('[Cron] Checking expired subscriptions...');
  const now = new Date();
  for (const [userId, sub] of Object.entries(subs)) {
    if (sub.active !== false && sub.expiresAt < now) {
      try {
        await resetRole(sub.username);
        console.log(`[Cron] Reset ${sub.username} → default`);
      } catch (err) {
        console.error(`[Cron] RCON error for ${sub.username}:`, err.message);
      }
      subs[userId].active = false;
    }
  }
});

// ============================================================
//  PASSPORT — Microsoft OAuth + Xbox Live → Minecraft UUID
// ============================================================
passport.serializeUser((user, done)   => done(null, user.id));
passport.deserializeUser((id, done)   => done(null, users[id] || null));

passport.use(new MicrosoftStrategy(
  {
    clientID:     process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    callbackURL:  process.env.MICROSOFT_CALLBACK_URL,
    scope:        ['user.read'],
  },
  async (accessToken, _refresh, profile, done) => {
    try {
      let minecraftName = null;
      let minecraftUUID = null;

      try {
        // Step 1 — MS token → XBL token
        const xblRes = await axios.post(
          'https://user.auth.xboxlive.com/user/authenticate',
          { Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${accessToken}` }, RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT' },
          { headers: { 'Content-Type': 'application/json', Accept: 'application/json' } }
        );
        const xblToken = xblRes.data.Token;
        const userHash = xblRes.data.DisplayClaims.xui[0].uhs;

        // Step 2 — XBL → XSTS token
        const xstsRes = await axios.post(
          'https://xsts.auth.xboxlive.com/xsts/authorize',
          { Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' },
          { headers: { 'Content-Type': 'application/json', Accept: 'application/json' } }
        );
        const xstsToken = xstsRes.data.Token;

        // Step 3 — XSTS → Minecraft access token
        const mcAuth = await axios.post(
          'https://api.minecraftservices.com/authentication/login_with_xbox',
          { identityToken: `XBL3.0 x=${userHash};${xstsToken}` },
          { headers: { 'Content-Type': 'application/json' } }
        );
        const mcToken = mcAuth.data.access_token;

        // Step 4 — Minecraft profile (UUID + username)
        const mcProfile = await axios.get(
          'https://api.minecraftservices.com/minecraft/profile',
          { headers: { Authorization: `Bearer ${mcToken}` } }
        );
        minecraftUUID = mcProfile.data.id;
        minecraftName = mcProfile.data.name;
      } catch (e) {
        console.warn('[OAuth] Could not resolve Minecraft profile:', e.message);
      }

      // Upsert user in memory
      const userId = profile.id;
      users[userId] = {
        id:            userId,
        displayName:   profile.displayName,
        email:         profile.emails?.[0]?.value ?? null,
        minecraftUUID,
        minecraftName,
      };

      done(null, users[userId]);
    } catch (err) {
      done(err);
    }
  }
));

// ============================================================
//  EXPRESS SETUP
// ============================================================

// ⚠️ Raw body for webhook routes MUST come before express.json()
app.use('/webhook/razorpay', express.raw({ type: '*/*' }));
app.use('/webhook/paypal',   express.raw({ type: '*/*' }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret:            process.env.SESSION_SECRET || 'change-me-in-production',
  resave:            false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 7 * 86400000 },
}));

app.use(passport.initialize());
app.use(passport.session());

// Serve your index.html from the same folder
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
//  AUTH MIDDLEWARE
// ============================================================
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Login with Microsoft first.' });
}

// ============================================================
//  AUTH ROUTES
// ============================================================
app.get('/auth/microsoft',
  passport.authenticate('microsoft', { prompt: 'select_account' })
);

app.get('/auth/microsoft/callback',
  passport.authenticate('microsoft', { failureRedirect: '/?error=login_failed' }),
  (req, res) => res.redirect('/')
);

app.get('/auth/me', requireAuth, (req, res) => {
  const { id, displayName, email, minecraftName, minecraftUUID } = req.user;
  const sub = subs[id];
  res.json({
    id, displayName, email, minecraftName, minecraftUUID,
    subscription: sub
      ? { product: sub.product, expiresAt: sub.expiresAt, active: sub.active !== false && sub.expiresAt > new Date() }
      : null,
  });
});

app.post('/auth/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session.destroy(() => res.json({ ok: true }));
  });
});

// ============================================================
//  RAZORPAY ROUTES
// ============================================================

// POST /pay/razorpay/order  — creates a Razorpay order, returns order id to frontend
app.post('/pay/razorpay/order', requireAuth, async (req, res) => {
  try {
    const { product: slug } = req.body;
    const product = PRODUCTS[slug];
    if (!product) return res.status(400).json({ error: 'Unknown product.' });
    if (!req.user.minecraftName) return res.status(403).json({ error: 'No Minecraft account linked.' });

    const rzpOrder = await rzp.orders.create({
      amount:   product.priceINR,
      currency: 'INR',
      notes:    { userId: req.user.id, product: slug, minecraftName: req.user.minecraftName },
    });

    // Store pending order
    orders[rzpOrder.id] = {
      userId:          req.user.id,
      product:         slug,
      gateway:         'razorpay',
      status:          'pending',
      webhookVerified: false,
    };

    res.json({
      rzpOrderId: rzpOrder.id,
      amount:     product.priceINR,
      currency:   'INR',
      keyId:      process.env.RAZORPAY_KEY_ID,
      name:       req.user.displayName,
      email:      req.user.email,
      productName: product.name,
    });
  } catch (err) {
    console.error('[Razorpay Order]', err.message);
    res.status(500).json({ error: 'Could not create order.' });
  }
});

// POST /webhook/razorpay  — Razorpay calls this after payment
app.post('/webhook/razorpay', async (req, res) => {
  try {
    const sig      = req.headers['x-razorpay-signature'];
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
                           .update(req.body).digest('hex');

    if (!sig || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      console.warn('[Razorpay Webhook] Bad signature');
      return res.status(400).json({ error: 'Bad signature.' });
    }

    const event   = JSON.parse(req.body.toString());
    const payment = event?.payload?.payment?.entity;

    if (event.event === 'payment.captured' && payment) {
      const orderId = payment.order_id;
      if (orders[orderId]) {
        orders[orderId].webhookVerified  = true;
        orders[orderId].gatewayPaymentId = payment.id;
        orders[orderId].status           = 'paid';
        fulfillOrder(orderId).catch(e => console.error('[Fulfill Error]', e.message));
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Razorpay Webhook]', err.message);
    res.status(500).json({ error: 'Webhook error.' });
  }
});

// ============================================================
//  PAYPAL ROUTES
// ============================================================

// POST /pay/paypal/order  — creates a PayPal order
app.post('/pay/paypal/order', requireAuth, async (req, res) => {
  try {
    const { product: slug } = req.body;
    const product = PRODUCTS[slug];
    if (!product) return res.status(400).json({ error: 'Unknown product.' });
    if (!req.user.minecraftName) return res.status(403).json({ error: 'No Minecraft account linked.' });

    const token = await getPayPalToken();
    const ppRes = await axios.post(
      `${PAYPAL_BASE}/v2/checkout/orders`,
      {
        intent: 'CAPTURE',
        purchase_units: [{
          custom_id:   req.user.id,
          description: `${product.name} — 7 Sage SMP`,
          amount:      { currency_code: 'USD', value: product.priceUSD },
        }],
        application_context: {
          brand_name:  '7 Sage SMP',
          user_action: 'PAY_NOW',
          return_url:  `${process.env.BASE_URL}/pay/paypal/capture`,
          cancel_url:  `${process.env.BASE_URL}/?cancelled=true`,
        },
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': crypto.randomUUID() } }
    );

    const ppOrder = ppRes.data;

    orders[ppOrder.id] = {
      userId:          req.user.id,
      product:         slug,
      gateway:         'paypal',
      status:          'pending',
      webhookVerified: false,
    };

    res.json({ ppOrderId: ppOrder.id, clientId: process.env.PAYPAL_CLIENT_ID });
  } catch (err) {
    console.error('[PayPal Order]', err.response?.data ?? err.message);
    res.status(500).json({ error: 'Could not create PayPal order.' });
  }
});

// POST /webhook/paypal  — PayPal calls this after capture
app.post('/webhook/paypal', async (req, res) => {
  try {
    const rawBody = req.body.toString();
    const token   = await getPayPalToken();

    // Verify signature via PayPal API
    const verify = await axios.post(
      `${PAYPAL_BASE}/v1/notifications/verify-webhook-signature`,
      {
        auth_algo:         req.headers['paypal-auth-algo'],
        cert_url:          req.headers['paypal-cert-url'],
        transmission_id:   req.headers['paypal-transmission-id'],
        transmission_sig:  req.headers['paypal-transmission-sig'],
        transmission_time: req.headers['paypal-transmission-time'],
        webhook_id:        process.env.PAYPAL_WEBHOOK_ID,
        webhook_event:     JSON.parse(rawBody),
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    if (verify.data.verification_status !== 'SUCCESS') {
      console.warn('[PayPal Webhook] Verification failed');
      return res.status(400).json({ error: 'Verification failed.' });
    }

    const event   = JSON.parse(rawBody);
    const capture = event?.resource;

    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED' && capture?.status === 'COMPLETED') {
      // PayPal puts the order id in supplementary_data
      const ppOrderId = capture?.supplementary_data?.related_ids?.order_id ?? capture.id;
      if (orders[ppOrderId]) {
        orders[ppOrderId].webhookVerified  = true;
        orders[ppOrderId].gatewayPaymentId = capture.id;
        orders[ppOrderId].status           = 'paid';
        fulfillOrder(ppOrderId).catch(e => console.error('[Fulfill Error]', e.message));
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[PayPal Webhook]', err.response?.data ?? err.message);
    res.status(500).json({ error: 'Webhook error.' });
  }
});

// ============================================================
//  MISC
// ============================================================
app.get('/health', (_, res) => res.json({ status: 'ok' }));
app.get('/products', (_, res) => res.json(PRODUCTS));

// ============================================================
//  START
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🟢  7 Sage SMP Store running → http://localhost:${PORT}`);
  console.log(`    Microsoft OAuth: http://localhost:${PORT}/auth/microsoft\n`);
});
