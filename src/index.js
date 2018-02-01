'use strict';

// Try to remove this. Such a large package
const _ = require('lodash');
const fdk = require('@serverless/fdk');
const crypto = require('crypto');

class EGPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    this.awsProvider = this.serverless.getProvider('aws');
    this.providerNaming = this.awsProvider.naming;

    this.hooks = {
      'package:compileEvents': this.compile.bind(this),
      'after:deploy:deploy': this.afterDeploy.bind(this),
    };
  }

  getConfig() {
    return this.serverless.service.custom && this.serverless.service.custom.eventgateway;
  }

  addUserDefinition() {
    _.merge(this.serverless.service.provider.compiledCloudFormationTemplate.Resources, {
      "EventGatewayUser": {
        "Type": "AWS::IAM::User"
      },
      "EventGatewayUserPolicy": {
        "Type": "AWS::IAM::ManagedPolicy",
        "Properties": {
          "Description": "This policy allows Custom plugin to gather data on IAM users",
          "PolicyDocument": {
            "Version": "2012-10-17",
            "Statement": [
              {
                "Effect": "Allow",
                "Action": [
                  "lambda:InvokeFunction",
                ],
                "Resource": "*"
              }
            ]
          },
          "Users": [
            {
              "Ref": "EventGatewayUser"
            }
          ]
        }
      },
      "EventGatewayUserKeys": {
        "Type": "AWS::IAM::AccessKey",
        "Properties": {
          "UserName": {
            "Ref": "EventGatewayUser"
          }
        }
      }
    })

    _.merge(this.serverless.service.provider.compiledCloudFormationTemplate.Outputs, {
      "EventGatewayUserAccessKey": {
        "Value": {
          "Ref": "EventGatewayUserKeys"
        },
        "Description": "Access Key ID of Custom User"
      },
      "EventGatewayUserSecretKey": {
        "Value": {
          "Fn::GetAtt": [
            "EventGatewayUserKeys",
            "SecretAccessKey"
          ]
        },
        "Description": "Secret Key of Custom User"
      }
    })
  }

  compile() {
    const config = this.getConfig();
    if (!config) {
      throw new Error('No EventGateway configuration provided in serverless.yaml')
    }
    if (!config['subdomain'] || !config['subdomain'].length) {
      throw new Error('Required "subdomain" property is missing from EventGateway configuration provided in serverless.yaml')
    }
    this.config = config

    this.eventGatewayURL = `https://${this.config['subdomain']}.eventgateway-dev.io`
    this.eventGateway = fdk.eventGateway({
      url: this.eventGatewayURL,
      configurationUrl: 'https://config.eventgateway-dev.io/',
    })

    this.addUserDefinition()
  }

  afterDeploy() {
    return this.awsProvider.request(
      'CloudFormation',
      'describeStacks',
      { StackName: this.awsProvider.naming.getStackName() },
      this.awsProvider.getStage(),
      this.awsProvider.getRegion()
    ).then(data => {
      if (!(data instanceof Object && data['Stacks'] && data['Stacks'] instanceof Array)) {
        throw new Error('Unable to fetch Stack information')
      }

      const stack = data['Stacks'].pop() || { Outputs: [] }
      const outputs = stack.Outputs || []

      const parsedOutputs = outputs.reduce((agg, current) => {
        if (current['OutputKey'] && current['OutputValue']) {
          agg[current['OutputKey']] = current['OutputValue']
        }
        return agg
      }, {})

      if (!(parsedOutputs['EventGatewayUserAccessKey'] && parsedOutputs['EventGatewayUserSecretKey'])) {
        throw new Error('Access Key or Secret Key not found in outputs')
      }

      this.serverless.cli.log('EventGatewayUserAccessKey: ' + parsedOutputs['EventGatewayUserAccessKey'])
      this.serverless.cli.log('EventGatewayUserSecretKey: ' + parsedOutputs['EventGatewayUserSecretKey'])

      const functionsWithEvents = this.serverless.service.getAllFunctions().reduce((agg, functionName) => {
        const functionObj = this.serverless.service.getFunction(functionName)

        if (!(functionObj instanceof Object && functionObj['events'] instanceof Array && functionObj['events'].length)) {
          return
        }
        agg.push(functionName.toLowerCase())

        return agg
      }, [])

      Object.keys(parsedOutputs).forEach(key => {
        const outputFunctionName = key.substring(0, key.indexOf('LambdaFunctionQualifiedArn')).toLowerCase()
        const actualFunctionName = functionsWithEvents.find(thisfunc => thisfunc.toLowerCase() === outputFunctionName)
        if (key.endsWith('LambdaFunctionQualifiedArn') && actualFunctionName) {
          this.serverless.cli.log(key + ": " + parsedOutputs[key])
          const functionId = crypto.createHash('sha256','utf8').update(parsedOutputs[key]).digest('hex')

          this.eventGateway.registerFunction({
            functionId: functionId,
            provider: {
              type: 'awslambda',
              arn: parsedOutputs[key],
              region: this.awsProvider.getRegion(),
              awsAccessKeyId: parsedOutputs['EventGatewayUserAccessKey'],
              awsSecretAccessKey: parsedOutputs['EventGatewayUserSecretKey'],
            }
          })

          const functionObj = this.serverless.service.getFunction(actualFunctionName)
          functionObj['events'].forEach(eventObj => {
            if (!eventObj['eventgateway']) return

            const event = eventObj['eventgateway']
            if (!(
              event instanceof Object &&
              event['event'] &&
              event['path']
            )) {
              return
            }

            const eventPath = (event['path'].startsWith('/') ? '' : '/') + event['path']
            const eventId = event['event']
            const subscribeEvent = {
              // Validation of nested objects is above when iterating over all the functions
              event: eventId,
              functionId: functionId,
              method: event['method'].toUpperCase(),
              path: `/${this.config['subdomain']}${eventPath}`,
            }
            if (event['event'] === 'http') {
              subscribeEvent['method'] = (event['method'] && event['method'].toUpperCase()) || 'GET'
            }
            this.eventGateway.subscribe(subscribeEvent)

            this.serverless.cli.log(`${this.eventGatewayURL}${eventPath}`)
          })
        }
      })
    })
  }
}

module.exports = EGPlugin;
