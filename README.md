# NVIDIA Multi-Model AI PowerPoint Generator

One Google Programmable Search Engine ID is reserved per presentation. If the Google JSON API explicitly reports a quota/rate limit, invalid engine, or transient server failure, that engine is recorded in SQLite with a cooldown and the app tries another eligible ID or falls back to Bing/Wikimedia. The ten supplied IDs are built in. Optional additional IDs can be set with `PSE_CX_ROTATION` (comma-separated).


Standalone Node.js app that creates editable `.pptx` presentations using NVIDIA text/review models and Google Programmable Search Engine image search, with NVIDIA multimodal analysis to select relevant image candidates.

## Features
- Topic, slide count, audience, tone, and visual style inputs.
- NVIDIA text model drafts slide structure/content.
- Google image search retrieves relevant existing JPEG/PNG images for each slide; the NVIDIA multimodal model compares candidate images and selects the best match when vision access is available.
- Optional review model pass.
- Editable PowerPoint: text, titles, shapes, tables and layout remain native PowerPoint elements; generated images are embedded separately.
- Generated images and presentation files are stored locally.
- SQLite records generation jobs and presentation metadata.
- Retries with exponential backoff + jitter for HTTP 429, 5xx, timeouts and transient network failures.
- Queue/semaphore limits concurrent generation jobs to avoid flooding NVIDIA endpoints.
- Per-client HTTP rate limit and server-side prompt validation.
- Status polling and download endpoint.
- Secrets stay server-side in `.env`.

## Requirements
- Node.js 20+
- NVIDIA API key for text generation and multimodal image analysis.
- Google Programmable Search Engine ID (`PSE_CX`). A Google API key is **not required** for HTTP-based retrieval, though Google may block automated requests.
- Internet access from the Node.js server to Google search pages and candidate image hosts.
- A vision-capable NVIDIA model/API account for AI image selection.

## Setup (Windows PowerShell)
```powershell
cd nvidia-multimodel-ppt-generator
Copy-Item .env.example .env
notepad .env
npm install
npm start
```
Open http://localhost:3000.

## Setup (Linux VPS)
```bash
cp .env.example .env
nano .env
npm install
npm start
```
For a public VPS, set `HOST=127.0.0.1` behind Nginx/Caddy, enable HTTPS, set firewall rules, and run under a process manager such as systemd or PM2. Do not expose the app directly without authentication if multiple users can access it.

## Google image search strategy
The app reserves one Google PSE ID for a presentation. When `PSE_API_KEY` is configured, Google JSON API response codes and error reasons are inspected: quota/rate-limit responses, invalid engines, and transient failures are logged and stored in SQLite with cooldowns. If an engine is cooling down, the app skips it on later searches; a fallback engine is only used when the selected engine is reported unavailable. Google quota can be scoped to the API project/key rather than an individual engine, so switching IDs may not bypass a project-wide quota. HTML-based PSE search cannot reliably report account quota status. The app tries Google PSE and Google Images via plain HTTP, then Bing Images. If Google/Bing results cannot be extracted or downloaded, it falls back to the Wikimedia Commons public API, which does not require a key or browser. Downloaded candidates are passed to the NVIDIA multimodal model to compare actual image pixels. Commons results are filtered to files with reuse-license metadata, and the selected source page is retained for attribution/review. The best candidate is embedded into the PPTX. Image files are saved locally; source-page links are recorded for attribution/review. If vision selection fails, the first downloadable candidate is used. If image search is unavailable, slide text/shapes still produce a PowerPoint and the image error appears in the job details.

Configure these in `.env`:
```env
IMAGE_PROVIDER=google_pse
PSE_CX=31e897332f91f4804
# Optional only if you already have access to Google Custom Search JSON API:
PSE_API_KEY=
IMAGE_SEARCH_RESULTS=8
IMAGE_SEARCH_MAX_BYTES=1500000
IMAGE_SEARCH_AI_ANALYSIS=true
```
Google HTML search is best-effort and can be blocked or return no image URLs. This version does not use Chromium. When Google and Bing cannot return downloadable images, the app automatically uses the Wikimedia Commons API without a key, and still sends downloaded candidates to NVIDIA for visual selection. `PSE_API_KEY` remains optional and is only used if you already have Custom Search JSON API access.

## Multi-model flow
1. Planner/content model produces structured slide JSON.
2. Review model checks and lightly improves the deck content (can be disabled with `ENABLE_REVIEW=false`).
3. Google image search retrieves candidates; NVIDIA multimodal analysis ranks actual image content when supported.
4. PptxGenJS assembles the editable presentation and embeds generated images.
5. SQLite records job state, prompt, model IDs, output path and error details.

