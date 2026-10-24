import { GoogleGenAI, Type, type Schema } from "@google/genai";
import { ACTIONS, FLAGS, type Action, type Flag, type Rubric, type SkuMetrics } from "./rules";

let client: GoogleGenAI | null = null;

export function geminiModel(): string {
  const m = process.env.GEMINI_MODEL?.trim();
  if (!m) throw new Error("GEMINI_MODEL is not set. Paste the exact model id from Google AI Studio into .env.local.");
  return m;
}

function getClient(): GoogleGenAI {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set. Paste your key into .env.local.");
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

export interface GeminiDecision {
  sku_id: string;
  flag: Flag;
  high_demand: boolean;
  action: Action;
  needs_raghav: boolean;
  raghav_reason: string;
  reason: string;
}

export interface GeminiBatchResult {
  decisions: GeminiDecision[];
  summary: string;
  tokensIn: number;
  tokensOut: number;
  problems: string[]; // duplicates or unknown SKUs Gemini returned (ignored)
}

/** Bump on any change to SYSTEM or the prompt layout; stored on every run. */
export const PROMPT_VERSION = "2026-10-24.2";

const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    decisions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          sku_id: { type: Type.STRING },
          flag: { type: Type.STRING, enum: FLAGS },
          high_demand: { type: Type.BOOLEAN },
          action: { type: Type.STRING, enum: ACTIONS },
          needs_raghav: { type: Type.BOOLEAN },
          raghav_reason: { type: Type.STRING },
          reason: { type: Type.STRING },
        },
        required: ["sku_id", "flag", "high_demand", "action", "needs_raghav", "raghav_reason", "reason"],
        propertyOrdering: ["sku_id", "flag", "high_demand", "action", "needs_raghav", "raghav_reason", "reason"],
      },
    },
    summary: { type: Type.STRING },
  },
  required: ["decisions", "summary"],
  propertyOrdering: ["decisions", "summary"],
};

const SYSTEM = `You are the demand-planning assistant for Freshroots, a regional FMCG distributor in Maharashtra and Goa.
You make the stock decision for each SKU by applying the senior demand planner Raghav's forecast rules exactly as written in the rubric.

Rules (thresholds come from the rubric JSON you are given):
1. High demand: if the last ${"{recent}"}-week average is more than high_demand_threshold_pct above the ${"{long}"}-week average (change_pct), set high_demand=true and recommend a reorder at high_demand_multiplier x the standard quantity (action REORDER_1_5X).
2. Stockout risk: if cover_weeks is below min_weeks, flag STOCKOUT_RISK and recommend an immediate reorder (REORDER_STANDARD, or REORDER_1_5X if high demand).
3. Overstock risk: if cover_weeks is above max_weeks, flag OVERSTOCK_RISK and recommend PAUSE_NEXT_ORDER.
4. Festival months: weekly_demand already includes the festival uplift when festival=true. Do not apply it again.
5. Perishability: min_weeks and max_weeks are already set per SKU (High perishability uses the tighter window). Use them as given.
Otherwise the flag is OK and the action is NO_ACTION.

How to decide:
- Use only the numbers provided. Never invent sales, stock, lead times, prices or events.
- cover_weeks already counts open purchase orders. Quantities are calculated by the system from your action; do not state a quantity of your own.
- Set needs_raghav=true when the rules do not settle the case: any item in "exceptions", a sudden step-change visible in recent_sales that the averages hide, rising sales on an SKU you are pausing, or anything matching Raghav's judgment notes or the approved lessons. Put the reason in raghav_reason (empty string otherwise).
- Approved lessons come from what actually happened after past decisions and from Raghav's overrides. They never change the thresholds; use them only to decide needs_raghav and to word the reason.
- reason: one plain sentence for Raghav that cites the numbers behind the decision (for example cover weeks against the window, change_pct against the threshold).
- Return exactly one decision for every SKU you are given, with the same sku_id.
- summary: two or three sentences on this run for Raghav: how many SKUs need action and which are most urgent.`;

