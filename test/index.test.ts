import waitForExpect from 'wait-for-expect';
import { LockNotFound, sleep } from '../src/index';
import { getDynamoItems, initContext, TEST_DYNAMO_TABLE_NAME } from './context';

describe('DynamoDB Lock Client', () => {
  it('handles cycle', async () => {
    const context = initContext();
    const lockId = 'lock-id';
    const expiresAt = new Date().getTime() + 30000;
    const updatedExpiresAt = expiresAt + 30000;

    // Expect getNextTicketNumber to increment ticket number in Dynamo
    const ticketNumber = await context.dynamoLockClient.getNextTicketNumber(
      lockId,
    );

    const res1 = await context.dynamo
      .getItem({
        TableName: TEST_DYNAMO_TABLE_NAME,
        Key: {
          PartitionKey: { S: `lock-client:lock:${lockId}:ticket-number` },
          SortKey: { S: 'current' },
        },
      })
      .promise();

    expect(res1).not.toBeNull();
    expect(res1?.Item?.ticketNumber?.N).toEqual('1');

    // Expect enterWaitingQueue to create an entry in Dynamo
    await context.dynamoLockClient.enterWaitingQueue({
      lockId,
      ticketNumber,
      expiresAt: expiresAt,
    });
    const res2 = await context.dynamo
      .getItem({
        TableName: TEST_DYNAMO_TABLE_NAME,
        Key: {
          PartitionKey: { S: `lock-client:lock:${lockId}` },
          SortKey: { S: ticketNumber },
        },
      })
      .promise();
    expect(res2).not.toBeNull();
    expect(res2?.Item?.expiresAt?.N).toBe(expiresAt.toString());

    // Expect isFirstInQueue to return True
    // isFirstInQueue is eventually consistent, so we can't check this synchronously
    await waitForExpect(() =>
      expect(
        context.dynamoLockClient.isFirstInQueue({ lockId, ticketNumber }),
      ).resolves.toBe(true),
    );

    // Expect sendHeartbeat to update lock ticket expiration in Dynamo
    await context.dynamoLockClient.sendHeartbeat({
      lockId,
      ticketNumber,
      expiresAt: updatedExpiresAt,
    });
    const res3 = await context.dynamo
      .getItem({
        TableName: TEST_DYNAMO_TABLE_NAME,
        Key: {
          PartitionKey: { S: `lock-client:lock:${lockId}` },
          SortKey: { S: ticketNumber },
        },
      })
      .promise();
    expect(res3).not.toBeNull();
    expect(res3?.Item?.expiresAt?.N).toBe(updatedExpiresAt.toString());

    // Expect leaveWaitingQueue to clear entry from Dynamo
    const res4 = await context.dynamo
      .getItem({
        TableName: TEST_DYNAMO_TABLE_NAME,
        Key: {
          PartitionKey: { S: `lock-client:lock:${lockId}` },
          SortKey: { S: ticketNumber },
        },
      })
      .promise();
    expect(res4).not.toStrictEqual({});
    await context.dynamoLockClient.leaveWaitingQueue({ lockId, ticketNumber });
    const res5 = await context.dynamo
      .getItem({
        TableName: TEST_DYNAMO_TABLE_NAME,
        Key: {
          PartitionKey: { S: `lock-client:lock:${lockId}` },
          SortKey: { S: ticketNumber },
        },
      })
      .promise();
    expect(res5).toStrictEqual({});

    await expect(getDynamoItems(context)).resolves.toEqual([
      {
        PartitionKey: { S: `lock-client:lock:${lockId}:ticket-number` },
        SortKey: { S: 'current' },
        ticketNumber: { N: '1' },
      },
    ]);
  });

  it('ensure lock is held by owner until released', async () => {
    const context = initContext();
    const lockId = 'lock-id';
    const expiresAt = new Date().getTime() + 10000;

    const ticketNumber1 = await context.dynamoLockClient.getNextTicketNumber(
      lockId,
    );
    await context.dynamoLockClient.enterWaitingQueue({
      lockId,
      ticketNumber: ticketNumber1,
      expiresAt: expiresAt,
    });

    const ticketNumber2 = await context.dynamoLockClient.getNextTicketNumber(
      lockId,
    );
    await context.dynamoLockClient.enterWaitingQueue({
      lockId,
      ticketNumber: ticketNumber2,
      expiresAt: expiresAt,
    });

    expect(ticketNumber1).not.toBe(ticketNumber2);

    // isFirstInQueue is eventually consistent, so we can't check this synchronously
    await waitForExpect(() =>
      expect(
        context.dynamoLockClient.isFirstInQueue({
          lockId,
          ticketNumber: ticketNumber1,
        }),
      ).resolves.toBe(true),
    );
    await waitForExpect(() =>
      expect(
        context.dynamoLockClient.isFirstInQueue({
          lockId,
          ticketNumber: ticketNumber2,
        }),
      ).resolves.toBe(false),
    );
    await context.dynamoLockClient.leaveWaitingQueue({
      lockId,
      ticketNumber: ticketNumber1,
    });

    // isFirstInQueue is eventually consistent, so we can't check this synchronously
    await waitForExpect(() =>
      expect(
        context.dynamoLockClient.isFirstInQueue({
          lockId,
          ticketNumber: ticketNumber1,
        }),
      ).resolves.toBe(false),
    );
    await waitForExpect(() =>
      expect(
        context.dynamoLockClient.isFirstInQueue({
          lockId,
          ticketNumber: ticketNumber2,
        }),
      ).resolves.toBe(true),
    );

    await context.dynamoLockClient.leaveWaitingQueue({
      lockId,
      ticketNumber: ticketNumber2,
    });

    // isFirstInQueue is eventually consistent, so we can't check this synchronously
    await waitForExpect(() =>
      expect(
        context.dynamoLockClient.isFirstInQueue({
          lockId,
          ticketNumber: ticketNumber2,
        }),
      ).resolves.toBe(false),
    );
  });
});

