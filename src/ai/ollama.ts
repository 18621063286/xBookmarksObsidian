import { asArray, asString, get } from "../util/json";

/**
 * Minimal local-Ollama client (http://localhost:11434 by default). All HTTP is
 * injected so it's testable; in the plugin it's wired to Obsidian's requestUrl.
 */

export interface OllamaResponse {
  status: number;
  json: unknown;
  text: string;
}

export type OllamaRequest = (opts: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<OllamaResponse>;

function trimUrl(base: string): string {
  return base.replace(/\/+$/, "");
}

/** List locally installed model names via /api/tags. */
export async function listOllamaModels(request: OllamaRequest, baseUrl: string): Promise<string[]> {
  const res = await request({ url: `${trimUrl(baseUrl)}/api/tags`, method: "GET" });
  if (res.status !== 200) {
    throw new Error(`Ollama not reachable at ${baseUrl} (HTTP ${res.status}). Is \`ollama serve\` running?`);
  }
  return asArray(get(res.json, "models"))
    .map((m) => asString(get(m, "name")))
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

/** Run a single non-streaming generation and return the response text. */
export async function ollamaGenerate(
  request: OllamaRequest,
  baseUrl: string,
  model: string,
  prompt: string
): Promise<string> {
  const res = await request({
    url: `${trimUrl(baseUrl)}/api/generate`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false }),
  });
  if (res.status !== 200) {
    const detail = asString(get(res.json, "error")) ?? res.text ?? "";
    throw new Error(`Ollama generate failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
  }
  return (asString(get(res.json, "response")) ?? "").trim();
}
