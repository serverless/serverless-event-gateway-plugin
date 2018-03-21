# Event Gateway plugin for Serverless Framework

Serverless plugin that publishes your functions and subscriptions to Hosted Event Gateway.

## Before you start

Get an API key from someone on [the Serverless team](mailto:hello@serverless.com).

## Examples

Looking for some examples to get started?

- To use custom events to allow for asynchronous, decoupled communication between services, check out [this example](./examples/crm-service) on updating your CRM service whenever a new user is created in your Users service.
- For using Event Gateway as an API Gateway to tie together hundreds of functions across multiple services, look at [this example](./examples/users-service) for deploying a REST-like Users service with standard CRUD endpoints.

## Usage

1. Create a new Serverless service and change into the directory.

2. Install the plugin:

	```bash
	$ npm install --save-dev @serverless/serverless-event-gateway-plugin
	```

3. Enter the necessary plugin and config in `serverless.yml`:

	```yml
	# serverless.yml

	service: my-service-name

	custom:
	  eventgateway:
	    subdomain: <your-subdomain>
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
	          path: /
	          method: GET
	```

5. Deploy, then invoke your function:

	```bash
	$ sls deploy
	....
	$ curl -X GET https://<your-subdomain>.eventgateway-dev.io
	```

6. View your space configuration with `sls gateway dashboard`:

    ```bash
    $ sls gateway dashboard

    Event Gateway

     space: myspace 
     endpoint: https://myspace.eventgateway-dev.io

    Functions
    ┌─────────────────────────────────┬───────────┬────────────────────────────────────────────────────────────────────────────────┐
    │ Function Id                     │ Region    │ ARN                                                                            │
    ├─────────────────────────────────┼───────────┼────────────────────────────────────────────────────────────────────────────────┤
    │ my-service-hello-world          │ us-east-1 │ arn:aws:lambda:us-east-1:111111111111:function:my-service-hello-world          │
    ├─────────────────────────────────┼───────────┼────────────────────────────────────────────────────────────────────────────────┤
    │ my-service-goodbye-world        │ us-east-1 │ arn:aws:lambda:us-east-1:111111111111:function:my-service-goodbye-world        │
    └─────────────────────────────────┴───────────┴────────────────────────────────────────────────────────────────────────────────┘

    Subscriptions
    ┌────────┬─────────────────────────────────┬────────┬───────────────────────┐
    │ Event  │ Function ID                     │ Method │ Path                  │
    ├────────┼─────────────────────────────────┼────────┼───────────────────────┤
    │ http   │ my-service-hello-world          │ POST   │ /myspace/hello        │
    ├────────┼─────────────────────────────────┼────────┼───────────────────────┤
    │ http   │ my-service-goodbye-world        │ POST   │ /myspace/goodbye      │
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

- **Subdomain:** A subdomain is a name-spacing mechanism within the Event Gateway. All functions and subscriptions in a subdomain are completely isolated from all other subdomains.
- **API key:** The API key is the security mechanism for a subdomain. A subdomain belongs to one and only one API key, but an API can own multiple subdomains. A request must have the proper API key to modify functions and subscriptions in a subdomain.
