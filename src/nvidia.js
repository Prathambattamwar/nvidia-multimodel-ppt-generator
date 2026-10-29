import dotenv from "dotenv";
dotenv.config();

const BASE = (process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/+$/, "");
const KEY = process.env.NVIDIA_API_KEY;
const MAX_RETRIES = Math.max(0, Number(process.env.NVIDIA_MAX_RETRIES ?? 1));
const BASE_DELAY = Math.max(250, Number(process.env.NVIDIA_RETRY_BASE_MS ?? 1200));
const TIMEOUT = Math.min(30000, Math.max(10000, Number(process.env.NVIDIA_REQUEST_TIMEOUT_MS ?? 25000)));
const TIMEOUT_RETRIES = Math.max(0, Number(process.env.NVIDIA_TIMEOUT_RETRIES ?? 0));

export class UpstreamError extends Error {
  constructor(message, status = 502, details = "") {
    super(message); this.name = "UpstreamError"; this.status = status; this.details = details;
  }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function retryable(status) { return status === 408 || status === 425 || status === 429 || status >= 500; }
function retryDelay(attempt, retryAfter) {
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 60000);
  const exp = Math.min(BASE_DELAY * (2 ** attempt), 30000);
  return Math.round(exp * (0.75 + Math.random() * 0.5));
}
async function requestJson(path, payload, label) {
  if (!KEY) throw new UpstreamError("NVIDIA_API_KEY is missing. Add it to .env and restart the server.", 503);
  let last;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload), signal: controller.signal
      });
      const raw = await res.text();
      let body;
      try { body = JSON.parse(raw); } catch { body = { raw: raw.slice(0, 1200) }; }
      if (!res.ok) {
        const msg = body?.detail || body?.message || body?.error?.message || body?.title || `HTTP ${res.status}`;
        last = new UpstreamError(`${label} failed (${res.status}): ${String(msg).slice(0, 500)}`, res.status, JSON.stringify(body).slice(0, 1200));
        if (attempt < MAX_RETRIES && retryable(res.status)) {
          await sleep(retryDelay(attempt, res.headers.get("retry-after"))); continue;
        }
        throw last;
      }
      return body;
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      last = err;
      if (err?.name === "AbortError") {
        if (attempt < Math.min(MAX_RETRIES, TIMEOUT_RETRIES)) {
          await sleep(retryDelay(attempt));
          continue;
        }
        throw new UpstreamError(`${label} timed out after ${TIMEOUT}ms. Try the faster NVIDIA text model nvidia/nemotron-3.5-lightning-30b-a3b, reduce the slide count, or check NVIDIA endpoint capacity.`, 504);
      }
      if (attempt < MAX_RETRIES) { await sleep(retryDelay(attempt)); continue; }
      throw new UpstreamError(`${label} network failure: ${err.message}`, 502);
    } finally { clearTimeout(timer); }
  }
  throw last || new UpstreamError(`${label} failed`, 502);
}

export async function chatCompletion({model, messages, temperature=0.4, max_tokens=5000, response_format}) {
  // Nemotron 3.5 Lightning can spend the entire max_tokens budget on hidden reasoning,
  // leaving message.content empty. Slide drafting needs direct JSON, not a reasoning trace.
  // NVIDIA's hosted endpoint supports this OpenAI-compatible chat-template flag.
  // Match the verified working request: disable thinking through NVIDIA's
  // chat-template option. Do not send reasoning_budget, which is not needed
  // for this endpoint and can conflict with model-specific handling.
  const disableThinking = String(process.env.NVIDIA_DISABLE_THINKING ?? "true").toLowerCase() !== "false";
  const payload = {
    model, messages, temperature, max_tokens,
    ...(disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {})
  };
  if (response_format) payload.response_format = response_format;
  const data = await requestJson("/chat/completions", payload, `Text model ${model}`);
  const choice = data?.choices?.[0];
  const message = choice?.message;
  let content = message?.content;
  if (Array.isArray(content)) {
    content = content.map(part => typeof part === "string" ? part : (part?.text || "")).join("");
  }
  if (typeof content === "string" && content.trim()) return content.trim();
  const finish = choice?.finish_reason || "unknown";
  const hasReasoning = Boolean(message?.reasoning_content || message?.reasoning);
  const usage = data?.usage;
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;
  throw new UpstreamError(
    `Text model ${model} returned no visible message content (finish_reason=${finish}${hasReasoning ? ", reasoning-only response" : ""}${Number.isFinite(reasoningTokens) ? `, reasoning_tokens=${reasoningTokens}` : ""}). The request used ${disableThinking ? "chat_template_kwargs.enable_thinking=false" : "thinking enabled"}.`,
    502,
    JSON.stringify(data).slice(0, 1800)
  );
}

export async function generateImage({model, prompt}) {
  // NVIDIA's hosted catalog currently exposes Qwen Image under qwen/qwen-image.
  // Some older configs use qwen/qwen-image-2512; retry the catalog model on 404.
  const candidates = [model];
  if (model === "qwen/qwen-image-2512") candidates.push("qwen/qwen-image");
  let lastError;
  for (const candidate of [...new Set(candidates)]) {
    try {
      const data = await requestJson("/images/generations", {
        model: candidate, prompt, n: 1, response_format: "b64_json"
      }, `Image model ${candidate}`);
      const item = data?.data?.[0];
      if (item?.b64_json) return { buffer: Buffer.from(item.b64_json, "base64"), mime: "image/png", model: candidate };
      if (item?.base64 || item?.image_base64) {
        return { buffer: Buffer.from(item.base64 || item.image_base64, "base64"), mime: item.mime_type || "image/png", model: candidate };
      }
      const imageUrl = item?.url || item?.image_url || item?.uri;
      if (imageUrl) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT);
        try {
          const res = await fetch(imageUrl, { signal: controller.signal });
          if (!res.ok) throw new UpstreamError(`Image URL fetch failed (${res.status}).`, 502);
          const mime = res.headers.get("content-type") || "image/png";
          if (!mime.startsWith("image/")) throw new UpstreamError("Image endpoint returned a non-image URL.", 502);
          return { buffer: Buffer.from(await res.arrayBuffer()), mime, model: candidate };
        } finally { clearTimeout(timer); }
      }
      throw new UpstreamError(`Image model ${candidate} returned an unsupported response format. Expected data[0].b64_json, base64, image_base64, or a URL.`, 502, JSON.stringify(data).slice(0,1200));
    } catch (err) {
      lastError = err;
      if (!(err instanceof UpstreamError) || err.status !== 404) throw err;
    }
  }
  if (lastError?.status === 404) {
    throw new UpstreamError(`${lastError.message}. NVIDIA's hosted image endpoint may not be enabled for this API key. Verify access on https://build.nvidia.com/qwen/qwen-image and set NVIDIA_IMAGE_MODEL to a model enabled for your account.`, 404, lastError.details);
  }
  throw lastError || new UpstreamError(`Image model ${model} failed.`, 502);
}
