const chai = require('chai')
chai.use(require('chai-as-promised'))
chai.use(require('sinon-chai'))
const expect = chai.expect
const merge = require('lodash.merge')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const Client = require('../src/client.js')
let Plugin = require('../src/index.js')

describe('Event Gateway Plugin', () => {
  let sandbox
  let serverlessStub

  beforeEach(() => {
    sandbox = sinon.sandbox.create()
    sandbox.stub(Client.prototype)

    Plugin = proxyquire('../src/index.js', {
      './client': Client
    })

    serverlessStub = {
      service: {
        service: 'test',
        custom: { eventgateway: { url: 'http://localhost:4001' } },
        functions: {},
        getAllFunctions: sandbox.stub().returns([])
      },
      getProvider: sandbox.stub().returns({
        getStage: sinon.stub().returns('dev'),
        getRegion: sinon.stub().returns('us-east-1'),
        naming: {
          getStackName: sinon.stub().returns('stackname'),
          getLambdaVersionOutputLogicalId: sinon.stub().returns('TestLambda')
        },
        request: sinon.stub().resolves({
          Stacks: [
            {
              Outputs: [
                { OutputKey: 'EventGatewayUserAccessKey', OutputValue: 'ak' },
                { OutputKey: 'EventGatewayUserSecretKey', OutputValue: 'sk' },
                { OutputKey: 'TestLambda', OutputValue: 'arn:aws:lambda:us-east-1:123:function:test-dev-testFunc' }
              ]
            }
          ]
        })
      })
    }
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('emit command', () => {
    it('should emit an event', () => {
      Client.prototype.emit.resolves()
      const plugin = constructPlugin(serverlessStub, {
        event: 'user.created',
        data: `{"foo":"bar"}`
      })

      plugin.hooks['gateway:emit:emit']()

      const emitArgs = Client.prototype.emit.lastCall.args[0]
      expect(emitArgs.eventType).to.equal('user.created')
      expect(emitArgs.cloudEventsVersion).to.equal('0.1')
      expect(emitArgs.source).to.equal('github.com/serverless/serverless-event-gateway-plugin')
      expect(emitArgs.eventID).not.empty
      expect(emitArgs.contentType).to.equal('application/json')
      expect(emitArgs.data).to.deep.equal({ foo: 'bar' })
    })
  })

  describe('event types', () => {
    it('should create event type if defined in eventTypes', async () => {
      // given
      serverlessStub.service.custom.eventTypes = { 'test.event': null }
      Client.prototype.listServiceEventTypes.resolves([])
      Client.prototype.listServiceFunctions.resolves([])
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['after:deploy:finalize']()

      // then
      return expect(Client.prototype.createEventType).calledWith({ name: 'test.event' })
    })

    it('should create event type if used in subscription', async () => {
      // given
      Client.prototype.listServiceFunctions.resolves([])
      Client.prototype.listServiceEventTypes.resolves([])
      serverlessStub.service.getAllFunctions = sinon.stub().returns(['test-dev-testFunc'])
      serverlessStub.service.getFunction = sinon
        .stub()
        .withArgs('test-dev-testFunc')
        .returns({
          handler: 'index.test',
          events: [{ eventgateway: { type: 'async', eventType: 'test.event' } }]
        })
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['after:deploy:finalize']()

      // then
      return expect(Client.prototype.createEventType).calledWith({ name: 'test.event' })
    })

    it('should remove event types no longer defined in the configuration', async () => {
      // given
      serverlessStub.service.custom.eventTypes = { 'test.event': {} }
      Client.prototype.listServiceFunctions.resolves([])
      Client.prototype.listServiceEventTypes.resolves([{ name: 'test.event' }, { name: 'test.event.deleted' }])
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['after:deploy:finalize']()

      // then
      return expect(Client.prototype.deleteEventType).calledWith({
        name: 'test.event.deleted'
      })
    })

    it('should remove event types no longer used by subscriptions', async () => {
      // given
      Client.prototype.listServiceFunctions.resolves([])
      Client.prototype.listServiceEventTypes.resolves([
        { name: 'test.event', metadata: { service: 'test', stage: 'dev' } },
        { name: 'test.event.notused', metadata: { service: 'test', stage: 'dev' } }
      ])
      serverlessStub.service.getAllFunctions = sinon.stub().returns(['test-dev-testFunc'])
      serverlessStub.service.getFunction = sinon
        .stub()
        .withArgs('test-dev-testFunc')
        .returns({
          handler: 'index.test',
          events: [{ eventgateway: { type: 'async', eventType: 'test.event' } }]
        })
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['after:deploy:finalize']()

      // then
      return expect(Client.prototype.deleteEventType).calledWith({
        name: 'test.event.notused'
      })
    })

    it('should update event type with authorizer', async () => {
      // given
      serverlessStub.service.custom.eventTypes = { 'test.event': { authorizer: 'testFunc' } }
      Client.prototype.listServiceEventTypes.resolves([])
      Client.prototype.listServiceFunctions.resolves([])
      Client.prototype.createEventType.resolves()
      serverlessStub.service.getAllFunctions = sinon.stub().returns(['test-dev-testFunc'])
      serverlessStub.service.getFunction = sinon
        .stub()
        .withArgs('test-dev-testFunc')
        .returns({ handler: 'index.test', events: [] })
      serverlessStub.service.functions = {
        testFunc: {
          name: 'test-dev-testFunc',
          handler: 'test'
        }
      }
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['after:deploy:finalize']()

      // then
      return expect(Client.prototype.updateEventType).calledWith({
        name: 'test.event',
        authorizerId: 'test-dev-testFunc'
      })
    })
  })

  describe('connector functions', () => {
    beforeEach(() => {
      Client.prototype.listServiceEventTypes.resolves([])
    })

    it('should throw error if connector function has no inputs', async () => {
      // given
      const funcName = 'saveToSQS'
      const funcType = 'awssqs'
      const inputName = 'queueUrl'
      const func = {
        type: funcType,
        inputs: {},
        events: [{ eventgateway: { event: 'test.tested' } }]
      }
      serverlessStub.service.functions = {}
      serverlessStub.service.functions[funcName] = func

      const plugin = constructPlugin(serverlessStub)
      Client.prototype.createFunction.rejects('Error')

      return expect(plugin.hooks['package:initialize']).to.throw(
        `Invalid inputs for ${funcType} function "${funcName}". ` +
          `You provided none. Please provide either "logicalId" or both "arn" and "${inputName}" inputs.`
      )
    })

    it('should throw error if awskinesis function has only arn in inputs', async () => {
      // given
      const funcName = 'saveToKinesis'
      const funcType = 'awskinesis'
      const inputName = 'arn'
      const func = {
        type: funcType,
        inputs: {},
        events: [{ eventgateway: { event: 'test.tested' } }]
      }
      serverlessStub.service.functions = {}
      serverlessStub.service.functions[funcName] = func
      serverlessStub.service.functions[funcName].inputs[inputName] = 'exampleinput'

      const plugin = constructPlugin(serverlessStub)
      Client.prototype.createFunction.rejects('Error')

      return expect(plugin.hooks['package:initialize']).to.throw(
        `Invalid inputs for ${funcType} function "${funcName}". ` +
          `You provided ${Object.keys(func.inputs)
            .map(i => `"${i}"`)
            .join(', ')}. Please provide either "logicalId" or both "arn" and "streamName" inputs.`
      )
    })

    it('should throw error if awskinesis function has incomplete inputs', async () => {
      // given
      const funcName = 'saveToKinesis'
      const funcType = 'awskinesis'
      const inputName = 'streamName'
      const func = {
        type: funcType,
        inputs: {},
        events: [{ eventgateway: { event: 'test.tested' } }]
      }
      serverlessStub.service.functions = {}
      serverlessStub.service.functions[funcName] = func
      serverlessStub.service.functions[funcName].inputs[inputName] = 'exampleinput'

      const plugin = constructPlugin(serverlessStub)
      Client.prototype.createFunction.rejects('Error')

      return expect(plugin.hooks['package:initialize']).to.throw(
        `Invalid inputs for ${funcType} function "${funcName}". ` +
          `You provided ${Object.keys(func.inputs)
            .map(i => `"${i}"`)
            .join(', ')}. Please provide either "logicalId" or both "arn" and "${inputName}" inputs.`
      )
    })

    it('should throw error if awsfirehose function has incomplete inputs', async () => {
      // given
      const funcName = 'saveToFirehose'
      const funcType = 'awsfirehose'
      const inputName = 'deliveryStreamName'
      const func = {
        type: funcType,
        inputs: {},
        events: [{ eventgateway: { event: 'test.tested' } }]
      }
      serverlessStub.service.functions = {}
      serverlessStub.service.functions[funcName] = func
      serverlessStub.service.functions[funcName].inputs[inputName] = 'exampleinput'

      const plugin = constructPlugin(serverlessStub)
      Client.prototype.createFunction.rejects('Error')

      return expect(plugin.hooks['package:initialize']).to.throw(
        `Invalid inputs for ${funcType} function "${funcName}". ` +
          `You provided ${Object.keys(func.inputs)
            .map(i => `"${i}"`)
            .join(', ')}. Please provide either "logicalId" or both "arn" and "${inputName}" inputs.`
      )
    })

    it('should throw error if awssqs function has incomplete inputs', async () => {
      // given
      const funcName = 'saveToSQS'
      const funcType = 'awssqs'
      const inputName = 'queueUrl'
      const func = {
        type: funcType,
        inputs: {},
        events: [{ eventgateway: { event: 'test.tested' } }]
      }
      serverlessStub.service.functions = {}
      serverlessStub.service.functions[funcName] = func
      serverlessStub.service.functions[funcName].inputs[inputName] = 'exampleinput'

      const plugin = constructPlugin(serverlessStub)
      Client.prototype.createFunction.rejects('Error')

      return expect(plugin.hooks['package:initialize']).to.throw(
        `Invalid inputs for ${funcType} function "${funcName}". ` +
          `You provided ${Object.keys(func.inputs)
            .map(i => `"${i}"`)
            .join(', ')}. Please provide either "logicalId" or both "arn" and "${inputName}" inputs.`
      )
    })

    it('should register awskinesis function', async () => {
      // given
      serverlessStub.service.functions = {
        saveToKinesis: {
          type: 'awskinesis',
          inputs: { arn: 'fakearn', streamName: 'testStream' },
          events: [{ eventgateway: { event: 'test.tested' } }]
        }
      }
      Client.prototype.listServiceFunctions.resolves([])
      Client.prototype.subscribeAndCreateCORS.resolves()
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['after:deploy:finalize']()

      // then
      return expect(Client.prototype.createFunction).calledWith({
        functionId: 'test-dev-saveToKinesis',
        provider: { streamName: 'testStream', awsAccessKeyId: 'ak', awsSecretAccessKey: 'sk', region: 'us-east-1' },
        type: 'awskinesis'
      })
    })

    it('should not register connector function if EG returned error', async () => {
      // given
      serverlessStub.service.functions = {
        saveToFirehose: {
          type: 'awskinesis',
          inputs: { arn: 'fakearn', streamName: 'testStream' },
          events: [{ eventgateway: { event: 'test.tested' } }]
        }
      }
      Client.prototype.listServiceFunctions.resolves([])
      const plugin = constructPlugin(serverlessStub)
      Client.prototype.createFunction.rejects('Error')

      // when
      plugin.hooks['package:initialize']()

      // then
      return expect(plugin.hooks['after:deploy:finalize']()).to.eventually.be.rejectedWith(
        `Couldn't register Connector Function "saveToFirehose": Error`
      )
    })

    it('should have correct IAM Policies', async () => {
      const arn = 'fakearn'
      // given
      serverlessStub.service.functions = {
        saveToKinesis: {
          type: 'awskinesis',
          inputs: { arn: arn, streamName: 'testStream' },
          events: [{ eventgateway: { event: 'test.tested' } }]
        }
      }
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()

      // then
      const expectedIAMPolicy = {
        Effect: 'Allow',
        Action: ['kinesis:PutRecord'],
        Resource: arn
      }
      return expect(plugin.requiredIAMPolicies[arn]).to.deep.equal(expectedIAMPolicy)
    })
  })

  describe('subscriptions', () => {
    beforeEach(() => {
      Client.prototype.listServiceEventTypes.resolves([])
      Client.prototype.listServiceFunctions.resolves([])
    })

    it('should recreate subscription if path changed', async () => {
      // given
      const existingSubscription = {
        subscriptionId: 'testid',
        type: 'async',
        functionId: 'test-dev-testFunc',
        method: 'GET',
        path: '/hello'
      }
      Client.prototype.unsubscribe.resolves()
      Client.prototype.unsubscribeAndDeleteCORS.resolves()
      Client.prototype.listServiceSubscriptions.resolves([existingSubscription])
      Client.prototype.listServiceFunctions.resolves([{ functionId: 'test-dev-testFunc' }])
      serverlessStub.service.getAllFunctions = sinon.stub().returns(['test-dev-testFunc'])
      serverlessStub.service.getFunction = sinon
        .stub()
        .withArgs('test-dev-testFunc')
        .returns({
          handler: 'index.test',
          events: [{ eventgateway: { type: 'async', eventType: 'user.created', path: '/hello1', method: 'GET' } }]
        })
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['after:deploy:finalize']()

      // then
      expect(Client.prototype.unsubscribeAndDeleteCORS).calledWith(existingSubscription)
      return expect(Client.prototype.subscribeAndCreateCORS).calledWith({
        type: 'async',
        eventType: 'user.created',
        functionId: 'test-dev-testFunc',
        method: 'GET',
        path: '/hello1'
      })
    })

    describe('legacy mode (old subscription format support)', () => {
      it('should create http subscription', async () => {
        // given
        serverlessStub.service.getAllFunctions = sinon.stub().returns(['test-dev-testFunc'])
        serverlessStub.service.getFunction = sinon
          .stub()
          .withArgs('test-dev-testFunc')
          .returns({
            handler: 'index.test',
            events: [{ eventgateway: { event: 'http', path: '/hello', method: 'get' } }]
          })
        const plugin = constructPlugin(serverlessStub)

        // when
        plugin.hooks['package:initialize']()
        await plugin.hooks['after:deploy:finalize']()

        // then
        return expect(Client.prototype.subscribeAndCreateCORS).calledWith({
          event: 'http',
          functionId: 'test-dev-testFunc',
          method: 'get',
          path: '/hello'
        })
      })

      it('should not delete HTTP subscription', async () => {
        // given
        Client.prototype.listFunctions.resolves([{ functionId: 'test-dev-testFunc' }])
        Client.prototype.listSubscriptions.resolves([
          {
            functionId: 'test-dev-testFunc',
            eventType: 'http.request',
            type: 'sync',
            path: '/default/hello',
            method: 'POST'
          }
        ])
        serverlessStub.service.getAllFunctions = sinon.stub().returns(['test-dev-testFunc'])
        serverlessStub.service.getFunction = sinon
          .stub()
          .withArgs('test-dev-testFunc')
          .returns({
            handler: 'index.test',
            events: [{ eventgateway: { event: 'http', path: '/hello', method: 'POST' } }]
          })
        const plugin = constructPlugin(serverlessStub)

        // when
        plugin.hooks['package:initialize']()
        await plugin.hooks['after:deploy:finalize']()

        // then
        return expect(Client.prototype.unsubscribeAndDeleteCORS).not.called
      })

      it('should not delete custom event subscription', async () => {
        // given
        Client.prototype.listFunctions.resolves([{ functionId: 'test-dev-testFunc' }])
        Client.prototype.listSubscriptions.resolves([
          {
            functionId: 'test-dev-testFunc',
            eventType: 'user.created',
            type: 'async',
            path: '/default/',
            method: 'POST'
          }
        ])
        serverlessStub.service.getAllFunctions = sinon.stub().returns(['test-dev-testFunc'])
        serverlessStub.service.getFunction = sinon
          .stub()
          .withArgs('test-dev-testFunc')
          .returns({
            handler: 'index.test',
            events: [{ eventgateway: { event: 'user.created' } }]
          })
        const plugin = constructPlugin(serverlessStub)

        // when
        plugin.hooks['package:initialize']()
        await plugin.hooks['after:deploy:finalize']()

        // then
        return expect(Client.prototype.unsubscribeAndDeleteCORS).not.called
      })
    })
  })
})

const constructPlugin = (serverless, options) => {
  serverless = merge(
    {
      cli: {
        log (params) {
          return params
        },
        consoleLog (params) {
          return params
        }
      },
      getProvider: () => {}
    },
    serverless
  )

  return new Plugin(serverless, options)
}
