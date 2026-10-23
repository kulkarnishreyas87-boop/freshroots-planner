import { NextResponse } from "next/server";
import { getRubric, saveRubric } from "@/lib/pipeline";
import { validateRubric } from "@/lib/rules";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ rubric: await getRubric() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// Raghav edits the rubric. Takes effect from the next run.
export async function PUT(req: Request) {
  const body = await req.json().catch(() => null);
  const res = validateRubric(body?.rubric);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  await saveRubric(res.rubric);
  return NextResponse.json({ rubric: res.rubric });
}
