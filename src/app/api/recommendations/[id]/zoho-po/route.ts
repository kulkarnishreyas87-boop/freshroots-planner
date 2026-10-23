import { NextResponse } from "next/server";
import { raisePo } from "@/lib/procure";

export const maxDuration = 60;

// Retry raising the Zoho PO for an approved line (after fixing a mapping, or a Zoho outage).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await raisePo(Number(id));
  return NextResponse.json(res, { status: res.status === "failed" ? 502 : res.status === "skipped" ? 409 : 200 });
}
