const merge = require('lodash.merge')
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
      'package:initialize': this.createConnectorFunctionDefinitions.bind(this),
      'package:compileEvents': this.addUserDefinition.bind(this),
      'after:deploy:finalize': this.configureEventGateway.bind(this),
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

    // Connector functions
    this.requiredIAMPolicies = {}
    this.connectorFunctions = {}
    this.connectorFunctionsOutputs = {}
  }

  setupClient () {
    // Plugin config
    let config
    if (this.serverless.service.custom && this.serverless.service.custom.eventgateway) {
      config = this.serverless.service.custom.eventgateway
    } else {
      throw new Error('No Event Gateway configuration provided in serverless.yaml')
    }

    // Event Gateway Service Client
    this.client = new Client(
      {
        url: config.url,
        configurationUrl: config.configurationUrl,
        space: config.space,
        accessKey: config.accessKey
      },
      this.serverless.service.service,
      this.awsProvider.getStage()
    )
  }

  createConnectorFunctionDefinitions () {
    const functions = this.serverless.service.functions
    for (let name in functions) {
      if (!functions.hasOwnProperty(name) || !functions[name].type) continue
      const func = (this.connectorFunctions[name] = functions[name])

      if (!func.inputs) throw new Error(`No inputs provided for ${func.type} function "${name}".`)

      if (!['awsfirehose', 'awskinesis', 'awssqs'].includes(func.type)) {
        throw new Error(`Unrecognised type "${func.type}" for function "${name}"`)
      }

      const { resourceName, action } = this.connectorFunctionNames(name, func.type)
      if (
        !(
          func.inputs.hasOwnProperty('logicalId') ||
          (func.inputs.hasOwnProperty('arn') && func.inputs.hasOwnProperty(resourceName))
        )
      ) {
        throw new Error(
          `Invalid inputs for ${func.type} function "${name}". ` +
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
            `Could not find resource "${func.inputs.logicalId}" in "resources" block for "${name}" function.`
          )
        }
        this.requiredIAMPolicies[func.inputs.logicalId] = {
          Effect: 'Allow',
          Action: [action],
          Resource: { 'Fn::GetAtt': [func.inputs.logicalId, 'Arn'] }
        }
        this.connectorFunctionsOutputs = Object.assign(
          this.connectorFunctionsOutputs,
          this.connectorFunctionOutput(name, func.type, { logicalId: func.inputs.logicalId })
        )
      } else if (func.inputs.hasOwnProperty('arn')) {
        this.requiredIAMPolicies[func.inputs.arn] = {
          Effect: 'Allow',
          Action: [action],
          Resource: func.inputs.arn
        }
        this.connectorFunctionsOutputs = Object.assign(
          this.connectorFunctionsOutputs,
          this.connectorFunctionOutput(name, func.type, { arn: func.inputs.arn })
        )
      }

      delete functions[name]
    }

    this.serverless.service.functions = functions
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

  async remove () {
    this.setupClient()
    this.serverless.cli.consoleLog('')
    this.serverless.cli.consoleLog(chalk.yellow.underline('Event Gateway Plugin'))

    const subscriptions = await this.client.listServiceSubscriptions()
    const unsubList = subscriptions.map(sub =>
      this.client.unsubscribeAndDeleteCORS(sub).then(() => {
        this.serverless.cli.consoleLog(
          `EventGateway: Subscription "${sub.eventType}" removed from function: ${sub.functionId}`
        )
      })
    )
    await Promise.all(unsubList)

    const functions = await this.client.listServiceFunctions()
    const deleteFuncList = functions.map(func =>
      this.client.deleteFunction({ functionId: func.functionId }).then(() => {
        this.serverless.cli.consoleLog(`EventGateway: Function "${func.functionId}" removed.`)
      })
    )
    await Promise.all(deleteFuncList)

    const eventTypes = await this.client.listEventTypes()
    const deleteTypesList = eventTypes.map(etype =>
      this.client.deleteEventType({ name: etype.name }).then(() => {
        this.serverless.cli.consoleLog(`EventGateway: Event Type "${etype.name}" removed.`)
      })
    )
    await Promise.all(deleteTypesList)
  }

  printDashboard () {
    this.setupClient()
    this.serverless.cli.consoleLog('')
    this.printGatewayInfo()
    this.printFunctions().then(() => this.printSubscriptions())
  }

  printGatewayInfo () {
    this.serverless.cli.consoleLog(chalk.bold('Event Gateway'))
    this.serverless.cli.consoleLog('')
    this.serverless.cli.consoleLog(` space: ${this.client.config.space}`)
    this.serverless.cli.consoleLog(` endpoint: ${this.client.config.eventsUrl}`)
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
        table.push([s.event || '', s.functionId || '', s.method || '', s.path || ''])
      })
      this.serverless.cli.consoleLog(chalk.bold('Subscriptions'))
      this.serverless.cli.consoleLog(table.toString())
      this.serverless.cli.consoleLog('')
    })
  }

  async configureEventGateway () {
    this.serverless.cli.consoleLog('')
    this.serverless.cli.consoleLog(chalk.yellow.underline('Event Gateway Plugin'))

    this.setupClient()

    const registeredEventTypes = await this.client.listServiceEventTypes()
    this.registerEventTypes(registeredEventTypes)

    const definedFunctions = this.definedFunctions()
    let registeredFunctions = await this.client.listServiceFunctions()
    let registeredSubscriptions = await this.client.listServiceSubscriptions()

    if (definedFunctions.length !== 0 || Object.keys(this.connectorFunctions).length !== 0) {
      const outputs = await this.fetchStackOutputs()

      // Register missing functions and create missing subscriptions
      await Promise.all(
        definedFunctions.map(async definedFunction => {
          const outputKey = this.awsProvider.naming.getLambdaVersionOutputLogicalId(definedFunction.key)
          const fullArn = outputs[outputKey]
          // Remove the function version from the ARN so that it always uses the latest version.
          const arn = fullArn
            .split(':')
            .slice(0, 7)
            .join(':')
          const functionId = fullArn.split(':')[6]
          const fn = {
            functionId: functionId,
            type: 'awslambda',
            provider: {
              arn: arn,
              region: this.awsProvider.getRegion(),
              awsAccessKeyId: outputs.EventGatewayUserAccessKey,
              awsSecretAccessKey: outputs.EventGatewayUserSecretKey
            }
          }

          const registeredFunction = registeredFunctions.find(f => f.functionId === functionId)
          if (!registeredFunction) {
            // create function if doesn't exit
            await this.client.createFunction(fn)
            this.serverless.cli.consoleLog(
              `EventGateway: Function "${definedFunction.key}" registered. (ID: ${fn.functionId})`
            )

            for (let event of definedFunction.events) {
              event.functionId = functionId
              await this.client.subscribeAndCreateCORS(event)
              this.serverless.cli.consoleLog(
                `EventGateway: Function "${definedFunction.key}" subscribed to "${event.event ||
                  event.eventType}" event.`
              )
            }
          } else {
            // remove function from functions array
            registeredFunctions = registeredFunctions.filter(f => f.functionId !== functionId)

            // update subscriptions
            let existingSubscriptions = registeredSubscriptions.filter(s => s.functionId === functionId)
            definedFunction.events.forEach(async event => {
              const existingSubscription = existingSubscriptions.find(existing =>
                this.areSubscriptionsEqual(event, existing)
              )

              // create subscription as it doesn't exists
              if (!existingSubscription) {
                event.functionId = functionId
                await this.client.subscribeAndCreateCORS(event)
                this.serverless.cli.consoleLog(
                  `EventGateway: Function "${definedFunction.key}" subscribed to "${event.event ||
                    event.eventType}" event.`
                )
              } else {
                existingSubscriptions = existingSubscriptions.filter(
                  s => s.subscriptionId !== existingSubscription.subscriptionId
                )
              }
            })

            // cleanup subscription that are not needed
            const subscriptionsToDelete = existingSubscriptions.map(sub =>
              this.client
                .unsubscribeAndDeleteCORS(sub)
                .then(() =>
                  this.serverless.cli.consoleLog(
                    `EventGateway: Function "${definedFunction.key}" unsubscribed from "${sub.event ||
                      sub.eventType}" event.`
                  )
                )
            )
            await Promise.all(subscriptionsToDelete)
          }

          await this.updateEventTypesAuthorizers(definedFunction.name, functionId)
        })
      )

      await this.registerConnectorFunctions(registeredFunctions, outputs)
    }

    await this.cleanupFunctionsAndSubscriptions(registeredFunctions, registeredSubscriptions, registeredEventTypes)
    await this.cleanupEventTypes(registeredEventTypes)
  }

  async registerConnectorFunctions (registeredFunctions, outputs) {
    for (let name in this.connectorFunctions) {
      const cf = this.connectorFunctions[name]
      const cfId = `${this.serverless.service.service}-${this.awsProvider.getStage()}-${name}`
      const registeredFunction = registeredFunctions.find(f => f.functionId === cfId)
      registeredFunctions = registeredFunctions.filter(f => f.functionId !== cfId)
      if (!registeredFunction) {
        await this.registerConnectorFunction(outputs, name, cf, cfId)
        this.serverless.cli.consoleLog(`EventGateway: Function "${name}" registered. (ID: ${cfId})`)

        if (!Array.isArray(cf.events)) continue

        const events = cf.events.filter(eventObj => eventObj.eventgateway).map(eventObj => {
          const subscription = eventObj.eventgateway
          subscription.functionId = cfId
          return this.client
            .subscribeAndCreateCORS(subscription)
            .then(() =>
              this.serverless.cli.consoleLog(
                `EventGateway: Function "${name}" subscribed for "${eventObj.eventgateway.event} event.`
              )
            )
        })
        await Promise.all(events)
      }
    }
  }

  updateEventTypesAuthorizers (key, functionId) {
    return Promise.all(
      this.definedEventTypes()
        .filter(et => et.authorizer === key)
        .map(et => {
          return this.client.updateEventType({
            name: et.name,
            authorizerId: functionId
          })
        })
    )
  }

  // cleanup function and subscription no longer defined in serverless.yaml
  async cleanupFunctionsAndSubscriptions (functionsToDelete, registeredSubscriptions, registeredEventTypes) {
    for (let functionToDelete of functionsToDelete) {
      const subscriptionsToDelete = registeredSubscriptions.filter(s => s.functionId === functionToDelete.functionId)

      await Promise.all(
        subscriptionsToDelete.map(subscriptionToDelete => this.client.unsubscribeAndDeleteCORS(subscriptionToDelete))
      )

      const eventTypeWithAuth = registeredEventTypes.find(et => et.authorizerId === functionToDelete.functionId)
      if (eventTypeWithAuth) {
        await this.client.updateEventType({ name: eventTypeWithAuth.name })
      }

      await this.client.deleteFunction({ functionId: functionToDelete.functionId })
      this.serverless.cli.consoleLog(
        `EventGateway: Function "${functionToDelete.functionId}" and it's subscriptions deleted.`
      )
    }
  }

  // event typed defined in custom section
  definedEventTypes () {
    if (this.serverless.service.custom.eventTypes) {
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
  usedEventTypes () {
    const definedTypes = this.definedEventTypes()

    const names = {}
    this.definedFunctions().forEach(localFunction => {
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

  // register event types defined in serverless.yaml
  async registerEventTypes (registeredTypes) {
    const definedTypes = this.definedEventTypes()

    await Promise.all(
      definedTypes.map(async definedType => {
        const registeredType = registeredTypes.find(et => et.name === definedType.name)
        if (!registeredType) {
          await this.client.createEventType({ name: definedType.name })
          this.serverless.cli.consoleLog(`EventGateway: Event Type "${definedType.name}" created.`)
        }
      })
    )

    const usedTypes = this.usedEventTypes()
    await Promise.all(
      usedTypes.map(async usedType => {
        try {
          await this.client.createEventType({ name: usedType.name })
          this.serverless.cli.consoleLog(`EventGateway: Event Type "${usedType.name}" created.`)
        } catch (err) {
          if (!err.message.includes('already exists')) {
            throw err
          }
        }
      })
    )
  }

  // cleanup types defined in EG not in the serverless.yaml
  async cleanupEventTypes (registeredTypes) {
    const definedTypes = this.definedEventTypes()
    let toRemove = registeredTypes.filter(registeredType => !definedTypes.find(et => et.name === registeredType.name))

    const usedTypes = this.usedEventTypes()
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

  async registerConnectorFunction (outputs, name, func, funcId) {
    const fn = {
      functionId: funcId,
      type: func.type,
      provider: {
        region: this.awsProvider.getRegion(),
        awsAccessKeyId: outputs.EventGatewayUserAccessKey,
        awsSecretAccessKey: outputs.EventGatewayUserSecretKey
      }
    }
    const expectedOutputName = this.connectorFunctionNames(name, func.type).outputName

    switch (func.type) {
      case 'awsfirehose':
        if (func.inputs.hasOwnProperty('arn') && func.inputs.hasOwnProperty('deliveryStreamName')) {
          fn.provider.deliveryStreamName = func.inputs.deliveryStreamName
        } else if (func.inputs.hasOwnProperty('logicalId')) {
          if (!outputs[expectedOutputName]) {
            throw new Error(`Expected "${expectedOutputName}" in Stack Outputs but not found`)
          }
          fn.provider.deliveryStreamName = outputs[expectedOutputName]
        }
        break
      case 'awskinesis':
        if (func.inputs.hasOwnProperty('arn') && func.inputs.hasOwnProperty('streamName')) {
          fn.provider.streamName = func.inputs.streamName
        } else if (func.inputs.hasOwnProperty('logicalId')) {
          if (!outputs[expectedOutputName]) {
            throw new Error(`Expected "${expectedOutputName}" in Stack Outputs but not found`)
          }
          fn.provider.streamName = outputs[expectedOutputName]
        }
        break
      case 'awssqs':
        if (func.inputs.hasOwnProperty('arn') && func.inputs.hasOwnProperty('queueUrl')) {
          fn.provider.queueUrl = func.inputs.queueUrl
        } else if (func.inputs.hasOwnProperty('logicalId')) {
          if (!outputs[expectedOutputName]) {
            throw new Error(`Expected "${expectedOutputName}" in Stack Outputs but not found`)
          }
          fn.provider.queueUrl = outputs[expectedOutputName]
        }
        break
      default:
    }

    try {
      return await this.client.createFunction(fn)
    } catch (err) {
      throw new Error(`Couldn't register Connector Function "${name}": ${err}`)
    }
  }

  // returns functions with EG subscription or authorizer
  definedFunctions () {
    const functions = []
    const definedEventTypes = this.definedEventTypes()

    Object.keys(this.serverless.service.functions).forEach(key => {
      // clone object
      const func = Object.assign({}, this.serverless.service.functions[key])
      func.key = key

      // functions with EG events
      const egEvents = func.events.filter(event => event.eventgateway).map(event => event.eventgateway)
      if (egEvents.length > 0) {
        func.events = egEvents
        functions.push(func)
        return
      }

      // function is authorizer
      const isAuthorizer = definedEventTypes.find(et => et.authorizer === func.key)
      if (isAuthorizer) {
        functions.push(func)
      }
    })

    return functions
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

  addUserDefinition () {
    const functionResources = this.definedFunctions().map(fn => {
      return {
        'Fn::GetAtt': [this.awsProvider.naming.getLambdaLogicalId(fn.key), 'Arn']
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
    if (!outputs.EventGatewayUserAccessKey || !outputs.EventGatewayUserSecretKey) {
      throw new Error('Event Gateway Access Key or Secret Key not found in outputs')
    }

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
}

function eventPath (event, space) {
  let path = event.path || '/'

  if (!path.startsWith('/')) {
    path = '/' + path
  }

  return `/${space}${path}`
}

module.exports = EGPlugin