describe('executeWithLock', () => {
  it('returns async fn value', async () => {
    const context = initContext();

    const resPromise = context.dynamoLockClient.executeWithLock(
      {
        lockId: 'lock-id',
        leaseDurationMs: 10000,
      },
      async () => {
        await sleep(100);
        return 'Hello!';
      },
    );

    await expect(resPromise).resolves.toBe('Hello!');
  });

  it('returns sync fn value', async () => {
    const context = initContext();

    const resPromise = context.dynamoLockClient.executeWithLock(
      {
        lockId: 'lock-id',
        leaseDurationMs: 10000,
      },
      () => 'Hello!',
    );
    await expect(resPromise).resolves.toBe('Hello!');
  });

  it('handles heartbeats', async () => {
    const context = initContext();
    const sendHeartbeatSpy = jest.spyOn(
      context.dynamoLockClient,
      'sendHeartbeat',
    );

    const resPromise = context.dynamoLockClient.executeWithLock(
      {
        lockId: 'lock-id',
        leaseDurationMs: 2000,
        heartbeatIntervalMs: 500,
      },
      async () => {
        await sleep(1800);
        return 'Hello!';
      },
    );

    await expect(resPromise).resolves.toBe('Hello!');
    expect(sendHeartbeatSpy).toHaveBeenCalledTimes(3);
  });

  it('raises exception when when waiting queue timeout is reached', async () => {
    const context = initContext();
    const lockId = 'lock-id';

    const ticketNumber1 = await context.dynamoLockClient.getNextTicketNumber(
      lockId,
    );
    await context.dynamoLockClient.enterWaitingQueue({
      lockId,
      ticketNumber: ticketNumber1,
      expiresAt: new Date().getTime() + 10000,
    });

    const resPromise = context.dynamoLockClient.executeWithLock(
      {
        lockId,
        leaseDurationMs: 1000,
      },
      () => {
        return 'Hello!';
      },
    );

    await expect(resPromise).rejects.toEqual(
      new Error('Unable to acquire lock within timeout period'),
    );
  });

  it('raises exception when lock does not exist on heartbeat', async () => {
    const context = initContext();
    const lockId = 'lock-id';

    await expect(
      context.dynamoLockClient.sendHeartbeat({
        lockId: lockId,
        ticketNumber: '1',
        expiresAt: new Date().getTime() + 10000,
      }),
    ).rejects.toEqual(
      new LockNotFound('Failed to renew lock. Lock does not exist.'),
    );
  });

  it('isFirstInQueue cleans up expired queue positions', async () => {
    const context = initContext();
    const lockId = 'lock-id';
    const now = new Date().getTime();

    const getLockQueueItems = async () =>
      (await getDynamoItems(context)).filter(
        (it) => it.PartitionKey.S == `lock-client:lock:${lockId}`,
      );

    const ticket1 = await context.dynamoLockClient.getNextTicketNumber(lockId);
    const ticket2 = await context.dynamoLockClient.getNextTicketNumber(lockId);
    const ticket3 = await context.dynamoLockClient.getNextTicketNumber(lockId);

    await context.dynamoLockClient.enterWaitingQueue({
      lockId: lockId,
      ticketNumber: ticket1,
      expiresAt: now - 20000,
    });

    await context.dynamoLockClient.enterWaitingQueue({
      lockId: lockId,
      ticketNumber: ticket2,
      expiresAt: now - 10000,
    });

    await context.dynamoLockClient.enterWaitingQueue({
      lockId: lockId,
      ticketNumber: ticket3,
      expiresAt: now + 30000,
    });

    // Expect three queue entries initially
    await expect(getLockQueueItems()).resolves.toHaveLength(3);

    // isFirstInQueue is eventually consistent, so we can't check this synchronously
    await waitForExpect(() =>
      expect(
        context.dynamoLockClient.isFirstInQueue({
          lockId: lockId,
          ticketNumber: ticket3,
          cleanupExpiredQueuePositions: true,
        }),
      ).resolves.toBe(true),
    );

    // Ensure that only one queue entry exists after we're first in queue, as others should have been cleaned up
    await expect(getLockQueueItems()).resolves.toHaveLength(1);
  });
});
