/**
 * ADAPTA CAPITAL — Backend Server
 * Discord OAuth2 + PIX + Mercado Pago Checkout Pro + Duplo Crédito + Logs Discord
 */

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const fs      = require("fs");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));

// ── Redireciona domínio raiz para www ─────────────────────────────────────────
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
const MP_ACCESS_TOKEN       = process.env.MP_ACCESS_TOKEN;
const DISCORD_WEBHOOK_URL   = process.env.DISCORD_WEBHOOK_URL;

const mysql = require("mysql2/promise");

// ── Pool de conexão MySQL — VPS da Adapta Capital ─────────────────────────────
const db = mysql.createPool({
  host:     process.env.DB_HOST     || "178.83.141.122",
  port:     parseInt(process.env.DB_PORT || "3306"),
  user:     process.env.DB_USER     || "root",
  password: process.env.DB_PASS     || "",
  database: process.env.DB_NAME     || "skips",
  waitForConnections: true,
  connectionLimit:    5,
  connectTimeout:     10000,
});

db.getConnection()
  .then(c => { console.log("✅ MySQL conectado à VPS da Adapta Capital"); c.release(); })
  .catch(e => console.error("❌ MySQL falhou:", e.message));

// ── Função auxiliar para enviar Embeds para o Discord ────────────────────────
async function enviarLogDiscord(embed) {
  if (!DISCORD_WEBHOOK_URL || DISCORD_WEBHOOK_URL.trim() === "") {
    console.log("[Discord] Webhook não enviado: Variável DISCORD_WEBHOOK_URL vazia ou ausente.");
    return;
  }
  try {
    const response = await fetch(DISCORD_WEBHOOK_URL.trim(), {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "User-Agent": "FiveM-Store-Webhook"
      },
      body: JSON.stringify({ 
        username: "Adapta Store",
        embeds: [embed] 
      })
    });
    
    if (!response.ok) {
      const txt = await response.text();
      console.error(`[Discord Webhook Error] Status: ${response.status} | Resposta: ${txt}`);
    } else {
      console.log("[Discord] Log enviado com sucesso para o canal.");
    }
  } catch (err) {
    console.error("[Discord Webhook Error] Falha de conexão:", err.message);
  }
}

// ── Credita coins em AMBAS as tabelas (sks_store_users e vrp_users) ───────────
async function creditarCoins({ player_id, quantidade, metodo, discord_tag }) {
  const uid = parseInt(player_id);
  if (!uid || uid <= 0) throw new Error("player_id inválido: " + player_id);

  console.log(`[MySQL] Iniciando duplo crédito para o ID ${uid}...`);

  // 1ª TABELA: sks_store_users (Antiga/Web)
  await db.execute(
    `INSERT INTO sks_store_users (user_id, coins)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE coins = coins + VALUES(coins)`,
    [uid, quantidade]
  );
  console.log(`[MySQL] 1/2: Sucesso na tabela sks_store_users.`);

  // 2ª TABELA: vrp_users (In-game)
  await db.execute(
    `UPDATE vrp_users 
     SET coins = coins + ? 
     WHERE id = ?`,
    [quantidade, uid]
  );
  console.log(`[MySQL] 2/2: Sucesso na tabela vrp_users.`);

  // Registra também em sks_store_logs para histórico
  await db.execute(
    `INSERT INTO sks_store_logs (user_id, product, price, purchase_date)
     VALUES (?, ?, ?, NOW())`,
    [uid, `${quantidade} Adapta Coins (${metodo})`, quantidade]
  ).catch(() => {}); 

  console.log(`[MySQL] 🌍 Duplo Crédito Concluído com sucesso para o ID ${uid}!`);

  // DISPARAR LOG DE PAGAMENTO CONFIRMADO NO DISCORD (VERDE)
  enviarLogDiscord({
    title: "✅ PAGAMENTO APROVADO — COINS ENTREGUES",
    color: 65280, 
    fields: [
      { name: "🆔 ID do Jogador", value: `${uid}`, inline: true },
      { name: "💰 Moedas Enviadas", value: `${quantidade} Coins`, inline: true },
      { name: "💳 Método de Pago", value: metodo, inline: true },
      { name: "👤 Comprador", value: discord_tag || "Não Identificado", inline: false }
    ],
    timestamp: new Date().toISOString(),
    footer: { text: "Adapta Capital — Entrega Automática" }
  });

  return { success: true };
}

const LOG_FILE = path.join(__dirname, "pagamentos.json");

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

