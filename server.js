require("dotenv").config();
const express = require("express");
const multer = require("multer");
const { Anthropic } = require("@anthropic-ai/sdk");
const { Resend } = require("resend");
const { nanoid } = require("nanoid");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

const store = new Map();

// ─── Parse CV ───────────────────────────────────────────────────────────────
async function parseFile(buffer, filename) {
  const name = filename.toLowerCase();
  if (name.endsWith(".pdf")) {
    const pdfParse = require("pdf-parse");
    return (await pdfParse(buffer)).text;
  }
  if (name.endsWith(".docx")) {
    const mammoth = require("mammoth");
    return (await mammoth.extractRawText({ buffer })).value;
  }
  if (name.endsWith(".txt")) return buffer.toString("utf-8");
  throw new Error("Formato no soportado. Usa PDF, DOCX o TXT.");
}

// ─── Analyze with Claude ────────────────────────────────────────────────────
async function analyze(jobText, cvText) {
  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2000,
    system: `Eres Miss Pao, reclutadora ATS experta en empleo remoto para latinoamericanos. Analiza la compatibilidad entre un CV y una oferta laboral. Responde SOLO con JSON válido, sin markdown ni texto extra.`,
    messages: [{
      role: "user",
      content: `OFERTA:\n${jobText.slice(0, 3000)}\n\nCV:\n${cvText.slice(0, 3000)}\n\nResponde con este JSON exacto:
{
  "compatibilityScore": 0-100,
  "atsScore": 0-100,
  "experienceLevel": "Junior|Mid|Senior",
  "recruiterMessage": "mensaje personal de 2-3 oraciones",
  "matchedKeywords": ["keyword1","keyword2"],
  "missingKeywords": ["keyword1","keyword2"],
  "strengths": ["fortaleza1","fortaleza2","fortaleza3"],
  "findings": [{"severity":"alta|media|baja","title":"título","suggestion":"sugerencia","example":"ejemplo opcional"}],
  "suggestedRoles": [{"title":"rol","matchPct":0-100,"reason":"razón"}],
  "improvementPlan": ["paso1","paso2","paso3","paso4","paso5"],
  "jobTitle": "título del cargo extraído de la oferta"
}`
    }]
  });
  let text = msg.content[0].text.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(text);
}

// ─── Generate Questions ─────────────────────────────────────────────────────
async function generateQuestions(jobText, cvText) {
  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1500,
    system: `Eres Miss Pao, reclutadora experta en empleo remoto latinoamericano. Genera preguntas específicas para evaluar al candidato para ESA vacante concreta. Responde SOLO con JSON válido sin markdown.`,
    messages: [{
      role: "user",
      content: `OFERTA:\n${jobText.slice(0, 2500)}\n\nCV:\n${cvText.slice(0, 2000)}\n\nGenera preguntas de evaluación. Sé específica con las herramientas, sectores y habilidades mencionadas en la oferta:\n{\n  "skillQuestions": [\n    {"id": "q1", "question": "pregunta sobre habilidad específica de la oferta", "hint": "qué evalúa esta pregunta"},\n    {"id": "q2", "question": "...", "hint": "..."},\n    {"id": "q3", "question": "...", "hint": "..."},\n    {"id": "q4", "question": "...", "hint": "..."},\n    {"id": "q5", "question": "...", "hint": "..."}\n  ],\n  "screeningQuestions": [\n    {"id": "s1", "question": "pregunta de filtro sobre requisito clave", "type": "yesno"},\n    {"id": "s2", "question": "...", "type": "text"},\n    {"id": "s3", "question": "...", "type": "yesno"}\n  ]\n}`
    }]
  });
  let text = msg.content[0].text.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(text);
}

// ─── Generate Adapted Content ───────────────────────────────────────────────
async function generateAdaptedContent(jobText, cvText, answers) {
  const answersText = answers.map((a, i) => `Pregunta ${i+1}: ${a.question}\nRespuesta: ${a.answer}`).join('\n\n');

  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4000,
    system: `Eres Miss Pao, reclutadora ATS experta en empleo remoto latinoamericano. Adaptas CVs y redactas cartas de presentación efectivas. Responde SOLO con JSON válido sin markdown ni texto extra.

FORMATO DE CARTA DE PRESENTACIÓN:
- Inicio: "Hola [nombre empresa o reclutador],"
- Párrafo 1: credibilidad de la persona + interés genuino en el cargo (mencionar algo específico de la empresa). Incluir 2-3 preguntas concretas sobre el rol, por ejemplo: "¿qué herramientas utilizan para gestionar sus proyectos?"
- Párrafo 2: CTA — invitar a revisar portafolio/trabajo relevante + proponer una conversación breve
- Cierre con nombre
- Español neutro latinoamericano, primera persona, tono profesional pero cercano
- MÁXIMO 350 palabras
- PROHIBIDO usar clichés como "soy proactiva", "orientada a resultados", "apasionada", "trabajo en equipo"`,
    messages: [{
      role: "user",
      content: `OFERTA:\n${jobText.slice(0, 2500)}\n\nCV ORIGINAL:\n${cvText.slice(0, 2500)}\n\nRESPUESTAS DEL CANDIDATO:\n${answersText}\n\nGenera JSON con este formato exacto:\n{\n  "adaptedCV": {\n    "name": "nombre completo del candidato",\n    "contact": "email | teléfono | LinkedIn | ciudad, país",\n    "summary": "resumen profesional adaptado a esta vacante específica (3-4 oraciones con keywords de la oferta)",\n    "experience": [\n      {"title": "cargo", "company": "empresa", "period": "mes año – mes año", "achievements": ["logro cuantificado 1", "logro cuantificado 2", "logro 3"]}\n    ],\n    "education": [\n      {"degree": "título", "institution": "institución", "year": "año"}\n    ],\n    "skills": ["habilidad relevante 1", "habilidad relevante 2"],\n    "languages": ["Español nativo", "Inglés B2"]\n  },\n  "coverLetter": "carta de presentación completa siguiendo el formato indicado (texto plano, párrafos separados por \\n\\n)",\n  "interviewTips": ["consejo específico 1", "consejo 2", "consejo 3", "consejo 4", "consejo 5"],\n  "applicationEmail": "email@empresa.com extraído de la oferta, o null si no hay",\n  "improvements": ["Mejora: descripción de qué se adaptó y por qué fortalece la postulación 1", "Mejora 2", "Mejora 3"]\n}`
    }]
  });
  let text = msg.content[0].text.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(text);
}

