import './style.css'
import { analyze, loadOpenCV, Tracker, CROP, RULES, type Reading, type Verdict } from './vision'
import { renderTray, DEMO_DELTAS } from './synth'
import { evaluate, type EvalResult } from './evaluate'
import { BASELINE } from './baseline'

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T
const view = $<HTMLCanvasElement>('#view'), ctx = view.getContext('2d')!
const video = $<HTMLVideoElement>('#video'), status = $<HTMLDivElement>('#status')
const COLORS: Record<Verdict, string> = { USE: '#15803d', 'USE FIRST': '#b45309', DISCARD: '#dc2626', RESCAN: '#64748b' }

let source: HTMLCanvasElement | HTMLImageElement | null = null
let readings: Reading[] = []
let selected: number | null = null
let stream: MediaStream | null = null
let hardSeed = 41
const log: (Reading & { when: string; source: string })[] = []
let sourceName = ''

function setStatus(s: string) { status.textContent = s; status.hidden = !s }

async function boot() {
  try { await loadOpenCV(); setStatus(''); runDemo() }
  catch { setStatus('Could not load the vision engine. Check your connection and reload.') }
}

function fit(w: number, h: number) { view.width = w; view.height = h }

function scanImage(img: HTMLCanvasElement | HTMLImageElement, name: string) {
  stopCamera()
  source = img; sourceName = name
  const w = img instanceof HTMLImageElement ? img.naturalWidth : img.width
  const h = img instanceof HTMLImageElement ? img.naturalHeight : img.height
  const scale = Math.min(1, 1600 / Math.max(w, h))
  fit(Math.round(w * scale), Math.round(h * scale))
  ctx.drawImage(img, 0, 0, view.width, view.height)
  const data = ctx.getImageData(0, 0, view.width, view.height)
  const t0 = performance.now()
  readings = analyze(data)
  const ms = performance.now() - t0
  selected = null
  const when = new Date().toISOString()
  for (const r of readings) log.push({ ...r, when, source: name })
  $<HTMLButtonElement>('#csv').disabled = !log.length
  draw(); panel(`${readings.length} labels measured in ${Math.round(ms)} ms`)
  animateRings()
}

function runDemo() { scanImage(renderTray({ seed: 7, deltas: DEMO_DELTAS }).canvas, 'demo tray') }

// Rings grow in one by one: the "snap" moment in the demo.
let animT = 0
function animateRings() {
  const start = performance.now(); cancelAnimationFrame(animT)
  const step = (t: number) => { draw((t - start) / 900); if (t - start < 1100) animT = requestAnimationFrame(step) }
  animT = requestAnimationFrame(step)
}

function draw(progress = 1) {
  if (source && !stream) ctx.drawImage(source, 0, 0, view.width, view.height)
  readings.forEach((r, i) => {
    const p = Math.min(1, Math.max(0, progress * readings.length - i))
    if (p <= 0) return
    const col = COLORS[r.verdict]
    ctx.save(); ctx.translate(r.cx, r.cy); ctx.rotate(r.angle)
    ctx.lineWidth = Math.max(3, r.a * 0.09); ctx.strokeStyle = col
    ctx.globalAlpha = p
    ctx.beginPath(); ctx.ellipse(0, 0, r.a * (1.25 + (1 - p) * 0.6), r.b * (1.25 + (1 - p) * 0.6), 0, 0, Math.PI * 2); ctx.stroke()
    if (selected === r.id) { ctx.setLineDash([6, 6]); ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(0, 0, r.a * 1.55, r.b * 1.55, 0, 0, Math.PI * 2); ctx.stroke() }
    ctx.restore()
    if (p < 1) return
    const fs = Math.max(13, Math.min(22, r.a * 0.34))
    ctx.font = `700 ${fs}px Inter, system-ui, sans-serif`
    const label = r.verdict === 'RESCAN' ? 'RESCAN' : `${r.verdict}  ${fmt(r.deltaL)}`
    const tw = ctx.measureText(label).width + fs
    const ly = r.cy + Math.max(r.a, r.b) * 1.32 + fs * 0.4
    ctx.fillStyle = col; roundRect(r.cx - tw / 2, ly, tw, fs * 1.6, fs * 0.8); ctx.fill()
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, r.cx, ly + fs * 0.82)
  })
}

function roundRect(x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath()
}
const fmt = (d: number) => `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}`

function panel(sub = '') {
  const discard = readings.filter((r) => r.verdict === 'DISCARD').length
  const rescan = readings.filter((r) => r.verdict === 'RESCAN').length
  const first = readings.filter((r) => r.verdict === 'USE FIRST').length
  const big = !readings.length ? 'No labels found' : discard ? `${discard} of ${readings.length} must be discarded` : `All ${readings.length - rescan} readable vials are usable`
  $('#summary').className = 'summary' + (discard ? ' bad' : readings.length ? ' good' : '')
  $('#summary').innerHTML = `<div class="sum-big">${big}</div><div class="sum-sub">${[first ? `${first} to use first` : '', rescan ? `${rescan} need a rescan` : '', sub].filter(Boolean).join(' · ')}</div>`
  $('#vials').innerHTML = readings.map((r, i) => `
    <li class="vial${selected === r.id ? ' on' : ''}" data-id="${r.id}">
      <span class="num">${i + 1}</span>
      <span class="chip" style="background:${COLORS[r.verdict]}">${r.verdict}</span>
      <span class="val">${r.verdict === 'RESCAN' ? r.reason.split('.')[0] : `ΔL* ${fmt(r.deltaL)} <small>[${fmt(r.lo)}, ${fmt(r.hi)}]</small>`}</span>
    </li>`).join('')
}

