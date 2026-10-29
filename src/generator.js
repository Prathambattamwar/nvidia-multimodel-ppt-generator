import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import PptxGenJS from "pptxgenjs";
import dotenv from "dotenv";
import { chatCompletion } from "./nvidia.js";
import { searchAndSelectImage, reserveEngineForPresentation } from "./imageSearch.js";
import { updateJob, addAsset } from "./db.js";
dotenv.config();

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const IMAGE_DIR = path.join(DATA_DIR, "images");
const PPTX_DIR = path.join(DATA_DIR, "presentations");
const FAST_TEXT_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";
const CONFIGURED_TEXT_MODEL = process.env.NVIDIA_TEXT_MODEL || FAST_TEXT_MODEL;
// Keep the slower omni-reasoning model available for vision tasks, but never let it
// become the default slide-drafting model when .env still points at it.
const TEXT_MODEL = /nemotron-3-nano-omni-30b-a3b-reasoning/i.test(CONFIGURED_TEXT_MODEL)
  ? FAST_TEXT_MODEL
  : CONFIGURED_TEXT_MODEL;
const REVIEW_MODEL = process.env.NVIDIA_REVIEW_MODEL || "nvidia/nemotron-3.5-lightning-30b-a3b";
const IMAGE_PROVIDER = (process.env.IMAGE_PROVIDER || "google_pse").toLowerCase();
const MAX_SLIDES = Math.min(12, Math.max(3, Number(process.env.MAX_SLIDES || 12)));
const ENABLE_REVIEW = process.env.ENABLE_REVIEW === "true";
const MAX_IMAGE_CONCURRENCY = Math.min(12, Math.max(1, Number(process.env.MAX_CONCURRENT_GENERATIONS || 10)));

await fs.mkdir(IMAGE_DIR, { recursive: true });
await fs.mkdir(PPTX_DIR, { recursive: true });

