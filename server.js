require('dotenv').config();

const express = require('express');
const mysql = require('mysql2');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const app = express();

// ✅ ADD THIS LINE
const path = require("path");
const fs = require("fs");
app.use(express.static(path.join(__dirname)));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================= HOME ROUTE =================
// Root will be served by express.static('index.html') automatically.

// ================= DB =================
 const db = mysql.createConnection({
     host: process.env.DB_HOST,
     user: process.env.DB_USER,
     password: process.env.DB_PASS,
   database: process.env.DB_NAME
 });

db.connect(err => {
     if (err) console.log("DB Error:", err);
     else console.log("✅ MySQL Connected");
 });

// ================= STORE CLIENTS =================
let users = {};

// ================= CREATE CLIENT =================
function createClient(userId) {

    // 🛑 Prevent duplicate client
    if (users[userId]?.client) {
        console.log("⚠️ Client already exists:", userId);
        return;
    }

    console.log("🚀 Creating client for:", userId);

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: userId }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu'
            ]
        }
    });

    users[userId] = {
        client,
        qr: null,
        ready: false
    };

    // ✅ QR
    client.on('qr', async (qr) => {
        console.log("📲 QR Generated:", userId);
        users[userId].qr = await QRCode.toDataURL(qr);
    });

    // ✅ READY
    client.on('ready', () => {
        console.log("🟢 Ready:", userId);
        users[userId].ready = true;
        users[userId].qr = null;
    });

    // 🔥 IMPORTANT EVENTS
    client.on('authenticated', () => {
        console.log("🔐 Authenticated:", userId);
    });

    client.on('auth_failure', (msg) => {
        console.log("❌ Auth failure:", userId, msg);

        if (users[userId]) {
            users[userId].ready = false;
            users[userId].qr = null;
        }
    });

    client.on('disconnected', (reason) => {
        console.log("🔴 Disconnected:", userId, reason);

        if (users[userId]) {
            users[userId].ready = false;
            users[userId].qr = null;
        }
    });

    client.on('change_state', state => {
        console.log("🔄 State:", userId, state);
    });

    // 🛡️ Prevent crash
    client.initialize().catch(err => {
        console.log("❌ Init error:", err.message);
    });
}

// ================= REGISTER =================
app.post('/register', (req, res) => {

    const { email, password, full_name, phone_number, dev_category } = req.body;

    db.query("SELECT * FROM users WHERE email=?", [email], (err, results) => {
        if (results.length > 0) {
            return res.redirect("/register.html?error=exists");
        }

        const apiKey = uuidv4();

        db.query(
            "INSERT INTO users (full_name, phone_number, dev_category, email, password, api_key) VALUES (?, ?, ?, ?, ?, ?)",
            [full_name, phone_number, dev_category, email, password, apiKey],
            (err) => {
                if (err) {
                    console.error("DB Insert Error: ", err);
                    return res.redirect("/register.html?error=1");
                }

                res.redirect("/login.html");
            }
        );
    });
});

// ================= LOGIN =================
app.post('/login', (req, res) => {

    const { email, password } = req.body;

    db.query(
        "SELECT * FROM users WHERE email=?",
        [email],
        (err, results) => {

            if (results.length === 0) {
                return res.redirect('/login.html?error=no_user');
            }

            const user = results[0];

            if (user.password !== password) {
                return res.redirect('/login.html?error=wrong_pass');
            }

            res.redirect(`/dashboard/${user.id}`);
        }
    );
});

// ================= DISCONNECT =================
app.post('/disconnect/:id', async (req, res) => {
    const userId = req.params.id;
    const userSession = users[userId];

    console.log(`🔴 Disconnect requested for user: ${userId}`);

    try {
        if (userSession && userSession.client) {

            // 🛑 Remove all listeners (VERY IMPORTANT to prevent crash)
            userSession.client.removeAllListeners();

            // 🔥 Destroy client safely (better than logout)
            await userSession.client.destroy();

            console.log(`✅ Client destroyed for user: ${userId}`);
        }
    } catch (err) {
        console.log(`❌ Error destroying client (${userId}):`, err.message);
    }

    // 🧹 Remove from memory
    delete users[userId];

    // 🗑️ Delete session folder
    const sessionDir = path.join(__dirname, '.wwebjs_auth', 'session-' + userId);
    if (fs.existsSync(sessionDir)) {
        try {
            fs.rmSync(sessionDir, { recursive: true, force: true });
            console.log(`🧹 Session deleted for user: ${userId}`);
        } catch (e) {
            console.log(`❌ Error deleting session (${userId}):`, e.message);
        }
    }

    // ⏳ Small delay to stabilize puppeteer (VERY IMPORTANT)
    setTimeout(() => {
        res.redirect(`/dashboard/${userId}`);
    }, 1000);
});

