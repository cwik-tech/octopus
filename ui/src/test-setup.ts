import '@testing-library/jest-dom'

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => undefined
}

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}
