/**
 * Local-only mode: the parser never sends content to an outside model, whatever the environment
 * says. OCR stays on, because it runs here with the bundled language file.
 *
 * The CLI imports this module before any other, so `--local-only` is in force before the rest of
 * the parser is even loaded. The flag sets the variable; it never clears one set by the caller.
 */
import { LOCAL_ONLY_ENV } from './lm/llm-model.js'

export { LOCAL_ONLY_ENV }

export const LOCAL_ONLY_FLAG = '--local-only'

if (process.argv.slice(2).includes(LOCAL_ONLY_FLAG)) {
  process.env[LOCAL_ONLY_ENV] = '1'
}
