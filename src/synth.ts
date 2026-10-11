// Synthetic VVM trays with known ground truth: used for the demo tray and the accuracy test.
// Each label's inner square is set to a known L* offset from its circle, then the whole scene
// gets the things that break naive readers: uneven light, colour cast, tilt, rotation, glare, noise, blur.
import { labToRgb } from './color'
import type { Verdict } from './vision'
import { RULES } from './vision'

export interface Truth { cx: number; cy: number; delta: number; expected: Verdict; glare: boolean }

const RING: [number, number, number] = [42, 24, -21]       // VVM reference circle (purple)
const FRESH: [number, number, number] = [93, 3, -3]        // a fresh square: near white

export function squareColour(delta: number): [number, number, number] {
  // Move from the fresh shade toward and past the ring shade as the label ages.
  const L = RING[0] + delta
  const t = Math.min(1.25, Math.max(0, (FRESH[0] - L) / (FRESH[0] - RING[0])))
  const a = FRESH[1] + (RING[1] - FRESH[1]) * t, b = FRESH[2] + (RING[2] - FRESH[2]) * t
  return labToRgb(L, a, b)
}

export function expectedVerdict(delta: number): Verdict {
  if (delta <= RULES.discardMargin) return 'DISCARD'
  if (delta < RULES.useFirstBelow) return 'USE FIRST'
  return 'USE'
}

function rng(seed: number) {
  let s = seed >>> 0
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

export interface TrayOpts { seed: number; deltas?: number[]; cols?: number; rows?: number; hard?: boolean; width?: number; height?: number }

export function renderTray(o: TrayOpts): { canvas: HTMLCanvasElement; truth: Truth[] } {
  const rand = rng(o.seed)
  const cols = o.cols ?? 4, rows = o.rows ?? 2
  const W = o.width ?? 1280, H = o.height ?? 800
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H
  const ctx = cv.getContext('2d')!
  // Tray: dark blue-grey with a soft vignette.
  const bg = ctx.createRadialGradient(W * 0.45, H * 0.4, 50, W / 2, H / 2, W * 0.75)
  bg.addColorStop(0, '#3b4a5c'); bg.addColorStop(1, '#1b2430')
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H)
  const n = cols * rows
  const deltas = o.deltas ?? Array.from({ length: n }, () => -10 + rand() * 42)
  const truth: Truth[] = []
  const cellW = W / cols, cellH = H / rows
  const capR = Math.min(cellW, cellH) * 0.36
  for (let i = 0; i < n; i++) {
    const col = i % cols, row = Math.floor(i / cols)
    const cx = cellW * (col + 0.5) + (rand() - 0.5) * cellW * 0.12
    const cy = cellH * (row + 0.5) + (rand() - 0.5) * cellH * 0.12
    const tilt = o.hard ? 0.62 + rand() * 0.38 : 0.82 + rand() * 0.18
    const rot = rand() * Math.PI
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot); ctx.scale(1, tilt)
    // Shadow, then a flip-off cap.
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.arc(capR * 0.08, capR * 0.1, capR * 1.02, 0, Math.PI * 2); ctx.fill()
    const capCols = [['#f4f6f8', '#c9cfd6'], ['#e8f0fa', '#b8c7d9'], ['#f6f3ee', '#d3ccc0']]
    const [c1, c2] = capCols[Math.floor(rand() * capCols.length)]
    const cg = ctx.createRadialGradient(-capR * 0.3, -capR * 0.3, capR * 0.1, 0, 0, capR)
    cg.addColorStop(0, c1); cg.addColorStop(1, c2)
    ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(0, 0, capR, 0, Math.PI * 2); ctx.fill()
    // White VVM sticker, purple circle, inner square.
    const vr = capR * 0.42
    ctx.fillStyle = '#fbfbfa'; ctx.beginPath(); ctx.arc(0, 0, vr * 1.55, 0, Math.PI * 2); ctx.fill()
    const ring = labToRgb(RING[0] + (rand() - 0.5) * 3, RING[1], RING[2])
    ctx.fillStyle = `rgb(${ring})`; ctx.beginPath(); ctx.arc(0, 0, vr, 0, Math.PI * 2); ctx.fill()
    const s = vr * 2 * 0.37
    ctx.rotate(rand() * Math.PI / 2)
    ctx.fillStyle = `rgb(${squareColour(deltas[i])})`; ctx.fillRect(-s / 2, -s / 2, s, s)
    ctx.restore()
    const glare = (o.hard ? rand() < 0.25 : rand() < 0.12)
    if (glare) {
      const gx = cx + (rand() - 0.5) * vr, gy = cy + (rand() - 0.5) * vr
      const gg = ctx.createRadialGradient(gx, gy, 0, gx, gy, vr * (0.6 + rand() * 0.6))
      gg.addColorStop(0, 'rgba(255,255,255,0.95)'); gg.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(gx, gy, vr * 1.2, 0, Math.PI * 2); ctx.fill()
    }
    truth.push({ cx, cy, delta: deltas[i], expected: expectedVerdict(deltas[i]), glare })
  }
  // Uneven light across the tray and a warm or cool cast.
  const ang = rand() * Math.PI * 2, strength = o.hard ? 0.35 : 0.2
  const lg = ctx.createLinearGradient(W / 2 - Math.cos(ang) * W / 2, H / 2 - Math.sin(ang) * H / 2, W / 2 + Math.cos(ang) * W / 2, H / 2 + Math.sin(ang) * H / 2)
  lg.addColorStop(0, `rgba(0,0,0,${strength})`); lg.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = lg; ctx.fillRect(0, 0, W, H)
  ctx.globalCompositeOperation = 'source-over'
  const warm = rand() < 0.5
  ctx.fillStyle = warm ? 'rgba(255,170,60,0.07)' : 'rgba(80,140,255,0.06)'; ctx.fillRect(0, 0, W, H)
  // Sensor noise and a touch of blur.
  const img = ctx.getImageData(0, 0, W, H), d = img.data, sigma = o.hard ? 5 : 3
  for (let i = 0; i < d.length; i += 4) {
    const z = (rand() + rand() + rand() - 1.5) * sigma * 1.4
    d[i] += z; d[i + 1] += z; d[i + 2] += z
  }
  ctx.putImageData(img, 0, 0)
  if (o.hard) { const t = document.createElement('canvas'); t.width = W; t.height = H; const tc = t.getContext('2d')!; tc.filter = 'blur(0.8px)'; tc.drawImage(cv, 0, 0); ctx.clearRect(0, 0, W, H); ctx.drawImage(t, 0, 0) }
  return { canvas: cv, truth }
}

// The demo tray: 8 vials, a realistic spread with 2 past the discard point.
export const DEMO_DELTAS = [28, 19, -3.5, 24, 8.5, 31, 0.8, 15]
