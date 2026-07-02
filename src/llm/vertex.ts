import { env } from "../config/env";

// Vertex-EU (Gemini) yazar katmanı — GCP creds gelince implement edilir (@google-cloud/vertexai).
// Şu an creds YOK → configured() false → router lokal Ollama'ya fallback (Faz 1 kilitlenmez).
// KVKK: implement edildiğinde GOOGLE_CLOUD_LOCATION=europe-west4 (EU residency) zorunlu.
export function vertexConfigured(): boolean {
  return Boolean(env.GOOGLE_CLOUD_PROJECT && env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

export async function vertexJson<T>(_opts: {
  system: string;
  user: string;
  schema: unknown;
}): Promise<T> {
  throw new Error(
    "vertex not configured — GOOGLE_CLOUD_PROJECT + GOOGLE_SERVICE_ACCOUNT_JSON gerekli (europe-west4). Router Ollama'ya fallback yapar.",
  );
}
