import { NextResponse } from "next/server";
import { getKillSwitch, resumeKillSwitch } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getKillSwitch());
}

// Resume after the rules have been recalibrated. A note is required for the audit log.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note) return NextResponse.json({ error: "Say what was recalibrated before resuming." }, { status: 400 });
  await resumeKillSwitch(note);
  return NextResponse.json(await getKillSwitch());
}