## Configuration
- `NVIDIA_TEXT_MODEL`: planning/content model.
- `NVIDIA_REVIEW_MODEL`: review model.
- `PSE_CX`: your Google Programmable Search Engine ID.
- `PSE_ENGINE_COOLDOWN_MS`: cooldown after a detected Google quota/rate-limit response (default 3600000 ms / 1 hour). Invalid engines cool down for 24 hours; transient failures for 10 minutes. `PSE_API_KEY` is optional and only used if you already have JSON API access. Response-based quota tracking requires this key; HTTP widget mode can only detect request failures/CAPTCHAs, not reliably inspect quota.
- `IMAGE_SEARCH_AI_ANALYSIS=false` (default): skip per-slide vision-model calls and use the first downloadable result; enable `true` for slower visual watermark/relevance checks.
- `MAX_CONCURRENT_GENERATIONS`: how many full-deck jobs can run at once.
- `NVIDIA_MAX_RETRIES`: max retry attempts per upstream call.
- `MAX_SLIDES`: maximum requested slides.
- `ENABLE_REVIEW=false` (default): skips the extra full-deck review model call; set `true` for an additional quality pass.

## Notes / limitations
- Generated pictures are raster images, not editable vector art.
- Slide text and shapes remain editable.
- API costs, rate limits, response formats, and model access depend on your NVIDIA account and selected model.
- Image generation is intentionally queued with low concurrency. Increase only after measuring API quotas.
- The app does not promise zero failures: rate limits and service overload are handled with retries and clear job errors.

## Troubleshooting image failures
If a slide has no generated image, open the generation status panel and read the error shown under that slide. Common causes:
- HTTP 401/403: API key or model permission problem.
- HTTP 404: model ID or endpoint unavailable.
- HTTP 429/503: rate limit or temporary provider capacity; the app retries with backoff.
- URL response download error: the image URL expired or did not return image bytes.
The app tries Google PSE, Google Images, and Bing Images over HTTP without Chromium. If those results are unavailable or images cannot be downloaded, it uses Wikimedia Commons via its public API. Wikimedia Commons requires no API key. All selected images are downloaded and offered to the configured NVIDIA multimodal model for visual comparison. Public API availability still depends on the host network being able to reach the provider.

## Retired reviewer model (HTTP 410)
The default reviewer is `nvidia/nemotron-3.5-lightning-30b-a3b`. If your `.env` already contains an older `NVIDIA_REVIEW_MODEL`, update that line too. If a reviewer still returns HTTP 410, the app automatically retries the review pass with `NVIDIA_TEXT_MODEL`.


### Image search troubleshooting

- Keep `PSE_CX` set to your Programmable Search Engine ID. HTTP mode does not need `PSE_API_KEY` or Chromium.
- Run `npm install` so the `sharp` image converter is installed.
- If Google presents a CAPTCHA or blocks automated requests, HTTP-only search cannot reliably work; the UI shows the specific image-search error on each slide card.
- AI visual selection uses `NVIDIA_TEXT_MODEL` and requires a model that accepts image input. If vision analysis is unsupported, the app logs the reason and falls back to the first downloadable result.


## Premium layout and image-quality improvements
- Content generation now asks for more substantial bullets, context paragraphs, actionable takeaways, and longer speaker notes.
- Slide layouts now alternate between editorial split layouts, wide-image layouts, and a distinctive closing slide.
- Image candidate selection rejects obvious stock-preview/watermark sources and uses NVIDIA vision to reject candidates with visible watermark overlays, logos, or prominent text.
- If all images from one provider are rejected, the search continues to the next provider instead of immediately embedding a watermarked candidate.
- Image selection quality depends on the configured NVIDIA model accepting image inputs. If vision analysis is unavailable, the app reports that limitation instead of claiming watermark filtering succeeded.


### Timeout troubleshooting

The default text-drafting/review model is `nvidia/nemotron-3.5-lightning-30b-a3b` to reduce latency. Image-pixel review uses the separately configured `NVIDIA_VISION_MODEL` (default `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`). If you already have a `.env` file, update `NVIDIA_TEXT_MODEL` there manually; `.env.example` does not overwrite it. Fast defaults skip the extra review call and per-slide vision checks, use one image candidate per slide, and cap NVIDIA calls at 45 seconds with no timeout retry. Set `ENABLE_REVIEW=true` and `IMAGE_SEARCH_AI_ANALYSIS=true` for slower extra quality checks. If you already have a `.env`, update it manually because `.env.example` does not overwrite existing settings.


### Faster generation

The default image-search timeout is 3.5 seconds and image downloads run up to 8 slides in parallel. If you already have a `.env` file, update `IMAGE_SEARCH_TIMEOUT_MS=3500`, `IMAGE_SEARCH_RESULTS=3`, and `MAX_CONCURRENT_GENERATIONS=8` there too; `.env.example` does not override an existing `.env`. Faster timeouts may mean more slides use the designed visual fallback when image providers respond slowly.

