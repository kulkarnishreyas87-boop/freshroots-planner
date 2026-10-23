import { NextRequest, NextResponse } from "next/server";

// HTTP Basic Auth for the deployed dashboard. Set SITE_PASSWORD on Vercel; leave it
// empty locally to skip the prompt. /api/cron has its own CRON_SECRET check.
export function proxy(req: NextRequest) {
  const password = process.env.SITE_PASSWORD;
  if (!password) return NextResponse.next();

  const auth = req.headers.get("authorization");
  if (auth) {
    const [scheme, encoded] = auth.split(" ");
    if (scheme === "Basic" && encoded) {
      const [, supplied] = Buffer.from(encoded, "base64").toString("utf-8").split(":");
      if (supplied === password) return NextResponse.next();
    }
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Freshroots Demand Planner"' },
  });
}

export const config = {
  matcher: ["/((?!api/cron|_next/static|_next/image|favicon.ico).*)"],
};
