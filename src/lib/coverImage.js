// Prepares a picked image as a book cover, in the browser: two WebP
// renditions sized for where covers appear — "lg" 600 px wide (the book
// page, sharp on 2x screens) and "sm" 200 px (lists, the home page) — plus
// the image's main color for the placeholder shown while it loads. A plain
// margin around the cover (product photos, scans) is cut away first. A phone
// photo of several MB becomes a few dozen KB. Orientation from the camera
// (EXIF) is applied. Browsers that cannot encode WebP fall back to JPEG.

export const ACCEPTED = 'image/jpeg,image/png,image/webp,image/gif,image/avif,image/bmp';
const MAX_INPUT = 25 * 1024 * 1024;
const WIDTHS = { lg: 600, sm: 200 };
const MAX_OUTPUT = { lg: 1.4 * 1024 * 1024, sm: 380 * 1024 };

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Halves the image repeatedly before the last step: one big jump down
// (e.g. 4000 → 200 px) looks jagged even with high-quality smoothing.
function scaled(source, width) {
  let w = source.width;
  let h = source.height;
  let current = source;
  while (w / 2 >= width) {
    w = Math.round(w / 2);
    h = Math.round(h / 2);
    const step = canvas(w, h);
    const ctx = step.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(current, 0, 0, w, h);
    current = step;
  }
  const height = Math.round((source.height / source.width) * width);
  const out = canvas(width, height);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  // transparent PNGs get a white page behind them
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(current, 0, 0, width, height);
  return out;
}

// Product photos and scans often put the cover on a plain margin (white
// studio background, scanner bed). Rows and columns along the edges that
// are all the same color as the corners are cut away, so the cover itself
// fills the frame. The search runs on a small copy; the cut is applied to
// the full image. Returns the source unchanged when there is no plain
// margin worth removing (or the corners disagree: no uniform background).
const TRIM_TOLERANCE = 28; // max channel difference still counted as "background"
function trimBorders(source) {
  const scale = Math.min(1, 400 / Math.max(source.width, source.height));
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));
  const probe = canvas(w, h).getContext('2d', { willReadFrequently: true });
  probe.fillStyle = '#ffffff';
  probe.fillRect(0, 0, w, h);
  probe.drawImage(source, 0, 0, w, h);
  const px = probe.getImageData(0, 0, w, h).data;
  const at = (x, y) => { const i = (y * w + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
  const corners = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)];
  const bg = corners[0];
  const near = (c) => Math.max(Math.abs(c[0] - bg[0]), Math.abs(c[1] - bg[1]), Math.abs(c[2] - bg[2])) <= TRIM_TOLERANCE;
  if (!corners.every(near)) return source;
  // a line is margin when (almost) every pixel on it is background
  const plainRow = (y) => { let off = 0; for (let x = 0; x < w; x += 1) if (!near(at(x, y))) off += 1; return off <= w * 0.01; };
  const plainCol = (x) => { let off = 0; for (let y = 0; y < h; y += 1) if (!near(at(x, y))) off += 1; return off <= h * 0.01; };
  let top = 0; while (top < h - 1 && plainRow(top)) top += 1;
  let bottom = h - 1; while (bottom > top && plainRow(bottom)) bottom -= 1;
  let left = 0; while (left < w - 1 && plainCol(left)) left += 1;
  let right = w - 1; while (right > left && plainCol(right)) right -= 1;
  const cw = right - left + 1;
  const ch = bottom - top + 1;
  // nothing to gain, or so much that it is probably not a margin at all
  if (cw * ch > w * h * 0.95 || cw < w * 0.2 || ch < h * 0.2) return source;
  // back to full resolution, keeping a hairline of the margin
  const pad = 1;
  const sx = Math.max(0, Math.floor((left - pad) / scale));
  const sy = Math.max(0, Math.floor((top - pad) / scale));
  const sw = Math.min(source.width - sx, Math.ceil((cw + pad * 2) / scale));
  const sh = Math.min(source.height - sy, Math.ceil((ch + pad * 2) / scale));
  const out = canvas(sw, sh);
  out.getContext('2d').drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
  return out;
}

const toBlob = (c, type, quality) => new Promise((resolve) => c.toBlob(resolve, type, quality));

async function encode(c, maxBytes) {
  for (const quality of [0.82, 0.72, 0.6, 0.5]) {
    let blob = await toBlob(c, 'image/webp', quality);
    if (!blob || blob.type !== 'image/webp') blob = await toBlob(c, 'image/jpeg', quality + 0.05);
    if (blob && blob.size <= maxBytes) return blob;
  }
  throw new Error('Ảnh quá chi tiết, không nén được xuống kích thước cho phép.');
}

// The average color of the image, as #rrggbb.
function mainColor(source) {
  const c = canvas(12, 18);
  const ctx = c.getContext('2d');
  ctx.drawImage(source, 0, 0, 12, 18);
  const px = ctx.getImageData(0, 0, 12, 18).data;
  let r = 0; let g = 0; let b = 0; let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 128) continue;
    r += px[i]; g += px[i + 1]; b += px[i + 2]; n += 1;
  }
  if (!n) return '#d9d4c7';
  const hex = (v) => Math.round(v / n).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// { lg, sm, color, width, height, preview } from a File or Blob.
export async function prepareCover(file) {
  if (!file) throw new Error('Chưa chọn ảnh.');
  if (!/^image\//.test(file.type)) throw new Error('Hãy chọn một file ảnh (JPEG, PNG, WebP…).');
  if (file.size > MAX_INPUT) throw new Error('Ảnh lớn hơn 25 MB.');
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('Trình duyệt không đọc được ảnh này (HEIC/RAW?). Hãy đổi sang JPEG hoặc PNG.');
  }
  try {
    const image = trimBorders(bitmap);
    if (image.width < 120 || image.height < 160) throw new Error('Ảnh quá nhỏ để làm bìa (cần tối thiểu 120×160 px).');
    // Covers are shown in a 2:3 frame (object-fit: cover); a moderately
    // different shape is cropped a little, a very different one is refused.
    const ratio = image.height / image.width;
    if (ratio < 0.6 || ratio > 2.5) throw new Error('Ảnh quá ngang hoặc quá dọc để làm bìa (nên dọc, khoảng 2:3).');
    const out = {};
    for (const [size, width] of Object.entries(WIDTHS)) {
      out[size] = await encode(scaled(image, Math.min(width, image.width)), MAX_OUTPUT[size]);
    }
    return { ...out, color: mainColor(image), width: image.width, height: image.height, trimmed: image !== bitmap, preview: URL.createObjectURL(out.lg) };
  } finally {
    bitmap.close?.();
  }
}
