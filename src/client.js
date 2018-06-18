const SDK = require('@serverless/event-gateway-sdk')

module.exports = class EGClient extends SDK {
  constructor (config, service, stage) {
    super(config)
    this.service = service
    this.stage = stage
  }

  async createFunction (fn) {
    try {
      return await super.createFunction(fn)
    } catch (err) {
      throw new Error(`Couldn't register a function ${fn.functionId}. ${err}`)
    }
  }

  async subscribe (event) {
    const subscribeEvent = {
      functionId: event.functionId,
      event: event.event,
      path: eventPath(event, this.client.config.space),
      cors: event.cors
    }

    if (event.event === 'http') {
      subscribeEvent.method = event.method.toUpperCase() || 'GET'
    }

    try {
      return await super.subscribe(subscribeEvent)
    } catch (err) {
      if (event.event === 'http' && err.message.includes('already exists')) {
        const msg =
          `Could not subscribe the ${event.functionId} function to the '${event.path}' ` +
          `endpoint. A subscription for that endpoint and method already ` +
          `exists in another service. Please remove that subscription before ` +
          `registering this subscription.`
        throw new Error(msg)
      } else {
        throw new Error(`Couldn't create subscriptions for ${event.functionId}. ${err}`)
      }
    }
  }

  async listServiceFunctions () {
    try {
      const functions = await this.listFunctions()
      return functions.filter(f => f.functionId.startsWith(`${this.service}-${this.stage}`))
    } catch (err) {
      return []
    }
  }

  async listServiceSubscriptions () {
    try {
      const subscriptions = await this.listSubscriptions()
      return subscriptions.filter(s => s.functionId.startsWith(`${this.service}-${this.stage}`))
    } catch (err) {
      return []
    }
  }
}

function eventPath (event, space) {
  let path = event.path || '/'

  if (!path.startsWith('/')) {
    path = '/' + path
  }

  return `/${space}${path}`
}
