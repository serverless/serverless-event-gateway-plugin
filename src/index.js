'use strict';

// Try to remove this. Such a large package
const _ = require('lodash');
const fdk = require('@serverless/fdk');
const eventGateway = fdk.eventGateway({
  url: 'http://localhost',
})



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
      if (!(data instanceof Object && data.hasOwnProperty('Stacks') && data['Stacks'] instanceof Array)) {
        throw new Error('Unable to fetch Stack information')
      }

      const stack = data['Stacks'].pop() || { Outputs: [] }
      const outputs = stack.Outputs || []

      const parsedOutputs = outputs.reduce((agg, current) => {
        if (current.hasOwnProperty('OutputKey') && current.hasOwnProperty('OutputValue')) {
          agg[current['OutputKey']] = current['OutputValue']
        }
        return agg
      }, {})

      if (!(parsedOutputs.hasOwnProperty('EventGatewayUserAccessKey') && parsedOutputs.hasOwnProperty('EventGatewayUserSecretKey'))) {
        throw new Error('Access Key or Secret Key not found in outputs')
      }

      this.serverless.cli.log('EventGatewayUserAccessKey: ' + parsedOutputs['EventGatewayUserAccessKey'])
      this.serverless.cli.log('EventGatewayUserSecretKey: ' + parsedOutputs['EventGatewayUserSecretKey'])

      Object.keys(parsedOutputs).forEach(key => {
        if (key.endsWith('LambdaFunctionQualifiedArn')) {
          this.serverless.cli.log(key + ": " + parsedOutputs[key])

          eventGateway.registerFunction({
            functionId: key.substring(0, key.indexOf('LambdaFunctionQualifiedArn')),
            provider: {
              type: 'awslambda',
              arn: parsedOutputs[key],
              region: this.awsProvider.getRegion(),
              awsAccessKeyId: parsedOutputs['EventGatewayUserAccessKey'],
              awsSecretAccessKey: parsedOutputs['EventGatewayUserSecretKey'],
            }
          })
        }
      })
    })
  }
}

module.exports = EGPlugin;