$('#vials').addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest('li'); if (!li) return
  selected = Number(li.dataset.id); draw(); panel(); detail()
})
view.addEventListener('click', (e) => {
  const rect = view.getBoundingClientRect(), x = (e.clientX - rect.left) * view.width / rect.width, y = (e.clientY - rect.top) * view.height / rect.height
  const hit = readings.find((r) => Math.hypot(r.cx - x, r.cy - y) < Math.max(r.a, r.b) * 1.4)
  if (hit) { selected = hit.id; draw(); panel(); detail() }
})

function detail() {
  const r = readings.find((k) => k.id === selected); const box = $('#detail')
  if (!r) { box.hidden = true; return }
  box.hidden = false
  box.innerHTML = `
    <div class="d-crop"><canvas id="dcrop" width="${CROP}" height="${CROP}"></canvas><span>Straightened label with the measured regions</span></div>
    <div class="d-body">
      <div class="d-head"><span class="chip big" style="background:${COLORS[r.verdict]}">${r.verdict}</span><span>${r.reason}</span></div>
      <dl class="d-nums">
        <div><dt>Square lightness</dt><dd>L* ${r.squareL.toFixed(1)}</dd></div>
        <div><dt>Circle at the centre</dt><dd>L* ${r.ringL.toFixed(1)}</dd></div>
        <div><dt>Difference (square − circle)</dt><dd class="strong">${fmt(r.deltaL)} <small>95% interval ${fmt(r.lo)} to ${fmt(r.hi)}</small></dd></div>
        <div><dt>Light falloff across the label</dt><dd>${r.ringGradient.toFixed(1)} L* (cancelled by the plane fit)</dd></div>
        <div><dt>Glare · sharpness · tilt</dt><dd>${(r.glare * 100).toFixed(0)}% · ${(r.edge * 100).toFixed(0)}% · ${Math.round(Math.acos(Math.min(1, r.tilt)) * 180 / Math.PI)}°</dd></div>
        ${r.frames > 1 ? `<div><dt>Frames averaged</dt><dd>${r.frames}</dd></div>` : ''}
      </dl>
      <p class="d-rule">Rule: discard when the interval reaches within ${RULES.discardMargin} L* of the circle or below (same or darker, per WHO). Use first when lighter by under ${RULES.useFirstBelow} L*.</p>
      <button class="btn small" id="askAI">Ask the AI model about this label</button><span id="askOut" class="ask-out"></span>
    </div>`
  const dc = (document.getElementById('dcrop') as HTMLCanvasElement).getContext('2d')!
  dc.putImageData(r.crop, 0, 0)
  const c = CROP / 2, R = 64
  dc.lineWidth = 2; dc.strokeStyle = '#1e5eff'
  dc.beginPath(); dc.arc(c, c, R * 0.3, 0, Math.PI * 2); dc.stroke()
  dc.setLineDash([5, 4]); dc.strokeStyle = '#ffffff'
  dc.beginPath(); dc.arc(c, c, R * 0.62, 0, Math.PI * 2); dc.stroke(); dc.beginPath(); dc.arc(c, c, R * 0.88, 0, Math.PI * 2); dc.stroke()
  $('#askAI').addEventListener('click', () => askAI(r))
}

async function askAI(r: Reading) {
  const out = $('#askOut'); out.textContent = 'Asking Qwen3-VL-30B…'
  const cv = document.createElement('canvas'); cv.width = CROP; cv.height = CROP; cv.getContext('2d')!.putImageData(r.crop, 0, 0)
  try {
    const res = await fetch('/api/baseline', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: cv.toDataURL('image/png') }) })
    const j = await res.json()
    out.innerHTML = j.answer ? `AI said: <b>${escapeHtml(j.answer)}</b> · VialSight measured ${fmt(r.deltaL)} → <b>${r.verdict}</b>` : 'The AI model is unavailable right now.'
  } catch { out.textContent = 'The AI model is unavailable right now (VialSight itself works offline).' }
}
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!))