// ── Páginas ───────────────────────────────────────────────────────────────────
app.get("/produto",  (req, res) => res.sendFile(path.join(__dirname, "produto.html")));
app.get("/checkout", (req, res) => res.sendFile(path.join(__dirname, "checkout.html")));
app.get("/termos",   (req, res) => res.sendFile(path.join(__dirname, "termos.html")));

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

app.get("/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect("/checkout?auth=error");
  try {
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI,
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
      ? `${user.username}#${user.discriminator}` : user.username;
    const params = new URLSearchParams({
      auth: "ok", id: user.id,
      username: user.global_name || user.username, tag, avatar,
    });
    res.redirect(`/checkout?${params}`);
  } catch (err) {
    console.error("[OAuth2 Error]", err);
    res.redirect("/checkout?auth=error");
  }
});

// ── Mercado Pago — Gera preferência de pagamento (Checkout Pro / Cartão) ───────
app.post("/api/mp/criar-preferencia", async (req, res) => {
  const { valor, player_id, discord_tag, discord_id, qty, product } = req.body;

  if (!valor || !player_id) {
    return res.status(400).json({ error: "Campos obrigatórios ausentes" });
  }

  try {
    const body = {
      items: [{
        id:          `coins-${product}`,
        title:       `${product} Coins Adapta Capital`,
        description: `${qty}x pacote de ${product} Coins para ID ${player_id}`,
        quantity:    1,
        currency_id: "BRL",
        unit_price:  parseFloat(valor),
      }],
      payer: {
        name: discord_tag || "Jogador",
      },
      external_reference: `${discord_id || "guest"}_${player_id}_${Date.now()}`,
      back_urls: {
        success: `${process.env.FRONTEND_URL || "https://www.adaptacapital.com.br"}/checkout?mp=success&player_id=${player_id}`,
        failure: `${process.env.FRONTEND_URL || "https://www.adaptacapital.com.br"}/checkout?mp=failure`,
        pending: `${process.env.FRONTEND_URL || "https://www.adaptacapital.com.br"}/checkout?mp=pending`,
      },
      auto_return:        "approved",
      statement_descriptor: "ADAPTA CAPITAL",
      notification_url:  `${process.env.FRONTEND_URL || "https://www.adaptacapital.com.br"}/api/mp/webhook`,
    };

    const mpRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${MP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(body),
    });

    const mpData = await mpRes.json();
    if (!mpData.id) throw new Error(JSON.stringify(mpData));

    // DISPARAR LOG DE SOLICITAÇÃO (CARTÃO/CHECKOUT) NO DISCORD (AMARELO)
    enviarLogDiscord({
      title: "⏳ NOVO CHECKOUT INICIADO",
      color: 16776960, 
      fields: [
        { name: "🆔 ID do Jogador", value: `${player_id}`, inline: true },
        { name: "💵 Valor Bruto", value: `R$ ${parseFloat(valor).toFixed(2)}`, inline: true },
        { name: "📦 Produto", value: `${qty}x ${product}`, inline: true },
        { name: "👤 Usuário", value: discord_tag || "Convidado", inline: false }
      ],
      timestamp: new Date().toISOString(),
      footer: { text: "Adapta Capital — Checkout Pro" }
    });

    console.log(`[MP] Preferência criada: ${mpData.id} | R$ ${valor} | ID: ${player_id}`);
    res.json({ init_point: mpData.init_point, id: mpData.id });

  } catch (err) {
    console.error("[MP Error]", err);
    res.status(500).json({ error: "Erro ao criar preferência MP" });
  }
});

// ── Mercado Pago — Webhook (cartão + PIX) ────────────────────────────────────
app.post("/api/mp/webhook", async (req, res) => {
  const { type, data } = req.body;
  if (type === "payment" && data?.id) {
    try {
      const payRes = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
        headers: { "Authorization": `Bearer ${MP_ACCESS_TOKEN}` },
      });
      const payment = await payRes.json();

      if (payment.status === "approved") {
        const ref        = payment.external_reference || "";
        const [discord_id, player_id] = ref.split("_");
        const quantidade = Math.round(payment.transaction_amount);
        const metodo     = payment.payment_method_id === "pix" ? "PIX" : "MERCADO_PAGO";

        const logs = readLogs();
        const idx  = logs.findIndex(l => l.mp_payment_id === data.id || l.external_reference === ref);
        
        let d_tag = "—";
        if (idx !== -1) {
          logs[idx].status = "CONFIRMADO";
          d_tag = logs[idx].discord_tag;
          fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
        } else {
          writeLog({
            id:        Date.now(),
            timestamp: new Date().toISOString(),
            status:    "CONFIRMADO",
            metodo,
            discord_id,
            player_id,
            valor_brl:  payment.transaction_amount,
            quantidade,
            mp_id:      data.id,
          });
        }

        await creditarCoins({ player_id, quantidade, metodo, discord_tag: d_tag });
        console.log(`[MP Webhook] ✅ ${metodo} approved | R$ ${payment.transaction_amount} | player ${player_id}`);
      }
    } catch (e) { 
      console.error("[MP Webhook Error]", e); 
    }
  }
  res.sendStatus(200);
});

