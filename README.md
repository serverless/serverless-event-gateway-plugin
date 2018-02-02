# Event Gateway plugin for Serverless Framework

Serverless plugin that publishes your functions and subscriptions to Hosted Event Gateway.

## Before you start

Get an API key from someone on [the Serverless team](mailto:hello@serverless.com).

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
	    apikey: <yourkey>

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
