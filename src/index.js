const merge = require('lodash.merge')
const isEqual = require('lodash.isequal')
const chalk = require('chalk')
const Table = require('cli-table')
const uuidv4 = require('uuid/v4')
const Client = require('./client')

class EGPlugin {
  constructor (serverless, options) {
    this.serverless = serverless
    this.options = options
    this.awsProvider = this.serverless.getProvider('aws')

    this.hooks = {
      'package:initialize': this.prepareFunctions.bind(this),
      'package:compileEvents': this.addUserResource.bind(this),
      'before:deploy:finalize': this.configureEventGateway.bind(this),
      'remove:remove': this.remove.bind(this),
      'gateway:gateway': () => {
        this.serverless.cli.generateCommandsHelp(['gateway'])
      },
      'gateway:emit:emit': this.emitEvent.bind(this),
      'gateway:dashboard:dashboard': this.printDashboard.bind(this)
    }

    this.commands = {
      gateway: {
        usage: 'Interact with the Event Gateway',
        lifecycleEvents: ['gateway'],
        commands: {
          emit: {
            usage: 'Emit event to hosted Event Gateway',
            lifecycleEvents: ['emit'],
            options: {
              event: {
                usage: 'Event you want to emit',
                required: true,
                shortcut: 'e'
              },
              data: {
                usage: 'Data for the event you want to emit',
                required: true,
                shortcut: 'd'
              }
            }
          },
          dashboard: {
            usage: 'Show functions and subscriptions in Space for Event Gateway',
            lifecycleEvents: ['dashboard']
          }
        }
      }
    }

    this.functions = {}

    // Connector functions variables
    this.requiredIAMPolicies = {}
    this.connectorFunctionsOutputs = {}
  }

  setupClient () {
    let url, accessKey, space, configurationUrl, domain

    // Load variables based on app and tenant
    domain = 'slsgateway.com'
    if (process.env.SERVERLESS_PLATFORM_STAGE && process.env.SERVERLESS_PLATFORM_STAGE !== 'prod') {
      domain = `eventgateway-dev.io`
    }

    if (this.serverless.service.app && this.serverless.service.tenant) {
      url = `${this.serverless.service.tenant}-${this.serverless.service.app}.${domain}`
    }

    if (this.serverless.utils.getLocalAccessKey) {
      accessKey = this.serverless.utils.getLocalAccessKey()
    }

    // Load explicit values from sls.yaml configuration
    if (this.serverless.service.custom && this.serverless.service.custom.eventgateway) {
      url = this.serverless.service.custom.eventgateway.url || url
      space = this.serverless.service.custom.eventgateway.space
      configurationUrl = this.serverless.service.custom.eventgateway.configurationUrl
      accessKey = this.serverless.service.custom.eventgateway.accessKey || accessKey
    }

    // Event Gateway Service Client
    this.client = new Client(
      {
        url,
        configurationUrl,
        space,
        accessKey
      },
      this.serverless.service.service,
      this.awsProvider.getStage()
    )
  }

  prepareFunctions () {
    const eventTypes = this.definedEventTypes()

    for (let key in this.serverless.service.functions) {
      if (!this.serverless.service.functions.hasOwnProperty(key)) continue
      const func = this.serverless.service.functions[key]

      // function is not subscribed nor is an authorizer
      if (!func.events.find(event => event.eventgateway) && !eventTypes.find(et => et.authorizer === func.name)) {
        continue
      }

      if (func.type) {
        // validate connector function
        if (!func.inputs) throw new Error(`No inputs provided for ${func.type} function "${key}".`)

        if (!['awsfirehose', 'awskinesis', 'awssqs'].includes(func.type)) {
          throw new Error(`Unrecognised type "${func.type}" for function "${key}"`)
        }

        const { resourceName, action } = this.connectorFunctionNames(key, func.type)
        if (
          !(
            func.inputs.hasOwnProperty('logicalId') ||
            (func.inputs.hasOwnProperty('arn') && func.inputs.hasOwnProperty(resourceName))
          )
        ) {
          throw new Error(
            `Invalid inputs for ${func.type} function "${key}". ` +
              `You provided ${
                Object.keys(func.inputs).length
                  ? Object.keys(func.inputs)
                    .map(i => `"${i}"`)
                    .join(', ')
                  : 'none'
              }. ` +
              `Please provide either "logicalId" or both "arn" and "${resourceName}" inputs.`
          )
        }

        if (func.inputs.hasOwnProperty('logicalId')) {
          if (!this.serverless.service.resources.Resources.hasOwnProperty(func.inputs.logicalId)) {
            throw new Error(
              `Could not find resource "${func.inputs.logicalId}" in "resources" block for "${key}" function.`
            )
          }
          this.requiredIAMPolicies[func.inputs.logicalId] = {
            Effect: 'Allow',
            Action: [action],
            Resource: { 'Fn::GetAtt': [func.inputs.logicalId, 'Arn'] }
          }
          this.connectorFunctionsOutputs = Object.assign(
            this.connectorFunctionsOutputs,
            this.connectorFunctionOutput(key, func.type, { logicalId: func.inputs.logicalId })
          )
        } else if (func.inputs.hasOwnProperty('arn')) {
          this.requiredIAMPolicies[func.inputs.arn] = {
            Effect: 'Allow',
            Action: [action],
            Resource: func.inputs.arn
          }
          this.connectorFunctionsOutputs = Object.assign(
            this.connectorFunctionsOutputs,
            this.connectorFunctionOutput(key, func.type, { arn: func.inputs.arn })
          )
        }

        delete this.serverless.service.functions[key]
      }

      this.functions[key] = Object.assign({}, func)
    }
  }

