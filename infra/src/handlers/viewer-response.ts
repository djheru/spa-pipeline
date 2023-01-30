import {
  Callback,
  CloudFrontResponseEvent,
  CloudFrontResponseHandler,
  CloudFrontResponseResult,
  Context,
} from 'aws-lambda';

export const handler: CloudFrontResponseHandler = (
  event: CloudFrontResponseEvent,
  context: Context,
  callback: Callback<CloudFrontResponseResult>
) => {
  console.log('event: %j', event);
  const response = event.Records[0].cf.response;
  callback(null, response);
};
