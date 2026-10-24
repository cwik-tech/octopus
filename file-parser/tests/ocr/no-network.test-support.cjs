/**
 * Every outbound network path, closed.
 *
 * Loaded with `--require` so it applies to the main thread and to the `worker_threads.Worker`
 * the recognition engine spawns, which inherits `execArgv` and `NODE_OPTIONS`. The engine's node
 * worker reads `global.fetch || require("node-fetch")`, and `node-fetch` reaches the network
 * through `http`/`https`, so all three are stopped here.
 *
 * An attempt is a thrown error, not a silent failure: recognition that tried to download its
 * language data must fail loudly rather than appear to work.
 */
'use strict'

const refuse = (what) => {
  throw new Error(`NETWORK ACCESS ATTEMPTED: ${what}`)
}

globalThis.fetch = (input) => refuse(`fetch ${String(input)}`)

for (const moduleName of ['http', 'https']) {
  const module = require(moduleName)
  module.request = (...args) => refuse(`${moduleName}.request ${String(args[0])}`)
  module.get = (...args) => refuse(`${moduleName}.get ${String(args[0])}`)
}

const net = require('net')
const originalConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function connect(...args) {
  const options = args[0]
  // Loopback stays open so a local test server is still reachable; anything else is refused.
  const host = typeof options === 'object' && options !== null ? options.host : args[1]
  if (typeof host === 'string' && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    refuse(`net.connect ${host}`)
  }
  if (typeof options === 'string') refuse(`net.connect ${options}`)
  return originalConnect.apply(this, args)
}

const dns = require('dns')
dns.lookup = (hostname) => refuse(`dns.lookup ${String(hostname)}`)
