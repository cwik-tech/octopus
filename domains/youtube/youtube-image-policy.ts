export const YOUTUBE_SOURCE_IMAGE_MAX_WIDTH_PX = 1_600
export const YOUTUBE_DOCX_IMAGE_MAX_WIDTH_PX = 640

export function assertYoutubeImagePolicy(wordMaximumWidthPx: number): void {
  if (
    wordMaximumWidthPx !== YOUTUBE_DOCX_IMAGE_MAX_WIDTH_PX ||
    wordMaximumWidthPx > YOUTUBE_SOURCE_IMAGE_MAX_WIDTH_PX
  ) {
    throw new Error('YouTube manual image policy is inconsistent.')
  }
}
