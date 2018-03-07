# Basic example

This example shows how subscribe a function to custom event.

## How To

1. Clone repository

```
git clone git@github.com:serverless/serverless-event-gateway-plugin.git
```

2. Change directory to basic example

```
cd serverless-event-gateway-plugin/examples/basic
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

6. Emit custom event

```
serverless gateway emit -e user.created -d '{"username": "bob"}'
```

7. Now, your function will be invoke by Event Gateway. You can inspect the event with CloudWatch in AWS console or `serverless logs` command.
