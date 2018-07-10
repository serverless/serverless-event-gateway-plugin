const SDK = require('@serverless/event-gateway-sdk')

module.exports = class EGClient extends SDK {
  constructor (config, service, stage) {
    super(config)
    this.service = service
    this.stage = stage
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

  async subscribeAndCreateCORS (event) {
    const toUpperCase = str => (str instanceof String ? str.toUpperCase() : str)

    let subscribeEvent = {
      functionId: event.functionId,
      path: eventPath(event, this.config.space)
    }

    if (event.event) {
      // legacy mode
      if (event.event === 'http') {
        subscribeEvent.type = 'sync'
        subscribeEvent.eventType = 'http.request'
        subscribeEvent.method = toUpperCase(event.method) || 'GET'
      } else {
        subscribeEvent.type = 'async'
        subscribeEvent.eventType = event.event
        subscribeEvent.method = 'POST'
      }
    } else {
      subscribeEvent.type = event.type
      subscribeEvent.eventType = event.eventType
      subscribeEvent.method = toUpperCase(event.method)
    }

    let cors
    if (event.cors === true) {
      cors = {
        path: subscribeEvent.path,
        method: subscribeEvent.method,
        metadata: this.metadata()
      }
    } else {
      if (event.cors) {
        cors = {
          path: subscribeEvent.path,
          method: subscribeEvent.method,
          allowedOrigins: event.cors.origins,
          allowedMethods: event.cors.methods,
          allowedHeaders: event.cors.headers,
          allowCredentials: event.cors.allowCredentials,
          metadata: this.metadata()
        }
      }
    }

    try {
      subscribeEvent.metadata = this.metadata()
      await super.subscribe(subscribeEvent)
    } catch (err) {
      if (subscribeEvent.type === 'sync' && err.message.includes('already exists')) {
        const msg =
          `Could not subscribe the ${subscribeEvent.functionId} function to the '${subscribeEvent.path}' ` +
          `endpoint. A subscription for that endpoint and method already ` +
          `exists in another service. Please remove that subscription before ` +
          `registering this subscription.`
        throw new Error(msg)
      } else {
        throw new Error(`Couldn't create subscription for ${subscribeEvent.functionId}. ${err}`)
      }
    }

    if (cors) {
      try {
        await super.createCORS(cors)
      } catch (err) {
        throw new Error(`Couldn't configure CORS for path ${subscribeEvent.path}. ${err}`)
      }
    }
  }

  unsubscribeAndDeleteCORS (subscription) {
    return Promise.all([
      super.unsubscribe({ subscriptionId: subscription.subscriptionId }),
      super
        .listCORS()
        .then(list => list.find(c => c.path === subscription.path && c.method === subscription.method))
        .then(cors => cors && super.deleteCORS({ corsId: cors.corsId }))
    ])
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

  listServiceEventTypes () {
    return this.listEventTypes({
      'metadata.service': this.service,
      'metadata.stage': this.stage
    })
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
