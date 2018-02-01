"use strict";

const merge = require("lodash.merge");
const fdk = require("@serverless/fdk");
const crypto = require("crypto");
const chalk = require("chalk");

class EGPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    this.awsProvider = this.serverless.getProvider("aws");

    this.hooks = {
      "package:compileEvents": this.addUserDefinition.bind(this),
      "after:deploy:finalize": this.configureEventGateway.bind(this)
    };
  }

  getConfig() {
    if (
      this.serverless.service.custom &&
      this.serverless.service.custom.eventgateway
    ) {
      const config = this.serverless.service.custom.eventgateway;
      config.eventsAPI = `https://${config.subdomain}.eventgateway-dev.io`;
      config.configurationAPI = "https://config.eventgateway-dev.io/";
      return config;
    }

    return null;
  }

  configureEventGateway() {
    const config = this.getConfig();
    if (!config) {
      throw new Error(
        "No Event Gateway configuration provided in serverless.yaml"
      );
    }

    if (!config.subdomain) {
      throw new Error(
        'Required "subdomain" property is missing from Event Gateway configuration provided in serverless.yaml'
      );
    }

    if (!config.apikey) {
      throw new Error(
        'Required "apikey" property is missing from Event Gateway configuration provided in serverless.yaml'
      );
    }

    this.eventGateway = fdk.eventGateway({
      url: config.eventsAPI,
      configurationUrl: config.configurationAPI
    });

    this.serverless.cli.consoleLog("");
    this.serverless.cli.consoleLog(
      chalk.yellow.underline("Event Gateway Plugin")
    );

    return this.awsProvider
      .request(
        "CloudFormation",
        "describeStacks",
        { StackName: this.awsProvider.naming.getStackName() },
        this.awsProvider.getStage(),
        this.awsProvider.getRegion()
      )
      .then(data => {
        const stack = data.Stacks.pop();
        if (!stack) {
          throw new Error("Unable to fetch CloudFormation stack information");
        }

        const outputs = this.parseOutputs(stack);

        if (
          !outputs.EventGatewayUserAccessKey ||
          !outputs.EventGatewayUserSecretKey
        ) {
          throw new Error(
            "Event Gateway Access Key or Secret Key not found in outputs"
          );
        }

        process.env.EVENT_GATEWAY_TOKEN = config.apikey;

        this.filterFunctionsWithEvents().map(name => {
          const outputKey = this.awsProvider.naming.getLambdaVersionOutputLogicalId(
            name
          );
          const arn = outputs[outputKey];
          const functionId = crypto
            .createHash("sha256", "utf8")
            .update(arn)
            .digest("hex");

          this.eventGateway
            .registerFunction({
              functionId: functionId,
              provider: {
                type: "awslambda",
                arn: arn,
                region: this.awsProvider.getRegion(),
                awsAccessKeyId: outputs.EventGatewayUserAccessKey,
                awsSecretAccessKey: outputs.EventGatewayUserSecretKey
              }
            })
            .then(() => {
              this.serverless.cli.consoleLog(
                `EventGateway: Function "${name}" registered.`
              );

              const func = this.serverless.service.getFunction(name);
              func.events.forEach(functionEvent => {
                if (!functionEvent.eventgateway) return;

                const event = functionEvent.eventgateway;
                if (!event.event || !event.path) return;

                const path =
                  (event.path.startsWith("/") ? "" : "/") + event.path;
                const subscribeEvent = {
                  functionId,
                  event: event.event,
                  path: `/${config.subdomain}${path}`
                };

                if (event.event == "http") {
                  subscribeEvent.method = event.method || "GET";
                }

                this.eventGateway.subscribe(subscribeEvent);

                this.serverless.cli.consoleLog(
                  `EventGateway: Function "${name}" subscribed to "${
                    event.event
                  }" event.`
                );
              });

              this.serverless.cli.consoleLog("");
              this.serverless.cli.consoleLog(
                `EventGateway: Endpoint URL: ${config.eventsAPI}`
              );
            });
        });
      });
  }

  filterFunctionsWithEvents() {
    return this.serverless.service
      .getAllFunctions()
      .reduce((agg, functionName) => {
        const func = this.serverless.service.getFunction(functionName);
        if (!func.events) {
          return;
        }
        agg.push(functionName);
        return agg;
      }, []);
  }

  parseOutputs(stack) {
    return stack.Outputs.reduce((agg, current) => {
      if (current.OutputKey && current.OutputValue) {
        agg[current.OutputKey] = current.OutputValue;
      }
      return agg;
    }, {});
  }

  addUserDefinition() {
    merge(
      this.serverless.service.provider.compiledCloudFormationTemplate.Resources,
      {
        EventGatewayUser: {
          Type: "AWS::IAM::User"
        },
        EventGatewayUserPolicy: {
          Type: "AWS::IAM::ManagedPolicy",
          Properties: {
            Description:
              "This policy allows Custom plugin to gather data on IAM users",
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: ["lambda:InvokeFunction"],
                  Resource: "*"
                }
              ]
            },
            Users: [
              {
                Ref: "EventGatewayUser"
              }
            ]
          }
        },
        EventGatewayUserKeys: {
          Type: "AWS::IAM::AccessKey",
          Properties: {
            UserName: {
              Ref: "EventGatewayUser"
            }
          }
        }
      }
    );

    merge(
      this.serverless.service.provider.compiledCloudFormationTemplate.Outputs,
      {
        EventGatewayUserAccessKey: {
          Value: {
            Ref: "EventGatewayUserKeys"
          },
          Description: "Access Key ID of Custom User"
        },
        EventGatewayUserSecretKey: {
          Value: {
            "Fn::GetAtt": ["EventGatewayUserKeys", "SecretAccessKey"]
          },
          Description: "Secret Key of Custom User"
        }
      }
    );
  }
}

module.exports = EGPlugin;
