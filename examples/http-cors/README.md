# HTTP CORS example

This example shows how to build simple HTTP endpoint with CORS support.

## How To

1. Clone repository

```
git clone git@github.com:serverless/serverless-event-gateway-plugin.git
```

2. Change directory to CORS example

```
cd serverless-event-gateway-plugin/examples/http-cors
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
    apiKey: <your API key>
```

5. Deploy service

```
serverless deploy
```

6. `curl` the endpoint to see CORS headers

```
$ curl -X OPTIONS -H "Access-Control-Request-Method: GET" -i https://<subdomain>.eventgateway-dev.io/rest
HTTP/2 200
date: Mon, 05 Feb 2018 16:11:02 GMT
content-type: text/plain; charset=utf-8
content-length: 0
vary: Origin
vary: Access-Control-Request-Method
vary: Access-Control-Request-Headers
```
