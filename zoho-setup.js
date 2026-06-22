/**
 * zoho-setup.js
 * Helper para obter as credenciais OAuth do Zoho CRM.
 *
 * PASSO 1: Abrir api-console.zoho.com
 * PASSO 2: Criar Self Client → gerar código com scope ZohoCRM.modules.ALL
 * PASSO 3: node zoho-setup.js exchange <CLIENT_ID> <CLIENT_SECRET> <CODE>
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const [,, command, ...args] = process.argv;

if (!command) {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           ZOHO CRM — SETUP DE CREDENCIAIS OAUTH             ║
╚══════════════════════════════════════════════════════════════╝

PASSO 1: Acesse https://api-console.zoho.com
PASSO 2: Clique em "Self Client" → "Create Now"
PASSO 3: Em "Scope" cole:  ZohoCRM.modules.ALL
          Em "Time Duration" escolha: 10 minutes
PASSO 4: Copie o "Code" gerado
PASSO 5: Execute o comando abaixo (substitua os valores):

  node zoho-setup.js exchange <CLIENT_ID> <CLIENT_SECRET> <CODE>

Onde:
  CLIENT_ID     = campo "Client ID" do Self Client
  CLIENT_SECRET = campo "Client Secret" do Self Client
  CODE          = código gerado no Passo 4 (válido por 10 min)
`);
  process.exit(0);
}

if (command === "exchange") {
  const [clientId, clientSecret, code] = args;
  if (!clientId || !clientSecret || !code) {
    console.error("Uso: node zoho-setup.js exchange <CLIENT_ID> <CLIENT_SECRET> <CODE>");
    process.exit(1);
  }

  const body = new URLSearchParams({
    code,
    client_id:     clientId,
    client_secret: clientSecret,
    redirect_uri:  "https://www.zohocorp.com",
    grant_type:    "authorization_code",
  }).toString();

  const options = {
    hostname: "accounts.zoho.com",
    path:     "/oauth/v2/token",
    method:   "POST",
    headers: {
      "Content-Type":   "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
    },
  };

  console.log("\nTrocando código pelo refresh token...");

  const req = https.request(options, (res) => {
    let raw = "";
    res.on("data", (chunk) => (raw += chunk));
    res.on("end", () => {
      let json;
      try { json = JSON.parse(raw); } catch { console.error("Resposta inválida:", raw); process.exit(1); }

      if (json.error) {
        console.error("\n❌ Erro:", json.error);
        console.error("   Verifique se o código ainda é válido (10 min) e os dados estão corretos.");
        process.exit(1);
      }

      console.log("\n✅ Credenciais obtidas com sucesso!\n");
      console.log("ACCESS_TOKEN  :", json.access_token);
      console.log("REFRESH_TOKEN :", json.refresh_token);
      console.log("EXPIRES_IN    :", json.expires_in, "segundos");

      // Atualiza o .env automaticamente
      const envPath = path.join(__dirname, ".env");
      let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";

      const setEnv = (key, value) => {
        const regex = new RegExp(`^${key}=.*$`, "m");
        if (regex.test(envContent)) {
          envContent = envContent.replace(regex, `${key}=${value}`);
        } else {
          envContent += `\n${key}=${value}`;
        }
      };

      setEnv("ZOHO_CLIENT_ID",     clientId);
      setEnv("ZOHO_CLIENT_SECRET", clientSecret);
      setEnv("ZOHO_REFRESH_TOKEN", json.refresh_token);

      fs.writeFileSync(envPath, envContent, "utf-8");

      console.log("\n✅ .env atualizado com ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET e ZOHO_REFRESH_TOKEN");
      console.log("   Reinicie o servidor: node server.js");
    });
  });

  req.on("error", (err) => {
    console.error("Erro de rede:", err.message);
    process.exit(1);
  });

  req.write(body);
  req.end();
}
