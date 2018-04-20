const merge = require('lodash.merge')
const SDK = require('@serverless/event-gateway-sdk')
const chalk = require('chalk')
const to = require('await-to-js').to
const Table = require('cli-table')

class EGPlugin {
  constructor (serverless, options) {
    this.serverless = serverless
    this.options = options

    this.awsProvider = this.serverless.getProvider('aws')

    this.requiredIAMPolicies = {}
    this.connectorFunctions = {}
    this.connectorFunctionsOutputs = {}

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

      const {resourceName, action} = this.connectorFunctionNames(name, func.type)
      if (
        !(
          func.inputs.hasOwnProperty('logicalId') ||
          (func.inputs.hasOwnProperty('arn') && func.inputs.hasOwnProperty(resourceName))
        )
      ) {
        throw new Error(
          `Invalid inputs for ${func.type} function "${name}". ` +
          `You provided ${Object.keys(func.inputs).length ? Object.keys(func.inputs).map(i => `"${i}"`).join(', ') : 'none'}. ` +
          `Please provide either "logicalId" or both "arn" and "${resourceName}" inputs.`
        )
      }

      if (func.inputs.hasOwnProperty('logicalId')) {
        if (!this.serverless.service.resources.Resources.hasOwnProperty(func.inputs.logicalId)) {
          throw new Error(`Could not find resource "${func.inputs.logicalId}" in "resources" block for "${name}" function.`)
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

  async getEGServiceFunctions () {
    const eg = this.getClient()
    let functions = []
    let err
    let result
    ;[err, result] = await to(eg.listFunctions())
    if (!err) {
      functions = result
    }
    return functions.filter(f =>
      f.functionId.startsWith(`${this.serverless.service.service}-${this.awsProvider.getStage()}`)
    )
  }

  async getEGServiceSubscriptions () {
    const eg = this.getClient()
    let subscriptions = []
    let err
    let result
    ;[err, result] = await to(eg.listSubscriptions())
    if (!err) {
      subscriptions = result
    }
    return subscriptions.filter(s =>
      s.functionId.startsWith(`${this.serverless.service.service}-${this.awsProvider.getStage()}`)
    )
  }

  emitEvent () {
    const eg = this.getClient()

    eg
      .emit({
        event: this.options.event,
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
    const eg = this.getClient()

    this.serverless.cli.consoleLog('')
    this.serverless.cli.consoleLog(chalk.yellow.underline('Event Gateway Plugin'))

    const subscriptions = await this.getEGServiceSubscriptions()
    if (subscriptions instanceof Array && subscriptions.length) {
      const unsubList = subscriptions.map(sub =>
        eg.unsubscribe({ subscriptionId: sub.subscriptionId }).then(() => {
          this.serverless.cli.consoleLog(
            `EventGateway: Subscription "${sub.event}" removed from function: ${sub.functionId}`
          )
        })
      )
      await Promise.all(unsubList)
    }

    const functions = await this.getEGServiceFunctions()
    if (Array.isArray(functions) && functions.length) {
      const deleteList = functions.map(func =>
        eg.deleteFunction({ functionId: func.functionId }).then(() => {
          this.serverless.cli.consoleLog(`EventGateway: Function "${func.functionId}" removed.`)
        })
      )
      await Promise.all(deleteList)
    }
  }

  printDashboard () {
    this.serverless.cli.consoleLog('')
    this.printGatewayInfo()
    this.printFunctions().then(() => this.printSubscriptions())
  }

  printGatewayInfo () {
    const space = this.getConfig().space
    const eventsAPI = this.getConfig().eventsAPI
    this.serverless.cli.consoleLog(chalk.bold('Event Gateway'))
    this.serverless.cli.consoleLog('')
    this.serverless.cli.consoleLog(` space: ${space}`)
    this.serverless.cli.consoleLog(` endpoint: ${eventsAPI}`)
    this.serverless.cli.consoleLog('')
  }

  printFunctions () {
    const eg = this.getClient()
    return eg.listFunctions().then(functions => {
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
    const eg = this.getClient()
    return eg.listSubscriptions().then(subscriptions => {
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

  getConfig () {
    if (this.config) {
      return this.config
    }
    if (this.serverless.service.custom && this.serverless.service.custom.eventgateway) {
      const config = this.serverless.service.custom.eventgateway
      if (config.subdomain !== undefined) {
        throw new Error(
          'The "subdomain" property in eventgateway config in serverless.yml is deprecated. Please use "space" instead.'
        )
      }
      if (!config.eventsAPI && !config.configurationAPI) {
        config.hosted = true
        config.eventsAPI = `https://${config.space}.slsgateway.com`
        config.configurationAPI = 'https://config.slsgateway.com'
      } else {
        config.hosted = false
      }
      this.config = config
      return config
    }

    return null
  }

  getClient () {
    const config = this.getConfig()
    if (!config) {
      throw new Error('No Event Gateway configuration provided in serverless.yaml')
    }

    if (!config.space) {
      throw new Error(
        'Required "space" property is missing from Event Gateway configuration provided in serverless.yaml'
      )
    }

    if (!config.apiKey && config.hosted === true) {
      throw new Error(
        'Required "apiKey" property is missing from Event Gateway configuration provided in serverless.yaml'
      )
    }

    return new SDK({
      url: config.eventsAPI,
      configurationUrl: config.configurationAPI,
      space: config.space,
      apiKey: config.apiKey
    })
  }

  async configureEventGateway () {
    const config = this.getConfig()
    const eg = this.getClient()

    this.serverless.cli.consoleLog('')
    this.serverless.cli.consoleLog(chalk.yellow.underline('Event Gateway Plugin'))

    let [err, data] = await to(
      this.awsProvider.request(
        'CloudFormation',
        'describeStacks',
        { StackName: this.awsProvider.naming.getStackName() },
        this.awsProvider.getStage(),
        this.awsProvider.getRegion()
      )
    )
    if (err) {
      throw new Error('Error during fetching information about stack.')
    }

    const stack = data.Stacks.pop()
    if (!stack) {
      throw new Error('Unable to fetch CloudFormation stack information.')
    }

    const localFunctions = this.filterFunctionsWithEvents()
    if (localFunctions.length === 0 && this.connectorFunctions.length === 0) {
      return
    }

    const outputs = (this.outputs = this.parseOutputs(stack))
    if (!outputs.EventGatewayUserAccessKey || !outputs.EventGatewayUserSecretKey) {
      throw new Error('Event Gateway Access Key or Secret Key not found in outputs')
    }

    let registeredFunctions = await this.getEGServiceFunctions()
    let registeredSubscriptions = await this.getEGServiceSubscriptions()

    // Register missing functions and create missing subscriptions
    this.filterFunctionsWithEvents().map(async name => {
      const outputKey = this.awsProvider.naming.getLambdaVersionOutputLogicalId(name)
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
      const functionEvents = this.serverless.service.getFunction(name).events.filter(f => f.eventgateway !== undefined)

      const registeredFunction = registeredFunctions.find(f => f.functionId === functionId)
      if (!registeredFunction) {
        // create function if doesn't exit
        await this.registerFunction(fn)
        this.serverless.cli.consoleLog(`EventGateway: Function "${name}" registered. (ID: ${fn.functionId})`)

        functionEvents.forEach(async event => {
          await this.createSubscription(config, functionId, event.eventgateway)
          this.serverless.cli.consoleLog(
            `EventGateway: Function "${name}" subscribed to "${event.eventgateway.event}" event.`
          )
        })
      } else {
        // remove function from functions array
        registeredFunctions = registeredFunctions.filter(f => f.functionId !== functionId)

        // update subscriptions
        let existingSubscriptions = registeredSubscriptions.filter(s => s.functionId === functionId)
        functionEvents.forEach(async event => {
          event = event.eventgateway
          const existingSubscription = existingSubscriptions.find(
            s => s.event === event.event && s.method === event.method && s.path === eventPath(event, config.space)
          )

          // create subscription as it doesn't exists
          if (!existingSubscription) {
            await this.createSubscription(config, functionId, event)
            this.serverless.cli.consoleLog(`EventGateway: Function "${name}" subscribed to "${event.event}" event.`)
          } else {
            existingSubscriptions = existingSubscriptions.filter(
              s => s.subscriptionId !== existingSubscription.subscriptionId
            )
          }
        })

        // cleanup subscription that are not needed
        const subscriptionsToDelete = existingSubscriptions.map(sub =>
          eg
            .unsubscribe({ subscriptionId: sub.subscriptionId })
            .then(() =>
              this.serverless.cli.consoleLog(`EventGateway: Function "${name}" unsubscribed from "${sub.event}" event.`)
            )
        )
        await Promise.all(subscriptionsToDelete)
      }
    })

    for (let name in this.connectorFunctions) {
      const cf = this.connectorFunctions[name]
      const cfId = `${this.serverless.service.service}-${this.awsProvider.getStage()}-${name}`
      const registeredFunction = registeredFunctions.find(f => f.functionId === cfId)
      registeredFunctions = registeredFunctions.filter(f => f.functionId !== cfId)
      if (!registeredFunction) {
        await this.registerConnectorFunction(name, cf, cfId)
        this.serverless.cli.consoleLog(`EventGateway: Function "${name}" registered. (ID: ${cfId})`)

        if (!Array.isArray(cf.events)) continue

        const events = cf.events
          .filter(eventObj => eventObj.eventgateway)
          .map(eventObj =>
            this.createSubscription(config, cfId, eventObj.eventgateway).then(() =>
              this.serverless.cli.consoleLog(
                `EventGateway: Function "${name}" subscribed for "${eventObj.eventgateway.event} event.`
              )
            )
          )
        await Promise.all(events)
      }
    }

    // Delete function and subscription no longer needed
    registeredFunctions.forEach(async functionToDelete => {
      const subscriptionsToDelete = registeredSubscriptions.filter(s => s.functionId === functionToDelete.functionId)
      await Promise.all(
        subscriptionsToDelete.map(toDelete => eg.unsubscribe({ subscriptionId: toDelete.subscriptionId }))
      )

      await eg.deleteFunction({ functionId: functionToDelete.functionId })
      this.serverless.cli.consoleLog(
        `EventGateway: Function "${functionToDelete.functionId}" and it's subscriptions deleted.`
      )
    })
  }

  async registerConnectorFunction (name, func, funcId) {
    const eg = this.getClient()
    const fn = {
      functionId: funcId,
      type: func.type,
      provider: {
        region: this.awsProvider.getRegion(),
        awsAccessKeyId: this.outputs.EventGatewayUserAccessKey,
        awsSecretAccessKey: this.outputs.EventGatewayUserSecretKey
      }
    }
    const expectedOutputName = this.connectorFunctionNames(name, func.type).outputName

    switch (func.type) {
      case 'awsfirehose':
        if (func.inputs.hasOwnProperty('arn') && func.inputs.hasOwnProperty('deliveryStreamName')) {
          fn.provider.deliveryStreamName = func.inputs.deliveryStreamName
        } else if (func.inputs.hasOwnProperty('logicalId')) {
          if (!this.outputs[expectedOutputName]) {
            throw new Error(`Expected "${expectedOutputName}" in Stack Outputs but not found`)
          }
          fn.provider.deliveryStreamName = this.outputs[expectedOutputName]
        }
        break
      case 'awskinesis':
        if (func.inputs.hasOwnProperty('arn') && func.inputs.hasOwnProperty('streamName')) {
          fn.provider.streamName = func.inputs.streamName
        } else if (func.inputs.hasOwnProperty('logicalId')) {
          if (!this.outputs[expectedOutputName]) {
            throw new Error(`Expected "${expectedOutputName}" in Stack Outputs but not found`)
          }
          fn.provider.streamName = this.outputs[expectedOutputName]
        }
        break
      case 'awssqs':
        if (func.inputs.hasOwnProperty('arn') && func.inputs.hasOwnProperty('queueUrl')) {
          fn.provider.queueUrl = func.inputs.queueUrl
        } else if (func.inputs.hasOwnProperty('logicalId')) {
          if (!this.outputs[expectedOutputName]) {
            throw new Error(`Expected "${expectedOutputName}" in Stack Outputs but not found`)
          }
          fn.provider.queueUrl = this.outputs[expectedOutputName]
        }
        break
      default:
    }

    let [err, result] = await to(eg.registerFunction(fn))
    if (err) {
      throw new Error(`Couldn't register Connector Function "${name}": ${err}`)
    }
    return result
  }

  filterFunctionsWithEvents () {
    const functions = []
    this.serverless.service.getAllFunctions().forEach(name => {
      const func = this.serverless.service.getFunction(name)
      const events = func.events

      if (!events) return

      const eventgateway = events.find(event => event.eventgateway)
      if (!eventgateway) return

      functions.push(name)
    })

    return functions
  }

  parseOutputs (stack) {
    return stack.Outputs.reduce((agg, current) => {
      if (current.OutputKey && current.OutputValue) {
        agg[current.OutputKey] = current.OutputValue
      }
      return agg
    }, {})
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
    const functionResources = this.filterFunctionsWithEvents().map(name => {
      return {
        'Fn::GetAtt': [this.awsProvider.naming.getLambdaLogicalId(name), 'Arn']
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

  async registerFunction (fn) {
    const eg = this.getClient()
    let [err, result] = await to(eg.registerFunction(fn))
    if (err) {
      throw new Error(`Couldn't register a function ${fn.functionId}. ${err}.`)
    }
    return result
  }

  async createSubscription (config, functionId, event) {
    const eg = this.getClient()
    const subscribeEvent = {
      functionId,
      event: event.event,
      path: eventPath(event, config.space),
      cors: event.cors
    }

    if (event.event === 'http') {
      subscribeEvent.method = event.method.toUpperCase() || 'GET'
    }

    let [err, result] = await to(eg.subscribe(subscribeEvent))
    if (err) {
      throw new Error(`Couldn't create subscriptions for ${functionId}. ${err}.`)
    }
    return result
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