  async configureEventGateway () {
    this.serverless.cli.consoleLog('')
    this.serverless.cli.consoleLog(chalk.yellow.underline('Event Gateway Plugin'))

    this.setupClient()

    const definedFunctions = this.definedFunctions(await this.fetchStackOutputs())

    // register event type before creating subscriptions
    let registeredEventTypes = await this.client.listServiceEventTypes()
    await this.registerEventTypes(registeredEventTypes, definedFunctions)

    // create, update or delete functions
    let registeredFunctions = await this.client.listServiceFunctions()
    let registeredSubscriptions = await this.client.listServiceSubscriptions()
    let registeredCORS = await this.client.listServiceCORS()
    let functionsToRegister = {} // new functions have to be registered after cleanup otherwise subscription can conflict
    await Promise.all(
      Object.keys(definedFunctions).map(async key => {
        const definedFunction = definedFunctions[key]
        const registeredFunction = registeredFunctions.find(f => f.functionId === definedFunction.functionId)
        if (!registeredFunction) {
          functionsToRegister[key] = definedFunction
        } else {
          registeredFunctions = registeredFunctions.filter(f => f.functionId !== definedFunction.functionId)
          await this.updateFunction(key, definedFunction, registeredFunction, registeredSubscriptions, registeredCORS)
        }

        await this.updateEventTypesAuthorizers(definedFunction.functionId)
      })
    )

    await this.cleanupFunctionsAndSubscriptions(registeredFunctions, registeredSubscriptions, registeredEventTypes)
    await this.registerFunctions(functionsToRegister)
    await this.cleanupEventTypes(registeredEventTypes, definedFunctions)
    await this.cleanupCORS(registeredCORS)
  }

  registerFunctions (functionsToRegister) {
    return Promise.all(
      Object.keys(functionsToRegister).map(key => {
        return this.registerFunction(key, functionsToRegister[key])
      })
    )
  }

  async registerFunction (key, fn) {
    await this.client.createFunction({ functionId: fn.functionId, type: fn.type, provider: fn.provider })
    this.serverless.cli.consoleLog(`EventGateway: Function "${key}" registered. (ID: ${fn.functionId})`)

    for (let event of fn.events) {
      await this.client.subscribe(event)
      this.serverless.cli.consoleLog(
        `EventGateway: Function "${key}" subscribed to "${event.event || event.eventType}" event.`
      )

      if (event.cors) {
        await this.client.createCORSFromSubscription(event)
      }
    }
  }

