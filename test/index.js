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
  let clientSpy

  beforeEach(() => {
    sandbox = sinon.sandbox.create()
    sandbox.stub(Client.prototype)
    clientSpy = sandbox.spy(Client)

    Plugin = proxyquire('../src/index.js', {
      './client': clientSpy
    })

    serverlessStub = {
      service: {
        service: 'testService',
        custom: { eventgateway: { url: 'http://localhost:4001' } },
        functions: {},
        provider: {
          compiledCloudFormationTemplate: {
            Resources: {}
          }
        }
      },
      utils: {
        getLocalAccessKey: sinon.stub().returns('')
      },
      getProvider: sandbox.stub().returns({
        getStage: sinon.stub().returns('dev'),
        getRegion: sinon.stub().returns('us-east-1'),
        naming: {
          getStackName: sinon.stub().returns('stackname'),
          getLambdaVersionOutputLogicalId: sinon.stub().returns('TestLambda'),
          getLambdaLogicalId: sinon.stub().returns('TestLambdaFunction')
        },
        request: sinon.stub().resolves({
          Stacks: [
            {
              Outputs: [
                { OutputKey: 'EventGatewayUserAccessKey', OutputValue: 'ak' },
                { OutputKey: 'EventGatewayUserSecretKey', OutputValue: 'sk' },
                {
                  OutputKey: 'TestLambda',
                  OutputValue: 'arn:aws:lambda:us-east-1:123:function:testService-dev-testFunc'
                }
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

  describe('EG client initialization', () => {
    beforeEach(() => {
      Client.prototype.listServiceEventTypes.resolves([])
      Client.prototype.listServiceCORS.resolves([])
      Client.prototype.listServiceFunctions.resolves([])
      serverlessStub.service.functions = {}
    })

    afterEach(() => {
      delete process.env['SERVERLESS_PLATFORM_STAGE']
    })

    it('should pass configuration values from serverless.yaml', async () => {
      // given
      serverlessStub.service.custom.eventgateway = {
        url: 'http://localhost:4001',
        configurationUrl: 'http://localhost:4002',
        space: 'test',
        accessKey: 'xxx'
      }
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['before:deploy:finalize']()

      // then
      expect(clientSpy).to.have.been.calledWithNew // eslint-disable-line
      expect(clientSpy.lastCall.args).to.deep.equal([
        {
          url: 'http://localhost:4001',
          configurationUrl: 'http://localhost:4002',
          accessKey: 'xxx',
          space: 'test'
        },
        'testService',
        'dev'
      ])
    })

    it('should construct URL from "app" and "tenant" values', async () => {
      // given
      serverlessStub.service.app = 'testApp'
      serverlessStub.service.tenant = 'testTenant'
      serverlessStub.service.custom.eventgateway = {}
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['before:deploy:finalize']()

      // then
      expect(clientSpy.lastCall.args[0].url).to.equal('testTenant-testApp.slsgateway.com')
    })

    it('should override URL constructed from "app" and "tenant" with the one specified in configuration', async () => {
      // given
      serverlessStub.service.app = 'testApp'
      serverlessStub.service.tenant = 'testTenant'
      serverlessStub.service.custom.eventgateway = { url: 'http://localhost:4001' }
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['before:deploy:finalize']()

      // then
      expect(clientSpy.lastCall.args[0].url).to.equal('http://localhost:4001')
    })

    it('should default to the local access key', async () => {
      // given
      serverlessStub.service.custom.eventgateway = { url: 'http://localhost:4001' }
      serverlessStub.utils.getLocalAccessKey = sinon.stub().returns('testKey')
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['before:deploy:finalize']()

      // then
      expect(clientSpy.lastCall.args[0].accessKey).to.equal('testKey')
    })

    it('should use non-prod env is SERVERLESS_PLATFORM_STAGE is set', async () => {
      // given
      process.env.SERVERLESS_PLATFORM_STAGE = 'dev'
      serverlessStub.service.app = 'testApp'
      serverlessStub.service.tenant = 'testTenant'
      serverlessStub.service.custom.eventgateway = {}
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['before:deploy:finalize']()

      // then
      expect(clientSpy.lastCall.args[0].url).to.equal('testTenant-testApp.eventgateway-dev.io')
    })
  })

  describe('addUserResource', () => {
    it('should add user definition to CF template', () => {
      // given
      serverlessStub.service.functions = {
        testFunc: {
          name: 'testService-dev-testFunc',
          handler: 'test',
          events: [{ eventgateway: { type: 'async', eventType: 'test.event' } }]
        }
      }
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      plugin.hooks['package:compileEvents']()

      // then
      const resources = plugin.serverless.service.provider.compiledCloudFormationTemplate.Resources
      expect(resources.EventGatewayUser).to.deep.equal({ Type: 'AWS::IAM::User' })
      expect(resources.EventGatewayUserKeys).to.deep.equal({
        Type: 'AWS::IAM::AccessKey',
        Properties: { UserName: { Ref: 'EventGatewayUser' } }
      })
    })

    it('should add user with policy to invoke awslambda functions', () => {
      // given
      serverlessStub.service.functions = {
        testFunc: {
          name: 'testService-dev-testFunc',
          handler: 'test',
          events: [{ eventgateway: { type: 'async', eventType: 'test.event' } }]
        },
        saveToKinesis: {
          name: 'testService-dev-saveToKinesis',
          type: 'awskinesis',
          inputs: { arn: 'fakearn', streamName: 'testStream' },
          events: [{ eventgateway: { event: 'test.tested' } }]
        }
      }
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      plugin.hooks['package:compileEvents']()

      // then
      const resources = plugin.serverless.service.provider.compiledCloudFormationTemplate.Resources
      expect(resources.EventGatewayUserPolicy.Properties.PolicyDocument.Statement[1]).to.deep.equal({
        Action: ['lambda:InvokeFunction'],
        Effect: 'Allow',
        Resource: [
          {
            'Fn::GetAtt': ['TestLambdaFunction', 'Arn']
          }
        ]
      })
    })
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
      expect(emitArgs.source).to.equal('https://github.com/serverless/serverless-event-gateway-plugin')
      expect(emitArgs.eventID).not.empty // eslint-disable-line
      expect(emitArgs.contentType).to.equal('application/json')
      expect(emitArgs.data).to.deep.equal({ foo: 'bar' })
    })
  })

  describe('functions', () => {
    beforeEach(() => {
      Client.prototype.listServiceEventTypes.resolves([])
      Client.prototype.listServiceCORS.resolves([])
    })

    it('should register awslambda function', async () => {
      // given
      serverlessStub.service.functions = {
        testFunc: {
          name: 'testService-dev-testFunc',
          handler: 'test',
          events: [{ eventgateway: { type: 'async', eventType: 'test.event' } }]
        }
      }
      Client.prototype.listServiceFunctions.resolves([])
      Client.prototype.subscribe.resolves()
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['before:deploy:finalize']()

      // then
      return expect(Client.prototype.createFunction).calledWith({
        functionId: 'testService-dev-testFunc',
        provider: {
          arn: 'arn:aws:lambda:us-east-1:123:function:testService-dev-testFunc',
          awsAccessKeyId: 'ak',
          awsSecretAccessKey: 'sk',
          region: 'us-east-1'
        },
        type: 'awslambda'
      })
    })

    it('should update existing function', async () => {
      // given
      serverlessStub.service.functions = {
        testFunc: {
          name: 'testService-dev-testFunc',
          handler: 'test',
          events: [{ eventgateway: { type: 'async', eventType: 'test.event' } }]
        }
      }
      Client.prototype.listServiceSubscriptions.resolves([])
      Client.prototype.listServiceFunctions.resolves([
        {
          functionId: 'testService-dev-testFunc',
          type: 'awskinesis',
          provider: { streamName: 'foo', region: 'bar' }
        }
      ])
      Client.prototype.subscribe.resolves()
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['before:deploy:finalize']()

      // then
      return expect(Client.prototype.updateFunction).calledWith({
        functionId: 'testService-dev-testFunc',
        provider: {
          arn: 'arn:aws:lambda:us-east-1:123:function:testService-dev-testFunc',
          awsAccessKeyId: 'ak',
          awsSecretAccessKey: 'sk',
          region: 'us-east-1'
        },
        type: 'awslambda'
      })
    })

    it('should delete remove function before registering new', async () => {
      // given
      serverlessStub.service.functions = {
        testFunc: {
          name: 'testService-dev-testFunc',
          handler: 'test',
          events: [{ eventgateway: { type: 'async', eventType: 'test.event' } }]
        }
      }
      Client.prototype.listServiceFunctions.resolves([{ functionId: 'testService-dev-testFuncRemoved' }])
      Client.prototype.listServiceSubscriptions.resolves([
        { subscriptionId: 'id', functionId: 'testService-dev-testFuncRemoved' }
      ])
      Client.prototype.subscribe.resolves()
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['before:deploy:finalize']()

      // then
      expect(Client.prototype.deleteFunction).calledWith({ functionId: 'testService-dev-testFuncRemoved' })
      expect(Client.prototype.createFunction).calledWith({
        functionId: 'testService-dev-testFunc',
        provider: {
          arn: 'arn:aws:lambda:us-east-1:123:function:testService-dev-testFunc',
          awsAccessKeyId: 'ak',
          awsSecretAccessKey: 'sk',
          region: 'us-east-1'
        },
        type: 'awslambda'
      })
      expect(Client.prototype.deleteFunction).to.have.been.calledBefore(Client.prototype.createFunction)
    })

    describe('connector functions', () => {
      beforeEach(() => {
        Client.prototype.listServiceEventTypes.resolves([])
      })

      it('should register awskinesis function', async () => {
        // given
        serverlessStub.service.functions = {
          saveToKinesis: {
            name: 'testService-dev-saveToKinesis',
            type: 'awskinesis',
            inputs: { arn: 'fakearn', streamName: 'testStream' },
            events: [{ eventgateway: { event: 'test.tested' } }]
          }
        }
        Client.prototype.listServiceFunctions.resolves([])
        Client.prototype.subscribe.resolves()
        const plugin = constructPlugin(serverlessStub)

        // when
        plugin.hooks['package:initialize']()
        await plugin.hooks['before:deploy:finalize']()

        // then
        return expect(Client.prototype.createFunction).calledWith({
          functionId: 'testService-dev-saveToKinesis',
          provider: { streamName: 'testStream', awsAccessKeyId: 'ak', awsSecretAccessKey: 'sk', region: 'us-east-1' },
          type: 'awskinesis'
        })
      })

      it('should throw an error if connector function has no inputs', async () => {
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

      it('should throw an error if awskinesis function has only arn in inputs', async () => {
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

      it('should throw an error if awskinesis function has incomplete inputs', async () => {
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

      it('should throw an error if awsfirehose function has incomplete inputs', async () => {
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

      it('should throw an error if awssqs function has incomplete inputs', async () => {
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

      it('should prepare correct IAM Policies', async () => {
        // given
        const arn = 'fakearn'
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
  })

  describe('event types', () => {
    beforeEach(() => {
      Client.prototype.listServiceCORS.resolves([])

      serverlessStub.service.functions = {
        testFunc: {
          name: 'testService-dev-testFunc',
          handler: 'test',
          events: [{ eventgateway: { type: 'async', eventType: 'test.event' } }]
        }
      }
    })

    it('should create event type if defined in eventTypes in configuration', async () => {
      // given
      serverlessStub.service.custom.eventTypes = { 'test.event': null }
      Client.prototype.listServiceEventTypes.resolves([])
      Client.prototype.listServiceFunctions.resolves([])
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['before:deploy:finalize']()

      // then
      return expect(Client.prototype.createEventType).calledWith({ name: 'test.event' })
    })

    it('should create event type if used in subscription', async () => {
      // given
      Client.prototype.listServiceFunctions.resolves([])
      Client.prototype.listServiceEventTypes.resolves([])
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['before:deploy:finalize']()

      // then
      return expect(Client.prototype.createEventType).calledWith({ name: 'test.event' })
    })

    it('should remove event types no longer defined in configuration', async () => {
      // given
      serverlessStub.service.custom.eventTypes = { 'test.event': {} }
      Client.prototype.listServiceFunctions.resolves([])
      Client.prototype.listServiceEventTypes.resolves([{ name: 'test.event' }, { name: 'test.event.deleted' }])
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['before:deploy:finalize']()

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
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['before:deploy:finalize']()

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
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['before:deploy:finalize']()

      // then
      return expect(Client.prototype.updateEventType).calledWith({
        name: 'test.event',
        authorizerId: 'testService-dev-testFunc'
      })
    })

    it('should update with metadata if defined in configuration and does not have service assigned', async () => {
      // given
      serverlessStub.service.custom.eventTypes = { 'test.event': {} }
      Client.prototype.listServiceEventTypes.resolves([])
      Client.prototype.listEventTypes.resolves([{ name: 'test.event' }])
      Client.prototype.listServiceFunctions.resolves([])
      Client.prototype.createEventType.rejects(new Error('already exists'))
      Client.prototype.updateEventType.resolves()
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['before:deploy:finalize']()

      // then
      return expect(Client.prototype.updateEventType).calledWith({ name: 'test.event' })
    })
  })

  describe('subscriptions', () => {
    beforeEach(() => {
      Client.prototype.listServiceEventTypes.resolves([])
      Client.prototype.listServiceFunctions.resolves([])
      Client.prototype.listServiceCORS.resolves([])

      serverlessStub.service.functions = {
        testFunc: {
          name: 'testService-dev-testFunc',
          handler: 'test',
          events: [
            {
              eventgateway: {
                type: 'async',
                eventType: 'user.created',
                path: '/hello',
                method: 'GET'
              }
            },
            {
              http: {
                path: '/test',
                method: 'GET'
              }
            }
          ]
        }
      }
    })

    it('should create subscription', async () => {
      // given
      Client.prototype.listServiceSubscriptions.resolves([])
      Client.prototype.listServiceFunctions.resolves([{ functionId: 'test-dev-testFunc' }])
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['before:deploy:finalize']()

      // then
      expect(Client.prototype.subscribe).calledWith({
        type: 'async',
        eventType: 'user.created',
        functionId: 'testService-dev-testFunc',
        method: 'GET',
        path: '/hello'
      })
    })

    it('should create CORS configuration', async () => {
      // given
      serverlessStub.service.functions.testFunc.events[0].eventgateway.cors = true
      Client.prototype.listServiceSubscriptions.resolves([])
      Client.prototype.listServiceFunctions.resolves([{ functionId: 'test-dev-testFunc' }])
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['before:deploy:finalize']()

      // then
      return expect(Client.prototype.createCORSFromSubscription).calledWith({
        type: 'async',
        eventType: 'user.created',
        functionId: 'testService-dev-testFunc',
        method: 'GET',
        path: '/hello',
        cors: true
      })
    })

    it('should recreate subscription if path changed', async () => {
      // given
      const existingSubscription = {
        subscriptionId: 'testid',
        type: 'async',
        functionId: 'testService-dev-testFunc',
        method: 'GET',
        path: '/differentpath'
      }
      Client.prototype.unsubscribe.resolves()
      Client.prototype.listServiceSubscriptions.resolves([existingSubscription])
      Client.prototype.listServiceFunctions.resolves([{ functionId: 'testService-dev-testFunc' }])
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['before:deploy:finalize']()

      // then
      expect(Client.prototype.unsubscribe).calledWith(existingSubscription)
      return expect(Client.prototype.subscribe).calledWith({
        type: 'async',
        eventType: 'user.created',
        functionId: 'testService-dev-testFunc',
        method: 'GET',
        path: '/hello'
      })
    })

    it('should update CORS configuration', async () => {
      // given
      serverlessStub.service.functions.testFunc.events[0].eventgateway.cors = true
      Client.prototype.listServiceCORS.resolves([
        {
          corsId: 'testid',
          path: '/hello',
          method: 'GET'
        }
      ])
      Client.prototype.listServiceSubscriptions.resolves([])
      Client.prototype.subscribe.resolves({
        subscriptionId: 'testid',
        type: 'async',
        eventType: 'user.created',
        path: '/hello',
        method: 'GET'
      })
      Client.prototype.listServiceFunctions.resolves([{ functionId: 'testService-dev-testFunc' }])
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['before:deploy:finalize']()

      // then
      return expect(Client.prototype.updateCORSFromSubscription).calledWith(
        {
          type: 'async',
          eventType: 'user.created',
          functionId: 'testService-dev-testFunc',
          method: 'GET',
          path: '/hello',
          cors: true
        },
        { corsId: 'testid', path: '/hello', method: 'GET' }
      )
    })

    it('should remove not used subscription', async () => {
      // given
      const existingSubscription = {
        subscriptionId: 'testid1',
        type: 'async',
        eventType: 'user.created',
        functionId: 'testService-dev-testFunc',
        method: 'GET',
        path: '/hello1'
      }
      const notUsedSubscription = {
        subscriptionId: 'testid2',
        type: 'async',
        eventType: 'test.deleted',
        functionId: 'test-dev-testFunc',
        method: 'GET',
        path: '/hello1'
      }
      Client.prototype.unsubscribe.resolves()
      Client.prototype.listServiceSubscriptions.resolves([existingSubscription, notUsedSubscription])
      Client.prototype.listServiceFunctions.resolves([{ functionId: 'test-dev-testFunc' }])
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['before:deploy:finalize']()

      // then
      return expect(Client.prototype.unsubscribe).calledWith(notUsedSubscription)
    })

    describe('legacy mode (old subscription format support)', () => {
      it('should create http subscription', async () => {
        // given
        serverlessStub.service.functions = {
          testFunc: {
            name: 'testService-dev-testFunc',
            handler: 'test',
            events: [{ eventgateway: { event: 'http', path: '/hello', method: 'get' } }]
          }
        }
        const plugin = constructPlugin(serverlessStub)

        // when
        plugin.hooks['package:initialize']()
        await plugin.hooks['before:deploy:finalize']()

        // then
        return expect(Client.prototype.subscribe).calledWith({
          event: 'http',
          functionId: 'testService-dev-testFunc',
          method: 'get',
          path: '/hello'
        })
      })

      it('should not delete HTTP subscription', async () => {
        // given
        Client.prototype.listFunctions.resolves([{ functionId: 'test-dev-testFunc' }])
        Client.prototype.listSubscriptions.resolves([
          {
            functionId: 'testService-dev-testFunc',
            eventType: 'http.request',
            type: 'sync',
            path: '/default/hello',
            method: 'POST'
          }
        ])
        const plugin = constructPlugin(serverlessStub)

        // when
        plugin.hooks['package:initialize']()
        await plugin.hooks['before:deploy:finalize']()

        // then
        return expect(Client.prototype.unsubscribe).not.called
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
        const plugin = constructPlugin(serverlessStub)

        // when
        plugin.hooks['package:initialize']()
        await plugin.hooks['before:deploy:finalize']()

        // then
        return expect(Client.prototype.unsubscribe).not.called
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
