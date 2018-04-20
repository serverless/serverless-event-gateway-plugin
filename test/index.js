const chai = require('chai')
chai.use(require('chai-as-promised'))
chai.use(require('sinon-chai'))
const expect = chai.expect
const merge = require('lodash.merge')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

let Plugin = require('../src/index.js')

describe('Event Gateway Plugin', () => {
  describe('connector functions', () => {
    let sandbox
    let sdkStub
    let serverlessStub

    beforeEach(() => {
      sandbox = sinon.sandbox.create()

      sdkStub = {
        registerFunction: sandbox.stub().resolves(),
        listFunctions: sandbox.stub().resolves([]),
        listSubscriptions: sandbox.stub().resolves([]),
        subscribe: sandbox.stub().resolves()
      }

      Plugin = proxyquire('../src/index.js', {
        '@serverless/event-gateway-sdk': function () {
          return sdkStub
        }
      })

      serverlessStub = {
        service: {
          service: 'test',
          custom: { eventgateway: { space: 'testspace', apiKey: 'xxx' } },
          functions: {},
          getAllFunctions: sandbox.stub().returns([])
        },
        getProvider: sandbox.stub().returns({
          getStage: sinon.stub().returns('dev'),
          getRegion: sinon.stub().returns('us-east-1'),
          naming: { getStackName: sinon.stub().returns('stackname') },
          request: sinon.stub().resolves({
            Stacks: [
              {
                Outputs: [
                  { OutputKey: 'EventGatewayUserAccessKey', OutputValue: 'ak' },
                  { OutputKey: 'EventGatewayUserSecretKey', OutputValue: 'sk' }
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
      sdkStub.registerFunction = sandbox.stub().rejects('Error')

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
      sdkStub.registerFunction = sandbox.stub().rejects('Error')

      return expect(plugin.hooks['package:initialize']).to.throw(
        `Invalid inputs for ${funcType} function "${funcName}". ` +
        `You provided ${Object.keys(func.inputs).map(i => `"${i}"`).join(', ')}. Please provide either "logicalId" or both "arn" and "streamName" inputs.`
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
      sdkStub.registerFunction = sandbox.stub().rejects('Error')

      return expect(plugin.hooks['package:initialize']).to.throw(
        `Invalid inputs for ${funcType} function "${funcName}". ` +
        `You provided ${Object.keys(func.inputs).map(i => `"${i}"`).join(', ')}. Please provide either "logicalId" or both "arn" and "${inputName}" inputs.`
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
      sdkStub.registerFunction = sandbox.stub().rejects('Error')

      return expect(plugin.hooks['package:initialize']).to.throw(
        `Invalid inputs for ${funcType} function "${funcName}". ` +
        `You provided ${Object.keys(func.inputs).map(i => `"${i}"`).join(', ')}. Please provide either "logicalId" or both "arn" and "${inputName}" inputs.`
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
      sdkStub.registerFunction = sandbox.stub().rejects('Error')

      return expect(plugin.hooks['package:initialize']).to.throw(
        `Invalid inputs for ${funcType} function "${funcName}". ` +
        `You provided ${Object.keys(func.inputs).map(i => `"${i}"`).join(', ')}. Please provide either "logicalId" or both "arn" and "${inputName}" inputs.`
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
      return expect(sdkStub.registerFunction).calledWith({
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
      sdkStub.registerFunction = sandbox.stub().rejects('Error')

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

  it('throws an error if the user passes a subdomain', () => {
    const plugin = constructPlugin({
      service: { custom: { eventgateway: { apiKey: 'mykey', subdomain: 'mysubdomain' } } }
    })

    return expect(plugin.hooks['after:deploy:finalize']()).to.eventually.be.rejectedWith(
      'The "subdomain" property in eventgateway config in serverless.yml is deprecated. Please use "space" instead.'
    )
  })

  it('throws an error if the user does not provide an apiKey in hosted mode', () => {
    const plugin = constructPlugin({ service: { custom: { eventgateway: { space: 'myspace' } } } })

    return expect(plugin.hooks['after:deploy:finalize']()).to.eventually.be.rejectedWith(
      'Required "apiKey" property is missing from Event Gateway configuration provided in serverless.yaml'
    )
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