  async updateFunction (key, fn, existingFn, registeredSubscriptions, registeredCORS) {
    if (!this.areFunctionsEqual(fn, existingFn)) {
      await this.client.updateFunction({
        functionId: fn.functionId,
        type: fn.type,
        provider: fn.provider
      })
      this.serverless.cli.consoleLog(`EventGateway: Function "${key}" updated. (ID: ${fn.functionId})`)
    }

    let subscriptions = registeredSubscriptions.filter(s => s.functionId === fn.functionId)
    for (let event of fn.events) {
      let subscription = subscriptions.find(existing => this.areSubscriptionsEqual(event, existing))

      if (!subscription) {
        subscription = await this.client.subscribe(event)
        this.serverless.cli.consoleLog(
          `EventGateway: Function "${key}" subscribed to "${event.event || event.eventType}" event.`
        )
      } else {
        subscriptions = subscriptions.filter(s => s.subscriptionId !== subscription.subscriptionId)
      }

      if (event.cors) {
        const cors = registeredCORS.find(c => c.method === subscription.method && c.path === subscription.path)
        if (!cors) {
          await this.client.createCORSFromSubscription(event)
        } else {
          await this.client.updateCORSFromSubscription(event, cors)
        }
      }

      registeredCORS = registeredCORS.filter(c => !(c.method === subscription.method && c.path === subscription.path))
    }

    // cleanup subscription that are not needed
    await Promise.all(
      subscriptions.map(sub =>
        this.client
          .unsubscribe(sub)
          .then(() =>
            this.serverless.cli.consoleLog(
              `EventGateway: Function "${key}" unsubscribed from "${sub.event || sub.eventType}" event.`
            )
          )
      )
    )
  }

  updateEventTypesAuthorizers (key) {
    return Promise.all(
      this.definedEventTypes()
        .filter(et => et.authorizer === key)
        .map(et => {
          return this.client.updateEventType({
            name: et.name,
            authorizerId: et.authorizer
          })
        })
    )
  }

  // cleanup function and subscription no longer defined in serverless.yaml
  async cleanupFunctionsAndSubscriptions (functionsToDelete, registeredSubscriptions, registeredEventTypes) {
    for (let functionToDelete of functionsToDelete) {
      const subscriptionsToDelete = registeredSubscriptions.filter(s => s.functionId === functionToDelete.functionId)

      await Promise.all(
        subscriptionsToDelete.map(subscriptionToDelete => this.client.unsubscribe(subscriptionToDelete))
      )

      const eventTypeWithAuth = registeredEventTypes.find(et => et.authorizerId === functionToDelete.functionId)
      if (eventTypeWithAuth) {
        // temporary remove authorizer, the event type will be deleted in the next step
        await this.client.updateEventType({ name: eventTypeWithAuth.name })
      }

      await this.client.deleteFunction({ functionId: functionToDelete.functionId })
      this.serverless.cli.consoleLog(
        `EventGateway: Function "${functionToDelete.functionId}" and it's subscriptions deleted.`
      )
    }
  }

  async cleanupCORS (registeredCORS) {
    return Promise.all(registeredCORS.map(cors => this.client.deleteCORS({ corsId: cors.corsId })))
  }

  async remove () {
    this.setupClient()
    this.serverless.cli.consoleLog('')
    this.serverless.cli.consoleLog(chalk.yellow.underline('Event Gateway Plugin'))

    const subscriptions = await this.client.listServiceSubscriptions()
    const unsubList = subscriptions.map(sub =>
      this.client.unsubscribe(sub).then(() => {
        this.serverless.cli.consoleLog(
          `EventGateway: Subscription "${sub.eventType}" removed from function: ${sub.functionId}`
        )
      })
    )
    await Promise.all(unsubList)

    const eventTypes = await this.client.listEventTypes()
    const deleteTypesList = eventTypes.map(etype =>
      this.client.deleteEventType({ name: etype.name }).then(() => {
        this.serverless.cli.consoleLog(`EventGateway: Event Type "${etype.name}" removed.`)
      })
    )
    await Promise.all(deleteTypesList)

    const functions = await this.client.listServiceFunctions()
    const deleteFuncList = functions.map(func =>
      this.client.deleteFunction({ functionId: func.functionId }).then(() => {
        this.serverless.cli.consoleLog(`EventGateway: Function "${func.functionId}" removed.`)
      })
    )
    await Promise.all(deleteFuncList)
  }

  // event typed defined in custom section
  definedEventTypes () {
    if (this.serverless.service.custom && this.serverless.service.custom.eventTypes) {
      return Object.keys(this.serverless.service.custom.eventTypes).map(name => {
        const eventTypes = this.serverless.service.custom.eventTypes
        let authorizer

        if (eventTypes[name]) {
          const authorizerName = eventTypes[name].authorizer
          if (authorizerName) {
            if (this.serverless.service.functions[authorizerName]) {
              authorizer = this.serverless.service.functions[authorizerName].name
            } else {
              throw new Error(`Authorizer function "${authorizerName}" is not defined.`)
            }
          }
        }

        return { name, authorizer }
      })
    }
    return []
  }

