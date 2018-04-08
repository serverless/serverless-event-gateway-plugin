# Event Gateway plugin for Serverless Framework

Serverless plugin that publishes your functions and subscriptions to Hosted Event Gateway.

## Before you start

Get an API key from someone on [the Serverless team](mailto:hello@serverless.com).

## Example

Looking for an example to get started? Check out the [**Getting Started Example**](https://github.com/serverless/event-gateway-getting-started) to deploy your first service to the Event Gateway.

## Usage

1. Create a new Serverless service and change into the directory.

2. Install the plugin: (needs Node version 7+)

	```bash
	$ npm install --save-dev @serverless/serverless-event-gateway-plugin
	```

3. Enter the necessary plugin and config in `serverless.yml`:

	```yml
	# serverless.yml

	service: my-service

	custom:
	  eventgateway:
	    space: myspace  // any name you choose 
	    apiKey: <yourkey>
	  # To use self-hosted Event Gateway, use the following
	  #  eventsAPI: http://localhost:4000
	  #  configurationAPI: http://localhost:4001

	plugins:
	  - "@serverless/serverless-event-gateway-plugin"

	provider:
	  name: aws
	  runtime: python3.6
	  stage: dev
	  region: us-west-2
	...
	```

4. Wire up functions with an `eventgateway` event type:

	```yml
	# serverless.yml

	functions:
	  hello:
	    handler: handler.hello
	    events:
	      - eventgateway:
	          event: http
	          path: /hello
	          method: GET
	  goodbye:
	    handler: handler.goodbye
	    events:
	      - eventgateway:
	          event: http
	          path: /goodbye
	          method: GET            
	```

5. Deploy, then invoke your function(s):

	  ```bash
	  $ sls deploy
    ....
    
	  $ curl -X GET https://myspace.slsgateway.com/hello
    ...
    
    $ curl -X GET https://myspace.slsgateway.com/goodbye
    ...
	  ```

6. View your space configuration with `sls gateway dashboard`:

    ```bash
    $ sls gateway dashboard

    Event Gateway

     space: myspace 
     endpoint: https://myspace.slsgateway.com

    Functions
    ┌─────────────────────────────────┬───────────┬────────────────────────────────────────────────────────────────────────────────┐
    │ Function Id                     │ Region    │ ARN                                                                            │
    ├─────────────────────────────────┼───────────┼────────────────────────────────────────────────────────────────────────────────┤
    │ my-service-dev-hello            │ us-east-1 │ arn:aws:lambda:us-east-1:111111111111:function:my-service-dev-hello            │
    ├─────────────────────────────────┼───────────┼────────────────────────────────────────────────────────────────────────────────┤
    │ my-service-dev-goodbye          │ us-east-1 │ arn:aws:lambda:us-east-1:111111111111:function:my-service-dev-goodbye          │
    └─────────────────────────────────┴───────────┴────────────────────────────────────────────────────────────────────────────────┘

    Subscriptions
    ┌────────┬─────────────────────────────────┬────────┬───────────────────────┐
    │ Event  │ Function ID                     │ Method │ Path                  │
    ├────────┼─────────────────────────────────┼────────┼───────────────────────┤
    │ http   │ my-service-dev-hello            │ GET    │ /myspace/hello        │
    ├────────┼─────────────────────────────────┼────────┼───────────────────────┤
    │ http   │ my-service-dev-goodbye          │ GET    │ /myspace/goodbye      │
    └────────┴─────────────────────────────────┴────────┴───────────────────────┘
    ```


## Concepts

**Core concepts:**

- **Function:** A function is a piece of compute + logic that is ready to respond to an event. Currently, functions can be AWS Lambda functions or HTTP-accessible endpoints.
- **Events:** Events are bits of data indicating something happened -- a user was created, a email was sent, or a client requested made an HTTP request.
- **Subscriptions:** Events are routed to functions via subscriptions. Subscriptions may be *synchronous*, as in the case of subscriptions for HTTP events, or *asynchronous*, as in the case of custom events.

**Event concepts:**

- **HTTP Event:** In the Event Gateway, an HTTP event is an event which expects a synchronous response from a backing function. An HTTP event subscription is a combination of *method* and *path* -- e.g. "GET /users" vs "POST /users".
- **Custom Events:** All non-HTTP events are custom events. Custom events are asynchronous. You may have multiple functions subscribed to the same custom event.

**Auth concepts:**

- **Space:** A space is a name-spacing mechanism within the Event Gateway. All functions and subscriptions in a space are completely isolated from all other spaces. When using with the hosted Event Gateway, your space will get its own subdomain at `https://<spaceName>.slsgateway.com`.
- **API key:** The API key is the security mechanism for a space within the hosted Event Gateway. A space belongs to one and only one API key, but an API can own multiple spaces. A request must have the proper API key to modify functions and subscriptions in a space.
