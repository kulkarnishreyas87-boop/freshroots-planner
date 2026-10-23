import { NextResponse } from "next/server";
import { runPlanning } from "@/lib/pipeline";

export const maxDuration = 120;

// Vercel Cron calls this on the schedule in vercel.json, with "Authorization: Bearer <CRON_SECRET>".
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const res = await runPlanning("cron");
    return NextResponse.json(res, { status: res.status === "failed" ? 500 : 200 });
  } catch (err) {
    return NextResponse.json({ status: "failed", message: (err as Error).message }, { status: 500 });
  }
}
