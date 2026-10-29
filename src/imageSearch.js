import { chatCompletion } from "./nvidia.js";
import { nextRoundRobinIndex, getAppSetting, setAppSetting } from "./db.js";

const API_URL = "https://www.googleapis.com/customsearch/v1";
const API_KEY = process.env.PSE_API_KEY || process.env.GOOGLE_CSE_API_KEY || "";
const DEFAULT_ENGINE_IDS = [
  "51f78c001d0284c05",
  "15bef143bf9644633",
  "8454339fb70f546cc",
  "141c268497aa443c0",
  "0510da4168de24c6b",
  "21c0a96a3d61045ab",
  "154bfa638b3a0471e",
  "330e6ea160a5a4558",
  "710187d765e324b4d",
  "c008c5b51c3294820"
];
// Select exactly one engine per presentation; all image searches in that deck reuse it.
// The next presentation receives the next ID, persisted across server restarts.
export const ENGINE_IDS = [...new Set([
  ...String(process.env.PSE_CX_ROTATION || "").split(/[;,\s]+/).filter(Boolean),
  ...DEFAULT_ENGINE_IDS
])];
const ENGINE_COOLDOWN_MS = Math.max(5 * 60_000, Number(process.env.PSE_ENGINE_COOLDOWN_MS || 60 * 60_000));
const engineHealthKey = id => `pse_engine_health:${id}`;
function getEngineHealth(id) { return getAppSetting(engineHealthKey(id), { state: "unknown", until: 0, reason: "" }); }
function markEngineUnavailable(id, reason, cooldownMs = ENGINE_COOLDOWN_MS) {
  const health = { state: "cooldown", until: Date.now() + cooldownMs, reason: String(reason || "provider limit/error").slice(0, 300), markedAt: new Date().toISOString() };
  setAppSetting(engineHealthKey(id), health);
  console.warn(`[PSE health] Engine ${id} marked unavailable until ${new Date(health.until).toISOString()}: ${health.reason}`);
}
function markEngineHealthy(id) {
  setAppSetting(engineHealthKey(id), { state: "healthy", until: 0, reason: "", checkedAt: new Date().toISOString() });
}
function engineIsCoolingDown(id) {
  const health = getEngineHealth(id);
  if (health.state === "cooldown" && Number(health.until || 0) > Date.now()) return true;
  if (health.state === "cooldown") setAppSetting(engineHealthKey(id), { state: "unknown", until: 0, reason: "cooldown expired" });
  return false;
}
export function reserveEngineForPresentation() {
  if (!ENGINE_IDS.length) return process.env.PSE_CX || process.env.GOOGLE_CSE_ID || "";
  const start = nextRoundRobinIndex("pse_engine_round_robin", ENGINE_IDS.length);
  for (let offset = 0; offset < ENGINE_IDS.length; offset++) {
    const id = ENGINE_IDS[(start + offset) % ENGINE_IDS.length];
    if (!engineIsCoolingDown(id)) return id;
  }
  console.warn("[PSE health] All configured engines are in cooldown; selecting the next rotation ID and relying on provider fallbacks.");
  return ENGINE_IDS[start];
}
const TEXT_MODEL = process.env.NVIDIA_VISION_MODEL || "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const SEARCH_RESULTS = Math.min(6, Math.max(1, Number(process.env.IMAGE_SEARCH_RESULTS || 3)));
const MAX_IMAGE_BYTES = Math.max(250_000, Number(process.env.IMAGE_SEARCH_MAX_BYTES || 1_500_000));
const TIMEOUT_MS = Math.min(2600, Math.max(1200, Number(process.env.IMAGE_SEARCH_TIMEOUT_MS || 2200)));
const STOCK_PREVIEW_RE = /shutterstock|istockphoto|istock|gettyimages|alamy|dreamstime|depositphotos|123rf|adobestock|stock\.adobe|freepik\.com\/premium|watermark|preview\.jpg|sample-image/i;
function obviousWatermarkSource(candidate) {
  return STOCK_PREVIEW_RE.test(`${candidate?.url || ""} ${candidate?.pageUrl || ""} ${candidate?.title || ""} ${candidate?.snippet || ""}`);
}

function safePublicHttps(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h === "::1" || h.startsWith("127.") || h.startsWith("10.") || h.startsWith("192.168.") || h.startsWith("169.254.") || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    return true;
  } catch { return false; }
}

