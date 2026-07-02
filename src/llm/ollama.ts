import { z } from "zod";
import { env } from "../config/env";

// Ollama /api/chat — JSON-mode + thinking kapalı; <think> defensive strip; zod-validate.
// Halüsinasyon guard'ının teknik zemini: serbest metin değil, ŞEMALI çıktı.
export async function ollamaJson<S extends z.ZodTypeAny>(opts: {
  model?: string;
  system: string;
  user: string;
  schema: S;
  temperature?: number;
}): Promise<z.infer<S>> {
  const model = opts.model ?? env.OLLAMA_BULK_MODEL;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), env.OLLAMA_TIMEOUT_MS);
  try {
    const res = await fetch(`${env.OLLAMA_HOST}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        format: "json",
        options: { temperature: opts.temperature ?? 0 },
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { message?: { content?: string } };
    const raw = (data.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Bazı modeller JSON'u metne sarar; ilk {...} bloğunu yakala.
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) throw new Error(`ollama JSON parse edilemedi: ${raw.slice(0, 200)}`);
      parsed = JSON.parse(m[0]);
    }
    return opts.schema.parse(parsed) as z.infer<S>;
  } finally {
    clearTimeout(to);
  }
}

export async function ollamaUp(): Promise<boolean> {
  try {
    const r = await fetch(`${env.OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}
