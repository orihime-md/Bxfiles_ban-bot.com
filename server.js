const fs = require('fs');
const path = require('path');
const express = require('express');
const wppconnect = require('@wppconnect-team/wppconnect');

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const SESSION_NAME = process.env.SESSION_NAME || 'antilink';
const EXEMPT_ADMINS = process.env.EXEMPT_ADMINS === 'true'; // default: delete links from everyone
const PREFIX = '.';
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

// ---------- Settings (which groups have antilink ON) ----------
let settings = { groups: {} };
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
} catch (_) {}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Could not save settings:', e.message);
  }
}

// ---------- Link detection ----------
const LINK_REGEX = new RegExp(
  [
    '(https?:\\/\\/|www\\.)\\S+',                                   // http(s):// or www.
    '(chat\\.whatsapp\\.com|wa\\.me|t\\.me|bit\\.ly|tinyurl\\.com)\\/?\\S*', // common shorteners / invites
    '\\b[a-z0-9-]+\\.(com|net|org|io|xyz|me|link|info|site|online|co|ly|gg|app|dev|shop|store)(\\/\\S*)?\\b'
  ].join('|'),
  'i'
);
const hasLink = (text) => LINK_REGEX.test(text || '');

// ---------- Helpers ----------
const idOf = (x) => (typeof x === 'string' ? x : x?._serialized || '');
const userPart = (id) => idOf(id).split('@')[0];

let client = null;
let status = 'starting';
let latestQr = null; // data:image/png;base64,... string

async function isGroupAdmin(groupId, participantId) {
  try {
    const admins = await client.getGroupAdmins(groupId);
    return admins.map(idOf).some((a) => userPart(a) === userPart(participantId));
  } catch (_) {
    return false;
  }
}

async function botIsGroupAdmin(groupId) {
  try {
    const me = await client.getHostNumber(); // the bot's own number
    return await isGroupAdmin(groupId, me);
  } catch (_) {
    return false;
  }
}

// ---------- Message handler ----------
async function handleMessage(msg) {
  try {
    if (!msg.isGroupMsg) return; // antilink works in groups only

    const groupId = msg.from;
    const senderId = msg.author || msg.sender?.id || msg.from;
    const msgId = idOf(msg.id);
    const text = (msg.body || msg.caption || '').trim();

    // ----- The only command: .antilink -----
    if (text.toLowerCase().startsWith(PREFIX + 'antilink')) {
      if (!(await isGroupAdmin(groupId, senderId))) {
        return client.reply(groupId, '❌ Only group admins can use .antilink.', msgId);
      }

      const arg = text.split(/\s+/)[1]?.toLowerCase();

      if (arg === 'on') {
        settings.groups[groupId] = true;
        saveSettings();
        return client.reply(groupId, '✅ Antilink is *ON*. Links will be deleted.', msgId);
      }
      if (arg === 'off') {
        delete settings.groups[groupId];
        saveSettings();
        return client.reply(groupId, '⛔ Antilink is *OFF*.', msgId);
      }

      const state = settings.groups[groupId] ? 'ON' : 'OFF';
      return client.reply(
        groupId,
        `Antilink is *${state}*.\nUse \`.antilink on\` or \`.antilink off\`.`,
        msgId
      );
    }

    // ----- Anti-link enforcement -----
    if (!settings.groups[groupId]) return;
    if (!hasLink(text)) return;
    if (EXEMPT_ADMINS && (await isGroupAdmin(groupId, senderId))) return;
    if (!(await botIsGroupAdmin(groupId))) {
      console.warn(`Link found in ${groupId} but bot is not admin; cannot delete.`);
      return;
    }

    await client.deleteMessage(groupId, msgId, false); // false = delete for everyone
    console.log(`Deleted link from ${userPart(senderId)} in ${groupId}`);
  } catch (err) {
    console.error('Handler error:', err.message);
  }
}

// ---------- Web server (required by Render, also serves index.html) ----------
const app = express();
app.use(express.static(__dirname));

app.get('/health', (_req, res) => res.send('ok'));

app.get('/api/status', (_req, res) => {
  res.json({
    status,
    needsScan: !!latestQr,
    antilinkGroups: Object.values(settings.groups).filter(Boolean).length,
  });
});

app.get('/api/qr', (_req, res) => {
  if (!latestQr) return res.status(404).json({ error: 'No QR available' });
  res.json({ qr: latestQr });
});

app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

// Keep the free instance awake while someone is hitting it (UptimeRobot is more reliable)
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(`${process.env.RENDER_EXTERNAL_URL}/health`).catch(() => {});
  }, 10 * 60 * 1000);
}

// ---------- WhatsApp client with auto-restart ----------
async function start() {
  try {
    status = 'starting';
    client = await wppconnect.create({
      session: SESSION_NAME,
      headless: true,
      logQR: true,
      autoClose: 0,            // never auto-close the session
      disableWelcome: true,
      catchQR: (base64Qr) => {
        latestQr = base64Qr;
        status = 'waiting_for_scan';
        console.log('QR ready, open the web page to scan it.');
      },
      statusFind: (st) => {
        console.log('WhatsApp status:', st);
        status = st;
        if (st === 'isLogged' || st === 'inChat' || st === 'qrReadSuccess') latestQr = null;
      },
      puppeteerOptions: {
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-zygote',
        ],
      },
    });

    status = 'connected';
    console.log('Bot connected.');
    client.onMessage(handleMessage);
  } catch (err) {
    console.error('Start failed, retrying in 15s:', err.message);
    status = 'error';
    setTimeout(start, 15000);
  }
}

start();

// Graceful shutdown
process.on('SIGTERM', async () => {
  try { if (client) await client.close(); } catch (_) {}
  process.exit(0);
});