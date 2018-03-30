const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
const expect = chai.expect

const EventGatewayPlugin = require('../src/index.js')

describe('Event Gateway Plugin', () => {
  it('throws an error if the user passes a subdomain', () => {
    const plugin = constructPlugin('', 'mykey', '', '', 'mysubdomain')

    expect(plugin.hooks['after:deploy:finalize']()).to.eventually.be.rejectedWith('The "subdomain" property in eventgateway config in serverless.yml is deprecated. Please use "space" instead.')
  })

  it('throws an error if the user does not provide an apiKey in hosted mode', () => {
    const plugin = constructPlugin('myspace')

    expect(plugin.hooks['after:deploy:finalize']()).to.eventually.be.rejectedWith('Required "apiKey" property is missing from Event Gateway configuration provided in serverless.yaml')
  })
})

const constructPlugin =
  (space, apiKey, eventsAPI, configurationAPI, subdomain) => {
    const serverless = {
      cli: {
        log (params) { return params },
        consoleLog (params) {
          return params
        }
      },
      service: {
        provider: {
          region: 'us-east-1',
          stage: 'dev'
        },
        custom: {
          eventgateway: {
          }
        }
      },
      getProvider: () => {
        return {}
      }
    }

    if (space) {
      serverless.service.custom.eventgateway.space = space
    }

    if (apiKey) {
      serverless.service.custom.eventgateway.apiKey = apiKey
    }

    if (eventsAPI) {
      serverless.service.custom.eventgateway.eventsAPI = eventsAPI
    }

    if (configurationAPI) {
      serverless.service.custom.eventgateway.configurationAPI = configurationAPI
    }

    if (subdomain) {
      serverless.service.custom.eventgateway.subdomain = subdomain
    }

    return new EventGatewayPlugin(serverless, {})
  }