// Live camera
const tracker = new Tracker()
let camTimer = 0
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false })
  } catch { setStatus('Camera blocked. Allow camera access, or upload a photo instead.'); return }
  video.srcObject = stream; await video.play()
  $('#camBtn').textContent = 'Stop camera'; sourceName = 'camera'
  const loop = () => {
    if (!stream) return
    const w = video.videoWidth, h = video.videoHeight
    if (w) {
      const s = Math.min(1, 960 / Math.max(w, h)); if (view.width !== Math.round(w * s)) fit(Math.round(w * s), Math.round(h * s))
      ctx.drawImage(video, 0, 0, view.width, view.height)
      const frame = analyze(ctx.getImageData(0, 0, view.width, view.height))
      readings = tracker.update(frame, performance.now())
      draw(); panel(`live · ${readings.length} labels tracked`)
    }
    camTimer = window.setTimeout(loop, 120)
  }
  loop()
}
function stopCamera() {
  if (!stream) return
  stream.getTracks().forEach((t) => t.stop()); stream = null; clearTimeout(camTimer)
  $('#camBtn').textContent = 'Live camera'
  for (const r of readings) log.push({ ...r, when: new Date().toISOString(), source: 'camera' })
}

document.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) => b.addEventListener('click', async () => {
  const act = b.dataset.act
  if (act === 'demo') runDemo()
  if (act === 'hard') scanImage(renderTray({ seed: hardSeed++, hard: true }).canvas, `hard tray ${hardSeed - 1}`)
  if (act === 'who') { const im = new Image(); im.src = '/who-vvm-graphic.png'; await im.decode(); scanImage(im, 'WHO graphic') }
  if (act === 'camera') stream ? stopCamera() : startCamera()
}))
$<HTMLInputElement>('#file').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return
  const im = new Image(); im.src = URL.createObjectURL(f); await im.decode(); scanImage(im, f.name)
})

$('#csv').addEventListener('click', () => {
  const rows = [['time', 'source', 'vial', 'verdict', 'deltaL', 'lo', 'hi', 'squareL', 'circleL', 'reason']]
  log.forEach((r, i) => rows.push([r.when, r.source, String(i + 1), r.verdict, r.deltaL.toFixed(2), r.lo.toFixed(2), r.hi.toFixed(2), r.squareL.toFixed(2), r.ringL.toFixed(2), r.reason]))
  const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n')
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'vialsight-log.csv'; a.click()
})

// Accuracy
$('#runEval').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('#runEval'); btn.disabled = true
  const prog = $('#evalProg')
  const normal = await evaluate(15, false, (i) => (prog.textContent = `normal set: tray ${i}/15`))
  const hard = await evaluate(15, true, (i) => (prog.textContent = `hard set: tray ${i}/15`))
  prog.textContent = ''; btn.disabled = false
  $('#evalOut').innerHTML = evalCard('Normal conditions', normal) + evalCard('Hard conditions (strong glare, tilt, noise, blur)', hard)
})
function evalCard(title: string, e: EvalResult) {
  const V: Verdict[] = ['USE', 'USE FIRST', 'DISCARD', 'RESCAN']
  const answered = e.detected - e.rescans
  const correct = (['USE', 'USE FIRST', 'DISCARD'] as Verdict[]).reduce((s, v) => s + e.matrix[v][v], 0)
  return `<div class="eval-card"><h3>${title}</h3>
    <div class="eval-kpis">
      <div><b>${e.unsafe}</b><span>unsafe calls<br/>(must discard, called usable)</span></div>
      <div><b>${e.wasted}</b><span>good vials thrown away</span></div>
      <div><b>${answered ? Math.round((100 * correct) / answered) : 0}%</b><span>exact verdict when answered</span></div>
      <div><b>${e.meanAbsErr.toFixed(1)}</b><span>mean ΔL* error</span></div>
      <div><b>${Math.round((100 * e.rescans) / Math.max(1, e.detected))}%</b><span>asked for a rescan</span></div>
    </div>
    <table class="matrix"><tr><th>truth ↓ / read →</th>${V.map((v) => `<th>${v}</th>`).join('')}</tr>
    ${(['USE', 'USE FIRST', 'DISCARD'] as Verdict[]).map((t) => `<tr><th>${t}</th>${V.map((p) => `<td class="${t === p ? 'diag' : t === 'DISCARD' && (p === 'USE' || p === 'USE FIRST') ? 'danger' : ''}">${e.matrix[t][p]}</td>`).join('')}</tr>`).join('')}
    </table><p class="note">${e.detected} of ${e.labels} labels found across ${e.trays} trays.</p></div>`
}

// AI baseline table (measured offline with scripts/baseline.mjs)
$('#aiTable').innerHTML = BASELINE.rows.length ? `
  <table class="matrix ai"><tr><th>Label (true ΔL*)</th><th>WHO answer</th><th>Qwen3-VL-30B said</th><th>VialSight</th></tr>
  ${BASELINE.rows.map((r) => `<tr><td>${fmt(r.truth)}</td><td>${r.expected}</td><td class="${r.aiCorrect ? 'diag' : 'danger'}">${escapeHtml(r.ai)}</td><td class="${r.vsCorrect === null ? '' : r.vsCorrect ? 'diag' : 'danger'}">${r.vs}</td></tr>`).join('')}
  </table><p class="note">${BASELINE.summary}</p>` : '<p class="note">Baseline run pending.</p>'

boot()
