const fs = require('node:fs')
const { app, safeStorage } = require('electron')

app.setName('pipeline-template')

app.whenReady().then(() => {
  const settings = JSON.parse(
    fs.readFileSync(process.env.PIPELINE_ACQUISITION_SETTINGS_PATH, 'utf8'),
  )
  const encryptedKey = Buffer.from(
    settings.providers['browser-use'].encryptedApiKey,
    'base64',
  )
  const apiKey = safeStorage.decryptString(encryptedKey)
  fs.writeFileSync(process.env.PIPELINE_BROWSER_USE_DECRYPTED_KEY_PATH, apiKey, {
    mode: 0o600,
  })
  app.quit()
}).catch(() => {
  process.exitCode = 1
  app.quit()
})
