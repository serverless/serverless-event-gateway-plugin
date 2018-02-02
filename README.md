# Serverless Plugin EventGateway
Serverless plugin that publishes your functions and events to EventGateway.

## Before you start

1. Get an API key from someone on the Serverless team.

2. Clone this repository and change into the directory:

	```bash
	$ git clone git@github.com:serverless/serverless-event-gateway-plugin.git
	$ cd serverless-event-gateway-plugin
	```

3. In the plugin directory, symlink the plugin to your global node_modules:

	```bash
	$ npm link
	```
	
## Usage

_By this point, you should have an API key and have linked the plugin to your global node\_modules._

1. Create a new Serverless service and change into the directory.

2. Symlink the plugin into your service:

	```bash
	$ npm link serverless-event-gateway-plugin
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
	  - serverless-event-gateway-plugin
	
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
