import * as DynamoClient from 'aws-sdk/clients/dynamodb';

export type AcquireLockArgs = {
  /**
   * Lock identifier
   */
  lockId: string;

  /**
   * The length of time that the lease for the lock will be
   * granted for. If this is set to, for example, 30 seconds,
   * then the lock will expire if the heartbeat is not sent for
   * at least 30 seconds (which would happen if the box or the
   * heartbeat thread dies, for example.)
   */
  leaseDurationMs: number;

  /**
   * How long to wait for lock acquisition before timing out
   *
   * Default: leaseDurationMs
   */
  acquireTimeoutMs?: number;

  /**
   * If unable to get the lock on the first try, retry every acquireIntervalMs
   * until the acquireTimeoutMs is reached.
   *
   * Default: leaseDurationMs / 2
   */
  acquireRetryIntervalMs?: number;

  /**
   * If the lock is acquired, how often heartbeats should be sent to maintain
   * the lock
   *
   * Default: leaseDurationMs / 4
   */
  heartbeatIntervalMs?: number;
};

// If T is Promise<U>, return U, otherwise T
export type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;

export class DynamoDbLockClient {
  private dynamo: DynamoClient;
  private tableName: string;

  constructor(dynamo: DynamoClient, tableName: string) {
    this.dynamo = dynamo;
    this.tableName = tableName;
  }

  /**
   * Executes a function while also calling the required acquisition, heartbeat, and release, lifcycle calls that are
   * required in order to maintain the lock for the duration of the function execution.
   *
   * @param args
   * @param fn
   */
  async executeWithLock<T extends () => any>(
    args: AcquireLockArgs,
    fn: T,
  ): Promise<UnwrapPromise<ReturnType<T>>> {
    const heartbeatIntervalMs =
      args.heartbeatIntervalMs ?? args.leaseDurationMs / 4;
    const acquireRetryIntervalMs =
      args.acquireRetryIntervalMs ?? args.leaseDurationMs / 2;
    const startEpochMs = new Date().getTime();
    const timeoutEpochMs = startEpochMs + (args.acquireTimeoutMs ?? args.leaseDurationMs);

    const ticketNumber = await this.getNextTicketNumber(args.lockId);

    await this.enterWaitingQueue({
      lockId: args.lockId,
      ticketNumber: ticketNumber,
      expiresAt: new Date().getTime() + args.leaseDurationMs,
    });

    return new Promise(async (resolve, reject) => {
      // Execute lock expiration renewal function every heartbeatPeriodMs milliseconds
      const intervalRef = setInterval(async () => {
        try {
          await this.sendHeartbeat({
            lockId: args.lockId,
            ticketNumber: ticketNumber,
            expiresAt: new Date().getTime() + args.leaseDurationMs,
          });
        } catch (e) {
          reject(e);
        }
      }, heartbeatIntervalMs);

      try {
        // Wait for our ticket to be ready
        while (
          !(await this.isFirstInQueue({
            lockId: args.lockId,
            ticketNumber: ticketNumber,
            deleteExpiredQueuePositions: true,
          }))
        ) {
          // If we've waited longer than our timeout, then raise an error
          const nowEpochMs = new Date().getTime();
          if (nowEpochMs >= timeoutEpochMs) {
            throw new LockAcquisitionTimeout(
              'Unable to acquire lock within timeout period',
            );
          }

          // Otherwise sleep for the polling period
          await sleep(acquireRetryIntervalMs);
        }

        // Execute provided function
        const fnRes = fn();
        if (fnRes instanceof Promise) {
          resolve(await fnRes);
        } else {
          resolve(fnRes);
        }
      } catch (e) {
        reject(e);
      } finally {
        clearInterval(intervalRef);
        await this.leaveWaitingQueue({
          lockId: args.lockId,
          ticketNumber: ticketNumber,
        });
      }
    });
  }

  /**
   * Updates the expiration on a given lock ticket
   *
   * @param args
   */
  async sendHeartbeat(args: {
    lockId: string;
    ticketNumber: string;
    expiresAt: number;
  }): Promise<void> {
    try {
      await this.dynamo
        .updateItem({
          TableName: this.tableName,
          Key: {
            PartitionKey: {
              S: `lock-client:lock:${args.lockId}`,
            },
            SortKey: {
              S: args.ticketNumber,
            },
          },
          ExpressionAttributeValues: {
            ':expiresAt': {
              N: args.expiresAt.toString(),
            },
          },
          ConditionExpression: 'attribute_exists(PartitionKey)',
          UpdateExpression: 'SET expiresAt = :expiresAt',
        })
        .promise();
    } catch (e: any) {
      if (e.code === 'ConditionalCheckFailedException') {
        throw new LockNotFound('Failed to renew lock. Lock does not exist.');
      } else {
        throw e;
      }
    }
  }

