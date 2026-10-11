// Sends one straightened label to a vision-language model, as the "just ask an AI" baseline.
const MODEL = 'Qwen/Qwen3-VL-30B-A3B-Instruct'
export const PROMPT = 'This is a Vaccine Vial Monitor (VVM) on a vaccine vial: an inner square inside an outer circle. WHO rule: if the inner square is the same colour as or darker than the outer circle, the vaccine must be discarded; if the square is lighter, it can be used. Answer in this exact format: "USE" or "DISCARD", then a dash, then at most 8 words saying whether the square is lighter, the same or darker.'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const image = req.body?.image
  if (typeof image !== 'string' || !image.startsWith('data:image/') || image.length > 1500000) return res.status(400).json({ error: 'bad image' })
  if (!process.env.FEATHERLESS_API_KEY) return res.status(503).json({ error: 'model not configured' })
  try {
    const r = await fetch('https://api.featherless.ai/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.FEATHERLESS_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: 40, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: PROMPT }] }] }),
    })
    const j = await r.json()
    const answer = j?.choices?.[0]?.message?.content?.trim()
    if (!answer) return res.status(502).json({ error: 'no answer' })
    res.json({ answer, model: MODEL })
  } catch { res.status(502).json({ error: 'model unreachable' }) }
}
