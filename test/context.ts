import * as DynamoDB from 'aws-sdk/clients/dynamodb';
import { DynamoDbLockClient } from '../src';

export const TEST_DYNAMO_TABLE_NAME = 'test-table';

export function initContext() {
  const dynamo = new DynamoDB({
    endpoint: 'http://localhost:4566',
    region: 'us-east-1',
  });
  const dynamoLockClient = new DynamoDbLockClient(
    dynamo,
    TEST_DYNAMO_TABLE_NAME,
  );

  return {
    dynamo,
    dynamoLockClient,
  };
}

export type TestContext = ReturnType<typeof initContext>;

export async function getDynamoItems(
  context: TestContext,
): Promise<DynamoDB.ItemList> {
  const res = await context.dynamo
    .scan({
      TableName: TEST_DYNAMO_TABLE_NAME,
    })
    .promise();

  return res.Items ?? [];
}
