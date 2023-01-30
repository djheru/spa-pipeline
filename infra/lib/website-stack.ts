import { CfnOutput, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { DnsValidatedCertificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
  AllowedMethods,
  CacheCookieBehavior,
  CacheHeaderBehavior,
  CachePolicy,
  CacheQueryStringBehavior,
  Distribution,
  LambdaEdgeEventType,
  OriginAccessIdentity,
  OriginRequestPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { ARecord, HostedZone, IHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { blueGreenHeaderContextKey } from '../src/handlers/viewer-request';
import {
  Environment,
  WebsitePipeline,
  WebsitePipelineBaseProps,
} from './website-pipeline';

export interface WebsiteStackProps extends StackProps {
  domainName: string;
  environmentName: Environment;
  serviceName: string;
  pipelineProps: WebsitePipelineBaseProps;
}

export class WebsiteStack extends Stack {
  public hostedZone: IHostedZone;
  public certificate: DnsValidatedCertificate;
  public aRecord: ARecord;
  public hostedZoneDomainName: string;
  public fullDomainName: string;
  public blueBucket: Bucket;
  public greenBucket: Bucket;
  public oai: OriginAccessIdentity;
  public blueOrigin: S3Origin;
  public greenOrigin: S3Origin;
  public edgeViewerRequestFunction: NodejsFunction;
  public edgeOriginRequestFunction: NodejsFunction;
  public edgeOriginResponseFunction: NodejsFunction;
  public edgeViewerResponseFunction: NodejsFunction;
  public distribution: Distribution;
  public pipeline: WebsitePipeline;

  constructor(
    scope: Construct,
    private readonly id: string,
    private readonly props: WebsiteStackProps
  ) {
    super(scope, id, props);

    /**
     * "Base" domain name from hosted zone. For prod, it's just the domain from the .env file
     * For other envs, it's e.g. `dev.example.com`
     * It is the name we'll use to look up the hosted zone
     */
    this.hostedZoneDomainName =
      this.props.environmentName === 'prod'
        ? this.props.domainName
        : `${this.props.environmentName}.${this.props.domainName}`;

    /**
     * The domain name where the site will be served. We use this to create
     * the A Record and certificate
     */
    this.fullDomainName = `${this.props.serviceName}.${this.hostedZoneDomainName}`;

    this.buildResources();
  }

  buildResources() {
    this.importHostedZone();
    this.buildCertificate();
    this.buildDeployBuckets();
    this.buildOAI();
    this.buildS3Origins();
    this.buildEdgeLambdas();
    this.buildDistribution();
    this.buildARecord();
    this.buildPipeline();
  }

  /**
   * Look up the existing Route53 hosted zone to use for
   */
  importHostedZone() {
    const zoneId = `${this.id}-hosted-zone`;
    this.hostedZone = HostedZone.fromLookup(this, zoneId, {
      domainName: this.hostedZoneDomainName,
    });
  }

  /**
   * Build a DNS validated certificate with the full domain name
   */
  buildCertificate() {
    const certId = `${this.id}-certificate`;
    this.certificate = new DnsValidatedCertificate(this, certId, {
      domainName: this.fullDomainName,
      hostedZone: this.hostedZone,
    });
  }

  /**
   * Two S3 buckets for Blue/Green deployments
   * NOTE: The removal policy is DESTROY, so they will not persist if you
   * remove the CloudFormation stack
   */
  buildDeployBuckets() {
    const bucketBaseId = `${this.id}-bucket`;
    const blueBucketId = `${bucketBaseId}-blue`;
    const greenBucketId = `${bucketBaseId}-green`;

    this.blueBucket = new Bucket(this, blueBucketId, {
      versioned: false,
      bucketName: `${blueBucketId}-${this.region}-${this.account}`,
      publicReadAccess: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.greenBucket = new Bucket(this, greenBucketId, {
      versioned: false,
      bucketName: `${greenBucketId}-${this.region}-${this.account}`,
      publicReadAccess: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }

  /**
   * Builds the Origin Access Identity, which is a special CloudFront user you
   * can associate with S3 origins and restrict access
   */
  buildOAI() {
    const oaiId = `${this.id}-oai`;
    this.oai = new OriginAccessIdentity(this, `${oaiId}-blue`, {
      comment: `Origin Access Identity for ${this.id} (Blue)`,
    });

    this.blueBucket.grantRead(this.oai);
    this.greenBucket.grantRead(this.oai);
  }

  /**
   * Sets up an Origin resource that the CloudFront Distribution connects to
   */
  buildS3Origins() {
    this.blueOrigin = new S3Origin(this.blueBucket, {
      originAccessIdentity: this.oai,
    });
    this.greenOrigin = new S3Origin(this.greenBucket, {
      originAccessIdentity: this.oai,
    });
  }

  /**
   * Edge lambdas intercept requests going to S3 and responses coming back
   * We use them to handle headers and route between the Green/Blue buckets
   */
  buildEdgeLambdas() {
    const lambdaId = `${this.id}-blue-green-edge`;
    this.edgeViewerRequestFunction = new NodejsFunction(
      this,
      `${lambdaId}-viewer-request`,
      {
        entry: './src/handlers/viewer-request.ts',
      }
    );
    this.edgeOriginRequestFunction = new NodejsFunction(
      this,
      `${lambdaId}-origin-request`,
      {
        entry: './src/handlers/origin-request.ts',
      }
    );
    this.edgeOriginResponseFunction = new NodejsFunction(
      this,
      `${lambdaId}-origin-response`,
      {
        entry: './src/handlers/origin-response.ts',
      }
    );
    this.edgeViewerResponseFunction = new NodejsFunction(
      this,
      `${lambdaId}-viewer-response`,
      {
        entry: './src/handlers/viewer-response.ts',
      }
    );
  }

  /**
   * Configures and builds a CloudFront distribution
   * Configured to add the `x-blue-green-context` header to the cache
   */
  buildDistribution() {
    const distributionId = `${this.id}-distribution`;
    const cachePolicy = new CachePolicy(this, `${distributionId}-cache-policy`, {
      comment: `Cache Policy for ${distributionId}`,
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
      cookieBehavior: CacheCookieBehavior.allowList(blueGreenHeaderContextKey),
      headerBehavior: CacheHeaderBehavior.allowList(blueGreenHeaderContextKey),
      queryStringBehavior: CacheQueryStringBehavior.all(),
    });
    const originRequestPolicy = OriginRequestPolicy.CORS_S3_ORIGIN;
    this.distribution = new Distribution(this, distributionId, {
      defaultBehavior: {
        origin: this.blueOrigin,
        cachePolicy,
        originRequestPolicy,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        edgeLambdas: [
          {
            eventType: LambdaEdgeEventType.VIEWER_REQUEST,
            functionVersion: this.edgeViewerRequestFunction.currentVersion,
          },
          {
            eventType: LambdaEdgeEventType.ORIGIN_REQUEST,
            functionVersion: this.edgeOriginRequestFunction.currentVersion,
          },
          {
            eventType: LambdaEdgeEventType.ORIGIN_RESPONSE,
            functionVersion: this.edgeOriginResponseFunction.currentVersion,
          },
          {
            eventType: LambdaEdgeEventType.VIEWER_RESPONSE,
            functionVersion: this.edgeViewerResponseFunction.currentVersion,
          },
        ],
      },
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
      defaultRootObject: 'index.html',
      domainNames: [this.fullDomainName],
      certificate: this.certificate,
      enableLogging: true,
    });
  }

  /**
   * Builds an A Record for the domain name that points to the CloudFront Distribution
   */
  buildARecord() {
    const aRecordId = `${this.id}-a-record`;
    this.aRecord = new ARecord(this, aRecordId, {
      zone: this.hostedZone,
      recordName: this.fullDomainName,
      target: RecordTarget.fromAlias(new CloudFrontTarget(this.distribution)),
    });

    const aRecordOutputId = `${aRecordId}-domain-name`;
    new CfnOutput(this, aRecordOutputId, {
      value: this.aRecord.domainName,
      exportName: aRecordOutputId,
    });
  }

  /**
   * Build CI/CD pipeline to listen for changes in GitHub and automatically deploy
   */
  buildPipeline() {
    const pipelineId = `${this.id}-cicd`;
    this.pipeline = new WebsitePipeline(this, pipelineId, {
      blueBucket: this.blueBucket,
      greenBucket: this.greenBucket,
      distributionId: this.distribution.distributionId,
      fullDomainName: this.fullDomainName,
      ...this.props.pipelineProps,
    });
  }
}
