process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
require("dotenv").config();
const crypto  = require("crypto");
const https   = require("https");

const token   = process.env.META_ACCESS_TOKEN;
const secret  = process.env.META_APP_SECRET;
const account = process.env.META_AD_ACCOUNT_ID;
const proof   = crypto.createHmac("sha256", secret).update(token).digest("hex");

function get(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", d => (body += d));
      res.on("end", () => resolve(JSON.parse(body)));
    });
    req.on("error", reject);
    req.end();
  });
}

(async () => {
  // 1. Pega image_hash do creative
  const qs1 = new URLSearchParams({ access_token: token, appsecret_proof: proof, fields: "id,image_hash,object_story_id" });
  const r1  = await get("graph.facebook.com", `/v23.0/4369672733301669?${qs1}`);
  console.log("image_hash:", r1.image_hash);
  console.log("object_story_id:", r1.object_story_id);

  if (r1.image_hash) {
    const qs2 = new URLSearchParams({ access_token: token, appsecret_proof: proof, hashes: JSON.stringify([r1.image_hash]), fields: "url,url_128,permalink_url" });
    const r2  = await get("graph.facebook.com", `/v23.0/act_${account}/adimages?${qs2}`);
    const img = (r2.data || [])[0];
    console.log("\nadimages result:");
    console.log("  url:", img?.url ? img.url.substring(0, 100) + "..." : "N/A");
    console.log("  url_128:", img?.url_128 ? img.url_128.substring(0, 100) + "..." : "N/A");
  }
})();
