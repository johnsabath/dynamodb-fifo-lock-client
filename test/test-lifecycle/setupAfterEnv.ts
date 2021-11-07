import { initContext, TEST_DYNAMO_TABLE_NAME } from '../context';

// Up to 15 seconds per test
jest.setTimeout(15000);

beforeEach(async () => {
  const context = initContext();

  await context.dynamo
    .createTable({
      TableName: TEST_DYNAMO_TABLE_NAME,
      KeySchema: [
        { AttributeName: 'PartitionKey', KeyType: 'HASH' },
        { AttributeName: 'SortKey', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PartitionKey', AttributeType: 'S' },
        { AttributeName: 'SortKey', AttributeType: 'S' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    })
    .promise();
});

afterEach(async () => {
  const context = initContext();

  await context.dynamo
    .deleteTable({
      TableName: TEST_DYNAMO_TABLE_NAME,
    })
    .promise();
});
