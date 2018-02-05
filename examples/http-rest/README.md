# HTTP REST example

This example shows how to build simple HTTP REST endpoint.

## How To

1. Clone repository

```
git clone git@github.com:serverless/serverless-event-gateway-plugin.git
```

2. Change directory to REST example

```
cd serverless-event-gateway-plugin/examples/http-rest
```

3. Install dependencies

```
npm install
```

4. Update `serverless.yml` with your subdomain and apikey

```
custom:
  eventgateway:
    subdomain: <your subdomain>
    apikey: <your API key>
```

5. Deploy service

```
serverless deploy
```

6. `curl` the endpoint with different HTTP methods

```
$ curl -X POST https://<subdomain>.eventgateway-dev.io/rest/10
POST resource with id: 10

$ curl -X GET https://<subdomain>.eventgateway-dev.io/rest/10
GET resource with id: 10

$ curl -X DELETE https://<subdomain>.eventgateway-dev.io/rest/10
DELETE resource with id: 10
```
