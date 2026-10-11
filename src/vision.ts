// VialSight measurement pipeline.
// 1. Find VVM outer circles (OpenCV.js contours + ellipse fit).
// 2. Resample each label to a front-on canonical view (undoes tilt and rotation).
// 3. Measure the inner square against the outer circle in CIELAB L*, with the circle's own
//    lighting gradient fitted as a plane, so the label is its own colour reference.
// 4. Apply the WHO rule: discard when the square is the same colour as, or darker than, the circle.
import { rgbToLab } from './color'

declare const cv: any

export type Verdict = 'USE' | 'USE FIRST' | 'DISCARD' | 'RESCAN'

export interface Reading {
  id: number
  cx: number; cy: number          // centre in image pixels
  a: number; b: number            // ellipse semi-axes in image pixels
  angle: number                   // radians, direction of the a-axis
  deltaL: number                  // L*(square) - L*(circle at centre)
  lo: number; hi: number          // 95% interval for deltaL
  squareL: number; ringL: number
  ringGradient: number            // L* change across the circle from the fitted plane
  ringStd: number; squareStd: number
  glare: number                   // share of label pixels lost to glare
  edge: number                    // edge sharpness 0..1
  tilt: number                    // minor/major axis ratio (1 = square-on)
  verdict: Verdict
  reason: string
  crop: ImageData                 // canonical front-on view, CROP x CROP
  frames: number
}

// Thresholds in L* units. The WHO rule fixes only the discard point (square equal or darker);
// the USE FIRST band is a field convention and is tunable.
export const RULES = {
  discardMargin: 2.0,   // a square within 2 L* of the circle counts as "same colour"
  useFirstBelow: 12,    // lighter by less than 12 L*: still usable, use these first
  maxInterval: 9,       // interval wider than this: rescan
  maxGlare: 0.22,
  minEdge: 0.42,
  minTilt: 0.5,
  minRadius: 9,
  maxRingStd: 3.0,     // a clean printed circle is even; glare or shadow makes it uneven
  maxSquareStd: 3.5,
  floor: 1.5,          // never claim better than +/-1.5 L* (print and camera tolerance)
}

export const CROP = 180
const R0 = 64 // canonical circle radius inside the crop
// Geometry measured from the WHO VVM graphic: square side is ~0.37 of the circle diameter,
// so square corners sit at ~0.52 R. Sample the square well inside, the ring well outside.
const SQ_R = 0.3, RING_IN = 0.62, RING_OUT = 0.88, OUT_IN = 1.12, OUT_OUT = 1.32

let ready: Promise<void> | null = null
export function loadOpenCV(): Promise<void> {
  if (ready) return ready
  ready = new Promise((resolve, reject) => {
    if ((window as any).cv?.Mat) return resolve()
    const s = document.createElement('script')
    s.src = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js'
    s.async = true
    s.onload = () => {
      const c = (window as any).cv
      if (c?.Mat) return resolve()
      if (c instanceof Promise) c.then((m: any) => { (window as any).cv = m; resolve() })
      else c.onRuntimeInitialized = () => resolve()
    }
    s.onerror = () => reject(new Error('OpenCV.js failed to load'))
    document.head.appendChild(s)
  })
  return ready
}

interface Ellipse { cx: number; cy: number; a: number; b: number; angle: number }

export function findLabels(img: ImageData): Ellipse[] {
  const src = cv.matFromImageData(img)
  const gray = new cv.Mat(), bin = new cv.Mat()
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
  cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0)
  const minDim = Math.min(img.width, img.height)
  let block = Math.max(15, Math.round(minDim / 10)); if (block % 2 === 0) block++
  cv.adaptiveThreshold(gray, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, block, 8)
  const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3))
  cv.morphologyEx(bin, bin, cv.MORPH_OPEN, k)
  const contours = new cv.MatVector(), hier = new cv.Mat()
  cv.findContours(bin, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_NONE)
  const out: Ellipse[] = []
  const minArea = Math.PI * RULES.minRadius * RULES.minRadius * 0.6
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i)
    const area = cv.contourArea(c)
    if (area < minArea || c.rows < 12) { c.delete(); continue }
    const perim = cv.arcLength(c, true)
    const circularity = (4 * Math.PI * area) / Math.max(1, perim * perim)
    if (circularity < 0.8) { c.delete(); continue } // squares and blobs are not VVM circles
    const r = cv.fitEllipse(c)
    const a = r.size.width / 2, b = r.size.height / 2
    const ellArea = Math.PI * a * b
    const hull = new cv.Mat(); cv.convexHull(c, hull)
    const solidity = area / Math.max(1, cv.contourArea(hull))
    hull.delete(); c.delete()
    const fill = area / ellArea
    const ratio = Math.min(a, b) / Math.max(a, b)
    if (fill < 0.82 || fill > 1.12 || solidity < 0.9 || ratio < 0.35) continue
    if (Math.max(a, b) > minDim * 0.45) continue
    out.push({ cx: r.center.x, cy: r.center.y, a, b, angle: (r.angle * Math.PI) / 180 })
  }
  ;[src, gray, bin, k, hier].forEach((m) => m.delete()); contours.delete()
  return out
}

