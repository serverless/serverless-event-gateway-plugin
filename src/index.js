"use strict";

const merge = require("lodash.merge");
const fdk = require("@serverless/fdk");
const crypto = require("crypto");
const chalk = require("chalk");
const fs = require("fs");
const path = require("path");

class EGPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    this.awsProvider = this.serverless.getProvider("aws");

    this.hooks = {
      "package:compileEvents": this.addUserDefinition.bind(this),
      "after:deploy:finalize": this.configureEventGateway.bind(this),
      "emitremote:emit": this.emitEvent.bind(this)
    };

    this.commands = {
      emitremote: {
        usage: "Emit event to hosted Event Gateway",
        lifecycleEvents: ["emit"],
        options: {
          event: {
            usage: "Event you want to emit",
            required: true,
            shortcut: "e"
          },
          data: {
            usage: "Data for the event you want to emit",
            required: true,
            shortcut: "d"
          }
        }
      }
    };
  }

  emitEvent() {
    const eg = this.getClient();

    eg.emit({
      event: this.options.event,
      data: JSON.parse(this.options.data)
    });
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

  getClient() {
    const config = this.getConfig();
    process.env.EVENT_GATEWAY_TOKEN = config.apikey || process.env.EVENT_GATEWAY_TOKEN;
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

    return fdk.eventGateway({
      url: config.eventsAPI,
      configurationUrl: config.configurationAPI
    });
  }

  configureEventGateway() {
    const config = this.getConfig();
    const eg = this.getClient();

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

        const stateDataFilePath = path.join(process.cwd(), '.egstate.json');
        let stateData = { functions: [], subscriptions: [] };
        if (fs.existsSync(stateDataFilePath)) {
          stateData = JSON.parse(fs.readFileSync(stateDataFilePath))
        }

        Promise.all(
          stateData.subscriptions.map(sub => {
            stateData.subscriptions.pop();
            return eg.unsubscribe({ subscriptionId: sub })
          })
        ).then(() => Promise.all(
          stateData.functions.map(func => {
            stateData.functions.pop();
            return eg.deleteFunction({ functionId: func })
          })
        )).then(() => Promise.all(
          this.filterFunctionsWithEvents().map(name => {
            const outputKey = this.awsProvider.naming.getLambdaVersionOutputLogicalId(
              name
            );
            const arn = outputs[outputKey];
            const functionId = crypto
              .createHash("sha256", "utf8")
              .update(arn)
              .digest("hex");

            return eg
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
                stateData.functions.push(functionId);

                this.serverless.cli.consoleLog(
                  `EventGateway: Function "${name}" registered.`
                );

                const func = this.serverless.service.getFunction(name);
                return Promise.all(
                  func.events.map(functionEvent => {
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

                    if (event.event === "http") {
                      subscribeEvent.method = event.method || "GET";
                    }

                    return eg.subscribe(subscribeEvent).then(subObj => {
                      stateData.subscriptions.push(subObj['subscriptionId']);

                      this.serverless.cli.consoleLog(
                        `EventGateway: Function "${name}" subscribed to "${
                          event.event
                          }" event.`
                      );

                      fs.writeFile(stateDataFilePath, JSON.stringify(stateData), (err) => {
                        if (err) throw new Error(err);
                      });
                    });
                  })
                ).then(() => {
                  this.serverless.cli.consoleLog("");
                  this.serverless.cli.consoleLog(
                    `EventGateway: Endpoint URL: ${config.eventsAPI}`
                  );
                });
              });
          })
        ));
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
