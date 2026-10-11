// sRGB (D65) <-> CIELAB. Exact formulas, no lookup tables.

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const gam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
const XN = 0.95047, YN = 1, ZN = 1.08883
const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)
const fi = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27))

export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R = lin(r / 255), G = lin(g / 255), B = lin(b / 255)
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / XN
  const Y = (0.2126729 * R + 0.7151522 * G + 0.0721750 * B) / YN
  const Z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / ZN
  const fx = f(X), fy = f(Y), fz = f(Z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

export function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200
  const X = fi(fx) * XN, Y = fi(fy) * YN, Z = fi(fz) * ZN
  const R = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z
  const G = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z
  const B = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z
  const to = (c: number) => Math.round(Math.min(1, Math.max(0, gam(c))) * 255)
  return [to(R), to(G), to(B)]
}