  /**
   * Main loop operation when a ticket is waiting for a lock to become available.  This method is eventually
   * consistent, so there may be a delay between the first ticket being deleted and the second ticket becoming "first"
   *
   * Can optionally delete expired items that it comes across while checking queue position.
   *
   * @param args
   * @returns True if ticketNumber is ready to be served for a given lockId, false otherwise
   */
  async isFirstInQueue(args: {
    lockId: string;
    ticketNumber: string;
    deleteExpiredQueuePositions?: boolean;
  }): Promise<boolean> {
    const expiredLocks: Record<string, any>[] = [];
    const now = new Date().getTime();
    let page: Record<string, any>[] = [];
    let resumeAfter: Record<string, any> | undefined;

    do {
      const res = await this.dynamo
        .query({
          TableName: this.tableName,
          ConsistentRead: true,
          ExclusiveStartKey: resumeAfter,
          ExpressionAttributeValues: {
            ':partitionKey': { S: `lock-client:lock:${args.lockId}` },
          },
          KeyConditionExpression: 'PartitionKey = :partitionKey',
          Limit: 100,
          ScanIndexForward: true,
        })
        .promise();

      page = res.Items ?? [];
      resumeAfter = res.LastEvaluatedKey;

      for (const entry of page) {
        if (parseInt(entry.expiresAt.N) < now) {
          // capture expired locks for removal
          expiredLocks.push(entry);
        } else if (entry.SortKey.S === args.ticketNumber) {
          // expired locks can be proactively deleted
          if (args.deleteExpiredQueuePositions ?? false) {
            await Promise.all(
              expiredLocks.map((it) =>
                this.dynamo
                  .deleteItem({
                    TableName: this.tableName,
                    Key: {
                      PartitionKey: { S: it.PartitionKey },
                      SortKey: { S: it.SortKey },
                    },
                  })
                  .promise(),
              ),
            );
          }
          // reached the front of queue
          return true;
        } else {
          // not at front of queue; cannot proceed
          return false;
        }
      }
    } while (resumeAfter);

    return false;
  }

  /**
   * Start waiting for a given lock to become available for a given ticket number
   *
   * @param args
   */
  async enterWaitingQueue(args: {
    lockId: string;
    ticketNumber: string;
    expiresAt: number;
  }) {
    await this.dynamo
      .putItem({
        TableName: this.tableName,
        Item: {
          PartitionKey: { S: `lock-client:lock:${args.lockId}` },
          SortKey: { S: args.ticketNumber },
          createdAt: { N: new Date().getTime().toString() },
          expiresAt: { N: args.expiresAt.toString() },
        },
        ConditionExpression: 'attribute_not_exists(PartitionKey)',
      })
      .promise();
  }

  /**
   * Deletes the waiting queue entry for a given lock and ticket number
   *
   * @param args
   */
  async leaveWaitingQueue(args: { lockId: string; ticketNumber: string }) {
    await this.dynamo
      .deleteItem({
        TableName: this.tableName,
        Key: {
          PartitionKey: { S: `lock-client:lock:${args.lockId}` },
          SortKey: { S: args.ticketNumber },
        },
      })
      .promise();
  }

  /**
   * Returns an atomically incremented number that is used to ensure FIFO
   * when waiting for a lock to become available
   */
  async getNextTicketNumber(lockId: string): Promise<string> {
    try {
      // Ticket numbers can be higher than the JS number's max value, so we use the core dynamo client to avoid
      // native type marshalling, and keep the ticket number as a string.
      const res = await this.dynamo
        .updateItem({
          TableName: this.tableName,
          Key: {
            PartitionKey: {
              S: `lock-client:lock:${lockId}:ticket-number`,
            },
            SortKey: {
              S: 'current',
            },
          },
          ConditionExpression: 'attribute_exists(PartitionKey)',
          ExpressionAttributeValues: {
            ':ticketNumber': {
              N: '1',
            },
          },
          ReturnValues: 'UPDATED_NEW',
          UpdateExpression: 'SET ticketNumber = ticketNumber + :ticketNumber',
        })
        .promise();

      return res.Attributes!.ticketNumber.N!;
    } catch (e: any) {
      // Ticket Number doesn't exist
      if (e.code === 'ConditionalCheckFailedException') {
        try {
          await this.dynamo
            .putItem({
              TableName: this.tableName,
              ConditionExpression: 'attribute_not_exists(PartitionKey)',
              Item: {
                PartitionKey: { S: `lock-client:lock:${lockId}:ticket-number` },
                SortKey: { S: 'current' },
                ticketNumber: { N: '1' },
              },
            })
            .promise();
          return '1';
        } catch (e2: any) {
          // Someone else created it before us, let's loop back to incrementing
          if (e2.code === 'ConditionalCheckFailedException') {
            return this.getNextTicketNumber(lockId);
          } else {
            throw e2;
          }
        }
      } else {
        throw e;
      }
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class LockAcquisitionTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockAcquisitionTimeout';
  }
}

export class LockNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockNotFound';
  }
}
