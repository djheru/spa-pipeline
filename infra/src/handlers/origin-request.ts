import {
  Callback,
  CloudFrontRequest,
  CloudFrontRequestEvent,
  CloudFrontRequestHandler,
  CloudFrontRequestResult,
  Context,
} from 'aws-lambda';
import { blueGreenHeaderContextKey } from './viewer-request';

/**
 * This function looks for the Blue/Green header and uses it to route the request to
 * one bucket or the other by replacing the "blue" or "green" portion of the S3
 * domain in the `origin` part of the request.
 */
export const handler: CloudFrontRequestHandler = (
  event: CloudFrontRequestEvent,
  context: Context,
  callback: Callback<CloudFrontRequestResult>
) => {
  console.log('event: %j', event);
  const request: CloudFrontRequest = event.Records[0].cf.request;
  const headers = request.headers;

  const s3DomainName = headers.host[0].value;
  const s3Region = s3DomainName.split('.')[2];

  let blueGreenContext: 'blue' | 'green' = 'blue';
  const contextHeader = headers[blueGreenHeaderContextKey];

  if (contextHeader) {
    console.log(`Context found in header: %j`, contextHeader);
    blueGreenContext = contextHeader[0].value === 'blue' ? 'blue' : 'green';
  }
  console.log('Blue/Green Context: %j', blueGreenContext);

  const requestOrigin = request.origin;
  if (requestOrigin && requestOrigin.s3) {
    const requestOriginContext = blueGreenContext === 'blue' ? 'green' : 'blue';
    const newDomainName = s3DomainName.replace(requestOriginContext, blueGreenContext);

    request.headers.host[0].value = newDomainName;
    request.origin = {
      s3: {
        ...requestOrigin.s3,
        region: s3Region,
        domainName: newDomainName,
      },
    };
  }
  console.log('response: %j', request);
  callback(null, request);
};
