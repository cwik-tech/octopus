const fs = require('node:fs')
const { app, safeStorage } = require('electron')

app.setName(process.env.PIPELINE_YOUTUBE_KEYCHAIN_APP_NAME || 'pipeline-template')

app.whenReady().then(() => {
  const settings = JSON.parse(fs.readFileSync(process.env.PIPELINE_YOUTUBE_SETTINGS_PATH, 'utf8'))
  const encryptedKey = Buffer.from(settings.encryptedGeminiApiKey, 'base64')
  const apiKey = safeStorage.decryptString(encryptedKey)
  fs.writeFileSync(process.env.PIPELINE_YOUTUBE_DECRYPTED_KEY_PATH, apiKey, { mode: 0o600 })
  app.quit()
}).catch(() => {
  process.exitCode = 1
  app.quit()
})
