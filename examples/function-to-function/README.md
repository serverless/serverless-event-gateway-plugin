# Function to function call example

This example shows how to call a function from another function.

## How To

1. Clone repository

```
git clone git@github.com:serverless/serverless-event-gateway-plugin.git
```

2. Change directory to basic example

```
cd serverless-event-gateway-plugin/examples/function-to-function
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

6. Take the `backend` function ID from console output and update the `frontend` function with subdomain and `backend` function ID.

```
Event Gateway Plugin
EventGateway: Function "backend" registered. (ID: 153b6071a5bdd291f64e7be0a74bbe7bf66a3b6c2047f97a148646720f322cde)
```

7. Deploy `frontend` function again

```
serverless deploy -f frontend
```

7. Now, every time you visit `frontend` function endpoint, result from `backend` function will be returned.
