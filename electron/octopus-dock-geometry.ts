/**
 * Dock hover geometry for the octopus swim animation.
 *
 * macOS never tells an application that the pointer is over its own Dock tile,
 * and reading the tile's position means going through the accessibility API,
 * which needs a permission grant. The trigger used here is coarser and free:
 * the pointer is somewhere inside the Dock strip. The strip is the gap between
 * a display's full bounds and its work area, which the Dock creates by
 * reserving space along one edge.
 *
 * Kept free of any Electron import so it can be unit tested directly.
 */

export interface DockRectangle {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface DockPoint {
  readonly x: number
  readonly y: number
}

export interface DockDisplayMetrics {
  readonly bounds: DockRectangle
  readonly workArea: DockRectangle
}

/**
 * An auto-hidden Dock reserves no space, so there is no gap to measure. A thin
 * band along the bottom edge stands in for it, which is also where the pointer
 * has to go to reveal it.
 */
export const HIDDEN_DOCK_BAND_POINTS = 4

/**
 * Returns the region of the display that the Dock occupies. The top edge is
 * ignored because that gap is the menu bar, not the Dock.
 */
export function resolveDockHoverStrip(metrics: DockDisplayMetrics): DockRectangle {
  const { bounds, workArea } = metrics
  const left = workArea.x - bounds.x
  const right = bounds.x + bounds.width - (workArea.x + workArea.width)
  const bottom = bounds.y + bounds.height - (workArea.y + workArea.height)

  const widest = Math.max(left, right, bottom)
  if (widest <= 0) {
    return {
      x: bounds.x,
      y: bounds.y + bounds.height - HIDDEN_DOCK_BAND_POINTS,
      width: bounds.width,
      height: HIDDEN_DOCK_BAND_POINTS,
    }
  }

  if (widest === bottom) {
    return {
      x: bounds.x,
      y: workArea.y + workArea.height,
      width: bounds.width,
      height: bottom,
    }
  }

  if (widest === left) {
    return { x: bounds.x, y: workArea.y, width: left, height: workArea.height }
  }

  return { x: workArea.x + workArea.width, y: workArea.y, width: right, height: workArea.height }
}

export function isPointInsideDockStrip(point: DockPoint, strip: DockRectangle): boolean {
  return (
    point.x >= strip.x &&
    point.x < strip.x + strip.width &&
    point.y >= strip.y &&
    point.y < strip.y + strip.height
  )
}
