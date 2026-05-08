/**
 * ADAPTA CAPITAL — Backend Server
 * Discord OAuth2 + PIX Payment Logger
 */

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));

// ── Redireciona domínio raiz para www ────────────────────────────────────────
app.use((req, res, next) => {
  const host = req.headers.host || "";
  if (!host.startsWith("www.") && !host.includes("railway.app") && !host.includes("localhost")) {
    return res.redirect(301, `https://www.${host}${req.url}`);
  }
  next();
});

app.use(express.static(path.join(__dirname)));

const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI          = process.env.REDIRECT_URI;
const LOG_FILE              = path.join(__dirname, "pagamentos.json");

if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, JSON.stringify([], null, 2));

function readLogs() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, "utf8")); }
  catch { return []; }
}

function writeLog(entry) {
  const logs = readLogs();
  logs.unshift(entry);
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}

// ── Checkout ──────────────────────────────────────────────────────────────────
app.get("/produto", (req, res) => {
  res.sendFile(path.join(__dirname, "produto.html"));
});

app.get("/checkout", (req, res) => {
  res.sendFile(path.join(__dirname, "checkout.html"));
});

app.get("/termos", (req, res) => {
  res.sendFile(path.join(__dirname, "termos.html"));
});

// ── Auth Discord ──────────────────────────────────────────────────────────────
app.get("/auth/discord", (req, res) => {
  const params = new URLSearchParams({
    client_id:     DISCORD_CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: "code",
    scope:         "identify",
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// ── Callback Discord ──────────────────────────────────────────────────────────
app.get("/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect("/checkout?auth=error");

  try {
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type:    "authorization_code",
        code,
        redirect_uri:  REDIRECT_URI,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error("Token inválido");

    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userRes.json();

    const avatar = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/${parseInt(user.id) % 5}.png`;

    const tag = user.discriminator && user.discriminator !== "0"
      ? `${user.username}#${user.discriminator}`
      : user.username;

    const params = new URLSearchParams({
      auth:     "ok",
      id:       user.id,
      username: user.global_name || user.username,
      tag,
      avatar,
    });

    res.redirect(`/checkout?${params}`);
  } catch (err) {
    console.error("[OAuth2 Error]", err);
    res.redirect("/checkout?auth=error");
  }
});

// ── Log de pagamento ──────────────────────────────────────────────────────────
app.post("/api/log-payment", (req, res) => {
  const { discord_id, discord_tag, avatar, valor, player_id, payload_pix } = req.body;
  if (!discord_id || !valor || !player_id) {
    return res.status(400).json({ error: "Campos obrigatórios ausentes" });
  }
  const entry = {
    id:          Date.now(),
    timestamp:   new Date().toISOString(),
    status:      "AGUARDANDO",
    discord_id,
    discord_tag,
    avatar,
    valor_brl:   parseFloat(valor),
    player_id,
    payload_pix,
  };
  writeLog(entry);
  console.log(`[PIX] ${discord_tag} | R$ ${valor} | ID: ${player_id}`);
  res.json({ ok: true, log_id: entry.id });
});

// ── Admin ─────────────────────────────────────────────────────────────────────
app.get("/api/admin/logs", (req, res) => {
  if (req.query.secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: "Acesso negado" });
  res.json(readLogs());
});

app.patch("/api/admin/logs/:id", (req, res) => {
  if (req.query.secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: "Acesso negado" });
  const logs = readLogs();
  const idx = logs.findIndex(l => l.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: "Não encontrado" });
  logs[idx].status = req.body.status || logs[idx].status;
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
  res.json(logs[idx]);
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ ADAPTA CAPITAL rodando na porta ${PORT}`));