// Keep one reading per physical label: the candidate with the strongest dark-circle contrast wins.
function dedupe(rs: (Reading & { score: number })[]): Reading[] {
  rs.sort((p, q) => q.score - p.score)
  const kept: (Reading & { score: number })[] = []
  for (const r of rs) {
    if (kept.some((k2) => Math.hypot(k2.cx - r.cx, k2.cy - r.cy) < Math.max(k2.a, k2.b) * 0.6)) continue
    kept.push(r)
  }
  return kept.map(({ score, ...r }) => r)
}

// Bilinear sample of the source image.
function sample(img: ImageData, x: number, y: number): [number, number, number] {
  const w = img.width, h = img.height, d = img.data
  if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return [0, 0, 0]
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0
  const i00 = (y0 * w + x0) * 4, i10 = i00 + 4, i01 = i00 + w * 4, i11 = i01 + 4
  const px = (o: number) =>
    d[i00 + o] * (1 - fx) * (1 - fy) + d[i10 + o] * fx * (1 - fy) + d[i01 + o] * (1 - fx) * fy + d[i11 + o] * fx * fy
  return [px(0), px(1), px(2)]
}

// Resample the ellipse to a front-on circle of radius R0 in a CROP x CROP image.
export function rectify(img: ImageData, e: Ellipse): ImageData {
  const out = new ImageData(CROP, CROP)
  const ca = Math.cos(e.angle), sa = Math.sin(e.angle)
  const c0 = CROP / 2
  for (let v = 0; v < CROP; v++) for (let u = 0; u < CROP; u++) {
    const nu = (u - c0) / R0, nv = (v - c0) / R0
    const x = e.cx + nu * e.a * ca - nv * e.b * sa
    const y = e.cy + nu * e.a * sa + nv * e.b * ca
    const [r, g, b] = sample(img, x, y)
    const i = (v * CROP + u) * 4
    out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b; out.data[i + 3] = 255
  }
  return out
}

interface Measure {
  deltaL: number; se: number; squareL: number; ringL: number; outL: number; squareStd: number
  gradient: number; glare: number; edge: number; ringStd: number
}

export function measure(crop: ImageData): Measure {
  const c0 = CROP / 2, d = crop.data
  const sq: number[] = [], ring: [number, number, number][] = [], outer: number[] = []
  const inEdge: number[] = [], outEdge: number[] = []
  let glare = 0, total = 0
  for (let v = 0; v < CROP; v++) for (let u = 0; u < CROP; u++) {
    const x = (u - c0) / R0, y = (v - c0) / R0, r = Math.hypot(x, y)
    if (r > OUT_OUT) continue
    const i = (v * CROP + u) * 4
    const R = d[i], G = d[i + 1], B = d[i + 2]
    const L = rgbToLab(R, G, B)[0]
    const isGlare = (R > 248 && G > 248 && B > 248) || L > 97
    if (r <= RING_OUT) { total++; if (isGlare) glare++ }
    if (isGlare) continue
    if (r <= SQ_R) sq.push(L)
    else if (r >= RING_IN && r <= RING_OUT) ring.push([x, y, L])
    else if (r >= OUT_IN) outer.push(L)
    if (r >= 0.9 && r <= 0.95) inEdge.push(L)
    if (r >= 1.05 && r <= 1.1) outEdge.push(L)
  }
  // Least-squares plane L = p0 + p1 x + p2 y over the ring. p0 is the circle's L* at the centre.
  let n = ring.length, sx = 0, sy = 0, sl = 0, sxx = 0, syy = 0, sxy = 0, sxl = 0, syl = 0
  for (const [x, y, L] of ring) { sx += x; sy += y; sl += L; sxx += x * x; syy += y * y; sxy += x * y; sxl += x * L; syl += y * L }
  const A = [[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]], bv = [sl, sxl, syl]
  const p = solve3(A, bv) ?? [sl / Math.max(1, n), 0, 0]
  let rv = 0
  for (const [x, y, L] of ring) rv += (L - (p[0] + p[1] * x + p[2] * y)) ** 2
  const ringStd = Math.sqrt(rv / Math.max(1, n - 3))
  const sqSorted = [...sq].sort((a1, b1) => a1 - b1)
  const trim = sqSorted.slice(Math.floor(sqSorted.length * 0.1), Math.ceil(sqSorted.length * 0.9))
  const sqMean = mean(trim), sqStd = std(trim)
  // Neighbouring pixels are correlated after resampling; treat ~1 in 12 as independent.
  const nEff = (k: number) => Math.max(1, k / 12)
  const se = Math.sqrt(sqStd ** 2 / nEff(trim.length) + ringStd ** 2 / nEff(n))
  const outL = median(outer), ringL = p[0]
  const contrast = Math.abs(outL - ringL)
  const edge = contrast > 1 ? Math.min(1, Math.abs(median(outEdge) - median(inEdge)) / contrast) : 0
  return {
    deltaL: sqMean - ringL, se, squareL: sqMean, ringL, outL, squareStd: sqStd,
    gradient: 2 * Math.hypot(p[1], p[2]), glare: total ? glare / total : 0, edge, ringStd,
  }
}

