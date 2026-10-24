import { useEffect, useState } from 'react'
import { loadArtifactImage } from '@/lib/clients/artifact-image-loader'

export function ArtifactMarkdownImage({ url, alt, title }: { url: string; alt: string; title?: string | undefined }) {
  const [image, setImage] = useState<{ url: string; objectUrl?: string; failed?: boolean }>()
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl: string | undefined
    // Cleanup owns cancellation and every object URL created by this effect.
    void loadArtifactImage(url, controller.signal).then((blob) => {
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(blob)
      setImage({ url, objectUrl })
    }).catch(() => {
      if (!controller.signal.aborted) setImage({ url, failed: true })
    })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [url])
  if (image?.url === url && image.objectUrl) return <img src={image.objectUrl} alt={alt} title={title} />
  return <span role="img" aria-label={alt}>{image?.url === url && image.failed ? `Image unavailable: ${alt}` : `Loading image: ${alt}`}</span>
}