async function searchGoogleImagesApi(query, engineId) {
  if (!API_KEY || !engineId) {
    throw new Error("Google JSON API credentials are not configured.");
  }
  const params = new URLSearchParams({
    key: API_KEY, cx: engineId, q: query.slice(0, 500), searchType: "image",
    num: String(SEARCH_RESULTS), safe: "active", imgSize: "large", fileType: "jpg",
    rights: "cc_publicdomain,cc_attribute,cc_sharealike"
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API_URL}?${params}`, { signal: controller.signal, headers: { Accept: "application/json" } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = body?.error?.message || `HTTP ${response.status}`;
      const reasons = (body?.error?.errors || []).map(x => `${x.reason || ""} ${x.domain || ""}`).join(" ").toLowerCase();
      const quota = /quotaexceeded|dailylimitexceeded|userratelimitexceeded|ratelimitexceeded|rate limit|quota/i.test(`${reasons} ${reason}`) || response.status === 429;
      const invalidEngine = /invalid value|invalid parameter|invalid cx|search engine.*not found|cx.*not found/i.test(reason);
      const error = new Error(`Google Programmable Search failed (${response.status}): ${reason}`);
      error.pseQuota = quota;
      error.pseInvalidEngine = invalidEngine;
      error.pseStatus = response.status;
      throw error;
    }
    markEngineHealthy(engineId);
    return (body.items || []).filter(x => x?.link && safePublicHttps(x.link) && /^image\/(jpeg|png|webp|avif)$/i.test(x.mime || "image/jpeg"))
      .map(x => ({ url: x.link, title: String(x.title || "Image result").slice(0, 240), pageUrl: safePublicHttps(x.image?.contextLink || "") ? x.image.contextLink : x.link, mime: x.mime || "image/jpeg", width: Number(x.image?.width || 0), height: Number(x.image?.height || 0), snippet: String(x.snippet || "").slice(0, 400) }))
      .filter(x => (!x.width || x.width >= 500) && (!x.height || x.height >= 320))
      .filter(x => !obviousWatermarkSource(x))
      .slice(0, SEARCH_RESULTS);
  } finally { clearTimeout(timer); }
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\\u003d/gi, "=").replace(/\\u0026/gi, "&").replace(/\\u003c/gi, "<").replace(/\\u003e/gi, ">")
    .replace(/\\\//g, "/").replace(/\\x26/gi, "&");
}

function normalizeImageUrl(raw) {
  try {
    let value = decodeHtml(raw).replace(/^['"]|['"]$/g, "");
    if (value.startsWith("//")) value = `https:${value}`;
    let u = new URL(value);
    if (u.hostname.includes("google.") && (u.pathname.includes("/imgres") || u.pathname === "/url")) {
      value = u.searchParams.get("imgurl") || u.searchParams.get("url") || "";
    }
    if (!value) return null;
    try { value = decodeURIComponent(value); } catch {}
    return safePublicHttps(value) ? value : null;
  } catch { return null; }
}

function extractImageCandidates(html, limit = SEARCH_RESULTS) {
  const source = decodeHtml(html);
  const found = new Map();
  const add = (rawUrl, rawPage, title = "Google image result") => {
    const url = normalizeImageUrl(rawUrl);
    if (!url || found.has(url)) return;
    const pageUrl = normalizeImageUrl(rawPage) || url;
    found.set(url, {
      url, title: String(title || "Google image result").replace(/\s+/g, " ").trim().slice(0, 240), pageUrl,
      mime: /\.png(?:[?#]|$)/i.test(url) ? "image/png" : /\.webp(?:[?#]|$)/i.test(url) ? "image/webp" : /\.avif(?:[?#]|$)/i.test(url) ? "image/avif" : "image/jpeg",
      width: 0, height: 0, snippet: ""
    });
  };

  for (const match of source.matchAll(/(?:href|data-url)=["']([^"']*(?:imgurl=|imgres)[^"']*)["']/gi)) {
    try {
      const link = new URL(match[1].replace(/&amp;/g, "&"), "https://www.google.com");
      const imageUrl = link.searchParams.get("imgurl") || link.searchParams.get("mediaurl");
      const pageUrl = link.searchParams.get("imgrefurl") || link.searchParams.get("imgref") || imageUrl;
      if (imageUrl) add(imageUrl, pageUrl);
    } catch {}
  }

  // Some Google result pages serialize image URLs inside script JSON instead of links.
  const decoded = source.replace(/\\u0026/g, "&").replace(/\\u003d/g, "=").replace(/\\\//g, "/");
  for (const match of decoded.matchAll(/https?:\/\/[^\s"'<>\\]+?\.(?:jpe?g|png|webp|avif)(?:\?[^\s"'<>\\]*)?/gi)) {
    add(match[0], match[0]);
    if (found.size >= limit * 3) break;
  }
  return [...found.values()].slice(0, limit);
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal, redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    const html = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (/unusual traffic|not a robot|captcha|automated queries/i.test(html)) throw new Error("Google blocked automated search (CAPTCHA/unusual traffic).");
    return html;
  } finally { clearTimeout(timer); }
}

async function searchGooglePSEHttp(query, engineId) {
  if (!engineId) throw new Error("No Programmable Search Engine IDs are configured.");
  const url = `https://cse.google.com/cse?cx=${encodeURIComponent(engineId)}&q=${encodeURIComponent(query.slice(0, 400))}`;
  const results = extractImageCandidates(await fetchHtml(url));
  if (!results.length) throw new Error("PSE page did not expose image URLs in static HTML. This engine may require its JavaScript widget or API access.");
  return results;
}

async function searchGoogleImagesHttp(query) {
  const url = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(query.slice(0, 400))}&safe=active`;
  const results = extractImageCandidates(await fetchHtml(url));
  if (!results.length) throw new Error("Google Images returned no extractable original image URLs. Google may require JavaScript or block automated requests.");
  return results;
}

// Bing's server-rendered image results are a no-browser fallback when Google's
// PSE widget only renders results through JavaScript. This uses ordinary HTTP
// and still sends downloaded candidates through the same NVIDIA visual filter.
async function searchBingImagesHttp(query) {
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query.slice(0, 400))}&form=HDRSC3&first=1&tsc=ImageBasicHover`;
  const html = await fetchHtml(url);
  const decoded = decodeHtml(html).replace(/\\u0026/g, "&").replace(/\\u003d/g, "=").replace(/\\\\u002f/gi, "/");
  const found = new Map();

  // Bing stores original image URL (murl) and source page URL (purl) in each
  // result's metadata. Parse that metadata rather than thumbnail URLs.
  for (const match of decoded.matchAll(/(?:\bmurl\b|"murl")\s*[:=]\s*"((?:\\.|[^"\\])+)"/g)) {
    let raw = match[1];
    try { raw = JSON.parse(`"${raw}"`); } catch { raw = raw.replace(/\\\\\\//g, "/").replace(/\\\\u0026/gi, "&"); }
    const imageUrl = normalizeImageUrl(raw);
    if (!imageUrl || found.has(imageUrl)) continue;
    const start = Math.max(0, match.index - 1000);
    const end = Math.min(decoded.length, match.index + 1200);
    const context = decoded.slice(start, end);
    const purlMatch = context.match(/(?:\bpurl\b|"purl")\s*[:=]\s*"((?:\\.|[^"\\])+)"/);
    let pageUrl = imageUrl;
    if (purlMatch) {
      try { pageUrl = normalizeImageUrl(JSON.parse(`"${purlMatch[1]}"`)) || imageUrl; } catch {}
    }
    found.set(imageUrl, {
      url: imageUrl, title: `Bing image result for ${query}`.slice(0, 240), pageUrl,
      mime: /\.png(?:[?#]|$)/i.test(imageUrl) ? "image/png" : /\.webp(?:[?#]|$)/i.test(imageUrl) ? "image/webp" : /\.avif(?:[?#]|$)/i.test(imageUrl) ? "image/avif" : "image/jpeg",
      width: 0, height: 0, snippet: ""
    });
    if (found.size >= SEARCH_RESULTS) break;
  }

  // Alternate markup: find escaped murl values in result metadata.
  if (!found.size) {
    for (const match of decoded.matchAll(/\bmurl\s*[:=]\s*([^,}\s]+)/g)) {
      const imageUrl = normalizeImageUrl(match[1].replace(/^['\"]|['\"]$/g, ""));
      if (!imageUrl || found.has(imageUrl)) continue;
      found.set(imageUrl, { url: imageUrl, title: `Bing image result for ${query}`.slice(0, 240), pageUrl: imageUrl, mime: "image/jpeg", width: 0, height: 0, snippet: "" });
      if (found.size >= SEARCH_RESULTS) break;
    }
  }
  if (!found.size) throw new Error("Bing Images returned no extractable original image URLs; the provider may be blocking automated requests.");
  return [...found.values()];
}


// No-key, no-browser fallback. Wikimedia Commons exposes structured image
// metadata through its public MediaWiki API, so this does not scrape a JS page.
async function searchWikimediaCommons(query) {
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: `${String(query || "").replace(/\\b(photo|photograph|image|visual|illustration|high resolution|no text|no watermark|educational|documentary)\\b/gi, "").replace(/\\s+/g, " ").trim().split(" ").slice(0, 8).join(" ")} filetype:bitmap`,
    gsrnamespace: "6",
    gsrlimit: String(Math.min(20, SEARCH_RESULTS * 2)),
    gsrsort: "relevance",
    prop: "imageinfo",
    iiprop: "url|mime|size|extmetadata",
    iiurlwidth: "1600",
    format: "json",
    formatversion: "2"
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
        "User-Agent": "NVIDIA-PowerPoint-Generator/1.0 (image search; contact: admin@example.com)"
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Wikimedia Commons API HTTP ${response.status}`);
    if (body?.error) throw new Error(`Wikimedia Commons API: ${body.error.info || body.error.code}`);
    const pages = Array.isArray(body?.query?.pages) ? body.query.pages : Object.values(body?.query?.pages || {});
    const candidates = [];
    for (const page of pages) {
      const info = page?.imageinfo?.[0];
      if (!info) continue;
      const mime = String(info.thumbmime || info.mime || "").toLowerCase();
      const url = info.thumburl || info.url;
      if (!url || !safePublicHttps(url) || !/^image\/(jpeg|png|webp|avif)$/.test(mime)) continue;
      if (Number(info.width || 0) < 600 || Number(info.height || 0) < 400) continue;
      const metadata = info.extmetadata || {};
      const license = String(metadata.LicenseShortName?.value || "").replace(/<[^>]*>/g, "").trim();
      // Skip files whose reuse license is explicitly absent or restricted.
      if (!license || /all rights reserved|noncommercial use only|no derivatives/i.test(license)) continue;
      const title = String(page.title || "Wikimedia image").replace(/^File:/, "");
      const candidate = {
        url,
        title: title.slice(0, 240),
        pageUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title || "").replace(/%3A/gi, ":").replace(/%20/g, "_")}`,
        mime,
        width: Number(info.thumbwidth || info.width || 0),
        height: Number(info.thumbheight || info.height || 0),
        snippet: String(metadata.ImageDescription?.value || "").replace(/<[^>]*>/g, "").slice(0, 400),
        license
      };
      // Skip obvious stock previews and files explicitly labeled as watermarked.
      if (obviousWatermarkSource(candidate) || /watermark|logo|sample|preview/i.test(title)) continue;
      candidates.push(candidate);
      if (candidates.length >= SEARCH_RESULTS) break;
    }
    if (!candidates.length) throw new Error("Wikimedia Commons returned no suitable openly licensed image candidates for this query.");
    return candidates;
  } finally { clearTimeout(timer); }
}

