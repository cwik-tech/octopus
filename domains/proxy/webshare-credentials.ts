import { z } from 'zod'

/**
 * Parses the credential response from the Webshare configuration API.
 *
 * This is untrusted external input, so it is validated rather than cast. Both
 * field spellings the API has used are accepted, and the unprefixed pair wins
 * when a response carries both.
 */

const nonEmpty = z.string().transform((value) => value.trim()).pipe(z.string().min(1))

const responseSchema = z
  .object({
    username: nonEmpty.optional(),
    password: nonEmpty.optional(),
    proxy_username: nonEmpty.optional(),
    proxy_password: nonEmpty.optional(),
  })
  .transform((value, context) => {
    const username = value.username ?? value.proxy_username
    const password = value.password ?? value.proxy_password
    if (!username || !password) {
      context.addIssue({ code: 'custom', message: 'missing credentials' })
      return z.NEVER
    }
    return { username, password }
  })

/** The schema is the single source of truth for this shape. */
export type WebshareCredentials = z.infer<typeof responseSchema>

export function parseWebshareCredentials(payload: unknown): WebshareCredentials {
  const parsed = responseSchema.safeParse(payload)
  if (!parsed.success) {
    throw new Error('Webshare did not return proxy credentials.')
  }
  return parsed.data
}
