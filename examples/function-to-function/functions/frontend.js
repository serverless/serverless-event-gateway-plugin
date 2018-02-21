'use script'

var SDK = require('@serverless/event-gateway-sdk')
var eventGateway = new SDK({
  url: 'https://<subdomain>.eventgateway-dev.io'
})

module.exports.frontend = (event, context, cb) => {
  eventGateway
    .invoke({
      functionId: '<backend function ID>'
    })
    .then(data => {
      cb(null, data)
    })
    .catch(err => {
      cb(err)
    })
}
