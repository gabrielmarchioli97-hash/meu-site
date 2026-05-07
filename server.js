/**
 * ADAPTA CAPITAL — Backend Server
 * Discord OAuth2 + PIX Payment Logger
 * 
 * Dependências: npm install express dotenv node-fetch cors
 */

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.static(path.join(__dirname, "public")));

// ─── Config ───────────────────────────────────────────────────────────────────
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI          = process.env.REDIRECT_URI; // ex: https://seusite.com/callback
const LOG_FILE              = path.join(__dirname, "pagamentos.json");

// Garante que o arquivo de log existe
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, JSON.stringify([], null, 2));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function readLogs() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, "utf8")); }
  catch { return []; }
}

function writeLog(entry) {
  const logs = readLogs();
  logs.unshift(entry); // mais recente primeiro
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}

// ─── ROTA: Checkout page ──────────────────────────────────────────────────────
app.get("/checkout", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "checkout.html"));
});

// ─── ROTA 1: Redireciona para o Discord ───────────────────────────────────────
app.get("/auth/discord", (req, res) => {
  const params = new URLSearchParams({
    client_id:     DISCORD_CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: "code",
    scope:         "identify",
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// ─── ROTA 2: Callback do Discord ──────────────────────────────────────────────
app.get("/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect("/?auth=error");
  }

  try {
    // Troca o code por um access_token
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

    // Busca os dados do usuário
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userRes.json();

    // Monta objeto de sessão seguro (sem token)
    const session = {
      id:            user.id,
      username:      user.username,
      discriminator: user.discriminator || "0",
      global_name:   user.global_name || user.username,
      avatar:        user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/${parseInt(user.id) % 5}.png`,
      tag:           user.discriminator && user.discriminator !== "0"
        ? `${user.username}#${user.discriminator}`
        : user.username,
    };

    // Redireciona de volta ao frontend com dados na query string
    const params = new URLSearchParams({
      auth:       "ok",
      id:         session.id,
      username:   session.global_name,
      tag:        session.tag,
      avatar:     session.avatar,
    });

    res.redirect(`/?${params}`);

  } catch (err) {
    console.error("[OAuth2 Error]", err);
    res.redirect("/?auth=error");
  }
});

// ─── ROTA 3: Registra pagamento PIX ───────────────────────────────────────────
// Chamada pelo frontend logo após gerar o QR Code
app.post("/api/log-payment", (req, res) => {
  const { discord_id, discord_tag, avatar, valor, player_id, payload_pix } = req.body;

  if (!discord_id || !valor || !player_id) {
    return res.status(400).json({ error: "Campos obrigatórios ausentes" });
  }

  const entry = {
    id:           Date.now(),
    timestamp:    new Date().toISOString(),
    status:       "AGUARDANDO",      // AGUARDANDO | CONFIRMADO | CANCELADO
    discord_id,
    discord_tag,
    avatar,
    valor_brl:    parseFloat(valor),
    player_id,
    payload_pix,
  };

  writeLog(entry);
  console.log(`[PIX] Novo PIX gerado — ${discord_tag} | R$ ${valor} | ID: ${player_id}`);

  res.json({ ok: true, log_id: entry.id });
});

// ─── ROTA 4: Lista logs (painel admin) ────────────────────────────────────────
// Proteja isso com senha em produção!
app.get("/api/admin/logs", (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: "Acesso negado" });
  }
  res.json(readLogs());
});

// ─── ROTA 5: Atualiza status do pagamento ─────────────────────────────────────
app.patch("/api/admin/logs/:id", (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: "Acesso negado" });
  }

  const logs = readLogs();
  const idx = logs.findIndex(l => l.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: "Log não encontrado" });

  logs[idx].status = req.body.status || logs[idx].status;
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
  res.json(logs[idx]);
});

// ─── Inicia servidor ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅  ADAPTA CAPITAL Server rodando na porta ${PORT}`);
  console.log(`📋  Logs em: ${LOG_FILE}\n`);
});
