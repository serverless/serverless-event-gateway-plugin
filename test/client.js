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

    proxyquire('../src/index.js', {
      '@serverless/event-gateway-sdk': SDK
    })
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('createEventType', () => {
    beforeEach(() => {
      sandbox.stub(SDK.prototype, 'createEventType')
    })

    it('should add metadata with service and stage', () => {
      SDK.prototype.createEventType.resolves()
      const client = new Client({ url: 'http://localhost:4001' }, 'test', 'dev')

      client.createEventType({ name: 'test' })

      return expect(SDK.prototype.createEventType).to.calledWith({
        name: 'test',
        metadata: {
          service: 'test',
          stage: 'dev'
        }
      })
    })
  })

  describe('updateEventType', () => {
    beforeEach(() => {
      sandbox.stub(SDK.prototype, 'updateEventType')
      SDK.prototype.updateEventType.resolves()
    })

    it('should add metadata with service and stage', () => {
      const client = new Client({ url: 'http://localhost:4001' }, 'test', 'dev')

      client.updateEventType({ name: 'test' })

      return expect(SDK.prototype.updateEventType).to.calledWith({
        name: 'test',
        metadata: {
          service: 'test',
          stage: 'dev'
        }
      })
    })

    it('should not override existing metadata', () => {
      const client = new Client({ url: 'http://localhost:4001' }, 'test', 'dev')

      client.updateEventType({ name: 'test', metadata: { foo: 'bar' } })

      return expect(SDK.prototype.updateEventType).to.calledWith({
        name: 'test',
        metadata: {
          service: 'test',
          stage: 'dev',
          foo: 'bar'
        }
      })
    })
  })

  describe('createFunction', () => {
    beforeEach(() => {
      sandbox.stub(SDK.prototype, 'createFunction')
    })

    it('should throw an error', () => {
      SDK.prototype.createFunction.rejects('Error')
      const client = new Client({ url: 'http://localhost:4001' }, 'test', 'dev')

      const result = client.createFunction({ functionId: 'test' })

      return expect(result).to.be.rejectedWith(`Couldn't register a function test. Error`)
    })

    it('should add metadata with service and stage', () => {
      SDK.prototype.createFunction.resolves()
      const client = new Client({ url: 'http://localhost:4001' }, 'test', 'dev')

      client.createFunction({ functionId: 'test' })

      return expect(SDK.prototype.createFunction).to.calledWith({
        functionId: 'test',
        metadata: {
          service: 'test',
          stage: 'dev'
        }
      })
    })
  })

  describe('listServiceFunctions', () => {
    beforeEach(() => {
      sandbox.stub(SDK.prototype, 'listFunctions')
    })

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
    beforeEach(() => {
      sandbox.stub(SDK.prototype, 'listSubscriptions')
    })

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

  describe('listServiceEventTypes', () => {
    beforeEach(() => {
      sandbox.stub(SDK.prototype, 'listEventTypes')
    })

    it('should return function for specific service', () => {
      SDK.prototype.listEventTypes.resolves([{ name: 'test1', metadata: { service: 'testService1', stage: 'dev' } }])
      const client = new Client({ url: 'http://localhost:4001' }, 'testService1', 'dev')

      const result = client.listServiceEventTypes()

      expect(SDK.prototype.listEventTypes).to.calledWith({
        'metadata.service': 'testService1',
        'metadata.stage': 'dev'
      })
      return expect(result).to.eventually.be.deep.equal([
        { name: 'test1', metadata: { service: 'testService1', stage: 'dev' } }
      ])
    })
  })

  describe('subscribeAndCreateCORS', () => {
    beforeEach(() => {
      sandbox.stub(SDK.prototype, 'subscribe')
    })

    it('should support legacy custom event format', async () => {
      const client = new Client({ url: 'http://localhost:4001' }, 'testService', 'dev')

      await client.subscribeAndCreateCORS({
        functionId: 'test',
        event: 'test.event',
        path: '/test'
      })

      return expect(SDK.prototype.subscribe).calledWith({
        type: 'async',
        functionId: 'test',
        eventType: 'test.event',
        path: '/default/test',
        method: 'POST',
        metadata: {
          service: 'testService',
          stage: 'dev'
        }
      })
    })

    it('should support legacy HTTP event format', async () => {
      const client = new Client({ url: 'http://localhost:4001' }, 'testService', 'dev')

      await client.subscribeAndCreateCORS({
        functionId: 'test',
        event: 'http',
        path: '/test',
        method: 'POST'
      })

      return expect(SDK.prototype.subscribe).calledWith({
        type: 'sync',
        functionId: 'test',
        eventType: 'http.request',
        path: '/default/test',
        method: 'POST',
        metadata: {
          service: 'testService',
          stage: 'dev'
        }
      })
    })

    it('should support legacy CORS format', async () => {
      SDK.prototype.subscribe.resolves()
      sandbox.stub(SDK.prototype, 'createCORS')
      const client = new Client({ url: 'http://localhost:4001' }, 'testService', 'dev')

      await client.subscribeAndCreateCORS({
        type: 'async',
        functionId: 'test',
        eventType: 'test.event',
        path: '/test',
        method: 'POST',
        cors: {
          origins: ['http://example.com'],
          methods: ['POST'],
          headers: ['x-api-key'],
          allowCredentials: true
        }
      })

      return expect(SDK.prototype.createCORS).calledWith({
        method: 'POST',
        path: '/default/test',
        allowedOrigins: ['http://example.com'],
        allowedMethods: ['POST'],
        allowedHeaders: ['x-api-key'],
        allowCredentials: true,
        metadata: {
          service: 'testService',
          stage: 'dev'
        }
      })
    })

    it('should prefix path with space', async () => {
      const client = new Client({ url: 'http://localhost:4001' }, 'testService', 'dev')

      await client.subscribeAndCreateCORS({
        type: 'async',
        functionId: 'test',
        eventType: 'test.event',
        path: '/test',
        method: 'POST'
      })

      return expect(SDK.prototype.subscribe).calledWith({
        type: 'async',
        functionId: 'test',
        eventType: 'test.event',
        path: '/default/test',
        method: 'POST',
        metadata: {
          service: 'testService',
          stage: 'dev'
        }
      })
    })

    it('should configure CORS (inclugin metadata)', async () => {
      SDK.prototype.subscribe.resolves()
      sandbox.stub(SDK.prototype, 'createCORS')
      const client = new Client({ url: 'http://localhost:4001' }, 'testService', 'dev')

      await client.subscribeAndCreateCORS({
        type: 'async',
        functionId: 'test',
        eventType: 'test.event',
        path: '/test',
        method: 'POST',
        cors: true
      })

      return expect(SDK.prototype.createCORS).calledWith({
        method: 'POST',
        path: '/default/test',
        metadata: {
          service: 'testService',
          stage: 'dev'
        }
      })
    })

    it('should remove CORS configuration when the subscription is removed', async () => {
      sandbox.stub(SDK.prototype, 'unsubscribe').resolves()
      sandbox.stub(SDK.prototype, 'createCORS').resolves()
      sandbox.stub(SDK.prototype, 'deleteCORS')
      sandbox.stub(SDK.prototype, 'listCORS').resolves([{ corsId: 'GET%2Ftest', path: '/test', method: 'GET' }])
      const client = new Client({ url: 'http://localhost:4001' }, 'testService', 'dev')

      await client.unsubscribeAndDeleteCORS({ subscriptionId: 'testid', method: 'GET', path: '/test' })

      return expect(SDK.prototype.deleteCORS).calledWith({
        corsId: 'GET%2Ftest'
      })
    })
  })
})
