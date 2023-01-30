import { CfnOutput, Stack } from 'aws-cdk-lib';
import { LoggingLevel, SlackChannelConfiguration } from 'aws-cdk-lib/aws-chatbot';
import { PipelineProject } from 'aws-cdk-lib/aws-codebuild';
import { Artifact, Pipeline } from 'aws-cdk-lib/aws-codepipeline';
import {
  CodeBuildAction,
  ManualApprovalAction,
  S3DeployAction,
} from 'aws-cdk-lib/aws-codepipeline-actions';
import { NotificationRule } from 'aws-cdk-lib/aws-codestarnotifications';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import {
  getCodeBuildProject,
  getInvalidationProject,
  getSourceAction,
} from './pipeline-actions';

export type Environment = 'dev' | 'prod' | 'test' | string;

export interface WebsitePipelineBaseProps {
  // Authenticates with GitHub to receive notifications of git activity
  codestarConnectionArn: string;
  // E.g. dev, prod, etc
  environmentName: Environment;
  // When this branch is updated, its code will be deployed
  githubBranchName: string;
  // GitHub user name
  githubOwner: string;
  // GitHub repository
  githubRepo: string;
  // Slack workspace for notifications
  slackWorkspaceId?: string;
  // Slack channel
  slackChannelId?: string;
}

export interface WebsitePipelineProps extends WebsitePipelineBaseProps {
  // The bucket containing the blue (live) files
  blueBucket: Bucket;
  // The bucket containing the green (new) files
  greenBucket: Bucket;
  // CloudFront distribution serving these files
  distributionId: string;
  // Full domain name
  fullDomainName: string;
}

export class WebsitePipeline extends Construct {
  public pipeline: Pipeline;
  public sourceOutput = new Artifact('SourceArtifact');
  public buildOutput = new Artifact('BuildArtifact');
  public distributionArn: string;
  public slackNotificationRule: NotificationRule;
  public notificationTopic: Topic;
  public slackChannelConfiguration: SlackChannelConfiguration;

  constructor(
    scope: Construct,
    private readonly id: string,
    private readonly props: WebsitePipelineProps
  ) {
    super(scope, id);
    // Build the ARN so we can use it to invalidate the cache in a build step
    this.distributionArn = `arn:aws:cloudfront::${Stack.of(this).account}:distribution/${
      this.props.distributionId
    }`;

    this.buildResources();
  }

  buildResources() {
    this.buildPipeline();
    this.buildSourceStage();
    this.buildBuildStage();
    this.buildGreenStage();
    this.buildBlueStage();
    if (this.props.slackChannelId && this.props.slackWorkspaceId) {
      this.buildNotificationTopic();
      this.buildSlackChannelConfiguration();
      this.buildSlackNotifications();
    }
  }

  /**
   * CodePipeline resource to orchestrate the build
   */
  buildPipeline() {
    const pipelineId = `${this.id}-pipeline`;
    this.pipeline = new Pipeline(this, pipelineId, {
      pipelineName: pipelineId,
      crossAccountKeys: false,
    });
  }

  /**
   * CodeStar resource that downloads the latest code from the configured branch and
   * packages it up in an Artifact
   */
  buildSourceStage() {
    const sourceAction = getSourceAction(this.props, this.sourceOutput);

    this.pipeline.addStage({
      stageName: 'GitHubSourceStage',
      actions: [sourceAction],
    });
  }

  /**
   * CodeBuild project to build the source code and generate the deployable artifacts.
   * E.g. transpiled and bundled React production build
   */
  buildBuildStage() {
    const buildAction = new CodeBuildAction({
      actionName: 'BuildAction',
      input: this.sourceOutput,
      project: new PipelineProject(
        this,
        `${this.id}-build-project`,
        getCodeBuildProject(this.id)
      ),
      outputs: [this.buildOutput],
    });

    this.pipeline.addStage({
      stageName: 'BuildSPAStage',
      actions: [buildAction],
    });
  }

