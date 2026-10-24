import './index.css'
import {
  OCTOPUS_SWIM_FRAMES_PER_SECOND,
  OCTOPUS_SWIM_SETTINGS,
  createOctopusSwimRenderer,
} from '@contracts/octopus-swim'

document.documentElement.classList.toggle(
  'dark',
  window.matchMedia('(prefers-color-scheme: dark)').matches,
)

function animateOctopus(image: HTMLImageElement, canvas: HTMLCanvasElement): void {
  const context = canvas.getContext('2d')
  if (!context || image.naturalWidth === 0) return
  const size = canvas.width
  context.drawImage(image, 0, 0, size, size)
  const renderer = createOctopusSwimRenderer({
    source: context.getImageData(0, 0, size, size).data,
    sourceSize: size,
    outputSize: size,
    settings: OCTOPUS_SWIM_SETTINGS,
  })
  const frame = context.createImageData(size, size)
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let animationFrame = 0
  let previousFrame = -1
  let startedAt: number | undefined

  const draw = (timestamp: number): void => {
    startedAt ??= timestamp
    const frameIndex = Math.floor((timestamp - startedAt) * OCTOPUS_SWIM_FRAMES_PER_SECOND / 1000) % renderer.frameCount
    if (frameIndex !== previousFrame) {
      frame.data.set(renderer.renderFrame(frameIndex))
      context.putImageData(frame, 0, 0)
      previousFrame = frameIndex
    }
    animationFrame = requestAnimationFrame(draw)
  }

  function updateMotion(): void {
    cancelAnimationFrame(animationFrame)
    canvas.hidden = reducedMotion.matches
    image.hidden = !reducedMotion.matches
    startedAt = undefined
    previousFrame = -1
    if (!reducedMotion.matches) animationFrame = requestAnimationFrame(draw)
  }

  reducedMotion.addEventListener('change', updateMotion)
  window.addEventListener('pagehide', () => {
    cancelAnimationFrame(animationFrame)
    reducedMotion.removeEventListener('change', updateMotion)
  }, { once: true })
  updateMotion()
}

const icon = document.getElementById('startup-icon')
const animation = document.getElementById('startup-animation')
if (icon instanceof HTMLImageElement && animation instanceof HTMLCanvasElement) {
  if (icon.complete) animateOctopus(icon, animation)
  else icon.addEventListener('load', () => animateOctopus(icon, animation), { once: true })
}
