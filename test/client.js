const chai = require('chai')
chai.use(require('chai-as-promised'))
chai.use(require('sinon-chai'))
const expect = chai.expect
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const SDK = require('@serverless/event-gateway-sdk')
const Client = require('../src/client.js')

describe('Event Gateway Client', () => {
  let sandbox

  beforeEach(() => {
    sandbox = sinon.sandbox.create()

    sandbox.stub(SDK.prototype, 'createFunction')
    sandbox.stub(SDK.prototype, 'listFunctions')
    sandbox.stub(SDK.prototype, 'listSubscriptions')

    proxyquire('../src/index.js', {
      '@serverless/event-gateway-sdk': SDK
    })
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('createFunction', () => {
    it('should throw an error', () => {
      SDK.prototype.createFunction.rejects('Error')
      const client = new Client({ url: 'http://localhost:4001' }, 'test', 'dev')

      const result = client.createFunction({ functionId: 'test' })

      return expect(result).to.eventually.be.rejectedWith(`Couldn't register a function test. Error`)
    })
  })

  describe('listServiceFunctions', () => {
    it('should return function for specific service', () => {
      SDK.prototype.listFunctions.resolves([
        { functionId: 'testService1-dev-func1' },
        { functionId: 'testService2-dev-func2' }
      ])
      const client = new Client({ url: 'http://localhost:4001' }, 'testService1', 'dev')

      const result = client.listServiceFunctions()

      return expect(result).to.eventually.be.deep.equal([{ functionId: 'testService1-dev-func1' }])
    })
  })

  describe('listServiceSubscriptions', () => {
    it('should return function for specific service', () => {
      SDK.prototype.listSubscriptions.resolves([
        { functionId: 'testService1-dev-func1' },
        { functionId: 'testService2-dev-func2' }
      ])
      const client = new Client({ url: 'http://localhost:4001' }, 'testService1', 'dev')

      const result = client.listServiceSubscriptions()

      return expect(result).to.eventually.be.deep.equal([{ functionId: 'testService1-dev-func1' }])
    })
  })
})
