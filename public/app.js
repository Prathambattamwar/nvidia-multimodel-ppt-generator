const $ = id => document.getElementById(id);
let currentJob = null, pollTimer = null;
const pretty = s => String(s||"").replaceAll("_"," ").replace(/\b\w/g,c=>c.toUpperCase());
async function api(url, options={}) {
  const res = await fetch(url, {headers:{"Content-Type":"application/json",...(options.headers||{})},...options});
  const body = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}
async function loadHealth(){
  try {
    const h=await api("/api/health");
    $("apiDot").style.background=h.configured?"#4bd6a3":"#f6bd60";
    $("apiStatus").textContent=h.configured?"NVIDIA API configured":"Add NVIDIA API key";
    $("textModel").textContent=h.models.text;
    $("reviewModel").textContent=h.models.review;
    $("imageModel").textContent=h.models.image + (h.imageSearchConfigured ? ` · ${h.imageSearchMode || "Google image search ready"}` : " · add PSE_CX to .env");
  } catch { $("apiStatus").textContent="Server status unavailable"; }
}
async function loadJobs(){
  try {
    const {jobs}=await api("/api/jobs");
    const el=$("jobsList");
    if(!jobs.length){el.innerHTML='<div class="empty">Your generated decks will appear here.</div>';return;}
    el.innerHTML=jobs.map(j=>`<div class="job-item" data-id="${j.id}"><span class="job-status">${esc(j.status)}</span><b>${esc(j.topic)}</b><small>${esc(pretty(j.stage))} · ${j.progress}%</small></div>`).join("");
    el.querySelectorAll(".job-item").forEach(n=>n.addEventListener("click",()=>watchJob(n.dataset.id)));
  } catch {}
}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function showActive(){ $("activeJob").classList.remove("hidden"); $("activeJob").scrollIntoView({behavior:"smooth",block:"nearest"}); }
async function watchJob(id){
  currentJob=id; showActive();
  if(pollTimer) clearInterval(pollTimer);
  await refreshJob();
  pollTimer=setInterval(refreshJob,2500);
}
async function refreshJob(){
  if(!currentJob)return;
  try{
    const j=await api(`/api/jobs/${currentJob}`);
    $("jobTitle").textContent=j.topic;
    $("jobStage").textContent=j.error?j.error:`${pretty(j.stage)} · ${j.status}`;
    $("progressValue").textContent=`${j.progress}%`;
    $("progressBar").style.width=`${j.progress}%`;
    $("jobError").classList.toggle("hidden",!j.error);
    $("jobError").textContent=j.error||"";
    const assets=(j.assets||[]);
    $("assetGrid").innerHTML=assets.map(a=>a.imageUrl
      ? `<div class="asset-card"><img loading="lazy" src="${a.imageUrl}" alt="Selected visual for slide ${a.slide_number}"><small>Slide ${a.slide_number} · Image selected</small>${a.sourcePageUrl ? `<a href="${esc(a.sourcePageUrl)}" target="_blank" rel="noopener noreferrer">Source: ${esc(a.sourceTitle||"Open image source")}</a>` : ""}</div>`
      : `<div class="asset-card asset-failed"><div class="asset-failure"><b>Slide ${a.slide_number}</b><span>Image failed</span></div><small title="${esc(a.error||"No image returned")}">${esc(a.error||"No image returned")}</small></div>`
    ).join("");
    const failures=assets.filter(a=>a.status==="failed");
    if(failures.length && !j.error) {
      $("jobStage").textContent=`${pretty(j.stage)} · ${failures.length} image(s) failed — expand the slide cards below to see the API error`;
    }
    const d=$("downloadBtn");
    d.classList.toggle("hidden",!j.downloadUrl);
    if(j.downloadUrl)d.href=j.downloadUrl;
    if(["complete","failed"].includes(j.status)){clearInterval(pollTimer);pollTimer=null;loadJobs();}
  }catch(e){$("jobStage").textContent=e.message;}
}
$("genForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const btn=$("submitBtn");btn.disabled=true;btn.querySelector("span:first-child").textContent="Queuing generation…";
  try{
    const data=Object.fromEntries(new FormData(e.currentTarget).entries());
    data.slideCount=Number(data.slideCount);
    const out=await api("/api/generate",{method:"POST",body:JSON.stringify(data)});
    await loadJobs();await watchJob(out.id);
  }catch(err){alert(err.message);}
  finally{btn.disabled=false;btn.querySelector("span:first-child").textContent="Generate PowerPoint";}
});
$("refreshBtn").addEventListener("click",loadJobs);
loadHealth();loadJobs();setInterval(loadHealth,30000);