  // event types used by subscriptions but not defined in custom section
  usedEventTypes (definedFunctions) {
    const definedTypes = this.definedEventTypes()

    const names = {}
    Object.keys(definedFunctions).forEach(key => {
      const localFunction = definedFunctions[key]
      localFunction.events.forEach(event => {
        if (event.eventType) {
          names[event.eventType] = true
        }
        if (event.event) {
          if (event.event === 'http') {
            names['http.request'] = true
          } else {
            names[event.event] = true
          }
        }
      })
    })

    const usedTypes = []
    Object.keys(names).forEach(name => {
      const definedType = definedTypes.find(t => t.name === name)
      if (!definedType) {
        usedTypes.push({ name })
      }
    })

    return usedTypes
  }

  // register event types defined explicitly in serverless.yaml or used by subscription
  async registerEventTypes (registeredTypes, definedFunctions) {
    const definedTypes = this.definedEventTypes()

    await Promise.all(
      definedTypes.map(async definedType => {
        const registeredType = registeredTypes.find(et => et.name === definedType.name)
        if (!registeredType) {
          try {
            await this.client.createEventType({ name: definedType.name })
            this.serverless.cli.consoleLog(`EventGateway: Event Type "${definedType.name}" created.`)
          } catch (err) {
            // if event type already exists and it has no metadata assign it to the current service
            if (err.message.includes('already exists')) {
              const eventTypes = await this.client.listEventTypes()
              const eventType = eventTypes.find(et => et.name === definedType.name)
              if (eventType && !eventType.metadata) {
                await this.client.updateEventType(eventType)
              }
            }
          }
        }
      })
    )

    const usedTypes = this.usedEventTypes(definedFunctions)
    await Promise.all(
      usedTypes.map(async usedType => {
        try {
          await this.client.createEventType({ name: usedType.name })
          this.serverless.cli.consoleLog(`EventGateway: Event Type "${usedType.name}" created.`)
        } catch (err) {
          // ignore already existing event type
          if (!err.message.includes('already exists')) {
            throw err
          }
        }
      })
    )
  }

  // cleanup event types defined in EG not in the serverless.yaml
  async cleanupEventTypes (registeredTypes, definedFunctions) {
    const definedTypes = this.definedEventTypes()
    let toRemove = registeredTypes.filter(registeredType => !definedTypes.find(et => et.name === registeredType.name))

    const usedTypes = this.usedEventTypes(definedFunctions)
    toRemove = toRemove.filter(registeredType => {
      const isUsed = usedTypes.find(t => t.name === registeredType.name)
      return !isUsed
    })

    await Promise.all(
      toRemove.map(async eventType => {
        await this.client.deleteEventType({ name: eventType.name })
        this.serverless.cli.consoleLog(`EventGateway: Event Type "${eventType.name}" deleted.`)
      })
    )
  }

  // returns EG function definitions
  definedFunctions (outputs) {
    const funcs = {}

    Object.keys(this.functions).map(key => {
      const rawFunc = this.functions[key]
      const func = {
        functionId: rawFunc.name,
        type: rawFunc.type || 'awslambda',
        provider: {
          region: this.awsProvider.getRegion(),
          awsAccessKeyId: outputs.EventGatewayUserAccessKey,
          awsSecretAccessKey: outputs.EventGatewayUserSecretKey
        }
      }

      if (func.type === 'awslambda') {
        // remove the function version from the ARN so that it always uses the latest version.
        const outputKey = this.awsProvider.naming.getLambdaVersionOutputLogicalId(key)
        const fullArn = outputs[outputKey]
        const arn = fullArn
          .split(':')
          .slice(0, 7)
          .join(':')

        func.provider.arn = arn
      } else {
        // connector function
        const expectedOutputName = this.connectorFunctionNames(rawFunc.name, rawFunc.type).outputName
        switch (rawFunc.type) {
          case 'awsfirehose':
            if (rawFunc.inputs.hasOwnProperty('arn') && rawFunc.inputs.hasOwnProperty('deliveryStreamName')) {
              func.provider.deliveryStreamName = rawFunc.inputs.deliveryStreamName
            } else if (rawFunc.inputs.hasOwnProperty('logicalId')) {
              if (!outputs[expectedOutputName]) {
                throw new Error(`Expected "${expectedOutputName}" in Stack Outputs but not found`)
              }
              func.provider.deliveryStreamName = outputs[expectedOutputName]
            }
            break
          case 'awskinesis':
            if (rawFunc.inputs.hasOwnProperty('arn') && rawFunc.inputs.hasOwnProperty('streamName')) {
              func.provider.streamName = rawFunc.inputs.streamName
            } else if (rawFunc.inputs.hasOwnProperty('logicalId')) {
              if (!outputs[expectedOutputName]) {
                throw new Error(`Expected "${expectedOutputName}" in Stack Outputs but not found`)
              }
              func.provider.streamName = outputs[expectedOutputName]
            }
            break
          case 'awssqs':
            if (rawFunc.inputs.hasOwnProperty('arn') && rawFunc.inputs.hasOwnProperty('queueUrl')) {
              func.provider.queueUrl = rawFunc.inputs.queueUrl
            } else if (rawFunc.inputs.hasOwnProperty('logicalId')) {
              if (!outputs[expectedOutputName]) {
                throw new Error(`Expected "${expectedOutputName}" in Stack Outputs but not found`)
              }
              func.provider.queueUrl = outputs[expectedOutputName]
            }
            break
          default:
        }
      }

      func.events = rawFunc.events.filter(event => event.eventgateway).map(event => event.eventgateway)
      func.events.forEach(event => (event.functionId = func.functionId))

      funcs[key] = func
    })

    return funcs
  }