## History presentation template
Choose **History template — Slidesgo terracotta and parchment** under Visual direction to use a history-specific palette inspired by the supplied Slidesgo Ancient World History template (terracotta `#A75441`, dusty rose `#E29887`, parchment cream, and white), with history-focused prompts for timelines, regions, maps, artifacts, and period-accurate visuals. History topics are also automatically detected. This reproduces the visual direction rather than importing the original 93-slide file or its individual slide layouts.


### Richer slide content and history-template layouts

The content prompt now requests 4–6 specific bullets on standard content slides, a context paragraph of roughly 45–75 words, and presenter notes of roughly 100–160 words. The goal is to explain concrete facts, dates, examples, causes/consequences, comparisons, and significance instead of generating sparse headline-only slides. The output token budget scales with requested slide count (capped at 12,000 tokens).

For history presentations, the PowerPoint renderer now uses a dedicated warm editorial layout: parchment/cream canvas, terracotta and dusty-rose accents, paper-like panels, numbered points, varied image/text compositions, and section-divider slides. Images are still conditional: the generator should retrieve them only when they materially help explain a slide. This recreates the uploaded template’s visual direction, but does not copy the original 93 slide layouts or assets exactly.

## Fast generation mode

The generator is tuned to reduce waiting without sacrificing useful slide content:
- Proportional output-token budget (520 tokens per requested slide, bounded between 3,000 and 9,000) instead of forcing every deck to request at least 6,500 tokens.
- Shorter but still substantive visible copy and speaker notes, reducing slow oversized JSON responses.
- NVIDIA request timeout capped at 45 seconds (35 seconds by default) with timeout retries disabled by default.
- Image-search HTTP timeouts capped at 2.6 seconds (2.2 seconds by default).
- If Google PSE's static page fails, skip the additional Google Images scrape and move directly to Bing; Wikimedia Commons remains the final openly licensed fallback.
- Image downloads remain concurrent, and failed image searches never block the text-and-shapes PowerPoint fallback.

For best speed, keep `ENABLE_REVIEW=false`, use `nvidia/nemotron-3.5-lightning-30b-a3b` as `NVIDIA_TEXT_MODEL`, and request 6-10 slides when possible. NVIDIA endpoint capacity and network latency are external factors and cannot be eliminated by local code.


### Fast text generation and timeout handling

Use `NVIDIA_TEXT_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b` for slide drafting. If an existing `.env` still sets `NVIDIA_TEXT_MODEL` to `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`, the generator automatically switches drafting to the Lightning model; the Omni model can remain configured separately for optional vision analysis. Requests are capped at 30 seconds (25 seconds by default), and default retry count is zero to avoid repeatedly waiting on a saturated endpoint. Draft token budgets are proportional to slide count to reduce latency. Restart the server after updating the project.


### Fast text generation / empty NVIDIA responses

The default drafting model is `nvidia/nemotron-3.5-lightning-30b-a3b`. The client sends `chat_template_kwargs: { enable_thinking: false }` and `reasoning_budget: 0` so the model returns slide JSON directly instead of spending its token budget on a reasoning trace. If the endpoint still returns an empty visible message, restart the app and retry; repeated empty responses can indicate temporary endpoint behavior or account capacity.

## Template and image placement refinements

- Slide content can request an intentional image position (`left`, `right`, or `full`) rather than relying only on slide-number rotation.
- Full-width imagery is reserved for visual evidence such as maps, scenes, timelines, and key artifacts; text-heavy slides stay text-first.
- Image-led slides alternate their image/text balance while keeping the title and footer grid consistent.
- Image placement uses PptxGenJS crop sizing where supported, with a contain-mode fallback to avoid stretching source images. A subtle keyline separates photos from the page background.
- The history style keeps its parchment/terracotta palette and asymmetric editorial layouts; images are skipped when they do not add explanatory value.


## Content and image reliability fixes
- Slide normalization accepts common alternate model field names and repairs missing bullets/body/notes before rendering, so title-only slides are not silently accepted.
- Content prompts require four substantive bullets and a supporting paragraph per regular slide.
- Educational decks request contextual images for relevant processes, examples, and concepts; image queries are shortened to improve retrieval.
- Image failures remain non-fatal and the deck falls back to complete text-and-shape layouts.
- NVIDIA Nemotron 3.5 Lightning uses `chat_template_kwargs: { enable_thinking: false }` by default to prevent reasoning from consuming the visible output token budget.


### Faster, timeout-resistant slide drafting

Slide drafting is split into small sequential batches (3 slides by default) so a large deck does not depend on one long NVIDIA response. Set `NVIDIA_DRAFT_BATCH_SIZE=2` for more conservative endpoint behavior or `3` for the default. Each batch uses the configured fast text model and disables thinking when `NVIDIA_DISABLE_THINKING=true`.


### Slide count options
The UI offers 4, 6, 8, 10, or 12 slides. The server also enforces a maximum of 12 slides to keep generation manageable for the configured NVIDIA model.
