/** Portable, font-independent collision filtering for synthetic label boxes. */
export type LabelBox = Readonly<{ x: number; y: number; width: number; height: number }>;
export type LabelCollisionResult =
  | Readonly<{ ok: true; accepted: readonly number[]; rejected: readonly number[] }>
  | Readonly<{ ok: false; code: 'INPUT' | 'LIMIT' }>;

const MAX_BOXES = 4096;
type Extents = Readonly<{ x: number; y: number; right: number; bottom: number }>;

/**
 * Greedily retain candidates in caller order. Earlier accepted labels take
 * precedence; rejected labels never block later candidates. Boxes use
 * half-open axis-aligned extents: touching edges/corners do not collide.
 *
 * Coordinates and extents are finite, widths and heights strictly positive,
 * and every candidate is validated before any selection is made. Outputs
 * are stable input indices; no caller-owned object or array is mutated.
 */
export function selectNonOverlappingLabels(
  boxes: readonly LabelBox[], maxBoxes = MAX_BOXES,
): LabelCollisionResult {
  if (!Array.isArray(boxes) || !Number.isSafeInteger(maxBoxes) || maxBoxes < 1) {
    return { ok: false, code: 'INPUT' };
  }
  if (maxBoxes > MAX_BOXES || boxes.length > maxBoxes) return { ok: false, code: 'LIMIT' };

  const extents: Extents[] = [];
  for (const box of boxes) {
    if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y) ||
        !Number.isFinite(box.width) || !Number.isFinite(box.height) ||
        box.width <= 0 || box.height <= 0) return { ok: false, code: 'INPUT' };
    const right = box.x + box.width;
    const bottom = box.y + box.height;
    if (!Number.isFinite(right) || !Number.isFinite(bottom) ||
        right <= box.x || bottom <= box.y) return { ok: false, code: 'LIMIT' };
    extents.push({ x: box.x, y: box.y, right, bottom });
  }

  const accepted: number[] = [];
  const rejected: number[] = [];
  for (let i = 0; i < extents.length; i++) {
    const candidate = extents[i];
    const collision = accepted.some(j => {
      const prior = extents[j];
      return candidate.x < prior.right && candidate.right > prior.x &&
        candidate.y < prior.bottom && candidate.bottom > prior.y;
    });
    if (collision) rejected.push(i);
    else accepted.push(i);
  }
  return { ok: true, accepted, rejected };
}