  emitEvent () {
    this.setupClient()
    this.client
      .emit({
        eventID: uuidv4(),
        eventType: this.options.event,
        cloudEventsVersion: '0.1',
        source: 'https://github.com/serverless/serverless-event-gateway-plugin',
        contentType: 'application/json',
        data: JSON.parse(this.options.data)
      })
      .then(() => {
        this.serverless.cli.consoleLog(
          chalk.yellow.underline('Event emitted:') + chalk.yellow(` ${this.options.event}`)
        )
        this.serverless.cli.consoleLog(
          chalk.yellow('Run `serverless logs -f <functionName>` to verify your subscribed function was triggered.')
        )
      })
  }

  printDashboard () {
    this.setupClient()
    this.serverless.cli.consoleLog('')
    this.printGatewayInfo()
    this.printFunctions()
      .then(() => this.printSubscriptions())
      .then(() => this.printCORS())
  }

  printGatewayInfo () {
    this.serverless.cli.consoleLog(chalk.bold('Event Gateway'))
    this.serverless.cli.consoleLog('')
    this.serverless.cli.consoleLog(` Tenant: ${this.serverless.service.tenant}`)
    this.serverless.cli.consoleLog(` App: ${this.serverless.service.app}`)
    this.serverless.cli.consoleLog(` Domain: ${this.client.config.eventsUrl}`)
    this.serverless.cli.consoleLog('')
  }

  printFunctions () {
    return this.client.listFunctions().then(functions => {
      const table = new Table({
        head: ['Function ID', 'Region', 'ARN'],
        style: { head: ['bold'] }
      })
      functions.forEach(f => {
        table.push([f.functionId || '', f.provider.region || '', f.provider.arn || ''])
      })
      this.serverless.cli.consoleLog(chalk.bold('Functions'))
      this.serverless.cli.consoleLog(table.toString())
      this.serverless.cli.consoleLog('')
    })
  }

  printSubscriptions () {
    return this.client.listSubscriptions().then(subscriptions => {
      const table = new Table({
        head: ['Event', 'Function ID', 'Method', 'Path'],
        style: { head: ['bold'] }
      })
      subscriptions.forEach(s => {
        table.push([s.eventType || '', s.functionId || '', s.method || '', s.path || ''])
      })
      this.serverless.cli.consoleLog(chalk.bold('Subscriptions'))
      this.serverless.cli.consoleLog(table.toString())
      this.serverless.cli.consoleLog('')
    })
  }

  printCORS () {
    return this.client.listServiceCORS()
      .then(cors => {
        const table = new Table({
          head: ['Path', 'Origins', 'Methods', 'Headers', 'Allow Credentials'],
          style: { head: ['bold'] }
        })
        cors.forEach(x => table.push([x.path || '', x.allowedOrigins.join(', ') || '', x.allowedMethods.join(', ') || '', x.allowedHeaders.join(', ') || '', x.allowCredentials || '?']))
        this.serverless.cli.consoleLog(chalk.bold('CORS'))
        this.serverless.cli.consoleLog(table.toString())
        this.serverless.cli.consoleLog('')
      })
  }

  connectorFunctionOutput (name, type, { logicalId, arn }) {
    const names = this.connectorFunctionNames(name, type)
    const outObject = {}
    outObject[names.outputName] = {
      Value: arn || { Ref: logicalId },
      Description: `${names.resourceName} for ${name} connector function.`
    }

    return outObject
  }