export async function decideBatch(params: { rubric: Rubric; festival: boolean; latestWeek: string; metrics: SkuMetrics[]; lessons?: string[] }): Promise<GeminiBatchResult> {
  const { rubric } = params;
  const skus = params.metrics.map((m) => ({
    sku_id: m.sku_id,
    name: m.name,
    perishability: m.perishability,
    standard_reorder_qty: m.standard_reorder_qty,
    avg_long: m.avg_12,
    avg_recent: m.avg_4,
    change_pct: m.change_pct,
    weekly_demand: m.weekly_demand,
    on_hand: m.on_hand,
    open_po_qty: m.open_po_qty,
    cover_weeks: m.cover_weeks,
    min_weeks: m.min_weeks,
    max_weeks: m.max_weeks,
    weeks_with_data: m.weeks_with_data,
    recent_sales: m.recent_sales,
    exceptions: m.exceptions,
  }));

  const prompt = `Rubric (Raghav's forecast rules):
${JSON.stringify({
    high_demand_threshold_pct: rubric.high_demand_threshold_pct,
    high_demand_multiplier: rubric.high_demand_multiplier,
    festival_uplift_pct: rubric.festival_uplift_pct,
    long_window_weeks: rubric.avg_window_weeks,
    recent_window_weeks: rubric.recent_window_weeks,
  })}

Raghav's judgment notes:
${rubric.judgment_notes.trim() || "(none written yet)"}

Approved lessons from past outcomes and overrides:
${params.lessons?.length ? params.lessons.map((l, i) => `${i + 1}. ${l}`).join("\n") : "(none yet)"}

Run context: sales up to ${params.latestWeek}. Festival month: ${params.festival ? "yes" : "no"}.

SKUs:
${JSON.stringify(skus)}`;

  const system = SYSTEM.replace("{recent}", String(rubric.recent_window_weeks)).replace("{long}", String(rubric.avg_window_weeks));

  const res = await getClient().models.generateContent({
    model: geminiModel(),
    contents: prompt,
    config: {
      systemInstruction: system,
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
      // 60 s per attempt; the SDK retries 429 and 5xx with exponential backoff.
      httpOptions: { timeout: 60_000, retryOptions: { attempts: 3, initialDelay: 2, maxDelay: 15 } },
    },
  });

  const text = res.text ?? "";
  let parsed: { decisions?: GeminiDecision[]; summary?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Gemini did not return valid JSON. First 300 characters: ${text.slice(0, 300)}`);
  }
  if (!Array.isArray(parsed.decisions)) throw new Error("Gemini's reply has no decisions list.");
  const v = validateDecisions(params.metrics.map((m) => m.sku_id), parsed.decisions);
  return {
    decisions: v.decisions,
    problems: v.problems,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    tokensIn: res.usageMetadata?.promptTokenCount ?? 0,
    tokensOut: res.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

/** Keeps one well-formed decision per requested SKU; reports anything else. Pure. */
export function validateDecisions(requested: string[], raw: unknown[]): { decisions: GeminiDecision[]; problems: string[] } {
  const want = new Set(requested);
  const seen = new Set<string>();
  const decisions: GeminiDecision[] = [];
  const problems: string[] = [];
  for (const d of raw as Partial<GeminiDecision>[]) {
    const id = typeof d?.sku_id === "string" ? d.sku_id : "";
    if (!want.has(id)) { problems.push(`Gemini returned an SKU that wasn't asked for: "${id}".`); continue; }
    if (seen.has(id)) { problems.push(`Gemini returned ${id} twice; kept the first.`); continue; }
    if (!FLAGS.includes(d.flag as Flag) || !ACTIONS.includes(d.action as Action) || typeof d.reason !== "string") {
      problems.push(`Gemini's decision for ${id} was malformed; the rule result is used.`);
      continue;
    }
    seen.add(id);
    decisions.push({
      sku_id: id, flag: d.flag as Flag, action: d.action as Action, high_demand: !!d.high_demand,
      needs_raghav: !!d.needs_raghav, raghav_reason: typeof d.raghav_reason === "string" ? d.raghav_reason : "", reason: d.reason,
    });
  }
  return { decisions, problems };
}