async function searchGoogleImages(query, selectedEngineId) {
  const primary = selectedEngineId || process.env.PSE_CX || process.env.GOOGLE_CSE_ID || ENGINE_IDS[0] || "";
  const candidates = [primary, ...ENGINE_IDS.filter(id => id !== primary && !engineIsCoolingDown(id))].filter(Boolean);
  let lastApiError = null;

  // Keep one engine for the whole presentation unless its API response explicitly
  // signals a quota/limit or invalid-engine condition. Failover is logged and tracked.
  if (API_KEY && candidates.length) {
    for (const engineId of candidates) {
      if (engineIsCoolingDown(engineId)) continue;
      try {
        const apiResults = await searchGoogleImagesApi(query, engineId);
        if (apiResults.length) return apiResults;
        console.warn(`[PSE health] Engine ${engineId} returned HTTP 200 but zero suitable images; trying its HTML/fallback route.`);
      } catch (err) {
        lastApiError = err;
        console.warn(`[PSE health] Engine ${engineId} response: ${err.message}`);
        if (err.pseQuota) {
          // Google API quotas are often project/API-key scoped, not per cx. Mark
          // this engine and avoid hammering the same endpoint; still try PSE HTML below.
          markEngineUnavailable(engineId, `quota/rate-limit response ${err.pseStatus}: ${err.message}`, ENGINE_COOLDOWN_MS);
          break;
        }
        if (err.pseInvalidEngine) {
          markEngineUnavailable(engineId, `invalid/unavailable engine response ${err.pseStatus}: ${err.message}`, 24 * 60 * 60_000);
          continue;
        }
        // A transient 5xx/timeout is cooled briefly; try the next configured ID.
        if (err.pseStatus >= 500 || /abort|timeout|fetch failed/i.test(err.message)) {
          markEngineUnavailable(engineId, `transient endpoint failure: ${err.message}`, 10 * 60_000);
          continue;
        }
        break;
      }
    }
  }

  // HTML widget pages don't expose API quota details consistently, so we only
  // mark engines from explicit API responses; try the selected engine's PSE page.
  try {
    const results = await searchGooglePSEHttp(query, primary);
    if (results.length) return results;
  } catch (err) {
    console.warn(`[PSE health] HTML search for engine ${primary || "(none)"} failed; using image fallback:`, err.message);
  }
  try { return await searchBingImagesHttp(query); }
  catch (err) {
    throw new Error(`Google PSE engine ${primary || "(none)"}${lastApiError ? ` (API: ${lastApiError.message})` : ""} and Bing fallback failed: ${err.message}`);
  }
}

