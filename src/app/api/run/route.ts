import { NextResponse } from "next/server";
import { runPlanning } from "@/lib/pipeline";

export const maxDuration = 120;

// "Run now" from the dashboard.
export async function POST() {
  try {
    const res = await runPlanning("manual");
    return NextResponse.json(res, { status: res.status === "failed" ? 500 : 200 });
  } catch (err) {
    return NextResponse.json({ status: "failed", message: (err as Error).message }, { status: 500 });
  }
}