// ================= DASHBOARD =================
app.get('/dashboard/:id', (req, res) => {
    const userId = req.params.id;
    const host = req.get('host');

    db.query("SELECT * FROM users WHERE id=?", [userId], (err, results) => {
        if (results.length === 0) return res.send("User not found");

        const dbUser = results[0];
        createClient(userId);
        const user = users[userId];

        const statusLabel = user.ready ? 'CONNECTED' : 'SCAN_NEEDED';
        const statusColor = user.ready ? '#00ff88' : '#f97316';
        const currentMonthName = new Date().toLocaleString('default', { month: 'long' }).toUpperCase();

        db.query("SELECT COUNT(*) AS total_sent FROM otp_logs WHERE user_id=? AND MONTH(created_at) = MONTH(CURRENT_DATE()) AND YEAR(created_at) = YEAR(CURRENT_DATE())", [userId], (err, countResults) => {
            const totalSent = countResults && countResults.length > 0 ? countResults[0].total_sent : 0;
            const maxLimit = 1550; // Set to 1550 for monthly total (50/day * 31 days)
            const percentage = Math.min((totalSent / maxLimit) * 100, 100);
            const dashOffset = 289 - (289 * percentage) / 100;

            res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Extreme Verify Console</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
            --bg:         #000000;
            --surface-1:  #0a0a0a;
            --surface-2:  #141414;
            --surface-3:  #1c1c1e;
            --border:     rgba(255,255,255,0.08);
            --blue:       #0a84ff;
            --blue-dim:   rgba(10,132,255,0.1);
            --green:      #30d158;
            --green-dim:  rgba(48,209,88,0.1);
            --orange:     #ff9f0a;
            --orange-dim: rgba(255,159,10,0.1);
            --red:        #ff453a;
            --text-1:     #ffffff;
            --text-2:     rgba(235,235,245,0.8);
            --text-3:     rgba(235,235,245,0.38);
            --mono:       'JetBrains Mono', monospace;
            --sans:       'Inter', sans-serif;
            --radius:     10px;
            --radius-lg:  14px;
        }

        html, body { height: 100%; }

        body {
            font-family: var(--sans);
            background: #000000;
            color: var(--text-1);
            display: flex;
            height: 100vh;
            overflow: hidden;
            -webkit-font-smoothing: antialiased;
        }

        /* ─── SIDEBAR ─────────────────────────────── */
        .sidebar {
            width: 240px;
            flex-shrink: 0;
            background: var(--surface-1);
            border-right: 1px solid var(--border);
            display: flex;
            flex-direction: column;
            padding: 24px 16px;
            gap: 4px;
        }

        .sidebar-logo {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 0 10px 28px;
        }

        .logo-icon {
            width: 32px; height: 32px;
            border-radius: 50%;
            object-fit: cover;
        }

        .logo-text {
            font-size: 17px;
            font-weight: 700;
            letter-spacing: -0.3px;
            color: var(--text-1);
        }

        .sidebar-section {
            font-family: var(--mono);
            font-size: 10px;
            font-weight: 500;
            color: var(--text-3);
            letter-spacing: 0.12em;
            text-transform: uppercase;
            padding: 16px 10px 6px;
        }

        .nav-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 12px;
            border-radius: var(--radius);
            color: var(--text-2);
            text-decoration: none;
            font-size: 13.5px;
            font-weight: 500;
            transition: background 0.15s, color 0.15s;
            cursor: pointer;
            border: none;
            background: none;
            width: 100%;
            text-align: left;
        }

        .nav-item svg { opacity: 0.6; flex-shrink: 0; }

        .nav-item:hover { background: var(--surface-2); color: var(--text-1); }
        .nav-item:hover svg { opacity: 1; }

        .nav-item.active {
            background: var(--blue);
            color: #ffffff;
            font-weight: 500;
        }
        .nav-item.active svg { opacity: 1; }

        .nav-item.danger { color: #ef4444; }
        .nav-item.danger svg { opacity: 0.8; }
        .nav-item.danger:hover { background: rgba(239,68,68,0.08); }

        .sidebar-spacer { flex: 1; }

        .sidebar-user {
            padding: 14px;
            border-radius: var(--radius);
            background: var(--surface-2);
            border: 1px solid var(--border);
            margin-bottom: 8px;
        }

        .sidebar-user-name {
            font-size: 13px;
            font-weight: 600;
            color: var(--text-1);
            margin-bottom: 2px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .sidebar-user-email {
            font-size: 11px;
            color: var(--text-3);
            font-family: var(--mono);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .sidebar-user-badge {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            margin-top: 7px;
            font-size: 10px;
            font-family: var(--mono);
            font-weight: 500;
            color: var(--blue);
            background: rgba(10,132,255,0.12);
            padding: 2px 8px;
            border-radius: 100px;
            letter-spacing: 0.04em;
        }

        /* ─── MAIN ────────────────────────────────── */
        .main {
            flex: 1;
            overflow-y: auto;
            padding: 28px 36px;
            background: #000000;
        }

        /* ─── TOP BAR ─────────────────────────────── */
        .topbar {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            margin-bottom: 32px;
        }

        .topbar-title {
            font-size: 28px;
            font-weight: 700;
            letter-spacing: -0.5px;
            line-height: 1.1;
        }

        .topbar-title span:first-child { color: var(--blue); }
        .topbar-title span:last-child  { color: rgba(255,255,255,0.35); font-style: italic; font-weight: 300; }

        .topbar-sub {
            font-size: 12px;
            font-family: var(--mono);
            color: var(--text-3);
            margin-top: 4px;
            letter-spacing: 0.05em;
        }

        .topbar-right {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .status-pill {
            display: inline-flex;
            align-items: center;
            gap: 7px;
            padding: 7px 14px;
            border-radius: 100px;
            font-size: 11px;
            font-family: var(--mono);
            font-weight: 600;
            letter-spacing: 0.08em;
            border: 1px solid;
        }

        .status-pill.connected {
            background: var(--green-dim);
            border-color: rgba(0,255,136,0.25);
            color: var(--green);
        }

        .status-pill.pending {
            background: var(--orange-dim);
            border-color: rgba(249,115,22,0.25);
            color: var(--orange);
        }

        .dot {
            width: 7px; height: 7px;
            border-radius: 50%;
            background: currentColor;
            animation: blink 1.6s ease-in-out infinite;
        }

        @keyframes blink {
            0%,100% { opacity: 1; }
            50%      { opacity: 0.3; }
        }

        .icon-btn {
            width: 36px; height: 36px;
            border-radius: 10px;
            background: var(--surface-2);
            border: 1px solid var(--border);
            display: flex; align-items: center; justify-content: center;
            cursor: pointer;
            color: var(--text-2);
            transition: background 0.15s, color 0.15s;
        }
        .icon-btn:hover { background: var(--surface-3); color: var(--text-1); }

        /* ─── GRID ────────────────────────────────── */
        .grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 20px;
        }

        .card {
            background: var(--surface-1);
            border: 1px solid var(--border);
            border-radius: var(--radius-lg);
            padding: 24px;
            transition: border-color 0.2s, box-shadow 0.2s;
        }

        .card:hover {
            border-color: rgba(255,255,255,0.12);
            box-shadow: 0 4px 32px rgba(0,0,0,0.3);
        }

        .card-label {
            font-size: 10px;
            font-family: var(--mono);
            font-weight: 500;
            color: var(--text-3);
            letter-spacing: 0.14em;
            text-transform: uppercase;
            margin-bottom: 16px;
        }

        .col-span-1 { grid-column: span 1; }
        .col-span-2 { grid-column: span 2; }
        .col-span-3 { grid-column: span 3; }

        /* ─── GATEWAY CARD (QR) ───────────────────── */
        .qr-wrap {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 16px;
        }

        .qr-frame {
            background: #fff;
            padding: 14px;
            border-radius: 14px;
            line-height: 0;
        }

        .qr-frame img { width: 130px; height: 130px; border-radius: 4px; }

        .qr-ready-icon {
            width: 100px; height: 100px;
            border-radius: 50%;
            background: var(--green-dim);
            border: 2px solid rgba(0,255,136,0.3);
            display: flex; align-items: center; justify-content: center;
            font-size: 36px;
        }

        .state-label {
            font-family: var(--mono);
            font-size: 11px;
            font-weight: 600;
            letter-spacing: 0.1em;
        }

        /* ─── NEURAL LOAD CARD ────────────────────── */
        .neural-center {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            gap: 12px;
        }

        .ring-wrap {
            position: relative;
            width: 110px; height: 110px;
        }

        .ring-wrap svg { transform: rotate(-90deg); }

        .ring-val {
            position: absolute;
            inset: 0;
            display: flex; align-items: center; justify-content: center;
            flex-direction: column;
        }

        .ring-num {
            font-size: 28px;
            font-weight: 700;
            line-height: 1;
        }

        .ring-sub {
            font-size: 9px;
            font-family: var(--mono);
            color: var(--text-3);
            letter-spacing: 0.1em;
            margin-top: 2px;
        }

        .live-badge {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            font-size: 10px;
            font-family: var(--mono);
            font-weight: 600;
            color: var(--green);
            letter-spacing: 0.08em;
        }

        .tier-badge {
            font-size: 11px;
            font-family: var(--mono);
            font-weight: 600;
            color: var(--blue);
            letter-spacing: 0.1em;
        }

        /* ─── PULSE CLUSTER CARD ──────────────────── */
        .metric-row {
            margin-bottom: 16px;
        }

        .metric-top {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 6px;
        }

        .metric-name {
            font-size: 10px;
            font-family: var(--mono);
            color: var(--text-3);
            letter-spacing: 0.1em;
            text-transform: uppercase;
        }

        .metric-val {
            font-size: 12px;
            font-family: var(--mono);
            font-weight: 600;
        }

        .metric-bar {
            height: 4px;
            border-radius: 2px;
            background: var(--surface-3);
            overflow: hidden;
        }

        .metric-fill {
            height: 100%;
            border-radius: 2px;
            transition: width 0.5s ease;
        }

        .terminal-block {
            margin-top: 16px;
            background: #000;
            border: 1px solid rgba(255,255,255,0.06);
            border-radius: 8px;
            padding: 12px 14px;
            font-family: var(--mono);
            font-size: 11px;
            line-height: 1.9;
        }

        .terminal-line { display: flex; gap: 8px; align-items: center; }
        .term-arrow { color: var(--blue); }
        .term-key   { color: var(--text-3); }
        .term-val   { color: var(--text-2); }
        .term-val.orange { color: var(--orange); }
        .term-val.green  { color: var(--green); }

        /* ─── FEATURE CARDS ──────────────────────── */
        .feature-card {
            display: flex;
            gap: 16px;
            align-items: flex-start;
        }

        .feature-icon {
            width: 40px; height: 40px; flex-shrink: 0;
            border-radius: 10px;
            display: flex; align-items: center; justify-content: center;
        }

        .feature-title {
            font-size: 13px;
            font-weight: 700;
            letter-spacing: 0.04em;
            text-transform: uppercase;
            margin-bottom: 6px;
        }

        .feature-desc {
            font-size: 12.5px;
            color: var(--text-2);
            line-height: 1.6;
        }

        .feature-desc a {
            color: inherit;
            text-decoration: underline;
            text-underline-offset: 2px;
        }

        /* ─── API KEY CARD ────────────────────────── */
        .api-key-row {
            display: flex;
            align-items: center;
            gap: 10px;
            background: rgba(0,0,0,0.4);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            padding: 12px 16px;
        }

        .api-key-text {
            flex: 1;
            font-family: var(--mono);
            font-size: 12px;
            color: var(--blue);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .btn-copy {
            flex-shrink: 0;
            padding: 6px 13px;
            border-radius: 7px;
            background: var(--surface-3);
            border: 1px solid var(--border);
            color: rgba(255,255,255,0.7);
            font-size: 11px;
            font-family: var(--mono);
            font-weight: 600;
            letter-spacing: 0.06em;
            cursor: pointer;
            transition: background 0.12s, color 0.12s;
        }

        .btn-copy:hover { background: #2a2a2a; color: #fff; }

        /* ─── OTP TEST CARD ───────────────────────── */
        .input-row {
            display: flex;
            gap: 10px;
            align-items: center;
        }

        .input-field {
            flex: 1;
            padding: 10px 14px;
            background: #000;
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: var(--radius);
            color: #fff;
            font-family: var(--mono);
            font-size: 13px;
            outline: none;
            transition: border-color 0.12s;
            -webkit-font-smoothing: antialiased;
        }

        .input-field::placeholder { color: var(--text-3); }
        .input-field:focus { border-color: rgba(10,132,255,0.5); }

        .btn-primary {
            padding: 11px 22px;
            border-radius: var(--radius);
            background: var(--blue);
            border: none;
            color: #fff;
            font-family: var(--sans);
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            white-space: nowrap;
            transition: opacity 0.15s;
        }

        .btn-primary:hover { opacity: 0.85; }
        .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

        /* ─── CODE CARD ───────────────────────────── */
        .tabs {
            display: flex;
            gap: 6px;
            margin-bottom: 16px;
        }

        .tab-btn {
            padding: 7px 14px;
            border-radius: 8px;
            background: transparent;
            border: 1px solid var(--border);
            color: var(--text-3);
            font-family: var(--mono);
            font-size: 11px;
            font-weight: 600;
            cursor: pointer;
            letter-spacing: 0.05em;
            transition: background 0.15s, color 0.15s;
        }

        .tab-btn:hover { color: var(--text-2); background: var(--surface-2); }
        .tab-btn.active { background: #222; color: #fff; border-color: rgba(255,255,255,0.14); }

        .code-block {
            display: none;
            background: #000;
            border: none;
            border-radius: 0;
            padding: 20px 24px;
            font-family: var(--mono);
            font-size: 13px;
            line-height: 1.9;
            color: rgba(255,255,255,0.5);
            overflow-x: auto;
            white-space: pre;
            tab-size: 4;
        }

        .code-block.active { display: block; }

        /* Syntax tokens — Xcode dark palette */
        .t-kw  { color: #ff7ab2; }
        .t-fn  { color: #6bdfff; }
        .t-str { color: #fc6; }
        .t-num { color: #ff8170; }
        .t-var { color: #ffffff; }
        .t-key { color: #9ef0f0; }
        .t-cm  { color: #5c6773; font-style: italic; }
        .t-op  { color: rgba(255,255,255,0.4); }
        .t-met { color: #dabaff; }

        .code-actions {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
        }

        .card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }

        .card-title {
            font-size: 14px;
            font-weight: 600;
            color: var(--text-1);
        }

        .card-sub {
            font-size: 12px;
            color: var(--text-3);
            margin-top: 2px;
        }

        /* ─── FAQ ─────────────────────────────────── */
        .faq-item {
            border-left: 2px solid var(--blue);
            padding: 4px 0 4px 16px;
        }

        .faq-q {
            font-size: 10px;
            font-family: var(--mono);
            font-weight: 600;
            color: var(--blue);
            letter-spacing: 0.06em;
            text-transform: uppercase;
            margin-bottom: 4px;
        }

        .faq-a {
            font-size: 12px;
            color: var(--text-2);
            line-height: 1.6;
        }

        /* ─── DISCONNECT BTN ──────────────────────── */
        .btn-danger {
            padding: 8px 16px;
            border-radius: 10px;
            background: rgba(239,68,68,0.08);
            border: 1px solid rgba(239,68,68,0.2);
            color: var(--red);
            font-family: var(--mono);
            font-size: 11px;
            font-weight: 600;
            cursor: pointer;
            letter-spacing: 0.06em;
            transition: background 0.15s;
            text-decoration: none;
            display: inline-block;
        }

        .btn-danger:hover { background: rgba(239,68,68,0.15); }

        /* scrollbar */
        .main::-webkit-scrollbar { width: 5px; }
        .main::-webkit-scrollbar-track { background: transparent; }
        .main::-webkit-scrollbar-thumb { background: var(--surface-3); border-radius: 3px; }
    </style>

    <script>
        /* ── Tab Switching ── */
        const filenames = { php: 'send_otp.php', node: 'sendOtp.js', py: 'send_otp.py' };
        function switchTab(lang) {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.code-block').forEach(p => p.classList.remove('active'));
            document.getElementById('tab-' + lang).classList.add('active');
            document.getElementById('code-' + lang).classList.add('active');
            const fn = document.getElementById('editor-filename');
            if (fn) fn.innerText = filenames[lang] || '';
        }

        /* ── Copy Key ── */
        function copyKey() {
            navigator.clipboard.writeText("${dbUser.api_key}");
            const btn = document.getElementById("copyBtn");
            const orig = btn.innerText;
            btn.innerText = "COPIED!";
            btn.style.color = "var(--green)";
            btn.style.borderColor = "rgba(0,255,136,0.3)";
            setTimeout(() => { btn.innerText = orig; btn.style.color = ""; btn.style.borderColor = ""; }, 2000);
        }

        /* ── Toggle Key Visibility ── */
        function toggleKey(btn) {
            const el = document.getElementById("apiKeyDisplay");
            const visible = btn.dataset.visible === "true";
            if (visible) {
                el.innerText = "${'•'.repeat(36)}";
                btn.innerText = "SHOW";
                btn.dataset.visible = "false";
            } else {
                el.innerText = "${dbUser.api_key}";
                btn.innerText = "HIDE";
                btn.dataset.visible = "true";
            }
        }

        /* ── Copy Snippet ── */
        function copySnippet(btn) {
            const active = document.querySelector('.code-block.active');
            if (active) {
                navigator.clipboard.writeText(active.innerText.trim());
                btn.innerText = "COPIED!";
                setTimeout(() => btn.innerText = "COPY", 2000);
            }
        }

        /* ── Auto-refresh for stats & QR ── */
        setInterval(async () => {
            try {
                const res  = await fetch("/api/status/${userId}");
                const data = await res.json();
                
                // Live update Neural Load (Monthly Total)
                const totalSent = data.total_sent || 0;
                const maxLimit = 1550; 
                const percentage = Math.min((totalSent / maxLimit) * 100, 100);
                const dashOffset = 289 - (289 * percentage) / 100;
                
                const ringNum = document.querySelector('.ring-num');
                if (ringNum && ringNum.innerText != totalSent) {
                    ringNum.innerText = totalSent;
                }
                const ringCircle = document.querySelector('.ring-wrap svg circle:nth-child(2)');
                if (ringCircle) {
                    ringCircle.style.strokeDashoffset = dashOffset;
                }

                // QR / Ready logic
                if (!${user.ready}) {
                    if (data.ready) {
                        location.reload();
                    } else if (data.qr) {
                        const img = document.getElementById("qr-image");
                        if (img && img.src !== data.qr) img.src = data.qr;
                        else if (!img) location.reload();
                    }
                }
            } catch(e) {}
        }, 3000);
    </script>
</head>
<body>

<!-- ───────────────── SIDEBAR ───────────────── -->
<aside class="sidebar">
    <div class="sidebar-logo">
        <img src="https://extremeweb.in/images/extreme.png" alt="Extreme Logo" class="logo-icon">
        <span class="logo-text">Extreme Verify</span>
    </div>

    <span class="sidebar-section">Navigation</span>

    <a class="nav-item active" href="/dashboard/${userId}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
        Overview
    </a>
    <a class="nav-item" href="/api-key/${userId}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
        API Key
    </a>
    <a class="nav-item" href="/live/${userId}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        Live Graph
    </a>
    <a class="nav-item" href="/docs/${userId}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        Docs
    </a>
    <a class="nav-item" href="/settings/${userId}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        Settings
    </a>

    <div class="sidebar-spacer"></div>

    <div class="sidebar-user">
        <div class="sidebar-user-name">${dbUser.full_name || 'User'}</div>
        <div class="sidebar-user-email">${dbUser.email}</div>
        <div class="sidebar-user-badge">
            <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><circle cx="4" cy="4" r="4"/></svg>
            ${dbUser.dev_category || 'DEVELOPER'}
        </div>
    </div>

    <a href="/login.html" class="nav-item danger">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        Logout
    </a>
</aside>

<!-- ───────────────── MAIN ───────────────── -->
<main class="main">

    <!-- Top Bar -->
    <div class="topbar">
        <div>
            <div class="topbar-title">
                <span>CONSOLE</span> <span>USER</span>
            </div>
            <div class="topbar-sub">${dbUser.email}</div>
        </div>
        <div class="topbar-right">
            <div class="status-pill ${user.ready ? 'connected' : 'pending'}">
                <span class="dot"></span>
                ${statusLabel}
            </div>
            <form action="/dashboard/${userId}" method="GET" style="margin:0;">
                <button type="submit" class="icon-btn" title="Refresh">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                </button>
            </form>
        </div>
    </div>

    <!-- Grid -->
    <div class="grid">

        <!-- ── INSTANCE GATEWAY (QR) ── -->
        <div class="card col-span-1">
            <div class="card-label">Instance Gateway</div>
            <div class="qr-wrap">
                ${!user.ready && user.qr
                    ? `<div class="qr-frame"><img id="qr-image" src="${user.qr}" width="130" height="130" alt="QR Code"/></div>
                       <div class="state-label" style="color:var(--orange)">STATE: SCAN_NEEDED</div>
                       <form action="/disconnect/${userId}" method="POST">
                           <button type="submit" class="btn-danger">↺ RESET SESSION</button>
                       </form>`
                    : user.ready
                        ? `<div class="qr-ready-icon">✓</div>
                       <div class="state-label" style="color:var(--green)">STATE: CONNECTED</div>
                       <form action="/disconnect/${userId}" method="POST">
                           <button type="submit" class="btn-danger">⏻ DISCONNECT</button>
                       </form>`
                        : `<div style="color:var(--text-3); font-family:var(--mono); font-size:12px; padding:30px 0; text-align:center;">Initializing…</div>`
                }
            </div>
        </div>

        <!-- ── NEURAL LOAD ── -->
        <div class="card col-span-1">
            <div class="card-label" style="display:flex; justify-content:space-between;">
                Neural Load
                <span class="live-badge"><span class="dot"></span>LIVE</span>
            </div>
            <div class="neural-center">
                <div class="ring-wrap">
                    <svg width="110" height="110" viewBox="0 0 110 110">
                        <circle cx="55" cy="55" r="46" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="8"/>
                        <circle cx="55" cy="55" r="46" fill="none" stroke="var(--blue)" stroke-width="8"
                            stroke-dasharray="289" stroke-dashoffset="${dashOffset}" stroke-linecap="round"
                            style="transition:stroke-dashoffset 1s ease;"/>
                    </svg>
                    <div class="ring-val">
                        <span class="ring-num">${totalSent}</span>
                        <span class="ring-sub">SENT</span>
                    </div>
                </div>
                <div class="tier-badge" style="display:inline-flex; align-items:center; gap:6px;">PLAN: SANDBOX <span style="background:var(--blue); color:#fff; padding:1px 6px; border-radius:4px; font-weight:700; letter-spacing:0.02em;">${currentMonthName}</span></div>
                <div style="font-size:9px; color:var(--text-3); font-family:var(--mono); margin-top:2px;">Monthly messages sent by this account</div>
            </div>
        </div>

        <!-- ── PULSE CLUSTER ── -->
        <div class="card col-span-1">
            <div class="card-label" style="display:flex; align-items:center; gap:6px;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                Pulse Cluster
            </div>

            <div class="metric-row">
                <div class="metric-top">
                    <span class="metric-name">Tunnel Latency</span>
                    <span class="metric-val" style="color:var(--blue)">149MS</span>
                </div>
                <div class="metric-bar"><div class="metric-fill" style="width:65%; background:var(--blue);"></div></div>
            </div>

            <div class="metric-row">
                <div class="metric-top">
                    <span class="metric-name">Success Rate</span>
                    <span class="metric-val" style="color:var(--green)">100%</span>
                </div>
                <div class="metric-bar"><div class="metric-fill" style="width:100%; background:var(--green);"></div></div>
            </div>

            <div class="terminal-block">
                <div class="terminal-line">
                    <span class="term-arrow">→</span>
                    <span class="term-key">node:</span>
                    <span class="term-val">LK0-TIN-01</span>
                </div>
                <div class="terminal-line">
                    <span class="term-arrow">→</span>
                    <span class="term-key">status:</span>
                    <span class="term-val ${user.ready ? 'green' : 'orange'}">${statusLabel}</span>
                </div>
                <div class="terminal-line">
                    <span class="term-arrow">→</span>
                    <span class="term-key">user:</span>
                    <span class="term-val">${dbUser.id}</span>
                </div>
            </div>
        </div>

        <!-- ── END-TO-END ENCRYPTION ── -->
        <div class="card col-span-1">
            <div class="feature-card">
                <div class="feature-icon" style="background:rgba(59,130,246,0.1); border:1px solid rgba(59,130,246,0.2);">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                </div>
                <div>
                    <div class="feature-title" style="color:var(--blue)">End-to-End Encryption</div>
                    <div class="feature-desc">Your private chats, media, and contact lists are <u>never stored</u> on our servers. All session tokens are locally encrypted.</div>
                </div>
            </div>
        </div>

        <!-- ── COMPLIANCE ── -->
        <div class="card col-span-2">
            <div class="feature-card">
                <div class="feature-icon" style="background:rgba(249,115,22,0.1); border:1px solid rgba(249,115,22,0.2);">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--orange)" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                </div>
                <div>
                    <div class="feature-title" style="color:var(--orange)">Compliance &amp; Anti-Spam</div>
                    <div class="feature-desc">Extreme Verify is an independent API and is not affiliated with Meta. <u><strong>Spamming is strictly prohibited</strong></u>. We hold no liability for account suspensions. Use responsibly.</div>
                </div>
            </div>
        </div>

        <!-- ── API KEY ── -->
        <div class="card col-span-3">
            <div class="card-header">
                <div>
                    <div class="card-title" style="display:flex;align-items:center;gap:8px;">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
                        Authentication Key
                    </div>
                    <div class="card-sub">Used to authenticate all API requests</div>
                </div>
            </div>
            <div style="background:#000; border:1px solid rgba(255,255,255,0.09); border-radius:var(--radius); padding:0; overflow:hidden;">
                <div style="display:flex; align-items:center; padding:4px 6px 4px 16px; gap:10px;">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" stroke-width="2" style="flex-shrink:0;"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
                    <span id="apiKeyDisplay" style="flex:1; font-family:var(--mono); font-size:13px; color:var(--blue); letter-spacing:0.05em; padding:12px 0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${'•'.repeat(36)}</span>
                    <div style="display:flex;gap:6px;flex-shrink:0;">
                        <button onclick="toggleKey(this)" style="padding:7px 13px; border-radius:8px; background:var(--surface-3); border:1px solid var(--border); color:var(--text-2); font-family:var(--mono); font-size:11px; font-weight:600; cursor:pointer; letter-spacing:0.05em;" data-visible="false">SHOW</button>
                        <button class="btn-copy" id="copyBtn" onclick="copyKey()">COPY</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- ── IMPLEMENTATION SNIPPETS ── -->
        <div class="card col-span-3">
            <div class="code-actions">
                <div>
                    <div class="card-title" style="display:flex;align-items:center;gap:8px;">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                        Implementation Snippets
                    </div>
                    <div class="card-sub">Copy &amp; integrate into your project</div>
                </div>
                <button class="btn-copy" onclick="copySnippet(this)">COPY</button>
            </div>
            <div class="tabs">
                <button id="tab-php"  class="tab-btn active" onclick="switchTab('php')">
                    <span style="color:#f07178;">🐘</span> PHP · cURL
                </button>
                <button id="tab-node" class="tab-btn" onclick="switchTab('node')">
                    <span style="color:#c3e88d;">⬡</span> Node.js · Axios
                </button>
                <button id="tab-py"   class="tab-btn" onclick="switchTab('py')">
                    <span style="color:#ffcb6b;">🐍</span> Python · Requests
                </button>
            </div>

                <!-- editor chrome wrapper -->
                <div style="border:1px solid rgba(255,255,255,0.08); border-radius:var(--radius); overflow:hidden;">
                    <!-- titlebar -->
                    <div style="background:#111; border-bottom:1px solid rgba(255,255,255,0.07); padding:9px 16px; display:flex; align-items:center; gap:8px;">
                    <span style="width:10px;height:10px;border-radius:50%;background:#ef4444;display:inline-block;"></span>
                    <span style="width:10px;height:10px;border-radius:50%;background:#f59e0b;display:inline-block;"></span>
                    <span style="width:10px;height:10px;border-radius:50%;background:#22c55e;display:inline-block;"></span>
                    <span id="editor-filename" style="margin-left:10px; font-family:var(--mono); font-size:11px; color:var(--text-3);">send_otp.php</span>
                    <span style="margin-left:auto; font-family:var(--mono); font-size:10px; color:var(--text-3); letter-spacing:0.08em;">Extreme Verify API</span>
                </div>
                <div id="code-php" class="code-block active"><span class="t-cm">// PHP · cURL — send OTP via Extreme Verify API</span>
<span class="t-kw">$</span><span class="t-var">data</span> <span class="t-op">=</span> <span class="t-op">[</span>
    <span class="t-str">"apiKey"</span> <span class="t-op">=></span> <span class="t-str">"${dbUser.api_key}"</span><span class="t-op">,</span>
    <span class="t-str">"number"</span> <span class="t-op">=></span> <span class="t-str">"91XXXXXXXXXX"</span><span class="t-op">,</span>
    <span class="t-str">"otp"</span>    <span class="t-op">=></span> <span class="t-fn">rand</span><span class="t-op">(</span><span class="t-num">1111</span><span class="t-op">,</span> <span class="t-num">9999</span><span class="t-op">)</span>
<span class="t-op">];</span>

<span class="t-kw">$</span><span class="t-var">ch</span> <span class="t-op">=</span> <span class="t-fn">curl_init</span><span class="t-op">(</span><span class="t-str">"http://${host}/api/send-otp"</span><span class="t-op">);</span>
<span class="t-fn">curl_setopt</span><span class="t-op">(</span><span class="t-kw">$</span><span class="t-var">ch</span><span class="t-op">,</span> <span class="t-key">CURLOPT_RETURNTRANSFER</span><span class="t-op">,</span> <span class="t-kw">true</span><span class="t-op">);</span>
<span class="t-fn">curl_setopt</span><span class="t-op">(</span><span class="t-kw">$</span><span class="t-var">ch</span><span class="t-op">,</span> <span class="t-key">CURLOPT_POSTFIELDS</span><span class="t-op">,</span>     <span class="t-fn">json_encode</span><span class="t-op">(</span><span class="t-kw">$</span><span class="t-var">data</span><span class="t-op">));</span>
<span class="t-fn">curl_setopt</span><span class="t-op">(</span><span class="t-kw">$</span><span class="t-var">ch</span><span class="t-op">,</span> <span class="t-key">CURLOPT_HTTPHEADER</span><span class="t-op">,</span>      <span class="t-op">[</span><span class="t-str">"Content-Type: application/json"</span><span class="t-op">]);</span>
<span class="t-kw">echo</span> <span class="t-fn">curl_exec</span><span class="t-op">(</span><span class="t-kw">$</span><span class="t-var">ch</span><span class="t-op">);</span></div>

                <div id="code-node" class="code-block"><span class="t-cm">// Node.js · Axios — send OTP via Extreme Verify API</span>
<span class="t-kw">const</span> <span class="t-var">axios</span> <span class="t-op">=</span> <span class="t-fn">require</span><span class="t-op">(</span><span class="t-str">'axios'</span><span class="t-op">);</span>

<span class="t-var">axios</span><span class="t-op">.</span><span class="t-met">post</span><span class="t-op">(</span><span class="t-str">'http://${host}/api/send-otp'</span><span class="t-op">,</span> <span class="t-op">{</span>
    <span class="t-key">apiKey</span><span class="t-op">:</span> <span class="t-str">"${dbUser.api_key}"</span><span class="t-op">,</span>
    <span class="t-key">number</span><span class="t-op">:</span> <span class="t-str">"91XXXXXXXXXX"</span><span class="t-op">,</span>
    <span class="t-key">otp</span><span class="t-op">:</span>    <span class="t-str">"1234"</span>
<span class="t-op">})</span>
<span class="t-op">.</span><span class="t-met">then</span><span class="t-op">(</span><span class="t-var">res</span>  <span class="t-op">=></span> <span class="t-var">console</span><span class="t-op">.</span><span class="t-fn">log</span><span class="t-op">(</span><span class="t-var">res</span><span class="t-op">.</span><span class="t-key">data</span><span class="t-op">))</span>
<span class="t-op">.</span><span class="t-met">catch</span><span class="t-op">(</span><span class="t-var">err</span> <span class="t-op">=></span> <span class="t-var">console</span><span class="t-op">.</span><span class="t-fn">error</span><span class="t-op">(</span><span class="t-var">err</span><span class="t-op">));</span></div>

                <div id="code-py" class="code-block"><span class="t-cm"># Python · Requests — send OTP via Extreme Verify API</span>
<span class="t-kw">import</span> <span class="t-var">requests</span>

<span class="t-var">url</span>  <span class="t-op">=</span> <span class="t-str">"http://${host}/api/send-otp"</span>
<span class="t-var">data</span> <span class="t-op">=</span> <span class="t-op">{</span>
    <span class="t-str">"apiKey"</span><span class="t-op">:</span> <span class="t-str">"${dbUser.api_key}"</span><span class="t-op">,</span>
    <span class="t-str">"number"</span><span class="t-op">:</span> <span class="t-str">"91XXXXXXXXXX"</span><span class="t-op">,</span>
    <span class="t-str">"otp"</span><span class="t-op">:</span>    <span class="t-str">"1234"</span>
<span class="t-op">}</span>

<span class="t-var">response</span> <span class="t-op">=</span> <span class="t-var">requests</span><span class="t-op">.</span><span class="t-met">post</span><span class="t-op">(</span><span class="t-var">url</span><span class="t-op">,</span> <span class="t-key">json</span><span class="t-op">=</span><span class="t-var">data</span><span class="t-op">)</span>
<span class="t-fn">print</span><span class="t-op">(</span><span class="t-var">response</span><span class="t-op">.</span><span class="t-met">json</span><span class="t-op">())</span></div>
            </div>
        </div>

        <!-- ── FAQ ── -->
        <div class="card col-span-3" style="margin-bottom: 80px;">
            <div class="card-label" style="margin-bottom:20px;">Frequently Asked Questions</div>
            <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:24px;">
                <div class="faq-item">
                    <div class="faq-q">Q: Is my account data secure?</div>
                    <div class="faq-a">Yes, all session files are stored using AES-256 encryption protocols on isolated nodes.</div>
                </div>
                <div class="faq-item">
                    <div class="faq-q">Q: How to prevent account bans?</div>
                    <div class="faq-a">Avoid rapid-fire bulk messaging. We recommend a 2–5 second delay between transmissions.</div>
                </div>
                <div class="faq-item">
                    <div class="faq-q">Q: When does a session expire?</div>
                    <div class="faq-a">Sessions remain active indefinitely until you manually trigger a logout from the WhatsApp mobile app.</div>
                </div>
            </div>
        </div>

    </div><!-- /grid -->
</main>

<footer style="
    position: fixed;
    bottom: 0;
    left: 240px; /* sidebar width */
    right: 0;
    text-align: center;
    padding: 14px;
    font-size: 12px;
    font-family: var(--mono);
    color: rgba(255,255,255,0.5);
    border-top: 1px solid rgba(255,255,255,0.08);
    background: #000;
    z-index: 100;
">
    Developed by <span style="color:#0a84ff; font-weight:600;">Anubhav Singh</span> — Extreme Verify Console
</footer>

</body>
</html>`);
        });
    });
});

// ================= LIVE GRAPH ENDPOINTS =================
app.get('/live/:id', (req, res) => {
    const userId = req.params.id;
    db.query("SELECT * FROM users WHERE id=?", [userId], (err, results) => {
        if (err || results.length === 0) return res.redirect('/login.html');
        try {
            let html = fs.readFileSync(path.join(__dirname, 'live.html'), 'utf-8');
            html = html.replace(/{{USER_ID}}/g, userId)
                .replace(/{{EMAIL}}/g, results[0].email)
                .replace(/{{FULL_NAME}}/g, results[0].full_name || 'User')
                .replace(/{{DEV_CATEGORY}}/g, results[0].dev_category || 'DEVELOPER');
            res.send(html);
        } catch (err) {
            res.status(500).send("Error loading page");
        }
    });
});

app.get('/api/live-data/:id', (req, res) => {
    const userId = req.params.id;
    db.query(`
        SELECT DATE(created_at) as date, type, COUNT(*) as count 
        FROM otp_logs 
        WHERE user_id=? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
        GROUP BY DATE(created_at), type 
        ORDER BY DATE(created_at) ASC
    `, [userId], (err, results) => {
        if (err) return res.json({ error: 'DB Error' });

        const labels = [];
        const customCounts = [];
        const otpCounts = [];

        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            labels.push(`${yyyy}-${mm}-${dd}`);
            customCounts.push(0);
            otpCounts.push(0);
        }

        results.forEach(row => {
            const rDate = new Date(row.date);
            const rYyyy = rDate.getFullYear();
            const rMm = String(rDate.getMonth() + 1).padStart(2, '0');
            const rDd = String(rDate.getDate()).padStart(2, '0');
            const dStr = `${rYyyy}-${rMm}-${rDd}`;

            const idx = labels.indexOf(dStr);
            if (idx !== -1) {
                if (row.type === 'custom') {
                    customCounts[idx] += row.count;
                } else {
                    otpCounts[idx] += row.count;
                }
            }
        });

        res.json({ labels, customCounts, otpCounts });
    });
});

// ================= API KEY PAGE =================
app.get('/api-key/:id', (req, res) => {
    const userId = req.params.id;

    db.query("SELECT * FROM users WHERE id=?", [userId], (err, userResults) => {
        if (err || userResults.length === 0) return res.send("User not found");

        const dbUser = userResults[0];

        // Fetch daily usage count
        db.query("SELECT COUNT(*) AS dailyCount FROM otp_logs WHERE user_id=? AND DATE(created_at) = CURDATE()", [userId], (err, usageResults) => {
            const dailyCount = usageResults && usageResults.length > 0 ? usageResults[0].dailyCount : 0;
            const maxLimit = 50;
            const usagePercentage = Math.min((dailyCount / maxLimit) * 100, 100);

            db.query("SELECT * FROM otp_logs WHERE user_id=? ORDER BY created_at DESC", [userId], (err, logs) => {
                let tableHTML = "";
                if (!err && logs.length > 0) {
                    const initialLogs = logs.slice(0, 5);
                    tableHTML = initialLogs.map(log => `
                        <tr data-timestamp="${new Date(log.created_at).getTime()}">
                            <td>${log.id}</td>
                            <td>${log.number}</td>
                            <td style="font-weight: 600;">${log.type === 'custom' ? log.message : log.otp}</td>
                            <td>${log.type === 'test' ? '<span class="badge badge-sandbox">TEST</span>' : (log.type === 'custom' ? '<span class="badge" style="background: rgba(10,132,255,0.15); color: var(--blue); border: 1px solid rgba(10,132,255,0.2);">MSG</span>' : '<span class="badge badge-prod">API</span>')}</td>
                            <td style="color: rgba(255,255,255,0.4);">${new Date(log.created_at).toLocaleString()}</td>
                        </tr>
                    `).join("");
                } else {
                    tableHTML = '<tr><td colspan="5" style="text-align:center; padding: 24px;">No OTP logs found.</td></tr>';
                }

                try {
                    let html = fs.readFileSync(path.join(__dirname, 'api-key.html'), 'utf-8');
                    html = html.replace(/{{USER_ID}}/g, userId)
                        .replace(/{{FULL_NAME}}/g, dbUser.full_name || 'User')
                        .replace(/{{EMAIL}}/g, dbUser.email)
                        .replace(/{{DEV_CATEGORY}}/g, dbUser.dev_category || 'DEVELOPER')
                        .replace(/{{API_KEY}}/g, dbUser.api_key)
                        .replace(/{{DAILY_COUNT}}/g, dailyCount)
                        .replace(/{{USAGE_PERCENTAGE}}/g, usagePercentage)
                        .replace(/{{TABLE_ROWS}}/g, tableHTML);
                    res.send(html);
                } catch (err) {
                    res.status(500).send("Could not load API Key page.");
                }
            });
        });
    });
});

// ================= DOCS PAGE =================
app.get('/docs/:id', (req, res) => {
    const userId = req.params.id;
    db.query("SELECT id FROM users WHERE id=?", [userId], (err, results) => {
        if (err || results.length === 0) return res.redirect('/login.html');
        res.sendFile(path.join(__dirname, 'docs.html'));
    });
});

// ================= API LOGS ENDPOINT =================
app.get('/api/logs/:id', (req, res) => {
    const userId = req.params.id;
    db.query("SELECT * FROM otp_logs WHERE user_id=? ORDER BY created_at DESC", [userId], (err, logs) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        res.json(logs);
    });
});

// ================= SETTINGS PAGE =================
app.get('/settings/:id', (req, res) => {
    const userId = req.params.id;

    db.query("SELECT * FROM users WHERE id=?", [userId], (err, userResults) => {
        if (err || userResults.length === 0) return res.redirect('/login.html');

        const dbUser = userResults[0];

        // Fetch all usage stats in one query
        db.query(`
            SELECT
                COUNT(*) AS total_sent,
                COUNT(CASE WHEN MONTH(created_at) = MONTH(CURRENT_DATE()) AND YEAR(created_at) = YEAR(CURRENT_DATE()) THEN 1 END) AS monthly_sent,
                COUNT(CASE WHEN DATE(created_at) = CURDATE() THEN 1 END) AS daily_sent,
                MAX(created_at) AS last_otp
            FROM otp_logs WHERE user_id=?
        `, [userId], (err2, statsResults) => {
            const stats = statsResults && statsResults[0] ? statsResults[0] : {};
            const totalSent = stats.total_sent || 0;
            const monthlySent = stats.monthly_sent || 0;
            const dailySent = stats.daily_sent || 0;
            const lastOtp = stats.last_otp ? new Date(stats.last_otp).toLocaleString() : '—';
            const createdAt = dbUser.created_at ? new Date(dbUser.created_at).toLocaleString() : '—';

            try {
                let html = fs.readFileSync(path.join(__dirname, 'settings.html'), 'utf-8');
                html = html
                    .replace(/{{USER_ID}}/g, userId)
                    .replace(/{{FULL_NAME}}/g, dbUser.full_name || 'User')
                    .replace(/{{EMAIL}}/g, dbUser.email)
                    .replace(/{{PHONE_NUMBER}}/g, dbUser.phone_number || '—')
                    .replace(/{{DEV_CATEGORY}}/g, dbUser.dev_category || 'DEVELOPER')
                    .replace(/{{API_KEY}}/g, dbUser.api_key)
                    .replace(/{{TOTAL_SENT}}/g, totalSent)
                    .replace(/{{MONTHLY_SENT}}/g, monthlySent)
                    .replace(/{{DAILY_SENT}}/g, dailySent)
                    .replace(/{{LAST_OTP}}/g, lastOtp)
                    .replace(/{{CREATED_AT}}/g, createdAt);
                res.send(html);
            } catch (e) {
                res.status(500).send('Could not load settings page.');
            }
        });
    });
});

// ================= SEND OTP =================
app.post('/send', async (req, res) => {

    const { id, number, type, message } = req.body;
    const user = users[id];

    if (!user || !user.ready || !user.client) {
        return res.status(400).json({ message: "Not connected" });
    }

    db.query("SELECT COUNT(CASE WHEN DATE(created_at) = CURDATE() THEN 1 END) AS dailyCount, MAX(created_at) AS lastOtpTime FROM otp_logs WHERE user_id = ?", [id], async (err, results) => {
        if (err) {
            console.error("DB Error:", err);
            return res.status(500).json({ message: "Database Error" });
        }

        const stats = results[0];
        const dailyCount = stats.dailyCount || 0;
        const lastOtpTime = stats.lastOtpTime ? new Date(stats.lastOtpTime).getTime() : 0;
        const now = Date.now();

        if (dailyCount >= 50) {
            return res.status(429).json({ message: "Daily limit reached", alert: "Another day at 12 am it unlock to send 50 otp again" });
        }

        if (now - lastOtpTime < 45000) {
            const waitSecs = Math.ceil((45000 - (now - lastOtpTime)) / 1000);
            return res.status(429).json({ message: `Please wait ${waitSecs} seconds.` });
        }

        try {
            let cleanNum = String(number).replace(/\D/g, '').replace(/^0+/, '');
            if (cleanNum.length === 10) cleanNum = "91" + cleanNum;

            const chatId = cleanNum + "@c.us";

            if (type === 'msg') {
                if (!message) return res.status(400).json({ message: "Message is required" });

                await user.client.sendMessage(chatId, message);

                db.query("INSERT INTO otp_logs (user_id, number, message, type) VALUES (?, ?, ?, 'custom')", [id, number, message], (dbErr) => {
                    if (dbErr) console.error("DB Insert Error:", dbErr);
                    res.json({ message: "Message Sent Successfully" });
                });
            } else {
                const otp = Math.floor(1000 + Math.random() * 9000);

                await user.client.sendMessage(chatId,
                    `Test OTP: *${otp}*\n\nValid for 5 min. Do not share.\n\n— Powered by Extreme Verify`
                );

                db.query("INSERT INTO otp_logs (user_id, number, otp, type) VALUES (?, ?, ?, 'test')", [id, number, otp], (dbErr) => {
                    if (dbErr) console.error("DB Insert Error:", dbErr);
                    res.json({ message: "OTP Sent: " + otp });
                });
            }

        } catch (err) {
            console.log("❌ Send OTP error:", err.message);

            // 💥 Prevent crash
            if (users[id]) {
                users[id].ready = false;
            }

            res.status(500).json({ message: "Failed to send OTP" });
        }
    });
});

// ================= API =================
app.get('/api/status/:id', (req, res) => {
    const userId = req.params.id;
    const user = users[userId];

    db.query("SELECT COUNT(*) AS total_sent FROM otp_logs WHERE user_id=? AND MONTH(created_at) = MONTH(CURRENT_DATE()) AND YEAR(created_at) = YEAR(CURRENT_DATE())", [userId], (err, countResults) => {
        const totalSent = countResults && countResults.length > 0 ? countResults[0].total_sent : 0;
        if (!user) return res.json({ ready: false, qr: null, total_sent: totalSent });
        res.json({ ready: user.ready, qr: user.qr, total_sent: totalSent });
    });
});

app.post('/api/send-otp', async (req, res) => {

    const { apiKey, number, otp } = req.body;

    db.query("SELECT * FROM users WHERE api_key=?", [apiKey], async (err, results) => {

        if (results.length === 0) {
            return res.json({ success: false, error: "Invalid API Key" });
        }

        const userId = results[0].id;
        const user = users[userId];

        if (!user || !user.ready) {
            return res.json({ success: false, error: "WhatsApp not connected" });
        }

        db.query("SELECT COUNT(CASE WHEN DATE(created_at) = CURDATE() THEN 1 END) AS dailyCount, MAX(created_at) AS lastOtpTime FROM otp_logs WHERE user_id = ?", [userId], async (statErr, statResults) => {
            if (statErr) {
                return res.json({ success: false, error: "Database error" });
            }

            const stats = statResults[0];
            const dailyCount = stats.dailyCount || 0;
            const lastOtpTime = stats.lastOtpTime ? new Date(stats.lastOtpTime).getTime() : 0;
            const now = Date.now();

            if (dailyCount >= 50) {
                return res.json({ success: false, error: "Another day at 12 am it unlock to send 50 otp again" });
            }

            if (now - lastOtpTime < 45000) {
                const waitSecs = Math.ceil((45000 - (now - lastOtpTime)) / 1000);
                return res.json({ success: false, error: `Please wait ${waitSecs} seconds.` });
            }

            let cleanNum = String(number).replace(/\D/g, '').replace(/^0+/, '');
            if (cleanNum.length === 10) cleanNum = "91" + cleanNum;
            const chatId = cleanNum + "@c.us";

            try {
                await user.client.sendMessage(chatId, `Your OTP is: *${otp}*\n\n_Valid for 5 min. Do not share_\n\n— Powered by Extreme Verify`);
                db.query("INSERT INTO otp_logs (user_id, number, otp, type) VALUES (?, ?, ?, 'API')", [userId, number, otp], (dbErr) => {
                    if (dbErr) console.error("DB Insert Error:", dbErr);
                    res.json({ success: true });
                });
            } catch (err) {
                console.log("API Error sending OTP:", err.message);
                res.json({ success: false, error: err.message });
            }
        });
    });
});

// ================= API: SEND CUSTOM MESSAGE =================
app.post('/api/send-message', async (req, res) => {

    const { apiKey, number, message } = req.body;

    if (!apiKey || !number || !message) {
        return res.json({ success: false, error: 'apiKey, number, and message are required' });
    }

    db.query("SELECT * FROM users WHERE api_key=?", [apiKey], async (err, results) => {
        if (err) return res.json({ success: false, error: 'Database error' });

        if (results.length === 0) {
            return res.json({ success: false, error: 'Invalid API Key' });
        }

        const userId = results[0].id;
        const user = users[userId];

        if (!user || !user.ready || !user.client) {
            return res.json({ success: false, error: 'WhatsApp not connected' });
        }

        let cleanNum = String(number).replace(/\D/g, '').replace(/^0+/, '');
        if (cleanNum.length === 10) cleanNum = '91' + cleanNum;
        const chatId = cleanNum + '@c.us';

        try {
            await user.client.sendMessage(chatId, `${message}\n\n— Powered by Extreme Verify`);
            db.query("INSERT INTO otp_logs (user_id, number, message, type) VALUES (?, ?, ?, 'custom')", [userId, number, message], (dbErr) => {
                if (dbErr) console.error("DB Insert Error:", dbErr);
                res.json({ success: true });
            });
        } catch (err) {
            console.log('API Error sending message:', err.message);
            res.json({ success: false, error: err.message });
        }
    });
});

// ================= START =================
db.query("SELECT id FROM users", (err, results) => {
    if (err) {
        console.error("DB Error fetching users on start:", err);
    } else if (results && results.length > 0) {
        console.log(`🔄 Auto-starting WhatsApp clients for ${results.length} users...`);
        results.forEach(user => {
            createClient(user.id);
        });
    }
});

app.listen(process.env.PORT, () => {
    console.log("🚀 Server running on port", process.env.PORT || 3000);
});
