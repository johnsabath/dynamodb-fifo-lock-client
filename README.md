# dynamodb-fifo-lock-client

[![codecov](https://codecov.io/gh/johnsabath/dynamodb-fifo-lock-client/branch/main/graph/badge.svg?token=LCDUYI0ISB)](https://codecov.io/gh/johnsabath/dynamodb-fifo-lock-client)

### Status: Experimental

AWS DynamoDB distributed locking client with fencing tokens and FIFO acquisition semantics.

Inspired by:
- [AWS Blog Post: Building Distributed Locks with the DynamoDB Lock Client](https://aws.amazon.com/blogs/database/building-distributed-locks-with-the-dynamodb-lock-client/)
- [Formidable Labs: Distributed Locking](https://formidable.com/blog/2020/distributed-locking/)

## Usage

### Setup
```javascript
import { DynamoDbLockClient } from "dynamodb-fifo-lock-client";
import * as DynamoDbClient from "aws-sdk/clients/dynamodb";

const dynamo = new DynamoDbClient();
const dynamoLockClient = new DynamoDbLockClient(dynamo, "my-dynamo-table-name");
```

### Options
```javascript
const lockOptions = {
  // Arbitrary string identifier
  lockId: "my-lock-identifier",

  // If we acquire the lock, how long does the lease last before expiring?
  // Leases are automatically extended by heartbeats.
  leaseDurationMs: 30000,

  // If we haven't acquired the lock by this point, raise LockAcquisitionTimeout.
  // Optional: defaults to leaseDurationMs
  acquireTimeoutMs: 30000,

  // How often we should reattempt a lock acquisition if it's being held by someone else
  // Optional: defaults to leaseDurationMs / 2
  acquireRetryIntervalMs: 15000,

  // How often heartbeats should be sent to extend the lease on the lock once its been acquired
  // Optional: defaults to leaseDurationMs / 4
  heartbeatIntervalMs: 7500, 
}
```

### Synchronous Lock Holding

Lock will be held until the `doWork` method returns.
```typescript
function doWork(): void {
  syncWork();
}

await dynamoLockClient.executeWithLock(lockOptions, doWork);
```

### Asynchronous Lock Holding

Lock will be held until the Promise returned by `doAsyncWork` resolves or rejects.
```typescript
async function doAsyncWork(): Promise<void> {
  await asyncWork();
}

await dynamoLockClient.executeWithLock(lockOptions, doAsyncWork);
```

## Contributing
Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

Please make sure to update tests as appropriate.

## License
[Apache](https://choosealicense.com/licenses/mit/)