export function decide(deltaL: number, lo: number, hi: number, m: Pick<Reading, 'glare' | 'edge' | 'tilt' | 'a' | 'b' | 'ringStd' | 'squareStd'>): [Verdict, string] {
  if (Math.max(m.a, m.b) < RULES.minRadius) return ['RESCAN', 'Label too small. Move closer.']
  if (m.tilt < RULES.minTilt) return ['RESCAN', 'Camera too tilted. Hold the phone square to the vial.']
  if (m.glare > RULES.maxGlare) return ['RESCAN', 'Glare on the label. Tilt slightly away from the light.']
  if (m.ringStd > RULES.maxRingStd || m.squareStd > RULES.maxSquareStd) return ['RESCAN', 'Uneven light or a reflection on the label. Shade it or change the angle.']
  if (m.edge < RULES.minEdge) return ['RESCAN', 'Image is blurred. Hold still or tap to focus.']
  if (hi - lo > RULES.maxInterval) return ['RESCAN', 'Reading is unstable. Hold still for a second.']
  if (lo <= RULES.discardMargin)
    return ['DISCARD', deltaL <= 0
      ? 'Square is darker than the circle: past the discard point.'
      : 'Square matches the circle: discard point reached.']
  if (lo < RULES.useFirstBelow) return ['USE FIRST', 'Square is still lighter, but darkening. Use this vial first.']
  return ['USE', 'Square is clearly lighter than the circle.']
}

let nextId = 1
export function analyze(img: ImageData): Reading[] {
  const labels = findLabels(img)
  const cands: (Reading & { score: number })[] = []
  for (const e of labels) {
    const crop = rectify(img, e)
    const m = measure(crop)
    // Must look like a VVM: a dark, even circle on a lighter surround.
    if (!(m.outL - m.ringL > 8) || m.ringStd > 14) continue
    const half = Math.max(1.96 * m.se, RULES.floor)
    const lo = m.deltaL - half, hi = m.deltaL + half
    const base = { glare: m.glare, edge: m.edge, tilt: Math.min(e.a, e.b) / Math.max(e.a, e.b), a: e.a, b: e.b, ringStd: m.ringStd, squareStd: m.squareStd }
    const [verdict, reason] = decide(m.deltaL, lo, hi, base)
    cands.push({
      score: m.outL - m.ringL - m.ringStd,
      id: 0, cx: e.cx, cy: e.cy, angle: e.angle, ...base,
      deltaL: m.deltaL, lo, hi, squareL: m.squareL, ringL: m.ringL, ringGradient: m.gradient,
      verdict, reason, crop, frames: 1,
    })
  }
  const readings = dedupe(cands)
  for (const r of readings) r.id = nextId++
  readings.sort((p, q) => (Math.abs(p.cy - q.cy) > 40 ? p.cy - q.cy : p.cx - q.cx))
  return readings
}

// Live camera: merge readings of the same label across frames into a running estimate.
export class Tracker {
  tracks: { r: Reading; deltas: number[]; seen: number }[] = []
  update(frame: Reading[], t: number) {
    for (const r of frame) {
      const tr = this.tracks.find((k) => Math.hypot(k.r.cx - r.cx, k.r.cy - r.cy) < Math.max(r.a, r.b) * 0.7)
      if (tr) {
        tr.deltas.push(r.deltaL); if (tr.deltas.length > 15) tr.deltas.shift()
        tr.seen = t; tr.r = { ...r, id: tr.r.id }
      } else this.tracks.push({ r, deltas: [r.deltaL], seen: t })
    }
    this.tracks = this.tracks.filter((k) => t - k.seen < 900)
    return this.tracks.map((k) => {
      const n = k.deltas.length, mu = mean(k.deltas)
      const half = n > 2 ? Math.max(1.96 * std(k.deltas) / Math.sqrt(n), RULES.floor) : k.r.hi - k.r.deltaL
      const [verdict, reason] = n < 4 && k.r.verdict !== 'RESCAN' ? (['RESCAN', 'Measuring… hold steady.'] as [Verdict, string]) : decide(mu, mu - half, mu + half, k.r)
      return { ...k.r, deltaL: mu, lo: mu - half, hi: mu + half, verdict, reason, frames: n }
    })
  }
}

function solve3(A: number[][], b: number[]): number[] | null {
  const M = A.map((row, i) => [...row, b[i]])
  for (let c = 0; c < 3; c++) {
    let piv = c
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r
    if (Math.abs(M[piv][c]) < 1e-9) return null
    ;[M[c], M[piv]] = [M[piv], M[c]]
    for (let r = 0; r < 3; r++) if (r !== c) {
      const f = M[r][c] / M[c][c]
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k]
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]]
}
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0)
const std = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)) }
const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