async function convertImageToPng(buffer, mime) {
  try {
    const sharp = (await import("sharp")).default;
    return await sharp(buffer, { failOn: "error", limitInputPixels: 40_000_000 }).rotate().png().toBuffer();
  } catch (err) {
    throw new Error(`Could not convert ${mime} image to PNG with sharp: ${err.message}`);
  }
}

async function downloadCandidate(candidate) {
  let current = candidate.url;
  for (let redirect = 0; redirect <= 3; redirect++) {
    if (!safePublicHttps(current)) throw new Error("Image URL or redirect is not a public HTTPS URL.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try {
      response = await fetch(current, { signal: controller.signal, redirect: "manual", headers: { Accept: "image/jpeg,image/png;q=0.9,*/*;q=0.1", "User-Agent": "AI-Presentation-Studio/1.0" } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirect === 3) throw new Error("Image host redirected too many times.");
        current = new URL(location, current).toString();
        await response.body?.cancel().catch(() => {});
        continue;
      }
      if (!response.ok) throw new Error(`Image download failed (${response.status}).`);
      const mime = (response.headers.get("content-type") || candidate.mime).split(";")[0].toLowerCase();
      if (!/^image\/(jpeg|png|webp|avif)$/.test(mime)) throw new Error(`Unsupported image type ${mime}; expected JPEG, PNG, WebP, or AVIF.`);
      const len = Number(response.headers.get("content-length") || 0);
      if (len > MAX_IMAGE_BYTES) throw new Error("Image is larger than the configured download limit.");
      const chunks = [];
      let total = 0;
      if (!response.body) throw new Error("Image host returned an empty response.");
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > MAX_IMAGE_BYTES) { await response.body.cancel().catch(() => {}); throw new Error("Image exceeded the configured download limit."); }
        chunks.push(Buffer.from(chunk));
      }
      let buffer = Buffer.concat(chunks);
      if (buffer.length < 1000) throw new Error("Image file is empty or invalid.");
      // PptxGenJS reliably embeds JPEG/PNG. Convert WebP/AVIF to PNG using sharp, without Chromium.
      if (mime === "image/webp" || mime === "image/avif") {
        buffer = await convertImageToPng(buffer, mime);
        return { ...candidate, buffer, mime: "image/png" };
      }
      return { ...candidate, buffer, mime };
    } finally { clearTimeout(timer); }
  }
  throw new Error("Could not download image.");
}