  connectorFunctionNames (name, type) {
    let resourceName
    let action
    switch (type) {
      case 'awsfirehose':
        resourceName = 'deliveryStreamName'
        action = 'firehose:PutRecord'
        break
      case 'awskinesis':
        resourceName = 'streamName'
        action = 'kinesis:PutRecord'
        break
      case 'awssqs':
        resourceName = 'queueUrl'
        action = 'sqs:SendMessage'
        break
      default:
        resourceName = ''
        action = ''
    }
    return {
      outputName:
        name.charAt(0).toUpperCase() + name.substr(1) + resourceName.charAt(0).toUpperCase() + resourceName.substr(1),
      resourceName,
      action
    }
  }

  async addUserResource () {
    const functionResources = Object.keys(this.functions)
      .filter(key => !this.functions[key].type)
      .map(key => {
        return {
          'Fn::GetAtt': [this.awsProvider.naming.getLambdaLogicalId(key), 'Arn']
        }
      })

    const policyStatement = Object.values(this.requiredIAMPolicies)
    if (functionResources.length) {
      policyStatement.push({
        Effect: 'Allow',
        Action: ['lambda:InvokeFunction'],
        Resource: functionResources
      })
    }

    if (policyStatement.length === 0) return

    merge(this.serverless.service.provider.compiledCloudFormationTemplate.Resources, {
      EventGatewayUser: {
        Type: 'AWS::IAM::User'
      },
      EventGatewayUserPolicy: {
        Type: 'AWS::IAM::ManagedPolicy',
        Properties: {
          Description: 'This policy allows Custom plugin to gather data on IAM users',
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: policyStatement
          },
          Users: [
            {
              Ref: 'EventGatewayUser'
            }
          ]
        }
      },
      EventGatewayUserKeys: {
        Type: 'AWS::IAM::AccessKey',
        Properties: {
          UserName: {
            Ref: 'EventGatewayUser'
          }
        }
      }
    })

    merge(
      this.serverless.service.provider.compiledCloudFormationTemplate.Outputs,
      Object.assign(this.connectorFunctionsOutputs, {
        EventGatewayUserAccessKey: {
          Value: {
            Ref: 'EventGatewayUserKeys'
          },
          Description: 'Access Key ID of Custom User'
        },
        EventGatewayUserSecretKey: {
          Value: {
            'Fn::GetAtt': ['EventGatewayUserKeys', 'SecretAccessKey']
          },
          Description: 'Secret Key of Custom User'
        }
      })
    )
  }

  async fetchStackOutputs () {
    let data
    try {
      data = await this.awsProvider.request(
        'CloudFormation',
        'describeStacks',
        { StackName: this.awsProvider.naming.getStackName() },
        this.awsProvider.getStage(),
        this.awsProvider.getRegion()
      )
    } catch (err) {
      throw new Error('Error during fetching information about stack.')
    }

    const stack = data.Stacks.pop()
    if (!stack) {
      throw new Error('Unable to fetch CloudFormation stack information.')
    }

    const outputs = stack.Outputs.reduce((agg, current) => {
      if (current.OutputKey && current.OutputValue) {
        agg[current.OutputKey] = current.OutputValue
      }
      return agg
    }, {})

    return outputs
  }

  areSubscriptionsEqual (newSub, existing) {
    const toUpperCase = str => (str instanceof String ? str.toUpperCase() : str)

    if (existing.path !== eventPath(newSub, this.client.config.space)) {
      return false
    }

    if (newSub.event) {
      if (newSub.event === 'http') {
        return (
          existing.type === 'sync' &&
          existing.eventType === 'http.request' &&
          toUpperCase(existing.method) === toUpperCase(newSub.method)
        )
      } else {
        return (
          existing.type === 'async' && existing.eventType === newSub.event && toUpperCase(existing.method) === 'POST'
        )
      }
    }

    return (
      existing.type === newSub.type &&
      existing.eventType === newSub.eventType &&
      toUpperCase(existing.method) === (toUpperCase(newSub.method) || 'POST')
    )
  }

  areFunctionsEqual (newFunc, existing) {
    return newFunc.type === existing.type && isEqual(newFunc.provider, existing.provider)
  }
}

function eventPath (event, space) {
  let path = event.path || '/'

  if (!path.startsWith('/')) {
    path = '/' + path
  }

  return `/${space}${path}`
}

module.exports = EGPlugin
