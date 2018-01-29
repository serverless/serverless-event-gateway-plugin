'use strict';

// Try to remove this. Such a large package
const _ = require('lodash');


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
    return this.serverless.service.custom.alerts;
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
      // TODO warn no config
      return;
    }

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

      this.serverless.cli.log("\n" +
        'EventGatewayUserAccessKey: ' + parsedOutputs['EventGatewayUserAccessKey'] + "\n" +
        'EventGatewayUserSecretKey: ' + parsedOutputs['EventGatewayUserSecretKey']
      )
      Object.keys(parsedOutputs).forEach(key => {
        if (key.endsWith('LambdaFunctionQualifiedArn')) {
          this.serverless.cli.log(key + ": " + parsedOutputs[key])
        }
      })
    })
  }
}

module.exports = EGPlugin;
