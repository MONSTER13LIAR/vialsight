# VialSight

**Reads the heat label on every vaccine vial.** Point a camera at vials (or upload a photo). VialSight finds every Vaccine Vial Monitor (VVM), measures the inner square against the outer circle, and applies the WHO discard rule, with the number behind every call.

Live: https://vialsight.vercel.app

## The problem
A VVM is a heat-sensitive label on vaccine vials: a square inside a circle. The square darkens with cumulative heat. WHO rule: once the square is the **same colour as or darker than** the circle, the vaccine must be discarded. Health workers judge this by eye, on over a billion labels a year (Temptime/Zebra shipped over 1 billion VVMs in 2021). WHO's own Effective Vaccine Management app "uses a human eye to judge" the VVM. Nothing scans it.

## How it works
No AI model makes the decision. Image processing finds and measures the label; an exact rule decides.

1. **Find**: adaptive threshold, contours and an ellipse fit (OpenCV.js) locate every VVM circle, at any size or rotation.
2. **Straighten**: each ellipse is resampled to a front-on circle, undoing camera tilt.
3. **Measure**: pixels go to CIELAB. The square's centre (r ≤ 0.30 R) is compared with the ring (0.62 R to 0.88 R). Geometry measured from the WHO VVM graphic: square side ≈ 0.37 of the circle diameter.
4. **Self-calibrate**: the circle is the label's own reference colour. A least-squares plane fitted to the ring's lightness cancels uneven light, so no colour card is needed.
5. **Decide**: ΔL* = L*(square) − L*(circle at centre), with a 95% interval (floor ±1.5 L*). Discard when the interval reaches within 2 L* of zero or below. Use first when lighter by under 12 L* (a field convention; WHO defines only the discard point).
6. **Refuse to guess**: glare, uneven light, blur, tilt or an unstable reading returns RESCAN with the reason.
7. **Live mode** tracks each label across frames and averages up to 15 readings.

## Accuracy
Synthetic trays with known ground truth (squares set to known L* offsets, then uneven light, colour cast, tilt, rotation, glare, noise and blur). Run it on the live site under "Accuracy".

| Set | Labels | Unsafe calls (discard read as usable) | Good vials thrown away |
|---|---|---|---|
| Normal | 120 | 0 | 0 |
| Hard | 120 | 0 | 0 |

The three real labels in the WHO VVM graphic are read correctly (USE, DISCARD, DISCARD).

## Why not just ask an AI?
`scripts/baseline.mjs` sends the same labels to Qwen3-VL-30B (via Featherless) at temperature 0. It answered DISCARD for all 8, including near-white squares, and described lighter squares as darker. Results are on the site.

## Stack
Vite + TypeScript, OpenCV.js 4.10 (contours, ellipse fit), hand-written CIELAB and resampling, Canvas 2D. Optional Vercel function for the AI baseline. The scanner itself runs entirely in the browser.

## Limits
Decision support for trained staff. A VVM shows heat exposure, not freezing. Validated on synthetic labels and WHO reference artwork; a field trial on real vials is next.

## Sources
- WHO VVM reading graphic (mirrored by mSupply): https://docs.msupply.org.nz/_media/cold_chain_equipment:vvm_graphic_final_color.pdf
- Zebra/Temptime at DCVMN 2022 (1 billion VVMs in 2021; EVM app uses the human eye): https://dcvmn.org/wp-content/uploads/2022/12/D2-S5-2-Brandon-Ball_Zebra_Final_DCVMN-presentation.pdf

Built for Banana Hacks 2026.