function stripFences(s) { return String(s).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim(); }
function cleanJsonCommonIssues(value) {
  // Repair common model formatting mistakes without changing quoted string content.
  let out = "", inString = false, escaped = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === "\\") { out += ch; escaped = true; continue; }
      if (ch === '"') { out += ch; inString = false; continue; }
      if (ch === "\n" || ch === "\r" || ch === "\t") { out += ch === "\t" ? "\\t" : "\\n"; continue; }
      out += ch; continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    out += ch;
  }
  // Remove trailing commas before closing arrays/objects, a frequent model JSON error.
  return out.replace(/,\s*([}\]])/g, "$1");
}
function extractJson(s) {
  const cleaned = stripFences(s);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  try { return JSON.parse(candidate); } catch (firstError) {
    try { return JSON.parse(cleanJsonCommonIssues(candidate)); } catch (secondError) {
      const line = secondError?.lineNumber || firstError?.lineNumber;
      const column = secondError?.columnNumber || firstError?.columnNumber;
      throw new Error(`The content model returned malformed JSON${line ? ` near line ${line}${column ? `, column ${column}` : ""}` : ""}. The generator will retry this batch once.`);
    }
  }
}
function clampText(v, max=1200) { return String(v ?? "").trim().slice(0, max); }
function normalizeDeck(deck, request) {
  if (!deck || !Array.isArray(deck.slides)) throw new Error("Model response is missing slides array.");
  const slides = deck.slides.slice(0, MAX_SLIDES).map((s, i) => ({
    title: clampText(s.title || `Slide ${i+1}`, 120),
    subtitle: clampText(s.subtitle, 220),
    bullets: (Array.isArray(s.bullets) ? s.bullets
      : Array.isArray(s.key_points) ? s.key_points
      : Array.isArray(s.points) ? s.points
      : Array.isArray(s.content_points) ? s.content_points
      : Array.isArray(s.highlights) ? s.highlights
      : []).slice(0, 5).map(x => clampText(typeof x === "string" ? x : (x?.text || x?.description || x?.point || ""), 260)).filter(Boolean),
    body: clampText(s.body || s.explanation || s.description || s.content || s.context, 1400),
    takeaway: clampText(s.takeaway || s.key_takeaway, 260),
    kicker: clampText(s.kicker || s.section_label, 80),
    visual_prompt: clampText(s.visual_prompt || `Professional editorial illustration about ${request.topic}, ${request.visualStyle} style. No text, no watermark.`, 1200),
    image_search_query: clampText(s.image_search_query || `${s.title || request.topic} ${s.subtitle || ""} ${request.topic} educational documentary photo or clear scientific illustration`, 500),
    needs_image: i === 0 || (i < (Array.isArray(deck.slides) ? deck.slides.length : 0) - 1 && (
      s.needs_image === true ||
      /map|location|architecture|artifact|portrait|species|anatomy|process|diagram|comparison|timeline|landmark|artwork|visual evidence|example image|cycle|stage|step|case study|example|impact|environment|nature|water|planet|ocean|river|plant|cloud|rain|sun/i.test(`${s.title} ${s.subtitle || ""} ${s.visual_prompt || ""}`) ||
      (typeof s.needs_image !== "boolean" && i % 2 === 0)
    )),
    image_position: ["left","right","full"].includes(s.image_position) ? s.image_position : (s.layout === "section" ? "full" : i % 3 === 2 ? "full" : i % 2 ? "right" : "left"),
    speaker_notes: clampText(s.speaker_notes || s.presenter_notes || s.notes || s.talk_track, 1800),
    layout: ["cover","section","content","closing","two-column","quote"].includes(s.layout) ? s.layout : (i === 0 ? "cover" : "content")
  }));
  if (slides.length < 3) throw new Error("The content model returned fewer than 3 slides. Try again.");
  // Repair schema drift and sparse model output before layout. The previous
  // version accepted a title-only slide even when the model used alternate
  // field names, which created visually empty PowerPoints.
  for (const slide of slides) {
    const sentencePool = [slide.body, slide.speaker_notes, slide.subtitle]
      .filter(Boolean).join(" ")
      .split(/(?<=[.!?])\\s+|\\n+/)
      .map(x => x.replace(/^[-•*\\d.)\\s]+/, "").trim())
      .filter(x => x.length >= 24);
    for (const fragment of sentencePool) {
      if (slide.bullets.length >= 5) break;
      if (!slide.bullets.some(b => b.toLowerCase() === fragment.toLowerCase())) {
        slide.bullets.push(fragment.slice(0, 250));
      }
    }
    // Last-resort learning prompts prevent empty slides without fabricating facts.
    const safeFallbacks = [
      `Core idea: ${slide.title}${slide.subtitle ? ` — ${slide.subtitle}` : ""}.`,
      `Look for the process, evidence, or example that explains “${slide.title}.”`,
      `Connect this idea to the wider topic: ${request.topic}.`
    ];
    for (const fallback of safeFallbacks) {
      if (slide.bullets.length >= 3) break;
      slide.bullets.push(fallback.slice(0, 250));
    }
    if (!slide.body) slide.body = slide.speaker_notes || `This slide explains ${slide.title.toLowerCase()} and how it connects to ${request.topic}.`;
    if (!slide.takeaway) slide.takeaway = slide.body.split(/(?<=[.!?])\\s+/)[0]?.slice(0, 220) || `Remember the key idea: ${slide.title}.`;
    if (!slide.speaker_notes || slide.speaker_notes.length < 80) {
      slide.speaker_notes = `${slide.title}. ${slide.body} Explain the key terms, give a concrete example, and ask the audience how this idea connects to ${request.topic}.`;
    }
  }
  slides[0].layout = "cover";
  slides[slides.length - 1].layout = "closing";
  return { title: clampText(deck.title || request.topic, 180), subtitle: clampText(deck.subtitle || request.audience, 220), slides };
}
async function draftDeck(request) {
  const historyTemplate = /history template|slidesgo terracotta|ancient world history/i.test(request.visualStyle || "") || /\b(history|historical|ancient|civilization|civilisation|empire|archaeology|archaeological|middle ages|medieval|world war|renaissance|revolution)\b/i.test(request.topic || "");
  const system = `You are an expert educator and presentation art director. Return ONLY valid JSON. Write useful, specific slide content with concrete examples, causes/effects, comparisons, and implications. Do not invent statistics, quotations, or citations. For each normal slide include exactly 4 informative bullets (roughly 10-20 words each), a 30-50 word explanatory paragraph, a takeaway, kicker, specific visual_prompt, image_search_query, needs_image true/false, image_position left/right/full, and speaker_notes of 60-90 words. Never omit bullets or body. Use exact schema field names. Avoid repetition and vague filler. Use varied layouts: chronology, compare/contrast, evidence, map, cause/effect, people, concepts, synthesis. Set needs_image=true when a relevant real visual improves understanding; false for definitions, text-first explanations, quotes, discussion, and conclusions. Alternate image sides; reserve full for maps, scenes, timelines, visual evidence. Layouts: cover, section, content, closing, two-column, quote. ${historyTemplate ? "HISTORY STYLE: Warm parchment/cream, terracotta and dusty rose, paper-like panels, editorial typography, asymmetric layouts, maps/artifacts/period architecture only when relevant. Include geography, society, innovation, everyday life, evidence and legacy as appropriate. Use specific people/places/dates when known; do not invent dates. Avoid modern stock photos for historical subjects." : ""}`;
  const total = Math.min(MAX_SLIDES, Math.max(3, Number(request.slideCount || 8)));
  // Chunk the deck into small calls: one oversized JSON response can exceed the
  // endpoint's 30s limit even when a short health-check prompt returns in <1s.
  // Sequential batches are gentler on endpoint capacity and each has a bounded token budget.
  const batchSize = Math.max(2, Math.min(3, Number(process.env.NVIDIA_DRAFT_BATCH_SIZE || 3)));
  const allSlides = [];
  let deckTitle = request.topic;
  let deckSubtitle = request.audience;
  for (let start = 0; start < total; start += batchSize) {
    const count = Math.min(batchSize, total - start);
    const end = start + count;
    const user = `Create slides ${start + 1}-${end} of ${total} for a presentation about: ${request.topic}\nAudience: ${request.audience}\nTone: ${request.tone}\nVisual style: ${request.visualStyle}\nAdditional instructions: ${request.instructions || "None"}\nMake this batch fit into a coherent deck: slide 1 is the opening if included; the final slide is a conclusion if included. Give this batch a logical progression and avoid repeating concepts from earlier slides. Return JSON only: {"title":"...","subtitle":"...","slides":[{"title":"...","subtitle":"...","bullets":["..."],"body":"...","takeaway":"...","kicker":"...","visual_prompt":"...","image_search_query":"...","needs_image":true,"image_position":"left|right|full","speaker_notes":"...","layout":"cover|section|content|closing|two-column|quote"}]}`;
    const tokenBudget = Math.min(2400, Math.max(1100, count * 720));
    let parsed;
    let lastParseError;
    // Retry malformed model JSON once with a stricter instruction. This handles
    // occasional missing commas, trailing commas, or schema drift without failing the deck.
    for (let parseAttempt = 0; parseAttempt < 2; parseAttempt++) {
      const raw = await chatCompletion({
        model: TEXT_MODEL,
        messages: [
          { role: "system", content: system + (parseAttempt ? " IMPORTANT: Output strict RFC-compliant JSON only. Escape all quotes inside strings. Do not add trailing commas, markdown, or commentary." : "") },
          { role: "user", content: user + (parseAttempt ? "\nYour previous response was invalid JSON. Return a corrected, complete JSON object with the same schema and exactly " + count + " slides. Keep each bullet concise so the response fits." : "") }
        ],
        temperature: parseAttempt ? 0.1 : 0.2,
        max_tokens: tokenBudget
      });
      try { parsed = extractJson(raw); lastParseError = null; break; }
      catch (err) { lastParseError = err; }
    }
    if (!parsed) throw new Error(`Could not parse slide batch ${start + 1}-${end} after one retry: ${lastParseError?.message || "invalid JSON"}`);
    if (!Array.isArray(parsed.slides) || parsed.slides.length === 0) {
      throw new Error(`NVIDIA returned no slides for batch ${start + 1}-${end}. Try fewer slides and retry.`);
    }
    if (start === 0) {
      deckTitle = parsed.title || deckTitle;
      deckSubtitle = parsed.subtitle || deckSubtitle;
    }
    allSlides.push(...parsed.slides.slice(0, count));
  }
  if (allSlides.length < 3) throw new Error("The content model returned fewer than 3 slides. Try again.");
  return normalizeDeck({ title: deckTitle, subtitle: deckSubtitle, slides: allSlides.slice(0, total) }, request);
}
async function reviewDeck(deck, request) {
  if (!ENABLE_REVIEW) return deck;
  try {
    const raw = await chatCompletion({
      model: REVIEW_MODEL,
      messages: [
        {role:"system",content:"Review slide decks for substance, clarity, factual caution, repetition, spelling, and useful presenter notes. Return ONLY valid JSON matching the exact schema provided. Preserve slide count and visual_prompt fields. Ensure ordinary slides have 3-5 specific bullets, body context, and a practical takeaway. Do not add unsupported precise claims."},
        {role:"user",content:`Review this presentation for ${request.audience}. Keep exactly ${deck.slides.length} slides and preserve the structure. Improve useful slide text and substantial presenter notes. Fill missing takeaway/kicker fields where helpful. Do not change visual_prompt. JSON:\n${JSON.stringify(deck)}`}
      ],
      temperature:0.2, max_tokens:4500
    });
    const revised = normalizeDeck(extractJson(raw), request);
    if (revised.slides.length === deck.slides.length) {
      revised.slides = revised.slides.map((s,i) => ({...s, visual_prompt: deck.slides[i].visual_prompt}));
      return revised;
    }
  } catch (err) {
    // Model catalog IDs can be retired. If the reviewer returns HTTP 410,
    // retry the review with the configured content model instead of silently skipping.
    if (err?.status === 410 && REVIEW_MODEL !== TEXT_MODEL) {
      try {
        console.warn(`Review model ${REVIEW_MODEL} is retired (HTTP 410); retrying review with ${TEXT_MODEL}.`);
        const raw = await chatCompletion({
          model: TEXT_MODEL,
          messages: [
            {role:"system",content:"Review slide decks for substance, clarity, factual caution, repetition, spelling, and useful presenter notes. Return ONLY valid JSON matching the exact schema provided. Preserve slide count and visual_prompt fields. Ensure ordinary slides have 3-5 specific bullets, body context, and a practical takeaway. Do not add unsupported precise claims."},
            {role:"user",content:`Review this presentation for ${request.audience}. Keep exactly ${deck.slides.length} slides and preserve the structure. Improve useful slide text and substantial presenter notes. Fill missing takeaway/kicker fields where helpful. Do not change visual_prompt. JSON:\n${JSON.stringify(deck)}`}
          ],
          temperature:0.2, max_tokens:4500
        });
        const revised = normalizeDeck(extractJson(raw), request);
        if (revised.slides.length === deck.slides.length) {
          revised.slides = revised.slides.map((s,i) => ({...s, visual_prompt: deck.slides[i].visual_prompt}));
          return revised;
        }
      } catch (fallbackErr) {
        console.warn("Fallback review skipped:", fallbackErr.message);
      }
    } else {
      console.warn("Review pass skipped:", err.message);
    }
  }
  return deck;
}
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length); let next = 0;
  async function run() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, run));
  return results;
}
function safeFile(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0,50) || "presentation"; }
async function saveImages(jobId, deck, request, engineId, onProgress) {
  return mapLimit(deck.slides, MAX_IMAGE_CONCURRENCY, async (slide, i) => {
    if (!slide.needs_image && i !== 0) { onProgress?.(i+1); return { path:null, skipped:true, mime:null }; }
    const assetId = crypto.randomUUID();
    const filename = `${jobId}-slide-${String(i+1).padStart(2,"0")}-${assetId.slice(0,8)}.png`;
    const filepath = path.join(IMAGE_DIR, filename);
    const query = `${slide.title} ${slide.subtitle || ""} ${request.topic}`
      .replace(/\\b(photo|photograph|image|visual|illustration|high resolution|no text|no watermark)\\b/gi, "")
      .replace(/\\s+/g, " ").trim().slice(0, 240);
    const prompt = `Image query: ${query}. Visual direction: ${slide.visual_prompt}. Presentation: ${deck.title}.`;
    try {
      if (IMAGE_PROVIDER !== "google_pse" && IMAGE_PROVIDER !== "google") {
        throw new Error(`Unsupported IMAGE_PROVIDER '${IMAGE_PROVIDER}'. Set IMAGE_PROVIDER=google_pse.`);
      }
      const result = await searchAndSelectImage({ query, slideTitle: slide.title, engineId });
      const ext = result.mime.includes("jpeg") || result.mime.includes("jpg") ? ".jpg" : ".png";
      const finalPath = filepath.replace(/\.png$/, ext);
      await fs.writeFile(finalPath, result.buffer);
      addAsset({job_id:jobId, slide_number:i+1, prompt, image_path:finalPath, model:result.model, source_url:result.sourceUrl, source_title:result.sourceTitle, source_page_url:result.sourcePageUrl, status:"complete", error:null});
      onProgress?.(i+1);
      return { path: finalPath, mime: result.mime, sourceUrl: result.sourceUrl, sourceTitle: result.sourceTitle, sourcePageUrl: result.sourcePageUrl };
    } catch (err) {
      addAsset({job_id:jobId, slide_number:i+1, prompt, image_path:null, model:"Google Programmable Search + NVIDIA visual selection", source_url:null, source_title:null, source_page_url:null, status:"failed", error:err.message.slice(0,1000)});
      onProgress?.(i+1);
      // Text-and-shapes fallback ensures the PPTX can still be delivered.
      return { path:null, mime:null, error:err.message };
    }
  });
}
function addText(slide, text, opts) {
  if (text) slide.addText(text, {fontFace:"Aptos", color:"172033", margin:0, breakLine:false, ...opts});
}
function addNotes(slide, notes) {
  if (notes) {
    try { slide.addNotes(notes); } catch (e) { console.warn("Speaker notes unsupported by current pptxgenjs version", e.message); }
  }
}
async function buildPptx(jobId, deck, request, imageResults) {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "AI Presentation Studio";
  pptx.subject = request.topic;
  pptx.title = deck.title;
  pptx.company = "AI Presentation Studio";
  pptx.lang = "en-US";
  const historyTemplate = /history template|slidesgo terracotta|ancient world history/i.test(request.visualStyle || "") || /\b(history|historical|ancient|civilization|civilisation|empire|archaeology|archaeological|middle ages|medieval|world war|renaissance|revolution)\b/i.test(request.topic || "");
  pptx.theme = historyTemplate ? { headFontFace:"Arial", bodyFontFace:"Arial", lang:"en-US" } : { headFontFace:"Aptos Display", bodyFontFace:"Aptos", lang:"en-US" };
  const W = 13.333, H = 7.5;
  const dark = /dark|futur|neon|cinematic/i.test(request.visualStyle || "") && !historyTemplate;
  const palette = historyTemplate
    ? {bg:"FFF8F3", panel:"FFFFFF", ink:"722B1B", muted:"A75441", accent:"A75441", accent2:"E29887", line:"FDDECB", soft:"F5C7BB"}
    : dark
      ? {bg:"0B1020", panel:"151D32", ink:"F5F7FF", muted:"A9B4CF", accent:"8B8CFF", accent2:"59DDD4", line:"303A58", soft:"1C2741"}
      : {bg:"F5F7FB", panel:"FFFFFF", ink:"14213A", muted:"64748B", accent:"4F46E5", accent2:"0F9EAD", line:"DCE3EF", soft:"E9EEFF"};
  const addText = (slide, text, opts={}) => {
    if (!text) return;
    slide.addText(text, {fontFace:historyTemplate ? "Arial" : "Aptos", color:palette.ink, margin:0, breakLine:false, valign:"mid", ...opts});
  };
  const shape = (slide, type, opts) => slide.addShape(type, opts);
  const addImageCover = (slide, img, x, y, w, h) => {
    if (!img?.path) return false;
    try {
      // Use PptxGenJS's crop helper (static on supported versions) so source
      // photos retain their aspect ratio instead of being stretched into frames.
      const placement = pptxgenSizing(pptx, img.path, x, y, w, h);
      slide.addImage({path:img.path, ...placement});
      // Fine, quiet keyline makes photos feel intentionally placed in the grid.
      slide.addShape(pptx.ShapeType.rect, {x, y, w, h, fill:{color:palette.bg, transparency:100}, line:{color:palette.line, transparency:12, width:0.8}});
      return true;
    } catch (e) {
      console.warn("Image placement failed; continuing with designed fallback:", e.message);
      return false;
    }
  };
  function pptxgenSizing(pptxInstance, imagePath, x, y, w, h) {
    try {
      if (typeof PptxGenJS.imageSizingCrop === "function") return PptxGenJS.imageSizingCrop(imagePath,x,y,w,h);
      if (typeof pptxInstance.imageSizingCrop === "function") return pptxInstance.imageSizingCrop(imagePath,x,y,w,h);
      // Last-resort contain mode preserves image proportions; it may leave a
      // small margin, but never distorts the subject as a stretched rectangle does.
      if (typeof PptxGenJS.imageSizingContain === "function") return PptxGenJS.imageSizingContain(imagePath,x,y,w,h);
      if (typeof pptxInstance.imageSizingContain === "function") return pptxInstance.imageSizingContain(imagePath,x,y,w,h);
      return {x,y,w,h};
    } catch { return {x,y,w,h}; }
  }
  pptx.defineSlideMaster({
    title:"LIGHT_MASTER",
    background:{color:palette.bg},
    objects:[
      {line:{x:0.55,y:7.06,w:12.22,h:0,line:{color:palette.line,width:0.7}}},
      {text:{text:deck.title,x:0.58,y:7.13,w:8.8,h:0.16,fontFace:historyTemplate ? "Arial" : "Aptos",fontSize:7,color:palette.muted,margin:0}},
      {text:{text:"AI PRESENTATION STUDIO",x:10.15,y:7.13,w:2.6,h:0.16,fontFace:historyTemplate ? "Arial" : "Aptos",fontSize:7,color:palette.muted,align:"right",margin:0}}
    ],
    slideNumber:{x:12.75,y:7.1,color:palette.muted,fontFace:"Aptos",fontSize:8}
  });
  const total = deck.slides.length;
  for (let i=0;i<total;i++) {
    const s = deck.slides[i], img = imageResults[i], isCover = i===0, isClosing = i===total-1;
    const slide = pptx.addSlide("LIGHT_MASTER");
    slide.background = {color:palette.bg};
    const kicker = (s.kicker || (isCover ? "PRESENTATION BRIEF" : isClosing ? "WHAT TO DO NEXT" : `INSIGHT ${String(i).padStart(2,"0")}`)).toUpperCase();
    if (isCover) {
      shape(slide,pptx.ShapeType.rect,{x:0,y:0,w:W,h:H,fill:{color:palette.bg},line:{color:palette.bg}});
      shape(slide,pptx.ShapeType.rect,{x:0,y:0,w:0.16,h:H,fill:{color:palette.accent},line:{color:palette.accent}});
      // Image panel occupies the right half; text remains in a stable left column.
      if (img?.path) {
        addImageCover(slide,img,7.05,0,6.283,H);
        shape(slide,pptx.ShapeType.rect,{x:6.55,y:0,w:1.15,h:H,fill:{color:palette.bg,transparency:14},line:{color:palette.bg,transparency:100}});
      } else {
        shape(slide,pptx.ShapeType.rect,{x:7.05,y:0,w:6.283,h:H,fill:{color:palette.soft},line:{color:palette.soft}});
        for(let j=0;j<7;j++) shape(slide,pptx.ShapeType.line,{x:7.2+j*.8,y:0,w:2.5,h:H,line:{color:palette.accent,transparency:78,width:1}});
      }
      addText(slide,kicker,{x:0.78,y:0.82,w:5.8,h:0.25,fontSize:10,bold:true,charSpacing:2,color:palette.accent2});
      addText(slide,deck.title,{x:0.78,y:1.45,w:5.85,h:2.3,fontFace:historyTemplate ? "Arial" : "Aptos Display",fontSize:34,bold:true,breakLine:false,fit:"shrink",valign:"mid"});
      addText(slide,s.subtitle || deck.subtitle,{x:0.8,y:4.0,w:5.55,h:0.9,fontSize:17,color:palette.muted,fit:"shrink",valign:"top"});
      shape(slide,pptx.ShapeType.rect,{x:0.8,y:5.22,w:0.75,h:0.06,fill:{color:palette.accent2},line:{color:palette.accent2}});
      addText(slide,`${request.audience}  ·  ${new Date().toLocaleDateString()}`,{x:0.8,y:5.55,w:5.5,h:0.4,fontSize:10,color:palette.muted});
      addText(slide,"A clear, practical guide",{x:0.8,y:6.65,w:4.8,h:0.3,fontSize:10,bold:true,color:palette.accent});
    } else if (isClosing) {
      shape(slide,pptx.ShapeType.rect,{x:0,y:0,w:W,h:H,fill:{color:palette.bg},line:{color:palette.bg}});
      if (img?.path) addImageCover(slide,img,7.65,0,5.683,H);
      shape(slide,pptx.ShapeType.rect,{x:0,y:0,w:7.95,h:H,fill:{color:palette.bg,transparency:0},line:{color:palette.bg,transparency:100}});
      addText(slide,kicker,{x:0.8,y:0.78,w:5.8,h:0.28,fontSize:10,bold:true,charSpacing:2,color:palette.accent2});
      addText(slide,s.title,{x:0.8,y:1.38,w:6.3,h:1.2,fontFace:historyTemplate ? "Arial" : "Aptos Display",fontSize:30,bold:true,fit:"shrink"});
      if (s.subtitle) addText(slide,s.subtitle,{x:0.82,y:2.65,w:6.1,h:0.55,fontSize:15,color:palette.muted,fit:"shrink"});
      if (s.bullets?.length) {
        s.bullets.slice(0,4).forEach((b,j)=>{
          const yy=3.35+j*.62;
          shape(slide,pptx.ShapeType.ellipse,{x:0.84,y:yy+0.05,w:0.18,h:0.18,fill:{color:palette.accent2},line:{color:palette.accent2}});
          addText(slide,b,{x:1.18,y:yy,w:5.85,h:0.45,fontSize:13,bold:j===0,color:palette.ink,fit:"shrink",valign:"top"});
        });
      }
      if(s.takeaway){
        shape(slide,pptx.ShapeType.roundRect,{x:0.8,y:6.1,w:6.25,h:0.62,rectRadius:0.08,fill:{color:palette.soft},line:{color:palette.line,width:0.8}});
        addText(slide,s.takeaway,{x:1.02,y:6.22,w:5.85,h:0.36,fontSize:11,bold:true,color:palette.accent2,fit:"shrink"});
      }
    } else if (historyTemplate) {
      // Warm editorial history layout: parchment canvas, terracotta rules, paper cards,
      // asymmetrical image/text compositions, and contextual imagery only when needed.
      const useImage = Boolean(img?.path) && s.needs_image !== false;
      const isSection = s.layout === "section" || /^(chapter|unit|era|period|part)\b|civilization|civilisation|dynasty|empire|middle ages|renaissance/i.test(`${s.kicker} ${s.title}`) && i % 3 === 1;
      addText(slide,kicker,{x:0.72,y:0.34,w:7.6,h:0.22,fontSize:9,bold:true,charSpacing:1.8,color:palette.accent});
      addText(slide,String(i+1).padStart(2,"0"),{x:11.9,y:0.32,w:0.72,h:0.3,fontSize:11,bold:true,color:palette.accent,align:"right"});
      if (isSection) {
        shape(slide,pptx.ShapeType.rect,{x:0.72,y:1.25,w:0.12,h:4.95,fill:{color:palette.accent},line:{color:palette.accent}});
        addText(slide,s.title,{x:1.08,y:1.42,w:useImage?6.15:10.9,h:1.55,fontFace:"Arial",fontSize:34,bold:true,fit:"shrink",valign:"mid"});
        if(s.subtitle) addText(slide,s.subtitle,{x:1.1,y:3.12,w:useImage?5.9:9.8,h:0.72,fontSize:17,color:palette.muted,fit:"shrink",valign:"top"});
        if(s.body) addText(slide,s.body,{x:1.1,y:4.05,w:useImage?5.9:9.8,h:1.15,fontSize:14,color:palette.ink,fit:"shrink",valign:"top"});
        if(useImage) addImageCover(slide,img,7.45,1.48,4.85,4.25);
        if(s.takeaway) addText(slide,s.takeaway,{x:1.1,y:5.65,w:useImage?5.9:10.8,h:0.48,fontSize:11,bold:true,color:palette.accent,fit:"shrink"});
      } else {
        addText(slide,s.title,{x:0.72,y:0.72,w:11.8,h:0.62,fontFace:"Arial",fontSize:25,bold:true,fit:"shrink",valign:"mid"});
        if(s.subtitle) addText(slide,s.subtitle,{x:0.74,y:1.39,w:11.7,h:0.34,fontSize:11,color:palette.muted,fit:"shrink",valign:"top"});
        const bullets=(s.bullets||[]).slice(0,6);
        if(useImage) {
          const imgLeft = s.image_position === "left" || (s.image_position !== "right" && i % 2 === 0);
          const imageX = imgLeft ? 0.72 : 8.35;
          const textX = imgLeft ? 5.62 : 0.76;
          const textW = imgLeft ? 6.9 : 7.2;
          addImageCover(slide,img,imageX,1.95,imgLeft?4.55:3.95,3.55);
          const shown=bullets.slice(0,5), rowH=Math.min(0.72,3.5/Math.max(1,shown.length));
          shown.forEach((b,j)=>{
            const yy=1.98+j*rowH;
            addText(slide,String(j+1).padStart(2,"0"),{x:textX,y:yy+0.02,w:0.36,h:0.22,fontSize:9,bold:true,color:palette.accent2});
            addText(slide,b,{x:textX+0.42,y:yy,w:textW-0.45,h:rowH-0.06,fontSize:11.5,color:palette.ink,fit:"shrink",valign:"top"});
          });
          if(s.body) {
            shape(slide,pptx.ShapeType.roundRect,{x:0.74,y:5.72,w:11.82,h:0.63,rectRadius:0.06,fill:{color:palette.panel},line:{color:palette.line,width:0.7}});
            addText(slide,s.body,{x:0.94,y:5.81,w:11.42,h:0.44,fontSize:9.5,color:palette.muted,fit:"shrink",valign:"mid"});
          }
        } else {
          const cols=bullets.length>=4?2:1, rows=Math.ceil(bullets.length/cols), gapX=0.2, gapY=0.14;
          const cardW=(11.82-gapX*(cols-1))/cols, cardH=Math.min(1.02,3.45/Math.max(1,rows));
          bullets.forEach((b,j)=>{
            const col=Math.floor(j/rows), row=j%rows, x=0.74+col*(cardW+gapX), y=1.95+row*(cardH+gapY);
            shape(slide,pptx.ShapeType.roundRect,{x,y,w:cardW,h:cardH,rectRadius:0.06,fill:{color:palette.panel},line:{color:palette.line,width:0.75}});
            shape(slide,pptx.ShapeType.rect,{x:x+0.16,y:y+0.16,w:0.05,h:0.3,fill:{color:j%2?palette.accent2:palette.accent},line:{color:j%2?palette.accent2:palette.accent}});
            addText(slide,b,{x:x+0.34,y:y+0.12,w:cardW-0.5,h:cardH-0.2,fontSize:11.2,color:palette.ink,fit:"shrink",valign:"mid"});
          });
          const bodyY=Math.min(5.88,1.95+rows*(cardH+gapY)+0.05);
          if(s.body) addText(slide,s.body,{x:0.82,y:bodyY,w:11.6,h:0.52,fontSize:10,color:palette.muted,fit:"shrink",valign:"mid"});
        }
        if(s.takeaway) {
          shape(slide,pptx.ShapeType.rect,{x:0.74,y:6.48,w:0.09,h:0.32,fill:{color:palette.accent2},line:{color:palette.accent2}});
          addText(slide,`REMEMBER  /  ${s.takeaway}`,{x:0.96,y:6.47,w:11.4,h:0.34,fontSize:10,bold:true,color:palette.accent,fit:"shrink"});
        }
      }
    } else {
      // Honor the model's semantic layout when supplied; only use the rotating
      // rhythm as a fallback. This makes image placement purposeful, not random.
      const variant = s.image_position === "full" ? 2 : s.image_position === "left" ? 1 : s.image_position === "right" ? 0 : s.layout === "two-column" ? 1 : s.layout === "section" ? 2 : s.layout === "quote" ? 0 : i % 3;
      const imgLeft = variant === 1;
      const imageFull = variant === 2;
      const useImage = Boolean(img?.path) && s.needs_image !== false;
      // Title band starts high and uses consistent top alignment, avoiding low content.
      addText(slide,kicker,{x:0.68,y:0.36,w:6.8,h:0.22,fontSize:9,bold:true,charSpacing:1.8,color:palette.accent});
      addText(slide,String(i+1).padStart(2,"0"),{x:11.8,y:0.32,w:0.82,h:0.3,fontSize:11,bold:true,color:palette.accent,align:"right"});
      addText(slide,s.title,{x:0.68,y:0.72,w:11.9,h:0.65,fontFace:historyTemplate ? "Arial" : "Aptos Display",fontSize:25,bold:true,fit:"shrink",valign:"mid"});
      if(s.subtitle) addText(slide,s.subtitle,{x:0.7,y:1.43,w:11.9,h:0.34,fontSize:11,color:palette.muted,fit:"shrink",valign:"top"});
      if (useImage && imageFull) {
        // Wide editorial image across the upper-middle, with content in cards below.
        addImageCover(slide,img,0.7,1.98,11.92,2.38);
        if(s.bullets?.length) {
          const n=Math.min(3,s.bullets.length), gap=0.14, cw=(11.92-gap*(n-1))/n;
          for(let j=0;j<n;j++){
            const x=0.7+j*(cw+gap);
            shape(slide,pptx.ShapeType.roundRect,{x,y:4.55,w:cw,h:1.23,rectRadius:0.08,fill:{color:palette.panel},line:{color:palette.line,width:0.8}});
            shape(slide,pptx.ShapeType.rect,{x:x+0.16,y:4.73,w:0.06,h:0.3,fill:{color:j%2?palette.accent2:palette.accent},line:{color:j%2?palette.accent2:palette.accent}});
            addText(slide,s.bullets[j],{x:x+0.34,y:4.67,w:cw-0.48,h:0.88,fontSize:12,bold:true,fit:"shrink",valign:"mid"});
          }
        }
        if(s.takeaway) {
          shape(slide,pptx.ShapeType.roundRect,{x:0.7,y:5.98,w:11.92,h:0.67,rectRadius:0.08,fill:{color:palette.soft},line:{color:palette.line,width:0.7}});
          addText(slide,`TAKEAWAY  ·  ${s.takeaway}`,{x:0.92,y:6.13,w:11.45,h:0.34,fontSize:11,bold:true,color:palette.accent,fit:"shrink"});
        }
      } else if (!useImage) {
        // Text-first slide: use the full canvas for readable content; no forced image placeholder.
        const bullets = (s.bullets || []).slice(0, 5);
        const cols = bullets.length >= 4 ? 2 : 1;
        const rows = Math.ceil(bullets.length / cols);
        const gapX = 0.22, gapY = 0.16, cardW = (11.92 - gapX * (cols - 1)) / cols;
        const cardH = Math.min(1.18, 3.9 / Math.max(1, rows));
        bullets.forEach((b, j) => {
          const col = Math.floor(j / rows), row = j % rows;
          const x = 0.7 + col * (cardW + gapX), y = 2.02 + row * (cardH + gapY);
          shape(slide,pptx.ShapeType.roundRect,{x,y,w:cardW,h:cardH,rectRadius:0.08,fill:{color:palette.panel},line:{color:palette.line,width:0.8}});
          shape(slide,pptx.ShapeType.rect,{x:x+0.16,y:y+0.2,w:0.06,h:0.28,fill:{color:j%2?palette.accent2:palette.accent},line:{color:j%2?palette.accent2:palette.accent}});
          addText(slide,b,{x:x+0.34,y:y+0.16,w:cardW-0.52,h:cardH-0.28,fontSize:13,color:palette.ink,fit:"shrink",valign:"mid"});
        });
        if (s.body) addText(slide,s.body,{x:0.78,y:Math.min(6.05,2.02+rows*(cardH+gapY)+0.08),w:11.7,h:0.48,fontSize:11,color:palette.muted,fit:"shrink",valign:"mid"});
        if(s.takeaway) {
          shape(slide,pptx.ShapeType.roundRect,{x:0.7,y:6.45,w:11.92,h:0.42,rectRadius:0.08,fill:{color:palette.soft},line:{color:palette.line,width:0.7}});
          addText(slide,`TAKEAWAY · ${s.takeaway}`,{x:0.9,y:6.54,w:11.5,h:0.22,fontSize:10,bold:true,color:palette.accent,fit:"shrink"});
        }
      } else {
        const imageX = imgLeft ? 0.7 : 7.28, textX = imgLeft ? 6.95 : 0.72;
        const imageW = 5.35, textW = 5.65;
        if (img?.path) {
          addImageCover(slide,img,imageX,1.98,imageW,3.6);
          shape(slide,pptx.ShapeType.rect,{x:imageX,y:5.3,w:imageW,h:0.28,fill:{color:palette.bg,transparency:20},line:{color:palette.bg,transparency:100}});
        } else {
          shape(slide,pptx.ShapeType.roundRect,{x:imageX,y:1.98,w:imageW,h:3.6,rectRadius:0.08,fill:{color:palette.soft},line:{color:palette.line,width:0.8}});
          addText(slide,"VISUAL CONCEPT",{x:imageX+0.25,y:3.45,w:imageW-0.5,h:0.35,fontSize:10,bold:true,color:palette.muted,align:"center"});
          // Decorative fallback is deliberate; never print an ugly IMAGE UNAVAILABLE placeholder.
          for(let j=0;j<4;j++) shape(slide,pptx.ShapeType.line,{x:imageX+0.3+j*1.2,y:2.25,w:0.7,h:2.8,line:{color:palette.accent,transparency:72,width:1.2}});
        }
        if(s.bullets?.length) {
          const maxBullets=Math.min(5,s.bullets.length);
          const rowH=Math.min(0.72,3.25/maxBullets);
          for(let j=0;j<maxBullets;j++){
            const yy=2.0+j*rowH;
            shape(slide,pptx.ShapeType.ellipse,{x:textX,y:yy+0.07,w:0.14,h:0.14,fill:{color:j%2?palette.accent2:palette.accent},line:{color:j%2?palette.accent2:palette.accent}});
            addText(slide,s.bullets[j],{x:textX+0.28,y:yy,w:textW-0.3,h:rowH-0.05,fontSize:12.2,color:palette.ink,fit:"shrink",valign:"top"});
          }
        }
        if(s.body) {
          shape(slide,pptx.ShapeType.roundRect,{x:textX,y:5.45,w:textW,h:0.73,rectRadius:0.07,fill:{color:palette.panel},line:{color:palette.line,width:0.7}});
          addText(slide,s.body,{x:textX+0.16,y:5.55,w:textW-0.32,h:0.53,fontSize:9.5,color:palette.muted,fit:"shrink",valign:"mid"});
        }
        if(s.takeaway) {
          addText(slide,`KEY TAKEAWAY`,{x:0.72,y:6.38,w:1.4,h:0.18,fontSize:8,bold:true,charSpacing:1.1,color:palette.accent2});
          addText(slide,s.takeaway,{x:2.0,y:6.31,w:10.4,h:0.34,fontSize:10.5,bold:true,color:palette.ink,fit:"shrink"});
        }
      }
    }
    addNotes(slide, s.speaker_notes);
  }
  const out = path.join(PPTX_DIR, `${safeFile(deck.title)}-${jobId.slice(0,8)}.pptx`);
  await pptx.writeFile({fileName:out});
  return out;
}
export async function runGeneration(job, request) {
  const id = job.id;
  try {
    updateJob(id,{status:"running",stage:"drafting",progress:5});
    let deck = await draftDeck(request);
    updateJob(id,{stage:"reviewing",progress:15});
    deck = await reviewDeck(deck, request);
    updateJob(id,{stage:"generating_images",progress:20});
    const engineId = reserveEngineForPresentation();
    console.log(`[PPT ${id}] Using Google PSE engine for this presentation: ${engineId || "default/fallback"}`);
    let finished = 0;
    const images = await saveImages(id, deck, request, engineId, () => {
      finished++;
      updateJob(id,{stage:"generating_images",progress:20+Math.round(55*finished/deck.slides.length)});
    });
    updateJob(id,{stage:"building_powerpoint",progress:82});
    const pptxPath = await buildPptx(id, deck, request, images);
    updateJob(id,{status:"complete",stage:"complete",progress:100,pptx_path:pptxPath});
  } catch (err) {
    console.error("Generation failed", id, err);
    updateJob(id,{status:"failed",stage:"failed",error:err.message || "Generation failed"});
  }
}
export const generationLimits = { MAX_SLIDES };
