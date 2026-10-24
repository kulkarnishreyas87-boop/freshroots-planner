import { NextResponse } from "next/server";
import { addLesson, decideProposal, draftProposals, loopSummary, scoreOutcomes } from "@/lib/learning";
import { getRubric, saveRubric } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    return NextResponse.json(await loopSummary());
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// action: "refresh" (score outcomes + draft proposals now), "accept" | "dismiss" { id }, "add" { text }
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  try {
    if (body.action === "refresh") {
      const s = await scoreOutcomes();
      const drafted = await draftProposals(await getRubric());
      return NextResponse.json({ ...s, drafted });
    }
    if (body.action === "accept" || body.action === "dismiss") {
      await decideProposal(Number(body.id), body.action === "accept", getRubric, saveRubric);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "add") {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (text.length < 10) return NextResponse.json({ error: "Write the lesson as a full sentence (10+ characters)." }, { status: 400 });
      await addLesson(text);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
