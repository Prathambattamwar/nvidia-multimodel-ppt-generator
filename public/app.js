const $ = id => document.getElementById(id);
let currentJob = null, pollTimer = null;
const stageLabels = {
  queued: "Waiting to start",
  drafting: "Writing your slides",
  reviewing: "Refining the content",
  generating_images: "Finding relevant visuals",
  building_powerpoint: "Building your PowerPoint",
  complete: "Your presentation is ready",
  failed: "We couldn't finish this presentation"
};
const stageOrder = ["drafting", "reviewing", "generating_images", "building_powerpoint", "complete"];
const pretty = s => stageLabels[s] || "Preparing your presentation";
async function api(url, options={}) {
  const res = await fetch(url, {headers:{"Content-Type":"application/json",...(options.headers||{})},...options});
  const body = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(body.error || "Something went wrong. Please try again.");
  return body;
}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function showActive(){ $("activeJob").classList.remove("hidden"); $("activeJob").scrollIntoView({behavior:"smooth",block:"nearest"}); }
function renderSteps(stage, status) {
  const current = stageOrder.indexOf(stage);
  document.querySelectorAll("#stepList li").forEach((li, index) => {
    li.classList.toggle("step-done", status === "complete" || (current >= 0 && index < current));
    li.classList.toggle("step-current", status !== "complete" && status !== "failed" && stage === li.dataset.stage);
    li.classList.toggle("step-error", status === "failed" && index === Math.max(0,current));
  });
}
async function watchJob(id){
  currentJob=id; showActive();
  if(pollTimer) clearInterval(pollTimer);
  await refreshJob();
  pollTimer=setInterval(refreshJob,2000);
}
async function refreshJob(){
  if(!currentJob)return;
  try{
    const j=await api(`/api/jobs/${currentJob}`);
    $("jobTitle").textContent=j.topic;
    $("jobStage").textContent=j.status === "failed" ? "Something went wrong while creating your presentation. Please try again or choose fewer slides." : pretty(j.stage);
    $("progressValue").textContent=`${j.progress}%`;
    $("progressBar").style.width=`${j.progress}%`;
    renderSteps(j.stage, j.status);
    $("jobError").classList.toggle("hidden",j.status !== "failed");
    $("jobError").textContent=j.status === "failed" ? (j.userError || "We couldn't finish this presentation. Please try again with fewer slides.") : "";
    const d=$("downloadBtn");
    d.classList.toggle("hidden",!j.downloadUrl);
    if(j.downloadUrl)d.href=j.downloadUrl;
    if(["complete","failed"].includes(j.status)){clearInterval(pollTimer);pollTimer=null;}
  }catch(e){$("jobStage").textContent="Can't refresh progress right now. Retrying…";}
}
$("genForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const btn=$("submitBtn");btn.disabled=true;btn.querySelector("span:first-child").textContent="Starting…";
  try{
    const data=Object.fromEntries(new FormData(e.currentTarget).entries());
    data.slideCount=Number(data.slideCount);
    const out=await api("/api/generate",{method:"POST",body:JSON.stringify(data)});
    await watchJob(out.id);
  }catch(err){
    const box=$("jobError");showActive();box.classList.remove("hidden");box.textContent=err.message || "Unable to start. Please try again.";
  }
  finally{btn.disabled=false;btn.querySelector("span:first-child").textContent="Generate PowerPoint";}
});

