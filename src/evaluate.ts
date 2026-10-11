// Accuracy test on synthetic trays with known ground truth.
import { analyze, type Reading, type Verdict } from './vision'
import { renderTray, type Truth } from './synth'

export interface EvalResult {
  labels: number; detected: number; rescans: number
  matrix: Record<Verdict, Record<Verdict, number>>   // truth -> predicted
  unsafe: number      // truly DISCARD, called USE or USE FIRST
  wasted: number      // truly USE, called DISCARD
  meanAbsErr: number  // |measured deltaL - true delta| on non-rescan reads
  trays: number
}

const V: Verdict[] = ['USE', 'USE FIRST', 'DISCARD', 'RESCAN']

export async function evaluate(trays: number, hard: boolean, onProgress?: (i: number) => void): Promise<EvalResult> {
  const matrix = Object.fromEntries(V.map((t) => [t, Object.fromEntries(V.map((p) => [p, 0]))])) as EvalResult['matrix']
  let labels = 0, detected = 0, rescans = 0, unsafe = 0, wasted = 0, errSum = 0, errN = 0
  for (let t = 0; t < trays; t++) {
    const { canvas, truth } = renderTray({ seed: 1000 + t * 7 + (hard ? 500000 : 0), hard })
    const img = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
    const reads = analyze(img)
    for (const g of truth) {
      labels++
      const r = match(g, reads)
      if (!r) continue
      detected++
      matrix[g.expected][r.verdict]++
      if (r.verdict === 'RESCAN') { rescans++; continue }
      errSum += Math.abs(r.deltaL - g.delta); errN++
      if (g.expected === 'DISCARD' && r.verdict !== 'DISCARD') { unsafe++; (globalThis as any).__unsafe?.push({ truth: g.delta.toFixed(1), got: r.deltaL.toFixed(1), glare: g.glare, gl: r.glare.toFixed(3), ringStd: r.ringStd.toFixed(1), sqStd: r.squareStd.toFixed(1), edge: r.edge.toFixed(2), tilt: r.tilt.toFixed(2) }) }
      if (g.expected === 'USE' && r.verdict === 'DISCARD') wasted++
    }
    onProgress?.(t + 1)
    if (t % 3 === 2) await new Promise((res) => setTimeout(res, 0))
  }
  return { labels, detected, rescans, matrix, unsafe, wasted, meanAbsErr: errN ? errSum / errN : 0, trays }
}

function match(g: Truth, reads: Reading[]): Reading | undefined {
  let best: Reading | undefined, bd = Infinity
  for (const r of reads) { const d = Math.hypot(r.cx - g.cx, r.cy - g.cy); if (d < bd) { bd = d; best = r } }
  return best && bd < Math.max(best.a, best.b) * 0.8 ? best : undefined
}
