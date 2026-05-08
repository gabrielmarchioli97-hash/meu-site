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

// ── Notificação Discord Webhook ───────────────────────────────────────────────
async function notifyDiscord(entry) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL || "https://discord.com/api/webhooks/1502138867841634304/5zn1WXybJuhtDpSRm5sidhUupCTO8kjgSQr6Ikt-TbVvgwEjIgduweSy6SSPTG_KSe56";
  if (!webhookUrl) return;

  const dataBR = new Date(entry.timestamp).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

  const embed = {
    embeds: [{
      title: "💸 Novo Pedido PIX — Adapta Capital",
      color: 0x00ff6a,
      thumbnail: entry.avatar ? { url: entry.avatar } : undefined,
      fields: [
        { name: "👤 Jogador",       value: `\`${entry.discord_tag || "—"}\``,        inline: true  },
        { name: "🆔 Discord ID",    value: `\`${entry.discord_id}\``,                inline: true  },
        { name: "🎮 ID no Servidor",value: `\`${entry.player_id}\``,                 inline: true  },
        { name: "💰 Valor",         value: `**R$ ${entry.valor_brl.toFixed(2)}**`,   inline: true  },
        { name: "📋 Status",        value: `\`${entry.status}\``,                    inline: true  },
        { name: "🕐 Horário",       value: dataBR,                                   inline: true  },
        { name: "📦 Log ID",        value: `\`#${entry.id}\``,                       inline: false },
        { name: "📲 Payload PIX",   value: `\`\`\`${entry.payload_pix.substring(0, 200)}\`\`\``, inline: false },
      ],
      footer: { text: "Adapta Capital · GTA RP" },
      timestamp: entry.timestamp,
    }],
  };

  try {
    await fetch(webhookUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(embed),
    });
    console.log(`[Webhook] Notificação enviada para Discord — #${entry.id}`);
  } catch (err) {
    console.error("[Webhook Error]", err.message);
  }
}

// ── Log de pagamento ──────────────────────────────────────────────────────────
app.post("/api/log-payment", async (req, res) => {
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

  // Dispara notificação no Discord (assíncrono, não bloqueia resposta)
  notifyDiscord(entry).catch(() => {});

  res.json({ ok: true, log_id: entry.id });
});

// ── Admin ─────────────────────────────────────────────────────────────────────
app.get("/api/admin/logs", (req, res) => {
  if (req.query.secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: "Acesso negado" });
  res.json(readLogs());
});

app.patch("/api/admin/logs/:id", async (req, res) => {
  if (req.query.secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: "Acesso negado" });
  const logs = readLogs();
  const idx = logs.findIndex(l => l.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: "Não encontrado" });

  const oldStatus = logs[idx].status;
  logs[idx].status = req.body.status || oldStatus;
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));

  // Notifica Discord quando status muda para PAGO
  if (req.body.status === "PAGO" && oldStatus !== "PAGO") {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL || "https://discord.com/api/webhooks/1502138867841634304/5zn1WXybJuhtDpSRm5sidhUupCTO8kjgSQr6Ikt-TbVvgwEjIgduweSy6SSPTG_KSe56";
    if (webhookUrl) {
      const entry = logs[idx];
      const embed = {
        embeds: [{
          title: "✅ Pagamento Confirmado — Adapta Capital",
          color: 0x00ff6a,
          thumbnail: entry.avatar ? { url: entry.avatar } : undefined,
          fields: [
            { name: "👤 Jogador",        value: `\`${entry.discord_tag || "—"}\``,      inline: true },
            { name: "🎮 ID no Servidor", value: `\`${entry.player_id}\``,                inline: true },
            { name: "💰 Valor",          value: `**R$ ${entry.valor_brl.toFixed(2)}**`, inline: true },
            { name: "📦 Log ID",         value: `\`#${entry.id}\``,                     inline: true },
          ],
          footer: { text: "Adapta Capital · GTA RP" },
          timestamp: new Date().toISOString(),
        }],
      };
      fetch(webhookUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(embed),
      }).catch(err => console.error("[Webhook PAGO Error]", err.message));
    }
  }

  res.json(logs[idx]);
});


// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ ADAPTA CAPITAL rodando na porta ${PORT}`));
