const chai = require('chai')
chai.use(require('chai-as-promised'))
chai.use(require('sinon-chai'))
const expect = chai.expect
const merge = require('lodash.merge')
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const SDK = require('@serverless/event-gateway-sdk')

let Plugin = require('../src/index.js')

describe('Event Gateway Plugin', () => {
  let sandbox
  let serverlessStub

  beforeEach(() => {
    sandbox = sinon.sandbox.create()

    sandbox.stub(SDK.prototype, 'registerFunction').resolves()
    sandbox.stub(SDK.prototype, 'listFunctions').resolves([])
    sandbox.stub(SDK.prototype, 'listSubscriptions').resolves([])
    sandbox.stub(SDK.prototype, 'subscribe').resolves()

    Plugin = proxyquire('../src/index.js', {
      '@serverless/event-gateway-sdk': SDK
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
                { OutputKey: 'TestLambda', OutputValue: 'arn:aws:lambda:us-east-1:123:function:testFunc' }
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

  describe('connector functions', () => {
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
      SDK.prototype.registerFunction.rejects('Error')

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
      SDK.prototype.registerFunction.rejects('Error')

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
      SDK.prototype.registerFunction.rejects('Error')

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
      SDK.prototype.registerFunction.rejects('Error')

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
      SDK.prototype.registerFunction.rejects('Error')

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
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['after:deploy:finalize']()

      // then
      return expect(SDK.prototype.registerFunction).calledWith({
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
      const plugin = constructPlugin(serverlessStub)
      SDK.prototype.registerFunction.rejects('Error')

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
    it('should create http subscription', async () => {
      // given
      serverlessStub.service.getAllFunctions = sinon.stub().returns(['testFunc'])
      serverlessStub.service.getFunction = sinon
        .stub()
        .withArgs('testFunc')
        .returns({
          handler: 'index.test',
          events: [{ eventgateway: { event: 'http', path: '/hello', method: 'get' } }]
        })
      const plugin = constructPlugin(serverlessStub)

      // when
      plugin.hooks['package:initialize']()
      await plugin.hooks['after:deploy:finalize']()

      // then
      return expect(SDK.prototype.subscribe).calledWith({
        functionId: 'testFunc',
        event: 'http',
        method: 'GET',
        path: '/default/hello',
        cors: undefined
      })
    })
  })
})

const constructPlugin = serverless => {
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

  return new Plugin(serverless, {})
}