async function chooseWithVision(query, candidates) {
  if (process.env.IMAGE_SEARCH_AI_ANALYSIS !== "true" || candidates.length < 1) return { index: 0, reject: false, reason: "AI image comparison disabled or no candidates." };
  const pool = candidates.slice(0, Math.min(6, candidates.length));
  const content = [{
    type: "text",
    text: `You are a strict editorial image quality reviewer for a professional PowerPoint. Topic: "${query}". Inspect the ACTUAL pixels of each image. Reject images with visible watermarks, stock-photo overlays, agency logos, prominent text, tiled preview marks, low resolution, unrelated subjects, screenshots, or awkward crops. Prefer clean documentary/editorial photography or useful unwatermarked illustrations. Do not treat an ordinary real-world sign or product label as a watermark unless it is a stock overlay. If at least one candidate is suitable, return its zero-based index. If ALL candidates have a visible watermark or are unsuitable, set reject=true. Return ONLY JSON: {"index":0,"reject":false,"reason":"brief visual reason"}. Valid indices 0-${pool.length - 1}.`
  }];
  for (let i = 0; i < pool.length; i++) {
    content.push({ type: "text", text: `Candidate ${i}: ${pool[i].title}. Source page: ${pool[i].pageUrl}.` });
    content.push({ type: "image_url", image_url: { url: `data:${pool[i].mime};base64,${pool[i].buffer.toString("base64")}` } });
  }
  const response = await chatCompletion({ model: TEXT_MODEL, messages: [{ role: "user", content }], temperature: 0.1, max_tokens: 300 });
  const text = typeof response === "string" ? response : JSON.stringify(response);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { index: 0, reject: false, reason: "Vision model returned no parseable selection." };
  const parsed = JSON.parse(match[0]);
  const index = Number(parsed.index);
  return {
    index: Number.isInteger(index) && index >= 0 && index < pool.length ? index : 0,
    reject: parsed.reject === true,
    reason: String(parsed.reason || "AI visual quality check").slice(0, 300)
  };
}

