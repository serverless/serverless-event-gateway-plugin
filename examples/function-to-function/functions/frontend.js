"use script";

var fdk = require("@serverless/fdk");
var eventGateway = fdk.eventGateway({
  url: 'https://<subdomain>.eventgateway-dev.io',
});

module.exports.frontend = (event, context, cb) => {
  eventGateway.invoke({
    functionId: "<backend function ID>"
  }).then(data => {
    cb(null, data);
  }).catch(err => {
    cb(err);
  });
};