// ── PIX via Mercado Pago — Gera QR Code rastreável ───────────────────────────
app.post("/api/pix/criar", async (req, res) => {
  const { discord_id, discord_tag, avatar, valor, player_id } = req.body;
  if (!valor || !player_id) return res.status(400).json({ error: "Campos obrigatórios ausentes" });

  const quantidade = Math.round(parseFloat(valor));

  try {
    const mpRes = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        "Content-Type":   "application/json",
        "Authorization":  `Bearer ${MP_ACCESS_TOKEN}`,
        "X-Idempotency-Key": `pix-${player_id}-${Date.now()}`,
      },
      body: JSON.stringify({
        transaction_amount: parseFloat(valor),
        description:        `${quantidade} Coins Adapta Capital — ID ${player_id}`,
        payment_method_id:  "pix",
        external_reference: `${discord_id || "guest"}_${player_id}_${Date.now()}`,
        notification_url:   `${process.env.FRONTEND_URL || "https://www.adaptacapital.com.br"}/api/mp/webhook`,
        payer: {
          email:      "cliente@adaptacapital.com.br",
          first_name: discord_tag || "Jogador",
          last_name:  "AC",
          identification: { type: "CPF", number: "00000000000" },
        },
      }),
    });

    const mpData = await mpRes.json();
    if (!mpData.id) throw new Error(JSON.stringify(mpData));

    const qr_code       = mpData.point_of_interaction?.transaction_data?.qr_code;
    const qr_code_base64 = mpData.point_of_interaction?.transaction_data?.qr_code_base64;

    if (!qr_code) throw new Error("MP não retornou QR code PIX");

    writeLog({
      id:          Date.now(),
      timestamp:   new Date().toISOString(),
      status:      "AGUARDANDO",
      metodo:      "PIX",
      discord_id:  discord_id || "guest",
      discord_tag: discord_tag || "—",
      avatar:      avatar || "",
      valor_brl:   parseFloat(valor),
      quantidade,
      player_id,
      mp_payment_id: mpData.id,
      external_reference: mpData.external_reference,
    });

    // DISPARAR LOG DE SOLICITAÇÃO DE PIX NO DISCORD (LARANJA)
    enviarLogDiscord({
      title: "⏳ SOLICITAÇÃO DE PIX GERADA",
      color: 16753920, 
      fields: [
        { name: "🆔 ID do Jogador", value: `${player_id}`, inline: true },
        { name: "💵 Valor", value: `R$ ${parseFloat(valor).toFixed(2)}`, inline: true },
        { name: "🪙 Moedas Estimadas", value: `${quantidade} Coins`, inline: true },
        { name: "👤 Solicitante", value: discord_tag || "—", inline: false }
      ],
      timestamp: new Date().toISOString(),
      footer: { text: "Adapta Capital — Sistema Pix" }
    });

    console.log(`[PIX-MP] Gerado | R$ ${valor} | player ${player_id} | mp_id ${mpData.id}`);
    res.json({ ok: true, qr_code, qr_code_base64, mp_id: mpData.id });

  } catch (err) {
    console.error("[PIX-MP Error]", err.message);
    res.status(500).json({ error: "Erro ao gerar PIX via Mercado Pago" });
  }
});

// ── Admin: confirmar PIX manualmente se necessário ───────────────────────────
app.post("/api/admin/confirmar/:id", async (req, res) => {
  if (req.query.secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: "Acesso negado" });
  const logs = readLogs();
  const idx  = logs.findIndex(l => l.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: "Não encontrado" });

  const entry = logs[idx];
  entry.status = "CONFIRMADO";
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));

  await creditarCoins({
    player_id:  entry.player_id,
    quantidade: entry.quantidade || Math.round(entry.valor_brl),
    metodo:     entry.metodo,
    discord_tag: entry.discord_tag
  });

  console.log(`[Admin] PIX confirmed manually — ID: ${entry.player_id} | ${entry.quantidade} coins`);
  res.json({ ok: true, entry });
});

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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`... ADAPTA CAPITAL rodando na porta ${PORT}`));
