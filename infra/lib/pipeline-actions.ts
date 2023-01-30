import {
  BuildSpec,
  LinuxBuildImage,
  PipelineProjectProps,
} from 'aws-cdk-lib/aws-codebuild';
import { Artifact } from 'aws-cdk-lib/aws-codepipeline';
import { CodeStarConnectionsSourceAction } from 'aws-cdk-lib/aws-codepipeline-actions';
import { WebsitePipelineProps } from './website-pipeline';

/**
 * Configures the CodeStar connection to trigger the pipeline when the specified repo/branch
 * are updated
 */
export const getSourceAction = (props: WebsitePipelineProps, sourceOutput: Artifact) =>
  new CodeStarConnectionsSourceAction({
    actionName: 'GitHubSourceAction',
    connectionArn: props.codestarConnectionArn,
    output: sourceOutput,
    owner: props.githubOwner,
    repo: props.githubRepo,
    branch: props.githubBranchName,
  });

/**
 * Runs the shell commands needed to build and bundle the React App
 */
export const getCodeBuildProject = (stackId: string): PipelineProjectProps => ({
  projectName: `${stackId}-build-project`,
  environment: {
    buildImage: LinuxBuildImage.STANDARD_6_0,
    privileged: true,
  },
  buildSpec: BuildSpec.fromObject({
    version: '0.2',
    phases: {
      install: {
        'runtime-versions': {
          nodejs: '16.x',
        },
      },
      pre_build: {
        commands: [
          'echo "Installing NPM Dependencies"',
          'npm ci --legacy-peer-deps',
          'npm test --passWithNoTests',
        ],
      },
      build: {
        commands: ['echo "build started on `date`"', 'npm rum build'],
      },
    },
    artifacts: {
      files: ['**/*'],
      'base-directory': 'build',
    },
  }),
  environmentVariables: {
    CI: { value: 'true' },
  },
});

/**
 * Invalidates the CloudFront cache after deployment so the new files can be picked up
 */
export const getInvalidationProject = (
  projectName: string,
  path: string,
  distributionId: string
): PipelineProjectProps => ({
  projectName,
  buildSpec: BuildSpec.fromObject({
    version: '0.2',
    phases: {
      build: {
        commands: [
          `aws cloudfront create-invalidation --distribution-id \${DIST_ID} --paths "${path}"`,
        ],
      },
    },
  }),
  environmentVariables: {
    DIST_ID: { value: distributionId },
  },
});
