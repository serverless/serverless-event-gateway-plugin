const SDK = require('@serverless/event-gateway-sdk')

module.exports = class EGClient extends SDK {
  constructor (config, service, stage) {
    super(config)
    this.service = service
    this.stage = stage
  }

  listServiceEventTypes () {
    return this.listEventTypes({
      'metadata.service': this.service,
      'metadata.stage': this.stage
    })
  }

  createEventType (et) {
    et.metadata = this.metadata()
    return super.createEventType(et)
  }

  updateEventType (et) {
    if (!et.metadata) {
      et.metadata = this.metadata()
    } else {
      const { service, stage } = this.metadata()
      et.metadata.service = service
      et.metadata.stage = stage
    }
    return super.updateEventType(et)
  }

  async listServiceFunctions () {
    try {
      const functions = await this.listFunctions()
      return functions.filter(f => f.functionId.startsWith(`${this.service}-${this.stage}`))
    } catch (err) {
      return []
    }
  }

  async createFunction (fn) {
    try {
      fn.metadata = this.metadata()
      return await super.createFunction(fn)
    } catch (err) {
      throw new Error(`Couldn't register a function ${fn.functionId}. ${err}`)
    }
  }

  async updateFunction (fn) {
    if (!fn.metadata) {
      fn.metadata = this.metadata()
    } else {
      const { service, stage } = this.metadata()
      fn.metadata.service = service
      fn.metadata.stage = stage
    }
    return super.updateFunction(fn)
  }

  async listServiceSubscriptions () {
    try {
      const subscriptions = await this.listSubscriptions()
      return subscriptions.filter(s => s.functionId.startsWith(`${this.service}-${this.stage}`))
    } catch (err) {
      return []
    }
  }

  async subscribe (event) {
    let subscription = {
      functionId: event.functionId,
      path: eventPath(event, this.config.space),
      metadata: this.metadata()
    }

    if (event.event) {
      // legacy mode
      if (event.event === 'http') {
        subscription.type = 'sync'
        subscription.eventType = 'http.request'
        subscription.method = toUpperCase(event.method) || 'GET'
      } else {
        subscription.type = 'async'
        subscription.eventType = event.event
        subscription.method = 'POST'
      }
    } else {
      subscription.type = event.type
      subscription.eventType = event.eventType
      subscription.method = toUpperCase(event.method)
    }

    try {
      return await super.subscribe(subscription)
    } catch (err) {
      if (subscription.type === 'sync' && err.message.includes('already exists')) {
        const msg =
          `Could not subscribe the ${subscription.functionId} function to the '${subscription.path}' ` +
          `endpoint. A subscription for that endpoint and method already ` +
          `exists in another service. Please remove that subscription before ` +
          `registering this subscription.`
        throw new Error(msg)
      } else {
        throw new Error(`Couldn't create subscription for ${subscription.functionId}. ${err}`)
      }
    }
  }

  listServiceCORS () {
    return this.listCORS({
      'metadata.service': this.service,
      'metadata.stage': this.stage
    })
  }

  async createCORSFromSubscription (event) {
    const cors = {
      path: eventPath(event, this.config.space),
      metadata: this.metadata()
    }

    if (event.event === 'http') {
      // legacy mode
      cors.method = toUpperCase(event.method) || 'GET'
    } else {
      cors.method = toUpperCase(event.method) || 'POST'
    }

    if (event.cors && event.cors !== true) {
      cors.allowedOrigins = event.cors.origins
      cors.allowedMethods = event.cors.methods
      cors.allowedHeaders = event.cors.headers
      cors.allowCredentials = event.cors.allowCredentials
    }

    cors.metadata = this.metadata()

    try {
      return await super.createCORS(cors)
    } catch (err) {
      throw new Error(`Couldn't configure CORS for path ${cors.path}. ${err}`)
    }
  }

  updateCORSFromSubscription (event, cors) {
    const updatedCORS = cors

    if (event.cors === true) {
      delete updatedCORS['allowCredentials']
      delete updatedCORS['allowedOrigins']
      delete updatedCORS['allowedHeaders']
      delete updatedCORS['allowedMethods']
    } else {
      updatedCORS.allowedOrigins = event.cors.origins
      updatedCORS.allowedMethods = event.cors.methods
      updatedCORS.allowedHeaders = event.cors.headers
      updatedCORS.allowCredentials = event.cors.allowCredentials
    }

    return this.updateCORS(updatedCORS)
  }

  updateCORS (cors) {
    if (!cors.metadata) {
      cors.metadata = this.metadata()
    } else {
      const { service, stage } = this.metadata()
      cors.metadata.service = service
      cors.metadata.stage = stage
    }
    return super.updateCORS(cors)
  }

  metadata () {
    return {
      service: this.service,
      stage: this.stage
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

function toUpperCase (str) {
  return str instanceof String ? str.toUpperCase() : str
}