export async function searchAndSelectImage({ query, slideTitle, engineId }) {
  const cleanedQuery = String(query || slideTitle || "professional presentation").replace(/\s+/g, " ").trim().slice(0, 500);
  const providers = [
    { name: `Google PSE/Images (${engineId || "default engine"}) with Bing fallback`, search: () => searchGoogleImages(cleanedQuery, engineId) },
    { name: "Wikimedia Commons API", search: () => searchWikimediaCommons(cleanedQuery) }
  ];
  const providerErrors = [];
  let downloaded = [];
  let providerName = "";
  let failures = [];

  for (const provider of providers) {
    let results;
    try {
      results = await provider.search();
    } catch (err) {
      providerErrors.push(`${provider.name}: ${err.message}`);
      console.warn(`${provider.name} failed; trying next image provider:`, err.message);
      continue;
    }
    const providerDownloaded = [];
    const localFailures = [];
    for (const candidate of results.slice(0, SEARCH_RESULTS)) {
      if (obviousWatermarkSource(candidate)) {
        localFailures.push(`${candidate.title}: skipped likely watermarked stock preview`);
        continue;
      }
      try { providerDownloaded.push(await downloadCandidate(candidate)); }
      catch (err) { localFailures.push(`${candidate.title}: ${err.message}`); }
      if (providerDownloaded.length >= (process.env.IMAGE_SEARCH_AI_ANALYSIS === "true" ? 6 : 1)) break;
    }
    if (providerDownloaded.length) {
      // Filter each candidate set using actual pixels. If the model rejects the
      // whole batch, continue to the next provider instead of embedding a bad image.
      if (providerDownloaded.length >= 1 && process.env.IMAGE_SEARCH_AI_ANALYSIS === "true") {
        try {
          const decision = await chooseWithVision(cleanedQuery, providerDownloaded);
          if (decision.reject) {
            providerErrors.push(`${provider.name}: AI rejected candidates: ${decision.reason}`);
            continue;
          }
          downloaded = providerDownloaded;
          providerName = provider.name;
          failures = localFailures;
          // Move the selected candidate to the first position so the shared selector below keeps it.
          downloaded._preselected = decision.index;
          downloaded._selectionReason = decision.reason;
          break;
        } catch (err) {
          console.warn("AI watermark/relevance filtering failed:", err.message);
          // On vision errors, don't claim watermark detection succeeded. Try next provider.
          providerErrors.push(`${provider.name}: AI image filtering failed: ${err.message}`);
          continue;
        }
      } else {
        downloaded = providerDownloaded;
        providerName = provider.name;
        failures = localFailures;
        break;
      }
    }
    providerErrors.push(`${provider.name}: found candidates but could not download any. ${localFailures.slice(0, 2).join("; ")}`);
  }

  if (!downloaded.length) {
    throw new Error(`No usable images were downloaded. ${providerErrors.join(" | ")}`);
  }

  let selected = Number.isInteger(downloaded._preselected) ? downloaded._preselected : 0;
  let analysis = downloaded._selectionReason
    ? `AI visual filter: ${downloaded._selectionReason}`
    : "Selected the highest-ranked downloadable result; only one candidate was available.";
  const winner = downloaded[selected] || downloaded[0];
  return {
    buffer: winner.buffer,
    mime: winner.mime,
    model: `${providerName} + NVIDIA visual selection`,
    sourceUrl: winner.url,
    sourceTitle: winner.title,
    sourcePageUrl: winner.pageUrl,
    searchQuery: cleanedQuery,
    analysis,
    license: winner.license || null,
    warning: providerErrors.length ? providerErrors.join(" | ") : null
  };
}
