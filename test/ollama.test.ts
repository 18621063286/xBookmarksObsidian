import { describe, it, expect, vi } from "vitest";
import { listOllamaModels, ollamaGenerate } from "../src/ai/ollama";

const ok = (json: any) => async () => ({ status: 200, json, text: JSON.stringify(json) });

describe("listOllamaModels", () => {
  it("returns model names from /api/tags", async () => {
    const req = vi.fn(ok({ models: [{ name: "llama3" }, { name: "qwen2.5" }] }));
    expect(await listOllamaModels(req, "http://localhost:11434")).toEqual(["llama3", "qwen2.5"]);
    expect(req).toHaveBeenCalledWith(expect.objectContaining({ url: "http://localhost:11434/api/tags" }));
  });

  it("trims a trailing slash on the base url", async () => {
    const req = vi.fn(ok({ models: [] }));
    await listOllamaModels(req, "http://localhost:11434/");
    expect(req).toHaveBeenCalledWith(expect.objectContaining({ url: "http://localhost:11434/api/tags" }));
  });

  it("filters out malformed entries", async () => {
    const req = vi.fn(ok({ models: [{ name: "a" }, {}, { name: "" }, { name: "b" }] }));
    expect(await listOllamaModels(req, "x")).toEqual(["a", "b"]);
  });

  it("throws a clear error when Ollama is unreachable", async () => {
    const req = vi.fn(async () => ({ status: 0, json: undefined, text: "" }));
    await expect(listOllamaModels(req, "http://localhost:11434")).rejects.toThrow(/ollama/i);
  });
});

describe("ollamaGenerate", () => {
  it("posts to /api/generate and returns the response text", async () => {
    const req = vi.fn(ok({ response: "  summary text  " }));
    const out = await ollamaGenerate(req, "http://localhost:11434", "llama3", "prompt");
    expect(out).toBe("summary text");
    const call = (req.mock.calls as any[])[0][0];
    expect(call.url).toBe("http://localhost:11434/api/generate");
    expect(call.method).toBe("POST");
    expect(JSON.parse(call.body)).toEqual({ model: "llama3", prompt: "prompt", stream: false });
  });

  it("throws with the server error detail on failure", async () => {
    const req = vi.fn(async () => ({ status: 404, json: { error: "model not found" }, text: "" }));
    await expect(ollamaGenerate(req, "x", "nope", "p")).rejects.toThrow(/model not found/);
  });
});