  /**
   * Deploy to the green bucket and invalidate the cache, then wait for manual approval
   */
  buildGreenStage() {
    const { githubOwner, githubRepo, githubBranchName } = this.props;

    const deployAction = new S3DeployAction({
      actionName: 'DeployGreenAction',
      bucket: this.props.greenBucket,
      input: this.buildOutput,
      runOrder: 1,
    });

    const invalidateProject = new PipelineProject(
      this,
      `${this.id}-invalidate-green-project-id`,
      getInvalidationProject(
        `${this.id}-invalidate-green-project`,
        '/*',
        this.props.distributionId
      )
    );

    invalidateProject.addToRolePolicy(
      new PolicyStatement({
        resources: [this.distributionArn],
        actions: ['cloudfront:CreateInvalidation'],
      })
    );

    const invalidateAction = new CodeBuildAction({
      actionName: 'InvalidateGreenCacheAction',
      input: this.sourceOutput,
      project: invalidateProject,
      runOrder: 2,
    });

    const approvalAction = new ManualApprovalAction({
      actionName: 'ApproveGreenAction',
      additionalInformation: `
Approve the Deployment to S3 for the GREEN deployment group? 
      
Add request header "x-blue-green-context" with value of "green", or a query string of "?blue_green=green" to test the new deployment.
PR Review URL: https://github.com/${githubOwner}/${githubRepo}/tree/${githubBranchName}
`,
      externalEntityLink: `https://${this.props.fullDomainName}`,
      runOrder: 3,
    });

    this.pipeline.addStage({
      stageName: 'DeployGreenStage',
      actions: [deployAction, invalidateAction, approvalAction],
    });
  }

  /**
   * After receiving manual approval, then deploy to the blue bucket and invalidate the cache
   */
  buildBlueStage() {
    const deployAction = new S3DeployAction({
      actionName: 'DeployBlueAction',
      bucket: this.props.blueBucket,
      input: this.buildOutput,
      runOrder: 2,
    });

    const invalidateProject = new PipelineProject(
      this,
      `${this.id}-invalidate-blue-project-id`,
      getInvalidationProject(
        `${this.id}-invalidate-blue-project`,
        '/*',
        this.props.distributionId
      )
    );

    invalidateProject.addToRolePolicy(
      new PolicyStatement({
        resources: [this.distributionArn],
        actions: ['cloudfront:CreateInvalidation'],
      })
    );

    const invalidateAction = new CodeBuildAction({
      actionName: 'InvalidateBlueCacheAction',
      input: this.sourceOutput,
      project: invalidateProject,
      runOrder: 3,
    });

    this.pipeline.addStage({
      stageName: 'DeployBlueStage',
      actions: [deployAction, invalidateAction],
    });
  }

  /**
   * Build an SNS topic to subscribe to pipeline notifications
   */
  buildNotificationTopic() {
    const notificationTopicId = `${this.id}-notification-topic`;
    this.notificationTopic = new Topic(this, notificationTopicId, {
      displayName: notificationTopicId,
      fifo: false,
      topicName: notificationTopicId,
    });

    const notificationTopicOutputId = `${notificationTopicId}-arn`;
    new CfnOutput(this, notificationTopicOutputId, {
      value: this.notificationTopic.topicArn,
      exportName: notificationTopicOutputId,
    });
  }

  /**
   * Set up a Slack channel notification configuration
   */
  buildSlackChannelConfiguration() {
    const { slackWorkspaceId = '', slackChannelId = '' } = this.props;
    const slackChannelConfigurationName = `${this.id}-slack-channel-config`;
    this.slackChannelConfiguration = new SlackChannelConfiguration(
      this,
      slackChannelConfigurationName,
      {
        slackChannelConfigurationName,
        slackWorkspaceId,
        slackChannelId,
        logRetention: RetentionDays.ONE_MONTH,
        loggingLevel: LoggingLevel.INFO,
        notificationTopics: [this.notificationTopic],
      }
    );

    const slackChannelConfigurationOutputId = `${slackChannelConfigurationName}-arn`;
    new CfnOutput(this, slackChannelConfigurationOutputId, {
      value: this.slackChannelConfiguration.slackChannelConfigurationArn,
      exportName: slackChannelConfigurationOutputId,
    });
  }

  /**
   * Create a notification rule based on CodePipeline events we're interested in
   */
  buildSlackNotifications() {
    const slackNotificationId = `${this.id}-slack-notification`;
    this.slackNotificationRule = new NotificationRule(this, slackNotificationId, {
      events: [
        'codepipeline-pipeline-manual-approval-needed',
        'codepipeline-pipeline-pipeline-execution-failed',
        'codepipeline-pipeline-pipeline-execution-succeeded',
      ],
      source: this.pipeline,
      targets: [this.slackChannelConfiguration],
    });
  }
}
