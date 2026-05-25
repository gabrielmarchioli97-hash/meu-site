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
    const response = await fetch
