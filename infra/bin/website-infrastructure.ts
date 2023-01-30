#!/usr/bin/env node
import { App, StackProps, Tags } from 'aws-cdk-lib';
import 'dotenv/config';
import 'source-map-support/register';
import { WebsitePipelineBaseProps } from '../lib/website-pipeline';
import { WebsiteStack } from '../lib/website-stack';

const {
  AWS_DEFAULT_ACCOUNT_ID,
  AWS_DEFAULT_REGION,
  CDK_DEFAULT_ACCOUNT,
  CDK_DEFAULT_REGION,
  CDK_ENV: environmentName = '', // Dev is the only supported env ATM
  CODESTAR_ARN: codestarConnectionArn = '',
  DOMAIN_NAME: domainName = '',
  GITHUB_OWNER: githubOwner = '',
  GITHUB_REPO: githubRepo = '',
  SERVICE_NAME: serviceName = '',
  SLACK_WORKSPACE_ID: slackWorkspaceId = '',
  SLACK_CHANNEL_ID: slackChannelId = '',
} = process.env;

const githubBranchName = environmentName === 'prod' ? 'main' : environmentName;

const account = CDK_DEFAULT_ACCOUNT || AWS_DEFAULT_ACCOUNT_ID;
const region = CDK_DEFAULT_REGION || AWS_DEFAULT_REGION;

if (
  ![
    environmentName,
    codestarConnectionArn,
    domainName,
    githubOwner,
    githubRepo,
    serviceName,
    slackWorkspaceId,
    slackChannelId,
  ].every((el) => !!el)
) {
  console.error('env vars: %j', {
    codestarConnectionArn,
    domainName,
    environmentName,
    githubOwner,
    githubRepo,
    serviceName,
    slackWorkspaceId,
    slackChannelId,
  });
  throw new Error('Missing environment variables!');
}

const app = new App();

const stackProps: StackProps = {
  description: `Summary: This stack is responsible for handling the WebsitePipeline stack infrastructure resources.
Deployment: This stack supports deployments to the standard environments. The stack 
can be deployed to a custom environment (e.g. a developer environment) by ensuring 
that the desired environment name (e.g. ${environmentName}) is set in the $CDK_ENV environment 
variable`,
  env: { account, region },
};

const stackId = `${serviceName}-${environmentName}`;

const pipelineProps: WebsitePipelineBaseProps = {
  codestarConnectionArn,
  environmentName,
  githubBranchName,
  githubOwner,
  githubRepo,
  slackWorkspaceId,
  slackChannelId,
};

const websiteStack = new WebsiteStack(app, stackId, {
  ...stackProps,
  domainName,
  environmentName,
  serviceName,
  pipelineProps,
});

// Tag the stacks and all of the nested constructs
Tags.of(websiteStack).add('name', serviceName);
Tags.of(websiteStack).add('environmentName', environmentName);
