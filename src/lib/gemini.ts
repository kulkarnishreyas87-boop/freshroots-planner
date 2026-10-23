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
}

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
- Set needs_raghav=true when the rules do not settle the case: any item in "exceptions", a sudden step-change visible in recent_sales that the averages hide, rising sales on an SKU you are pausing, or anything matching Raghav's judgment notes. Put the reason in raghav_reason (empty string otherwise).
- reason: one plain sentence for Raghav that cites the numbers behind the decision (for example cover weeks against the window, change_pct against the threshold).
- Return exactly one decision for every SKU you are given, with the same sku_id.
- summary: two or three sentences on this run for Raghav: how many SKUs need action and which are most urgent.`;

export async function decideBatch(params: { rubric: Rubric; festival: boolean; latestWeek: string; metrics: SkuMetrics[] }): Promise<GeminiBatchResult> {
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
    },
  });

  const text = res.text ?? "";
  let parsed: GeminiBatchResult;
  try {
    parsed = JSON.parse(text) as GeminiBatchResult;
  } catch {
    throw new Error(`Gemini did not return valid JSON. First 300 characters: ${text.slice(0, 300)}`);
  }
  if (!Array.isArray(parsed.decisions)) throw new Error("Gemini's reply has no decisions list.");
  return parsed;
}
