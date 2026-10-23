// One-time: exchanges a Zoho Self Client grant code for a refresh token.
// Run: npm run zoho:token -- <grant-code>
// Needs ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_ACCOUNTS_URL in .env.local.

async function main() {
  const code = process.argv[2]?.trim();
  const id = process.env.ZOHO_CLIENT_ID?.trim();
  const secret = process.env.ZOHO_CLIENT_SECRET?.trim();
  const accounts = process.env.ZOHO_ACCOUNTS_URL?.trim().replace(/\/+$/, "");
  if (!code) throw new Error("Usage: npm run zoho:token -- <grant-code>");
  if (!id || !secret || !accounts) throw new Error("Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_ACCOUNTS_URL in .env.local first.");

  const params = new URLSearchParams({ code, client_id: id, client_secret: secret, grant_type: "authorization_code" });
  if (process.env.ZOHO_REDIRECT_URI?.trim()) params.set("redirect_uri", process.env.ZOHO_REDIRECT_URI.trim());
  const res = await fetch(`${accounts}/oauth/v2/token?${params}`, { method: "POST" });
  const json = (await res.json()) as { refresh_token?: string; error?: string; api_domain?: string };
  if (!json.refresh_token) throw new Error(`Zoho did not return a refresh token: ${json.error ?? `HTTP ${res.status}`}. Grant codes expire within minutes and work once.`);
  console.log("Paste this into .env.local:");
  console.log(`ZOHO_REFRESH_TOKEN=${json.refresh_token}`);
  if (json.api_domain) console.log(`(Zoho says your API domain is ${json.api_domain}; ZOHO_API_BASE should be ${json.api_domain}/inventory/v1)`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
