import express from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { createJob, getJob, listJobs } from "./db.js";
import { runGeneration, generationLimits } from "./generator.js";
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const maxPrompt = Math.max(1000, Number(process.env.MAX_PROMPT_LENGTH || 12000));
app.disable("x-powered-by");
app.use(express.json({limit:"1mb"}));
app.use("/api/", rateLimit({windowMs:60_000, limit:30, standardHeaders:true, legacyHeaders:false, message:{error:"Too many requests. Wait a minute and try again."}}));
app.use(express.static(path.join(root,"public"), {maxAge:"1h"}));

const schema = z.object({
  topic: z.string().trim().min(3).max(240),
  slideCount: z.coerce.number().int().min(3).max(generationLimits.MAX_SLIDES).default(8),
  audience: z.string().trim().min(2).max(180).default("General professional audience"),
  tone: z.string().trim().min(2).max(100).default("Clear, insightful, professional"),
  visualStyle: z.string().trim().min(2).max(160).default("Premium editorial, cinematic, clean"),
  instructions: z.string().trim().max(maxPrompt).optional().default("")
});
const active = new Set();
const maxConcurrent = Math.max(1, Number(process.env.MAX_CONCURRENT_GENERATIONS || 2));
const queue = [];
function pump() {
  while (active.size < maxConcurrent && queue.length) {
    const item = queue.shift();
    active.add(item.id);
    runGeneration(item, item.request)
      .catch(err => console.error("Worker error",err))
      .finally(() => { active.delete(item.id); pump(); });
  }
}
app.get("/api/health", (_req,res) => res.json({
  ok:true, app:"AI Presentation Studio",
  configured: Boolean(process.env.NVIDIA_API_KEY),
  queueLength: queue.length, activeJobs: active.size, maxConcurrent
}));
app.post("/api/generate", (req,res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({error:"Please check the form fields.",details:parsed.error.issues.map(x=>({field:x.path.join("."),message:x.message}))});
  if (!process.env.NVIDIA_API_KEY) return res.status(503).json({error:"Presentation service setup is incomplete. Please contact the administrator."});
  const request = parsed.data;
  const id = crypto.randomUUID();
  const job = {id, topic:request.topic, request_json:JSON.stringify(request)};
  createJob(job);
  const item = {id, topic:request.topic, request};
  queue.push(item);
  pump();
  res.status(202).json({id,status:"queued",message:"Presentation queued. You can monitor progress."});
});
app.get("/api/jobs", (_req,res) => res.json({jobs:listJobs(30).map(j=>({...j,error:undefined,userError:j.status === "failed" ? "We could not finish this presentation. Please try again or choose fewer slides." : undefined}))}));
app.get("/api/jobs/:id", (req,res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({error:"Job not found."});
  const output = {...job};
  output.error = undefined;
  output.userError = job.status === "failed" ? "We could not finish this presentation. Please try again or choose fewer slides." : undefined;
  if (output.pptx_path) output.downloadUrl = `/api/jobs/${job.id}/download`;
  output.assets = output.assets.map(a => ({...a, imageUrl:a.image_path ? `/api/jobs/${job.id}/images/${a.slide_number}` : null, image_path:undefined, sourceUrl:a.source_url || null, sourceTitle:a.source_title || null, sourcePageUrl:a.source_page_url || null, source_url:undefined, source_title:undefined, source_page_url:undefined}));
  res.json(output);
});
app.get("/api/jobs/:id/images/:slide", async (req,res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).end();
  const asset = job.assets.find(a=>a.slide_number===Number(req.params.slide));
  if (!asset?.image_path || !fs.existsSync(asset.image_path)) return res.status(404).json({error:"Image not available."});
  res.sendFile(path.resolve(asset.image_path));
});
app.get("/api/jobs/:id/download", (req,res) => {
  const job = getJob(req.params.id);
  if (!job?.pptx_path || !fs.existsSync(job.pptx_path)) return res.status(404).json({error:"PowerPoint is not ready."});
  res.download(path.resolve(job.pptx_path), path.basename(job.pptx_path));
});
app.get("*", (_req,res) => res.sendFile(path.join(root,"public","index.html")));
app.listen(port,host,()=>console.log(`PPT generator listening on http://${host}:${port}`));
