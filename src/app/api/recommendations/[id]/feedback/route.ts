import { NextResponse } from "next/server";
import { exec, one, logAudit } from "@/lib/db";

// Raghav's one-tap rating: "Was this recommendation useful?"
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (typeof body.useful !== "boolean") return NextResponse.json({ error: "useful must be true or false" }, { status: 400 });
  const line = await one(`SELECT id FROM recommendations WHERE id = $1`, [Number(id)]);
  if (!line) return NextResponse.json({ error: "Line not found" }, { status: 404 });
  await exec(`UPDATE recommendations SET useful = $2 WHERE id = $1`, [Number(id), body.useful]);
  await logAudit("feedback", { id: Number(id), useful: body.useful });
  return NextResponse.json({ ok: true });
}