// ─── Render CV HTML ─────────────────────────────────────────────────────────
function renderCVHtml(cv, jobTitle, autoPrint) {
  const exp = (cv.experience || []).map(e =>
    `<div class="exp-item">
      <div class="exp-header"><span class="exp-title">${e.title}</span><span class="exp-period">${e.period || ''}</span></div>
      <div class="exp-company">${e.company || ''}</div>
      <ul class="exp-ach">${(e.achievements || []).map(a => `<li>${a}</li>`).join('')}</ul>
    </div>`
  ).join('');
  const edu = (cv.education || []).map(e =>
    `<div class="edu-item"><span class="edu-deg">${e.degree}</span> · ${e.institution || ''} ${e.year ? '· ' + e.year : ''}</div>`
  ).join('');
  const skills = (cv.skills || []).map(s => `<span class="skill-tag">${s}</span>`).join('');
  const langs = (cv.languages || []).map(l => `<span class="skill-tag lang">${l}</span>`).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>${cv.name || 'CV'} · ${jobTitle || 'CV Adaptado'}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  @page{margin:15mm 20mm}
  body{font-family:'Helvetica Neue',Arial,sans-serif;font-size:11pt;color:#111;line-height:1.5;background:#fff;padding:30px 40px}
  @media print{body{padding:0}}
  .cv-header{border-bottom:2.5px solid #f77e8a;padding-bottom:16px;margin-bottom:20px}
  h1{font-size:26pt;font-weight:700;letter-spacing:-.5px;margin-bottom:4px}
  .contact{font-size:9.5pt;color:#555}
  .badge{display:inline-block;background:#fff5f7;border:1px solid #fce7f3;color:#c0405a;font-size:8.5pt;padding:2px 10px;border-radius:9999px;margin-top:6px}
  h2{font-size:11pt;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#f77e8a;margin:18px 0 8px;border-bottom:1px solid #fce7f3;padding-bottom:4px}
  .summary{font-size:11pt;line-height:1.65;color:#222}
  .exp-item{margin-bottom:14px}
  .exp-header{display:flex;justify-content:space-between;align-items:baseline}
  .exp-title{font-weight:700;font-size:11.5pt}
  .exp-period{font-size:9.5pt;color:#666}
  .exp-company{font-size:10pt;color:#555;margin-bottom:4px}
  .exp-ach{list-style:none;padding:0}
  .exp-ach li{font-size:10.5pt;color:#333;padding-left:14px;position:relative;margin-bottom:2px}
  .exp-ach li:before{content:"▸";position:absolute;left:0;color:#f77e8a;font-size:9pt}
  .edu-item{margin-bottom:6px;font-size:10.5pt}
  .edu-deg{font-weight:600}
  .skills-wrap{display:flex;flex-wrap:wrap;gap:6px}
  .skill-tag{background:#f3f4f6;border-radius:6px;padding:3px 10px;font-size:9.5pt;color:#444}
  .skill-tag.lang{background:#fff5f7;color:#c0405a}
  .print-btn{position:fixed;bottom:24px;right:24px;background:linear-gradient(135deg,#f77e8a,#e85f6e);color:white;border:none;padding:12px 28px;border-radius:9999px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 20px rgba(247,126,138,.4)}
  @media print{.print-btn{display:none}}
</style>
${autoPrint ? '<script>window.addEventListener("load",()=>setTimeout(window.print,600))<\/script>' : ''}
</head>
<body>
<div class="cv-header">
  <h1>${cv.name || ''}</h1>
  <div class="contact">${cv.contact || ''}</div>
  ${jobTitle ? `<span class="badge">✨ Adaptado para: ${jobTitle}</span>` : ''}
</div>
${cv.summary ? `<h2>Perfil Profesional</h2><p class="summary">${cv.summary}</p>` : ''}
${exp ? `<h2>Experiencia</h2>${exp}` : ''}
${edu ? `<h2>Educación</h2>${edu}` : ''}
${skills ? `<h2>Habilidades</h2><div class="skills-wrap">${skills}</div>` : ''}
${langs ? `<h2>Idiomas</h2><div class="skills-wrap">${langs}</div>` : ''}
<button class="print-btn" onclick="window.print()">🖨 Descargar PDF</button>
</body>
</html>`;
}

// ─── Send Email ──────────────────────────────────────────────────────────────
async function sendEmail(to, name, a) {
  const scoreColor = s => s >= 80 ? "#16a34a" : s >= 60 ? "#ca8a04" : "#dc2626";
  await resend.emails.send({
    from: `Bypao · Mypaotipss <${process.env.FROM_EMAIL || "onboarding@resend.dev"}>`,
    to,
    subject: `Tu diagnóstico de CV está listo · ${a.compatibilityScore}/100`,
    html: `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#fff8f8">
<h1 style="color:#f77e8a;font-family:Georgia,serif">Hola ${name} 👋</h1>
<p>Aquí está tu diagnóstico completo de CV:</p>
<div style="background:white;border-radius:16px;padding:20px;border:1px solid #fce7f3;margin:16px 0">
  <div style="display:flex;gap:16px;text-align:center">
    <div style="flex:1"><div style="font-size:36px;font-weight:bold;color:${scoreColor(a.compatibilityScore)}">${a.compatibilityScore}</div><div style="font-size:11px;color:#666">Compatibilidad</div></div>
    <div style="flex:1"><div style="font-size:36px;font-weight:bold;color:${scoreColor(a.atsScore)}">${a.atsScore}%</div><div style="font-size:11px;color:#666">ATS Score</div></div>
  </div>
  <p style="color:#555;font-style:italic;border-left:3px solid #f77e8a;padding-left:12px;margin:16px 0">"${a.recruiterMessage}"</p>
  <h3>🚀 Tu plan de acción completo</h3>
  ${a.improvementPlan.map((s,i) => `<div style="padding:10px;margin:6px 0;background:#fff5f7;border-radius:8px"><strong>${i+1}.</strong> ${s}</div>`).join("")}
</div>
<p style="font-size:13px;color:#999">Con cariño, Bypao · <a href="https://www.mypaotipss.com" style="color:#f77e8a">mypaotipss.com</a></p>
</body></html>`
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────────
app.post("/api/analyze", upload.single("cv"), async (req, res) => {
  try {
    const { job } = req.body;
    if (!job || job.length < 80) return res.status(400).json({ error: "Oferta muy corta" });
    if (!req.file) return res.status(400).json({ error: "Sube tu CV" });

    const cvText = await parseFile(req.file.buffer, req.file.originalname);
    const result = await analyze(job, cvText);

    const id = nanoid(10);
    store.set(id, {
      ...result, id,
      fileName: req.file.originalname,
      jobText: job,
      cvText,
      createdAt: new Date().toISOString(),
      unlocked: false
    });

    if (process.env.SHEETS_WEBHOOK_URL) {
      fetch(process.env.SHEETS_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "analysis", id, compatibilityScore: result.compatibilityScore, atsScore: result.atsScore, createdAt: new Date().toISOString() })
      }).catch(() => {});
    }

    res.json({ id, ...result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Error al analizar" });
  }
});

app.get("/api/analysis/:id", (req, res) => {
  const data = store.get(req.params.id);
  if (!data) return res.status(404).json({ error: "No encontrado" });
  const { jobText, cvText, ...safe } = data;
  res.json(safe);
});

app.get("/api/questions/:id", async (req, res) => {
  try {
    const data = store.get(req.params.id);
    if (!data) return res.status(404).json({ error: "Análisis no encontrado" });
    if (data.questions) return res.json(data.questions);

    const questions = await generateQuestions(data.jobText || '', data.cvText || '');
    store.set(req.params.id, { ...data, questions });
    res.json(questions);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Error al generar preguntas" });
  }
});

app.post("/api/generate/:id", async (req, res) => {
  try {
    const data = store.get(req.params.id);
    if (!data) return res.status(404).json({ error: "Análisis no encontrado" });
    const { answers } = req.body;
    if (!answers || !Array.isArray(answers)) return res.status(400).json({ error: "Faltan respuestas" });

    const generated = await generateAdaptedContent(data.jobText || '', data.cvText || '', answers);
    store.set(req.params.id, { ...data, generated });
    res.json(generated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Error al generar CV adaptado" });
  }
});

app.get("/api/generated/:id", (req, res) => {
  const data = store.get(req.params.id);
  if (!data || !data.generated) return res.status(404).json({ error: "No encontrado" });
  res.json(data.generated);
});

app.get("/api/cv/:id", (req, res) => {
  const data = store.get(req.params.id);
  if (!data || !data.generated || !data.generated.adaptedCV) {
    return res.status(404).send("<h1>CV no encontrado</h1>");
  }
  const autoPrint = req.query.print === '1';
  const html = renderCVHtml(data.generated.adaptedCV, data.jobTitle, autoPrint);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.post("/api/lead", async (req, res) => {
  try {
    const { analysisId, name, email, whatsapp } = req.body;
    if (!name || !email) return res.status(400).json({ error: "Nombre y email requeridos" });

    const data = store.get(analysisId);
    if (!data) return res.status(404).json({ error: "Análisis no encontrado" });

    store.set(analysisId, { ...data, unlocked: true, leadName: name, leadEmail: email });

    let emailSent = false;
    try { await sendEmail(email, name, data); emailSent = true; } catch (e) { console.error("Email:", e.message); }

    if (process.env.SHEETS_WEBHOOK_URL) {
      fetch(process.env.SHEETS_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "lead", analysisId, name, email, whatsapp, emailSent, capturedAt: new Date().toISOString() })
      }).catch(() => {});
    }

    res.json({ ok: true, emailSent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Frontend ─────────────────────────────────────────────────────────────────
const C = `--coral:#f77e8a;--pink:#fed4e0;--bg:#fff8f8;--border:#fce7f3;--gray:#6b7280`;
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Cormorant+Garamond:ital,wght@0,600;0,700;1,600&display=swap" rel="stylesheet">`;
const NAV = (back) => `<nav style="display:flex;justify-content:space-between;align-items:center;padding:16px 24px;background:white;border-bottom:1px solid var(--border)">
  <div style="font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:700">Mypao<span style="color:var(--coral);font-style:italic">tipss</span></div>
  ${back ? `<a href="/" style="font-size:14px;color:var(--gray);text-decoration:none">← Analizar otro CV</a>` : `<div style="background:var(--pink);color:#8a2c3a;font-size:11px;font-weight:700;padding:4px 12px;border-radius:9999px">✨ Recruiter ATS con IA</div>`}
</nav>`;

// ─── Home ─────────────────────────────────────────────────────────────────────
app.get("/", (_, res) => res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Analizador de CV · Mypaotipss</title>${FONTS}
<style>*{box-sizing:border-box;margin:0;padding:0}:root{${C}}body{font-family:'DM Sans',sans-serif;background:var(--bg);color:#111}
.wrap{max-width:900px;margin:0 auto;padding:0 20px}
.hero{text-align:center;padding:48px 24px 32px}
.hero h1{font-family:'Cormorant Garamond',serif;font-size:clamp(32px,5vw,52px);line-height:1.1;margin-bottom:16px}
.hero h1 em{color:var(--coral);font-style:italic}
.hero p{font-size:16px;color:var(--gray);max-width:560px;margin:0 auto;line-height:1.6}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px}
@media(max-width:640px){.grid{grid-template-columns:1fr}}
.card{background:white;border:1px solid var(--border);border-radius:20px;padding:24px}
.card-title{font-size:15px;font-weight:600;margin-bottom:8px}
.card-sub{font-size:13px;color:var(--gray);margin-bottom:12px}
textarea{width:100%;height:200px;border:1px solid var(--border);border-radius:12px;padding:12px;font-family:inherit;font-size:14px;resize:vertical;outline:none;line-height:1.6}
textarea:focus{border-color:var(--coral)}
.ccount{font-size:12px;color:var(--gray);text-align:right;margin-top:4px}
.drop{border:2px dashed var(--pink);border-radius:12px;min-height:160px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;cursor:pointer;padding:20px;text-align:center}
.drop:hover,.drop.drag{border-color:var(--coral);background:#fff5f7}
.drop input{display:none}
.drop .hint{font-size:12px;color:var(--gray)}
.cta{text-align:center;padding-bottom:32px}
.btn{background:linear-gradient(135deg,var(--coral),#e85f6e);color:white;border:none;padding:16px 40px;border-radius:9999px;font-size:16px;font-weight:600;cursor:pointer;width:100%;max-width:400px;font-family:inherit}
.btn:hover{opacity:.9}.btn:disabled{opacity:.6;cursor:not-allowed}
.err{background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:12px 16px;font-size:14px;color:#dc2626;margin-bottom:12px;display:none}
.loading{display:none;text-align:center;padding:16px}
.spin{width:32px;height:32px;border:3px solid var(--pink);border-top-color:var(--coral);border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 12px}
@keyframes spin{to{transform:rotate(360deg)}}
.meta{font-size:12px;color:var(--gray);margin-top:8px}
</style></head><body>
${NAV(false)}
<section class="hero wrap">
  <h1>¿Tu CV es compatible con <em>esa vacante</em>?</h1>
  <p>Pega la oferta laboral y sube tu CV. Miss Pao actúa como reclutadora ATS y te dice qué tan compatible eres.</p>
</section>
<div class="wrap">
<div class="grid">
  <div class="card">
    <div class="card-title">📋 La oferta laboral</div>
    <div class="card-sub">Pega la descripción completa de la vacante.</div>
    <textarea id="job" placeholder="Pega aquí el texto completo de la oferta laboral..."></textarea>
    <div class="ccount"><span id="cc">0</span> chars · <span id="wc">0</span> palabras</div>
  </div>
  <div class="card">
    <div class="card-title">📄 Tu CV</div>
    <div class="card-sub">El CV con el que piensas aplicar.</div>
    <div class="drop" id="drop">
      <input type="file" id="file" accept=".pdf,.docx,.txt">
      <div id="empty"><div style="font-size:32px;opacity:.5">📎</div>
        <div class="hint">Arrastra tu CV o <strong style="color:var(--coral)">haz clic</strong></div>
        <div class="hint">PDF, DOCX o TXT · máx 10MB</div></div>
      <div id="ready" style="display:none;text-align:center">
        <div style="font-size:28px">📄</div>
        <div id="fname" style="font-weight:600;font-size:14px"></div>
        <div id="fsize" style="font-size:12px;color:var(--gray)"></div>
        <div onclick="clearFile()" style="font-size:12px;color:var(--coral);cursor:pointer;margin-top:4px">Cambiar</div>
      </div>
    </div>
  </div>
</div>
<div class="cta">
  <div class="err" id="err"></div>
  <div class="loading" id="load"><div class="spin"></div><div style="font-size:14px;color:var(--gray)">Miss Pao está analizando tu CV...<br><span style="font-size:12px">30-60 segundos</span></div></div>
  <button class="btn" id="btn" onclick="go()">✨ Analizar compatibilidad</button>
  <div class="meta">Gratis · No guardamos tu CV</div>
</div>
</div>
<script>
const job=document.getElementById('job'),fi=document.getElementById('file'),drop=document.getElementById('drop');
job.addEventListener('input',()=>{const t=job.value;document.getElementById('cc').textContent=t.length;document.getElementById('wc').textContent=t.trim()?t.trim().split(/\s+/).length:0});
drop.addEventListener('click',e=>{if(e.target.onclick===null||e.target.id==='drop'||e.target.closest('#empty'))fi.click()});
['dragover','dragenter'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.add('drag')}));
['dragleave','drop'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.remove('drag')}));
drop.addEventListener('drop',e=>{const f=e.dataTransfer.files[0];if(f)setFile(f)});
fi.addEventListener('change',()=>{if(fi.files[0])setFile(fi.files[0])});
function setFile(f){document.getElementById('fname').textContent=f.name;document.getElementById('fsize').textContent=(f.size/1024).toFixed(1)+' KB';document.getElementById('empty').style.display='none';document.getElementById('ready').style.display='block'}
function clearFile(){fi.value='';document.getElementById('empty').style.display='block';document.getElementById('ready').style.display='none'}
async function go(){
  document.getElementById('err').style.display='none';
  const j=job.value.trim(),f=fi.files[0];
  if(!j)return showErr('Pega la oferta laboral primero.');
  if(j.length<80)return showErr('La oferta es muy corta. Pega la descripción completa.');
  if(!f)return showErr('Sube tu CV (PDF, DOCX o TXT).');
  const btn=document.getElementById('btn');
  btn.disabled=true;document.getElementById('load').style.display='block';btn.style.display='none';
  try{
    const fd=new FormData();fd.append('job',j);fd.append('cv',f);
    const r=await fetch('/api/analyze',{method:'POST',body:fd});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||'Error');
    sessionStorage.setItem('cv_analysis_'+d.id,JSON.stringify(d));
    location.href='/results?id='+d.id;
  }catch(e){showErr(e.message||'Error de conexión');btn.disabled=false;btn.style.display='inline-block';document.getElementById('load').style.display='none'}
}
function showErr(m){const e=document.getElementById('err');e.textContent=m;e.style.display='block'}
</script></body></html>`));

// ─── Results ──────────────────────────────────────────────────────────────────
app.get("/results", (_, res) => res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Diagnóstico de CV · Mypaotipss</title>${FONTS}
<style>*{box-sizing:border-box;margin:0;padding:0}:root{${C}}body{font-family:'DM Sans',sans-serif;background:var(--bg);color:#111}
.wrap{max-width:860px;margin:0 auto;padding:24px 20px}
.ptitle{font-family:'Cormorant Garamond',serif;font-size:36px;margin-bottom:4px}
.psub{font-size:14px;color:var(--gray);margin-bottom:20px}.psub strong{color:var(--coral)}
.scores{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
@media(max-width:600px){.scores{grid-template-columns:1fr 1fr}}
.sc{background:white;border:1px solid var(--border);border-radius:16px;padding:16px;text-align:center}
.sn{font-size:36px;font-weight:700;line-height:1}.sl{font-size:11px;color:var(--gray);text-transform:uppercase;letter-spacing:1.5px;margin-top:4px}
.pao{background:#fff5f7;border:1px solid var(--border);border-radius:16px;padding:20px;margin-bottom:16px;display:flex;gap:14px}
.av{width:40px;height:40px;border-radius:50%;background:var(--pink);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
.tabs{display:flex;gap:4px;border-bottom:2px solid var(--border);margin-bottom:16px}
.tab{padding:10px 18px;font-size:14px;font-weight:500;cursor:pointer;border:none;background:none;color:var(--gray);border-bottom:2px solid transparent;margin-bottom:-2px;font-family:inherit}
.tab.a{color:var(--coral);border-bottom-color:var(--coral);font-weight:600}
.pane{display:none}.pane.a{display:block}
.card{background:white;border:1px solid var(--border);border-radius:16px;padding:20px;margin-bottom:16px}
.card h3{font-family:'Cormorant Garamond',serif;font-size:22px;margin-bottom:12px}
.kws{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}
.kw{padding:4px 12px;border-radius:9999px;font-size:12px;font-weight:500}
.kh{background:#dcfce7;color:#166534}.km{background:#fee2e2;color:#991b1b}
.sts{list-style:none;display:grid;grid-template-columns:1fr 1fr;gap:8px}
@media(max-width:500px){.sts{grid-template-columns:1fr}}
.st{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:10px 12px;font-size:13px;color:#166534}
.fi{padding:14px 0;border-bottom:1px solid var(--border)}.fi:last-child{border-bottom:none}
.fs{font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:4px}
.fa{color:#dc2626}.fm{color:#ca8a04}.fb{color:#2563eb}
.roles{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
@media(max-width:600px){.roles{grid-template-columns:1fr}}
.rc{background:#fff5f7;border:1px solid var(--border);border-radius:12px;padding:12px}
.ps{display:flex;gap:14px;padding:14px 0;border-bottom:1px solid var(--border)}.ps:last-child{border-bottom:none}
.pn{width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,var(--coral),#e85f6e);color:white;font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.pw{position:relative}
.mdb{position:fixed;inset:0;background:rgba(0,0,0,.5);display:none;align-items:center;justify-content:center;z-index:100;padding:20px}
.mdb.o{display:flex}
.md{background:white;border-radius:24px;padding:32px;max-width:460px;width:100%}
.md h3{font-family:'Cormorant Garamond',serif;font-size:26px;margin-bottom:8px}
.fld{margin-bottom:14px}.fld label{display:block;font-size:13px;font-weight:600;margin-bottom:4px}
.fld input{width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:10px;font-family:inherit;font-size:14px;outline:none}
.fld input:focus{border-color:var(--coral)}
.btn{background:linear-gradient(135deg,var(--coral),#e85f6e);color:white;border:none;padding:14px 32px;border-radius:9999px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;width:100%}
.btn:hover{opacity:.9}.btn:disabled{opacity:.6;cursor:not-allowed}
.ok{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:16px;text-align:center;font-size:14px;color:#166534;display:none}
.er{color:#dc2626;font-size:13px;margin-top:8px;display:none}
.spin{width:20px;height:20px;border:2px solid var(--pink);border-top-color:var(--coral);border-radius:50%;animation:spin 1s linear infinite;display:inline-block;vertical-align:middle;margin-right:6px}
.bspin{width:36px;height:36px;border:3px solid var(--pink);border-top-color:var(--coral);border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.next-cta{background:linear-gradient(135deg,#fff0f3,#fce7f3);border:2px solid var(--pink);border-radius:20px;padding:28px;text-align:center;margin-top:8px}
.next-cta h3{font-family:'Cormorant Garamond',serif;font-size:28px;margin-bottom:8px}
.next-cta p{font-size:14px;color:var(--gray);margin-bottom:20px;line-height:1.6}
.next-btn{display:inline-block;background:linear-gradient(135deg,var(--coral),#e85f6e);color:white;text-decoration:none;padding:16px 36px;border-radius:9999px;font-size:16px;font-weight:600}
.next-btn:hover{opacity:.9}
</style></head><body>
${NAV(true)}
<div class="wrap" id="app"><div style="text-align:center;padding:60px 20px"><div class="bspin" style="margin:0 auto 12px"></div><div style="color:var(--gray);font-size:14px">Cargando análisis...</div></div></div>
<div class="mdb" id="mb">
  <div class="md">
    <h3>🔓 Desbloquea tu plan completo</h3>
    <p style="font-size:14px;color:var(--gray);margin-bottom:20px">Recibe los 5 pasos + análisis completo en tu email. Gratis.</p>
    <div class="ok" id="ok">✅ ¡Listo! Revisa tu email.</div>
    <div id="lf">
      <div class="fld"><label>Nombre *</label><input id="ln" placeholder="Tu nombre"></div>
      <div class="fld"><label>Email *</label><input id="le" type="email" placeholder="tu@email.com"></div>
      <div class="fld"><label>WhatsApp (opcional)</label><input id="lw" placeholder="+52 55 1234 5678"></div>
      <div class="er" id="le2"></div>
      <button class="btn" id="lb" onclick="submitLead()">Recibir análisis completo →</button>
      <div style="font-size:12px;color:var(--gray);text-align:center;margin-top:12px">Sin spam. Puedes darte de baja cuando quieras.</div>
    </div>
  </div>
</div>
<script>
const id=new URLSearchParams(location.search).get('id');
let A=null;
function sc(s){return s>=80?'#16a34a':s>=60?'#ca8a04':'#dc2626'}
function kw(a,c){return a.map(k=>'<span class="kw '+c+'">'+k+'</span>').join('')||'<span style="color:#999;font-size:13px">Ninguna</span>'}
function tab(n,b){document.querySelectorAll('.tab').forEach(t=>t.classList.remove('a'));document.querySelectorAll('.pane').forEach(p=>p.classList.remove('a'));b.classList.add('a');document.getElementById('p-'+n).classList.add('a')}
async function submitLead(){
  const n=document.getElementById('ln').value.trim(),e=document.getElementById('le').value.trim(),w=document.getElementById('lw').value.trim(),er=document.getElementById('le2');
  er.style.display='none';
  if(!n){er.textContent='Escribe tu nombre.';er.style.display='block';return}
  if(!e||!e.includes('@')){er.textContent='Email inválido.';er.style.display='block';return}
  const btn=document.getElementById('lb');btn.disabled=true;
  try{
    const r=await fetch('/api/lead',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({analysisId:id,name:n,email:e,whatsapp:w})});
    const d=await r.json();if(!r.ok)throw new Error(d.error||'Error');
    document.getElementById('lf').style.display='none';document.getElementById('ok').style.display='block';
    A.unlocked=true;setTimeout(()=>{document.getElementById('mb').classList.remove('o');render(A);tab('plan',document.querySelectorAll('.tab')[3])},2000);
  }catch(e){er.textContent=e.message;er.style.display='block';btn.disabled=false}
}
function render(a){
  document.title='Diagnóstico · '+a.fileName;
  const app=document.getElementById('app');
  app.innerHTML='<div class="ptitle">Diagnóstico de tu CV 📊</div>'
    +'<div class="psub">'+a.fileName+' · Aplicando a <strong>'+(a.jobTitle||'la vacante')+'</strong></div>'
    +'<div class="scores">'
    +'<div class="sc"><div class="sn" style="color:'+sc(a.compatibilityScore)+'">'+a.compatibilityScore+'<span style="font-size:16px;color:#999">/100</span></div><div class="sl">Compatibilidad</div></div>'
    +'<div class="sc"><div class="sn" style="color:'+sc(a.atsScore)+'">'+a.atsScore+'<span style="font-size:16px;color:#999">%</span></div><div class="sl">ATS Score</div></div>'
    +'<div class="sc"><div class="sn" style="font-size:22px;padding-top:4px">'+(a.experienceLevel||'—')+'</div><div class="sl">Nivel</div></div>'
    +'<div class="sc"><div class="sn" style="font-size:22px;padding-top:4px">'+(a.suggestedRoles||[]).length+' roles</div><div class="sl">Match</div></div>'
    +'</div>'
    +'<div class="pao"><div class="av">🐣</div><div><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#8a2c3a;margin-bottom:6px">Diagnóstico Personal · Por Miss Pao</div><div style="font-size:15px;line-height:1.6">'+a.recruiterMessage+'</div></div></div>'
    +'<div class="tabs">'
    +'<button class="tab a" onclick="tab(\\'resumen\\',this)">📝 Resumen</button>'
    +'<button class="tab" onclick="tab(\\'diag\\',this)">🔍 Diagnóstico</button>'
    +'<button class="tab" onclick="tab(\\'ats\\',this)">🤖 ATS</button>'
    +'<button class="tab" onclick="tab(\\'plan\\',this)">🚀 Plan</button>'
    +'</div>'
    // Resumen
    +'<div class="pane a" id="p-resumen">'
    +'<div class="card"><h3>✨ Lo que haces bien</h3><ul class="sts">'+(a.strengths||[]).map(s=>'<li class="st">✓ '+s+'</li>').join('')+'</ul></div>'
    +'<div class="card"><h3>🔑 Keywords</h3><div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#16a34a;margin-bottom:6px">✓ Tienes</div><div class="kws">'+kw(a.matchedKeywords||[],'kh')+'</div><div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#dc2626;margin-bottom:6px">✗ Te faltan</div><div class="kws">'+kw(a.missingKeywords||[],'km')+'</div></div>'
    +'</div>'
    // Diagnóstico
    +'<div class="pane" id="p-diag"><div class="card"><h3>⚠️ Hallazgos</h3>'
    +(a.findings||[]).map(f=>'<div class="fi"><div class="fs f'+f.severity[0]+'">'+f.severity.toUpperCase()+'</div><div style="font-weight:600;font-size:14px;margin-bottom:4px">'+f.title+'</div><div style="font-size:13px;color:#555;line-height:1.5">→ '+f.suggestion+'</div>'+(f.example?'<div style="font-size:12px;color:#888;margin-top:4px;font-style:italic">Ej: '+f.example+'</div>':'')+'</div>').join('')
    +'</div></div>'
    // ATS
    +'<div class="pane" id="p-ats"><div class="card"><h3>🤖 ATS</h3>'
    +'<div style="margin-bottom:20px"><div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="font-size:14px;font-weight:600">Score ATS</span><span style="font-size:14px;font-weight:700;color:'+sc(a.atsScore)+'">'+a.atsScore+'%</span></div>'
    +'<div style="background:#f3f4f6;border-radius:9999px;height:12px;overflow:hidden"><div id="atsb" style="height:100%;border-radius:9999px;width:0%;background:'+sc(a.atsScore)+';transition:width 1s ease"></div></div></div>'
    +(a.suggestedRoles&&a.suggestedRoles.length?'<h3 style="margin-bottom:12px">🎯 Roles donde encajas</h3><div class="roles">'+a.suggestedRoles.map(r=>'<div class="rc"><div style="font-weight:600;font-size:14px">'+r.title+'</div><div style="font-size:12px;color:'+sc(r.matchPct)+'">'+r.matchPct+'% match</div><div style="font-size:12px;color:var(--gray);line-height:1.4">'+r.reason+'</div></div>').join('')+'</div>':'')
    +'</div></div>'
    // Plan
    +'<div class="pane" id="p-plan"><div class="card"><h3>🚀 Plan de acción</h3>'
    +(a.unlocked
      ? a.improvementPlan.map((s,i)=>'<div class="ps"><div class="pn">'+(i+1)+'</div><div style="font-size:14px;line-height:1.6;padding-top:5px">'+s+'</div></div>').join('')
      : a.improvementPlan.slice(0,2).map((s,i)=>'<div class="ps"><div class="pn">'+(i+1)+'</div><div style="font-size:14px;line-height:1.6;padding-top:5px">'+s+'</div></div>').join('')
        +'<div class="pw"><div style="filter:blur(5px);pointer-events:none">'+a.improvementPlan.slice(2).map((s,i)=>'<div class="ps"><div class="pn">'+(i+3)+'</div><div style="font-size:14px;line-height:1.6;padding-top:5px">'+s+'</div></div>').join('')+'</div>'
        +'<div style="position:absolute;inset:0;background:linear-gradient(to bottom,transparent,var(--bg) 40%);display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding:24px">'
        +'<div style="background:white;border:1px solid var(--border);border-radius:20px;padding:28px;text-align:center;max-width:420px;width:100%"><h3 style="font-family:\\'Cormorant Garamond\\',serif;font-size:24px;margin-bottom:8px">Desbloquea los '+(a.improvementPlan.length-2)+' pasos restantes</h3>'
        +'<p style="font-size:14px;color:var(--gray);margin-bottom:16px">Recibe tu plan completo + análisis en tu email. Gratis.</p>'
        +'<button class="btn" onclick="document.getElementById(\\'mb\\').classList.add(\\'o\\')">Recibir análisis completo →</button></div></div></div>'
    )
    +'</div></div>'
    // Siguiente paso CTA
    +'<div class="next-cta">'
    +'<h3>🎯 ¿Quieres el trabajo?</h3>'
    +'<p>Responde unas preguntas y Miss Pao adaptará tu CV a esta vacante, generará tu carta de presentación y te preparará para la entrevista.</p>'
    +'<a href="/quiz?id='+a.id+'" class="next-btn">✨ Adaptar mi CV a esta vacante →</a>'
    +'</div>';
  setTimeout(()=>{const b=document.getElementById('atsb');if(b)b.style.width=a.atsScore+'%'},300);
}
async function load(){
  if(!id){document.getElementById('app').innerHTML='<div style="text-align:center;padding:80px 20px"><h2 style="font-family:serif;font-size:32px;margin-bottom:12px">Análisis no encontrado</h2><a href="/" style="color:var(--coral)">← Nuevo análisis</a></div>';return}
  const cached=sessionStorage.getItem('cv_analysis_'+id);
  if(cached){try{A=JSON.parse(cached);render(A);return}catch(e){}}
  try{
    const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),10000);
    const r=await fetch('/api/analysis/'+id,{signal:ctrl.signal});
    clearTimeout(t);
    if(!r.ok)throw new Error();
    A=await r.json();render(A);
  }catch{document.getElementById('app').innerHTML='<div style="text-align:center;padding:80px 20px"><h2 style="font-family:serif;font-size:32px;margin-bottom:12px">Análisis no encontrado</h2><p style="color:var(--gray);margin-bottom:20px">El link puede haber expirado.</p><a href="/" style="color:var(--coral)">← Nuevo análisis</a></div>'}
}
load();
</script></body></html>`));

// ─── Quiz ─────────────────────────────────────────────────────────────────────
app.get("/quiz", (_, res) => res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cuestionario · Mypaotipss</title>${FONTS}
<style>*{box-sizing:border-box;margin:0;padding:0}:root{${C}}body{font-family:'DM Sans',sans-serif;background:var(--bg);color:#111}
.wrap{max-width:700px;margin:0 auto;padding:24px 20px}
.hero{text-align:center;padding:32px 0 24px}
.hero h1{font-family:'Cormorant Garamond',serif;font-size:clamp(28px,4vw,40px);margin-bottom:8px}
.hero p{font-size:15px;color:var(--gray);line-height:1.6}
.q-card{background:white;border:1px solid var(--border);border-radius:16px;padding:20px;margin-bottom:16px}
.q-num{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--coral);margin-bottom:6px}
.q-text{font-size:16px;font-weight:600;line-height:1.5;margin-bottom:12px}
.q-hint{font-size:12px;color:var(--gray);margin-bottom:10px;font-style:italic}
.q-screen{border-left:3px solid var(--pink)}
textarea{width:100%;min-height:100px;border:1px solid var(--border);border-radius:10px;padding:12px;font-family:inherit;font-size:14px;resize:vertical;outline:none;line-height:1.6}
textarea:focus{border-color:var(--coral)}
.yn{display:flex;gap:16px;margin-top:8px}
.yn label{display:flex;align-items:center;gap:8px;font-size:15px;cursor:pointer;padding:10px 20px;border:1.5px solid var(--border);border-radius:10px;flex:1;justify-content:center}
.yn input[type=radio]{accent-color:var(--coral);width:16px;height:16px}
.yn label:has(input:checked){border-color:var(--coral);background:#fff5f7}
.cta{text-align:center;padding:8px 0 32px}
.btn{background:linear-gradient(135deg,var(--coral),#e85f6e);color:white;border:none;padding:16px 40px;border-radius:9999px;font-size:16px;font-weight:600;cursor:pointer;font-family:inherit}
.btn:hover{opacity:.9}.btn:disabled{opacity:.6;cursor:not-allowed}
.err{background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:12px 16px;font-size:14px;color:#dc2626;margin-bottom:16px;display:none}
.loading{display:none;text-align:center;padding:40px}
.spin{width:36px;height:36px;border:3px solid var(--pink);border-top-color:var(--coral);border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 12px}
@keyframes spin{to{transform:rotate(360deg)}}
.progress{background:var(--pink);border-radius:9999px;height:6px;margin-bottom:24px}
.progress-bar{background:var(--coral);height:6px;border-radius:9999px;width:0%;transition:width .5s ease}
#loading-state{text-align:center;padding:60px 20px}
</style></head><body>
${NAV(true)}
<div class="wrap">
  <div id="loading-state">
    <div class="spin" style="margin:0 auto 12px"></div>
    <div style="color:var(--gray);font-size:14px">Miss Pao está preparando tus preguntas...</div>
  </div>
  <div id="quiz-content" style="display:none">
    <div class="hero">
      <h1>Cuéntame un poco más</h1>
      <p id="quiz-sub">Responde estas preguntas para que Miss Pao pueda adaptar tu CV a esta vacante.</p>
    </div>
    <div class="progress"><div class="progress-bar" id="pb"></div></div>
    <div id="questions"></div>
    <div class="err" id="err"></div>
    <div class="cta">
      <div class="loading" id="load">
        <div class="spin"></div>
        <div style="font-size:14px;color:var(--gray)">Miss Pao está adaptando tu CV...<br><span style="font-size:12px">30-60 segundos</span></div>
      </div>
      <button class="btn" id="btn">✨ Generar mi CV adaptado →</button>
    </div>
  </div>
</div>
<script>
const id = new URLSearchParams(location.search).get('id');
let questionsData = null;

async function loadQuestions() {
  if (!id) { showError('ID no encontrado'); return; }
  try {
    const r = await fetch('/api/questions/' + id);
    if (!r.ok) throw new Error('No se pudieron cargar las preguntas');
    questionsData = await r.json();
    renderQuestions();
  } catch(e) {
    document.getElementById('loading-state').innerHTML = '<div style="color:#dc2626;padding:40px 0">' + e.message + '</div><a href="/" style="color:var(--coral)">← Volver</a>';
  }
}

function renderQuestions() {
  document.getElementById('loading-state').style.display = 'none';
  document.getElementById('quiz-content').style.display = 'block';

  const container = document.getElementById('questions');
  const total = (questionsData.skillQuestions || []).length + (questionsData.screeningQuestions || []).length;

  (questionsData.skillQuestions || []).forEach(function(q, i) {
    const card = document.createElement('div');
    card.className = 'q-card';
    card.dataset.qid = q.id;

    const num = document.createElement('div');
    num.className = 'q-num';
    num.textContent = 'Pregunta ' + (i + 1) + ' de ' + total;
    card.appendChild(num);

    const text = document.createElement('div');
    text.className = 'q-text';
    text.textContent = q.question;
    card.appendChild(text);

    if (q.hint) {
      const hint = document.createElement('div');
      hint.className = 'q-hint';
      hint.textContent = '💡 ' + q.hint;
      card.appendChild(hint);
    }

    const ta = document.createElement('textarea');
    ta.id = 'answer_' + q.id;
    ta.placeholder = 'Escribe tu respuesta aquí...';
    ta.addEventListener('input', updateProgress);
    card.appendChild(ta);
    container.appendChild(card);
  });

  const offset = (questionsData.skillQuestions || []).length;
  (questionsData.screeningQuestions || []).forEach(function(q, i) {
    const card = document.createElement('div');
    card.className = 'q-card q-screen';
    card.dataset.qid = q.id;

    const num = document.createElement('div');
    num.className = 'q-num';
    num.textContent = 'Filtro ' + (i + 1) + ' de ' + total;
    card.appendChild(num);

    const text = document.createElement('div');
    text.className = 'q-text';
    text.textContent = q.question;
    card.appendChild(text);

    if (q.type === 'yesno') {
      const yn = document.createElement('div');
      yn.className = 'yn';
      yn.innerHTML = '<label><input type="radio" name="scr_' + q.id + '" value="si"> Sí</label><label><input type="radio" name="scr_' + q.id + '" value="no"> No</label>';
      yn.querySelectorAll('input').forEach(function(inp) { inp.addEventListener('change', updateProgress); });
      card.appendChild(yn);
    } else {
      const ta = document.createElement('textarea');
      ta.id = 'answer_' + q.id;
      ta.placeholder = 'Tu respuesta...';
      ta.style.minHeight = '70px';
      ta.addEventListener('input', updateProgress);
      card.appendChild(ta);
    }
    container.appendChild(card);
  });

  document.getElementById('btn').addEventListener('click', submitAnswers);
  updateProgress();
}

function updateProgress() {
  const all = document.querySelectorAll('#questions .q-card');
  let answered = 0;
  all.forEach(function(card) {
    const qid = card.dataset.qid;
    const ta = document.getElementById('answer_' + qid);
    if (ta && ta.value.trim().length > 0) { answered++; return; }
    const radio = document.querySelector('input[name="scr_' + qid + '"]:checked');
    if (radio) answered++;
  });
  document.getElementById('pb').style.width = (all.length > 0 ? (answered / all.length * 100) : 0) + '%';
}

async function submitAnswers() {
  const answers = [];
  let missing = false;

  (questionsData.skillQuestions || []).forEach(function(q) {
    const ta = document.getElementById('answer_' + q.id);
    const val = ta ? ta.value.trim() : '';
    if (!val) missing = true;
    answers.push({ question: q.question, answer: val || '(sin respuesta)' });
  });

  (questionsData.screeningQuestions || []).forEach(function(q) {
    if (q.type === 'yesno') {
      const radio = document.querySelector('input[name="scr_' + q.id + '"]:checked');
      if (!radio) missing = true;
      answers.push({ question: q.question, answer: radio ? radio.value : '(sin respuesta)' });
    } else {
      const ta = document.getElementById('answer_' + q.id);
      const val = ta ? ta.value.trim() : '';
      if (!val) missing = true;
      answers.push({ question: q.question, answer: val || '(sin respuesta)' });
    }
  });

  if (missing) {
    const err = document.getElementById('err');
    err.textContent = 'Por favor responde todas las preguntas antes de continuar.';
    err.style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  document.getElementById('err').style.display = 'none';
  document.getElementById('btn').style.display = 'none';
  document.getElementById('load').style.display = 'block';

  try {
    const r = await fetch('/api/generate/' + id, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: answers })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Error al generar');
    sessionStorage.setItem('cv_generated_' + id, JSON.stringify(d));
    location.href = '/download?id=' + id;
  } catch(e) {
    document.getElementById('load').style.display = 'none';
    document.getElementById('btn').style.display = 'inline-block';
    const err = document.getElementById('err');
    err.textContent = e.message || 'Error de conexión. Intenta de nuevo.';
    err.style.display = 'block';
  }
}

function showError(msg) {
  document.getElementById('loading-state').innerHTML = '<div style="color:#dc2626;padding:40px 0">' + msg + '</div><a href="/" style="color:var(--coral)">← Volver</a>';
}

loadQuestions();
</script></body></html>`));

// ─── Download ─────────────────────────────────────────────────────────────────
app.get("/download", (_, res) => res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tu CV Adaptado · Mypaotipss</title>${FONTS}
<style>*{box-sizing:border-box;margin:0;padding:0}:root{${C}}body{font-family:'DM Sans',sans-serif;background:var(--bg);color:#111}
.wrap{max-width:860px;margin:0 auto;padding:24px 20px}
.hero{text-align:center;padding:32px 0 24px}
.hero h1{font-family:'Cormorant Garamond',serif;font-size:clamp(28px,4vw,40px);margin-bottom:8px}
.hero p{font-size:15px;color:var(--gray);line-height:1.6}
.tabs{display:flex;gap:4px;border-bottom:2px solid var(--border);margin-bottom:20px;overflow-x:auto}
.tab{padding:10px 18px;font-size:14px;font-weight:500;cursor:pointer;border:none;background:none;color:var(--gray);border-bottom:2px solid transparent;margin-bottom:-2px;font-family:inherit;white-space:nowrap}
.tab.a{color:var(--coral);border-bottom-color:var(--coral);font-weight:600}
.pane{display:none}.pane.a{display:block}
.card{background:white;border:1px solid var(--border);border-radius:16px;padding:24px;margin-bottom:16px}
.card h3{font-family:'Cormorant Garamond',serif;font-size:24px;margin-bottom:12px}
.tip{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid var(--border)}.tip:last-child{border-bottom:none}
.tip-n{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,var(--coral),#e85f6e);color:white;font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.imp{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:12px 14px;margin-bottom:8px;font-size:14px;color:#166534}
.imp:before{content:"✅ ";font-size:13px}
.email-box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px;font-size:14px;line-height:1.6;color:#334155;margin-bottom:12px;font-family:monospace}
.btn{background:linear-gradient(135deg,var(--coral),#e85f6e);color:white;border:none;padding:12px 28px;border-radius:9999px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
.btn:hover{opacity:.9}
.btn-out{background:white;color:var(--coral);border:2px solid var(--coral);padding:12px 28px;border-radius:9999px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;text-decoration:none;display:inline-block}
.btn-out:hover{background:#fff5f7}
.cv-frame{width:100%;height:600px;border:1px solid var(--border);border-radius:12px;background:white}
.letter-text{white-space:pre-line;font-size:14px;line-height:1.8;color:#333;padding:16px;background:#fafafa;border-radius:12px;border:1px solid var(--border);min-height:200px;max-height:500px;overflow-y:auto;margin-bottom:16px}
.bspin{width:36px;height:36px;border:3px solid var(--pink);border-top-color:var(--coral);border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.copied{color:#16a34a;font-size:13px;margin-left:10px;display:none}
</style></head><body>
${NAV(true)}
<div class="wrap">
  <div id="app"><div style="text-align:center;padding:60px 20px"><div class="bspin" style="margin:0 auto 12px"></div><div style="color:var(--gray);font-size:14px">Cargando resultados...</div></div></div>
</div>
<script>
const id = new URLSearchParams(location.search).get('id');
let G = null;

function tab(n, btn) {
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('a'); });
  document.querySelectorAll('.pane').forEach(function(p) { p.classList.remove('a'); });
  btn.classList.add('a');
  document.getElementById('p-' + n).classList.add('a');
}

function copyText(text, btnId) {
  navigator.clipboard.writeText(text).then(function() {
    const el = document.getElementById(btnId);
    if (el) { el.style.display = 'inline'; setTimeout(function() { el.style.display = 'none'; }, 2000); }
  });
}

function render(g) {
  const app = document.getElementById('app');

  const tipsHtml = (g.interviewTips || []).map(function(t, i) {
    return '<div class="tip"><div class="tip-n">' + (i+1) + '</div><div style="font-size:14px;line-height:1.6;padding-top:2px">' + t + '</div></div>';
  }).join('');

  const impsHtml = (g.improvements || []).map(function(imp) {
    return '<div class="imp">' + imp + '</div>';
  }).join('');

  const emailSection = g.applicationEmail
    ? '<div class="card"><h3>📧 Email de Contacto</h3><p style="font-size:14px;color:var(--gray);margin-bottom:12px">Email extraído de la oferta laboral:</p><div class="email-box">' + g.applicationEmail + '</div><button class="btn" onclick="navigator.clipboard.writeText(' + "'" + g.applicationEmail + "'" + ');document.getElementById(\\'email-copied\\').style.display=\\'inline\\'">Copiar email</button><span class="copied" id="email-copied">¡Copiado!</span></div>'
    : '<div class="card"><h3>📧 Email de Contacto</h3><p style="font-size:14px;color:var(--gray)">No se encontró un email en la oferta laboral. Busca la forma de contacto directamente en la publicación o en LinkedIn.</p></div>';

  const letter = (g.coverLetter || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  app.innerHTML = '<div class="hero"><h1>🎉 Tu CV está adaptado</h1><p>Miss Pao preparó todo lo que necesitas para aplicar con confianza.</p></div>'
    + impsHtml
    + '<div class="tabs">'
    + '<button class="tab a" onclick="tab(\\'cv\\',this)">📄 CV Adaptado</button>'
    + '<button class="tab" onclick="tab(\\'carta\\',this)">✉️ Carta de Presentación</button>'
    + '<button class="tab" onclick="tab(\\'prep\\',this)">🎯 Preparación</button>'
    + '<button class="tab" onclick="tab(\\'email\\',this)">📧 Contacto</button>'
    + '</div>'
    // CV tab
    + '<div class="pane a" id="p-cv">'
    + '<div class="card"><h3>📄 Tu CV Adaptado</h3>'
    + '<p style="font-size:14px;color:var(--gray);margin-bottom:16px">Tu CV fue optimizado con las keywords de esta vacante. Para descargarlo como PDF, ábrelo y usa Ctrl+P / Cmd+P.</p>'
    + '<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">'
    + '<a href="/api/cv/' + id + '?print=1" target="_blank" class="btn">🖨 Abrir y descargar PDF</a>'
    + '<a href="/api/cv/' + id + '" target="_blank" class="btn-out">👁 Vista previa</a>'
    + '</div>'
    + '<iframe class="cv-frame" src="/api/cv/' + id + '" title="CV Adaptado"></iframe>'
    + '</div></div>'
    // Carta tab
    + '<div class="pane" id="p-carta">'
    + '<div class="card"><h3>✉️ Carta de Presentación</h3>'
    + '<p style="font-size:14px;color:var(--gray);margin-bottom:12px">Personalizada para esta vacante, siguiendo el formato que mejor convierte.</p>'
    + '<div class="letter-text" id="letter-text">' + letter + '</div>'
    + '<button class="btn" onclick="copyText(document.getElementById(\\'letter-raw\\').textContent,\\'letter-copied\\')">Copiar carta</button>'
    + '<span class="copied" id="letter-copied">¡Copiada!</span>'
    + '<textarea id="letter-raw" style="display:none">' + letter + '</textarea>'
    + '</div></div>'
    // Preparación tab
    + '<div class="pane" id="p-prep">'
    + '<div class="card"><h3>🎯 Cómo prepararte para la entrevista</h3>'
    + tipsHtml
    + '</div></div>'
    // Email tab
    + '<div class="pane" id="p-email">'
    + emailSection
    + '</div>';
}

async function load() {
  if (!id) {
    document.getElementById('app').innerHTML = '<div style="text-align:center;padding:80px 20px"><h2>No encontrado</h2><a href="/" style="color:var(--coral)">← Volver</a></div>';
    return;
  }
  const cached = sessionStorage.getItem('cv_generated_' + id);
  if (cached) {
    try { G = JSON.parse(cached); render(G); return; } catch(e) {}
  }
  try {
    const r = await fetch('/api/generated/' + id);
    if (!r.ok) throw new Error();
    G = await r.json();
    render(G);
  } catch(e) {
    document.getElementById('app').innerHTML = '<div style="text-align:center;padding:80px 20px"><h2 style="font-family:serif;font-size:28px;margin-bottom:12px">Resultados no encontrados</h2><p style="color:var(--gray);margin-bottom:20px">El servidor fue reiniciado. Vuelve al análisis y repite el proceso.</p><a href="/" style="color:var(--coral)">← Nuevo análisis</a></div>';
  }
}

load();
</script></body></html>`));

app.listen(process.env.PORT || 3000, () => console.log(`✅ App corriendo en http://localhost:${process.env.PORT || 3000}`));
